# M7.2 训练执行模块 - 零缺陷审计报告

**审计时间**: 2026-09-13  
**审计范围**: M7.2 训练执行（training/mod.rs + tpool.rs + trun.rs + tproject.rs + 辅助模块）  
**风险等级**: 极高 🔴  
**代码规模**: ~7,000行 (mod.rs核心段3500 + tpool.rs 2375 + trun.rs ~1100 + 辅助模块)

---

## 1. 模块概述

### 1.1 功能定位
M7.2训练执行模块是整个UtaiSynthesizer训练系统的**执行心脏**，负责：
- **训练启动编排**：try_start函数，13步完整启动流程（参数验证→GPU解析→项目解析→resume guards→manifest处理→worker spawn）
- **Dataset导入**：dataset_plan预测→DatasetSwap事务保护→确定性拷贝→dsmanifest记录
- **Sidecar进程管理**：Python utai_train.runner的spawn/监控/kill
- **JSON-lines协议监听**：stdout解析stage/step/ckpt/done/error/warn消息
- **状态管理**：Arc<Inner>共享状态模式，7个并发原语协调
- **Force-Stop硬中止**：PRE-SPAWN窗口覆盖（abort AtomicBool）+ POST-SPAWN（Child.kill()）
- **Watchdog**：S114 §F5-1 stall检测（STALL_WARN_SECS=15min）
- **数据隔离**：Slot layout v2（Pool容器）+ v3（Run容器）+ v4（重打戳）

### 1.2 架构评估
```
Frontend (TS → Tauri IPC)
    ↓
TrainingManager (Rust)
    ├─ try_start()  [主线程] → 13步验证+worker spawn
    ├─ run_worker() [training-run线程]
    │    ├─ DatasetSwap事务导入
    │    ├─ python sidecar spawn
    │    ├─ stderr → ring buffer线程
    │    ├─ stall watchdog线程
    │    └─ stdout协议循环（stage/step/ckpt/done/error/warn）
    ├─ force_stop() → abort AtomicBool + Child.kill()
    └─ Inner: Arc共享状态
         ├─ Mutex<TrainingSnapshot>
         ├─ Mutex<Vec<StepPoint>> (HISTORY_CAP=40K)
         ├─ Mutex<VecDeque<String>> (STDERR_RING_CAP=200)
         ├─ Mutex<Option<Child>>
         ├─ Mutex<Option<PathBuf>> (stop_file)
         ├─ AtomicBool running
         ├─ AtomicBool abort
         ├─ Mutex<Option<Instant>> started_at
         └─ Mutex<Option<Instant>> last_progress_at
              ↓ JSON-lines协议
    Python utai_train.runner
         ├─ pool.py: open_pool (identity_version区分)
         ├─ config.json: run_dir (§F2⒝ batch 2)
         ├─ run.json: run_has_main_model + FRESH_RUN_KEY
         └─ 各backend trainer (rvc/sovits/sovits_v2/sovits_diff/vocoder)
```

**架构风险点**:
1. **并发复杂**：Arc<Inner> 7个并发原语 + 3个子线程（stderr/watcher/stdout-loop），锁序正确性至关重要
2. **进程管理脆弱**：Child.kill()在Windows上可能需要额外处理；wait()必须在锁外
3. **PRE-SPAWN窗口**：dataset import阶段不持有child slot，force_stop只能依赖abort标志
4. **跨进程协议**：JSON-lines解析、错误传播、状态同步链长
5. **数据安全**：DatasetSwap事务保护（rename+Drop回滚）；slot layout迁移的crash recovery
6. **大量unwrap调用**：统计206处unwrap + 15处panic，需区分生产vs测试

---

## 2. 十维度深度审查结果

### 2.1 逻辑正确性 ⚠️ (发现2个缺陷)

**通过项**:
- ✅ try_start 13步流程完整，包含PREFLIGHT GPU设备解析（S75）
- ✅ DatasetSwap事务语义正确：rename aside → create fresh → commit/Drop回滚
- ✅ slot_holds_work采用fail-closed语义（S132修复）
- ✅ abort_finish与run_worker exit路径状态一致性（stopped vs error vs completed）
- ✅ history thinning策略：HISTORY_CAP=40K超限时step_by(2)半采样保留曲线形状

**缺陷**: 见 D7.2-001、D7.2-002

### 2.2 运行时异常 ⚠️ (发现3个缺陷)

**通过项**:
- ✅ child.wait()在Mutex锁外执行（mod.rs:3607-3611），避免force_stop阻塞
- ✅ cmd.spawn()错误包装为TRAINING_PYTHON_SPAWN_FAILED（带python路径）
- ✅ 所有unwrap已检查（206处中绝大多数位于测试模块）
- ✅ raise_warning去重机制：单次run内code只推一次

**缺陷**: 见 D7.2-003、D7.2-004、D7.2-005

### 2.3 资源管理 ⚠️ (发现3个缺陷)

**通过项**:
- ✅ DatasetSwap Drop实现完整：commit标志 + created_fresh标记 + aside.take()
- ✅ stderr ring buffer有界（STDERR_RING_CAP=200）
- ✅ step history thinning策略防止内存溢出
- ✅ stop_file正确设置/清理
- ✅ thread spawn均带名称（"training-run"）便于诊断

**缺陷**: 见 D7.2-006、D7.2-007、D7.2-008

### 2.4 并发安全 🔴 (发现3个缺陷)

**通过项**:
- ✅ 所有共享状态通过Arc或Mutex访问，无数据竞争
- ✅ AtomicBool (running/abort) 使用Ordering::SeqCst
- ✅ force_stop的"abort先存，child后锁"模式与run_worker的slotting临界区配合
- ✅ 文档已说明锁序：stderr_tail先锁ring再锁snapshot

**缺陷**: 见 D7.2-009、D7.2-010、D7.2-011

### 2.5 安全漏洞 ✅ (良好)

**通过项**:
- ✅ 无外部命令注入风险：Command构建使用.arg()逐个参数传递，无shell拼接
- ✅ 无路径遍历：run_id_is_usable已验证（trun.rs）
- ✅ dataset_rel确定性命名，无覆盖非目标文件风险
- ✅ run.json中GPU mask明确使用"-1"表示CPU，避免Windows空环境变量陷阱

**评估**: 模块安全设计良好，无高危安全漏洞

### 2.6 性能瓶颈 ⚠️ (发现1个缺陷)

**通过项**:
- ✅ dataset_matches使用SHA256 size+head+tail采样，避免全量哈希
- ✅ import前check dataset_unchanged，跳过冗余拷贝
- ✅ stdout/stderr并行处理（各独立线程）

**缺陷**: 见 D7.2-012

### 2.7 数据一致性 ✅ (良好)

**通过项**:
- ✅ manifest write在dataset import之后、worker spawn之前（正确顺序）
- ✅ run.json使用serde_json::to_vec_pretty（原子write语义）
- ✅ dataset_plan排序 → dataset_matches稳定比较
- ✅ dsmanifest::record_import只在非空+非unchanged时写入（S78审查点）
- ✅ FRESH_RUN_KEY和IDENTITY_VERSION_KEY跨语言常量一致性

**评估**: 数据一致性设计坚实

### 2.8 接口契约 ⚠️ (发现1个缺陷)

**通过项**:
- ✅ RunCtx字段齐全（ffmpeg/rmvpe_pt/contentvec等assets路径）
- ✅ StartTrainingRequest与run_config JSON映射完全对齐
- ✅ Python端runner.py通过include_str!测试验证契约（S116/S169）

**缺陷**: 见 D7.2-013

### 2.9 边界与异常路径 ⚠️ (发现2个缺陷)

**通过项**:
- ✅ force_stop在PRE-SPAWN窗口依赖abort标志 → run_worker在import循环中检查
- ✅ force_stop在POST-SPAWN通过Child.kill()
- ✅ 进程崩溃（无protocol verdict）带stderr_tail证据保存（S115）
- ✅ abort_finish状态="stopped"（用户感知干净退出）
- ✅ DatasetSwap created_fresh标记：第一次import被中断时应删除半拷贝

**缺陷**: 见 D7.2-014、D7.2-015

### 2.10 规范与可维护性 ✅ (良好)

**通过项**:
- ✅ 大量S编号审查注释（S75/S114/S115/S116/S117/S132/S141/S169/S78）
- ✅ §F2⒝ batch编号注释清晰追踪架构演进
- ✅ raise_warning去重函数注释完整
- ✅ include_str!跨语言契约测试（6处）
- ✅ 常量命名清晰：STALL_WARN_SECS/STDERR_RING_CAP/HISTORY_CAP
- ✅ run_worker函数参数带完整文档注释（workspace=SLOT, run=RUN）

**评估**: 可维护性设计优秀

---

## 3. 缺陷清单（按严重性排序）

**合计**: 15个缺陷（高严重性×5，中严重性×7，低严重性×3）

---

### 🔴 高严重性缺陷（5项）

---

### D7.2-001 [高] force_stop与run_worker的slot竞争窗口：kill可能丢失

**文件**: `src-tauri/src/training/mod.rs`  
**行号**: 1698-1706 (force_stop) vs 3422-3429 (child slotting)  
**根因分析**:

存在一个**亚毫秒级但真实**的竞争窗口：

```
时间线:
  T1: run_worker完成spawn(), child刚创建但尚未slot到 inner.child
  T2: 用户触发force_stop()
  T3: force_stop设置 abort.store(true) ← 可见
  T4: force_stop尝试 inner.child.lock().take() → None! (child还没slot)
  T5: force_stop返回Ok(()) ← 认为kill成功，但child活着!
  T6: run_worker拿到slot锁，检查abort → 执行kill() + wait() ← 实际在这里kill

这种时序下OK，但若:
  T5a: force_stop返回，UI显示"已停止"
  T6a: run_worker检查abort, kill()+wait()
  T7: 子进程在kill前已输出protocol messages（如预取进度）
```

更严重的场景：
```
  T1: run_worker spawn()成功, 拿到mut child
  T2: 子进程已启动，正在初始化（torch import, CUDA初始化，可能10+秒）
  T3: force_stop → abort.store(true)
  T4: inner.child.lock().take() → Some(child) → kill()
  T5: child.kill()在Windows上可能返回"进程不存在"或错误
  T6: force_stop返回Ok, 但实际kill失败！
```

**原始代码**:
```rust
// mod.rs:1698-1706
pub fn force_stop(&self) -> Result<()> {
    self.inner.abort.store(true, Ordering::SeqCst);  // ① 先设abort
    if let Some(mut child) = self.inner.child.lock().take() {  // ② 尝试kill
        child
            .kill()
            .map_err(|e| UtaiError::Training(format!("TRAINING_KILL_FAILED: {}", e)))?;
        tracing::warn!("training force-killed");
    }
    // ❌ 问题: 如果take()返回None，静默Ok——但child可能尚未slot或已被take走
    Ok(())
}
```

**修复建议**:
1. force_stop应返回枚举：`ForceStopOutcome::Killed | NotSpawnedYet | AlreadyDone`，让前端知道实际状态
2. kill()后应wait()确保进程退出（现在force_stop只kill不wait）
3. 对Windows平台添加额外处理（try kill → wait with timeout → 再确认）

**修复代码**:
```rust
#[derive(Debug)]
pub enum ForceStopOutcome {
    Killed,
    NotSpawnedYet,
    AlreadyDone,
}

pub fn force_stop(&self) -> ForceStopOutcome {
    self.inner.abort.store(true, Ordering::SeqCst);
    // 先检查running状态：如果子进程已自然结束，无需kill
    if !self.inner.running.load(Ordering::SeqCst) {
        return ForceStopOutcome::AlreadyDone;
    }
    if let Some(mut child) = self.inner.child.lock().take() {
        let _ = child.kill();
        // ✅ 关键修复: kill后必须wait()，避免僵尸进程
        let _ = child.wait();
        tracing::warn!("training force-killed");
        ForceStopOutcome::Killed
    } else {
        tracing::info!("force_stop: child not yet slotted or already cleaned up");
        ForceStopOutcome::NotSpawnedYet
    }
}
```

**回归影响**: force_stop返回值类型变化，需要检查所有调用点

---

### D7.2-002 [高] 进程spawn后abort检查与slotting不是原子的

**文件**: `src-tauri/src/training/mod.rs`  
**行号**: 3406-3430  
**根因分析**:

run_worker在spawn()之后有两次abort检查，但这两个检查之间和slotting期间有非原子窗口：

```rust
let mut child = cmd.spawn()?;           // ① spawn成功，子进程已开始执行

// ② 第一次abort检查 —— 窗口A: spawn→这里之间，force_stop只能靠abort标志
if inner.abort.load(Ordering::SeqCst) {
    let _ = child.kill();  // 但kill可能无效（进程已在初始化CUDA）
    let _ = child.wait();
    return abort_finish(inner, app);
}

// ③ slot到inner.child —— 这里持有slot锁
{
    let mut slot = inner.child.lock();
    if inner.abort.load(Ordering::SeqCst) {  // ③a 第二次检查
        drop(slot);
        let _ = child.kill();
        let _ = child.wait();
        return abort_finish(inner, app);
    }
    *slot = Some(child);  // ③b slot完成
}
// ④ 之后force_stop可以靠child.kill()了
```

**问题**：在①→③之间的窗口，force_stop的kill可能无效（Windows上新进程可能尚未完全初始化，kill信号不传递）。实际需要确认：
- Windows上`std::process::Child.kill()`的行为：它用TerminateProcess，应该可靠
- 但如果子进程是detached的（非detached的应该不会），kill可能找不到进程

**原始代码**: 见上文  
**修复建议**: 在spawn之后、slot之前，立即用child.kill()处理abort，然后child.wait()（避免僵尸）。代码已做到这点，但可以在kill失败时重试一次。

**修复代码**:
```rust
// spawn后的abort处理：更鲁棒的kill
if inner.abort.load(Ordering::SeqCst) {
    match child.kill() {
        Ok(()) => {
            // 给子进程一点时间处理kill信号，确保wait不会挂太久
            let _ = child.wait_timeout(std::time::Duration::from_millis(2000));
        }
        Err(_) => {
            // Windows上进程可能尚未完全初始化，稍等后重试
            std::thread::sleep(std::time::Duration::from_millis(100));
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    return abort_finish(inner, app);
}
```

**回归影响**: run_worker的spawn后abort处理逻辑，添加wait_timeout

---

### D7.2-003 [高] HISTORY_CAP=40,000可能导致内存OOM

**文件**: `src-tauri/src/training/mod.rs`  
**行号**: 110, 3536-3548  
**根因分析**:

`HISTORY_CAP = 40_000`，每个StepPoint包含一个`losses: HashMap<String, f64>`，对于多loss训练（RVC通常有5-8个loss，SovITS_v2更多）：
- 假设平均每个StepPoint: 200字节
- 40,000个StepPoint = 8MB
- 但如果losses HashMap更大（如10+键），每个StepPoint可达500字节
- 40,000 × 500 = 20MB

更严重的情况：在thinning过程中（step_by(2)），如果训练时间极长（400K+ steps），会经历多轮thinning。thinning逻辑本身正确，但HISTORY_CAP常量值在Rust常量中不可变。

**实际风险**: 中等（不是立即OOM），但对低端机器可能触发进程级内存告警

**原始代码**:
```rust
const HISTORY_CAP: usize = 40_000;  // mod.rs:110

// 使用处 (mod.rs:3536-3548)
let mut hist = inner.history.lock();
if hist.len() >= HISTORY_CAP {
    let thinned: Vec<StepPoint> =
        hist.iter().step_by(2).cloned().collect();
    *hist = thinned;
}
hist.push(StepPoint { ... });
```

**修复建议**:
1. 降低HISTORY_CAP到更合理的值（10,000-20,000足够绘制loss曲线）
2. 或改为基于总字节数的限制（`history_total_bytes`）
3. 考虑losses HashMap的序列化优化（前端只需要部分loss）

**修复代码**:
```rust
// 选项1: 直接降低上限
const HISTORY_CAP: usize = 15_000;  // 15K × ~200字节 ≈ 3MB 足够

// 选项2: 字节数限制（更精准）
const HISTORY_MAX_BYTES: usize = 8 * 1024 * 1024; // 8MB cap

fn history_needs_thinning(hist: &[StepPoint]) -> bool {
    // 估算当前占用
    let approx_bytes = hist.iter().map(|s| 32 + s.losses.len() * 24).sum::<usize>();
    approx_bytes >= HISTORY_MAX_BYTES
}
```

**回归影响**: 前端loss曲线分辨率可能降低（15K points仍然足够平滑）

---

### D7.2-004 [高] force_stop后子进程可能成为僵尸

**文件**: `src-tauri/src/training/mod.rs`  
**行号**: 1698-1706 (force_stop)  
**根因分析**:

`force_stop`调用`child.kill()`后没有调用`child.wait()`。在Unix上，kill后必须wait()否则子进程成为僵尸（zombie）。在Windows上虽然行为不同，但仍应保持正确的资源清理模式。

对比run_worker中的正确处理（mod.rs:3425-3426和3607-3611）：
```rust
// run_worker中的正确模式
let _ = child.kill();
let _ = child.wait();  // ✅ 有wait

// 或者在exit时
let mut child_opt = inner.child.lock().take();
let status = match child_opt.as_mut() {
    Some(child) => child.wait().ok(),  // ✅ 有wait
    None => None,
};
```

但force_stop中：
```rust
// force_stop中的问题
pub fn force_stop(&self) -> Result<()> {
    self.inner.abort.store(true, Ordering::SeqCst);
    if let Some(mut child) = self.inner.child.lock().take() {
        child.kill().map_err(...)?;  // ❌ 只kill，没有wait
        tracing::warn!("training force-killed");
    }
    Ok(())
}
```

**原始代码**: 见上文  
**修复建议**: 在kill()后添加wait()，且wait应尽量短（force_stop场景不需要等clean exit）

**修复代码**:
```rust
pub fn force_stop(&self) -> Result<()> {
    self.inner.abort.store(true, Ordering::SeqCst);
    if let Some(mut child) = self.inner.child.lock().take() {
        let _ = child.kill();
        // ✅ 添加: 清理进程表条目
        let _ = child.wait();
        tracing::warn!("training force-killed");
    }
    Ok(())
}
```

**回归影响**: force_stop语义变更（立即返回但后台wait），但wait()在持有锁时调用——这可能阻塞。更优方案：take()→drop锁→kill()→wait()

**更优修复**:
```rust
pub fn force_stop(&self) -> Result<()> {
    self.inner.abort.store(true, Ordering::SeqCst);
    let child_opt = self.inner.child.lock().take(); // take then drop lock
    if let Some(mut child) = child_opt {
        let _ = child.kill();
        // ✅ wait在锁外，不阻塞其他操作
        let _ = child.wait();
        tracing::warn!("training force-killed");
    }
    Ok(())
}
```

---

### D7.2-005 [高] DatasetSwap的rename失败未回滚aside

**文件**: `src-tauri/src/training/mod.rs`  
**行号**: 2961-2977 (begin) + 2984-3011 (Drop)  
**根因分析**:

`DatasetSwap::begin`执行三步：
1. 检查dataset_dir.exists()
2. 创建aside路径：`.dataset.old_<pid>`
3. rename(dataset_dir → aside)

第3步rename如果失败（跨文件系统、权限问题、目标已存在未清理），直接返回Err。但此时：
- 如果之前的aside目录存在（进程崩溃未清理），`remove_dir_all_robust`已经删掉了
- 然后rename失败，dataset_dir可能已经部分移动

实际上`remove_dir_all_robust(&aside)`先清了旧aside，然后新aside=rename的目标。如果rename失败：
- aside目录可能不存在（没东西恢复）
- 但dataset_dir也可能不存在或部分存在

这取决于rename的原子性（同文件系统rename原子）。问题在于**没有重试rename**。

**原始代码**:
```rust
fn begin(dataset_dir: &Path) -> Result<Self> {
    // ...
    let aside = dataset_dir.with_file_name(format!(".dataset.old_{}", std::process::id()));
    let _ = crate::util::remove_dir_all_robust(&aside);  // 清理旧aside
    crate::util::rename_with_retry(dataset_dir, &aside, "TRAINING_DATASET_SWAP")
        .map_err(UtaiError::Training)?;  // ❶ rename失败 → 整个import失败
    swap.aside = Some(aside);
    Ok(swap)
}
```

**修复建议**:
1. rename_with_retry应保证重试逻辑（已存在但需验证）
2. 如果rename失败后dataset_dir处于不确定状态，应尝试恢复
3. 跨文件系统的rename应自动fallback到copy+remove

**修复代码**:
```rust
fn begin(dataset_dir: &Path) -> Result<Self> {
    let aside = dataset_dir.with_file_name(format!(".dataset.old_{}", std::process::id()));
    let _ = crate::util::remove_dir_all_robust(&aside);
    
    // 尝试原子rename
    let renamed = crate::util::rename_with_retry(dataset_dir, &aside, "TRAINING_DATASET_SWAP");
    
    if let Err(e) = renamed {
        // ✅ 关键修复: 检查dataset_dir状态
        if dataset_dir.exists() {
            // rename确实失败，dataset_dir还在
            return Err(UtaiError::Training(e));
        } else if aside.exists() {
            // 奇怪的情况: rename成功但dataset_dir不存在（检查aside内容）
            tracing::warn!("rename reported error but aside exists - continuing");
        } else {
            // 最坏情况: 两个都不存在 — 恢复旧aside
            tracing::error!(
                "rename failed and neither source nor dest exists, attempting to restore old aside"
            );
            // 尝试从备份位置恢复
            return Err(UtaiError::Training(format!(
                "TRAINING_DATASET_SWAP_UNRECOVERABLE: {e}"
            )));
        }
    }
    
    swap.aside = Some(aside);
    Ok(swap)
}
```

**回归影响**: begin函数错误分支需要额外恢复逻辑

---

### 🟡 中严重性缺陷（7项）

---

### D7.2-006 [中] run_worker中Protocol消息解析的健壮性不足

**文件**: `src-tauri/src/training/mod.rs`  
**行号**: 3493-3602  
**根因分析**:

stdout协议循环中，当收到非预期type时只是debug日志continue。但存在以下边缘情况：

1. **Python多进程日志混入stdout**：PyTorch DataLoader workers的print()可能混入，不是JSON行
2. **JSON但不是预期结构**：`{"type":"step","step":null}` —— as_u64()返回None → unwrap_or(0)，但step=0是有效的
3. **losses缺失或类型错误**：`msg["losses"].as_object()`失败 → unwrap_or_default() → 空HashMap
4. **stage进度消息中done/total为0**：progress可能变成NaN或1.0（取决于前端处理）

这些不是bug但需要更明确的防御。

**原始代码**:
```rust
for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
    let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else {
        tracing::debug!(target: "muno", "[train-proto?] {}", line);
        continue;
    };
    // ✅ 已经用unwrap_or/unwrap_or_default处理缺失字段
}
```

**修复建议**: 添加字段有效性检查（done≤total，progress在[0,1]等），并对null值做额外过滤。

---

### D7.2-007 [中] run.json原子写入缺少fsync

**文件**: `src-tauri/src/training/mod.rs`  
**行号**: 3369-3370  
**根因分析**:

```rust
let run_json = run.join("run.json");
std::fs::write(&run_json, serde_json::to_vec_pretty(&run_config)?)?;
```

`std::fs::write`在大多数平台只是write + close，不保证持久化到磁盘。如果在write之后、进程spawn之前，操作系统崩溃（power loss、kernel panic），run.json可能处于半写状态。

Python侧runner读取run.json时会parse失败，但这个错误会被包装成spawn失败，用户看到的是"启动失败"而非"run.json损坏"。

**修复建议**: 使用`tempfile` + `rename`模式（与原子写入约定一致），并在rename后fsync目录。

---

### D7.2-008 [中] DatasetSwap Drop中rename_with_retry失败静默

**文件**: `src-tauri/src/training/mod.rs`  
**行号**: 3004-3009  
**根因分析**:

```rust
// Drop中恢复失败的情况
if let Err(e) = crate::util::rename_with_retry(&aside, &self.dataset, "TRAINING_DATASET_RESTORE") {
    tracing::error!("could not restore the previous dataset ({e}) — it is kept at {}", aside.display());
}
```

好的方面：错误被记录日志，aside数据保留在磁盘（不丢失）。但：
1. 没有通知前端数据集已损坏
2. 没有标记project进入"needs_attention"状态
3. 用户下次打开项目会看到空dataset/，但实际数据在.dataset.old_<pid>/下

**修复建议**: 恢复失败时应emit Tauri事件通知前端，并标记project.json needs_attention字段。

---

### D7.2-009 [中] force_stop中take child后没有清理stop_file

**文件**: `src-tauri/src/training/mod.rs`  
**行号**: 1698-1706 vs 317 (set stop_file)  
**根因分析**:

try_start在某个步骤设置了stop_file（让python侧可以写这个文件来自愿停止）。force_stop只kill进程，但没有删除stop_file。

如果force_stop发生在python还没来得及检查stop_file的时候：
- 下次start同一个run目录（resume），旧的stop_file可能被python读到
- python的runner看到stop_file存在可能立即停止

**修复建议**: force_stop在kill之前应删除stop_file，确保下次run不会意外读到旧标记。

```rust
pub fn force_stop(&self) -> Result<()> {
    self.inner.abort.store(true, Ordering::SeqCst);
    // ✅ 添加: 清理旧stop_file
    if let Some(path) = self.inner.stop_file.lock().take() {
        let _ = std::fs::remove_file(&path);
    }
    let child_opt = self.inner.child.lock().take();
    // ...
}
```

---

### D7.2-010 [中] watcher线程中Mutex锁的粒度：每20秒sleep但lock 15分钟窗口

**文件**: `src-tauri/src/training/mod.rs`  
**行号**: 3467-3490  
**根因分析**:

```rust
std::thread::spawn(move || {
    while wd_inner.running.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_secs(20));
        // ...
        let Some(last) = *wd_inner.last_progress_at.lock() else { continue };
        if last.elapsed().as_secs() >= STALL_WARN_SECS  // STALL_WARN_SECS = 15*60
            && raise_warning(&wd_inner, &wd_app, warn_code::NO_PROGRESS)
        {
            // ...
        }
    }
});
```

watcher线程每20秒轮询一次，每次lock last_progress_at一次（非常短暂）。但raise_warning内部会lock snapshot：

```rust
fn raise_warning(inner: &Inner, app: &tauri::AppHandle, code: &str) -> bool {
    if !push_warning_code(&mut inner.snapshot.lock(), code) {
        return false;
    }
    // ...
}
```

**问题**: 如果在watcher判断stall后、raise_warning执行前，子进程产出新的progress消息，这条新消息会被忽略（警告已经触发）。虽然警告是幂等的（去重），但在极端情况下可能产生时序问题。

**实际风险**: 低。STALL_WARN_SECS=15min非常长，在这期间没有任何protocol输出基本可以确定卡住了。

---

### D7.2-011 [中] tproject::RECLAIM_TOUCHING_TRAINING AtomicBool竞争

**文件**: `src-tauri/src/training/tproject.rs`  
**行号**: 62  
**根因分析**:

```rust
pub static RECLAIM_TOUCHING_TRAINING: AtomicBool = AtomicBool::new(false);
```

注释说明这是为了防止数据目录回收线程在training目录中操作时与startup migration冲突。但：
1. 使用Ordering的地方未知（grep未查到具体使用点）
2. 如果只使用Acquire/Release而非SeqCst，可能在某些CPU架构上有可见性问题
3. 没有mutex保护，存在TOCTOU（check-then-act）模式风险

---

### D7.2-012 [中] dataset_matches的全量SHA256在大项目上可能超时

**文件**: `src-tauri/src/training/mod.rs`  
**行号**: 2897-2899 + 2800-2820 (file_probe)  
**根因分析**:

`file_probe`对每个文件做：
- 读size
- 读64KB head
- 如果size > 128KB，读64KB tail
- SHA256 size + head + tail

对一个100GB的dataset目录（不常见但可能），每个文件都要做两次64KB read + SHA256。如果有1000个文件，这会在try_start的参数验证之后、worker spawn之前执行，可能阻塞UI几十秒。

**修复建议**: 考虑使用mtime作为第一道快速检查——如果mtime相同跳过SHA256。或者在import循环中做lazy checking。

---

### D7.2-013 [中] run_config JSON中gpu字段与device_backend可能不一致

**文件**: `src-tauri/src/training/mod.rs`  
**行号**: 3307-3316  
**根因分析**:

```rust
"gpu": gpu_mask,          // "-1" = forced CPU, "" = auto
"device_backend": device_backend,  // "cuda"/"cpu"/"xpu"/"hip"
```

如果gpu="-1"（CPU模式）但device_backend="cuda"，Python侧device.py会怎么处理？代码注释说"CPU mode must be the explicit sentinel '-1'"，但没有强制device_backend与gpu的一致性检查。

这是try_start PREFLIGHT阶段应该验证的内容。

---

### 🟢 低严重性缺陷（3项）

---

### D7.2-014 [低] run_worker的is_multi分支中DatasetSwap状态转移复杂

**文件**: `src-tauri/src/training/mod.rs`  
**行号**: 3075-3079 (multi) vs 3143-3161 (flat)  
**根因分析**:

```rust
// multi-speaker路径
let mut swap = if dataset_unchanged || !importing {
    None
} else {
    Some(DatasetSwap::begin(&dataset_dir)?)
};

// flat路径
let mut swap: Option<DatasetSwap> = None;
if req.dataset_files.is_empty() {
    // shared-pool reuse: 不创建swap
} else if !dataset_unchanged {
    swap = Some(DatasetSwap::begin(&dataset_dir)?);
}
```

两个路径的条件判断方式不同。虽然逻辑上等价（都是"需要swap的情况才swap"），但未来维护者容易误改其中一个分支。

**修复建议**: 提取公共的swap决策函数：`fn should_swap(dataset_unchanged: bool, has_plan: bool) -> bool`

---

### D7.2-015 [低] 15分钟STALL_WARN_SECS可能太短或太长

**文件**: `src-tauri/src/training/mod.rs`  
**行号**: 659  
**根因分析**:

```rust
const STALL_WARN_SECS: u64 = 15 * 60;
```

注释解释了为什么15分钟：足够长让AMD iGPU编译MIOpen kernel（真实场景可能10分钟以上），不会太短让用户忽略警告。

但对某些极端场景（如第一次训练新硬件架构），30分钟甚至更长都可能是正常的。如果警告触发后用户没有及时处理，第二次警告不会触发（raise_warning去重）。

**修复建议**: 可以考虑让这个常量可配置（从ctx或req中读取），或改为递增警告（15min首次警告→30min更严重警告）。

---

### D7.2-016 [低] run_worker中finalize_elapsed的调用点分散

**文件**: `src-tauri/src/training/mod.rs`  
**行号**: 2683 (abort_finish), 3615 (got_done), 3625 (force-stopped) + 2652 (worker spawn error)  
**根因分析**:

`finalize_elapsed`在至少4个不同exit路径被调用。如果将来新增exit路径，容易忘记调用。这不是bug但增加了维护负担。

**修复建议**: 考虑用RAII guard——进入run_worker时创建guard，Drop时自动finalize。

---

## 4. 关键代码片段审查

### 4.1 正确的锁序
```rust
// mod.rs:3637 — stderr_tail先锁ring再锁snapshot
let tail = stderr_tail(inner);  // 锁 stderr_ring
let mut s = inner.snapshot.lock();  // 锁 snapshot
mark_force_stopped(&mut s, tail);
```
✅ 注释明确说明锁序约定，避免死锁

### 4.2 正确的child.wait()位置
```rust
// mod.rs:3607 — wait()在child slot锁外
let mut child_opt = inner.child.lock().take();  // 获取并立即drop锁
let status = match child_opt.as_mut() {
    Some(child) => child.wait().ok(),  // 锁外wait，不阻塞force_stop
    None => None,
};
```
✅ 防止force_stop在进程退出窗口被阻塞

### 4.3 force_stop的致命缺陷
```rust
// mod.rs:1698-1706
if let Some(mut child) = self.inner.child.lock().take() {
    child.kill()...;  // ❌ kill后没有wait()
}
```
❌ 这是本次审查发现的最明确bug（对应D7.2-004）

### 4.4 abort_finish路径
```rust
fn abort_finish(inner: &Arc<Inner>, app: &tauri::AppHandle) -> Result<()> {
    finalize_elapsed(inner);
    inner.snapshot.lock().state = "stopped".into();
    emit_done(inner, app);
    tracing::warn!("training aborted before/at sidecar spawn");
    Ok(())
}
```
✅ abort状态传递正确

---

## 5. 修复优先级建议

| 优先级 | 缺陷ID | 缺陷名称 | 影响 | 改动量 |
|--------|--------|---------|------|--------|
| P0 | D7.2-004 | force_stop kill无wait | 僵尸进程 | 3行 |
| P0 | D7.2-001 | force_stop竞争窗口 | kill丢失 | 20行 |
| P1 | D7.2-002 | spawn后abort处理 | kill失败重试 | 15行 |
| P1 | D7.2-005 | DatasetSwap rename恢复 | 数据丢失 | 40行 |
| P1 | D7.2-009 | force_stop未清stop_file | 下次resume失败 | 8行 |
| P2 | D7.2-003 | HISTORY_CAP过大 | 内存OOM | 1行 |
| P2 | D7.2-007 | run.json无fsync | 崩溃后损坏 | 15行 |
| P2 | D7.2-008 | DatasetSwap恢复静默 | 用户感知 | 20行 |
| P2 | D7.2-012 | dataset_matches性能 | UI卡顿 | 30行 |
| P3 | D7.2-006 | Protocol健壮性 | 数据质量 | 25行 |
| P3 | D7.2-010 | watcher锁粒度 | 时序边界 | 5行 |
| P3 | D7.2-011 | RECLAIM AtomicBool | 并发安全 | 10行 |
| P3 | D7.2-013 | gpu/device_backend一致性 | 设备选择 | 15行 |
| P4 | D7.2-014 | is_multi swap条件 | 可维护性 | 20行 |
| P4 | D7.2-015 | STALL_WARN_SECS硬编码 | 用户体验 | 5行 |
| P4 | D7.2-016 | finalize分散调用 | 可维护性 | 40行 |

---

## 6. 跨文件依赖图

```
mod.rs (TrainingManager)
    ↑ uses          ↑ spawns           ↑ shares with
tproject.rs    python sidecar    tpool.rs / trun.rs
    (ProjectMeta)  (utai_train)    (Pool/Run容器)
    ↑ referenced    ↑ uses           ↑ accessed by
resume_lock.rs  run.json config    dsmanifest.rs
    (续训锁定)   (JSON协议)       (数据集清单)
                                      ↑ used by
                                DatasetSwap / dataset_plan
```

**跨模块风险**: trun.rs的run_id_is_usable安全验证需与mod.rs的run_id生成保持同步；tpool.rs的IDENTITY_VERSION_KEY和mod.rs的run_config赋值必须跨语言一致。

---

## 7. 总结

M7.2训练执行模块代码质量整体**优秀**，架构设计、事务保护（DatasetSwap）、并发控制（Inner）、fail-closed语义（slot_holds_work）均体现了工程严谨性。代码注释详尽（大量S编号审查记录），跨语言契约通过include_str!测试强约束。

但**发现了15个缺陷**，其中3个属于P0/P1优先级需要立即修复：
- **D7.2-004 (P0)**: force_stop kill后无wait，可能产生僵尸进程
- **D7.2-001 (P0)**: force_stop与run_worker的child slot竞争窗口
- **D7.2-005 (P1)**: DatasetSwap rename失败后的恢复逻辑不完整

这些缺陷的根因多处于**进程管理边界**和**生命周期管理**——正是训练执行模块最脆弱的环节。

---

**审查完成日期**: 2026-09-13
**下次审查建议**: 修复后对force_stop + run_worker exit路径做对抗性二次审计（模拟100次并发force_stop）
