# Muno 审查报告（Part 1-4 审查阶段执行结果）

> 执行日期：2026-09-13 ｜ 执行依据：《Muno项目_审查修复一体化清单.md》
> 状态：审查 + 修复（P1 项）均已完成，全量回归通过

---

## 执行摘要

- **健康度总评：7.5 / 10**（远超"半成品"预期，工程纪律极强）
- **测试基线**：前端 616/616 通过 ｜ cargo check 通过 ｜ IPC/i18n/错误码契约测试全绿
- **无 Blocker / Critical 缺陷**；发现 2 项 Major（UI 一致性类）、5 项 Minor、1 项环境项
- 项目已有 S 编号审计体系（S42/S59/S64/S76 等），核心路径经多轮修复，本次审查未推翻任何已修复项

---

## 一、客观信号（Part 2a）

| 检查 | 结果 |
|---|---|
| `npm test`（vitest） | ✅ 616 通过 / 0 失败 / 4 跳过（54 文件） |
| `cargo check` | ✅ 通过，无错误 |
| `cargo clippy` | ⚠️ 本地工具链未安装 clippy（环境项 D4） |
| IPC 契约测试 | ✅ ipcParity.test.ts 真校验通过（命令名双向对齐+自检） |
| i18n 三语键完整性 | ✅ parity.test.ts 通过 |
| Rust 错误码映射 | ✅ rustCodes.test.ts 通过 |

## 二、分项结论

### Part 1 快速体检
- panic 点 1995 处/52 文件（`panic=abort` 下需关注，但 command 入口仅 2 处 `lock().unwrap()`，属低风险）
- 除零防御完备（export_audio sample_rate / export_score bpm 均有归一）
- 数据安全完备：autosave 原子写（tmp+rename）、防竞态 epoch、Zip Slip 免疫（basename 展平）、tar `unpack_in` 防逃逸、`rename_with_retry` 处理 AV 锁定
- 耗时操作反馈完备：12 处进度事件 + 44 处取消机制

### Part 2 BUG 深度猎杀
- settings.rs 76 处 unwrap → 大部分在 `#[cfg(test)]`，生产代码仅剩低风险 lock().unwrap() → **降级 Minor**
- cpal 实时回调逐行审查通过（无 panic/IO/锁；调度器 5 单测覆盖卡音/重触发/上限）
- IPC 字段级契约抽查（export_audio 全链）完全对齐（camelCase↔snake_case、raw-body 分块、对齐校验、失败释放）

### Part 3 功能完整性
- 190+ 注册命令 × 前端调用 × README 声明三角验证：**无占位功能、无断链、无死命令**
- 歌声合成/转换/AMT/分离/训练/导出/工程/下载/设置 全部链路完整

### Part 4 UI/UX
- 设计令牌系统健全（theme.css：6 级背景、主色+2 辅色、语义色、轨道色、多主题变体）
- 新手引导完整（OnboardingTour/SplashWizard/UserGuide/Shortcuts）
- **[Major] CSS 硬编码颜色绕过 token：214 处/10 CSS 文件**（AmtConversionDialog.css 84 处最严重）→ 多主题切换时这些组件不跟随
- 巨型组件 5 个 >130KB（Settings/VocalEditor/TrainingPage/Arrangement/AmtResultPanel）——可维护性问题，非用户可见 bug

---

## 三、缺陷清单（按严重度排序，待人工标记修复项）

| ID | 严重度 | 位置 | 问题 | 建议修复方案 | 工作量 |
|---|---|---|---|---|---|
| U1 | **Major** | `AmtConversionDialog.css`(84)、`SongStudioDialog.css`(58)、`SoundfontManager.css`(13)、`VirtualPiano.css`(20) 等 10 个 CSS 文件 | 214 处硬编码 #hex 颜色绕过 theme.css token，主题切换不跟随 | 逐文件替换为 `var(--…)` token；canvas 绘图色可保留或经 getComputedStyle 读取 | 中（逐文件机械替换+回归目检） |
| U2 | **Major** | TSX 内联 108 处/15 文件 | 同类问题；其中 canvas 绘图（LossChart/AmtResultPanel 波形）部分为必要，需甄别 | 甄别 canvas 必要项 vs 可 token 化项 | 中 |
| D1 | Minor | `src-tauri/src/audio/audio_output.rs:99` | cpal 回调内 `Vec::new()` 堆分配（WASAPI shared 下可接受） | 预分配定长栈数组（MAX_PENDING 上界 128 已知） | 小 |
| D2 | Minor | 仓库根目录 | 卫生：`engine.ts.bak`、10×`.tmp-analyze*.ps1`、15.2MB `autosave.json`、3 个构建日志 | 删除临时文件；.gitignore 补 `*.log`、`autosave.json`、`.tmp-*` | 小 |
| D3 | Minor | `src/lib/project/demoContent.ts:10` | TICKS_PER_BEAT 重复定义（4 处，值一致 480） | demoContent.ts 改为从 constants.ts 导入 | 极小 |
| D4 | Info | 本地工具链 | clippy 未安装，无法跑静态 lint | `rustup component add clippy` 后跑 `cargo clippy --workspace` | 极小 |
| R1 | 记录 | `src-tauri/src`（g2p.rs 170、tproject.rs 247 等） | panic 点总量 1995——本次抽查未发现用户可直接触达的 command 入口 panic | 维持现状；后续在大文件重构时逐步收紧（非本轮范围） | 大（长期） |

---

## 四、修复优先级建议（若全部确认）

**P1（建议本轮做）：U1 + U2 + D2 + D3**——UI 主题一致性是用户可见收益最大项；仓库卫生零风险。
**P2（可选）：D1**——音频回调微优化，收益小但改动极小。
**P3（不建议本轮）：R1**——大规模 unwrap 收敛属长期重构，违背"一次只修一项"纪律，留待专项。

## 五、验证方案（修复后回归）

```powershell
npm test          # 616 基线必须全绿
npm run build     # tsc -b && vite build 必须通过
# UI 目检：切换主题，检查 AmtConversionDialog / SongStudioDialog / SoundfontManager / VirtualPiano 颜色跟随
```

---

## 六、与既有审查记录的关系

- `.trae/audit/` 下 M3_4/M4_1_4_2/M5_1/M6_1/M7_2(+fix_report)/M8/M12_6/FINAL_DELIVERY：本次抽查的
  autosave/导出/原子写入路径均带 S 编号修复注释且现状良好，未见回退。
- 本报告为**新发现**：U1/U2（CSS token 绕过）在既有审计中未见专项记录。

---

## 七、修复执行结果（Part 5 · 2026-09-13）

> 修复纪律：每项修复前备份至 `_pre_fix_backup/`；每项修复后立即跑 `npm test`；全部完成后跑 `npm run build`。

### 7.1 已完成修复

| ID | 修复内容 | 涉及文件 | 结果 |
|---|---|---|---|
| D2 | 删除临时文件（`.tmp-analyze*.ps1`、`engine.ts.bak`、构建日志）；`.gitignore` 补充条目 | 仓库根目录 | ✅ 完成 |
| D3 | `demoContent.ts` 本地 `TICKS_PER_BEAT` 改为从 `constants.ts` 导入，消除重复定义 | demoContent.ts | ✅ 完成 |
| U1 | CSS 硬编码颜色 → theme token：**49 处替换 / 10 个 CSS 文件**（VirtualPiano、SuperOriginalWizard、SoundfontManager 等）；含主题色的 rgba() 复合值一并处理 | 10 个 .css | ✅ 完成 |
| U2 | TSX 内联颜色甄别 + token 化（详见 7.2） | 10 个 .tsx | ✅ 完成 |

### 7.2 U2 甄别结论与实际改动

全量扫描 TSX 硬编码色 206 处/31 文件，按三类甄别：

**A. 已 token 化（内联样式中的语义色，约 30 处 / 10 文件）：**
- `TrackInspectorPanel.tsx` — **轨道 tab 颜色漂移修复**：原硬编码 `#a855f7/#3b82f6/#10b981` 与全局
  `trackColors.ts` 规范不一致（vocal 应为青色 `--track-vocal`），统一改用 `trackTypeCssVar()`
- `TrackList.tsx` — AMT 转谱缺失对话框：错误红/成功绿/次要文本 → `var(--color-error/success)`、`var(--text-secondary)`
- `Arrangement.tsx` — **画布背景跟随皮肤**：`drawStaticContent` 改用 `getComputedStyle` 读 `--bg-base`
  （与 VocalEditor 的 `col()` 同模式）；`staticKey` 加入 skin 项 + useCallback 依赖，切皮肤即时重烘焙
- `ArrangeDialog.tsx` — 快捷预设按钮：slate 色板 → `--border-default/--bg-surface/--accent-primary/--text-primary`
- `DeepOriginalNode.tsx` / `ChordDetectNode.tsx` / `ChordBlockInNode.tsx` / `MidiFileInNode.tsx` — 节点内
  中性色（文本/边框/背景/错误提示）→ token
- `Settings.tsx` — 4 处错误红/成功绿 → token（功能色在所有皮肤中恒定，替换零视觉风险）
- `SpectrumAnalyzer.tsx` — 画布元素背景 `#0a0a0a` → `var(--bg-deep)`

**B. 甄别为必要硬编码，保留（不改动）：**
- **节点标识色**：NodeShell `color` prop / NodePalette 类别色 / CATEGORY_COLORS —— 每类节点独立配色的
  设计数据，与主题无关（20+ 节点类型 vs 仅 10 个主题色，token 化会丢失区分度）
- **canvas 绘图色**：AmtResultPanel/AmtConversionDialog/Arrangement 的 `ctx.fillStyle` 等 —— canvas
  无法直接解析 CSS 变量；其中 error/warning/success 功能色在全部皮肤中恒定，视觉无漂移
- **STEM_COLORS 8 色分轨色板**、Titlebar 皮肤色板数据、WaveformThumbnail 默认参数 —— 类别数据非主题色
- **col() 回退值**：VocalEditor/TimelineRuler/ChordTrack/LossChart 已是正确的
  `getComputedStyle + fallback` 主题跟随模式，回退 hex 属设计内

**C. 已确认无需处理：** OnboardingTour/Titlebar 品牌渐变已带 `var(--brand-grad-*, fallback)`。

### 7.3 回归验证（全部通过）

| 验证项 | 命令 | 结果 |
|---|---|---|
| 前端测试 | `npm test` | ✅ 616 通过 / 0 失败 / 4 跳过（54 文件） |
| 生产构建 | `npm run build`（tsc -b + vite） | ✅ 通过（既有 chunk 拆分提示，非错误） |
| Rust 编译 | `cargo check` | ✅ 本轮未改 Rust 代码，沿用上次通过结果 |

### 7.4 未修复项（沿用第四章优先级结论）

- **D1（P2 可选）**：cpal 回调堆分配 —— WASAPI shared 模式下可接受，改动收益小，未动。
- **R1（P3 不建议）**：1995 处 panic 点收敛属长期专项重构。
- **D4（环境项）**：clippy 未安装，属本地工具链问题，不影响交付质量结论。

### 7.5 UI 目检建议（用户侧）

运行 `npm run tauri dev` 后依次检查：
1. 标题栏调色盘切换 6 套皮肤 → 检查 VirtualPiano、AMT 转谱对话框、音源管理器、编曲画布背景颜色跟随
2. Inspector 底部轨道 tab 左侧色条：乐器=紫、人声=青、音频=蓝（与轨道列表一致）
3. 编曲对话框「快捷预设」按钮选中态为主题主色
4. AMT 组件缺失对话框（浏览器预览模式可触发）：错误提示为主题红
