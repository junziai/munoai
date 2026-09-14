import { useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useMsstModelStore } from "../../store/msst-models";
import { useAppStore } from "../../store/app";
import { MSST_CATALOG, ALL_CATEGORIES, CATEGORY_LABELS, CATEGORY_COLORS, t18 } from "../../lib/models/msst-catalog";
import { OUTPUT_NODE_COLOR } from "../../lib/constants";
import i18n from "../../i18n";
import "./NodePalette.css";

interface Props {
  onAddNode: (type: string, label: string, extraParams?: Record<string, unknown>) => void;
  onDropNode?: (type: string, label: string, clientX: number, clientY: number, extraParams?: Record<string, unknown>) => void;
}

/** One draggable/clickable palette entry — THE single source of node definitions, shared by the
 *  left sidebar (grouped) and the canvas right-click menu (flat), so the two can never drift. */
export interface PaletteNodeDef {
  type: string;
  label: string;
  icon: string;
  color: string;
  extraParams?: Record<string, unknown>;
}

export interface PaletteGroup {
  /** i18n key for the sidebar category title (workflow.catVoice / catEffects / catSeparation / catIO). */
  categoryKey: string;
  nodes: PaletteNodeDef[];
}

/** The full palette in sidebar order. Separation entries are filtered to INSTALLED models (a
 *  separation node is unusable without its weights on disk). Callers pass their own `lang`. */

/** The full palette in sidebar order, grouped into 4 categories. Callers pass their own lang. */
export function getPaletteDefs(lang: string, installedFiles: Set<string>): PaletteGroup[] {
  const availableCategories = ALL_CATEGORIES.filter((cat) =>
    MSST_CATALOG.some((e) => e.category === cat && installedFiles.has(e.filename)),
  );
  return [
    // ─────────────── 🎚 效果 / 音频处理 ───────────────
    {
      categoryKey: "workflow.catEffects",
      nodes: [
        { type: "transpose",  label: "Signalsmith",icon: "🎛", color: "#fbbf24" },
        { type: "speedShift", label: "变速",       icon: "⏱", color: "#06b6d4" },
      ],
    },
    // ─────────────── 🎵 AI / 智能 ───────────────
    {
      categoryKey: "workflow.catAI",
      nodes: [
        { type: "rvc",         label: "RVC 换声",     icon: "🗣", color: "#39c5bb" },
        { type: "sovits",      label: "SoVITS 换声",  icon: "🎤", color: "#8b5cf6" },
        { type: "chordDetect", label: "和弦识别",     icon: "🎼", color: "#a78bfa" },
        { type: "autoArrange", label: "AI 自动编曲",  icon: "🥁", color: "#ec4899" },
        { type: "melodyGen",   label: "AI 旋律",      icon: "🎵", color: "#10b981" },
        { type: "harmonizer",  label: "和声层",       icon: "🎶", color: "#06b6d4" },
        { type: "deepOriginal",label: "⚡深度原创",    icon: "✨", color: "#f59e0b" },
      ],
    },
    // ─────────────── 🔊 音频分离 ───────────────
    {
      categoryKey: "workflow.catSeparation",
      nodes: [
        ...availableCategories.map((cat) => ({
          type: "separation",
          label: t18(CATEGORY_LABELS[cat], lang),
          icon: t18(CATEGORY_LABELS[cat], lang).charAt(0),
          color: CATEGORY_COLORS[cat],
          extraParams: { category: cat },
        })),
        { type: "amtMidi", label: "AMT 转谱", icon: "♪", color: "#a855f7" },
      ],
    },
    // ─────────────── 🎹 MIDI / 输入 ───────────────
    {
      categoryKey: "workflow.catMidi",
      nodes: [
        { type: "audioInput",   label: "Audio In",      icon: "🎵", color: "#60a5fa" },
        { type: "midiFileIn",   label: "MIDI File In",  icon: "🎹", color: "#c084fc" },
        { type: "chordBlockIn", label: "Chord Block",   icon: "🎼", color: "#facc15" },
      ],
    },
    // ─────────────── 📤 输出 ───────────────
    {
      categoryKey: "workflow.catIO",
      nodes: [
        { type: "audioOutput", label: i18n.t("workflow.nodeOutput"), icon: "📤", color: OUTPUT_NODE_COLOR },
      ],
    },
  ];
}


export function NodePalette({ onAddNode, onDropNode }: Props) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const installed = useMsstModelStore((s) => s.installed);
  const installedFiles = new Set(installed.map((m) => m.filename));
  const toggleModelManager = useAppStore((s) => s.toggleModelManager);
  const groups = getPaletteDefs(lang, installedFiles);

  const dragRef = useRef<{ type: string; label: string; extraParams?: Record<string, unknown> } | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current || !ghostRef.current) return;
      ghostRef.current.style.left = `${e.clientX - 40}px`;
      ghostRef.current.style.top = `${e.clientY - 12}px`;
    };
    const onUp = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const { type, label, extraParams } = dragRef.current;
      dragRef.current = null;
      if (ghostRef.current) {
        ghostRef.current.remove();
        ghostRef.current = null;
      }
      document.body.style.cursor = "";
      if (onDropNode) {
        onDropNode(type, label, e.clientX, e.clientY, extraParams);
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [onDropNode]);

  const startDrag = useCallback((e: React.MouseEvent, type: string, label: string, extraParams?: Record<string, unknown>) => {
    e.preventDefault();
    dragRef.current = { type, label, extraParams };
    document.body.style.cursor = "grabbing";
    const ghost = document.createElement("div");
    ghost.className = "palette-drag-ghost";
    ghost.textContent = label;
    ghost.style.left = `${e.clientX - 40}px`;
    ghost.style.top = `${e.clientY - 12}px`;
    document.body.appendChild(ghost);
    ghostRef.current = ghost;
  }, []);

  return (
    <aside className="node-palette">
      <div className="palette-title">{t("workflow.nodes")}</div>

      {groups.map((g) => (
        <div key={g.categoryKey} className="palette-category">
          <div className="palette-category-title">{t(g.categoryKey)}</div>
          {g.nodes.map((n) => (
            <PaletteItem
              key={`${n.type}-${n.label}`}
              type={n.type}
              label={n.label}
              icon={n.icon}
              color={n.color}
              extraParams={n.extraParams}
              onAdd={onAddNode}
              onDrag={startDrag}
            />
          ))}
          {g.categoryKey === "workflow.catSeparation" && g.nodes.length === 0 && (
            <span className="palette-empty">
              {t18({ zh: "未安装分离模型", en: "No separation models", ja: "分離モデル未インストール" }, lang)}
            </span>
          )}
          {g.categoryKey === "workflow.catSeparation" && (
            <button className="palette-manage-btn" onClick={toggleModelManager}>
              {t18({ zh: "管理模型...", en: "Manage models...", ja: "モデル管理..." }, lang)}
            </button>
          )}
        </div>
      ))}
    </aside>
  );
}

interface PaletteItemProps {
  type: string;
  label: string;
  icon: string;
  color: string;
  extraParams?: Record<string, unknown>;
  onAdd: (type: string, label: string, extraParams?: Record<string, unknown>) => void;
  onDrag: (e: React.MouseEvent, type: string, label: string, extraParams?: Record<string, unknown>) => void;
}

function PaletteItem({ type, label, icon, color, extraParams, onAdd, onDrag }: PaletteItemProps) {
  return (
    <div
      className="palette-node"
      role="button"
      tabIndex={0}
      onClick={() => onAdd(type, label, extraParams)}
      onMouseDown={(e) => { if (e.button === 0) onDrag(e, type, label, extraParams); }}
      style={{ "--node-color": color } as React.CSSProperties}
    >
      <span className="palette-node-icon">[{icon}]</span>
      <span className="palette-node-label">{label}</span>
    </div>
  );
}
