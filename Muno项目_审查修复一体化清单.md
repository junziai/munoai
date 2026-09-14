# Muno / UtaiSynthesizer · AI 审查修复一体化清单

> **版本**: v2.0 强化版（审查+修复双模式）  
> **项目**: Muno v0.12.2 — AI Music Workstation  
> **架构**: Tauri 2 (React 19 + Rust + Python)  
> **适用场景**: 全面 BUG 排查、功能完整性验证、UI 优化、性能提升

---

## 🎯 使用说明

### 核心原则
1. **审查模式**：只读分析，输出问题清单（禁止改代码）
2. **修复模式**：按优先级逐项修复，每修一项验证一项
3. **纪律约束**：
   - 所有结论必须有证据（文件:行号 + 代码片段）
   - 禁止编造不存在的文件/函数/API
   - 修复前必须 git commit（可回滚）
   - 修复后必须运行测试验证

### 执行流程
```
步骤 1: 【审查阶段】运行 Part 1-4，生成缺陷清单 → 按严重度排序
步骤 2: 【确认阶段】人工审核清单，标记优先修复项
步骤 3: 【修复阶段】运行 Part 5，逐项修复 + 实时验证
步骤 4: 【验收阶段】运行 Part 6，全量回归测试
```

---

## Part 1: 快速体检（10 分钟全局扫描）

### 任务
快速定位项目最严重的 5-10 个问题，建立修复优先级。

### 检查清单

#### 1.1 致命风险扫描（Blocker 级）
- [ ] **panic 风险**：搜索 `unwrap()` / `expect()` / `panic!` / `unreachable!()`
  - 重点：Tauri command 入口（`src-tauri/src/commands/*.rs`）
  - Rust release profile 设置 `panic = "abort"`，任何 panic 直接杀进程
  - 输出：统计 panic 点总数，标出"用户输入可触发"的高危项
  
- [ ] **数组越界**：索引操作 `[i]` / `slice[a..b]` / `get_unchecked`
  - 重点检查：声道数、MIDI note(0-127)、音素索引、模型张量维度
  
- [ ] **整数溢出**：`as i32/u32/usize` 类型窄化转换
  - 长音频样本计数（>2^31 样本 ≈ 13.5 小时@44.1k）
  - BPM/采样率/时长相关计算
  
- [ ] **除零风险**：BPM=0、采样率=0、音量=0 归一化、空 MIDI/音频

#### 1.2 跨层契约一致性（最易出错）
- [ ] **IPC 类型不匹配**：前端 `invoke<T>()` vs Rust `#[tauri::command]` 签名
  - 检查 `src/lib/tauri.ts` 所有 invoke 调用
  - 对照 `src-tauri/src/commands/*.rs` 实际返回类型
  - 字段名大小写（Rust snake_case vs TS camelCase）
  - 输出对照表，标出不匹配项
  
- [ ] **时间单位一致性**：前端(秒/毫秒/tick) vs Rust vs Python
  - `src/lib/timeAxis.ts`
  - `src-tauri/src/inference/midi_extract.rs`
  - `data/amt/python/src/core/midi_tempo.py`
  
- [ ] **错误码映射完整性**：
  - `src/i18n/rustCodes.test.ts` 是否覆盖所有 Rust 错误
  - 三语文件 `zh.json/en.json/ja.json` 是否有缺失键

#### 1.3 UI 交互基本完整性
- [ ] **所有耗时操作是否有反馈**：
  - 进度显示（真进度 vs 转圈）
  - 可取消按钮
  - 失败原因明确提示
  - 完成后状态刷新
  - 检查：生成、转录、分离、导出、下载、训练
  
- [ ] **表单校验**：数值范围、路径合法性、防重复提交
  
- [ ] **对话框层级管理**：z-index、ESC 关闭、模态遮罩

#### 1.4 数据安全
- [ ] **自动保存安全性**：根目录 `autosave.json` (15.2MB)
  - 多工程是否会互相覆盖（高危）
  - 是否有体积膨胀控制
  - 崩溃恢复流程
  
- [ ] **原子写入**：工程保存、导出、模型下载
  - 是否用"临时文件 → 校验 → 原子替换"
  - 中断/断电是否会损坏原文件
  
- [ ] **路径穿越防护**：zip/tar 解包（检查 Zip Slip 漏洞）

### 输出格式
```markdown
## 快速体检报告

### 健康度评分: _/10

### Top 5 致命问题（必须立即修复）
1. [Blocker] 文件:行号 - 问题描述 - 触发条件 - 影响
2. ...

### 次要问题清单（共 X 项）
- [Critical] ...
- [Major] ...

### 建议修复顺序
第一优先: ...
第二优先: ...
```

---

## Part 2: BUG 深度猎杀（分层扫描）

### 2.1 Rust 后端（`src-tauri/src/`）

#### 音频正确性
- [ ] **重采样**（rubato）：块间相位连续性、采样率不匹配处理
- [ ] **混音削波**：增益累加、软限幅、浮点累加顺序确定性
- [ ] **WAV 读写**：位深标签、多声道布局、>2GB 文件（RF64）
- [ ] **变速**（utai-stretch）：极端比例（0.1x/10x）、FFI 内存所有权
- [ ] **FFT 归一化**：逆变换的 1/N 系数是否漏掉（经典 bug）
- [ ] **数值稳定**：NaN/Inf 检测与兜底（模型输出可能含 NaN）

#### 并发安全
- [ ] **锁持有时长**：是否在持锁期间做 IO/推理/await
- [ ] **锁顺序死锁**：多个锁的获取顺序是否一致
- [ ] **async 跨 await 持锁**：Mutex 在 async 函数跨 await 点
- [ ] **取消与超时**：长任务（推理/训练/下载）是否真正可取消
  - 检查 `src-tauri/src/training/resume_lock.rs`
  - 检查 `src/lib/resumeLock.ts`（前后端锁语义是否一致）
  
- [ ] **cpal 音频回调**（`src-tauri/src/audio/audio_output.rs`）
  - 回调内禁止：堆分配、加锁、文件IO、日志、panic、await
  - 逐行检查，这是唯一的实时路径

#### AI 推理
- [ ] **ort 动态加载**：库缺失/版本不匹配的错误路径
- [ ] **Session 生命周期**：是否复用、多模型显存峰值、卸载机制
- [ ] **GPU 降级**：显存不足回退 CPU、fp16 在非 NVIDIA 上的行为
- [ ] **G2P OOV 处理**：未登录词监控（`src/lib/vocal/oovWatch.ts`）

#### 文件系统
- [ ] **长路径**（Windows MAX_PATH 260）、中文路径、UNC 路径
- [ ] **便携版 vs 安装版**：数据目录决策、迁移安全性
- [ ] **注册表写入**（`portable.rs`）：权限、失败处理、影响范围

### 2.2 前端 TypeScript/React（`src/`）

#### React 正确性
- [ ] **useEffect 依赖**：漏依赖（stale closure）、依赖过多（无限循环）
- [ ] **清理函数**：定时器、事件监听、AbortController、WebAudio 节点、IPC 监听
- [ ] **巨型组件**（需拆分，AI 工具读不完）：
  - `Settings.tsx` (159KB)
  - `VocalEditor.tsx` (157KB)
  - `TrainingPage.tsx` (155KB)
  - `Arrangement.tsx` (143KB)
  - `AmtResultPanel.tsx` (134KB)
  - 输出拆分方案：职责、子组件、hook、优先级
  
- [ ] **key 与列表**：长列表是否用 index 作 key（状态错乱）
- [ ] **虚拟化**：千项列表（音色库、节点面板、日志）是否一次渲染

#### Web Audio
- [ ] **AudioContext 生命周期**：重复创建、用户手势后 resume
- [ ] **时间同步**：
  - 离线 bake → WAV → WebAudio 播放路径
  - cpal 试听流（Rust 侧）与 WebAudio 的双时钟对齐
  - 播放头漂移（currentTime vs 定时器）
  
- [ ] **增益斜坡**：音量改变是否用 `setTargetAtTime` 避免爆音
- [ ] **导出一致性**：实时预览 vs 离线导出结果是否逐样本一致
- [ ] **母带处理**（`mastering.ts`）：LUFS 计算、真峰值限幅

#### 节点图（@xyflow/react）
- [ ] **执行顺序**：拓扑排序、环检测、确定性
- [ ] **备份文件**：`engine.ts.bak` 与 `engine.ts` 哪个生效
- [ ] **节点错误处理**：每个节点是否有错误态、加载态、参数校验
- [ ] **模型路径自愈**（`modelPathHeal.ts`）：会不会"静默换错模型"

#### 内存泄漏
- [ ] WebAudio 节点未 disconnect
- [ ] Blob URL 未 `revokeObjectURL`
- [ ] 波形缓存（`waveformCache.ts`）无上限
- [ ] 变速缓存（`stretchCache.ts`）无淘汰
- [ ] @xyflow 节点/边对象累积

### 2.3 Python 子系统（`data/amt/python/`）

#### 集成契约
- [ ] **调用形态确认**：CLI / Qt GUI / HTTP API / Web 前端
  - Rust 实际调用哪一种？（查 `src-tauri/src/pyenv/mod.rs`）
  - Qt GUI 是否还在用？（3 万行维护负担）
  
- [ ] **HTTP API 安全**：
  - 监听地址（127.0.0.1 vs 0.0.0.0）
  - 是否有鉴权（本机进程能否随意调用）
  - CSRF/DNS rebinding 风险
  
- [ ] **进程管理**：
  - 崩溃重启、端口冲突、多实例
  - stdout/stderr 管道塞满导致挂起

#### 模型推理
- [ ] **多后端选择**：8+ 转录后端的取舍逻辑
  - `aria_amt/beat_this/bytedance_piano/miros/muscriptor/transkun/yourmt3`
  - 用户如何选？选错了会怎样？
  
- [ ] **设备降级**：CUDA/DirectML/OpenVINO/CPU 选择与降级提示
- [ ] **内存泄漏**：模型用完是否释放（`del` + `torch.cuda.empty_cache()`）
- [ ] **fp16 精度**：NaN 问题兜底（`converter/verify/fp16/` 有测试）

#### 音频处理一致性
- [ ] **SoundFont 渲染**：Python `fluidsynth_runtime.py` vs Rust `sf2.rs`
  - 是否两套独立实现？结果是否一致？
  - 前端试听与导出是否用同一渲染器？
  
- [ ] **MIDI 往返**：导出后用第三方工具打开是否一致

---

## Part 3: 功能完整性验证

### 3.1 核心功能检查表

| 功能模块 | 状态 | 检查项 | 已知问题 |
|---------|------|--------|----------|
| **歌声合成** | [ ] | 乐谱+歌词→人声、音高曲线、自动调教 | |
| **歌声转换** | [ ] | RVC/SoVITS、浅扩散、多歌手混合 | |
| **音频分离** | [ ] | 6 种模型（BS-Roformer/MDX23C/HTDemucs/VR等） | |
| **节点工作流** | [ ] | 20+ 节点、拓扑执行、模板、撤销重做 | |
| **DAW 编排** | [ ] | 多轨、剪辑、交叉淡化、BPM 检测 | |
| **自动编曲** | [ ] | autoArrange、styles、chordMidi | |
| **音源管理** | [ ] | SF2/SFZ 挂载、FluidSynth 渲染 | |
| **变调变速** | [ ] | Signalsmith、音域扩展 | |
| **人声转 MIDI** | [ ] | AMT 多模型、GAME 引擎 | |
| **混音导出** | [ ] | 多格式（wav/flac/mp3/ogg/opus/m4a）、分轨 | |
| **模型训练** | [ ] | RVC/SoVITS、断点续训、多歌手项目 | |
| **模型下载** | [ ] | 12+ 下载器、sha256 校验、镜像支持 | |
| **工程管理** | [ ] | 保存、自动保存、模板、历史、打包 | |
| **三语 i18n** | [ ] | zh/en/ja 键完整性、动态切换 | |

### 3.2 缺失/半成品功能识别

检查每个模块：
- [ ] 只有 UI 占位，后端未实现
- [ ] 后端有代码，前端未连接
- [ ] 功能可用但无错误提示
- [ ] 功能可用但无进度反馈
- [ ] 文档说有，实际没有

输出：**功能缺口清单**（按影响面排序）

---

## Part 4: UI/UX 专项审查

### 4.1 UI 简洁性评估

#### 当前问题诊断
- [ ] **信息密度过高**：单屏显示元素 > 20 个
- [ ] **层级混乱**：z-index 冲突、遮罩重叠
- [ ] **颜色滥用**：配色方案不一致、对比度不足
- [ ] **字体大小**：层级不清（h1/h2/body/caption）
- [ ] **间距不统一**：padding/margin 无规律

#### 优化方向
```
核心原则：少即是多（Less is More）
1. 主界面只保留 3-5 个核心功能入口
2. 次要功能收进右键菜单/下拉面板
3. 所有设置项分组折叠（默认只展开常用组）
4. 减少装饰性元素（边框、阴影、渐变）
5. 统一色系（主色 1 个 + 辅色 2 个 + 灰阶）
```

### 4.2 界面干净度检查

- [ ] **冗余控件**：重复功能的按钮/菜单项
- [ ] **未使用功能**：灰色不可点击但一直显示的按钮
- [ ] **提示过载**：tooltip/hint 文字过长（>30 字）
- [ ] **警告滥用**：红色/黄色警告图标过多（应该很少见）

### 4.3 交互流畅度

- [ ] **操作步骤**：核心任务是否能在 3 步内完成
- [ ] **快捷键**：常用操作是否有键盘快捷键
- [ ] **拖放**：文件导入是否支持拖放
- [ ] **右键菜单**：上下文操作是否就近可达
- [ ] **面板停靠**：布局是否可自定义并保存

### 4.4 新手友好度

- [ ] **向导流程**：首次启动是否有引导（OnboardingTour）
- [ ] **示例工程**：是否内置 demo 项目
- [ ] **空状态提示**：空列表/空画布是否有操作提示
- [ ] **错误提示人话化**：抽查 20 条错误提示，评估可理解度

### 4.5 UI 优化建议输出

```markdown
## UI 优化方案

### A. 简化主界面（减少 30% 控件）
- 移除：...
- 合并：...
- 折叠：...

### B. 统一设计语言
- 色系：主色 #..., 辅色 #..., #...
- 字号：h1(24px) h2(18px) body(14px) caption(12px)
- 间距：标准 8px 倍数（8/16/24/32）
- 圆角：统一 4px

### C. 关键交互优化
1. 【功能 A】从 5 步简化为 2 步：...
2. 【功能 B】增加拖放支持：...
3. 【功能 C】增加快捷键 Ctrl+...

### D. 新手引导强化
- 添加交互式教程（首次使用）
- 内置 3 个示例工程（翻唱/原创/转录）
- 所有空状态添加操作提示
```

---

## Part 5: 修复执行（带验证）

### 修复纪律
1. **一次只修一项**（禁止批量改）
2. **修复前 git commit**（打标签 `fix-N-before`）
3. **修复后立即验证**（运行相关测试）
4. **修复失败立即回滚**（`git reset --hard`）
5. **记录修复日志**（问题-方案-验证-结果）

### 修复模板

```markdown
## 修复项 #N: [问题简述]

### 问题详情
- 文件: `src-tauri/src/commands/settings.rs:274`
- 类型: [Blocker/Critical/Major]
- 描述: unwrap() 可被用户输入触发，导致进程崩溃
- 触发: 用户设置路径为空字符串

### 修复方案
将 `let path = config.data_dir.unwrap();` 改为：
```rust
let path = config.data_dir.ok_or_else(|| 
    Error::Config("数据目录未设置".to_string())
)?;
```

### 验证步骤
1. 运行测试：`cargo test --package muno --test settings_test`
2. 手动测试：打开设置 → 清空数据目录 → 保存 → 预期显示错误提示
3. 检查日志：应有明确错误记录，不应有 panic

### 修复结果
- [x] 测试通过
- [x] 手动验证通过
- [x] 无副作用
- Commit: `abc1234` "fix: 处理数据目录为空的情况"
```

### 优先级分级修复

#### P0 - Blocker（立即修复）
- 崩溃、数据丢失、结果错误、无法完成核心流程

#### P1 - Critical（本周修复）
- 严重性能问题、安全漏洞、跨层不一致

#### P2 - Major（本月修复）
- 功能缺失、UI 交互问题、错误提示不清

#### P3 - Minor（择机修复）
- 代码质量、测试覆盖、文档完善

---

## Part 6: 全量验收测试

### 6.1 自动化测试

```powershell
# 前端测试
npm test                                    # vitest
npm run build                               # 构建 gate

# Rust 测试
cd src-tauri
cargo test --workspace                      # 单元测试
cargo clippy -- -D warnings                 # 静态检查
cargo check                                 # 编译检查

# Python 测试（如果有）
cd data/amt/python
pytest tests/ -v                            # 运行测试套件
```

### 6.2 手动回归测试清单

#### 核心流程（必测）
- [ ] 创建新工程 → 导入音频 → 添加音符 → 合成 → 播放 → 导出
- [ ] 打开示例工程 → 修改参数 → 重新渲染 → 保存
- [ ] 训练模型 → 中断 → 续训 → 完成 → 应用到合成
- [ ] 节点工作流 → 连接 5+ 节点 → 执行 → 预览结果
- [ ] 崩溃恢复：强制关闭应用 → 重新打开 → 自动恢复工程

#### 边界情况（抽测）
- [ ] 空工程保存与加载
- [ ] 超长音频（> 1 小时）
- [ ] 特殊字符路径（中文、空格、emoji）
- [ ] 网络断开时下载模型
- [ ] 磁盘满时导出

### 6.3 性能基准测试

```markdown
## 性能指标（release 构建）

| 操作 | 目标 | 实测 | 状态 |
|------|------|------|------|
| 启动时间 | < 3s | _ | _ |
| 工程加载 | < 2s | _ | _ |
| 播放延迟 | < 100ms | _ | _ |
| 单音符合成 | < 5s | _ | _ |
| 音频分离（4min） | < 60s | _ | _ |
| 导出混音 | < 10s | _ | _ |
| 内存占用（空闲） | < 500MB | _ | _ |
| 内存占用（工作） | < 2GB | _ | _ |
```

---

## Part 7: 增强功能建议

### 7.1 性能优化方向

#### 已识别瓶颈
- [ ] **巨型组件重渲染**：Settings/VocalEditor/TrainingPage
  - 方案：拆分 + React.memo + useMemo
  
- [ ] **波形绘制**：长音频每次缩放重算峰值
  - 方案：多级缓存（1x/10x/100x）
  
- [ ] **节点图大图重排**：每次编辑全图 re-render
  - 方案：`onlyRenderVisibleElements={true}`
  
- [ ] **模型加载**：同时加载多个模型显存爆
  - 方案：LRU 缓存 + 自动卸载

#### 优化效果预期
- 启动时间：减少 50%（懒加载重型依赖）
- 播放延迟：减少 30%（预缓存 + 双缓冲）
- 内存占用：减少 40%（及时释放 + 缓存上限）

### 7.2 功能增强建议

#### 用户高频需求（优先）
1. **批量处理**：一次导入多个文件，批量转换
2. **预设管理**：保存常用参数组合，一键应用
3. **快捷键定制**：允许用户自定义键位
4. **主题切换**：浅色/深色模式
5. **协作功能**：工程导出为便携包，跨设备无缝加载

#### 体验提升（次要）
- 实时波形预览（边调参边看波形）
- 和弦进行推荐（AI 辅助作曲）
- 音色库在线商店（社区分享）
- 云端备份（可选）
- 插件系统（VST3 支持？）

#### 冗余功能（可移除）
根据使用数据，建议移除：
- [ ] Qt GUI（如果已不使用）
- [ ] 重复的工具栏按钮（保留右键菜单）
- [ ] 过时的模型后端（仅保留最优的 3 个）

---

## Part 8: 快速检查命令集

### 一键扫描脚本

```powershell
# 保存为 quick-check.ps1

Write-Host "=== Muno 快速健康检查 ===" -ForegroundColor Cyan

# 1. panic 点统计
Write-Host "`n[1/8] 扫描 panic 风险..." -ForegroundColor Yellow
$panics = Select-String -Path "src-tauri/src/**/*.rs" -Pattern "(unwrap\(|expect\(|panic!|unreachable!)" -Recurse
Write-Host "发现 $($panics.Count) 个 panic 点" -ForegroundColor $(if($panics.Count -gt 50){"Red"}else{"Green"})

# 2. IPC 调用检查
Write-Host "`n[2/8] 检查 IPC 调用..." -ForegroundColor Yellow
$invokes = Select-String -Path "src/**/*.ts" -Pattern "invoke<.*>\(" -Recurse
Write-Host "发现 $($invokes.Count) 个 invoke 调用" -ForegroundColor White

# 3. useEffect 依赖检查
Write-Host "`n[3/8] 检查 useEffect 依赖..." -ForegroundColor Yellow
$effects = Select-String -Path "src/**/*.tsx" -Pattern "useEffect\(" -Recurse
Write-Host "发现 $($effects.Count) 个 useEffect" -ForegroundColor White

# 4. 测试运行
Write-Host "`n[4/8] 运行前端测试..." -ForegroundColor Yellow
npm test 2>&1 | Select-String "Tests|PASS|FAIL"

# 5. Rust 编译检查
Write-Host "`n[5/8] Rust 编译检查..." -ForegroundColor Yellow
Push-Location src-tauri
cargo check --message-format=short 2>&1 | Select-String "error|warning" | Select-Object -First 10
Pop-Location

# 6. 巨型文件检测
Write-Host "`n[6/8] 检测巨型文件..." -ForegroundColor Yellow
Get-ChildItem -Recurse -File | Where-Object {$_.Length -gt 100KB -and $_.Extension -match '\.(rs|tsx|ts)$'} | 
    Select-Object Name, @{N="Size(KB)";E={[math]::Round($_.Length/1KB)}} | 
    Sort-Object Size -Descending | 
    Select-Object -First 10 | 
    Format-Table

# 7. 依赖版本检查
Write-Host "`n[7/8] 检查关键依赖..." -ForegroundColor Yellow
Get-Content package.json | Select-String "react|zustand|xyflow"
Get-Content src-tauri/Cargo.toml | Select-String "tauri|ort" | Select-Object -First 5

# 8. 磁盘占用
Write-Host "`n[8/8] 磁盘占用..." -ForegroundColor Yellow
$sizes = @{
    "node_modules" = (Get-ChildItem node_modules -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB
    "src-tauri/target" = (Get-ChildItem src-tauri/target -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB
    "dist" = (Get-ChildItem dist -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB
}
$sizes.GetEnumerator() | ForEach-Object { Write-Host "$($_.Key): $([math]::Round($_.Value)) MB" }

Write-Host "`n=== 检查完成 ===" -ForegroundColor Cyan
```

---

## 附录 A: 项目特定风险点

### A.1 音频架构特殊性
- 时间线播放：**离线 bake → WAV → WebAudio**（非实时合成）
- cpal 实时流：仅用于音源/音色**试听**
- 重点审查：bake 延迟、缓存失效、WebAudio 与 Rust 时间同步

### A.2 已知历史问题（`.trae/audit/`）
- M3_4: [查看具体问题]
- M4_1_4_2: [查看具体问题]
- M7_2: [已修复]
- M8: [查看具体问题]
- 审查时必须验证这些问题是否真的修复

### A.3 高危文件清单
| 文件 | 大小 | 风险 |
|------|------|------|
| `vocal_range.rs` | 1.0MB | 音域检查逻辑，AI 工具难读全 |
| `g2p.rs` | 519KB | 音素转换表，需分函数审查 |
| `training/mod.rs` | 355KB | 训练主逻辑，状态机复杂 |
| `Settings.tsx` | 159KB | 设置界面，巨型组件 |
| `VocalEditor.tsx` | 157KB | 编辑器核心，需拆分 |

### A.4 必须排除的目录
- `src-tauri/target/`（构建产物）
- `node_modules/`（依赖）
- `data/amt/python/venv/`（Python 虚拟环境）
- `data/amt/python/external/`（第三方代码，仅许可证审查时读）
- `BACKUP_BEFORE_ORIGINAL_SWAP/`（临时备份）
- `*.log` / `autosave.json`（运行时数据）

---

## 附录 B: AI 协作最佳实践

### 给 AI 的审查提示词模板

```
你是 Rust + React + 音频 DSP 专家，正在审查 Muno 项目（AI 音乐工作站）。

【本轮任务】
{选择: Part 1-8 中的某一部分}

【严格约束】
1. 只读审查，禁止修改任何文件
2. 所有结论必须有证据：文件路径:行号 + 代码片段
3. 禁止编造不存在的 API/函数/配置
4. 不确定的写【需人工确认】并说明如何确认
5. 排除这些目录：target/ node_modules/ venv/ external/ BACKUP_*

【项目架构关键事实】
- 时间线播放：离线 bake → WAV → WebAudio（不是实时合成）
- cpal：仅用于试听
- Rust panic=abort：任何 panic 直接杀进程
- IPC：Rust snake_case vs TS camelCase 需注意
- 巨型文件：先 grep 结构，再按需下钻

【输出格式】
## 审查报告
### 执行摘要（≤10 行）
### 问题清单（表格）
| ID | 严重度 | 文件:行号 | 问题 | 触发条件 | 修复方案 | 工作量 |
### Top 5 详细分析
### 下一步建议
```

### 给 AI 的修复提示词模板

```
你是 Rust + React 专家，正在修复 Muno 项目的 Bug #{N}。

【问题详情】
- 文件: {path:line}
- 问题: {description}
- 严重度: {Blocker/Critical/Major}

【修复要求】
1. 先输出完整修复方案（代码 + 说明）
2. 等我确认后再动手改文件
3. 改完立即运行相关测试验证
4. 验证失败立即回滚并报告

【验证步骤】
{具体测试命令}

【架构约束】
- Rust 侧改动需考虑前端 IPC 调用
- 前端改动需保证类型安全
- 不要引入新依赖（除非必要）
- 遵循现有代码风格

开始吧，先给出修复方案。
```

---

## 修改日志

**v2.0 (2026-09-13)**
- 升级为"审查+修复一体化"双模式
- 精简原 339KB 提示词，保留核心检查项
- 增加 UI 优化专项（简洁性、交互流畅度）
- 增加功能增强建议（性能优化、用户需求）
- 增加快速检查脚本（一键扫描）
- 增加 AI 协作模板（提示词标准化）
- 强化修复纪律（git 纪律、验证流程）

**v1.0 (原版)**
- 12 轮纯审查流程
- 27 万行代码逐层扫描
- 输出提示词手册

---

## 使用反馈

使用过程中遇到问题？请补充：
- 哪个 Part 最有用？
- 哪个 Part 不够实用？
- 缺少什么检查项？
- AI 理解困难的地方？

持续优化中... 🚀
