import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../store/project";
import { useAppStore } from "../../store/app";
import { useHistoryStore } from "../../store/history";
import { fitTimelineToContent } from "../../lib/timeline/fitView";
import { newProjectFile, openProjectFromPath, restoreAutosave } from "../../lib/project/projectFile";
import { readAutosave, clearAutosave, setRecoveryPending, markAutosaveBaseline } from "../../lib/project/autosave";
import { getRecentProjects, removeRecentProject, updateRecentProjectName, type RecentProject } from "../../lib/project/recentProjects";
import { isTauri } from "../../lib/tauri";
import "./Wizard.css";

interface Props { onClose: () => void; }

interface AutosaveEntry {
  filePath: string | null;
  name: string;
  savedAt: number;
  dirty: boolean;
  handled?: boolean;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  project: RecentProject | null;
}

function fmtDate(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

/**
 * 启动欢迎页：左边是新建区域，右边是历史记录/保存的工程
 * 简洁设计，移除示例工程卡片
 */
export function SplashWizard({ onClose }: Props) {
  const { t } = useTranslation();
  const projectName = useProjectStore((s) => s.name);
  const [recent, setRecent] = useState<RecentProject[]>(() => getRecentProjects());
  const [autosave, setAutosave] = useState<AutosaveEntry | null>(null);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, project: null });
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null);
  const [showMore, setShowMore] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // 启动时读 autosave
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const env = await readAutosave();
      if (cancelled || !env) return;
      setAutosave({
        filePath: env.filePath,
        name: env.name || "未命名工程",
        savedAt: env.savedAt,
        dirty: true,
      });
      setRecoveryPending(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // 工程被别处加载时自动关闭
  useEffect(() => {
    const onLoaded = () => { setRecoveryPending(false); onClose(); };
    window.addEventListener("utai:project-loaded", onLoaded);
    return () => { window.removeEventListener("utai:project-loaded", onLoaded); };
  }, [onClose]);

  // 点击外部关闭右键菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu({ visible: false, x: 0, y: 0, project: null });
      }
    };
    if (contextMenu.visible) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [contextMenu.visible]);

  /** 新建空白工程，直接进入主界面 */
  const pickBlank = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const s = useProjectStore.getState();
      const isAlreadyEmpty = (!s.name || s.name === "Untitled") && s.tracks.length === 0 && !s.dirty;
      if (isAlreadyEmpty) {
        useAppStore.getState().clearSelection();
        useHistoryStore.getState().reset();
        useHistoryStore.getState().markSaved();
        fitTimelineToContent();
        if (isTauri()) await markAutosaveBaseline();
        setRecoveryPending(false);
        onClose();
      } else {
        if (isTauri()) {
          await newProjectFile();
        }
        // 浏览器环境下直接关闭欢迎页
        setRecoveryPending(false);
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }, [busy, onClose]);

  const openRecent = useCallback(async (p: RecentProject) => {
    if (!isTauri() || busy || openingPath) return;
    setBusy(true);
    setOpeningPath(p.path);
    try {
      const exists = await invoke<boolean>("path_exists", { path: p.path });
      if (!exists) {
        removeRecentProject(p.path);
        setRecent(getRecentProjects());
        useAppStore.getState().showToast(t("splash.recentMissing"), "warning");
        return;
      }
      const ok = await openProjectFromPath(p.path);
      if (ok) { setRecoveryPending(false); onClose(); }
    } finally {
      setOpeningPath(null);
      setBusy(false);
    }
  }, [busy, openingPath, onClose, t]);

  // 右键菜单：删除
  const handleDeleteProject = useCallback((path: string) => {
    removeRecentProject(path);
    setRecent(getRecentProjects());
    setContextMenu({ visible: false, x: 0, y: 0, project: null });
    useAppStore.getState().showToast(t("splash.recentRemoved"), "info");
  }, [t]);

  // 右键菜单：重命名
  const handleRenameProject = useCallback((project: RecentProject) => {
    setRenaming({ path: project.path, name: project.name });
    setContextMenu({ visible: false, x: 0, y: 0, project: null });
  }, []);

  const handleRenameSubmit = useCallback(() => {
    if (!renaming) return;
    const newName = renaming.name.trim();
    if (newName && newName !== renaming.path) {
      updateRecentProjectName(renaming.path, newName);
      setRecent(getRecentProjects());
      useAppStore.getState().showToast(t("splash.renamed"), "success");
    }
    setRenaming(null);
  }, [renaming, t]);

  const handleRenameCancel = useCallback(() => {
    setRenaming(null);
  }, []);

  // 显示右键菜单
  const handleContextMenu = useCallback((e: React.MouseEvent, project: RecentProject) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      project,
    });
  }, []);

  // autosave 恢复
  const recoverAutosave = useCallback(async () => {
    if (!autosave || busy) return;
    setBusy(true);
    try {
      const env = await readAutosave();
      if (!env) { setAutosave(null); setRecoveryPending(false); return; }
      await restoreAutosave(env);
      setAutosave(null);
      setRecoveryPending(false);
      onClose();
    } catch (e) {
      useAppStore.getState().showToast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  }, [autosave, busy, onClose]);

  const discardAutosave = useCallback(async () => {
    if (!autosave || busy) return;
    setBusy(true);
    try {
      await clearAutosave();
      setAutosave(null);
      setRecoveryPending(false);
      useAppStore.getState().showToast(t("splash.autosaveDiscarded"), "info");
    } finally {
      setBusy(false);
    }
  }, [autosave, busy, t]);

  const title = projectName && projectName !== "Untitled"
    ? `${t("splash.titleWithName")} ${projectName}`
    : t("splash.title");

  /** 渲染单个历史工程卡片（避免重复代码） */
  const renderRecentItem = (p: RecentProject) => {
    const isCrashed = autosave?.filePath === p.path;
    return (
      <button
        key={p.path}
        className={`startpage-recent-item ${openingPath === p.path ? "opening" : ""} ${renaming?.path === p.path ? "renaming" : ""} ${isCrashed ? "crashed" : ""}`}
        onClick={() => renaming?.path !== p.path && void openRecent(p)}
        onContextMenu={(e) => handleContextMenu(e, p)}
        disabled={busy}
        title={p.path}
      >
        <span className="startpage-recent-icon">{isCrashed ? "⚠" : "🎼"}</span>
        {renaming?.path === p.path ? (
          <input
            type="text"
            className="startpage-rename-input"
            value={renaming.name}
            onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameSubmit();
              if (e.key === "Escape") handleRenameCancel();
            }}
            onBlur={handleRenameSubmit}
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="startpage-recent-info">
            <span className="startpage-recent-name">
              {p.name}
              {isCrashed && <span className="startpage-recent-crash-badge">意外退出</span>}
            </span>
            <span className="startpage-recent-meta">
              <span>{fmtDate(p.at)}</span>
              <span className="startpage-recent-path">{p.path}</span>
            </span>
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="startpage-backdrop" onClick={(e) => e.preventDefault()}>
      <div className="startpage-wrap">
        {/* 顶部品牌 LOGO 区 */}
        <div className="startpage-brand-header">
          <img className="startpage-brand-logo" src="/logo-user.png" alt="MunoAI" />
          <div className="startpage-brand-name">MunoAI</div>
          <div className="startpage-brand-sep">·</div>
          <div className="startpage-brand-tagline">造乐之地</div>
        </div>

        {/* 左边：新建区域 */}
        <div className="startpage-left">
          <button className="startpage-hero" onClick={() => void pickBlank()} disabled={busy}>
            <div className="startpage-hero-inner">
              <div className="startpage-hero-emoji">🎵</div>
              <div className="startpage-hero-title">{t("splash.createBlank")}</div>
              <div className="startpage-hero-desc">{t("splash.createBlankDesc")}</div>
              <div className="startpage-hero-arrow" aria-hidden>→</div>
            </div>
          </button>

          {/* autosave 恢复卡（如果存在）*/}
          {autosave && (
            <div className="startpage-autosave">
              <div className="startpage-autosave-icon">⚠</div>
              <div className="startpage-autosave-body">
                <div className="startpage-autosave-title">{t("splash.autosaveTitle")}</div>
                <div className="startpage-autosave-meta">
                  {autosave.name} · {fmtDate(autosave.savedAt)}
                </div>
                <div className="startpage-autosave-actions">
                  <button className="startpage-autosave-recover" onClick={() => void recoverAutosave()} disabled={busy}>
                    {t("splash.autosaveRecover")}
                  </button>
                  <button className="startpage-autosave-discard" onClick={() => void discardAutosave()} disabled={busy}>
                    {t("splash.autosaveDiscardBtn")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 右边：历史记录/保存的工程 */}
        <div className="startpage-right">
          <div className="startpage-title">{title}</div>
          <div className="startpage-subtitle">{t("splash.recentProjects")}</div>

          {recent.length === 0 ? (
            <div className="startpage-empty">{t("splash.recentEmpty")}</div>
          ) : (
            <>
              <div className="startpage-recent">
                {recent.slice(0, 4).map((p) => renderRecentItem(p))}
                {recent.length > 4 && (
                  <button
                    className="startpage-recent-more"
                    onClick={() => setShowMore(true)}
                    title={`共 ${recent.length} 个历史工程`}
                  >
                    <span className="startpage-recent-more-num">+{recent.length - 4}</span>
                    <span className="startpage-recent-more-label">查看全部</span>
                  </button>
                )}
              </div>

              {/* 更多历史弹窗 */}
              {showMore && (
                <div className="startpage-modal-mask" onClick={() => setShowMore(false)}>
                  <div className="startpage-modal" onClick={(e) => e.stopPropagation()}>
                    <div className="startpage-modal-header">
                      <div className="startpage-modal-title">历史工程 · 共 {recent.length} 个</div>
                      <button className="startpage-modal-close" onClick={() => setShowMore(false)}>✕</button>
                    </div>
                    <div className="startpage-modal-list">
                      {recent.map((p) => renderRecentItem(p))}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* 右键菜单 */}
      {contextMenu.visible && contextMenu.project && (
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="context-menu-item"
            onClick={() => contextMenu.project && handleRenameProject(contextMenu.project)}
          >
            ✏️ {t("splash.rename")}
          </button>
          <button
            className="context-menu-item danger"
            onClick={() => contextMenu.project && handleDeleteProject(contextMenu.project.path)}
          >
            🗑️ {t("splash.delete")}
          </button>
        </div>
      )}
    </div>
  );
}

