import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../store/app";
import { useProjectStore } from "../../store/project";
import { useHistoryStore } from "../../store/history";
import { useMsstModelStore } from "../../store/msst-models";
import { useVoiceModelStore } from "../../store/voice-models";
import { useAmtModelStore } from "../../store/amt-models";
import { MSST_CATALOG, t18 } from "../../lib/models/msst-catalog";
import { AUDIO_EXTENSIONS } from "../../lib/constants";
import { importAudioToNewTrack } from "../../lib/audio/import";
import { flushAutosaveNow } from "../../lib/project/autosave";
import {
  buildWorkflow,
  templateNeedsSeparation,
  templateNeedsVoiceModel,
  type WizardTemplateId,
} from "../../lib/workflow/templates";
import "./SuperOriginalWizard.css";

/**
 * §user「超级原创」一键向导：选歌 → 选模板 →（自动建轨 + 挂载即运行）。
 *
 * 向导本身绝不旁路执行引擎 —— 它只做三件事：
 *   1. importAudioToNewTrack 建轨导入（复用导入的全部解码/错误处理）；
 *   2. 把模板 Workflow（lib/workflow/templates.ts 纯数据）写进新片段；
 *   3. openWorkflow + workflowAutoRun 标志 → WorkflowEditor 挂载后走它自己的
 *      handleExecute（preflight 缺失组件弹窗、进度、取消、轨道沉积全部复用）。
 * 组件检查在向导内前置（分离模型 / 声音模型 / 转谱后端），缺什么就地提示并给
 * 「打开模型管理」入口，绝不把用户丢进一个必然失败的运行。
 */

interface TemplateCard {
  id: WizardTemplateId;
  icon: string;
  title: { zh: string; en: string; ja: string };
  desc: { zh: string; en: string; ja: string };
}

const TEMPLATE_CARDS: TemplateCard[] = [
  {
    id: "transcribe",
    icon: "🎼",
    title: { zh: "一键扒带", en: "One-Click Transcribe", ja: "ワンクリック採譜" },
    desc: {
      zh: "整首歌转成多乐器 MIDI（钢琴/吉他/贝斯/鼓…），之后可换音源、修复、任意改编。",
      en: "Turn the whole song into multi-instrument MIDI, then swap sounds, repair, and rearrange freely.",
      ja: "楽曲全体をマルチ楽器 MIDI へ。音源交換・修復・アレンジ自由。",
    },
  },
  {
    id: "clone",
    icon: "🎤",
    title: { zh: "声音复刻", en: "Voice Clone", ja: "ボイス復刻" },
    desc: {
      zh: "分离人声与伴奏，人声用你的声音模型重新演唱，伴奏原样保留。",
      en: "Separate vocals from backing, re-sing the vocals with your voice model, keep the backing as-is.",
      ja: "ボーカルと伴奏を分離し、ボーカルをあなたの声モデルで歌い直す。",
    },
  },
  {
    id: "original",
    icon: "✨",
    title: { zh: "深度原创", en: "Deep Original", ja: "完全オリジナル" },
    desc: {
      zh: "复刻 + 伴奏移调 + 同步扒带 —— 声音换了、调性变了、音源可换，改完就是你的原创。",
      en: "Clone + transposed backing + parallel transcription — new voice, new key, swappable sounds.",
      ja: "復刻＋伴奏移調＋並行採譜。声も調性も新しくオリジナルに。",
    },
  },
];

export function SuperOriginalWizard({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;

  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [template, setTemplate] = useState<WizardTemplateId>("original");
  const [voiceName, setVoiceName] = useState("");
  const [semitones, setSemitones] = useState(2);
  const [busy, setBusy] = useState(false);

  const msstInstalled = useMsstModelStore((s) => s.installed);
  const voiceModels = useVoiceModelStore((s) => s.models.rvc);
  const amtInstalled = useAmtModelStore((s) => s.installed);
  const toggleModelManager = useAppStore((s) => s.toggleModelManager);

  // 拉取三个模型库的最新状态（可能本会话还没被任何页面触发过）。
  useEffect(() => {
    void useMsstModelStore.getState().fetchInstalled();
    void useVoiceModelStore.getState().fetchModels();
    void useAmtModelStore.getState().fetchInstalled();
  }, []);

  // Esc 关闭（忙时不关）——与 ExportAudioDialog 相同的捕获模式。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);

  /** 最佳人声分离模型：已安装的 vocals 类里按 SDR 分数挑第一。 */
  const sepModel = useMemo(() => {
    const files = new Set(msstInstalled.map((m) => m.filename));
    const cands = MSST_CATALOG.filter((e) => e.category === "vocals" && files.has(e.filename));
    if (cands.length === 0) return null;
    cands.sort((a, b) => (b.sdrScore ?? -1) - (a.sdrScore ?? -1));
    const cat = cands[0]!;
    const inst = msstInstalled.find((m) => m.filename === cat.filename);
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    const stems = inst?.stem_names?.length
      ? [...inst.stem_names, ...(inst.residual_name ? [inst.residual_name] : [])].map(cap)
      : cat.stems;
    return { filename: cat.filename, displayName: t18(cat.name, lang), stems };
  }, [msstInstalled, lang]);

  /** 最佳转谱后端：MuScriptor > MIROS > YourMT3+（按已安装可用性降级）。 */
  const amtBackend = useMemo(() => {
    const has = (id: string) => amtInstalled.some((m) => m.id === id && m.is_available);
    if (has("muscriptor_large") || has("muscriptor_small")) return "muscriptor";
    if (has("mc13_256_all_cross_v6")) return "miros";
    if (has("yptf_moe_multi_nops")) return "yourmt3";
    return null;
  }, [amtInstalled]);

  // 声音模型默认选第一个（列表刷新/删除后保持合法选择）。
  useEffect(() => {
    if (voiceModels.length > 0 && !voiceModels.some((m) => m.name === voiceName)) {
      setVoiceName(voiceModels[0]!.name);
    }
  }, [voiceModels, voiceName]);

  const needsVoice = templateNeedsVoiceModel(template);
  const needsSep = templateNeedsSeparation(template);

  const missingPieces: string[] = [];
  if (!amtBackend) missingPieces.push(t("wizard.missingAmt"));
  if (needsSep && !sepModel) missingPieces.push(t("wizard.missingSep"));
  if (needsVoice && voiceModels.length === 0) missingPieces.push(t("wizard.missingVoice"));

  const canStart = !!audioPath && missingPieces.length === 0 && !busy && (!needsVoice || !!voiceName);

  const pickAudio = async () => {
    const path = await open({
      multiple: false,
      title: t("wizard.pickSong"),
      filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
    });
    if (typeof path === "string" && path) setAudioPath(path);
  };

  const start = async () => {
    if (!canStart || !audioPath) return;
    setBusy(true);
    try {
      // 1) 建轨导入（tick 0，与「+」导入一致；解码/失败提示由 import.ts 全权负责）。
      const { trackId, segId } = await importAudioToNewTrack(audioPath, 0);
      const track = useProjectStore.getState().tracks.find((tr) => tr.id === trackId);
      if (!track || !track.segments.some((s) => s.id === segId)) return; // 解码失败已被 toast，占位已清

      // 2) 模板工作流写进新片段（系统级设置，静默入历史 —— 与导入的 loading→loaded 同规则）。
      const vm = voiceModels.find((m) => m.name === voiceName);
      const wf = buildWorkflow(template, {
        vocalStemNames: sepModel?.stems,
        separationModelFile: sepModel?.filename,
        voiceModel: vm ? { name: vm.name, path: vm.path } : undefined,
        transposeSemitones: semitones,
        amtBackend: amtBackend ?? "muscriptor",
      });
      useHistoryStore.getState().runSilent(() =>
        useProjectStore.getState().updateTrack(trackId, {
          segments: track.segments.map((s) => (s.id === segId ? { ...s, workflow: wf } : s)),
        }),
      );
      flushAutosaveNow(); // 建轨+建图是一个里程碑，立即落盘

      // 3) 打开工作流编辑器并请求挂载即运行（进度/取消/缺失组件弹窗全在编辑器侧）。
      useAppStore.getState().openWorkflow(segId);
      useAppStore.setState({ workflowAutoRun: segId });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const fileName = audioPath ? audioPath.split(/[/\\]/).pop()! : "";

  return (
    <div className="confirm-overlay sow-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="confirm-dialog sow-dialog">
        <div className="confirm-title">{t("wizard.title")}</div>
        <div className="sow-subtitle">{t("wizard.subtitle")}</div>

        {/* ── 第 1 步：选歌 ─────────────────────────────────────────── */}
        <section className="sow-step">
          <div className="sow-step-head">
            <span className="sow-step-num">1</span>
            <span>{t("wizard.stepSong")}</span>
          </div>
          <button type="button" className={`sow-file-btn${audioPath ? " has-file" : ""}`} onClick={() => void pickAudio()}>
            <span className="sow-file-icon">{audioPath ? "🎵" : "📂"}</span>
            <span className="sow-file-text">{audioPath ? fileName : t("wizard.pickSongHint")}</span>
          </button>
        </section>

        {/* ── 第 2 步：选模板 ───────────────────────────────────────── */}
        <section className="sow-step">
          <div className="sow-step-head">
            <span className="sow-step-num">2</span>
            <span>{t("wizard.stepTemplate")}</span>
          </div>
          <div className="sow-cards">
            {TEMPLATE_CARDS.map((c) => (
              <button
                type="button"
                key={c.id}
                className={`sow-card${template === c.id ? " active" : ""}`}
                onClick={() => setTemplate(c.id)}
              >
                <span className="sow-card-icon">{c.icon}</span>
                <span className="sow-card-title">{t18(c.title, lang)}</span>
                <span className="sow-card-desc">{t18(c.desc, lang)}</span>
              </button>
            ))}
          </div>

          {/* 模板相关选项：声音模型（复刻/原创）与移调（原创） */}
          {needsVoice && (
            <div className="sow-opt">
              <label className="sow-opt-label">{t("wizard.voiceModel")}</label>
              <select
                className="sow-select"
                value={voiceName}
                onChange={(e) => setVoiceName(e.target.value)}
                disabled={voiceModels.length === 0}
              >
                {voiceModels.length === 0 ? (
                  <option value="">{t("wizard.noVoiceModel")}</option>
                ) : (
                  voiceModels.map((m) => (
                    <option key={m.name} value={m.name}>{m.name}</option>
                  ))
                )}
              </select>
            </div>
          )}
          {template === "original" && (
            <div className="sow-opt">
              <label className="sow-opt-label">{t("wizard.transpose")}</label>
              <div className="sow-semi-row">
                {[-3, -2, -1, 1, 2, 3].map((s) => (
                  <button
                    type="button"
                    key={s}
                    className={`sow-semi${semitones === s ? " active" : ""}`}
                    onClick={() => setSemitones(s)}
                  >
                    {s > 0 ? `+${s}` : s}
                  </button>
                ))}
              </div>
              <div className="sow-opt-hint">{t("wizard.transposeHint")}</div>
            </div>
          )}
        </section>

        {/* ── 组件就绪状态 ──────────────────────────────────────────── */}
        {missingPieces.length > 0 ? (
          <div className="sow-missing">
            <div className="sow-missing-title">{t("wizard.missingTitle")}</div>
            <ul>
              {missingPieces.map((m) => <li key={m}>{m}</li>)}
            </ul>
            <button type="button" className="sow-link-btn" onClick={toggleModelManager}>
              {t("wizard.openModelManager")}
            </button>
          </div>
        ) : (
          <div className="sow-ready">
            ✓ {t("wizard.ready", { model: sepModel && needsSep ? sepModel.displayName : "" })}
          </div>
        )}

        {/* ── 第 3 步：开始 ─────────────────────────────────────────── */}
        <div className="sow-actions">
          <button type="button" className="sow-btn" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="sow-btn primary"
            onClick={() => void start()}
            disabled={!canStart}
          >
            {busy ? t("wizard.starting") : `🚀 ${t("wizard.start")}`}
          </button>
        </div>
        <div className="sow-footnote">{t("wizard.footnote")}</div>
      </div>
    </div>
  );
}
