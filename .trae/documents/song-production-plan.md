# 「歌曲制作」新功能 TRAE 编程规划文档

> 目标读者：TRAE / 后续实现者。
> 代码库：`E:\软件开发\UtaiSynthesizer-main\UtaiSynthesizer-main`（产品名 **Muno**，Tauri 2 + React 19 + Zustand + i18next + @xyflow/react）。
> 安装版路径：`F:\002 AIgequ\UtaiSynthesizer`（前端内嵌在 exe 中，改完必须重建并替换 exe）。
> 本文档重点在**设置部分**（模型选择、歌词/提示词/参数、男女声、采样与推理参数）。

---

## 0. 一句话结论

主页面新增「歌曲制作」入口 → 弹出**模型选择面板** → 选择 **YuE2**（负责 MIDI/人声歌曲生成）或 **ACE-Step**（负责多轨生成）→ 面板切换为对应模型的**歌词 / 提示词 / 参数设置页** → 点「生成」后**轨道区实时以多条 MIDI/音频轨出现**（生成中 → 可试听）→ 结果落成轨道，可「合成单一轨道」、可保存到生成历史（含歌曲名、可试听）。资源管理器新增「音乐模型」分类，下载走已有的统一镜像线路。

---

## 1. 背景与现状（已勘查确认）

### 1.1 工程结构（与本需求相关部分）

```
src/
  App.tsx                      # 主装配：Titlebar + DawWorkflowSplit + 各类 lazy 弹窗
  i18n/{zh,en,ja}.json         # 三语；parity.test.ts 强制键集合一致
  components/
    common/Titlebar.tsx        # 文件/编辑/AI/帮助 菜单 + 训练按钮 + 缩放控件 + SuperOriginalWizard
    common/Settings.tsx        # 设置（下载源/HF 镜像/GH 代理/资产包/CUDA 运行时）158KB
    common/SuperOriginalWizard.tsx  # 「超级原创」向导（可作为新面板的 UI 蓝本）
    models/MsstModelManager.tsx     # 资源管理器（顶部 tab: separation|amt|lyrics|runtime|voice）
    models/AmtConversionDialog.tsx
    synth/DawWorkflowSplit.tsx # 上 DawView / 下单个可调面板
    workflow/WorkflowEditor.tsx
    workflow/nodes/*           # 节点 UI（RvcNode / SoVitsNode / SeparationNode ...）
  lib/
    models/msst-catalog.ts     # 镜像/目录定义：MirrorSource, applyMirror, GhMirror, ghMirrorCandidates
    models/amt-catalog.ts      # AMT 目录（I18nText 形状参考）
    workflow/engine.ts         # 节点执行引擎（switch(nodeType)），92KB
    workflow/templates.ts      # 纯数据模板（buildTranscribeWorkflow 等）
    audio/import.ts            # importAudioToNewTrack / importAudioToExistingTrack
    audio/exportLaneAudio.ts   # exportOneAudioFileToFolder
    project/bundle.ts          # .usp 工程包
  store/
    app.ts                     # modelManagerOpen / showToast / showConfirm / zoom
    project.ts                 # tracks / addTrack / mergeProcessedOutputs（轨道 & 子轨沉积）
    msst-models.ts             # mirror / ghMirror / downloading / downloadEntry
    amt-models.ts              # 同上（AMT 版）
    workflow.ts                # 执行状态（executions / nodeOutputs / status）
  types/project.ts             # Track / Segment / ProcessedOutput / WorkflowNodeType(联合类型)
src-tauri/src/
  lib.rs                       # AppState{ data_dir, models_dir, msst_models_dir, amt_models_dir, cache_dir } + invoke_handler
  commands/{msst_models.rs, models.rs, assets.rs, download.rs, storage.rs, settings.rs, audio.rs}
data/
  models/{msst,amt,auxiliary}  # 落盘目录
  workflow_presets.json        # 已存在（storage.rs 的 load_workflow_presets/save_workflow_preset）
```

### 1.2 已有的、必须复用的基础设施

| 能力 | 现成实现 | 复用方式 |
|---|---|---|
| 下载线路（HF / HF镜像 / 自定义） | `MirrorSource` + `applyMirror()`（msst-catalog.ts）；GH 代理 `GhMirror` + `ghMirrorCandidates()` | 音乐模型目录直接沿用同一 `mirror`/`ghMirror` 状态与设置 UI |
| 下载引擎 | `download.rs`（.part 断点续传 + 镜像轮换 + 停滞看门狗 + sha256 校验后改名）；事件 `msst-download-progress` | 新增命令走同一引擎，事件名沿用同一模式 |
| 模型管理器 UI | `MsstModelManager.tsx`（顶部 tab + 分类侧栏 + 下载卡片 + 进度） | 「音乐模型」作为新 tab；分类沿用 `CATEGORY_LABELS` 的 `I18nText` 形状 |
| 节点执行 | `lib/workflow/engine.ts` 的 `switch(nodeType)` | 新增两个节点类型，落进同一引擎（免费获得缺失组件检测/进度/取消/沉积/缓存） |
| 轨道沉积 | `store/project.ts` 的 `mergeProcessedOutputs` / `ProcessedOutput` | 生成中间结果 → 以 loading 占位子轨呈现 → 完成替换 |
| 三语 | `i18n/parity.test.ts` | 所有新文案三语同步，否则测试红 |
| 工程保存 | `bundle.ts` + `workflow_presets.json` | 歌曲历史另存一份 JSON |

### 1.3 外部模型情报（摘要，决定参数设计）

**YuE2**（`multimodal-art-projection/YuE`，代码 Apache-2.0 / **权重 CC BY-NC 4.0，非商用**）
- 3B AR-NAR Mixture-of-Transformers。流程：`plan() → generate_semantic() → synthesize() → decode()`。
- **先产出可编辑符号谱（ABC notation，含旋律+和弦），再渲染为 48 kHz 立体声歌曲**——天然对应「MIDI 轨道」需求。
- 参数：`cot`（`full`=旋律+和弦（默认）/`melody`=仅旋律（推荐翻唱）/`off`=直接生成）、`abc`（外部 ABC 谱，需 cot≠off）、`cfg_scale`（full/melody 默认 1.0；off 默认 1.01）、`seed`、`num_inference_steps`（默认 30）、`prompt`（风格：语言/流派/乐器/人声特征/速度）、`lyrics`（带 `[Verse]/[Chorus]` 段落标签）。
- 运行：Linux + Python 3.12 + BF16 + 24GB 显存 GPU；安装 `pip install .` 或 HF 上的 `yue2_infer-0.1.5-py3-none-any.whl`（含 7.3GB checkpoint）。官方无 Windows 原生支持 ⇒ 本项目的接入按「外部推理服务/子进程」设计（见 §4.6）。
- 输出目录保留 `score/tokens/latents/settings/model identities` ⇒ 有原生「生成历史 + 元数据」结构，直接映射需求 6。

**ACE-Step 1.5**（`ace-step/ACE-Step-1.5`，**MIT，可商用**，2026-02-03）
- LM planner（CoT 出 metadata/lyrics/captions）→ DiT + AutoencoderOobleck VAE（25Hz 立体声 latent）+ Qwen3 文本编码器；flow matching；48 kHz，10s–600s。
- 参数：`prompt`（风格标签）、`lyrics`（`[verse]/[chorus]/[bridge]`，空行=器乐段）、`audio_duration`（默认 30，范围 10–240）、`num_inference_steps`（turbo 默认 8，1–20）、`guidance_scale`（默认 1.0，0–20；turbo >1.0 被忽略）、`shift`、`negative_prompt`、`seed`、`format`（flac/wav/ogg/mp3）；另有 BPM 60–200、Key/调性、拍号、19–50+ 语言标记。
- 三档 checkpoint：Turbo(3.5B, 8 步) / XL Turbo(~10B INT8, 8 步) / Base(3.5B, 5–100 步)；2026-04-02 的 XL 系列(4B) 需 ≥12GB 显存 offload、推荐 ≥20GB。
- 已完成能力：**Multi-Track Generation**、Track Separation（vocals/drums/bass/other）、Repaint/Edit、Cover、Vocal2BGM、Metadata Control、LRC 生成。**官方无 MIDI 输出** ⇒ MIDI 需经 AMT 转录环节（本项目已有 AMT）。三档工作流：Turbo 草稿 → XL Turbo 精修 → Base(40–60) 抛光。
- 运行：Python 3.11 + `uv sync`；`uv run acestep-api --port 8001`（HTTP API）或 `python app.py --port 7860`（Gradio）。首次自动下载约 5GB。支持 CUDA/ROCm/XPU/Mac MPS，CPU 仅推理。

**许可差异必须在 UI 明示**：YuE2 权重 **CC BY-NC 4.0（非商用）**；ACE-Step **MIT（可商用）**。资源管理器的模型卡片需要许可证标签（沿用 `assets.rs` 的 `license: Option<&str>` 思路）。

---

## 2. 需求分解与验收口径

| # | 需求 | 验收口径 |
|---|---|---|
| R1 | 主页面「歌曲制作」入口 + 模型选择面板 | 标题栏/工具栏出现按钮；点击弹出面板，先选模型（YuE2 / ACE-Step），选中后进入该模型的设置页 |
| R2 | 资源管理器新增「音乐模型」分类 | `MsstModelManager` 新增顶部 tab；两个模型可下载/删除/查看进度；下载走同一 `mirror`/`ghMirror` 线路 |
| R3 | 各模型独立的歌词/提示词/参数调节 | 两套独立表单，字段按 §5 定义，含**男女声**设置；参数有默认值、范围、tooltip |
| R4 | 生成时旁侧显示多轨 MIDI 并可合成单一轨道 | 生成开始即在轨道区出现多条子轨（MIDI/音频），生成中→可试听→完成；提供「合成单一轨道」 |
| R5 | 生成过程直接以轨道形式显示在轨道区 | 轨道区可见「生成中」占位子轨，进度同步；不占用 WorkflowEditor 的下方面板互斥槽位 |
| R6 | 生成历史记录 + 歌曲名 + 可试听 + 结果落轨 | 历史列表（名称/时间/模型/时长/歌词摘要）；可回放试听；可「恢复到轨道」 |
| R7 | 尽力让两模型都支持 MIDI 轨道 | YuE2：ABC 符号谱 → 直接转 MIDI（原生）；ACE-Step：生成音频 → 复用 AMT 转录为 MIDI 子轨 |
| R8 | 三语 + 构建 | `npx tsc -b --noEmit` 与 `npx vitest run src/i18n` 通过；重建 exe 并替换安装版 |

---

## 3. 总体架构

```
[Titlebar「歌曲制作」按钮]
        │ setSongStudioOpen(true)
        ▼
SongStudioDialog (新增, lazy)
  ├─ Step 1  模型选择  ModelPicker（YuE2 / ACE-Step 卡片；显示许可证/显存需求/是否已安装）
  └─ Step 2  设置页    (按 model 分支)
       ├─ YuESettingsPanel   — 歌词 / 风格 prompt / cot / cfg / steps / seed / 人声(男女声) / 段落标签
       └─ AceStepSettingsPanel — 歌词 / prompt / duration / steps / guidance / shift / negative / seed / BPM / Key / 拍号 / 语言 / checkpoint 档位
              │ 点「生成」
              ▼
        generationController (新增 lib/song/generation.ts)
          1. 建一条「歌曲制作」载体轨（trackType: "audio"），挂 workflow: {input → songGen(模型) → output×N}
          2. songGen 节点 params 带上全部设置 → 交给 engine.ts 执行
          3. engine 侧调用 Rust 命令（或外部服务）产出：
             - audio 全曲
             - N 条 MIDI/音频 stem（YuE2: ABC→MIDI；ACE-Step: 分轨音频→AMT→MIDI）
          4. 生成中：每条 stem 先以 loading 占位子轨写进 segment.processedOutputs → 轨道区立即可见
          5. 完成：替换为真实音频/MIDI 路径 → 可试听
          6. 写入 SongHistory（data/song_history.json）+ 存档到工程
```

**关键决策**：
- **不改 WorkflowEditor 的下方面板互斥槽位**（`DawWorkflowSplit` 的 workflowSegmentId/vocalSegmentId/amtResult 三选一）。「歌曲制作」是**独立弹窗**，生成结果直接落到轨道区（走 `processedOutputs` 子轨机制）。
- **新增两个节点类型** `songGenYue2` / `songGenAceStep`（`WorkflowNodeType` 联合类型扩展），这样执行、进度、取消、沉积、缓存全部复用引擎，不另起一套。
- 载体的轨道命名 = 用户输入的**歌曲名**。

---

## 4. 详细实现

### 4.1 R1 — 主页面入口 + 模型选择面板

**新增文件**
- `src/components/song/SongStudioDialog.tsx`（+ `.css`）
- `src/components/song/ModelPicker.tsx`
- `src/components/song/Yue2SettingsPanel.tsx`
- `src/components/song/AceStepSettingsPanel.tsx`
- `src/components/song/SongHistoryPanel.tsx`

**改动**
- `src/App.tsx`：`const SongStudioDialog = lazy(() => import("./components/song/SongStudioDialog").then(m => ({default: m.SongStudioDialog})))`；新增 `songStudioOpen` 状态（或复用 `useAppStore`，见下）；在弹窗区渲染 `{songStudioOpen && <SongStudioDialog onClose={...} />}`。**注意**：App.tsx 里已有一处「不叠加弹窗」的纪律（见现有 confirm/updateDialog 判断），新弹窗在打开前要检查 `trainingPageOpen`（全屏页）以避免互相遮挡。
- `src/store/app.ts`：新增 `songStudioOpen: boolean` + `toggleSongStudio: () => void`（与 `modelManagerOpen/toggleModelManager` 完全同构），并在 `Titlebar.tsx` 的 AI 菜单或顶部按钮接入。
- `src/components/common/Titlebar.tsx`：
  - 在 `aiItems` 里追加 `{ label: t("song.entry"), icon: "🎵", onClick: toggleSongStudio }`；
  - 同时在右侧按钮区（「超级原创」按钮旁，见 `sow-titlebar-btn`）加一个主入口按钮，`onClick={toggleSongStudio}`。

**模型选择卡片内容**（`ModelPicker`，数据来源 `SONG_MODEL_CATALOG`，见 §4.2）

| 字段 | YuE2 | ACE-Step |
|---|---|---|
| 定位 | MIDI / 人声歌曲生成（符号谱优先） | 多轨生成（LM+DiT，音频优先） |
| 许可 | CC BY-NC 4.0（非商用） | MIT（可商用） |
| 显存建议 | ≥24GB（BF16） | ≥4GB（turbo）/ ≥12GB（XL） |
| 产出 | ABC 谱 + 48kHz 立体声歌曲 | 48kHz 多轨/全曲 |
| MIDI | 原生（符号谱转 MIDI） | 经 AMT 转录 |
| 状态 | 已安装 / 未安装（给「去资源管理器下载」按钮 → `toggleModelManager`） |

未安装时禁用「下一步」并给明确引导文案（沿用 `SuperOriginalWizard` 的「缺什么就地提示 + 打开模型管理」范式）。

### 4.2 R2 — 资源管理器「音乐模型」分类 + 下载线路

**新增文件**
- `src/lib/models/song-catalog.ts`：定义 `SongModelId`、`SongCatalogEntry`、`SONG_MODEL_CATALOG`、`SONG_CATEGORIES`、`SONG_CATEGORY_LABELS`。
- `src/store/song-models.ts`：与 `msst-models.ts` **同构**的 zustand store。

**`song-catalog.ts` 骨架**（沿用 `I18nText` / `MirrorSource` 形状）

```ts
import type { I18nText, MirrorSource } from "./msst-catalog";

export type SongModelId = "yue2" | "acestep";
export type SongCategory = "songmidi" | "songmultitrack";   // 音乐模型分类

export const SONG_CATEGORY_LABELS: Record<SongCategory, I18nText> = {
  songmidi:       { zh: "歌曲MIDI/人声生成", en: "Song (MIDI/Vocal)", ja: "楽曲（MIDI/ボーカル）" },
  songmultitrack: { zh: "歌曲多轨生成",     en: "Song (Multi-Track)", ja: "楽曲（マルチトラック）" },
};

export interface SongCatalogEntry {
  id: SongModelId;
  name: I18nText;
  description: I18nText;
  category: SongCategory;
  /** 主产物在 <data>/models/song/<file>（HF 仓库内的相对路径） */
  files: { rel: string; size: number; sha256: string }[];
  license: string;                       // "CC-BY-NC-4.0" | "MIT"
  upstream: string;                      // 原始发布页（attribution 必须可达）
  minVramMb: number;
  outputs: ("audio" | "midi" | "stems")[];
}
```

**持久化目录**：`<data>/models/song/`（Rust 侧新增 `state.song_models_dir = models_dir.join("song")`，与 `msst`/`amt` 并列）。

**下载线路**（关键：**不新建线路，直接跟随既有设置**）
- store 里 `mirror: loadSetting("utai.mirror", DEFAULT_MIRROR)`、`ghMirror: loadSetting("utai.ghMirror", DEFAULT_GH_MIRROR)`、`ghPresets: BUILTIN_GH_PRESETS` —— 与 `msst-models.ts` 完全一致，因此**设置页改一次，全部模型生效**。
- 下载 URL 组装：`ghMirrorCandidates(applyMirror(entry.file.downloadUrl, mirror), ghMirror, ghPresets)`。
- 下载命令：复用 `download.rs` 引擎，新增 `download_song_model(app, file, urls[], sha256, destDir)`，事件名沿用 `"msst-download-progress"` 或新开 `"song-download-progress"`（**建议新开**，避免与 MSST 卡片状态串台）。

**`MsstModelManager.tsx` 改动**
- `type TopTab` 追加 `"songmodel"`；顶部 tab 按钮区追加一项（沿用现有 `topTab === "x" ? "active" : ""` 写法）。
- 新增渲染分支 `{topTab === "songmodel" && <SongModelsTab lang={lang} />}`，内部：左侧 `SONG_CATEGORIES` 侧栏（模仿现有 `ALL_CATEGORIES.map` 的 622 行写法）+ 右侧卡片列表（下载/删除/进度）。建议把 `SongModelsTab` 抽成独立组件文件 `src/components/models/SongModelsTab.tsx`，避免 113KB 的 `MsstModelManager.tsx` 继续膨胀。

**设置页（Settings.tsx）**：**无需新增控件**——音乐模型复用「下载源」这一节的目标（HF/镜像/自定义 + GH 代理）。但需在其 note 文案里补一句「音乐模型同样遵循此处下载源」。若要做「模型卡片显示许可证」，则把 `assetLicenseTip` 的 i18n 文案复用即可。

### 4.3 R3 — 各模型的歌词 / 提示词 / 参数（**本文档重点**）

两套面板各自独立定义。所有字段都走 `useNodeParams` 或本地 state 后写入节点 `params`，并同时镜像进 `SongHistory` 记录。

#### 4.3.1 YuE2 设置页字段

| 分组 | 字段 | 控件 | 默认 | 范围 | 说明（tooltip 三语） |
|---|---|---|---|---|---|
| 歌词 | `lyrics` | 多行文本框（等宽，`[Verse]`/`[Chorus]` 标签高亮，字数统计） | 空 | — | 支持 `[Verse] [Chorus] [Bridge]` 段落标签；行内换行=乐句 |
| 歌词 | `lyricsLang` | 下拉 | 自动 | zh/en/ja/ko/… | 歌词语言标记，喂给 style prompt |
| 提示词 | `prompt`（风格） | 多行文本框 | 空 | — | 语言/流派/乐器/人声特征/速度，例："female vocal, mandarin pop, piano and strings, 92 BPM" |
| 提示词 | `genreQuick` | chip 多选（流行/摇滚/电子/中国风/民谣/K-Pop…） | 空 | — | 快捷标签，追加进 `prompt` |
| 生成方式 | `cot` | 分段选择 | `full` | `full`/`melody`/`off` | full=旋律+和弦（原创）；melody=仅旋律（**翻唱推荐**）；off=直接生成 |
| 生成方式 | `abc` | 文件选择/文本框（高级，可折叠） | 空 | — | 外部 ABC 谱；需 `cot != off` |
| 采样 | `cfg_scale` | 滑条 | 1.0（off 时 1.01） | 0.5–2.0 | 跟随度；`cot=off` 建议 1.01 |
| 采样 | `num_inference_steps` | 滑条 | 30 | 10–100 | 步数越多越慢越细 |
| 采样 | `seed` | 数字 + 🎲 | 0（随机） | 0–2^31 | 0=随机；固定值可复现 |
| **人声** | `vocalGender` | 二选/三选 | `auto` | `auto`/`female`/`male` | **男女声**；自动=交给 prompt 推断 |
| **人声** | `vocalType` | 下拉 | 空 | 童声/女声/男声/合唱/说唱 | 进一步的人声特征，写入 prompt |
| **人声** | `vocalRange` | 「低/中/高」选择 | 中 | — | 写入 prompt 的 "low/medium/high register" |
| 结构 | `songDuration` | 滑条（秒） | 120 | 30–300 | 目标时长 → 决定生成段落数 |
| 结构 | `chorusCount` | 滑条 | 2 | 0–6 | 副歌重复次数，写进 lyrics 段落提示 |
| 输出 | `wantMidi` | 开关（默认**开**） | true | — | 是否导出 ABC→MIDI 子轨 |
| 输出 | `wantStems` | 开关 | false | — | 是否按符号谱拆分（旋律/和弦/贝斯）为多 MIDI 轨 |

**男女声落点**：`vocalGender` + `vocalType` + `vocalRange` 三者合成一段英文标签追加到 `prompt`；同时在节点 params 里**独立保存**这三个字段（不要只存拼接结果），因为历史记录与后续"改演唱"要能回读。

#### 4.3.2 ACE-Step 设置页字段

| 分组 | 字段 | 控件 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| 歌词 | `lyrics` | 多行文本框 | 空 | — | `[verse]/[chorus]/[bridge]`；**空行=器乐段** |
| 歌词 | `language` | 下拉（top10 置顶） | zh | en/zh/ru/es/ja/de/fr/pt/it/ko/… | 影响演唱发音 |
| 提示词 | `prompt`（风格标签） | 多行文本框 | 空 | — | 风格/乐器/情绪标签 |
| 提示词 | `negative_prompt` | 单行 | 空 | — | 负向提示 |
| 提示词 | `instrumental` | 开关 | false | — | 纯器乐（清空 lyrics 生效） |
| 时长 | `audio_duration` | 滑条（秒） | 30 | 10–240 | 官方最可靠到约 4 分钟 |
| 采样 | `num_inference_steps` | 滑条（按档位联动） | 8 | 1–20（turbo）/5–100（base） | Turbo 固定 8 |
| 采样 | `guidance_scale` | 滑条 | 1.0 | 0–20 | turbo >1.0 被忽略（面板要按档位禁用） |
| 采样 | `shift` | 滑条 | 1.0 | 0.5–5 | flow matching 时间步偏移 |
| 采样 | `seed` | 数字 + 🎲 | 随机 | — | 复现 |
| 音乐性 | `bpm` | 数字 + 检测按钮 | 自动 | 60–200 | 可「从歌词/风格自动推断」 |
| 音乐性 | `keyScale` | 下拉（C…B + maj/min） | 自动 | — | 调性 |
| 音乐性 | `timeSignature` | 下拉 | 4/4 | 3/4,4/4,6/8… | 拍号 |
| **人声** | `vocalGender` | 三选 | `auto` | auto/female/male | **男女声**（写入 prompt 的 "female vocal"/"male vocal"） |
| **人声** | `vocalStyle` | 下拉 | 空 | 气声/清亮/沙哑/童声/说唱 | 音色标签 |
| 档位 | `checkpoint` | 三选 | `turbo` | turbo/xl-turbo/base | 面板按档位联动 steps/guidance/显存提示 |
| 质量 | `refineChain` | 开关 | false | — | Turbo 草稿 → XL Turbo 精修 → Base(40–60) 抛光 |
| 输出 | `wantStems` | 开关（默认**开**） | true | — | 是否做 Track Separation 出多轨 |
| 输出 | `wantMidi` | 开关 | true | — | 是否对每轨跑 AMT 转 MIDI（复用现有 AMT） |
| 输出 | `wantLrc` | 开关 | false | — | 生成 LRC 歌词文件 |
| 输出 | `format` | 下拉 | wav | flac/wav/ogg/mp3 | 落盘格式 |

**档位联动规则（必须在 UI 实现）**
- `turbo`：steps 锁定 8，`guidance_scale` 控件置灰（提示"turbo 忽略 >1.0"），显存提示 ≥4GB。
- `xl-turbo`：steps 8，显存提示 ≥12GB（offload）/ ≥20GB 推荐。
- `base`：steps 可调 5–100（默认 27，提示"27 步为甜点"），显存 ≥12GB。

#### 4.3.3 公共设置（两个模型共用，放在面板顶部折叠区）

| 字段 | 说明 |
|---|---|
| `songName` | **歌曲名**（必填，默认 `Untitled Song YYYY-MM-DD HH:mm`），作为载体轨名 + 历史记录名 |
| `outputFolder` | 输出目录（默认 `<data>/songs/<sanitized(songName)>/`） |
| `autoAddToTimeline` | 生成完成自动落轨（默认开） |
| `keepIntermediate` | 保留中间产物（ABC 谱 / latent / 分轨）默认开 |
| `device` | 复用 `DeviceConfig`（沿用 Settings 的 CUDA/DirectML/CPU 选择） |

**面板布局**：左「设置表单」（可滚动，分组折叠），右「预览/历史」（歌词预览、上次生成结果、`SongHistoryPanel`）。这与需求「生成时旁侧显示多轨 MIDI 轨道」呼应——右侧预览区在生成中实时刷新轨道列表。

### 4.4 R4/R5 — 多轨 MIDI 显示、单轨合成、生成过程落轨

**核心机制：复用 `ProcessedOutput` 子轨（loading 占位）**

1. 生成开始时，在载体轨的 segment 上写入 N 条 loading 占位：
   ```ts
   const placeholders: ProcessedOutput[] = stems.map((s, i) => ({
     outputNodeId: `songstem_${i}`,
     laneId: `songstem_${i}`,
     laneLabel: `${songName} · ${s.label}`,   // 沿用 " · " 分隔约定（laneOps.laneLabelParts）
     group: songName,
     loading: true,
     audioPath: "",
   }));
   useProjectStore.getState().mergeProcessedOutputs(trackId, segmentId, placeholders);
   ```
   轨道区立刻出现「生成中…」的多条子轨（`loading: true` 已经在 UI 有骨架/转圈表现）。
2. 每个 stem 完成 → `mergeProcessedOutputs` 用真实 `audioPath` **替换同 `outputNodeId`** 的那条（该方法本就是"replace only the lanes present, keep siblings"）。
3. **音轨 vs MIDI 轨**：
   - YuE2：ABC 谱 → 用 Rust 侧新增 `abc_to_midi`（或前端 `lib/song/abc.ts` 简单解析）生成 `.mid`；旋律/和弦/贝斯分别成轨。MIDI 落轨沿用现有 `amtMidi`/`midiFileIn` 的 MIDI 导入通路（`lib/vocal/midiExtract.ts` / `importScoreFile`）。
   - ACE-Step：分轨音频（vocals/drums/bass/other）→ 每条走 **现有 AMT 节点**转 MIDI（`amtMidi` 节点的引擎分支，`engine.ts:778`），产出可编辑 MIDI 轨；同时保留音频轨。
4. **「合成单一轨道」**：面板上给一个按钮，把当前 N 条 stem 的音频按时间对齐求和导出一条 wav。
   - 复用 `src/lib/audio/exportMixdown.ts` 的 mixdown 逻辑（或 `exportLaneAudio.ts`）；
   - 产物作为该载体轨的**主音频段**（`content.type === "audioClip"` 指向新 wav），子轨折叠。
   - MIDI 侧的"合成单一轨"：把 N 条 MIDI 轨合并为一个 MIDI 文件（多 channel），复用现有 MIDI 导出（`export_score.rs` / `export_score.ts`）。

**进度显示**：节点 `songGen*` 的 `setNodeProgress`（`store/workflow.ts`）已经在节点卡片上有环/条；同时在**轨道区的占位子轨**上显示百分比（占位项的 `laneLabel` 后缀 `(45%)` 或单独的进度条，按实现成本二选一，优先 label 后缀）。

### 4.5 R6 — 生成历史 + 歌曲名 + 试听

**新增文件**
- `src/lib/song/history.ts`：`SongHistoryEntry` 定义 + `loadSongHistory()` / `saveSongHistory()` / `pushSongHistory()`。
- `src/components/song/SongHistoryPanel.tsx`。

```ts
export interface SongHistoryEntry {
  id: string;                 // uuid
  songName: string;
  model: SongModelId;
  createdAt: number;          // epoch ms
  durationSec: number;
  lyrics: string;             // 原样保存
  prompt: string;
  /** 完整设置快照（含 vocalGender 等）——「恢复设置」与复现靠它 */
  settings: Record<string, unknown>;
  /** 产物路径 */
  audioPath: string;          // 全曲
  stems: { label: string; audioPath?: string; midiPath?: string }[];
  midiPath?: string;          // 合并 MIDI
  lrcPath?: string;
  license: string;            // 许可证随记录留痕
}
```

**持久化**：Rust 侧新增（与 `workflow_presets.json` 同域）
- `load_song_history(state) -> String`（缺文件返回 `[]`）
- `save_song_history(state, entries: serde_json::Value) -> Result<(), String>`
落 `<data>/song_history.json`。**直接照抄 `storage.rs` 的 `preset_file` / `load_workflow_presets` / `save_workflow_preset` 范式。**

**试听**：复用现有播放通路——历史条目点 ▶ 时用 `load_audio_file`（`commands/audio.rs:28`）加载 `audioPath` 交给前端播放器；MIDI 试听走现有 MIDI 预览。

**「恢复到轨道」**：把历史条目的 `stems` 重新 `mergeProcessedOutputs` 到当前工程（或新建载体轨）。

**历史列表 UI**：名称 / 模型徽标 / 时间 / 时长 / 许可证 / ▶ 试听 / 恢复设置 / 恢复到轨道 / 删除 / 打开输出文件夹（`open` 目录选择器反向定位，用 `plugin-shell` 或现有导出辅助）。

### 4.6 生成后端接入（关键工程决策）

两个模型都是**外部的 Linux/Python 推理栈**，而本项目是 Windows Tauri。建议**分阶段**：

**阶段 A（可先落地，纯前端 + 现有 AMT）**
- 新增节点类型与全部 UI/设置/历史/落轨；
- 生成动作先接「**本地服务 HTTP**」：用户在设置里配置服务地址（默认 `http://127.0.0.1:8001` for ACE-Step，`http://127.0.0.1:8port` for YuE2）；
- Rust 新增 `commands/song.rs`：`song_service_probe(url)`、`song_generate(req) -> 产物路径列表`（内部 `reqwest` 调外部服务；若用户已装 Python 环境也可以 `Command::new("uv").args(["run","acestep-api"])` 拉起，但**默认不自动拉起**，只提示）。

**阶段 B（可选增强）**
- 若后续要做「一键内嵌运行时」，参照现有 `pyenv.rs` 的便携 Python 运行时机制新增「音乐模型运行时包」（体量极大，非本期必须）。

**必须的新增 Rust 命令清单**（`commands/song.rs`，并在 `lib.rs` 的 `generate_handler!` 注册）
| 命令 | 作用 |
|---|---|
| `get_song_models_dir()` | 返回 `<data>/models/song` 并建目录 |
| `list_song_models()` | 扫描已下载模型文件 |
| `download_song_model(app, file, urls, sha256, size)` | 走 `download.rs` 引擎 |
| `delete_song_model(filename)` | 删除 |
| `load_song_history()` / `save_song_history(entries)` | 历史持久化 |
| `song_service_probe(url)` | 探测外部推理服务可用性 |
| `song_generate(req: SongGenRequest)` | 调外部服务并落 `<data>/songs/<name>/`，返回产物路径 |
| `abc_to_midi(abc: String, outPath: String)` | （可选）ABC→MIDI；若前端实现则不需要 |

**`SongGenRequest`（Rust 侧 `serde::Deserialize`）字段**：`model`、`song_name`、`lyrics`、`prompt`、`negative_prompt`、`cot`、`cfg_scale`、`num_inference_steps`、`seed`、`audio_duration`、`guidance_scale`、`shift`、`bpm`、`key_scale`、`time_signature`、`language`、`vocal_gender`、`vocal_type`、`vocal_range`、`checkpoint`、`want_stems`、`want_midi`、`want_lrc`、`format`、`service_url`、`output_dir`。

**进度事件**：`song-progress`（`{ stage, current, total, stemLabel }`），前端 `listen` 后同时更新节点进度和占位子轨。

### 4.7 引擎改动（`lib/workflow/engine.ts`）

- `types/project.ts`：`WorkflowNodeType` 追加 `"songGenYue2" | "songGenAceStep"`。
- `engine.ts` 的 `switch (nodeType)` 追加两个 case：组装 `SongGenRequest` → `invoke("song_generate", ...)` → 监听 `song-progress` → 把返回的 N 条产物 `outputData.set(port, path)`（输出端口数 = N，动态）。
- 缺失组件检测（`MissingModelItem`）：若 `SONG_MODEL_CATALOG` 对应文件不在 `list_song_models()` 结果里 → 走 `maybeShowErrorModal` / 缺失模型弹窗（沿用现有 `preflightRun` 流程）。
- `NodePalette.tsx`：`getPaletteDefs` 里新增分组「歌曲制作」，两个节点卡片（`{ type: "songGenYue2", label: "YuE2 歌曲生成", icon: "🎼", color: "#22d3ee" }`、`{ type: "songGenAceStep", label: "ACE-Step 多轨生成", icon: "🎛️", color: "#f472b6" }`）。
- 节点 UI：`src/components/workflow/nodes/SongGenNode.tsx`（一个组件按 `nodeType` 分支，复用 `NodeShell` + `ParamSlider`）。

### 4.8 i18n（三语必须同步）

新增顶层命名空间 `song`（zh/en/ja 各一份，键集合完全一致）。建议键：

```
song.entry            歌曲制作
song.title            歌曲制作
song.stepModel        选择模型
song.stepSettings     生成设置
song.model.yue2       YuE2 — MIDI / 人声歌曲生成
song.model.acestep    ACE-Step — 多轨生成
song.license          {value} 授权
song.notInstalled     未安装
song.gotoManager      去资源管理器下载
song.lyrics           歌词
song.lyricsHint       使用 [Verse] [Chorus] 标记段落
song.prompt           提示词（风格）
song.negative         负向提示
song.cot              生成方式
song.cotFull          旋律 + 和弦（原创）
song.cotMelody        仅旋律（翻唱推荐）
song.cotOff           直接生成
song.cfg              提示词跟随度
song.steps            推理步数
song.seed             随机种子
song.duration         时长（秒）
song.guidance         引导强度
song.shift            时间步偏移
song.bpm              速度（BPM）
song.key              调性
song.meter            拍号
song.language         语言
song.checkpoint       模型档位
song.vocalGender      人声性别
song.genderAuto       自动
song.genderFemale     女声
song.genderMale       男声
song.vocalType        人声音色
song.vocalRange       音域
song.wantStems        生成多轨
song.wantMidi         生成 MIDI 轨
song.wantLrc          生成 LRC 歌词
song.songName         歌曲名
song.outputFolder     输出目录
song.generate         生成
song.generating       生成中…
song.preview          试听
song.mergeSingle      合成单一轨道
song.history          生成历史
song.historyEmpty     暂无生成记录
song.restoreSettings  恢复设置
song.restoreToTrack   恢复到轨道
song.delete           删除
song.licenseTip       仅提示：本模型权重为 {license}，请遵守其授权条款
```

同时给 `titlebar` 补 `songStudio` 键（若按钮文案走 titlebar 命名空间）。
**校验**：`npx vitest run src/i18n` 必须绿；`parity.test.ts` 会同时校验占位符 `{{...}}` 三语一致。

### 4.9 设置页（Settings.tsx）需要补的文案

- 「下载源」note 补一句：`settingsNote` = "音乐模型与其它模型共用此下载源。"
- 新增「歌曲生成服务」一节（阶段 A 需要）：外部服务地址输入框 + 「测试连接」按钮（复用 `handleSrcTest` 的按钮/结果样式 `settings-source-test` / `settings-mini-btn`）。

---

## 5. 实现顺序（建议提交切分）

| PR | 内容 | 依赖 |
|---|---|---|
| P1 | `song-catalog.ts` + `song-models.ts` + Rust `get/list/download/delete_song_model`；`MsstModelManager` 加「音乐模型」tab | 无 |
| P2 | `SongStudioDialog` + `ModelPicker` + 两个 Settings 面板（纯 UI + 本地 state） + 全部 i18n | P1 |
| P3 | `types/project.ts` 节点类型 + `engine.ts` case + `SongGenNode.tsx` + `NodePalette` | P2 |
| P4 | 生成落轨（占位子轨 → 替换）、进度、试听、合成单一轨道 | P3 |
| P5 | `song_history.json` + Rust 命令 + `SongHistoryPanel` + 恢复设置/落轨 | P4 |
| P6 | `commands/song.rs` 外部服务对接 + 设置页服务地址 | P4（可并行） |
| P7 | 构建 exe、替换安装版、安装版手测 | 全部 |

---

## 6. 验证清单

**自动化**
1. `npx tsc -b --noEmit` 通过（新类型/新组件无类型错误）。
2. `npx vitest run src/i18n` 通过（三语键集合 + 占位符一致）。
3. `npx vitest run` 全量通过（不得因改动 `types/project.ts` 破坏既有测试）。
4. `cargo check`（`src-tauri`）通过（新命令 + `generate_handler!` 注册正确）。

**构建与部署**
5. `npm run tauri build -- --no-bundle`。
6. **备份**旧 exe，替换 `F:\002 AIgequ\UtaiSynthesizer\UtaiSynthesizer.exe`；**保留**用户 `data/`（模型、工程、`workflow_presets.json`、`song_history.json`）与 `runtimes/`。

**安装版手测**
7. 标题栏/AI 菜单出现「歌曲制作」；打开 → 选模型 → 未安装时引导到资源管理器。
8. 资源管理器出现「音乐模型」分类；下载走当前设置的下载源（切 HF镜像/自定义各测一次）；进度、删除正常。
9. 两个模型的设置面板：字段默认值/范围/tooltip 正确；ACE-Step 档位联动（turbo 灰掉 guidance）生效；**男女声**设置写入 prompt 可见（在预览区回显）。
10. 点生成 → 轨道区立刻出现多条「生成中」子轨 → 完成后可试听 → 「合成单一轨道」产出单轨。
11. 生成历史出现记录（歌曲名/时间/模型/时长）；▶ 可试听；「恢复设置」「恢复到轨道」可用。
12. YuE2 能出 MIDI 轨；ACE-Step 经 AMT 出 MIDI 轨。
13. 关掉软件重开：历史、模型、工程均保留。

---

## 7. 边界与注意事项

- **许可证**：YuE2 权重 CC BY-NC 4.0（非商用）≠ 本项目 AGPL-3.0，也 ≠ ACE-Step 的 MIT。UI 必须在模型卡片与历史记录处明示，且保留 `upstream` 归属链接（参照 `assets.rs` 的 `license` / `upstream` 注释纪律）。
- **不改数据根**：新目录 `<data>/models/song/`、`<data>/songs/`、`<data>/song_history.json` 全部挂在既有 `data_root` 下（用户可能把 `data_dir` 指到别的盘，必须走 `data_root(state)`）。
- **弹窗纪律**：新弹窗打开前检查 `trainingPageOpen`（全屏训练页）与已有 confirm/updateDialog，避免叠加（App.tsx 现有注释明确这条）。
- **面板互斥**：不要把「歌曲制作」塞进 `DawWorkflowSplit` 的三选一槽位，否则会和 workflow/vocal/amt 面板互相顶掉。
- **节点内交互**：沿用 `nodrag` + `stopPropagation`，避免点开控件误拖节点。
- **i18n 三语铁律**：任何新键必须 zh/en/ja 同时加，占位符 `{{x}}` 三语一致；否则 `parity.test.ts` 直接红。
- **下载统一**：不要为音乐模型另写下载逻辑；一律经 `download.rs`（.part 续传 + 镜像轮换 + sha256 校验后改名），保证内容安全。
- **外部服务默认不自动拉起**：阶段 A 只提示 + 探测；自动拉起 Python 服务属于重型行为，需用户显式开启。
- **`MsstModelManager.tsx` 已 113KB**：新 tab 抽成独立文件，不要再往里堆。
- **重建 exe**：前端内嵌，任何前端改动都必须重建，否则安装版看不到新功能。

---

## 8. 附：关键代码锚点（实现时直接定位）

| 要做的事 | 去哪里 |
|---|---|
| 加一个全局弹窗开关 | `src/store/app.ts:99/351/402`（`modelManagerOpen` 全套写法） |
| 在标题栏加菜单项/按钮 | `src/components/common/Titlebar.tsx:218`（`aiItems`）、`:416`（`sow-titlebar-btn` 主按钮范式） |
| 挂 lazy 弹窗 | `src/App.tsx:37-41`（lazy 声明）、`:468-490`（渲染区） |
| 资源管理器加 tab | `src/components/models/MsstModelManager.tsx:51`（`TopTab`）、`:417-429`（tab 按钮）、`:619`（分支渲染）、`:622`（分类侧栏） |
| 下载线路 | `src/lib/models/msst-catalog.ts:606`（`applyMirror`）、`:679/727`（GH 代理）；`src/store/msst-models.ts:133-188`（下载流程） |
| 轨道沉积（loading→真实） | `src/store/project.ts:274/1003`（`mergeProcessedOutputs`）；`src/lib/audio/laneOps.ts:59-94`（lane 分组/命名） |
| 引擎加 case | `src/lib/workflow/engine.ts:599` 起（`switch` 各 case 范式） |
| 面板/节点 UI 范式 | `src/components/workflow/nodes/RvcNode.tsx`、`SoVitsNode.tsx`、`useNodeParams.ts` |
| 三语 | `src/i18n/{zh,en,ja}.json` + `src/i18n/parity.test.ts` |
| 持久化命令范式 | `src-tauri/src/commands/storage.rs`（`preset_file` / `load_workflow_presets` / `save_workflow_preset`） |
| 下载引擎 | `src-tauri/src/commands/download.rs`、`msst_models.rs:160-230`（进度事件写法） |
| AppState 目录 | `src-tauri/src/lib.rs:60-97`（新增 `song_models_dir`） |
| 引擎注册 | `src-tauri/src/lib.rs` 的 `generate_handler!` |
