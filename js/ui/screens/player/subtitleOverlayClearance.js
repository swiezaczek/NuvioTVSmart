import { getSubtitleVerticalOffsetVh } from "../../../core/player/subtitleVerticalOffset.js";

// The controls overlay fades out over 200ms (components-30.css). Subtitle clearance has to
// follow the fade, not the logical visibility flag, or subtitles jump while controls are still
// on screen.
export const CONTROLS_HIDE_TRANSITION_MS = 200;

export function keepControlsClearance({
  controlsVisible = false,
  hideUntil = 0,
  now = Date.now()
} = {}) {
  return Boolean(controlsVisible) || Number(now) < Number(hideUntil || 0);
}

const clearanceStates = new WeakMap();

// HTML bottom cues and capable ASS renderers receive selective placement.
// Authored positions and opaque native subtitle planes retain their coordinates.
export function syncHtmlSubtitleClearance(screen, { force = false } = {}) {
  const refs = screen?.uiRefs;
  const root = refs?.root;
  if (!root?.style || typeof root.getBoundingClientRect !== "function") return;
  const controlsClearanceActive = keepControlsClearance({
    controlsVisible: screen.controlsVisible,
    hideUntil: screen.controlsHideUntil
  });
  const modalBlocked = Boolean(refs.controlsOverlay?.classList?.contains?.("modal-blocked"));
  const skipIntroVisible = Boolean(
    refs.skipIntro && !refs.skipIntro.classList?.contains?.("hidden")
  );
  const nextEpisodeVisible = Boolean(
    refs.nextEpisodeCard && !refs.nextEpisodeCard.classList?.contains?.("hidden")
  );
  const seekOverlayActive = Boolean(
    screen.seekOverlayVisible &&
    !screen.controlsVisible &&
    (!refs.seekOverlay || !refs.seekOverlay.classList?.contains?.("hidden"))
  );
  const subtitleDialogVisible = Boolean(screen.subtitleDialogVisible);
  const verticalOffset = getSubtitleVerticalOffsetVh(screen.subtitleStyleSettings?.verticalOffset);
  const playbackBadgesVisible = Boolean(refs.playbackBadges && !refs.playbackBadges.hidden);
  const chapterTitleVisible = Boolean(
    refs.chapterTitle && !refs.chapterTitle.classList?.contains?.("hidden")
  );
  const seekChapterTitleVisible = Boolean(
    refs.seekChapterTitle && !refs.seekChapterTitle.classList?.contains?.("hidden")
  );
  const progressFocused = Boolean(refs.progressShell?.classList?.contains?.("focused"));
  const rootWidth = Math.max(
    0,
    Math.round(Number(globalThis.window?.innerWidth || root.clientWidth || 0))
  );
  const rootHeight = Math.max(
    0,
    Math.round(Number(globalThis.window?.innerHeight || root.clientHeight || 0))
  );
  const assRenderer = screen.assSubtitleRenderer || null;

  const layoutKey = [
    controlsClearanceActive ? 1 : 0,
    screen.controlsVisible ? 1 : 0,
    modalBlocked ? 1 : 0,
    skipIntroVisible ? 1 : 0,
    nextEpisodeVisible ? 1 : 0,
    seekOverlayActive ? 1 : 0,
    subtitleDialogVisible ? 1 : 0,
    playbackBadgesVisible ? 1 : 0,
    chapterTitleVisible ? 1 : 0,
    seekChapterTitleVisible ? 1 : 0,
    progressFocused ? 1 : 0,
    verticalOffset,
    rootWidth,
    rootHeight
  ].join("|");

  const cached = clearanceStates.get(screen);
  if (!force && cached && cached.root === root && cached.layoutKey === layoutKey) {
    if (assRenderer && cached.assRenderer !== assRenderer && cached.placement) {
      cached.assRenderer = assRenderer;
      assRenderer.setPlacement?.(cached.placement);
    }
    return;
  }

  const viewport = root.getBoundingClientRect();
  if (!(viewport.height > 0)) return;
  const gap = (viewport.height * 8) / 540;
  let clearance = 0;
  const include = (node, enabled) => {
    if (
      subtitleDialogVisible ||
      !enabled ||
      !node ||
      node.classList.contains("hidden") ||
      !node.getClientRects().length
    )
      return;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return;
    const rect = node.getBoundingClientRect();
    if (rect.height > 0) clearance = Math.max(clearance, viewport.bottom - rect.top + gap);
  };
  include(refs.controlsBottom, controlsClearanceActive && !modalBlocked);
  include(refs.skipIntro, true);
  include(refs.nextEpisodeCard, true);
  include(refs.seekOverlay, screen.seekOverlayVisible && !screen.controlsVisible);
  const bottom = (viewport.height * (8 - verticalOffset)) / 100;
  const lift = Math.max(0, Math.min(viewport.height / 2, clearance) - bottom);
  const value = `${Math.round(lift)}px`;
  if (root.style.getPropertyValue("--player-subtitle-clearance") !== value)
    root.style.setProperty("--player-subtitle-clearance", value);
  const placement = {
    viewportBottom: viewport.bottom,
    overlayTop: clearance > 0 ? viewport.bottom - Math.min(viewport.height / 2, clearance) : null,
    userOffsetPx: -(viewport.height * verticalOffset) / 100
  };
  clearanceStates.set(screen, { root, layoutKey, assRenderer, placement });
  assRenderer?.setPlacement?.(placement);
}
