import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
// ── 纯前端音频管线辅助函数 (Web Audio 侧) ──
import type { Workflow } from "../../types/project";
import { parseWorkflowGraph } from "./graph";
import { useProjectStore } from "../../store/project";
import { useWorkflowStore } from "../../store/workflow";
import { useAmtStore } from "../../store/amt";
import { useAppStore, type MissingModelItem } from "../../store/app";
import { useHistoryStore } from "../../store/history";
import { useMsstModelStore } from "../../store/msst-models";
import { useAudioStore } from "../../store/audio";
import { logToBackend } from "../log";
import { backendErrorMessage, isCancelError } from "../backendError";
import { maybeShowErrorModal } from "../errorDisplay";
import { DEFAULT_OUTPUT_GROUP } from "../constants";
import { MSST_CATALOG, MSST_DEFAULT_PRECISION, type MsstArchitecture } from "../models/msst-catalog";
import { RVC_DEFAULTS, SOVITS_DEFAULTS, buildVoiceOptions } from "./voiceDefaults";
import { healVoiceModelPath, healMsstModelPath } from "./modelPathHeal";
import { matchInstrumentWav } from "../amtSource";
import { analyzeChords, type ChordAnalysisNote } from "../analysis/chordAnalysis";
import { arrange } from "../arrangement/arranger";
import { generateChordMidi } from "../arrangement/chordMidi";
import { TICKS_PER_BEAT } from "../constants";
import type { ArrangeMood, ArrangeStyle } from "../arrangement/styles";

export async function audioBufferToWav(buf: AudioBuffer): Promise<ArrayBuffer> {
  const numCh = buf.numberOfChannels;
  const sr = buf.sampleRate;
  const samples = buf.length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const byteRate = sr * blockAlign;
  const dataSize = samples * blockAlign;
  const bufSize = 44 + dataSize;
  const out = new ArrayBuffer(bufSize);
  const view = new DataView(out);
  let off = 0;
  const writeStr = (s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off++, s.charCodeAt(i)); };
  writeStr("RIFF"); view.setUint32(off, 36 + dataSize, true); off += 4;
  writeStr("WAVE"); writeStr("fmt ");
  view.setUint32(off, 16, true); off += 4;
  view.setUint16(off, 1, true); off += 2;          // PCM
  view.setUint16(off, numCh, true); off += 2;
  view.setUint32(off, sr, true); off += 4;
  view.setUint32(off, byteRate, true); off += 4;
  view.setUint16(off, blockAlign, true); off += 2;
  view.setUint16(off, bytesPerSample * 8, true); off += 2;
  writeStr("data"); view.setUint32(off, dataSize, true); off += 4;
  const chans: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) chans.push(buf.getChannelData(c));
  for (let s = 0; s < samples; s++) {
    for (let c = 0; c < numCh; c++) {
      const v = Math.max(-1, Math.min(1, (chans[c] ?? new Float32Array(buf.length))[s] ?? 0));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return out;
}
export function arrayBufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin);
}
// Tauri writeFile (dynamic import, avoid static import breaking browser preview)
export async function writeFile(path: string, data: ArrayBuffer): Promise<void> {
  const fs = await import("@tauri-apps/plugin-fs");
  await fs.writeFile(path, new Uint8Array(data));
}
import type { Segment, ProcessedOutput, Track } from "../../types/project";

import i18n from "../../i18n";

interface AudioFileInfo {
  duration_ms: number;
  peaks: number[];
}

let runSeq = 0;

/** Live voice invokes per segment. A cancelled run_rvc/run_sovits invoke keeps DRAINING
 *  until the Rust pipeline hits its next cancel poll (the cancel flag LATCHES — one click
 *  always takes effect at the next poll — but that poll can sit behind a multi-second
 *  ONNX Run) — starting a new run for the same segment during that window produced two
 *  live runs emitting `voice-progress` for the SAME node (the "possessed" jumping bar) and
 *  a late「已取消」rejection that looked like the NEW run failing. Both run entry points
 *  AWAIT the drain and then start automatically (no manual retry); a second click while
 *  one is already queued is dropped. Keyed per segment so other segments are unaffected. */
const voiceInvokesInFlight = new Map<string, number>();
const voiceDrainWaiters = new Set<string>();

/** Wait for the segment's draining voice invoke(s) to settle, then proceed. Returns false
 *  when this attempt should be dropped (a run is already queued, or the drain timed out). */
async function waitVoiceDrain(segmentId: string): Promise<boolean> {
  if ((voiceInvokesInFlight.get(segmentId) ?? 0) === 0) return true;
  const toast = useAppStore.getState().showToast;
  if (voiceDrainWaiters.has(segmentId)) {
    toast(i18n.t("workflow.drainQueued"), "info");
    return false;
  }
  voiceDrainWaiters.add(segmentId);
  toast(i18n.t("workflow.drainWaiting"), "info");
  try {
    // Generous cap: a CPU-mode extractor pass over a 30 s piece is the longest single
    // uninterruptible step. A hang past this is a real bug, not a slow drain.
    const deadline = Date.now() + 120_000;
    while ((voiceInvokesInFlight.get(segmentId) ?? 0) > 0) {
      if (Date.now() > deadline) {
        toast(i18n.t("workflow.drainTimeout"), "error");
        return false;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return true;
  } finally {
    voiceDrainWaiters.delete(segmentId);
  }
}

/** Cancel sentinel — delegated to THE single check in backendError.ts (shared with every toast
 *  funnel). Runs BEFORE any error-code localization, or a user cancel would surface as a red error. */
function isCancelMessage(msg: string): boolean {
  return isCancelError(msg);
}

/** PRE-FLIGHT separation-busy gate. The Rust SeparationManager is a GLOBAL single slot — dispatching a
 *  run whose separation node would hit its "already in progress" guard used to START the run anyway and
 *  fail it seconds later with a red error, flipping this segment's button back to Run while the OTHER
 *  (earlier) backend job kept going — the UI read as "backend stopped" when it hadn't. So: if the run
 *  would actually EXECUTE a separation node (for a single-node run, dense-cached upstreams are reused
 *  and never invoke the backend) and a live separation is in flight, REJECT before startExecution with
 *  a toast — no execution state is ever created, nothing to un-wind. The Rust guard stays as the
 *  authoritative backstop for the query→dispatch race (its SEPARATION_BUSY code maps to the same text
 *  in executeNode). */
async function rejectIfSeparationBusy(
  segmentId: string,
  workflow: Workflow,
  targetNodeId: string | null,
): Promise<boolean> {
  let needsSeparation = false;
  try {
    const graph = parseWorkflowGraph(workflow);
    const cache = useWorkflowStore.getState().nodeOutputs[segmentId] ?? {};
    // Single-node runs only ever execute the target's ANCESTOR chain (see ancestorSetOf).
    const scope = targetNodeId !== null ? ancestorSetOf(graph, targetNodeId) : null;
    for (const nodeId of graph.sorted) {
      if (scope && !scope.has(nodeId)) continue;
      const gn = graph.nodes.get(nodeId)!;
      if (gn.node.nodeType === "msstSeparation") {
        // Mirrors executeSingleNode's reuse rule: a dense-cached non-target node is skipped, never run.
        const cached = cache[nodeId];
        const reused = targetNodeId !== null && nodeId !== targetNodeId
          && !!cached && cached.length > 0 && isDenseCache(cached);
        if (!reused) { needsSeparation = true; break; }
      }
      if (targetNodeId !== null && nodeId === targetNodeId) break;
    }
  } catch {
    return false; // broken graph — let the normal run path surface its own error
  }
  if (!needsSeparation) return false;
  const status = await invoke<{ state: string | Record<string, string> }>("get_separation_status")
    .catch(() => null);
  const busy = status !== null && typeof status.state === "string"
    && (status.state === "Separating" || status.state === "LoadingModel");
  if (busy) useAppStore.getState().showToast(i18n.t("workflow.separationBusy"), "error");
  return busy;
}

/** S66 — pre-run model availability scan (the "don't make users guess" rule): every model a run
 *  参与节点 references is checked BEFORE dispatch, and problems surface as ONE dialog with per-item
 *  one-click actions instead of a mid-run MSST_MODEL_NOT_CONVERTED / AUX_FILE_MISSING error toast.
 *  Scope follows the run's real execution domain (Run All = whole graph, single node = its
 *  ancestor set — the S62b rule). Best-effort: an IPC failure never blocks the run (the Rust
 *  pipeline still errors loudly). */
export async function collectMissingModels(
  workflow: Workflow,
  targetNodeId: string | null,
): Promise<MissingModelItem[]> {
  let scope: Set<string> | null = null;
  if (targetNodeId !== null) {
    try {
      scope = ancestorSetOf(parseWorkflowGraph(workflow), targetNodeId);
    } catch {
      scope = null; // unparseable graph → scan everything; the run itself will report the parse error
    }
  }
  const nodes = workflow.nodes.filter((n) => scope === null || scope.has(n.id));
  const items: MissingModelItem[] = [];
  const seen = new Set<string>();

  const msstNodes = nodes.filter((n) => n.nodeType === "msstSeparation");
  if (msstNodes.length > 0) {
    let installed: Array<{ filename: string; architecture: string; has_onnx: boolean; has_fp16: boolean }> = [];
    try {
      // straight from Rust — the store copy may never have been fetched this session
      installed = await invoke("list_msst_models");
    } catch {
      return items; // can't scan → don't block
    }
    for (const n of msstNodes) {
      const modelFile = (n.params.modelFile as string) ?? "";
      if (!modelFile || seen.has(modelFile)) continue;
      seen.add(modelFile);
      const entry = installed.find((m) => m.filename === modelFile);
      if (!entry) {
        items.push({ kind: "msstMissing", label: modelFile });
        continue;
      }
      if (!entry.has_onnx && !entry.has_fp16) {
        // mirror the executeNode effective-precision derivation (catalog arch wins over detection;
        // Rust's "unknown" detection verdict is not a usable hint)
        const detected =
          entry.architecture !== "unknown" ? (entry.architecture as MsstArchitecture) : undefined;
        const arch = MSST_CATALOG.find((e) => e.filename === modelFile)?.architecture ?? detected;
        const precision =
          (n.params.precision as "fp32" | "fp16" | undefined) ??
          (arch !== undefined ? MSST_DEFAULT_PRECISION[arch] : undefined);
        items.push({
          kind: "msstConvert",
          label: modelFile,
          filename: modelFile,
          precision,
          architecture: arch,
        });
      }
    }
  }

  if (nodes.some((n) => n.nodeType === "rvc" || n.nodeType === "sovits")) {
    try {
      const packs = await invoke<Array<{ id: string; missing: number; downloading: boolean }>>(
        "asset_pack_status",
      );
      const aux = packs.find((p) => p.id === "aux-inference");
      if ((aux?.missing ?? 0) > 0 && !(aux?.downloading ?? false)) {
        items.push({ kind: "auxPack", label: "aux-inference" });
      }
    } catch {
      /* best-effort */
    }
  }
  return items;
}

/** Gate a run BEFORE the caller mutates anything (deposit invalidation, store state). The two run entry
 *  points (WorkflowEditor handleExecute / handleRunSingleNode) MUST await this FIRST — previously the
 *  busy/drain checks lived inside executeWorkflow, i.e. AFTER handleExecute had already stripped the
 *  segment's deposited lanes, so a rejected run cost the track its lanes for nothing (and the drain-drop
 *  path returned 0, stacking a misleading "no outputs" error toast on top). Returns false (after
 *  toasting) when the run must not start; nothing has been touched. */
export async function preflightRun(
  segmentId: string,
  workflow: Workflow,
  targetNodeId: string | null,
): Promise<boolean> {
  const running = () => useWorkflowStore.getState().executions[segmentId]?.status === "running";
  // Same-segment double-run guard: the per-node Run button stays reachable during a live run (the main
  // Run button flips to Stop, but node buttons don't) — dispatching would clobber the live execution
  // entry and orphan its UI state.
  if (running()) {
    useAppStore.getState().showToast(i18n.t("workflow.runBusy"), "info");
    return false;
  }
  // S66: unconverted/missing models → the one-click dialog instead of a mid-run error. Read-only
  // scan, so it rides before the drain; the running() rechecks below still cover its awaits.
  const missing = await collectMissingModels(workflow, targetNodeId);
  if (missing.length > 0) {
    useAppStore.getState().openMissingModels(missing);
    return false;
  }
  if (running()) { // a run may have started while the scan's IPC was in flight
    useAppStore.getState().showToast(i18n.t("workflow.runBusy"), "info");
    return false;
  }
  if (!(await waitVoiceDrain(segmentId))) return false;
  if (running()) { // a run may have started while we drained
    useAppStore.getState().showToast(i18n.t("workflow.runBusy"), "info");
    return false;
  }
  if (await rejectIfSeparationBusy(segmentId, workflow, targetNodeId)) return false;
  if (running()) { // …or while we queried the separation status (the path to startExecution is sync from here)
    useAppStore.getState().showToast(i18n.t("workflow.runBusy"), "info");
    return false;
  }
  return true;
}

/** Per-RUN output directory under the segment's cache dir. Node output paths were previously
 *  deterministic (`${cacheDir}/${nodeId}_rvc.wav`, MSST stems by label), which ALIASED across a split:
 *  both halves' deposited lanes reference the ORIGINAL segment's files, so re-running one half silently
 *  overwrote the other half's audio (and waveform) in place — and a re-run at the SAME path could never
 *  be told apart from the old run, so the reconciler's KEEP branch retained stale deposits after a
 *  dependency re-run. A fresh dir per run makes every output path unique: existing deposits keep playing
 *  their own files untouched, and a path CHANGE is itself the re-render signal (placeholder → fresh
 *  decode). Old run dirs are pruned by the startup cache sweep (age/byte budget). */
async function ensureRunDir(segmentId: string): Promise<string> {
  const raw = await invoke<string>("ensure_cache_dir", {
    segmentId: `${segmentId}/r${Date.now().toString(36)}${(runSeq++).toString(36)}`,
  });
  return raw.replace(/\\/g, "/");
}

/** Returns the number of lanes that reached Output nodes (0 = nothing landed — the caller
 *  toasts). The actual track deposit is done by the live reconciler / RenderLinkWatcher. */
export async function executeWorkflow(
  segmentId: string,
  segment: Segment,
  workflow: Workflow,
): Promise<number> {
  const store = useWorkflowStore.getState();
  // Dispatch-time participant snapshot (every non-IO node — a full run executes them all): written in
  // the SAME store update that flips the run to "running", so the reconciler's very first pass already
  // knows which feeders belong to this run (its pending placeholders key on membership). A parse failure
  // lands [] here and throws properly inside the try below.
  let participants: string[] = [];
  try {
    const g = parseWorkflowGraph(workflow);
    participants = g.sorted.filter((id) => {
      const t = g.nodes.get(id)!.node.nodeType;
      return t !== "input" && t !== "output";
    });
  } catch { /* reported by the parse inside the try below */ }
  store.startExecution(segmentId, participants);
  store.clearNodeStatuses(segmentId);
  // A full run recomputes every node. Drop any warm/rehydrated cache first so the live reconciler shows
  // loading placeholders and deposits each lane FRESH as its node finishes — never an early decode of a
  // deterministic path this run is about to overwrite in place (the crash-recovery "keeps old stem" hazard).
  store.clearNodeOutputs(segmentId);

  try {
    logToBackend("info", `Workflow started (${workflow.nodes.length} nodes)`);
    const graph = parseWorkflowGraph(workflow);

    // Mark all non-IO nodes as waiting BEFORE the first await: the reconciler's pending placeholders
    // key on per-feeder participation (waiting/running), so the marks must land in the same tick the
    // run starts — marking them after fetchInstalled/ensureRunDir left an await-sized window in which
    // connected lanes showed no placeholder at all.
    for (const nodeId of graph.sorted) {
      const gn = graph.nodes.get(nodeId)!;
      if (gn.node.nodeType !== "input" && gn.node.nodeType !== "output") {
        store.setNodeStatus(segmentId, nodeId, "waiting");
      }
    }

    await useMsstModelStore.getState().fetchInstalled();
    const cacheDir = await ensureRunDir(segmentId);

    const dataMap = new Map<string, Map<number, string>>();

    if (segment.content.type !== "audioClip") {
      throw new Error("Workflow execution requires an audioClip segment");
    }
    const inputData = new Map<number, string>();
    // Separate the SAME audio the original segment PLAYS — the content-addressed cache WAV, whose codec
    // pre-skip silence was TRIMMED by load_audio_file. Feeding the raw source instead produced an
    // UN-trimmed stem that played + drew shifted by ~the trim length (a full beat) vs the main track.
    // Fall back to the raw path if the clip wasn't decoded through the cache yet.
    const playbackWav = useAudioStore.getState().audioFiles[segment.content.sourcePath]?.playbackPath;
    inputData.set(0, playbackWav || segment.content.sourcePath);
    dataMap.set(graph.inputNodeId, inputData);

    const totalNodes = graph.sorted.length;

    for (let step = 0; step < totalNodes; step++) {
      const nodeId = graph.sorted[step]!;
      const gn = graph.nodes.get(nodeId)!;
      const nodeType = gn.node.nodeType;
      const params = gn.node.params as Record<string, unknown>;

      store.updateProgress(segmentId, nodeId, step / totalNodes);

      if (nodeType === "input" || nodeType === "output") continue;

      if (useWorkflowStore.getState().isCancelled(segmentId)) {
        throw new Error("Cancelled");
      }

      store.setNodeStatus(segmentId, nodeId, "running");

      const outputData = await executeNode(nodeId, nodeType, params, gn, dataMap, cacheDir, segmentId);

      dataMap.set(nodeId, outputData);
      if (outputData.size > 0) {
        useWorkflowStore.getState().setNodeOutputs(segmentId, nodeId, Array.from(outputData.values()));
      }
      store.setNodeStatus(segmentId, nodeId, "completed");
    }

    const laneCount = countOutputLanes(graph, dataMap);

    store.completeExecution(segmentId);
    if (graph.outputNodeIds.length > 0 && laneCount === 0) {
      // Output nodes exist but nothing reached the track — warn loudly instead of a clean "completed".
      logToBackend("warn", "Workflow completed but produced 0 outputs — output node has no connected/rendered upstream");
    } else {
      logToBackend("info", `Workflow completed (${laneCount} outputs)`);
    }
    return laneCount;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cancelled = isCancelMessage(msg);
    logToBackend(cancelled ? "warn" : "error", cancelled ? "Workflow cancelled" : `Workflow failed: ${msg}`);
    // THE single localization point for node/run error DISPLAY (cancel checked first — a localized
    // cancel would dodge the swallow checks downstream): known Rust CODEs (APP_BUSY, SEPARATION_BUSY,
    // TRANSPOSE_*, MSST_MODEL_NOT_CONVERTED, …) become t(...) text; unknown messages pass through raw.
    // A cancel settles as the bare frontend sentinel (not the raw "Inference error: CANCELLED" wire text).
    const display = cancelled ? "Cancelled" : (backendErrorMessage(msg) ?? msg);
    const store = useWorkflowStore.getState();
    // A real failure marks the offending node red; a user cancel marks nothing. Either way clear the
    // running/waiting badges so nodes don't stay stuck blue/yellow after the run settles.
    if (!cancelled && store.executions[segmentId]?.currentNodeId) {
      store.setNodeStatus(segmentId, store.executions[segmentId]!.currentNodeId!, "error");
      store.setNodeError(segmentId, store.executions[segmentId]!.currentNodeId!, display);
    }
    // S67c: fatal modal-class errors (INFERENCE_LOW_MEMORY …) additionally open the alert
    // dialog — the node tooltip is invisible until hovered and can't carry the guidance text.
    if (!cancelled) maybeShowErrorModal(msg, display);
    store.clearPendingStatuses(segmentId);
    store.failExecution(segmentId, display);
    throw err;
  }
}

/** True iff every index of `arr` holds a value (no holes / no null). A live run always writes a DENSE
 *  output array (Array.from(map.values())); rehydrateRenderState may write a SPARSE one (only the deposited
 *  ports), which must NOT be reused as a complete node output. `.every` can't detect holes (it skips them),
 *  so scan by index. */
function isDenseCache(arr: string[]): boolean {
  for (let i = 0; i < arr.length; i++) if (arr[i] == null) return false;
  return true;
}

/** The target node + its transitive UPSTREAM — the only nodes a single-node run may touch. A plain
 *  walk of graph.sorted "up to the target" also visits UNRELATED parallel branches that happen to sort
 *  earlier (topological order ≠ ancestry), so clicking "run this node" used to silently re-render
 *  never-rendered nodes elsewhere on the canvas (old bug, user-caught S62b). */
function ancestorSetOf(
  graph: ReturnType<typeof parseWorkflowGraph>,
  targetNodeId: string,
): Set<string> {
  const anc = new Set<string>([targetNodeId]);
  const stack = [targetNodeId];
  while (stack.length > 0) {
    const gn = graph.nodes.get(stack.pop()!);
    for (const e of gn?.inEdges ?? []) {
      if (!anc.has(e.fromNode)) {
        anc.add(e.fromNode);
        stack.push(e.fromNode);
      }
    }
  }
  return anc;
}

export async function executeSingleNode(
  segmentId: string,
  segment: Segment,
  workflow: Workflow,
  targetNodeId: string,
): Promise<void> {
  const store = useWorkflowStore.getState();
  // NOTE: we deliberately DON'T clear the target's cache here. The stale-in-place-overwrite hazard is
  // handled AFTER a successful run by handleRunSingleNode (clearBufferCache + removeProcessedOutputsForNode
  // for lanes this node feeds → the reconciler re-decodes fresh); and during the run the old deposit stays
  // present so the reconciler KEEPs it (no early decode of a to-be-overwritten file). Clearing up front
  // instead LOST the last-good cache pointer if the re-run FAILED, breaking reconnect-from-cache.
  // Participant snapshot = the target + its ANCESTOR chain, non-IO (cache-reused upstreams included —
  // harmless: their lanes resolve from the cache branch before the pending branch is consulted).
  // NOT "everything up to the target in topo order": that includes unrelated parallel branches.
  const participants: string[] = [];
  try {
    const g = parseWorkflowGraph(workflow);
    const scope = ancestorSetOf(g, targetNodeId);
    for (const id of g.sorted) {
      if (!scope.has(id)) continue;
      const t = g.nodes.get(id)!.node.nodeType;
      if (t !== "input" && t !== "output") participants.push(id);
      if (id === targetNodeId) break;
    }
  } catch { /* reported by the parse inside the try below */ }
  store.startExecution(segmentId, participants);

  try {
    const graph = parseWorkflowGraph(workflow);
    // Run-unique dir here too: a single-node re-run only writes the nodes it actually EXECUTES (cached
    // upstreams keep their old-run paths in dataMap), so re-executed outputs land at fresh paths and the
    // reconciler re-deposits every lane they feed — including lanes of OTHER Output nodes fed by an
    // upstream that re-ran as an uncached dependency (previously stale: same path, KEEP branch held it).
    const cacheDir = await ensureRunDir(segmentId);

    if (segment.content.type !== "audioClip") {
      throw new Error("Workflow execution requires an audioClip segment");
    }

    const dataMap = new Map<string, Map<number, string>>();
    const inputData = new Map<number, string>();
    // Separate the SAME audio the original segment PLAYS — the content-addressed cache WAV, whose codec
    // pre-skip silence was TRIMMED by load_audio_file. Feeding the raw source instead produced an
    // UN-trimmed stem that played + drew shifted by ~the trim length (a full beat) vs the main track.
    // Fall back to the raw path if the clip wasn't decoded through the cache yet.
    const playbackWav = useAudioStore.getState().audioFiles[segment.content.sourcePath]?.playbackPath;
    inputData.set(0, playbackWav || segment.content.sourcePath);
    dataMap.set(graph.inputNodeId, inputData);

    // Only the target's ANCESTOR chain may run. graph.sorted is a WHOLE-graph topological order, so
    // "walk until the target" also visits unrelated parallel branches that happen to sort earlier —
    // clicking "run this node" used to silently render never-rendered nodes elsewhere on the canvas.
    const scope = ancestorSetOf(graph, targetNodeId);

    for (const nodeId of graph.sorted) {
      if (!scope.has(nodeId)) continue;
      const gn = graph.nodes.get(nodeId)!;
      if (gn.node.nodeType === "input" || gn.node.nodeType === "output") continue;

      if (useWorkflowStore.getState().isCancelled(segmentId)) {
        throw new Error("Cancelled");
      }

      // Reuse a node's cached output ONLY if it's DENSE (every port present). rehydrateRenderState may warm
      // a multi-output node with just the DEPOSITED ports (a sparse array with holes); reusing that would
      // feed `undefined` to a downstream node reading a non-deposited port ("has no input connected"). A
      // hole means that port isn't cached → fall through and RE-RUN the node to regenerate all ports.
      const cached = store.nodeOutputs[segmentId]?.[nodeId];
      if (cached && cached.length > 0 && nodeId !== targetNodeId && isDenseCache(cached)) {
        const m = new Map<number, string>();
        cached.forEach((p, i) => m.set(i, p));
        dataMap.set(nodeId, m);
        continue;
      }

      store.setNodeStatus(segmentId, nodeId, "running");

      const outputData = await executeNode(
        nodeId, gn.node.nodeType, gn.node.params as Record<string, unknown>,
        gn, dataMap, cacheDir, segmentId,
      );

      dataMap.set(nodeId, outputData);
      if (outputData.size > 0) {
        store.setNodeOutputs(segmentId, nodeId, Array.from(outputData.values()));
      }
      store.setNodeStatus(segmentId, nodeId, "completed");

      if (nodeId === targetNodeId) break;
    }

    store.completeExecution(segmentId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cancelled = isCancelMessage(msg);
    // S67c: single-node failures now reach the backend log too (they used to be
    // tooltip-only — invisible in crash forensics), mirroring executeWorkflow's catch.
    logToBackend(cancelled ? "warn" : "error", cancelled ? "Single-node run cancelled" : `Single-node run failed: ${msg}`);
    // Same single localization point as executeWorkflow's catch (cancel checked first).
    const display = cancelled ? "Cancelled" : (backendErrorMessage(msg) ?? msg);
    if (!cancelled) {
      store.setNodeStatus(segmentId, targetNodeId, "error");
      store.setNodeError(segmentId, targetNodeId, display);
      maybeShowErrorModal(msg, display);
    }
    store.clearPendingStatuses(segmentId);
    store.failExecution(segmentId, display);
  }
}

async function executeNode(
  nodeId: string,
  nodeType: string,
  params: Record<string, unknown>,
  gn: { inEdges: Array<{ fromNode: string; fromPort: number; toPort: number }> },
  dataMap: Map<string, Map<number, string>>,
  cacheDir: string,
  segmentId: string,
): Promise<Map<number, string>> {
  const inputPaths: Map<number, string> = new Map();
  for (const edge of gn.inEdges) {
    const upstream = dataMap.get(edge.fromNode);
    if (upstream) {
      const path = upstream.get(edge.fromPort);
      if (path) inputPaths.set(edge.toPort, path);
    }
  }

    // Source nodes (no inputs) are self-contained — skip the primary-input guard.
  const SOURCE_NODE_TYPES = new Set(["midiFileIn", "chordBlockIn"]);
  const isSourceNode = SOURCE_NODE_TYPES.has(nodeType);

  const primaryInput = inputPaths.get(0);
  if (!primaryInput && !isSourceNode) {
    throw new Error(`Node "${nodeId}" (${nodeType}) has no input connected`);
  }

  const outputData = new Map<number, string>();

  switch (nodeType) {
    case "rvc":
    case "sovits": {
      const isRvc = nodeType === "rvc";
      const voiceName = params.voiceName as string | undefined;
      // S64 portability: persisted modelPath is absolute and can be stale after an install/data-dir
      // move; re-resolve by voiceName at use time (the panel pickers only heal on MOUNT).
      const modelPath = await healVoiceModelPath(nodeType, voiceName, params.modelPath as string | undefined);
      if (!voiceName || !modelPath) {
        throw new Error(`${isRvc ? "RVC" : "SoVITS"} node has no voice model selected — import one in the resource manager`);
      }
      const outputPath = `${cacheDir}/${nodeId}_${nodeType}.wav`;
      // Drive the node's (generic) progress bar off the Rust `voice-progress` events, filtered
      // by nodeId. The listener is torn down in `finally` so a failed/cancelled run can't leak it.
      const unlisten = await listen<{ node_id: string; progress: number }>(
        "voice-progress",
        (e) => {
          if (e.payload.node_id === nodeId) {
            useWorkflowStore.getState().setNodeProgress(segmentId, nodeId, e.payload.progress);
          }
        },
      );
      voiceInvokesInFlight.set(segmentId, (voiceInvokesInFlight.get(segmentId) ?? 0) + 1);
      try {
        // Options are EXACTLY the snake_case contract keys (voiceDefaults.ts, THE single source of
        // truth): node params store them verbatim, defaults fill anything unset. No other invoke
        // args — the legacy `shallowDiffusion` arg is gone (feature deferred by user decision).
        // S66/O5: Rust writes the wav to outputPath and returns just the path — the old
        // ~100MB samples JSON (response + save_temp_audio write-back) is gone.
        await invoke<{ path: string; sample_rate: number }>(
          isRvc ? "run_rvc" : "run_sovits",
          {
            voiceName,
            modelPath,
            audioPath: primaryInput!,
            nodeId,
            outputPath,
            options: buildVoiceOptions(isRvc ? RVC_DEFAULTS : SOVITS_DEFAULTS, params),
          },
        );
      } finally {
        unlisten();
        voiceInvokesInFlight.set(segmentId, Math.max(0, (voiceInvokesInFlight.get(segmentId) ?? 1) - 1));
      }
      outputData.set(0, outputPath);
      break;
    }

    case "msstSeparation": {
      // Effective inference precision: the node's explicit choice, else the ARCH default
      // (melband = fp16 — inst_v2 fp32 saturates 12GB VRAM). Always SEND the effective value;
      // Rust degrades gracefully (missing .fp16.onnx → fp32 with a warning, and vice versa).
      // Arch comes from the catalog entry for the node's model file, falling back to the
      // installed list's detected architecture (covers locally imported models).
      const modelFile = (params.modelFile as string) ?? "";
      const arch =
        MSST_CATALOG.find((e) => e.filename === modelFile)?.architecture ??
        (useMsstModelStore.getState().installed.find((m) => m.filename === modelFile)
          ?.architecture as MsstArchitecture | undefined);
      const config = {
        audioPath: primaryInput!,
        // S64 portability: recompute from the current models dir + stable modelFile (stale absolute
        // path after an install/data-dir move; the node UI only heals on mount).
        modelPath: await healMsstModelPath(
          params.modelFile as string | undefined,
          (params.modelPath as string) ?? (params.modelName as string) ?? "",
        ),
        // Per-NODE subdir: Rust names stems by LABEL only ("vocals.wav"), so two separation nodes in one
        // run emitting a same-labeled stem would overwrite each other inside the shared run dir. Rust
        // create_dir_all's the output dir before writing.
        outputDir: `${cacheDir}/${nodeId}`,
        device: (params.device as string) ?? "cpu",
        normalize: (params.normalize as boolean) ?? false,
        useTta: (params.useTta as boolean) ?? false,
        shifts: (params.shifts as number) ?? 0,
        // Only override num_overlap when the user explicitly set it — otherwise OMIT it so Rust keeps
        // the model-JSON default (bs/mel=2, mdx23c/htdemucs=4). Always sending a number would force
        // every model to it and silently coarsen mdx23c/htdemucs (whose real default is 4).
        ...(params.numOverlap !== undefined ? { numOverlap: params.numOverlap as number } : {}),
        ...(params.batch !== undefined ? { batch: params.batch as number } : {}),
        // uvr_vr-only knobs: OMIT when unset so Rust keeps its own defaults (aggression 5,
        // post-process off, threshold 0.2). Other archs never set them.
        ...(params.aggression !== undefined ? { aggression: params.aggression as number } : {}),
        ...(params.postProcess !== undefined ? { postProcess: params.postProcess as boolean } : {}),
        ...(params.postProcessThreshold !== undefined ? { postProcessThreshold: params.postProcessThreshold as number } : {}),
        precision: (params.precision as string | undefined)
          ?? (arch !== undefined ? MSST_DEFAULT_PRECISION[arch] : undefined)
          ?? "fp32", // arch "unknown"/unresolvable → fp32 (Rust auto-uses fp16 if it's the only file)
      };
      // Rejection CODEs (SEPARATION_BUSY backstop / MSST_MODEL_NOT_CONVERTED) are localized once at
      // the run-catch (executeWorkflow / executeSingleNode) — the single mapping point.
      await invoke("run_msst_separation", { config });
      let status = await invoke<{ state: string | Record<string, string>; stems?: { label: string; path: string }[]; progress?: number }>("get_separation_status");
      // No-PROGRESS (stall) timeout instead of a fixed wall clock: a slow GPU / CPU fallback / TTA
      // (3+ full passes) can legitimately run very long, so we only fail when progress stops
      // advancing for STALL_TIMEOUT. A single chunk never takes this long even on CPU, so a real
      // stall (crash / OOM) is caught while a slow-but-advancing run is never killed.
      const STALL_TIMEOUT = 180 * 1000;
      let lastProgress = -1;
      let lastProgressAt = Date.now();
      while (typeof status.state === "string" && status.state !== "Completed" && status.state !== "Idle") {
        if (useWorkflowStore.getState().isCancelled(segmentId)) {
          await invoke("cancel_separation").catch(() => {});
          // Wait briefly to see if it already completed
          await new Promise((r) => setTimeout(r, 1000));
          status = await invoke("get_separation_status");
          if (status.state === "Completed") break;
          throw new Error("Cancelled");
        }
        await new Promise((r) => setTimeout(r, 500));
        status = await invoke("get_separation_status");
        if (typeof status.state === "string") {
          const p = status.progress ?? 0;
          if (p > lastProgress + 1e-4) { lastProgress = p; lastProgressAt = Date.now(); }
          useWorkflowStore.getState().setNodeProgress(segmentId, nodeId, p);
        }
        if (Date.now() - lastProgressAt > STALL_TIMEOUT) {
          // Abandon the backend job too: leaving it running permanently armed the SEPARATION_BUSY guard
          // (frontend showed "stopped" while the worker kept going — the state-desync the user hit).
          await invoke("cancel_separation").catch(() => {});
          throw new Error("MSST separation stalled: no progress for 180s (possible crash or out-of-memory)");
        }
      }
      if (typeof status.state === "object") {
        const errMsg = (status.state as Record<string, string>).Error ?? "MSST separation failed";
        throw new Error(errMsg);
      }
      if (status.state !== "Completed") {
        throw new Error(`MSST separation ended unexpectedly: ${JSON.stringify(status.state)}`);
      }
      useWorkflowStore.getState().setNodeProgress(segmentId, nodeId, 1);
      // A "Completed" status with no stems is a real failure (crash / no output written) — surface it
      // instead of marking the node green with nothing to deposit (the silent 0-output path).
      if (!status.stems || status.stems.length === 0) {
        throw new Error("MSST separation reported Completed but produced no stems");
      }
      for (let i = 0; i < status.stems.length; i++) {
        outputData.set(i, status.stems[i]!.path);
      }
      break;
    }

    case "transpose": {
      // The Signalsmith node (spectral transpose + formant controls) — built for
      // instrumentals. All-neutral = exact passthrough: forward the input path untouched so
      // an inert node costs nothing and downstream lanes keep byte-identical audio. A
      // non-default follow alone (0 st, 0 offset) is also inert — with no transpose there is
      // nothing for formants to follow or resist.
      const semitones = typeof params.semitones === "number" ? params.semitones : 0;
      const formantOffset = typeof params.formantOffset === "number" ? params.formantOffset : 0;
      // formantFollow: 1 = classic full-spectrum shift (pre-S82 default); a same-session
      // preserveFormants=true save reads as follow 0 (the checkbox this slider replaced).
      const formantFollow = typeof params.formantFollow === "number"
        ? params.formantFollow
        : params.preserveFormants === true ? 0 : 1;
      if (semitones === 0 && formantOffset === 0) {
        outputData.set(0, primaryInput!);
        break;
      }
      const outputPath = `${cacheDir}/${nodeId}_transpose.wav`;
      // TRANSPOSE_* CODEs are localized once at the run-catch (the single mapping point).
      await invoke("transpose_audio", {
        path: primaryInput,
        semitones,
        formantFollow,
        formantOffset,
        outputPath,
      });
      outputData.set(0, outputPath);
      break;
    }

    case "split": {
      const numOutputs = (params.outputs as number) ?? 2;
      for (let i = 0; i < numOutputs; i++) {
        outputData.set(i, primaryInput!);
      }
      break;
    }

    case "amtMidi": {
      const midiMode = (params.midiMode as string) ?? "smart";
      const useGpu = (params.useGpu as boolean) ?? true;
      const backend = (params.backend as string) ?? "yourmt3";
      const quantizeGrid = (params.quantizeGrid as string) ?? "off";
      const midiTrackMode = (params.midiTrackMode as string) ?? "multi_track";
      const muscriptorInstruments = (params.muscriptorInstruments as string[]) ?? [];
      // Python contract: only "official" | "telknet" (never the legacy "sustain_connect").
      // Sanitize legacy persisted values so old projects keep working.
      const rawChain = (params.muscriptorChain as string) ?? "official";
      const muscriptorChain = rawChain === "telknet" ? "telknet" : "official";
      const outDir = `${cacheDir}/amt_${nodeId}`;
      const isMulti = ["smart", "vocal_split", "six_stem_split"].includes(midiMode);

      // Stream sidecar progress into the node's progress bar. The sidecar
      // reports overall progress in [0,1] on the `progress` field.
      const unlisten = await listen<{
        node_id: string | null;
        progress: number;
        total: number;
        message: string | null;
      }>("amt-progress", (e) => {
        if (e.payload.node_id && e.payload.node_id !== nodeId) return;
        const p = e.payload.total > 0 ? e.payload.progress / e.payload.total : e.payload.progress;
        useWorkflowStore.getState().setNodeProgress(segmentId, nodeId, Math.min(1, Math.max(0, p)));
      });

      try {
        let res;
        try {
          res = await invoke<{
          midi_path: string;
          total_notes: number | null;
          processing_time_secs: number;
          stem_midi_paths: Record<string, string> | null;
          vocal_midi_path: string | null;
          accompaniment_midi_path: string | null;
          merged_midi_path: string | null;
          separated_audio: Record<string, string> | null;
        }>("run_amt_midi", {
          audioPath: primaryInput!,
          midiMode,
          transcriptionBackend: isMulti ? backend : null,
          yourmt3Model: null,
          muscriptorModel: null,
          midiTrackMode: isMulti ? midiTrackMode : null,
          tempoMode: null,
          customBpm: null,
          quantizeNotes: quantizeGrid !== "off",
          quantizeGrid: quantizeGrid === "off" ? null : quantizeGrid,
          useGpu,
          gpuDevice: 0,
          outputDir: outDir,
          nodeId,
          muscriptorInstruments: backend === "muscriptor" ? muscriptorInstruments : null,
          muscriptorProcessingChain: backend === "muscriptor" ? muscriptorChain : null,
        });
        } catch (e) {
          // The Stop button force-kills the AMT sidecar (cancel_amt_all). A kill makes the
          // in-flight run_amt_midi reject with a non-cancel error; if the run was actually
          // flagged cancelled, settle as a clean "Cancelled" so no red node / error modal.
          if (useWorkflowStore.getState().isCancelled(segmentId)) {
            await invoke("cancel_amt_all").catch(() => {});
            throw new Error("Cancelled");
          }
          throw e;
        }
        // Separation-only modes (vocal_split / six_stem_split) emit WAV stems
        // in separated_audio rather than a MIDI — fall back to the first stem
        // so the node has a real, playable output.
        const primaryOut = res.midi_path || Object.values(res.separated_audio ?? {})[0] || "";
        outputData.set(0, primaryOut);

        // Expose additional MIDI artifacts (per-stem, vocal/accomp, merged) as
        // extra output slots so the node preview can show download buttons for
        // each. Slot 0 = primary; 1+ = supplementary.
        let slot = 1;
        if (res.merged_midi_path) outputData.set(slot++, res.merged_midi_path);
        if (res.vocal_midi_path) outputData.set(slot++, res.vocal_midi_path);
        if (res.accompaniment_midi_path) outputData.set(slot++, res.accompaniment_midi_path);
        if (res.stem_midi_paths) {
          for (const [, p] of Object.entries(res.stem_midi_paths)) {
            if (p) outputData.set(slot++, p);
          }
        }
        // Also expose separated WAV stems as output slots (for split modes).
        if (res.separated_audio) {
          for (const [, p] of Object.entries(res.separated_audio)) {
            if (p) outputData.set(slot++, p);
          }
        }

        useWorkflowStore.getState().setNodeProgress(segmentId, nodeId, 1);
        // Capture run context so the MIDI workbench can re-quantize / re-tempo.
        useAmtStore.getState().setRun({
          nodeId,
          audioPath: primaryInput!,
          midiPath: res.midi_path,
          mode: midiMode,
          backend,
          totalNotes: res.total_notes,
          processingTimeSecs: res.processing_time_secs,
        });
        // 节点转换完成后，把输出的 MIDI 自动落到主时间线：一个乐器音符轨道，
        // 替换本节点之前生成的轨道（去重），轨道名用 MIDI 里的乐器名。
        if (res.midi_path) {
          await materializeAmtMidiTracks(nodeId, res.midi_path, midiTrackMode, primaryInput, outDir);
        }

        // 🎵 Beat-This: 音频源自动测速 → 填工程 BPM (fire-and-forget,不阻塞节点执行).
        const audioExts = new Set(["wav", "mp3", "flac", "ogg", "m4a", "aiff", "aac", "opus"]);
        const isAudio = primaryInput && audioExts.has((primaryInput.split(".").pop() ?? "").toLowerCase());
        if (isAudio) {
          void (async () => {
            try {
              const tempo = await invoke<{ bpm: number; confidence: number; not_constant?: boolean }>(
                "analyze_segment_tempo", { path: primaryInput, windowStartMs: 0, windowEndMs: 0, beats_per_bar: 4 }
              );
              if (tempo && tempo.bpm > 30 && tempo.bpm < 300) {
                const prev = useProjectStore.getState().tempo;
                if (Math.abs(prev - tempo.bpm) > 0.5) {
                  useProjectStore.getState().setTempo(Math.round(tempo.bpm * 10) / 10);
                  useAppStore.getState().showToast(
                    `🎵 Beat-This: 检测 BPM ${Math.round(tempo.bpm * 10) / 10} (置信度 ${Math.round(tempo.confidence * 100)}%) — 工程已自动填入`,
                    "info",
                  );
                }
              }
            } catch { /* tempo 检测失败不影响转谱 */ }
          })();
        }
      } finally {
        unlisten();
      }
      break;
    }

    // ── 纯前端/AI 自动编曲节点 (不需要 Tauri backend, 浏览器里也能跑) ──

        case "speedShift": {
      // Signalsmith spectral time-stretch (保音高变速). Rust backend handles the DSP.
      // time_factor = 1/rate  (rate=2.0x -> factor=0.5  half duration)
      // rate=0.5x -> factor=2.0  double duration)
      const rate = (params.rate as number) ?? 1.0;
      if (Math.abs(rate - 1.0) < 0.001) {
        // Near-identity: passthrough (no DSP cost, cache-friendly)
        outputData.set(0, primaryInput!);
        break;
      }
      if (isSourceNode) {
        throw new Error("speedShift requires an input connection (audio or MIDI)");
      }
      const timeFactor = 1 / rate;
      try {
        const result = await invoke<{ output_path: string; duration_ms: number; sample_rate: number; channels: number }>(
          "stretch_segment_audio", { path: primaryInput, time_factor: timeFactor }
        );
        outputData.set(0, result.output_path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // STRETCH_RATIO_RANGE: user set an extreme rate we can't handle
        if (msg.includes("STRETCH_RATIO_RANGE")) {
          throw new Error("Speed rate must be between 0.25x and 4.0x");
        }
        // Other failure (missing file etc.) — fallback passthrough, don't break the graph
        outputData.set(0, primaryInput!);
        console.warn("[speedShift] stretch failed, passthrough fallback:", msg);
      }
      break;
    }

    case "chordDetect": {
      if (isSourceNode) throw new Error("chordDetect needs audio/MIDI input");
      if (!primaryInput) throw new Error("chordDetect: no input connected");
      const ext = (primaryInput.split(".").pop() ?? "").toLowerCase();
      let notes: Array<{ tick: number; duration: number; pitch: number; velocity?: number }> = [];
      let ppq = 480;
      if (ext === "mid" || ext === "midi") {
        const res = await invoke<any>("import_score_file", { path: primaryInput });
        notes = (res?.tracks ?? []).flatMap((t: any) =>
          (t.notes ?? []).map((n: any) => ({ tick: n.tick, duration: n.duration, pitch: n.pitch, velocity: n.velocity }))
        );
        ppq = res?.ppq ?? 480;
      } else {
        throw new Error("chordDetect needs MIDI input. Connect an AMT node upstream (audio → AMT → chordDetect)");
      }
      if (notes.length === 0) throw new Error("chordDetect: input has no notes");
      const result = analyzeChords(notes, ppq, 4);
      outputData.set(0, JSON.stringify({
        segments: result.segments.map((s) => ({ startTick: s.startTick, endTick: s.endTick, label: s.label })),
        key: result.key.label, confidence: result.key.confidence,
      }));
      outputData.set(1, result.segments.map((s) => s.label).join(" | "));
      break;
    }

    case "autoArrange": {
      if (isSourceNode) throw new Error("autoArrange needs MIDI or chord input");
      if (!primaryInput) throw new Error("autoArrange: no input connected");

      // 1. Parse input to notes (MIDI file) or chord block (JSON)
      let notes: ChordAnalysisNote[] = [];
      
      let chordBlock: { chords: Array<{ label: string; root: number; quality?: string }>; bpm?: number } | null = null;

      if (primaryInput.trim().startsWith("{")) {
        // JSON input: could be chordBlock or notes array
        try {
          const parsed = JSON.parse(primaryInput);
          if (parsed.type === "chordBlock" && parsed.chords) {
            chordBlock = parsed;
          } else if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].pitch != null) {
            notes = parsed as ChordAnalysisNote[];
          }
        } catch { /* ignore */ }
      } else {
        // File path — try import_score_file
        const ext = (primaryInput.split(".").pop() ?? "").toLowerCase();
        if (ext === "mid" || ext === "midi") {
          const res = await invoke<any>("import_score_file", { path: primaryInput });
          notes = (res?.tracks ?? []).flatMap((t: any) =>
            (t.notes ?? []).map((n: any) => ({ tick: n.tick, duration: n.duration, pitch: n.pitch, velocity: n.velocity ?? 100 }))
          );
          void (res?.ppq);
        } else {
          throw new Error("autoArrange needs MIDI input (.mid/.midi), chord block, or AMT node upstream");
        }
      }

      // 2. If we got notes → run arrange() (real engine). If only chord block → build fake "block chord" notes.
      let chordAnalysisNotes: ChordAnalysisNote[] = notes;
      if (chordBlock && notes.length === 0) {
        // Synthesize block chord notes from chord labels → arrange engine treats them as "stub melody".
        // Each chord gets 2 block octaves on beats 1+3 (C4..C5), then piano takes the voicing below.
        const beatsPerBar = 4;
        const chordNotes: ChordAnalysisNote[] = [];
        chordBlock.chords.forEach((c, i) => {
          const barStart = i * beatsPerBar * TICKS_PER_BEAT;
          const rootPc = c.root;
          chordNotes.push({ tick: barStart, duration: beatsPerBar * TICKS_PER_BEAT, pitch: rootPc + 60, velocity: 90 });
          chordNotes.push({ tick: barStart + TICKS_PER_BEAT * 2, duration: TICKS_PER_BEAT * 2, pitch: rootPc + 72, velocity: 80 });
        });
        chordAnalysisNotes = chordNotes;
      }
      if (chordAnalysisNotes.length === 0) throw new Error("autoArrange: no notes or chord blocks to arrange");

      // 3. Call real arrange() engine — same as DAW menu layer
      const proj = useProjectStore.getState();
      const style = (params.style as ArrangeStyle) ?? "pop";
      const mood = (params.mood as ArrangeMood) ?? "neutral";
      const res = arrange({
        notes: chordAnalysisNotes,
        tempo: proj.tempo,
        timeSignature: proj.timeSignature,
        style,
        mood,
      });
      if (!res || res.bars === 0) throw new Error("autoArrange: arrange engine produced no output");

      // 4. Write 5-track JSON files to cacheDir, outputData holds paths
      const outDir = cacheDir + "/arrange_" + nodeId;
      const fs = await import("@tauri-apps/plugin-fs").catch(() => null);
      const writeJson = async (filePath: string, data: any) => {
        const json = JSON.stringify(data);
        if (fs && (fs as any).writeTextFile) await (fs as any).writeTextFile(filePath, json);
        else {
          // Fallback: store in-memory string (preview node reads from outputData)
          return json;
        }
        return filePath;
      };

      // Collects: outputData maps slot → result
      // 🎵 全部 11 轨输出 (OPT1+OPT2 扩充乐器现在也走 workflow 节点)
      const tracks = [
        { key: "drums",       label: "🥁 Drums",       notes: res.drums },
        { key: "bass",        label: "🎸 Bass",        notes: res.bass },
        { key: "piano",       label: "🎹 Piano",       notes: res.piano },
        { key: "guitarArp",   label: "🪕 GuitarArp",  notes: res.guitarArp },
        { key: "guitarStrum", label: "🎶 Strum",       notes: res.guitarStrum },
        { key: "epiano",      label: "🎼 E.Piano",     notes: res.epiano },
        { key: "strings",     label: "🎻 Strings",     notes: res.strings },
        { key: "pad",         label: "🪟 Pad",         notes: res.pad },
        { key: "synthPad",    label: "🎛 SynthPad",    notes: res.synthPad },
        { key: "pluck",       label: "💠 Pluck",       notes: res.pluck },
        { key: "melody",      label: "✨ Lead",        notes: res.melody },
      ];
      const manifest: any = { style, mood, key: res.key.label, confidence: res.key.confidence, bars: res.bars, startTick: res.startTick, endTick: res.endTick };
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i]!;
        const path = `${outDir}/${t.key}.json`;
        await writeJson(path, { key: res.key.label, chords: res.chords, notes: t.notes });
        manifest[t.key + "Notes"] = t.notes.length;
        // Store in outputData. If writeJson returned raw string (no fs), store that instead.
        outputData.set(i, path);
      }
      // chord summary JSON on slot 11 (超出主输出端口, 供下游 chordDetect 消费者读)
      outputData.set(11, JSON.stringify({ chords: res.chords, key: res.key.label, bars: res.bars }));
      break;
    }

    case "deepOriginal": {
      const rate = (params.rate as number) ?? 1.0;
      const semitones = (params.semitones as number) ?? 0;
      let outPath = primaryInput ?? "";
      if (!isSourceNode && primaryInput && Math.abs(rate - 1.0) > 0.001) {
        try {
          const s = await invoke<{ output_path: string }>("stretch_segment_audio", { path: primaryInput, time_factor: 1 / rate });
          outPath = s.output_path;
        } catch { /* passthrough */ }
      }
      if (!isSourceNode && primaryInput && semitones !== 0) {
        try {
          const tpath = cacheDir + "/deepOrig_" + nodeId + ".wav";
          await invoke("transpose_audio", { path: outPath, semitones, formantFollow: 1, formantOffset: 0, outputPath: tpath });
          outPath = tpath;
        } catch { /* passthrough */ }
      }
      for (let p = 0; p < 5; p++) outputData.set(p, outPath);
      break;
    }

    case "midiFileIn": {
      const filePath = (params.filePath as string) ?? "";
      if (!filePath) throw new Error("MIDI File In: pick a .mid file first (click the button)");
      outputData.set(0, filePath);
      break;
    }

    case "chordBlockIn": {
      const chordStr = (params.chords as string) ?? "C | Am | F | G";
      const bpm = (params.bpm as number) ?? 120;
      const rootMap2: Record<string, number> = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };
      const parts = chordStr.split(/[|,;]/).map((s) => s.trim()).filter(Boolean);
      const chords = parts.map((label) => {
        const m = label.match(/^([A-G][#b]?)/);
        return { label, root: (rootMap2[m?.[1] ?? "C"] ?? 0) };
      });
      outputData.set(0, JSON.stringify({ type: "chordBlock", chords, bpm, ppq: 480 }));
      break;
    }

    case "harmonizer": {
      if (isSourceNode) throw new Error("harmonizer needs MIDI or chord input");
      if (!primaryInput) throw new Error("harmonizer: no input connected");
      let notes: ChordAnalysisNote[] = [];
      if (primaryInput.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(primaryInput);
          if (Array.isArray(parsed)) notes = parsed;
          else if (parsed.notes) notes = parsed.notes;
        } catch { /* ignore */ }
      } else {
        const ext = (primaryInput.split(".").pop() ?? "").toLowerCase();
        if (ext === "mid" || ext === "midi") {
          const res = await invoke<any>("import_score_file", { path: primaryInput });
          notes = (res?.tracks ?? []).flatMap((t: any) =>
            (t.notes ?? []).map((n: any) => ({ tick: n.tick, duration: n.duration, pitch: n.pitch, velocity: n.velocity ?? 100 }))
          );
        } else {
          throw new Error("harmonizer needs MIDI input or chordDetect/autoArrange output");
        }
      }
      if (notes.length === 0) throw new Error("harmonizer: no notes");
      const proj = useProjectStore.getState();
      const style = (params.chordStyle as string) ?? "POP_STANDARD";
      const chordsPerBar = (params.chordsPerBar as number) ?? 1;
      const keyName = (params.key as string) ?? "auto";
      const res = generateChordMidi({
        notes,
        timeSignature: proj.timeSignature,
        style: style as any,
        chordsPerBar: chordsPerBar === 2 ? 2 : 1,
        key: keyName,
      });
      if (!res) throw new Error("harmonizer: no chord output");
      outputData.set(0, JSON.stringify(res.notes));
      outputData.set(1, JSON.stringify({ segments: res.segments, key: res.key.label, bars: res.bars }));
      break;
    }

    case "melodyGen": {
      if (isSourceNode) throw new Error("melodyGen needs chord input");
      if (!primaryInput) throw new Error("melodyGen: no chord input connected");
      let chordBlock: any = null;
      if (primaryInput.trim().startsWith("{")) {
        try { chordBlock = JSON.parse(primaryInput); } catch { /* ignore */ }
      }
      const proj = useProjectStore.getState();
      const style = (params.style as ArrangeStyle) ?? "pop";
      const mood = (params.mood as ArrangeMood) ?? "neutral";
      const stubNotes: ChordAnalysisNote[] = [];
      const chords = chordBlock?.chords ?? chordBlock?.segments ?? [{ label: "C", root: 0 }];
      const beatsPerBar = proj.timeSignature[0] ?? 4;
      chords.forEach((c: any, i: number) => {
        const barStart = i * beatsPerBar * TICKS_PER_BEAT;
        const root = typeof c === "number" ? c : (c.root ?? 0);
        stubNotes.push({ tick: barStart, duration: beatsPerBar * TICKS_PER_BEAT, pitch: root + 60, velocity: 90 });
      });
      const res = arrange({ notes: stubNotes, tempo: proj.tempo, timeSignature: proj.timeSignature, style, mood });
      if (!res) throw new Error("melodyGen: arrange failed");
      outputData.set(0, JSON.stringify(res.melody));
      outputData.set(1, JSON.stringify({ style, mood, key: res.key.label, bars: res.bars, chordCount: chords.length }));
      break;
    }

    case "songGenYue2":
    case "songGenAceStep": {
      // 外部推理服务驱动的歌曲生成 — 不读音频输入, 零输入节点.
      // 两种协议差异只体现在 params 字段上, Rust 端 song_generate 统一转发.
      const model = (params.model as string) ?? "";
      const service_url = (params.service_url as string) ?? "";
      if (!model) throw new Error(`${nodeType}: 请先在左侧面板的 Music Models 中选择一个已下载的音乐模型`);
      if (!service_url) throw new Error(`${nodeType}: 请在节点参数里填写推理服务 URL (http://...)`);
      const outDir = `${cacheDir}/${nodeId}`;
      await invoke<{
        label: string;
        audio_path?: string;
        midi_path?: string;
        lrc_path?: string;
      }[]>("song_generate", {
        req: {
          model,
          lyrics: params.lyrics as string | undefined,
          prompt: params.prompt as string | undefined,
          negative_prompt: params.negative_prompt as string | undefined,
          bpm: params.bpm as number | undefined,
          time_signature: params.timeSignature as string | undefined,
          language: params.language as string | undefined,
          audio_duration: params.audioDuration as number | undefined,
          want_stems: params.wantStems as boolean | undefined,
          want_midi: params.wantMidi as boolean | undefined,
          want_lrc: params.wantLrc as boolean | undefined,
          // YuE2 专属
          cot: params.cot as string | undefined,
          vocal_gender: params.vocalGender as string | undefined,
          vocal_type: params.vocalType as string | undefined,
          vocal_range: params.vocalRange as string | undefined,
          // ACE-Step 专属
          checkpoint: params.checkpoint as string | undefined,
          guidance_scale: params.guidanceScale as number | undefined,
          shift: params.shift as number | undefined,
          num_inference_steps: params.numInferenceSteps as number | undefined,
          cfg_scale: params.cfgScale as number | undefined,
          seed: params.seed as number | undefined,
          format: params.format as string | undefined,
          // 通用
          service_url,
          output_dir: outDir,
        },
      });
      // outputData: 0=primary audio path, 1=midi path (if any), 2=lrc path, 3=stems-dir
      outputData.set(0, `${outDir}/primary.wav`);
      outputData.set(1, `${outDir}/primary.mid`);
      outputData.set(2, `${outDir}/primary.lrc`);
      outputData.set(3, outDir);
      break;
    }
  }

  return outputData;
}

/** Single merged MIDI file → per-instrument note tracks in the main timeline.
 *  The AMT sidecar writes ONE merged .mid whose TRACKS are the instruments (this is the
 *  reliable source of per-stem data — the sidecar's `stem_midi_paths` map is unpopulated at
 *  runtime). Repeating the same node REPLACES its prior auto-generated tracks (tagged by
 *  `amtNodeId`) instead of piling up duplicates. Track names come from the MIDI TrackName
 *  (fallback: <midi file base>_<index>), so "出来多少个就显示多少个，名字是乐器名"。 */
async function materializeAmtMidiTracks(
  nodeId: string,
  midiPath: string,
  trackMode = "multi_track",
  sourceAudioPath?: string,
  playbackDir?: string,
): Promise<void> {
  const showToast = useAppStore.getState().showToast;
  // 撤销全覆盖（§user）：节点的"去旧建新"落轨合并成一步撤销——没有事务时，
  // removeTrack + N×addTrack 会碎成 N+1 步，撤销只能一条条退，体验极差。
  useHistoryStore.getState().beginTransaction();
  try {
    const project = useProjectStore.getState();
    // Replace any earlier auto-generated tracks from THIS node (dedup on re-run).
    for (const t of [...project.tracks]) {
      if (t.amtNodeId === nodeId) useProjectStore.getState().removeTrack(t.id);
    }

    let score: ImportedAmtScore;
    try {
      score = await invoke<ImportedAmtScore>("import_score_file", { path: midiPath });
    } catch (e) {
      showToast(i18n.t("amt.midiParseFailed", "MIDI 解析失败：无法读取转换结果。"), "error");
      return;
    }
    const tracks = score.tracks?.filter((t) => t.notes && t.notes.length > 0) ?? [];
    if (tracks.length === 0) return;

    const base =
      midiPath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "") || nodeId;
    const addTrack = useProjectStore.getState().addTrack;

    // Synthesize per-instrument playback WAVs so every materialized track is AUDIBLE —
    // notes-only tracks play nothing in the DAW transport. Best-effort: on failure we
    // still import the notes (visible, editable), they'd just be silent.
    let wavs: Record<string, string> = {};
    let fullMixWav: string | undefined;
    if (sourceAudioPath && playbackDir) {
      try {
        const pb = await invoke<any>("amt_prepare_playback", {
          midiPath,
          audioPath: sourceAudioPath,
          outputDir: playbackDir,
        });
        wavs = (pb?.instrument_wavs ?? {}) as Record<string, string>;
        fullMixWav = pb?.transcription_wav || undefined;
        await invoke("allow_asset_dir", { dir: playbackDir }).catch(() => {});
      } catch (e) {
        console.warn(`[amtMidi] playback synthesis failed for ${nodeId}:`, e);
      }
    }

    // Per-track GM metadata (program+channel) maps track names onto the sidecar's
    // "gm:NNN"/"drums" WAV keys — the human names alone never match.
    let metaTracks: any[] = [];
    try {
      const meta = await invoke<any>("amt_midi_metadata", { midiPath });
      metaTracks = meta?.tracks ?? [];
    } catch { /* best-effort */ }
    const metaFor = (name: string) =>
      metaTracks.find((m: any) => m.name === name) || undefined;

    /** Build a playable audio lane for one track's WAV (peaks + duration). */
    const buildLane = async (
      wav: string,
      segmentId: string,
      label: string,
      maxTick: number,
    ): Promise<ProcessedOutput | undefined> => {
      let totalDurationMs = Math.max(1, (maxTick / (480 * (120 / 60))) * 1000);
      let waveformPeaks: number[] | undefined;
      try {
        const data = await useAudioStore.getState().loadAudioFile(wav);
        if (data.durationMs > 0) totalDurationMs = data.durationMs;
        if (data.peaks && data.peaks.length > 0) waveformPeaks = data.peaks;
      } catch { /* best-effort waveform */ }
      return {
        laneId: segmentId,
        laneLabel: label,
        group: label,
        audioPath: wav,
        totalDurationMs,
        waveformPeaks,
      } as ProcessedOutput;
    };

    // 单轨道模式：把所有乐器合并进一条轨道（轨道名 = MIDI 文件名），整条挂
    // 全乐器混音 WAV 保证可播放。
    if (trackMode === "single_track") {
      const allNotes = tracks.flatMap((it) =>
        it.notes.map((n) => ({
          id: crypto.randomUUID(),
          tick: n.tick,
          duration: n.duration,
          pitch: n.pitch,
          lyric: n.lyric || "La",
          velocity: n.velocity ?? 100,
        })),
      );
      let maxTick = 0;
      for (const n of allNotes) maxTick = Math.max(maxTick, n.tick + n.duration);
      const segmentId = crypto.randomUUID();
      const lane = fullMixWav ? await buildLane(fullMixWav, segmentId, base, maxTick) : undefined;
      addTrack({
        id: crypto.randomUUID(),
        name: localizeTrackName(base, 0),
        trackType: "instrument",
        volumeDb: 0,
        pan: 0,
        muted: false,
        solo: false,
        expanded: false,
        laneControls: {},
        amtNodeId: nodeId,
        segments: [
          {
            id: segmentId,
            startTick: 0,
            durationTicks: Math.max(1, maxTick),
            content: { type: "notes", notes: allNotes },
            processedOutputs: lane ? [lane] : undefined,
          },
        ],
      });
      showToast(i18n.t("amt.nodeTracksGenerated", { count: 1 }), "success");
      return;
    }

    // 全轨道（multi_track）模式：一个乐器一条轨道，轨道名 = 乐器名，每条挂
    // 对应乐器的合成 WAV 保证可播放。
    for (let i = 0; i < tracks.length; i++) {
      const it = tracks[i];
      if (!it?.notes || it.notes.length === 0) continue;
      const name = localizeTrackName(it.name?.trim() || `${base}_${i + 1}`, i);
      const maxTick = it.notes.reduce(
        (m, n) => Math.max(m, n.tick + n.duration),
        it.start_tick ?? 0,
      );
      const mt = metaFor(it.name || "");
      const wav = matchInstrumentWav(wavs, it.name || "", mt?.program ?? null, mt?.channel ?? null);
      const segmentId = crypto.randomUUID();
      const lane = wav ? await buildLane(wav, segmentId, name, maxTick) : undefined;
      addTrack({
        id: crypto.randomUUID(),
        name,
        trackType: "instrument",
        volumeDb: 0,
        pan: 0,
        muted: false,
        solo: false,
        expanded: false,
        laneControls: {},
        amtNodeId: nodeId,
        segments: [
          {
            id: segmentId,
            startTick: 0,
            durationTicks: Math.max(1, maxTick),
            content: {
              type: "notes",
              notes: it.notes.map((n) => ({
                id: crypto.randomUUID(),
                tick: n.tick,
                duration: n.duration,
                pitch: n.pitch,
                lyric: n.lyric || "La",
                velocity: n.velocity ?? 100,
              })),
            },
            processedOutputs: lane ? [lane] : undefined,
          },
        ],
      });
    }
    showToast(i18n.t("amt.nodeTracksGenerated", { count: tracks.length }), "success");
  } catch (e) {
    // 从不阻断主流程：MIDI 落轨失败只提示，不影响工作流运行结果本身。
    showToast(i18n.t("amt.nodeTracksFailed", "MIDI 音轨生成失败。"), "error");
  } finally {
    useHistoryStore.getState().commitTransaction();
  }
}

/** Shape of `import_score_file`'s result consumed by materializeAmtMidiTracks. */
interface ImportedAmtScore {
  tracks: {
    name: string;
    start_tick: number;
    notes: { tick: number; duration: number; pitch: number; lyric?: string; velocity?: number }[];
  }[];
}

/** MuScriptor 乐器名 / 六轨分离 stem 名 → 中文轨道名。
 *  匹配时先精确匹配乐器 ID，再大小写不敏感做子串兜底，
 *  最后 fallback 到原始名（MIDI TrackName 可能是任意字符串）。 */
const STEM_ZH_MAP: Record<string, string> = {
  // 六轨分离 stem 名
  vocals: "人声",
  voice: "人声",
  drums: "鼓组",
  drum: "鼓组",
  bass: "贝斯",
  guitar: "吉他",
  piano: "钢琴",
  other: "其他",
  // MuScriptor 乐器名
  acoustic_piano: "原声钢琴",
  electric_piano: "电钢琴",
  chromatic_percussion: "半音阶打击乐",
  organ: "风琴",
  acoustic_guitar: "原声吉他",
  clean_electric_guitar: "干净电吉他",
  distorted_electric_guitar: "失真电吉他",
  acoustic_bass: "原声贝斯",
  electric_bass: "电贝斯",
  violin: "小提琴",
  viola: "中提琴",
  cello: "大提琴",
  contrabass: "低音提琴",
  orchestral_harp: "管弦乐竖琴",
  timpani: "定音鼓",
  string_ensemble: "弦乐合奏",
  synth_strings: "合成弦乐",
  orchestra_hit: "管弦乐击奏",
  trumpet: "小号",
  trombone: "长号",
  tuba: "大号",
  french_horn: "圆号",
  brass_section: "铜管乐组",
  soprano_and_alto_sax: "高音/中音萨克斯",
  tenor_sax: "次中音萨克斯",
  baritone_sax: "上低音萨克斯",
  oboe: "双簧管",
  english_horn: "英国管",
  bassoon: "巴松管",
  clarinet: "单簧管",
  flutes: "长笛组",
  synth_lead: "合成主音",
  synth_pad: "合成铺底",
};

function localizeTrackName(raw: string | undefined | null, index: number): string {
  if (!raw) return `轨道 ${index + 1}`;
  const trimmed = raw.trim();
  // 先精确匹配
  if (STEM_ZH_MAP[trimmed]) return STEM_ZH_MAP[trimmed]!;
  // 再做大小写不敏感子串匹配（处理 "Drums-1" / "vocals_clean" 这类）
  const lower = trimmed.toLowerCase();
  for (const [key, zh] of Object.entries(STEM_ZH_MAP)) {
    if (lower.includes(key)) return zh;
  }
  // 最后 fallback：如果全是英文就原样返回（可能是 unknown instrument），否则原样
  return trimmed;
}

/**
 * Display label + stem suffix for edges into an Output node ("轨道组 · stem"). Lane IDENTITY/dedup is
 * handled separately by `laneId` (see laneIdFor + getLanes in trackLayout.ts), so same-named lanes
 * never collapse — the suffix is purely cosmetic.
 */
/** The stem suffix for one edge into an Output node. When the upstream node NAMES its ports
 *  (`stemLabels`, e.g. a separation node's vocals/instrumental) the stem is used EVEN FOR A
 *  SINGLE-EDGE output — a lone "Main" that is actually the instrumental stem was the root of the
 *  same-name collision confusion (two bare same-group lanes are indistinguishable; see getLanes'
 *  display numbering for what remains). Unnamed ports keep the bare group label when single. */
function laneStem(
  graph: ReturnType<typeof parseWorkflowGraph>,
  inEdgeCount: number,
  edge: { fromNode: string; fromPort: number },
): string | null {
  const stems = (graph.nodes.get(edge.fromNode)?.node.params as Record<string, unknown> | undefined)
    ?.stemLabels as string[] | undefined;
  const stem = stems?.[edge.fromPort];
  if (stem) return stem;
  return inEdgeCount > 1 ? `out${edge.fromPort}` : null;
}

function laneLabelFor(
  graph: ReturnType<typeof parseWorkflowGraph>,
  base: string,
  inEdgeCount: number,
  edge: { fromNode: string; fromPort: number },
): string {
  const stem = laneStem(graph, inEdgeCount, edge);
  // A group named exactly like its stem (e.g. a DETACHED lane whose new group IS the stem name)
  // would read "vocals · vocals" — collapse to the bare name.
  return stem && stem !== base ? `${base} · ${stem}` : base;
}

/** Stable lane IDENTITY for one edge into an Output node = `${outputNodeId}::${fromNode}:${fromPort}`.
 *  Keyed on the PHYSICAL EDGE — NOT the inbound-edge count, NOT the display stem — so adding/removing a
 *  SIBLING edge never re-keys an existing lane (a count-dependent id would wipe a persisted lane when the
 *  count crosses 1<->2), and two DIFFERENT upstream nodes feeding one Output stay distinct (e.g. blending
 *  two voices). Canvas / header / laneControls all key on THIS, not the label; stable across re-runs +
 *  save/load since node ids + ports persist in the graph. */
function laneIdFor(
  outputNodeId: string,
  edge: { fromNode: string; fromPort: number },
): string {
  return `${outputNodeId}::${edge.fromNode}:${edge.fromPort}`;
}

/** Count the lanes that reached Output nodes — NO decode (S59 deposit-perf O3). The old
 *  collectOutputs invoked load_audio_file per lane just to build a return value the sole caller
 *  read as `.length`, double-decoding every freshly-rendered stem in parallel with the live
 *  reconciler's own deposit (S32's "deposit slower than inference" bottleneck #1). The deposit
 *  itself is the reconciler's / RenderLinkWatcher's job via loadCachedOutput. The missing-feeder
 *  warn is preserved verbatim. */
function countOutputLanes(
  graph: ReturnType<typeof parseWorkflowGraph>,
  dataMap: Map<string, Map<number, string>>,
): number {
  let count = 0;
  for (const outId of graph.outputNodeIds) {
    const gn = graph.nodes.get(outId)!;
    const base = (gn.node.params as Record<string, unknown>).laneLabel as string ?? DEFAULT_OUTPUT_GROUP;
    for (const edge of gn.inEdges) {
      const audioPath = dataMap.get(edge.fromNode)?.get(edge.fromPort);
      if (!audioPath) {
        // Don't silently swallow a missing feeder — a dropped lane with no trace reads as "it worked".
        logToBackend("warn", `Output "${base}": upstream ${edge.fromNode} port ${edge.fromPort} produced no audio — lane skipped`);
        continue;
      }
      count++;
    }
  }
  return count;
}

/** Decode-failure memo for the SETTLE deposit path: a cached path that repeatedly fails to decode
 *  (file deleted/corrupt — e.g. swept externally) must stop re-arming hasUndepositedCache, or one dead
 *  file turns every watcher tick into a failing multi-second load_audio_file invoke forever
 *  (review-caught). Keyed segment|path; paths are RUN-UNIQUE so entries never need invalidation — a
 *  re-render mints new paths. A couple of retries are kept for transient Windows file locks. */
const cacheDecodeFailures = new Map<string, number>();
const DECODE_GIVE_UP = 3;
function noteDecodeFailure(segmentId: string, audioPath: string): void {
  const k = `${segmentId}|${audioPath}`;
  cacheDecodeFailures.set(k, (cacheDecodeFailures.get(k) ?? 0) + 1);
}
function decodeGivenUp(segmentId: string, audioPath: string): boolean {
  return (cacheDecodeFailures.get(`${segmentId}|${audioPath}`) ?? 0) >= DECODE_GIVE_UP;
}

export interface CachedPath {
  laneId: string;
  laneLabel: string;
  /** The Output node's group name (laneLabel's base) — carried onto the deposited lane. */
  group: string;
  audioPath: string;
  outputNodeId: string;
}

/**
 * Collect a single Output node's cached upstream PATHS (no audio decode) — the fast first half of a
 * deposit, so the caller can show per-lane loading placeholders immediately, then decode + load each
 * one. `missing` = at least one feeder had no cached audio (caller warns rather than silently dropping).
 */
export function collectCachedPaths(
  segmentId: string,
  outputNodeId: string,
  workflow: Workflow,
): { paths: CachedPath[]; missing: boolean } {
  const graph = parseWorkflowGraph(workflow);
  const gn = graph.nodes.get(outputNodeId);
  if (!gn) return { paths: [], missing: false };
  const base = ((gn.node.params as Record<string, unknown>).laneLabel as string) ?? DEFAULT_OUTPUT_GROUP;
  const cache = useWorkflowStore.getState().nodeOutputs[segmentId] ?? {};

  const paths: CachedPath[] = [];
  let missing = false;
  for (const edge of gn.inEdges) {
    const audioPath = cache[edge.fromNode]?.[edge.fromPort];
    if (!audioPath) {
      // Upstream not rendered yet — normal mid-run; the live reconciler waits + retries on cache change.
      // No log here: collectCachedPaths runs on every reconcile, so a warn would flood the panel at frame
      // rate. (A genuinely-never-rendered lane just never deposits — visible as no lane on the track.)
      missing = true;
      continue;
    }
    // MIDI is NOT an audio lane: deposits always decode via load_audio_file, which a .mid can never
    // satisfy (ffmpeg "Invalid data"). AMT's MIDI result is surfaced as NOTE tracks by
    // materializeAmtMidiTracks instead — skip it here so the Output node never errors/litters a lane.
    if (!isAudioFile(audioPath)) continue;
    paths.push({ laneId: laneIdFor(outputNodeId, edge), laneLabel: laneLabelFor(graph, base, gn.inEdges.length, edge), group: base, audioPath, outputNodeId });
  }
  return { paths, missing };
}

/** Is this a decodable AUDIO file (not a MIDI/score file)? Deposit-as-lane and matching all go
 *  through audio decode, so non-audio outputs (MIDI) must be excluded from audio lanes. */
export function isAudioFile(p: string): boolean {
  const ext = p.split(/[/\\]/).pop()?.split(".").pop()?.toLowerCase() ?? "";
  return !["mid", "midi", "kar", "smf"].includes(ext);
}

/**
 * HEADLESS deposit — resolve a segment's Output-node lanes from the render cache using the segment's OWN
 * persisted `workflow`, with NO open editor / ReactFlow refs. The normal LIVE deposit is done by the
 * WorkflowEditor reconciler, which only runs while THAT segment's editor is open; if you navigate away from a
 * rendering segment before it finishes, its loading placeholders never resolve to real lanes (their branch
 * finished in the cache, but nothing deposited it). This lets an always-mounted watcher settle them — e.g. so
 * a split-mid-render SOURCE whose editor was closed becomes "ready" and its linked halves can inherit.
 * Respects the CURRENT graph: orphan-cleans lanes whose Output node was deleted. Returns true if it changed
 * anything. CONTRACT: call at RENDER SETTLE only — leftover `loading` placeholders are PRUNED as dead
 * (the run that would have finished them is over); real (non-loading) lanes are never touched.
 */
export async function depositFromCache(trackId: string, segmentId: string, workflow: Workflow): Promise<boolean> {
  // The settle check happens at DISPATCH, but the decodes below await for seconds — a NEW run can start
  // for this segment mid-deposit (reopen editor + Run). Depositing then would clobber the new run's
  // placeholders with old-run audio, and the settle-prune would eat its live placeholders — so re-check
  // liveness around every store write and bail the moment a run owns the segment again.
  const runningNow = () => useWorkflowStore.getState().executions[segmentId]?.status === "running";
  if (runningNow()) return false;
  let graph: ReturnType<typeof parseWorkflowGraph> | null = null;
  try { graph = parseWorkflowGraph(workflow); } catch { /* broken/incomplete graph — still prune below */ }
  let changed = false;
  if (graph) {
    const outSet = new Set(graph.outputNodeIds);
    // Lanes already deposited at the SAME path need no re-decode (paths are run-unique — same path ⇒
    // same content); skipping them keeps a settle deposit that refreshes ONE re-rendered lane from
    // re-decoding every sibling stem. Loading placeholders are NOT "deposited" (they must resolve).
    const segBefore = useProjectStore.getState().tracks.find((t) => t.id === trackId)?.segments.find((s) => s.id === segmentId);
    const alreadyAt = new Map((segBefore?.processedOutputs ?? []).filter((o) => !o.loading).map((o) => [o.laneId, o.audioPath] as const));
    for (const outId of graph.outputNodeIds) {
      const { paths } = collectCachedPaths(segmentId, outId, workflow);
      const fresh = paths.filter((p) => alreadyAt.get(p.laneId) !== p.audioPath && !decodeGivenUp(segmentId, p.audioPath));
      if (fresh.length === 0) continue;
      // S59 deposit-perf O2: decode the lanes CONCURRENTLY (each is an independent load_audio_file
      // → hound decode + peaks); the old sequential awaits serialized 4-5 multi-second decodes.
      const decoded = (await Promise.all(fresh.map((p) => loadCachedOutput(p).catch(() => {
        noteDecodeFailure(segmentId, p.audioPath); // dead/corrupt cache file — stop re-arming the watcher after a few tries
        return null;
      })))).filter((o): o is ProcessedOutput => o !== null);
      if (runningNow()) return changed;
      if (decoded.length > 0) {
        // The store merge REPLACES by outputNodeId — it must receive the node's COMPLETE lane set:
        // re-attach the lanes the fresh-filter skipped (already deposited at the same cached path), or
        // the merge would silently delete this node's healthy sibling lanes — and the settle watcher
        // would then oscillate forever re-depositing the alternating halves (review-caught HIGH).
        const kept = (segBefore?.processedOutputs ?? []).filter(
          (o) => o.outputNodeId === outId && !o.loading
            && paths.some((p) => p.laneId === o.laneId && p.audioPath === o.audioPath),
        );
        useProjectStore.getState().mergeProcessedOutputs(trackId, segmentId, [...kept, ...decoded]);
        changed = true;
      }
    }
    // Orphan cleanup: drop lanes whose producing Output node no longer exists in the current graph.
    const seg = useProjectStore.getState().tracks.find((t) => t.id === trackId)?.segments.find((s) => s.id === segmentId);
    for (const o of seg?.processedOutputs ?? []) {
      if (o.outputNodeId && !outSet.has(o.outputNodeId)) {
        useProjectStore.getState().removeProcessedOutputsForNode(trackId, segmentId, o.outputNodeId);
        changed = true;
      }
    }
  }
  // SETTLE-TIME PRUNE: this runs when the render has SETTLED (RenderLinkWatcher), so any lane STILL
  // `loading` after the merges above was never finished by the run (cancelled / failed mid-branch —
  // its feeder has no cache) and nothing will ever finish it now. The open editor's reconciler prunes
  // these for the segment it shows ("uncached + idle → no lane"); this is the headless twin — without
  // it, split-mid-render + force-stop left the LINKED half's placeholder spinning forever (the watcher's
  // source-GONE path stripped loading lanes, the settle path didn't — this closes that asymmetry).
  // Non-loading lanes are NEVER touched here (cold cache ≠ remove).
  if (runningNow()) return changed; // a new run owns the placeholders now — never prune them
  const segNow = useProjectStore.getState().tracks.find((t) => t.id === trackId)?.segments.find((s) => s.id === segmentId);
  const outs = segNow?.processedOutputs ?? [];
  if (outs.some((o) => o.loading)) {
    useProjectStore.getState().replaceProcessedOutputs(trackId, segmentId, outs.filter((o) => !o.loading));
    changed = true;
  }
  return changed;
}

/** Decode one cached path into a finished ProcessedOutput (duration + waveform peaks). */
export async function loadCachedOutput(p: CachedPath): Promise<ProcessedOutput> {
  const info = await invoke<AudioFileInfo>("load_audio_file", { path: p.audioPath });
  return {
    laneId: p.laneId,
    laneLabel: p.laneLabel,
    group: p.group,
    audioPath: p.audioPath,
    totalDurationMs: info.duration_ms,
    waveformPeaks: info.peaks,
    outputNodeId: p.outputNodeId,
  };
}

/** All inbound-edge lane IDs for ONE Output node — STRUCTURE only, no cache/audio. Lets the auto-deposit
 *  reconciler know which lanes the node SHOULD carry, so it removes a lane only when its producing edge
 *  is gone — NOT merely because this session's render cache is cold (which would wipe persisted lanes on
 *  reopening a saved segment). `fromNode` = the lane's direct feeder, so the reconciler can ask whether
 *  that branch actually participates in the active run (per-feeder pending placeholders). */
export function outputLanes(workflow: Workflow, outputNodeId: string): { laneId: string; laneLabel: string; group: string; fromNode: string }[] {
  const graph = parseWorkflowGraph(workflow);
  const gn = graph.nodes.get(outputNodeId);
  if (!gn) return [];
  const base = ((gn.node.params as Record<string, unknown>).laneLabel as string) ?? DEFAULT_OUTPUT_GROUP;
  return gn.inEdges.map((edge) => ({
    laneId: laneIdFor(outputNodeId, edge),
    laneLabel: laneLabelFor(graph, base, gn.inEdges.length, edge),
    group: base,
    fromNode: edge.fromNode,
  }));
}

/** True iff this segment's render CACHE holds, for some structural Output lane, an audio path that the
 *  track does not carry yet (lane missing, or deposited at a DIFFERENT path — paths are run-unique, so a
 *  path difference IS a newer render). This is the settle watcher's "something landed that never
 *  deposited" signal: a re-render of an already-deposited lane keeps the OLD lane in place (the
 *  reconciler's KEEP branch — non-loading), so the watcher cannot rely on loading placeholders alone;
 *  without this check, closing the editor mid-re-render silently stranded the finished render in the
 *  cache (the track kept playing the previous version until the editor was reopened). Pure + cheap:
 *  reads graph structure and the cache map, decodes nothing. */
export function hasUndepositedCache(
  segmentId: string,
  workflow: Workflow | undefined,
  outs: ProcessedOutput[] | undefined,
): boolean {
  if (!workflow) return false;
  // Cheap pre-gate: no session render cache ⇒ nothing can be undeposited (skips the graph parse for
  // the many cold segments the settle watcher iterates over).
  const cache = useWorkflowStore.getState().nodeOutputs[segmentId];
  if (!cache || Object.keys(cache).length === 0) return false;
  let graph: ReturnType<typeof parseWorkflowGraph>;
  try { graph = parseWorkflowGraph(workflow); } catch { return false; }
  const deposited = new Map((outs ?? []).filter((o) => !o.loading).map((o) => [o.laneId, o.audioPath] as const));
  for (const outId of graph.outputNodeIds) {
    const { paths } = collectCachedPaths(segmentId, outId, workflow);
    for (const p of paths) {
      // A path whose decode has permanently failed (dead cache file) counts as deposited — otherwise
      // the settle watcher re-arms forever on a file that will never load (see cacheDecodeFailures).
      if (deposited.get(p.laneId) !== p.audioPath && !decodeGivenUp(segmentId, p.audioPath)) return true;
    }
  }
  return false;
}

/** All Output-group names in use across the project (every segment's persisted Output nodes), plus any
 *  `extra` (e.g. the calling node's not-yet-saved current value). The dropdown's option list — the group
 *  "registry" IS this union (per the project decision 先并集): a group exists by being assigned; there is
 *  no separate persisted list to migrate or drift. */
export function collectGroupNames(tracks: Track[], extra: string[] = []): string[] {
  const names = new Set<string>([DEFAULT_OUTPUT_GROUP, ...extra.filter(Boolean)]);
  for (const t of tracks) {
    for (const seg of t.segments) {
      for (const n of seg.workflow?.nodes ?? []) {
        if (n.nodeType !== "output") continue;
        const g = n.params?.laneLabel;
        if (typeof g === "string" && g) names.add(g);
      }
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export interface DetachPlan {
  oldNodeId: string;
  /** One new single-edge Output node per inbound edge of the old node. */
  newNodes: { id: string; group: string; position: { x: number; y: number }; edge: { fromNode: string; fromPort: number } }[];
  /** Deposited-lane rewrite: old laneId (under the old node) → the new node's identity. */
  mapping: { oldLaneId: string; newLaneId: string; newNodeId: string; group: string; laneLabel: string }[];
}

/**
 * Plan an "ungroup" (解组): split a multi-input Output node into one single-edge Output node per inbound
 * edge. What splits is the 组 — the CO-OPERATION unit (lanes sharing one Output node: co-selected,
 * co-sliced, shared settings). The 轨道组 NAME is deliberately KEPT: every new node inherits the old
 * node's group name, so the lanes stay in "Main" with their exact display labels ("Main · vocals");
 * only the shared-node linkage is broken. PURE — computes the graph delta + the deposited-lane rewrite;
 * the caller applies it to the editor graph (so it lands in the node-graph undo stack) and to the project
 * store (laneOps/laneControls inheritance rides in `applyLaneDetach`). Null when < 2 inbound edges.
 */
export function planDetachGroup(workflow: Workflow, outputNodeId: string): DetachPlan | null {
  let graph: ReturnType<typeof parseWorkflowGraph>;
  try { graph = parseWorkflowGraph(workflow); } catch { return null; }
  const gn = graph.nodes.get(outputNodeId);
  if (!gn || gn.inEdges.length < 2) return null;
  const base = ((gn.node.params as Record<string, unknown>).laneLabel as string) ?? DEFAULT_OUTPUT_GROUP;
  const pos = gn.node.position;
  const newNodes: DetachPlan["newNodes"] = [];
  const mapping: DetachPlan["mapping"] = [];
  gn.inEdges.forEach((edge, i) => {
    const id = `audioOutput-${crypto.randomUUID().slice(0, 8)}`;
    newNodes.push({ id, group: base, position: { x: pos.x + i * 40, y: pos.y + i * 96 }, edge });
    mapping.push({
      oldLaneId: laneIdFor(outputNodeId, edge),
      newLaneId: laneIdFor(id, edge),
      newNodeId: id,
      group: base,
      // Single-edge label via the SAME formula deposits use (a stem-labeled feeder keeps its suffix →
      // the display is IDENTICAL to before the ungroup), so the reconciler's KEEP branch matches without
      // a re-deposit. Two no-stem lanes both labeled bare "Main" de-collide at display time (getLanes).
      laneLabel: laneLabelFor(graph, base, 1, edge),
    });
  });
  return { oldNodeId: outputNodeId, newNodes, mapping };
}

/**
 * Rebuild the RUNTIME render cache + node badges for a segment from its PERSISTED processedOutputs. The
 * workflow store (nodeOutputs / nodeStatuses) is runtime-only and cold after a project load/autoload, but
 * the rendered audio is KEPT (each deposited lane carries its audioPath). Without this, on reopening a
 * loaded project the render nodes show idle and — worse — deleting an Output edge and reconnecting it
 * finds a cold cache and re-runs a full separation of audio that already exists. This reconstructs, per
 * deposited lane, the DIRECT feeder node's output path at its port (so collectCachedPaths re-finds it →
 * reconnect re-deposits from cache, no re-run) and marks every node UPSTREAM of a deposited lane
 * "completed" (the deposit proves they all ran). Idempotent + non-destructive: no-op if the cache is
 * already warm, and it only writes runtime overlays (never processedOutputs / never the undo doc).
 */
export function rehydrateRenderState(
  segmentId: string,
  segment: { workflow?: Workflow; processedOutputs?: ProcessedOutput[] },
): void {
  const wf = segment.workflow;
  const outs = (segment.processedOutputs ?? []).filter(
    (o) => !o.loading && o.outputNodeId && o.audioPath && !o.audioPath.startsWith("__pending"),
  );
  if (!wf || outs.length === 0) return;
  const store = useWorkflowStore.getState();
  const warm = store.nodeOutputs[segmentId];
  if (warm && Object.keys(warm).length > 0) return; // already warm (live / just-run) — don't clobber

  let graph: ReturnType<typeof parseWorkflowGraph>;
  try {
    graph = parseWorkflowGraph(wf);
  } catch {
    return; // incomplete/invalid graph (no input/output/cycle) — nothing to safely rehydrate
  }

  const byLaneId = new Map(outs.map((o) => [o.laneId, o] as const));
  const nodeOutputs: Record<string, string[]> = {};
  const outputIds = new Set<string>();

  for (const outId of new Set(outs.map((o) => o.outputNodeId as string))) {
    const gn = graph.nodes.get(outId);
    if (!gn) continue;
    for (const edge of gn.inEdges) {
      const po = byLaneId.get(laneIdFor(outId, edge)); // laneId is ALWAYS `${out}::${fromNode}:${fromPort}`
      if (!po) continue;
      (nodeOutputs[edge.fromNode] ??= [])[edge.fromPort] = po.audioPath; // index = port, matches collectCachedPaths
      outputIds.add(outId);
    }
  }
  if (Object.keys(nodeOutputs).length === 0) return;
  // Mark "completed" ONLY the nodes whose output we ACTUALLY warmed (the deposited lanes' DIRECT feeders)
  // plus the Output nodes — so a green badge always means "cache-backed / reusable". A deeper ancestor in a
  // chain (separation → transpose → output) is NOT warmable (only the deposited lane's direct-feeder audio is
  // persisted), so greening it would be a badge no cache backs — and single-running a downstream node would
  // still re-run it. This also matches the user's rationale ("we kept the separation RESULT" = the deposited
  // lane = the direct feeder). The common input→separation→output graph still greens the separation node,
  // since it IS the direct feeder. (Excludes the input node too — a real run never sets its status.)
  store.hydrateRenderState(segmentId, nodeOutputs, [...Object.keys(nodeOutputs), ...outputIds]);
}
