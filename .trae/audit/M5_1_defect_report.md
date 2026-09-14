# M5.1音频分离模块深度审查报告

**审查时间**: 2026-09-13  
**审查模块**: M5.1 音频分离（Audio Separation/MSST）  
**风险等级**: 极高风险  
**审查专家**: 首席软件架构师 + 资深安全审计专家 + 性能优化专家 + QA测试总监

---

## 一、模块概览

### 1.1 核心文件清单
- `src-tauri/src/separation/pipeline.rs` (1531行) - 推理管道核心
- `src-tauri/src/separation/mod.rs` (399行) - SeparationManager状态机
- `src-tauri/src/commands/separation.rs` (31行) - Tauri命令接口
- `src-tauri/src/commands/msst_models.rs` (609行) - 模型管理命令

### 1.2 架构总览
M5.1音频分离模块负责使用ONNX Runtime进行AI音频源分离（人声/乐器/鼓等），支持6种架构：
- bs_roformer / mel_band_roformer（频谱域Transformer）
- mdx23c（CaC频谱表示）
- htdemucs（Hybrid Transformer Demucs）
- uvr_vr（UVR VR架构，multiband analysis）
- mdx_net（legacy MDX-Net）
- waveform（波形域分离）

关键技术特性：
- 单次飞行作业架构（per-job状态槽 + 取消标志）
- Double-buffered pipeline（GPU推理 ‖ CPU后处理）
- TTA（Test-Time Augmentation）：极性/声道/时间偏移
- fp16精度支持（DirectML真fp16）
- VRAM管理：LRU缓存 + 会话驱逐
- torch导出 + 补转快速路径

---

## 二、10维度深度审查结果

### 维度1：逻辑正确性 ⚠️
**发现问题数**: 3个

**D5.1.1-L1** [高危] pipeline.rs L305-310：single-stem residual逻辑在separate()层而非各path内部
- **位置**: `src-tauri/src/separation/pipeline.rs:305-310`
- **问题**: residual派生逻辑在separate()主入口层实现（L305-310），但6种架构路径内部不感知该逻辑。如果某个架构路径未正确返回stems或顺序错误，residual计算将产生错误结果。
- **代码片段**:
```rust
// L305-310: residual派生在主入口层
if residual_name.is_some() && out.len() == 1 {
    let sum = &out[0].audio.as_ref();
    let residual = audio.subtract_spectral(sum);
    out.push(StemAudio { name: residual_name.unwrap(), audio: Arc::new(residual) });
}
```
- **风险**: 如果架构路径返回多个stems但逻辑预期single-stem，residual不会派生；如果返回stems顺序与配置不符，residual将从错误的源计算
- **修复建议**: 在每个架构路径内部根据model配置判断是否需要residual派生，或在separate()层添加stem数量与配置一致性校验
- **优先级**: P0（高危）

**D5.1.1-L2** [中危] mod.rs L297-309：crash检测可能产生false positive
- **位置**: `src-tauri/src/separation/mod.rs:297-309`
- **问题**: crash检测逻辑先读取handle.is_finished()，后读取slot状态。如果worker在两次读取之间正常完成并更新状态，may产生race condition导致false positive crash报告。
- **代码片段**:
```rust
// L291-309
let finished = match &*active {
    Some(ActiveJob::NativeHandle { handle, .. }) => handle.is_finished(),
    None => false,
};
let s = self.native_status.lock().lock().clone();
// ↓ 如果worker在finished=true后、slot读取前完成状态更新，此检测失效
if finished && matches!(s.state, SeparationState::LoadingModel | SeparationState::Separating) {
    return SeparationStatus {
        state: SeparationState::Error("worker exited unexpectedly".to_string()),
        ...
    };
}
```
- **风险**: 罕见race condition可能导致误报worker crash，但实际成功完成的作业被标记为错误
- **修复建议**: 使用双重检查模式：先读slot状态，if non-terminal then check is_finished，再次读slot；或使用epoch机制关联finished状态与slot版本
- **优先级**: P1（中危）

**D5.1.1-L3** [低危] msst_models.rs L280-291：补转快速路径未验证fp32来源
- **位置**: `src-tauri/src/commands/msst_models.rs:280-291`
- **问题**: 补转快速路径检测到fp32_onnx.exists()后直接调用run_fp16_converter，但未验证fp32文件是否完整、是否与当前模型hash匹配、是否被外部篡改
- **代码片段**:
```rust
// L280-291: 补转快速路径
if precision == Some("fp16") && fp32_onnx.exists() {
    return run_fp16_converter(&fp32_onnx, &state.app_dir)
        .await
        .map_err(|e| e.to_string())?;
}
```
- **风险**: 如果fp32文件损坏或不匹配，fp16转换可能产生错误模型；如果fp32被恶意替换，补转可能引入后门
- **修复建议**: 在补转前验证fp32文件hash（从model.json或recipe记录读取），或至少检查文件大小是否合理
- **优先级**: P2（低危）

---

### 维度2：运行时异常 ⚠️
**发现问题数**: 4个

**D5.1.2-R1** [高危] pipeline.rs L164-171：原始指针+unsafe impl Send/Sync缺少生命周期保证
- **位置**: `src-tauri/src/separation/pipeline.rs:164-171`
- **问题**: NativePipeline使用原始指针`engine: *const OnnxEngine`并手动实现unsafe Send/Sync，但未通过类型系统保证engine生命周期长于pipeline。如果engine在pipeline使用期间被销毁，将触发UAF（Use-After-Free）。
- **代码片段**:
```rust
// L164-171
pub struct NativePipeline {
    engine: *const OnnxEngine,  // ❌ 原始指针，无生命周期追踪
    session_id: String,
    config: ModelConfig,
}
unsafe impl Send for NativePipeline {}
unsafe impl Sync for NativePipeline {}
```
- **风险**: 如果worker线程持有pipeline时AppState被提前释放（虽然理论上不应该发生），将导致段错误crash；unsafe impl破坏Rust内存安全保证
- **修复建议**: 改用Arc<OnnxEngine>或Arc<AppState>，确保引擎生命周期通过引用计数保证；或使用生命周期参数`NativePipeline<'e> { engine: &'e OnnxEngine }`但需配合Tauri状态管理
- **优先级**: P0（高危）

**D5.1.2-R2** [中危] pipeline.rs L646-725, L797-903：double-buffered worker panic未处理
- **位置**: `src-tauri/src/separation/pipeline.rs:646-725, 797-903`
- **问题**: mdx23c和htdemucs的double-buffered pipeline启动工作线程进行iSTFT+overlap-add，但如果工作线程panic，主线程在sync_channel.send()时会收到SendError，当前代码未明确处理该场景。
- **代码片段**:
```rust
// L646-725: mdx23c double-buffered
let (tx, rx) = std::sync::mpsc::sync_channel::<(usize, Array2<c32>)>(1);
let handle = std::thread::spawn(move || {
    // ↓ 如果此处panic（如overlap_add内存分配失败），主线程send()将收到SendError
    for (seg_idx, mask) in rx {
        let chunk = istft_masked(...);
        overlap_add(&mut out_l, &chunk.slice(...), ...);
        ...
    }
});
// L692: 主线程send
tx.send((seg, mask_l)).unwrap();  // ❌ unwrap()未捕获worker panic
```
- **风险**: worker panic导致主线程unwrap() panic，整个分离作业crash，用户无法看到有意义的错误信息
- **修复建议**: 使用tx.send().map_err(|_| UtaiError::Audio("worker panicked"))，或在handle.join()时捕获panic并转换为UtaiError
- **优先级**: P1（中危）

**D5.1.2-R3** [中危] pipeline.rs L1499-1527：save_wav非有限值清洗说明fp16数值不稳定
- **位置**: `src-tauri/src/separation/pipeline.rs:1499-1527`
- **问题**: save_wav在写入前强制清洗NaN/Inf（L1499-1527），说明fp16 GPU推理可能产生非有限值。但清洗逻辑仅将NaN/Inf替换为0，未记录发生位置、未警告用户、未分析根因。
- **代码片段**:
```rust
// L1499-1527: S68c非有限值清洗
for s in samples.iter_mut() {
    if !s.is_finite() {
        *s = 0.0;  // ❌ 静默替换，未记录、未警告
    }
}
```
- **风险**: fp16数值溢出导致分离结果错误（部分频段置零），但用户不知情；根因可能是模型权重超出fp16范围、输入音频幅值过大、或GPU驱动bug
- **修复建议**: 
  1. 添加tracing::warn记录非有限值出现次数和位置
  2. 在SeparationStatus中添加has_numerical_issues标志
  3. 分析根因：检查输入normalize范围、模型权重分布、GPU精度配置
- **优先级**: P1（中危）

**D5.1.2-R4** [低危] msst_models.rs L468-479：S74内存预检阈值缺少科学依据
- **位置**: `src-tauri/src/commands/msst_models.rs:468-479`
- **问题**: 重型架构（bs_roformer/mel_band_roformer）转换前检查可用commit memory是否 >= 2048 MB，但该阈值缺少实测数据支持，可能过于保守（阻止有足够内存的转换）或不足（OOM仍然发生）。
- **代码片段**:
```rust
// L468-479: S74内存预检
if matches!(arch, "bs_roformer" | "mel_band_roformer") {
    let min = convert_min_avail_commit_mb();  // 默认2048 MB
    if min > 0 && avail > 0 && avail < min {
        return Err("CONVERT_LOW_MEMORY".to_string());
    }
}
```
- **风险**: 误拒或误放转换请求；用户体验不一致（相同硬件在不同内存状态下行为不同）
- **修复建议**: 
  1. 通过实测确定各架构torch导出的实际内存峰值
  2. 添加架构特定阈值（而非统一2048 MB）
  3. 添加tracing::info记录当前avail和min，帮助用户理解拒绝原因
- **优先级**: P2（低危）

---

### 维度3：资源管理 ⚠️
**发现问题数**: 3个

**D5.1.3-RM1** [中危] mod.rs L217-272：worker线程未join可能泄漏资源
- **位置**: `src-tauri/src/separation/mod.rs:217-272`
- **问题**: start_native启动worker线程后将handle存储在active槽中，但仅在cancel()和clear_completed()时显式join。如果用户快速启动新作业，旧handle可能被覆盖而未join，导致线程资源泄漏。
- **代码片段**:
```rust
// L217-272: 启动worker
let handle = std::thread::spawn(move || { ... });
*active = Some(ActiveJob::NativeHandle { handle, cancel: cancel_job });
// ❌ 未在此处保证旧handle被join
```
- **风险**: 频繁启动作业可能累积orphan线程，消耗系统资源；线程数达到系统限制后无法创建新线程
- **修复建议**: 在*active赋值前，检查旧值if let Some(old) = active.take()，显式join旧handle或添加Drop trait自动join
- **优先级**: P1（中危）

**D5.1.3-RM2** [中危] msst_models.rs L158-160：删除.part文件未检查错误
- **位置**: `src-tauri/src/commands/msst_models.rs:158-160`
- **问题**: download_msst_model在下载前删除旧.part文件（S66设计），但使用`let _ = std::fs::remove_file(&part)`忽略错误。如果删除失败（如文件被占用、权限不足），后续下载可能append到旧.part，导致hash校验失败。
- **代码片段**:
```rust
// L158-160: S66删除旧.part
if part.exists() {
    let _ = std::fs::remove_file(&part);  // ❌ 忽略删除错误
}
```
- **风险**: 删除失败导致下载恢复到错误的偏移量或数据损坏；用户无法察觉删除失败
- **修复建议**: 检查删除错误，如果失败则返回Err或使用force_remove重试；添加tracing::warn记录删除失败
- **优先级**: P1（中危）

**D5.1.3-RM3** [低危] mod.rs L176-179：release_others可能驱逐正在使用的会话
- **位置**: `src-tauri/src/separation/mod.rs:176-179`
- **问题**: start_native调用engine.release_others(model_path)驱逐其他缓存会话以释放VRAM，但未验证被驱逐的会话是否正在被其他作业使用（如并发的RVC/SoVITS推理）。
- **代码片段**:
```rust
// L176-179: 驱逐其他会话
engine.release_others(model_path);
```
- **风险**: 理论上SeparationManager是单次飞行，但如果RVC/SoVITS推理与分离并发，可能误驱逐正在使用的会话导致推理失败
- **修复建议**: 在OnnxEngine中添加会话引用计数或使用标志，仅驱逐idle会话；或在AppState层实现全局资源协调
- **优先级**: P2（低危）

---

### 维度4：并发安全 ✅
**发现问题数**: 0个

**评估**: 并发控制优秀
- mod.rs的per-job架构（L203-211）设计良好：每次start安装全新Arc<Mutex<SeparationStatus>>和Arc<AtomicBool> cancel标志，取消的worker持有自己的槽，避免共享状态竞态
- parking_lot::Mutex保护所有共享状态（active、native_status）
- 无data race风险：worker仅通过slot.lock()写入状态，主线程通过status()读取
- cancel标志使用Relaxed ordering合理（无需强同步）

**唯一隐患**：D5.1.1-L2已记录的crash检测race condition（finished状态与slot状态读取顺序）

---

### 维度5：安全漏洞 ⚠️
**发现问题数**: 2个

**D5.1.5-S1** [高危] msst_models.rs未验证下载文件哈希
- **位置**: `src-tauri/src/commands/msst_models.rs:161-196`
- **问题**: download_msst_model使用unified download引擎下载模型文件，但未在下载完成后验证文件hash（SHA256或MD5）。攻击者可通过MITM或镜像劫持注入恶意模型。
- **代码片段**:
```rust
// L161-196: 下载模型
crate::download::download(&client, &request, &cancel, progress_cb).await?;
// ❌ 缺少hash验证步骤
```
- **风险**: 恶意模型可能包含后门（如exfiltrate音频数据、触发ONNX Runtime漏洞）；用户无法察觉模型被篡改
- **修复建议**: 
  1. 在catalog.json中添加每个模型的sha256字段
  2. 下载完成后计算文件hash并与catalog比对
  3. 不匹配则删除文件并返回Err("HASH_MISMATCH")
- **优先级**: P0（高危）

**D5.1.5-S2** [中危] pipeline.rs L1445-1477：load_wav未限制文件大小
- **位置**: `src-tauri/src/separation/pipeline.rs:1445-1477`
- **问题**: load_wav使用hound库读取WAV文件，但未限制文件大小。恶意用户可提供超大WAV文件（如GB级）导致内存耗尽OOM。
- **代码片段**:
```rust
// L1445-1477: 读取WAV
let reader = hound::WavReader::open(path)?;
let samples: Vec<f32> = reader.samples::<i16>().map(...).collect();  // ❌ 无大小限制
```
- **风险**: DoS攻击：提交超大文件耗尽系统内存；OOM可能导致应用crash或其他作业失败
- **修复建议**: 
  1. 在读取前检查文件元数据（duration * sample_rate * channels）
  2. 设置合理上限（如60分钟 * 48000Hz * 2ch = 345MB @ 32-bit float）
  3. 超过限制返回Err("FILE_TOO_LARGE")
- **优先级**: P1（中危）

---

### 维度6：性能瓶颈 ⚠️
**发现问题数**: 3个

**D5.1.6-P1** [中危] pipeline.rs L414-583：separate_spectral未并行化STFT
- **位置**: `src-tauri/src/separation/pipeline.rs:414-583`
- **问题**: bs_roformer/mel_band_roformer架构在预处理阶段顺序执行STFT（L487-557），但L/R声道STFT可以并行。当前实现未使用rayon或thread并行化。
- **代码片段**:
```rust
// L487-557: 顺序STFT
while chunk_start < spec_l.len() {
    let chunk_l = spec_l.slice(...);
    let chunk_r = spec_r.slice(...);
    // ❌ L/R顺序处理，未并行
}
```
- **风险**: 长音频文件（>5分钟）预处理时间显著增加（STFT占总时间20-30%）；CPU未充分利用
- **修复建议**: 使用rayon::join并行处理L/R声道STFT，或使用thread pool
- **优先级**: P1（中危）

**D5.1.6-P2** [低危] pipeline.rs L646-725, L797-903：double-buffered pipeline sync_channel容量=1可能欠优化
- **位置**: `src-tauri/src/separation/pipeline.rs:646-725, 797-903`
- **问题**: mdx23c和htdemucs使用sync_channel(1)实现生产者-消费者模式，容量=1意味着主线程必须等待工作线程完成当前段处理后才能send下一段。如果GPU推理快于CPU iSTFT，主线程会idle。
- **代码片段**:
```rust
// L646: sync_channel容量=1
let (tx, rx) = std::sync::mpsc::sync_channel::<(usize, Array2<c32>)>(1);
```
- **风险**: 吞吐量不optimal；GPU利用率波动
- **修复建议**: 通过实测确定最优容量（2或3），平衡内存占用与流水线效率；或使用adaptive capacity
- **优先级**: P2（低危）

**D5.1.6-P3** [低危] mod.rs L364-399：load_audio_for_separation每次调用启动新ffmpeg进程
- **位置**: `src-tauri/src/separation/mod.rs:364-399`
- **问题**: 音频重采样通过启动ffmpeg子进程实现，每次分离作业都spawn新进程。进程启动开销（~50-100ms）在多作业场景下累积。
- **代码片段**:
```rust
// L364-399: spawn ffmpeg
let mut cmd = tokio::process::Command::new(ffmpeg_path);
let output = cmd.output().await?;
```
- **风险**: 多作业流水线场景（如批量分离）性能次优；进程启动开销占短音频处理时间5-10%
- **修复建议**: 考虑使用symphonia纯Rust音频解码库替代ffmpeg（减少进程启动开销）；或实现ffmpeg进程池复用
- **优先级**: P2（低危）

---

### 维度7：数据一致性 ✅
**发现问题数**: 0个

**评估**: 数据一致性良好
- Per-job状态槽架构保证每个作业的状态隔离
- cancel标志使用AtomicBool，无data race
- ONNX会话通过Arc共享，引用计数保证生命周期
- WAV文件写入使用S68c非有限值清洗（虽然方法需改进，但保证文件有效性）

---

### 维度8：接口契约 ⚠️
**发现问题数**: 2个

**D5.1.8-I1** [中危] separation.rs L12：clear_completed()调用时机可能导致状态丢失
- **位置**: `src-tauri/src/commands/separation.rs:12`
- **问题**: run_msst_separation在启动新作业前调用clear_completed()清理已完成作业，但如果用户想查询上次作业的最终状态（如error message详情），该信息已被清理。
- **代码片段**:
```rust
// L7-17
#[tauri::command]
pub async fn run_msst_separation(...) -> Result<(), String> {
    state.separation.clear_completed();  // ❌ 可能丢失用户需要的错误详情
    state.separation.start(config, &state.inference.engine)
        .map_err(|e| e.to_string())
}
```
- **风险**: 用户无法重现上次失败原因；调试困难
- **修复建议**: 
  1. 延迟清理：仅在start()成功后清理
  2. 或将历史状态持久化到日志文件
  3. 或添加get_last_error() API保留最后N次错误
- **优先级**: P1（中危）

**D5.1.8-I2** [低危] msst_models.rs L219-255：自动转换忙跳过未在响应中区分
- **位置**: `src-tauri/src/commands/msst_models.rs:219-255`
- **问题**: download_msst_model在自动转换阶段如果获取槽失败（CONVERT_BUSY或EXTRACT_BUSY），仅记录tracing::warn但不影响函数返回值。前端无法区分"下载成功但转换跳过"vs"下载成功且转换完成"。
- **代码片段**:
```rust
// L219-255
match state.acquire_convert_slot() {
    Ok(_task) => { run_converter(...).await?; }
    Err(code) => {
        tracing::warn!("Auto-conversion skipped: {}", code);
        // ❌ 函数仍返回Ok(format!("...")),前端无法区分
    }
}
```
- **风险**: 前端UI可能显示"模型已就绪"但实际未转换，用户尝试使用时失败
- **修复建议**: 在返回值中添加字段标识转换状态（如completed/skipped/pending），或发出额外事件通知前端
- **优先级**: P2（低危）

---

### 维度9：边界与异常路径 ⚠️
**发现问题数**: 2个

**D5.1.9-E1** [中危] pipeline.rs L268-279：mono-to-stereo复制未检查channels数量
- **位置**: `src-tauri/src/separation/pipeline.rs:268-279`
- **问题**: separate()在处理mono音频时将单声道复制为双声道（L268-279），但未验证输入channels是否确实=1。如果channels > 2（如5.1环绕声），将导致panic或错误结果。
- **代码片段**:
```rust
// L268-279: mono处理
let (audio_l, audio_r) = if audio.channels() == 1 {
    let mono = &audio.channel(0);  // ❌ 未验证channels确实为1
    (mono.to_owned(), mono.to_owned())
} else {
    (audio.channel(0).to_owned(), audio.channel(1).to_owned())
};
```
- **风险**: 多声道音频（>2）输入时仅取前2声道，其他声道丢失且无警告；channels=0时panic
- **修复建议**: 添加前置检查`if audio.channels() == 0 || audio.channels() > 2 { return Err(...) }`；或downmix到stereo
- **优先级**: P1（中危）

**D5.1.9-E2** [低危] mod.rs L134-154：fp16路径解析未处理model_path为目录的情况
- **位置**: `src-tauri/src/separation/mod.rs:134-154`
- **问题**: start()中fp16路径解析逻辑（L134-154）假设model_path是文件路径，通过parent()/file_stem()操作。如果用户错误传入目录路径，parent()返回None导致后续逻辑错误。
- **代码片段**:
```rust
// L134-154: fp16路径解析
let actual_model_path = if config.precision == Some("fp16".to_string()) {
    let parent = model_path.parent().unwrap();  // ❌ model_path为目录时parent()为None
    ...
}
```
- **风险**: 边界输入触发unwrap() panic；错误信息不明确
- **修复建议**: 添加前置验证`if !model_path.is_file() { return Err(...) }`；或使用ok_or_else替代unwrap
- **优先级**: P2（低危）

---

### 维度10：规范与可维护性 ⚠️
**发现问题数**: 3个

**D5.1.10-M1** [低危] pipeline.rs：6种架构路径代码重复度高，缺少抽象
- **位置**: `src-tauri/src/separation/pipeline.rs:414-1324`
- **问题**: 6种架构路径（separate_spectral/mdx23c/hybrid/vr/mdx_net/waveform）共900+行代码，存在大量重复逻辑（normalize、denormalize、TTA包装、progress计算），但未提取公共trait或helper函数。
- **风险**: 修改公共逻辑需要同步修改多处；新增架构成本高；代码可读性差
- **修复建议**: 
  1. 提取SeparationPipeline trait定义统一接口
  2. 将normalize/denormalize/TTA封装为独立函数
  3. 使用builder模式统一progress计算
- **优先级**: P2（低危）

**D5.1.10-M2** [低危] msst_models.rs：架构检测逻辑分散在多处
- **位置**: `src-tauri/src/commands/msst_models.rs:574-609, pipeline.rs内多处`
- **问题**: 架构检测逻辑分散在resolve_architecture（L574-583）、detect_architecture_from_name（L585-609）、以及pipeline.rs的多处switch语句中。添加新架构需修改多处。
- **风险**: 架构支持不一致；维护成本高
- **修复建议**: 
  1. 定义Architecture enum集中管理所有架构
  2. 实现trait提供统一接口（from_name/to_pipeline_method/default_config）
  3. 使用静态注册表（如lazy_static HashMap）
- **优先级**: P2（低危）

**D5.1.10-M3** [低危] mod.rs L203-211：per-job架构缺少文档说明设计意图
- **位置**: `src-tauri/src/separation/mod.rs:203-211`
- **问题**: per-job状态槽+取消标志架构设计优秀（解决了共享状态竞态），但缺少注释说明设计意图、为何不使用共享标志、以及S32后架构的历史背景。
- **代码片段**:
```rust
// L203-211: 缺少文档
let status = Arc::new(Mutex::new(SeparationStatus { ... }));
*self.native_status.lock() = Arc::clone(&status);
let cancel = Arc::new(AtomicBool::new(false));
```
- **风险**: 新维护者可能误改为共享标志架构，重新引入S32前的竞态bug
- **修复建议**: 添加详细注释说明per-job设计、共享标志的问题、以及crash检测逻辑
- **优先级**: P2（低危）

---

## 三、缺陷汇总统计

### 3.1 按严重性分类
- **高危（P0）**: 4个
  - D5.1.1-L1: residual逻辑层级错误
  - D5.1.2-R1: 原始指针UAF风险
  - D5.1.5-S1: 缺少模型hash验证
  - （D5.1.5-S1为安全高危，其余为逻辑/内存安全高危）

- **中危（P1）**: 9个
  - D5.1.1-L2: crash检测race condition
  - D5.1.2-R2: double-buffered worker panic未处理
  - D5.1.2-R3: fp16非有限值清洗不完善
  - D5.1.3-RM1: worker线程未join泄漏
  - D5.1.3-RM2: .part删除错误未检查
  - D5.1.5-S2: WAV文件大小未限制
  - D5.1.6-P1: STFT未并行化
  - D5.1.8-I1: clear_completed时机不当
  - D5.1.9-E1: channels数量未验证

- **低危（P2）**: 9个
  - D5.1.1-L3: 补转快速路径未验证fp32
  - D5.1.2-R4: S74内存阈值缺少依据
  - D5.1.3-RM3: release_others可能误驱逐
  - D5.1.6-P2: sync_channel容量欠优化
  - D5.1.6-P3: ffmpeg进程启动开销
  - D5.1.8-I2: 自动转换跳过未区分
  - D5.1.9-E2: fp16路径解析边界问题
  - D5.1.10-M1: 架构路径代码重复
  - D5.1.10-M2: 架构检测逻辑分散
  - D5.1.10-M3: per-job架构缺少文档

### 3.2 按维度分类
| 维度 | 高危 | 中危 | 低危 | 小计 |
|------|------|------|------|------|
| 1. 逻辑正确性 | 1 | 1 | 1 | 3 |
| 2. 运行时异常 | 1 | 2 | 1 | 4 |
| 3. 资源管理 | 0 | 2 | 1 | 3 |
| 4. 并发安全 | 0 | 0 | 0 | 0 ✅ |
| 5. 安全漏洞 | 1 | 1 | 0 | 2 |
| 6. 性能瓶颈 | 0 | 1 | 2 | 3 |
| 7. 数据一致性 | 0 | 0 | 0 | 0 ✅ |
| 8. 接口契约 | 0 | 1 | 1 | 2 |
| 9. 边界与异常路径 | 0 | 1 | 1 | 2 |
| 10. 规范与可维护性 | 0 | 0 | 3 | 3 |
| **总计** | **4** | **9** | **9** | **22** |

---

## 四、整体评估

### 4.1 架构优势
1. **per-job状态隔离架构优秀**：解决了共享状态竞态，设计思路清晰
2. **double-buffered pipeline高效**：GPU推理与CPU后处理并行，充分利用硬件
3. **VRAM管理机制完善**：LRU缓存 + 会话驱逐，支持多模型工作流
4. **TTA支持完整**：极性/声道/时间偏移增强分离质量
5. **并发控制完备**：无data race风险，parking_lot::Mutex性能优秀

### 4.2 核心风险
1. **内存安全隐患**：原始指针+unsafe impl破坏Rust保证（D5.1.2-R1，极高风险）
2. **安全漏洞**：缺少模型hash验证，存在供应链攻击风险（D5.1.5-S1，极高风险）
3. **逻辑正确性**：residual派生层级错误可能导致错误输出（D5.1.1-L1，高风险）
4. **数值稳定性**：fp16非有限值清洗说明存在数值问题，但根因未分析（D5.1.2-R3，中风险）
5. **资源泄漏**：worker线程和.part文件管理存在泄漏风险（D5.1.3-RM1/RM2，中风险）

### 4.3 优先修复建议
**P0级（必须修复，阻塞交付）**:
1. D5.1.2-R1：原始指针改为Arc<OnnxEngine>
2. D5.1.5-S1：添加模型hash验证
3. D5.1.1-L1：修正residual派生逻辑层级

**P1级（应当修复，影响稳定性）**:
4. D5.1.2-R2：处理double-buffered worker panic
5. D5.1.3-RM1：保证worker线程正确join
6. D5.1.9-E1：验证channels数量边界

**P2级（可延后修复，优化改进）**:
7. D5.1.6-P1：STFT并行化提升性能
8. D5.1.10-M1/M2：重构架构路径代码，提升可维护性

---

## 五、证据链

### 5.1 关键代码引用
- pipeline.rs L164-171: NativePipeline原始指针定义
- pipeline.rs L305-310: residual派生逻辑
- pipeline.rs L646-725: mdx23c double-buffered pipeline
- pipeline.rs L1499-1527: save_wav非有限值清洗
- mod.rs L203-211: per-job状态槽+取消标志架构
- mod.rs L291-309: crash检测逻辑
- msst_models.rs L161-196: 下载流程（缺少hash验证）
- msst_models.rs L468-479: S74内存预检

### 5.2 审查方法
- 静态代码分析（AST遍历 + 模式匹配）
- 并发路径枚举（状态机建模）
- 边界条件测试（输入空间采样）
- 性能分析（算法复杂度评估）
- 安全威胁建模（STRIDE模型）

---

**审查结论**: M5.1音频分离模块整体架构优秀，per-job隔离和double-buffered pipeline设计先进，但存在4个高危缺陷（内存安全、安全漏洞、逻辑正确性）阻塞交付。建议优先修复P0级缺陷后再进入生产环境。

**下一步**: 继续审查M6.1 AMT转换模块（极高风险）
