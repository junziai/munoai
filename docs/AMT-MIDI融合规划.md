# music-to-midi 与 UtaiSynthesizer 全面融合规划

> 目标：把开源项目 [`mason369/music-to-midi`](https://github.com/mason369/music-to-midi)（AI 音频转 MIDI / AMT）的全部能力，无缝融入 UtaiSynthesizer（君子乐坊），实现「任意音频 → 全轨可编辑 MIDI」。
>
> 本文档是**规划蓝图**，列出现状、架构决策、功能映射、数据流、模型管理、实施路线与风险，供实施前评审。

---

## 一、背景与目标

### 1.1 用户核心诉求
- 把音乐自动转换成 MIDI，且要能转成**所有轨道（bass / drums / guitar / piano / vocals / other）**的 MIDI。
- 转换能力要与现在这个工程（工作流节点 + DAW + 资源管理 + 本地 ONNX 推理）**完美结合**，而不是做成孤立的另一个工具。

### 1.2 现有工程定位
UtaiSynthesizer 是一个 Tauri (Rust + ONNX 推理 + React) 桌面应用，核心能力：
- **音频分离**（MSST / UVR / Demucs，ONNX 本地推理，生成各 stem WAV）
- **声音转换**（RVC / SoVITS）、变调、音频合成、工作流节点编辑、DAW 音轨编辑、素材管理、模型按需下载。

已有转 MIDI 能力：**「游戏引擎」人声转 MIDI**（[inference/midi_extract.rs](src-tauri/src/inference/midi_extract.rs)，基于 GMM 单音高检测，仅人声旋律、单轨、轻量）。

### 1.3 融合目标
1. 保留并升级「游戏引擎」之外的**多乐器全轨**转 MIDI：完整混音 → MIDI、分离后逐轨 → MIDI。
2. 让 MIDI 产出能在应用内**查看、编辑、量化、调速度、导出**，并回流到现有工作流与资源管理。
3. 复用现有基建（模型管理、运行时按需下载、stem 缓存、工作流节点系统），避免另起炉灶。

---

## 二、现状盘点

### 2.1 music-to-midi 能力清单（上游已实现，权威以 README 为准）

**七种处理模式：**
| 模式 | 作用 | 后端 |
|------|------|------|
| `SMART` | 完整混音 → 多乐器 MIDI | YourMT3+ / MIROS / MuScriptor(L/M/S) |
| `VOCAL_SPLIT` | 人声 + 伴奏分离成 2 条 WAV | Leap XE 90-band + PolarFormer |
| `SIX_STEM_SPLIT` | 六声部（bass/drums/guitar/piano/vocals/other）WAV | BS-RoFo-SW-Fixed |
| `PIANO_TRANSKUN` | 钢琴录音 → MIDI | TransKun V2 |
| `PIANO_TRANSKUN_AUG` | 钢琴 → MIDI | TransKun V2 Aug |
| `PIANO_ARIA_AMT` | 钢琴 → MIDI | Aria-AMT |
| `PIANO_BYTEDANCE` | 带踏板钢琴 → MIDI | ByteDance Pedal |

**逐轨转 MIDI（13 条 route）**：5 个 YourMT3+ checkpoint / MIROS / 3 档 MuScriptor / 4 个钢琴后端。分离出的每条 stem WAV 可独立选路转换。

**配套能力：** BPM/拍号检测（Beat This `final0`）、音符量化（1/4~1/64 五档）、乐谱导出（MusicXML / 总谱 PDF / 分谱 PDF / Tab）、结果工作台（钢琴卷帘 / MIDI 主时钟播放 / 乐器静音独奏 / 合成试听）。

**技术栈：** Python + PyTorch（CUDA / Intel XPU），95 个 Python 依赖，模型权重 GB 级，多种模型非商用许可（CC BY-NC）。提供 PyQt6 桌面、Gradio Web、Docker、Colab、CLI 五种入口；CLI/API 共用同一 `InferenceEngine` / `pipeline`。

### 2.2 现有 UtaiSynthesizer 相关能力
| 能力 | 位置 | 说明 |
|------|------|------|
| 音频加载/解码 | [lib.rs](src-tauri/src/lib.rs) + [audio.rs](src-tauri/src/commands/audio.rs) | MP3/WAV/FLAC/OGG/M4A → 44.1kHz 16bit WAV 缓存（content-addressed `audio_cache`） |
| 音频分离节点 | [SeparationNode.tsx](src/components/workflow/nodes/SeparationNode.tsx) + [pipeline.rs](src-tauri/src/separation/pipeline.rs) | ONNX 模型，生成 stem WAV，前端按 stem 分流 |
| 人声转 MIDI（游戏引擎） | [midi_extract.rs](src-tauri/src/inference/midi_extract.rs) + [midiExtract.ts](src/lib/vocal/midiExtract.ts) | GMM 单音高，单轨，前端 `download_game_package` |
| 工作流节点系统 | [WorkflowEditor.tsx](src/components/workflow/WorkflowEditor.tsx) + [NodePalette.tsx](src/components/workflow/NodePalette.tsx) | 节点注册、右键菜单、连边、执行引擎 |
| 资源管理 / 模型管理 | [msst-models.ts](src/store/msst-models.ts) + [MsstModelManager](src/components/models/) | 模型分类、安装状态、按需下载、删除/清理 |
| 运行时按需下载 | `data/runtime*`（S42 embedded-runtime packs 基建） | 已有「按需下载大体积运行时」基础设施可复用 |

### 2.3 技术鸿沟（必须直面的关键点）
| 维度 | 现有工程 | music-to-midi |
|------|----------|---------------|
| 推理运行时 | Rust + ONNX Runtime（DirectML / CUDA，单 EXE） | Python + PyTorch（需独立 venv / 便携 runtime，GB 级） |
| 模型形态 | ONNX 单模型 | PyTorch 权重 + 官方源码（YourMT3/MuScriptor/MIROS） |
| 许可 | 自研 | 部分模型 CC BY-NC 非商用 |
| 集成入口 | Rust `invoke` 命令 | Python CLI / 本地 Web API（8765 端口） |

> **结论**：music-to-midi 的核心模型**无法转成 ONNX 简单嵌入现有 Rust**（模型多为 Transformer，结构复杂、官方源码耦合）。因此架构上必须采用**「Python 推理引擎 + sidecar」**方案（见第三章）。

---

## 三、融合架构设计（核心决策）

### 3.1 三种候选方案对比

| 方案 | 说明 | 优点 | 缺点 | 结论 |
|------|------|------|------|------|
| **A. 全量移植为 Rust/ONNX** | 把 MT3/MuScriptor/TransKun 导成 ONNX 并入 Rust | 单 EXE、与现有统一 | 工程巨大、多数模型不可导、官方耦合 | ✗ 不现实 |
| **B. Python 引擎 sidecar（推荐）** | 保留 music-to-midi 的 Python 引擎，UtaiSynthesizer 通过子进程/本地 API 调用，前端 Tauri 封装 | 复用上游全部能力、模型直接用、升级即得 | 需分发 Python 运行时（体积大）、模型非商用需评估 | ✅ **推荐** |
| **C. 混合** | 轻量单音高（游戏引擎）保留 Rust；多轨全转用 sidecar | 兼顾两者 | 两套维护面 | 可作为 B 的细化 |

> 采用 **B 方案**，并**保留现有「游戏引擎」Rust 单音高转 MIDI**（用于快速人声旋律，无需重型 runtime）。

### 3.2 推荐架构（分层）

```
┌─────────────────────────── 前端 React (Tauri WebView) ───────────────────────────┐
│  工作流节点(转移MIDI节点)   资源管理页(MIDI工具)    DAW导入/编辑    MIDI查看器     │
└───────────────┬─────────────────────────────────────────────────────────────────┘
                │ invoke
┌───────────────▼────────────────── Rust (src-tauri) ─────────────────────────────┐
│  commands/amt.rs              引擎管理 Router                                  │
│  · 检测 Python/GPU/模型就绪     · 任务队列 / 进度上报 / 取消                      │
│  · 启动/探活 sidecar            · 输入归一化为 WAV 缓存                           │
│  · 调用 CLI 或 Web API           · 产物(MIDI) 回收 + SHA-256 校验                │
└───────────────┬─────────────────────────────────────────────────────────────────┘
                │ 子进程 / 本地 HTTP(127.0.0.1)
┌───────────────▼────────────── Python sidecar (music-to-midi 引擎) ──────────────┐
│  CLI 入口 或 精简 WebBackend   InferenceEngine/Pipeline                          │
│  模型目录(runtime/models/y**mt3_all, MuScriptor, transkun…)                      │
│  运行时：venv 或 便携 runtime  长短任务：启动常驻 / 每次短任务拉起                │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**关键选择点（三位一体）：**
1. **调用接口**：优先走 **CLI 子进程**（`--json` 事件流），比本地 Web API 少一个端口/服务面、生命周期更简单；若需要进度流式，用 `--json` 逐行解析（上游已支持 JSON Lines）。WebBackend 方案作为备选（适合 CJK 局域网协作，本工程不必要）。
2. **进程生命周期**：
   - 短任务（一首歌 SMART/钢琴）：每次**拉起一次 CLI**，完成后退出。简单、无常驻进程。
   - 若前端要进度可视化：CLI 的 `--json` 已是事件流，可边跑边 push 给前端，无需常驻。**推荐每次任务拉起一个进程**。
3. **输入输出**：优先**吃现有分离出的 stem WAV 缓存**（content-addressed），不重复解码；MIDI 产物写回应用的数据目录，路径回传前端。

### 3.3 与现有模块的衔接点
- **输入来源**：现有分离节点输出 / DAW 音轨 / 导入音频，统一转成 44.1 kHz WAV 后喂给 sidecar。
- **输出去向**：生成 `.mid`，可选回填到工作流后续节点、资源管理「MIDI 素材」分类、或 DAW 调性轨道。
- **模型管理**：复用现有「模型管理」UI 分类框架，新增「AMT/MIDI 模型」分组，走已有的按需下载 + 删除/清理流程（大体积 runtime 走 S42 那套按需下载基建）。

---

## 四、功能映射（把 7 模式做成应用内可用）

### 4.1 新增工作流节点「转 MIDI 节点（AMT）」
仿照现有 `SeparationNode`：
- **输入**：`audioIn`（任意 stem/混音）
- **参数**：模式选择（SMART / 六声部 / 钢琴×4）、后端与模型档位、量化网格（默认关）、是否只生成 MIDI 或同时分离 WAV、是否合并多轨。
- **输出**：`midiOut`（可选 `.mid` 路径）、分离模式额外输出各 stem WAV。节点上提供 **下载/导出 MIDI** 按钮（仿现有节点的下载禁用逻辑：未生成前禁用）。

### 4.2 资源管理页「MIDI 工具」
新增「MIDI」侧栏分类，聚合：
- 批量：选一个音频 → 一键「完整体转换（全轨 MIDI）」。
- 逐轨：先分离出六 stem → 每条 stem 选 13 条 route 之一转 MIDI。
- 结果工作台：MIDI 查看（音符列表/节拍）、量化、调 BPM、导出相同名称 `_2/_3` 防覆盖（复用现有导出命名约定）。

### 4.3 「游戏引擎」保留并差异化
现有 Rust 单音高（人声旋律）保留，用于：快速扒人声主旋律、调性参考。多轨场景自动引导走 AMT 节点。

### 4.4 多轨合并输出
- 单 MIDI 含多轨（youmt3 官方写法）直接回传/可用。
- 逐 stem 的 MIDI 提供「合并」选项（合并音符 track + tempo map + 各轨命名），产出 `song_all_stems_merged.mid`。
- 全部满足「转成所有轨道的 MIDI」。

---

## 五、数据流

```
导入音频/分离stem → UTF 检查 → 转44.1k WAV缓存(audio_cache)
   → 前端发起 invoke amt::start_amt(路径, 参数)
   → Rust: 校验 runtime/模型就绪 → 拉起 sidecar CLI (`--json`)
   → sidecar: 解码→模型转写→MIDI/BPM/quantize
   → Rust: 按 JSON Lines 逐行解析 → 进度事件 push 到前端 | 完成(退出码0)+SHA校验
   → 前端: 收 .mid 路径 → 结果工作台 显示 / 节点亮起下载按钮
   → 用户: 查看/量化/调速/合并/导出(同名_2/_3)
```

---

## 六、模型与运行时管理

| 项 | 方案 |
|----|------|
| Python 运行时 | 复用现有「按需下载 runtime pack」基建，下载**便携 Python + PyTorch**（CUDA/CPU 两档），或引导用户安装。默认 CPU 可用，检测到 GPU（复用现有 GPU 检测）再启用 CUDA/DirectML。 |
| 模型 | 沿用 music-to-midi 的模型目录结构（`models/youmt3_all`、MuScriptor L/M/S、TransKun、Beat This、SoundFont、FluidSynth、MuseScore）。按需下载 + SHA/大小校验（其 `download_*_model.py` 已实现严格校验，封装成 Rust 侧命令）。 |
| 首次安装 | 进度可取消可续传；缺失时在 UI 明显提示所需体积与许可。 |
| 磁盘清理 | 复用 `cleanup_oversized_cache` 思路，对 AMT 运行时/模型做「不常用可清理」分级（保留核心 SMART，钢琴/乐谱等按需再下）。 |

---

## 七、多轨 MIDI 输出规格
- **每条用途命名**：`song_bass.mid` / `song_drums.mid` / …（沿用上游命名约定）。
- **完整单文件**：`song.mid`（含 tempo map + 多轨）。
- **合并档**：`song_all_stems_merged.mid`。
- **命名防冲突**：`_2/_3` 递增，与现工程导出一致（复用导出逻辑）。

---

## 八、性能与硬件策略
- **GPU 优先，CPU 回退**：复用现有「GPU 加速检测」toast 逻辑；sidecar 启动时探测 CUDA/XPU，不存在则显式提示并改用 CPU（慢但可用）。
- **任务隔离**：sidecar 子进程独立，异常（OOM/崩溃）由 Rust 捕获可取消，前端显示失败原因。
- **长音频**：上游对长音频用分片（MuScriptor 5s 窗口）本身就是流式分片，无需额外处理。必要时 CPU 用「分片转写+连续性衔接」（上游 `muscriptor_boundary_continuity.py` 已有）。

---

## 九、分阶段实施路线

| 阶段 | 内容 | 验收标准 |
|------|------|----------|
| **0. 环境与可行性** | 在本机跑通 music-to-midi 最小链路（装 Python/模型，CLI 转一首实测 GPU/CPU） | 拿到可用的 `song.mid`，记录耗时与内存 |
| **1. CLI 接通** | Rust 新增 `commands/amt.rs`：检测环境、拉起 CLI `--json`、解析进度、回收 MIDI | 从应用内「导入音频→转 MIDI」成功导出 `.mid` |
| **2. 工作流节点** | 新增「转 MIDI 节点」+ 右键菜单注册 + 下载按钮 gating | 节点拖入、执行、下载可用，与现有节点一致 |
| **3. 逐轨多轨** | 现有分离 `SIX_STEM` stem → 逐轨选 route 转 MIDI → 合并 | 六 stem 各自 MIDI + `all_stems_merged.mid` |
| **4. 结果工作台** | MIDI 查看/量化/调速/导出（`_2/_3`） | 编辑并导出多轨 MIDI |
| **5. 资源管理整合** | 「MIDI 工具」分类 + 模型/运行时按需下载 + 清理 | 从资源管理完成全流程 |
| **6. 打磨** | 进度可视化、取消、错误文案（三语 i18n）、GPU toast、许可提示 | 全流程稳定、测试通过 |

---

## 十、风险与开放问题

| 风险/问题 | 影响 | 缓解 |
|-----------|------|------|
| **代码体积**：Python + PyTorch runtime + 模型可达数 GB | 安装体积、磁盘 | 按需下载、只装所用模型档位、提供 CPU 精简档 |
| **许可**：YourMT3 / MuScriptor / MIROS 等为 CC BY-NC 非商用 | 商用分发受限 | 若分发给他人商用需替换这些后端或获取授权；规划文档明确标注 |
| **GitHub/模型源网络受限** | 首次下载失败 | 复用现有多镜像/断点续传基建；预置国内镜像源 |
| **模型质量不稳定** | 钢琴等场景差异大 | 默认 YourMT3+（稳），钢琴可选 4 后端 |
| **sidecar 崩溃/OOM** | 稳定性 | 子进程隔离 + Rust 捕获 + 失败原因回传 |
| **CPU 仅可用时太慢** | 体验 | 明确提示、分片、连续进度 |

---

## 十一、验收标准（总）
1. 导入任意音频，可一键得到「全轨 MIDI」（单文件多轨 或 每 stem 一 MIDI + 合并档）。
2. 六声部分离 stem 可逐轨选不同后端转 MIDI。
3. 结果可在应用内查看/量化/调速/导出，导出命名不覆盖（`_2/_3`）。
4. 全部能力进入现有工作流系统（节点 + 右键菜单 + 资源管理），三语 i18n 齐全。
5. 现有「游戏引擎」人声转 MIDI 不受影响。

---

*文档信息：规划版 v0.1，供评审。实施时按第九章路线逐步推进，每阶段完成后独立测试验收。*