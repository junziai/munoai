/**
 * §user「超级原创」内置模板——把工程的既有节点（分离 / AMT 扒带 / RVC / 移调 / 输出）
 * 组装成三条一键流水线。模板是纯数据：生成 Workflow 对象后走与手动编辑器完全相同的
 * 执行引擎（preflightRun → executeWorkflow），因此缺失组件检测、进度、取消、轨道沉积、
 * 缓存全部免费复用。
 *
 *   transcribe  一键扒带：input → AMT(smart 多乐器) 。MIDI 自动落主时间线（换音源/修复的起点）。
 *   clone       声音复刻：input → 分离(人声) → [人声→RVC]→输出 + [伴奏]→输出。
 *   original    深度原创：clone + [伴奏→移调]→输出 + 平行 AMT 扒带（换音源起点）。
 *
 * 端口连线由向导按分离模型的真实 stem 顺序解析（resolveVocalPorts）；modelPath 不写入
 * params —— 引擎执行时用 modelFile 自愈（modelPathHeal.healMsstModelPath），天然可移植。
 */

import type { Workflow, WorkflowNode, WorkflowConnection } from "../../types/project";
import { MUSCRIPTOR_INSTRUMENTS } from "../models/muscriptor-instruments";

export type WizardTemplateId = "transcribe" | "clone" | "original";

export interface WizardTemplateContext {
  /**
   * 已安装的人声分离模型（向导从 MSST_CATALOG × installed 解析出的最佳模型）。
   * stemNames 为该模型 json 的真实输出顺序（stem_names [+ residual]，首字母大写），
   * 引擎按索引沉积 stem，连线端口必须跟随此顺序。缺省按 ["Vocals","Instrumental"]。
   */
  vocalStemNames?: string[];
  /** 分离节点的 modelFile（已安装模型文件名；引擎据此自愈 onnx 路径）。 */
  separationModelFile?: string;
  /** RVC 声音模型（clone/original 模板必填；缺省时节点面板挂载后自动选第一个）。 */
  voiceModel?: { name: string; path: string };
  /** original 模板：伴奏移调半音数（±1~3，0 无意义）。默认 2。 */
  transposeSemitones?: number;
  /** AMT 后端：muscriptor（默认，多乐器精细）或 yourmt3 / miros。 */
  amtBackend?: string;
}

/** 分离模型真序 → 人声/伴奏端口索引（大小写不敏感；兜底 0/1）。 */
export function resolveVocalPorts(stemNames?: string[]): { vocalPort: number; instPort: number } {
  const names = (stemNames ?? []).map((s) => s.toLowerCase());
  if (names.length === 0) return { vocalPort: 0, instPort: 1 };
  let vocalPort = names.findIndex((s) => s.includes("vocal") || s.includes("voice"));
  if (vocalPort < 0) vocalPort = 0;
  let instPort = names.findIndex(
    (s, i) => i !== vocalPort && (s.includes("instrument") || s.includes("accompan") || s.includes("other") || s.includes("no_vocal") || s.includes("karaoke")),
  );
  if (instPort < 0) instPort = names.length > 1 ? (vocalPort === 0 ? 1 : 0) : vocalPort;
  return { vocalPort, instPort };
}

/** 人声分离模型 stem 端口数（供输出连线校验；兜底 2）。 */
export function stemCount(stemNames?: string[]): number {
  return Math.max(2, stemNames?.length ?? 2);
}

const node = (id: string, nodeType: WorkflowNode["nodeType"], x: number, y: number, params: Record<string, unknown>): WorkflowNode =>
  ({ id, nodeType, position: { x, y }, params });

const conn = (fromNode: string, fromPort: number, toNode: string, toPort: number): WorkflowConnection =>
  ({ fromNode, fromPort, toNode, toPort });

/** 分离节点 params：modelFile（引擎自愈路径的唯一稳定标识）+ 真序 stemLabels。 */
function sepParams(ctx: WizardTemplateContext): Record<string, unknown> {
  const p: Record<string, unknown> = { category: "vocals", device: "cuda" };
  if (ctx.separationModelFile) p.modelFile = ctx.separationModelFile;
  if (ctx.vocalStemNames?.length) p.stemLabels = ctx.vocalStemNames;
  return p;
}

/** AMT 节点 params（smart 多乐器模式；backend 默认 muscriptor = 最优转谱）。
 *  MuScriptor 默认全选全部 36 种乐器 —— 用户要精简可以在节点面板取消勾选，
 *  但「默认空数组导致只有 4 轨」是最常见的踩坑。 */
function amtParams(ctx: WizardTemplateContext): Record<string, unknown> {
  return {
    midiMode: "smart",
    backend: ctx.amtBackend ?? "muscriptor",
    useGpu: true,
    midiTrackMode: "multi_track",
    quantizeGrid: "off",
    muscriptorInstruments: [...MUSCRIPTOR_INSTRUMENTS],
    muscriptorChain: "official",
  };
}

/** 一键扒带：AMT 多乐器转 MIDI（自动落轨）；MIDI 路径接到输出节点以便预览/导出。 */
export function buildTranscribeWorkflow(ctx: WizardTemplateContext): Workflow {
  return {
    nodes: [
      node("input", "input", 0, 0, {}),
      node("amt", "amtMidi", 300, 0, amtParams(ctx)),
      node("out", "output", 620, 0, { laneLabel: "一键扒带" }),
    ],
    connections: [
      conn("input", 0, "amt", 0),
      conn("amt", 0, "out", 0),
    ],
  };
}

/** 声音复刻：分离 → 人声 RVC + 伴奏直出。 */
export function buildCloneWorkflow(ctx: WizardTemplateContext): Workflow {
  const { vocalPort, instPort } = resolveVocalPorts(ctx.vocalStemNames);
  const vm = ctx.voiceModel;
  return {
    nodes: [
      node("input", "input", 0, 0, {}),
      node("sep", "msstSeparation", 300, 0, sepParams(ctx)),
      node("rvc", "rvc", 620, -60, vm ? { voiceName: vm.name, modelPath: vm.path } : {}),
      node("out", "output", 940, 0, { laneLabel: "超级原创" }),
    ],
    connections: [
      conn("input", 0, "sep", 0),
      conn("sep", vocalPort, "rvc", 0),
      conn("rvc", 0, "out", 0),
      conn("sep", instPort, "out", 1),
    ],
  };
}

/** 深度原创：复刻 + 伴奏移调 + 平行 AMT 扒带（换音源起点）。 */
export function buildOriginalWorkflow(ctx: WizardTemplateContext): Workflow {
  const { vocalPort, instPort } = resolveVocalPorts(ctx.vocalStemNames);
  const vm = ctx.voiceModel;
  const semis = ctx.transposeSemitones ?? 2;
  return {
    nodes: [
      node("input", "input", 0, 0, {}),
      node("sep", "msstSeparation", 280, 0, sepParams(ctx)),
      node("rvc", "rvc", 580, -90, vm ? { voiceName: vm.name, modelPath: vm.path } : {}),
      node("transpose", "transpose", 580, 110, { semitones: semis, formantFollow: 0, formantOffset: 0 }),
      node("amt", "amtMidi", 280, 240, amtParams(ctx)),
      node("out", "output", 900, 0, { laneLabel: "超级原创" }),
    ],
    connections: [
      conn("input", 0, "sep", 0),
      conn("input", 0, "amt", 0),
      conn("sep", vocalPort, "rvc", 0),
      conn("rvc", 0, "out", 0),
      conn("sep", instPort, "transpose", 0),
      conn("transpose", 0, "out", 1),
    ],
  };
}

export function buildWorkflow(template: WizardTemplateId, ctx: WizardTemplateContext): Workflow {
  switch (template) {
    case "transcribe": return buildTranscribeWorkflow(ctx);
    case "clone": return buildCloneWorkflow(ctx);
    case "original": return buildOriginalWorkflow(ctx);
  }
}

/** 模板是否需要声音模型（前端组件检查用）。 */
export const templateNeedsVoiceModel = (t: WizardTemplateId): boolean =>
  t === "clone" || t === "original";

/** 模板是否需要人声分离模型。 */
export const templateNeedsSeparation = (t: WizardTemplateId): boolean =>
  t === "clone" || t === "original";

/** stem 端口数（校验连线不越界）。 */
export function templateStemCount(template: WizardTemplateId, ctx: WizardTemplateContext): number {
  return templateNeedsSeparation(template) ? stemCount(ctx.vocalStemNames) : 0;
}
