# 四项功能移植与增强实施计划

## Context（背景）
用户在已安装版（`F:\002 AIgequ\UtaiSynthesizer`）上手动测试时，提出了 4 项改进。代码库为
Tauri + React（源在 `c:\Users\…\UtaiSynthesizer-main\UtaiSynthesizer-main`），前端改动内嵌在 exe
中，改完需重新 `npm run tauri build -- --no-bundle` 并替换安装版 exe。

四项需求与已确认的口径：
1. **输出节点下载自定义名**：工作流「输出到轨道」节点点下载：先选文件夹 → 再输文件名（有智能默认名）→ 保存/取消。
2. **横向缩放**：默认自动"看到整首"；HScrollbar 拇指边缘可拖拽缩放；训练按钮旁加 ‑ / + 和一个滑动条来放大缩小（用户已确认=仅横向 zoom，不改内容大小）。
3. **工作流保存/加载**：工作流编辑器头部加「保存工作流」（自定义名）与「加载工作流」（下拉选择）两个按钮，**全局通用**（存应用数据目录）；同时「帮助/社区」菜单删除所有地址链接，只保留 `QQ：202112`。
4. **轨道片段右键加「另存为」**：编曲区片段右键菜单（现有 分裂/删除/提取MIDI）新增「另存为」，把该片段（含其结果子轨）音频复制到选定目录。

---

## 需求 1 — 输出节点下载自定义名
**文件**：`src/components/workflow/nodes/AudioOutputNode.tsx`、`src/lib/audio/exportLaneAudio.ts`、i18n 三语文案、`NodeShell.css`（追加 `.wf-download-form` 样式）。

- 现有 `download()`（选目录→导出）改为两阶段内联表单：
  1. 点「⬇ 下载音频」→ 先 `open({directory})` 选目录；
  2. 在节点卡片内展开 `.wf-download-form`：一个文本框（预填默认名，可改）+「保存」「取消」。
  3. 保存：对 `outputPaths` 逐个用 `exportOneAudioFileToFolder(item, folder, sanitized(name))` 复制；toast 提示数量。取消：复位状态。
- **默认名**：新增辅助 `defaultOutputFileName(workflow, outputNodeId, fallback)`：
  - 在工作流 `connections` 里找 `toNode === outputNodeId` 的边，取其 `fromNode`（可直接从 `useAppStore.workflowSegmentId` → 项目 store 的 `segment.workflow` 读图，不必给 NodeShell 传 props）；
  - `fromNode` 类型为 `rvc/sovits` → `params.voiceName`（模型名）；
  - `fromNode` 类型为 `msstSeparation` → `params.stemLabels?.[fromPort]`（如「人声」「伴奏」）；
  - 其余/多条边 → `fromNode.label + "_"` 连接 或退回 `laneLabel`。
- 复用：`useNodeParams`、`exportOneAudioFileToFolder`、`laneExportErrorMessage`、`useAppStore.showToast`。
- i18n 新键：`workflow.outputSave`（保存）/`workflow.outputCancel`（取消）/`workflow.outputName`（文件名）/`workflow.outputPickFolder`（选择文件夹），同步 en/ja。

## 需求 2 — 横向缩放
**文件**：`src/components/synth/HScrollbar.tsx`、`src/components/common/Titlebar.tsx`、`src/components/synth/DawView.tsx`、`Titlebar.css`/`HScrollbar.css`、`src/lib/project/projectFile.ts`（或 App.tsx 加载后）。

- **默认看整首**：项目加载完成后调用一次 `fitToContent()`：`zoom = clamp(canvasWidth / (computeTotalTicks(tracks,axis) * PIXELS_PER_TICK), 0.1, 10)`（用 `useAppStore.setZoom`）。在打开/新建工程的加载流程里触发一次；不订阅持续调节（避免和用户缩放打架）。
- **HScrollbar 拇指边缘拖拽缩放**：给 `HScrollbarView` 的拇指加左右两个边缘拖拽 handle；拖左边缘＝缩小、右边缘＝放大，按 `dx` 连续调用 `useAppStore.setZoom`（clamp 0.1–10）。复用 app.zoom。
- **标题栏控件**：在 `Titlebar` 右侧（训练按钮同区块，训练按钮上方/左侧）加“‑ [slider] ＋”小控件，绑定 `app.zoom`。功能同 HScrollbar。
- 注意：DawView 里 `totalWidth` 已随 zoom 变化（`computeTotalTicks*PIXELS_PER_TICK*zoom`），HScrollbar/HScrollbarView 的 `totalWidth`/`viewWidth` 已由 DawView 传入，只需把 zoom 改动接到 store。DawView 传 `onZoomChange`（或 HScrollbar 自订阅 `setZoom`）。
- i18n 键：`titlebar.zoom`（缩放）或复用，三语文案。

## 需求 3 — 工作流保存/加载（全局）+ 帮助菜单清理
**文件**：`src/components/workflow/WorkflowEditor.tsx`、`WorkflowEditor.css`、`src-tauri/src/commands/*`（新增预设读写命令）、`src-tauri/src/lib.rs`（注册）、`src/components/common/Titlebar.tsx`（help 菜单）、i18n 三语。

- **保存工作流**：头部在 Run 按钮旁加「保存工作流」按钮 → 弹输入框（复用 `useAppStore.showConfirm` 的 `input` 模式，同 `promptNewGroup`）让用户命名 → 把当前 `reactFlowToWorkflow(nodes, edges)` 序列化（type/position/params + connections）存入预设列表 → 调 Rust `save_workflow_presets` 落盘。
- **加载工作流**：加「加载工作流」按钮 → 下拉列出已保存预设（打开时 `load_workflow_presets` 读列表）→ 选择后用 `workflowToReactFlow(preset)` 生成的节点/边替换 `nodes/edges`（复用现有 `workflowToReactFlow`/`reactFlowToWorkflow`），随后 debounced save 自动写入 `segment.workflow`。
- **持久化**：Rust 新增 `load_workflow_presets` / `save_workflow_presets` 两个 command，读写应用数据目录下 `workflow_presets.json`（与模型/配置同目录，全局共享）。前端用 `invoke` 调用。
- **帮助菜单清理**：`Titlebar` 的 `helpItems` 只保留第一行版本信息 + 一行纯文本 `QQ：202112`（去掉 guide/repo/score2convec/discord 的 openUrl）。i18n：`help.qq` 文案改为 `QQ：202112`，可保留多余键但不再被引用（parity 测试要求三语键一致，多余键保留无碍）。

## 需求 4 — 片段右键「另存为」
**文件**：`src/components/synth/Arrangement.tsx`、`src/lib/audio/exportLaneAudio.ts`、i18n（`menu.saveAs` 或 `tracks.saveAs`）。

- 在 `ctxMenu.segId` 分支的 `ctxItems`（现有 分裂/删除/复制/剪切/粘贴/…）顶部加 `{ label: t("tracks.saveAs"), onClick: … }`。
- onClick：`open({directory})` 选目录 → 对该片段的可导出音频（`content.type==="audioClip"` 的 `sourcePath`，加各 `processedOutputs[].audioPath`）用 `exportOneAudioFileToFolder` 逐个复制，命名 `<segmentId 前段>_<stem>.<ext>`；toast 提示。新增 `segmentExportItems(seg)` 辅助。
- i18n 新键：`tracks.saveAs`（另存为…），三语同步。

---

## 边界 / 注意
- 全部为前端改动，但 exe 内嵌前端 ⇒ 实现完成后**必须**重新 `npm run tauri build -- --no-bundle`，备份后替换 `F:\002 AIgequ\UtaiSynthesizer\UtaiSynthesizer.exe`（保留用户 `data`/`runtime`）。
- i18n parity 测试要求 zh/en/ja 键集合一致；新增键需三语同步。
- 下载/保存统一用 Rust `copy_audio_file_to`（不重编码、不破坏源文件）。
- 节点内交互统一 `nodrag` + `stopPropagation`（避免点开控件误触节点选择/拖拽），沿用现有输出节点的写法。

## 验证
1. `npx tsc -b --noEmit` 通过；`npx vitest run src/i18n` 通过。
2. 重新构建 release exe，备份旧 exe 后替换安装版。
3. 安装版手动测试：
   - 输出节点：下载 → 选目录 → 默认名（人声/伴奏/模型名）→ 改名保存；
   - 打开工程自动全景；拖 HScrollbar 拇指边缘、标题栏缩放控件均生效；
   - 工作流「保存/加载」跨工程可用；帮助菜单仅剩 QQ：202112；
   - 片段右键「另存为」把该片段导出到选定目录。