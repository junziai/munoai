import { useState, useCallback, useRef, useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useProjectStore } from "../../store/project";
import { useAppStore } from "../../store/app";
import { useSoundfontStore } from "../../store/soundfont";
import { useHistoryStore } from "../../store/history";
import { useVoiceModelStore } from "../../store/voice-models";
import { useRecording } from "../../lib/audio/recorder";
import { VOCAL_LANGUAGES, langById } from "../../lib/vocal/languages";
import { VolumeFader, formatDb, formatPan } from "../common/VolumeFader";
import { analyzeTrackChords, detectTrackDrums } from "../../lib/analysis/trackAnalysisActions";
import { ArrangeDialog } from "./ArrangeDialog";
import { ChordMidiDialog } from "./ChordMidiDialog";
import { AmtConversionDialog } from "../models/AmtConversionDialog";
import { setFxBusConfig, getFxBusConfig } from "../../lib/audio/effectsBus";
import { trackTypeCssVar } from "../../lib/trackColors";
import "./TrackInspectorPanel.css";

/** Studio Pro 风格底部 docked Inspector 面板 — 1:1 复刻 v2
 *  改动: 插入按钮弹 popover、底部 tab = tracks.length (有几个显示几个)、
 *        顶部 edge 可拖拽调整面板高度、记住高度到 localStorage
 */
const PLUGIN_CATALOG = [
  { id: "eq",         name: "EQ 均衡器",   icon: "🎚️" },
  { id: "compressor", name: "压缩器",      icon: "📦" },
  { id: "reverb",     name: "混响",        icon: "🌊" },
  { id: "delay",      name: "延迟",        icon: "⏱️" },
  { id: "chorus",     name: "合唱",        icon: "🎭" },
  { id: "limiter",    name: "限制器",      icon: "🔒" },
];

const loadInspectorHeight = () => {
  try { return parseInt(localStorage.getItem("utai.inspectorHeight") || "280", 10) || 280; }
  catch { return 280; }
};

/** ───────────────────────────────────────────────────
 *  Global FX Bus Panel — 全局效果总线 (可折叠).
 *  所有轨道共享同一套 Reverb / Delay 效果器, 用 Sends 旋钮控制每轨送多少进去.
 *  参数调完立刻生效 (实时 AudioContext + OfflineAudioContext 一致).
 * ─────────────────────────────────────────────────── */
function GlobalFxBusPanel() {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState(() => getFxBusConfig());

  const update = (patch: Partial<typeof cfg>) => {
    const next = { ...cfg, ...patch };
    setFxBusConfig(next);   // 同步到音频引擎 (playback + export 都读同一份)
    setCfg(next);            // UI 即时反映
  };

  return (
    <div className={`inspector-fxbus ${open ? "inspector-fxbus-open" : ""}`}>
      <button
        className="inspector-fxbus-head"
        onClick={() => setOpen((o) => !o)}
        title="全局混响/延迟总线 (所有轨道共享)"
      >
        <span className="inspector-fxbus-title">🌐 全局 FX 总线</span>
        <span className="inspector-fxbus-summary">
          Reverb {Math.round(cfg.reverbWet * 100)}% · Delay {cfg.delayTimeSec.toFixed(2)}s
        </span>
        <span className="inspector-fxbus-arrow">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="inspector-fxbus-body">
          {/* 混响 */}
          <div className="inspector-fx-group">
            <span className="inspector-fx-group-title">🌊 Reverb</span>
            <div className="inspector-fx-sliders">
              <label className="inspector-fx-label">
                <span>Wet</span>
                <input type="range" min={0} max={1} step={0.02}
                  value={cfg.reverbWet}
                  onChange={(e) => update({ reverbWet: +e.target.value })} />
                <span className="inspector-fx-val">{Math.round(cfg.reverbWet * 100)}%</span>
              </label>
            </div>
          </div>
          {/* 延迟 */}
          <div className="inspector-fx-group">
            <span className="inspector-fx-group-title">⏱ Delay</span>
            <div className="inspector-fx-sliders">
              <label className="inspector-fx-label">
                <span>Time</span>
                <input type="range" min={0.02} max={1.5} step={0.01}
                  value={cfg.delayTimeSec}
                  onChange={(e) => update({ delayTimeSec: +e.target.value })} />
                <span className="inspector-fx-val">{cfg.delayTimeSec.toFixed(2)}s</span>
              </label>
              <label className="inspector-fx-label">
                <span>Feedback</span>
                <input type="range" min={0} max={0.95} step={0.02}
                  value={cfg.delayFeedback}
                  onChange={(e) => update({ delayFeedback: +e.target.value })} />
                <span className="inspector-fx-val">{Math.round(cfg.delayFeedback * 100)}%</span>
              </label>
              <label className="inspector-fx-label">
                <span>Wet</span>
                <input type="range" min={0} max={1} step={0.02}
                  value={cfg.delayWet}
                  onChange={(e) => update({ delayWet: +e.target.value })} />
                <span className="inspector-fx-val">{Math.round(cfg.delayWet * 100)}%</span>
              </label>
            </div>
          </div>
          {/* 预设 */}
          <div className="inspector-fx-presets">
            <span style={{ fontSize: 10, color: "var(--text-muted)", marginRight: 4 }}>预设:</span>
            {[
              { name: "🎤 人声",   reverbWet: 0.7,  delayWet: 0.4, delayTimeSec: 0.35, delayFeedback: 0.3 },
              { name: "🎸 吉他",   reverbWet: 0.5,  delayWet: 0.6, delayTimeSec: 0.427, delayFeedback: 0.42 },
              { name: "🥁 鼓",    reverbWet: 0.3,  delayWet: 0.0, delayTimeSec: 0.25, delayFeedback: 0.2 },
              { name: "🎹 钢琴",   reverbWet: 0.85, delayWet: 0.5, delayTimeSec: 0.5, delayFeedback: 0.35 },
              { name: "🌌 氛围",   reverbWet: 0.95, delayWet: 0.8, delayTimeSec: 0.8, delayFeedback: 0.6 },
              { name: "🔇 干净",   reverbWet: 0.1,  delayWet: 0.0, delayTimeSec: 0.25, delayFeedback: 0.0 },
            ].map((p) => (
              <button key={p.name}
                className="inspector-fx-preset-btn"
                onClick={() => update(p)}
                type="button"
                title={`${p.name}: Reverb ${Math.round(p.reverbWet*100)}% / Delay ${p.delayTimeSec.toFixed(2)}s`}
              >{p.name}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function TrackInspectorPanel() {
  const tracks = useProjectStore((s) => s.tracks);
  const inspectorTrackId = useAppStore((s) => s.inspectorTrackId);
  const closeInspector = useAppStore((s) => s.closeInspector);
  const openInspector = useAppStore((s) => s.openInspector);
  const updateTrack = useProjectStore((s) => s.updateTrack);
  const setTrackSoundfont = useProjectStore((s) => s.setTrackSoundfont);
  const refreshFonts = useSoundfontStore((s) => s.refresh);
  const fonts = useSoundfontStore((s) => s.fonts);
  // 录音态 + 歌手/语言 (从轨道头移入参数面板)
  const recording = useRecording((s) => (inspectorTrackId ? s.recordingTrackId === inspectorTrackId : false));
  const voiceModels = useVoiceModelStore((s) => s.models);
  const setVocalParams = useProjectStore((s) => s.setVocalParams);
  const [insertOpen, setInsertOpen] = useState(false);
  const [activeSlot, setActiveSlot] = useState(0);
  // —— AI 弹窗 state ——
  const [arrangeOpen, setArrangeOpen] = useState(false);
  const [chordMidiOpen, setChordMidiOpen] = useState(false);
  const [amtOpen, setAmtOpen] = useState(false);
  const [panelHeight, setPanelHeight] = useState(loadInspectorHeight);
  const dockRef = useRef<HTMLElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const targetHRef = useRef(panelHeight);
  const rafRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHRef = useRef(0);
  const activePointerIdRef = useRef<number | null>(null);

  // Keep DOM in sync with ref during normal (non-drag) renders
  useEffect(() => { targetHRef.current = panelHeight; }, [panelHeight]);

  // Lazily refresh soundfonts ONCE when they're empty. Must be in useEffect, NOT render body —
  // calling zustand setters during render triggers React's "Cannot update while rendering" error.
  useEffect(() => {
    if (fonts.length === 0) refreshFonts().catch(() => {});
  }, [fonts.length, refreshFonts]);

  const track = tracks.find((t) => t.id === inspectorTrackId) ?? null;
  if (!track) return null;

  const currentFont = track.soundfont
    ? fonts.find((f) => f.id === track.soundfont?.fontId)
    : null;

  // 插件槽位数据：从 Track.pluginSlots 读（新字段），默认 6 个空槽
  const plugins = track.pluginSlots ?? Array(6).fill(null);

  const updatePlugins = (slots: (string | null)[]) => {
    useHistoryStore.getState().beginTransaction();
    updateTrack(track.id, { pluginSlots: slots });
    useHistoryStore.getState().commitTransaction();
  };

  const onInsertPlugin = (pluginId: string) => {
    const next = [...plugins];
    next[activeSlot] = pluginId;
    updatePlugins(next);
    setInsertOpen(false);
  };

  const onClearSlot = (slotIdx: number) => {
    const next = [...plugins];
    next[slotIdx] = null;
    updatePlugins(next);
  };

  const updateVolume = useCallback((v: number) => {
    useHistoryStore.getState().beginTransaction();
    updateTrack(track.id, { volumeDb: v });
    useHistoryStore.getState().commitTransaction();
  }, [track.id, updateTrack]);

  const updatePan = useCallback((v: number) => {
    useHistoryStore.getState().beginTransaction();
    updateTrack(track.id, { pan: v });
    useHistoryStore.getState().commitTransaction();
  }, [track.id, updateTrack]);

  const toggleMute = () => {
    useHistoryStore.getState().beginTransaction();
    updateTrack(track.id, { muted: !track.muted });
    useHistoryStore.getState().commitTransaction();
  };
  const toggleSolo = () => {
    useHistoryStore.getState().beginTransaction();
    updateTrack(track.id, { solo: !track.solo });
    useHistoryStore.getState().commitTransaction();
  };

  const onFontChange = (fontId: string) => {
    const font = fonts.find((f) => f.id === fontId);
    if (!font) { setTrackSoundfont(track.id, undefined); return; }
    const firstPreset = font.presets[0];
    useHistoryStore.getState().beginTransaction();
    setTrackSoundfont(track.id, {
      fontId: font.id,
      presetId: firstPreset?.id ?? "0:0",
      presetName: firstPreset?.name ?? font.name,
    });
    useHistoryStore.getState().commitTransaction();
  };

  const panDeg = -90 * (1 - track.pan);

  // ── Height resize drag — Pointer Events + rAF direct DOM write ──
  // 关键点: mousemove 只更新 ref, rAF 里直接写 dock.style.height,
  // 全程不触发 React re-render, 只在 pointerup 时 commit 到 state.
  const flushRaf = useCallback(() => {
    if (!rafRef.current) return;
    rafRef.current = null;
    const dock = dockRef.current;
    if (dock) dock.style.height = `${targetHRef.current}px`;
  }, []);

  const onResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const el = handleRef.current;
    if (el && el.setPointerCapture) {
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    activePointerIdRef.current = e.pointerId;
    draggingRef.current = true;
    startYRef.current = e.clientY;
    startHRef.current = targetHRef.current;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    document.body.style.touchAction = "none";
    el?.classList.add("is-dragging");

    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      if (activePointerIdRef.current !== null && ev.pointerId !== activePointerIdRef.current) return;
      const dy = startYRef.current - ev.clientY;
      const next = Math.max(180, Math.min(560, startHRef.current + dy));
      targetHRef.current = next;
      if (!rafRef.current) rafRef.current = requestAnimationFrame(flushRaf);
    };

    const finish = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      activePointerIdRef.current = null;
      // Cancel any pending rAF and commit last value
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      flushRaf();
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.body.style.touchAction = "";
      handleRef.current?.classList.remove("is-dragging");
      // Persist to localStorage + commit state (only ONCE at end)
      const final = Math.round(targetHRef.current);
      localStorage.setItem("utai.inspectorHeight", String(final));
      setPanelHeight((prev) => (prev !== final ? final : prev));
    };

    const onUp = (ev: PointerEvent) => {
      if (activePointerIdRef.current !== null && ev.pointerId !== activePointerIdRef.current) return;
      const el2 = handleRef.current;
      if (el2 && el2.releasePointerCapture) {
        try { el2.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      }
      finish();
    };

    const onCancel = () => finish();

    // pointer capture ensures we get move/up even when pointer leaves the handle
    el?.addEventListener("pointermove", onMove);
    el?.addEventListener("pointerup", onUp);
    el?.addEventListener("pointercancel", onCancel);
    // Also bind on window as safety net (capture already handles it, but belt-and-suspenders)
    window.addEventListener("pointerup", finish);
    window.addEventListener("blur", finish);

    // Cleanup is tied to pointerup/cancel — but also protect against unmount mid-drag
    (handleRef.current as any & { __cleanupResize?: () => void }).__cleanupResize = () => {
      el?.removeEventListener("pointermove", onMove);
      el?.removeEventListener("pointerup", onUp);
      el?.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("blur", finish);
    };
  }, [flushRaf]);

  // Close insert popover when clicking outside
  useEffect(() => {
    if (!insertOpen) return;
    const onDocClick = () => setInsertOpen(false);
    const t = setTimeout(() => document.addEventListener("click", onDocClick), 0);
    return () => { clearTimeout(t); document.removeEventListener("click", onDocClick); };
  }, [insertOpen]);

  return (
    <aside
      ref={dockRef}
      className="inspector-dock"
      role="dialog"
      aria-label="轨道属性"
      style={{ height: panelHeight }}
    >
      {/* ── RESIZE HANDLE (top edge) — Pointer Events + setPointerCapture ── */}
      <div
        ref={handleRef}
        className="inspector-resize-handle"
        onPointerDown={onResizePointerDown}
        title="拖动调整高度"
      />

      {/* ── HEADER ── */}
      <div className="inspector-header">
        <button className="inspector-close" onClick={closeInspector} title="关闭">✕</button>
        <span className="inspector-track-name" title={track.name}>{track.name}</span>
        <span className="inspector-db-readout">{formatDb(track.volumeDb, -60)}</span>
        <div className="inspector-state-btns">
          <button
            className={`inspector-state-btn ${track.muted ? "active-mute" : ""}`}
            onClick={toggleMute}
            title="Mute"
          >M</button>
          <button
            className={`inspector-state-btn ${track.solo ? "active-solo" : ""}`}
            onClick={toggleSolo}
            title="Solo"
          >S</button>
        </div>
        <div className="inspector-header-spacer" />

        {/* —— AI 快捷按钮组（跟随当前轨道类型智能启用 —— */}
        {track && (() => {
          const isAudio = track.trackType === "audio";
          const hasNotes = (track.trackType === "instrument" || track.trackType === "vocal") &&
            track.segments.some((s) => s.content.type === "notes" && s.content.notes.length > 0);
          const audioPath = (track.segments.find((s) => s.content.type === "audioClip")?.content as { sourcePath?: string } | undefined)?.sourcePath;
          const amtOk = isAudio && !!audioPath;
          const arrOk = hasNotes;
          const chordOk = hasNotes;
          const chordDetectOk = hasNotes || amtOk;
          const drumsOk = amtOk;
          const btn = (ok: boolean, label: string, tip: string, onClick?: () => void) => (
            <button
              className={`inspector-ai-btn${ok ? "" : " disabled"}`}
              disabled={!ok}
              title={tip}
              onClick={ok ? onClick : undefined}
            >{label}</button>
          );
          return (
            <div className="inspector-ai-group" onClick={(e) => e.stopPropagation()}>
              {btn(amtOk, "🎵AMT", amtOk ? "AI 转谱 (音频 → MIDI)" : "需要带音频文件的音频轨", () => setAmtOpen(true))}
              {btn(arrOk, "✨编曲", arrOk ? "AI 自动编曲 (鼓/贝斯/钢琴/铺底)" : "需要有音符的旋律/乐器轨", () => setArrangeOpen(true))}
              {btn(chordOk, "🎹和弦MIDI", chordOk ? "AI 生成和弦轨" : "需要有音符的旋律/乐器轨", () => setChordMidiOpen(true))}
              {btn(chordDetectOk, "🎼识别和弦", chordDetectOk ? "AI 识别和弦 (写入和弦轨)" : "需要音符轨或音频轨", () => analyzeTrackChords(track.id))}
              {btn(drumsOk, "🥁识别鼓点", drumsOk ? "AI 识别鼓点" : "需要带音频文件的音频轨", async () => { if (audioPath) { await detectTrackDrums(track.id, audioPath); useAppStore.getState().showToast("鼓点识别完成", "success"); } })}
            </div>
          );
        })()}

        {/* Insert plugin button — with popover menu */}
        <div className="inspector-insert-wrap" onClick={(e) => e.stopPropagation()}>
          <button
            className="inspector-insert-btn"
            onClick={() => setInsertOpen((o) => !o)}
            title={`插入到槽位 ${activeSlot + 1}`}
          >
            插入 ▼ +
          </button>
          {insertOpen && (
            <div className="inspector-insert-menu">
              <div className="inspector-insert-menu-title">
                插入到槽位 {activeSlot + 1}（{plugins[activeSlot] ? PLUGIN_CATALOG.find(p => p.id === plugins[activeSlot])?.name : "空"}）
              </div>
              {PLUGIN_CATALOG.map((p) => (
                <button
                  key={p.id}
                  className="inspector-insert-item"
                  onClick={() => onInsertPlugin(p.id)}
                >
                  <span className="inspector-insert-item-icon">{p.icon}</span>
                  <span>{p.name}</span>
                </button>
              ))}
              {plugins[activeSlot] && (
                <button
                  className="inspector-insert-item inspector-insert-clear"
                  onClick={() => onClearSlot(activeSlot)}
                >
                  🗑️ 清除此槽位
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── INPUT ROUTE ROW ── */}
      <div className="inspector-input-row">
        <span className="inspector-input-label">输入</span>
        <select className="inspector-input-select" defaultValue="stereo">
          <option value="stereo">L+R 立体声</option>
          <option value="mono">单声道</option>
          <option value="bus">总线</option>
          <option value="sidechain">侧链</option>
        </select>
        <div className="inspector-input-knob" />
        <span>▼</span>
      </div>

      {/* ── 录音 + 歌手/语言 (vocal 轨) —— 从轨道头移入参数面板 ── */}
      <div className="inspector-rec-row">
        <button
          className={`inspector-rec-btn ${recording ? "recording" : ""}`}
          onClick={() => { void useRecording.getState().toggle(track.id); }}
          title={recording ? "停止录音" : "开始在此轨道录音"}
        >
          {recording ? "■ 停止录音" : "● 录音"}
        </button>
        {track.trackType === "vocal" && (() => {
          const singers = [...voiceModels.sovits, ...voiceModels.rvc];
          const currentSinger = singers.find((s) => s.name === track.voiceModel) ?? null;
          return (
            <>
              <select
                className="inspector-input-select"
                value={track.voiceModel ?? ""}
                onChange={(e) => {
                  const m = singers.find((s) => s.name === e.target.value);
                  useHistoryStore.getState().beginTransaction();
                  updateTrack(track.id, {
                    voiceModel: m?.name,
                    voiceModelAvatar: m?.avatar_path ? convertFileSrc(m.avatar_path) : undefined,
                  });
                  useHistoryStore.getState().commitTransaction();
                }}
                title="选择歌手模型"
              >
                <option value="">🎤 选择歌手…</option>
                {singers.map((m) => (
                  <option key={`${m.model_type}-${m.path}`} value={m.name}>{m.name}</option>
                ))}
              </select>
              {currentSinger?.avatar_path && (
                <img
                  className="inspector-singer-avatar"
                  src={convertFileSrc(currentSinger.avatar_path)}
                  alt={currentSinger.name}
                  title={currentSinger.name}
                />
              )}
              <select
                className="inspector-input-select inspector-lang-select"
                value={track.vocalParams?.langId ?? 0}
                onChange={(e) => setVocalParams(track.id, { langId: +e.target.value })}
                title={`发音语言: ${langById(track.vocalParams?.langId ?? 0).code.toUpperCase()}`}
              >
                {VOCAL_LANGUAGES.map((l) => (
                  <option key={l.id} value={l.id}>{l.short} — {l.code}</option>
                ))}
              </select>
            </>
          );
        })()}
      </div>

      {/* ── MAIN AREA ── */}
      <div className="inspector-main">
        {/* VU METER */}
        <div className="inspector-vu-group">
          <span className="inspector-vu-label">主输出</span>
          <div style={{ position: "relative", display: "flex", gap: "20px" }}>
            <div className="inspector-vu-scale">
              <span>0</span><span>-6</span><span>-12</span><span>-18</span><span>-24</span>
            </div>
            <div className="inspector-vu-meter">
              <div
                className="inspector-vu-fill"
                style={{ height: `${Math.max(0, Math.min(100, (track.volumeDb + 60) * 1.67))}%` }}
              />
            </div>
          </div>
        </div>

        {/* PAN KNOB */}
        <div className="inspector-pan-group">
          <span className="inspector-pan-label">平衡</span>
          <div className="inspector-pan-knob" onClick={() => updatePan(0)} title="点击居中">
            <div
              className="inspector-pan-indicator"
              style={{ transform: `translateX(-50%) rotate(${panDeg}deg)` }}
            />
          </div>
          <span className="inspector-pan-value">{formatPan(track.pan)}</span>
        </div>

        {/* VOLUME FADER */}
        <div className="inspector-volume-group">
          <span className="inspector-volume-label">音量</span>
          <div style={{ width: 40, height: 100, position: "relative" }}>
            <VolumeFader
              value={track.volumeDb}
              min={-60}
              max={6}
              orientation="vertical"
              width={24}
              height={100}
              onChange={updateVolume}
              onGestureStart={() => useHistoryStore.getState().beginTransaction()}
              onGestureEnd={() => useHistoryStore.getState().commitTransaction()}
            />
          </div>
          <span className="inspector-volume-db">{formatDb(track.volumeDb, -60)}</span>
        </div>

        {/* RIGHT SIDE: 6 插件槽位 (always 6 per track — Studio Pro standard) + 音源 */}
        <div className="inspector-plugins-area">
          <div className="inspector-plugin-insert-row">
            {plugins.map((pluginId, i) => {
              const p = pluginId ? PLUGIN_CATALOG.find((pc) => pc.id === pluginId) : null;
              return (
                <div
                  key={i}
                  className={`inspector-plugin-slot ${activeSlot === i ? "inspector-plugin-slot-active" : ""}`}
                  onClick={() => setActiveSlot(i)}
                  title={p ? p.name : `槽位 ${i + 1}（空）`}
                >
                  {p ? (
                    <span>
                      {p.icon} {p.name}
                      <button
                        className="inspector-plugin-clear"
                        onClick={(e) => { e.stopPropagation(); onClearSlot(i); }}
                        title="移除"
                      >×</button>
                    </span>
                  ) : (
                    <span style={{ color: "var(--text-tertiary, #666)" }}>（空 {i + 1}）</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Soundfont selector (instrument tracks only) */}
          {track.trackType === "instrument" && (
            <div className="inspector-soundfont-group">
              <span className="inspector-soundfont-label">🎹 音源</span>
              <select
                className="inspector-soundfont-select"
                value={track.soundfont?.fontId ?? ""}
                onChange={(e) => onFontChange(e.target.value)}
              >
                <option value="">— 默认合成 —</option>
                {fonts.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} ({f.format.toUpperCase()})
                  </option>
                ))}
              </select>
              {currentFont && currentFont.presets.length > 1 && (
                <select
                  className="inspector-soundfont-select"
                  value={track.soundfont?.presetId ?? ""}
                  onChange={(e) => {
                    if (!track.soundfont) return;
                    const preset = currentFont.presets.find((p) => p.id === e.target.value);
                    useHistoryStore.getState().beginTransaction();
                    setTrackSoundfont(track.id, {
                      ...track.soundfont,
                      presetId: e.target.value,
                      presetName: preset?.name ?? e.target.value,
                    });
                    useHistoryStore.getState().commitTransaction();
                  }}
                >
                  {currentFont.presets.map((p) => (
                    <option key={p.id} value={p.id}>{p.name || p.id}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* ── SENDS: 每轨独立 Reverb / Delay 发送 ── */}
          <div className="inspector-sends-row">
            <span className="inspector-sends-label">🎛 Sends</span>
            <div className="inspector-send-knob" title="Reverb Send — 发到全局混响总线的量">
              <span className="inspector-send-icon">🌊</span>
              <input
                type="range" min={0} max={1} step={0.01}
                value={track.reverbSend ?? 0}
                onChange={(e) => {
                  const v = +e.target.value;
                  useHistoryStore.getState().beginTransaction();
                  updateTrack(track.id, { reverbSend: v });
                  useHistoryStore.getState().commitTransaction();
                }}
              />
              <span className="inspector-send-value">{Math.round((track.reverbSend ?? 0) * 100)}%</span>
              <span className="inspector-send-name">Reverb</span>
            </div>
            <div className="inspector-send-knob" title="Delay Send — 发到全局延迟总线的量">
              <span className="inspector-send-icon">⏱</span>
              <input
                type="range" min={0} max={1} step={0.01}
                value={track.delaySend ?? 0}
                onChange={(e) => {
                  const v = +e.target.value;
                  useHistoryStore.getState().beginTransaction();
                  updateTrack(track.id, { delaySend: v });
                  useHistoryStore.getState().commitTransaction();
                }}
              />
              <span className="inspector-send-value">{Math.round((track.delaySend ?? 0) * 100)}%</span>
              <span className="inspector-send-name">Delay</span>
            </div>
            <button
              className="inspector-sends-reset"
              onClick={() => {
                useHistoryStore.getState().beginTransaction();
                updateTrack(track.id, { reverbSend: 0, delaySend: 0 });
                useHistoryStore.getState().commitTransaction();
              }}
              title="清零所有 Sends"
            >× 清零</button>
          </div>
        </div>
      </div>

      {/* ── 🌐 全局 FX 总线 (折叠面板) ── */}
      <GlobalFxBusPanel />

      {/* ── TRACK SWITCH TABS — 动态: 有几条轨道就显示几个, 颜色跟随轨道类型 ── */}
      <div className="inspector-track-tabs">
        {tracks.map((t, i) => {
          const color = trackTypeCssVar(t.trackType); // 统一走 trackColors（与 TrackList/主题 --track-* 一致）
          const isActive = t.id === inspectorTrackId;
          return (
            <button
              key={t.id}
              className={`inspector-track-tab ${isActive ? "active" : ""}`}
              onClick={() => openInspector(t.id)}
              style={{
                borderColor: isActive ? color : "transparent",
                borderLeftColor: isActive ? color : color,
                borderLeftWidth: isActive ? "4px" : "3px",
              }}
              title={t.name}
            >
              <span style={{ color, fontWeight: 700, marginRight: 4 }}>{i + 1}</span>
              {t.name}
            </button>
          );
        })}
        {tracks.length === 0 && (
          <span style={{ color: "var(--text-tertiary, #666)", fontSize: 11, padding: "4px 10px" }}>
            工程里还没有轨道
          </span>
        )}
      </div>

      {/* —— AI 弹窗（Inspector 按钮触发）—— */}
      {amtOpen && track && <AmtConversionDialog trackId={track.id} onClose={() => setAmtOpen(false)} />}
      {arrangeOpen && track && <ArrangeDialog trackId={track.id} onClose={() => setArrangeOpen(false)} />}
      {chordMidiOpen && track && <ChordMidiDialog trackId={track.id} onClose={() => setChordMidiOpen(false)} />}
    </aside>
  );
}
