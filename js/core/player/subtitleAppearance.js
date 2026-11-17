// Android SubtitleStyleSettings font, background roundness and drop shadow.
export const SUBTITLE_FONT_DEFAULT = "default";
export const SUBTITLE_FONT_SERIF = "serif";
export const SUBTITLE_FONT_MONO = "mono";
export const SUBTITLE_BUILT_IN_FONTS = [
  SUBTITLE_FONT_DEFAULT,
  SUBTITLE_FONT_SERIF,
  SUBTITLE_FONT_MONO
];
export const SUBTITLE_BACKGROUND_RADIUS_MAX = 24;
export const SUBTITLE_BACKGROUND_RADIUS_STEP = 2;
export const SUBTITLE_SHADOW_OPACITY_DEFAULT = 75;
export const SUBTITLE_SHADOW_SIZE_MIN = 1;
export const SUBTITLE_SHADOW_SIZE_MAX = 8;
export const SUBTITLE_SHADOW_SIZE_DEFAULT = 2;
export const SUBTITLE_OUTLINE_SIZE_MIN = 1;
export const SUBTITLE_OUTLINE_SIZE_MAX = 8;
export const SUBTITLE_OUTLINE_SIZE_DEFAULT = 2;
export const SUBTITLE_LINE_SPACING_MIN = 50;
export const SUBTITLE_LINE_SPACING_MAX = 150;
export const SUBTITLE_LINE_SPACING_STEP = 5;
export const SUBTITLE_LINE_SPACING_DEFAULT = 100;
// Android StyledSubtitle: sizes are in units of a 24sp base text.
export const SUBTITLE_BASE_TEXT_UNITS = 24;

function intInRange(value, min, max, fallback) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function intInSteppedRange(value, min, max, step, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || value === null || value === "") {
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, Math.round(number)));
  return min + Math.round((clamped - min) / step) * step;
}

export function normalizeSubtitleFontId(value) {
  const id = String(value || "").trim();
  return SUBTITLE_BUILT_IN_FONTS.includes(id) ? id : SUBTITLE_FONT_DEFAULT;
}

export function normalizeSubtitleAppearance(style = {}) {
  return {
    fontId: normalizeSubtitleFontId(style.fontId),
    backgroundRadius: intInRange(style.backgroundRadius, 0, SUBTITLE_BACKGROUND_RADIUS_MAX, 0),
    shadowEnabled: style.shadowEnabled === true,
    shadowOpacity: intInRange(style.shadowOpacity, 0, 100, SUBTITLE_SHADOW_OPACITY_DEFAULT),
    shadowSize: intInRange(
      style.shadowSize,
      SUBTITLE_SHADOW_SIZE_MIN,
      SUBTITLE_SHADOW_SIZE_MAX,
      SUBTITLE_SHADOW_SIZE_DEFAULT
    ),
    outlineSize: intInRange(
      style.outlineSize,
      SUBTITLE_OUTLINE_SIZE_MIN,
      SUBTITLE_OUTLINE_SIZE_MAX,
      SUBTITLE_OUTLINE_SIZE_DEFAULT
    ),
    lineSpacing: intInSteppedRange(
      style.lineSpacing,
      SUBTITLE_LINE_SPACING_MIN,
      SUBTITLE_LINE_SPACING_MAX,
      SUBTITLE_LINE_SPACING_STEP,
      SUBTITLE_LINE_SPACING_DEFAULT
    )
  };
}

/** CSS font stack for a subtitle font; null keeps the renderer's own default stack. */
export function subtitleFontFamilyCss(fontId) {
  switch (normalizeSubtitleFontId(fontId)) {
    case SUBTITLE_FONT_SERIF:
      return 'Georgia, "Times New Roman", serif';
    case SUBTITLE_FONT_MONO:
      return '"Courier New", monospace';
    default:
      return null;
  }
}

/** Android drop shadow: black at the shadow opacity, offset by the size, blurred by twice it. */
export function subtitleDropShadowCss(style = {}) {
  const appearance = normalizeSubtitleAppearance(style);
  if (!appearance.shadowEnabled) {
    return "none";
  }
  const size = appearance.shadowSize / SUBTITLE_BASE_TEXT_UNITS;
  const alpha = Math.round(appearance.shadowOpacity) / 100;
  return `${size.toFixed(4)}em ${size.toFixed(4)}em ${(size * 2).toFixed(4)}em rgba(0, 0, 0, ${alpha})`;
}

/** CSS text-shadow for subtitle outline; crisp 8-way offsets for webOS/em, blur for Tizen/browser. */
export function subtitleOutlineShadowCss(
  style = {},
  { outlineColor = "#000000", crisp = false, unit = "px" } = {}
) {
  if (!style?.outlineEnabled) {
    return "";
  }
  const size = normalizeSubtitleAppearance(style).outlineSize;
  if (!crisp) {
    return `0 0 ${size}px ${outlineColor}, 0 0 ${size * 2}px ${outlineColor}`;
  }
  const offset = unit === "em" ? `${(size / SUBTITLE_BASE_TEXT_UNITS).toFixed(4)}em` : `${size}px`;
  return [
    `-${offset} -${offset} 0 ${outlineColor}`,
    `0 -${offset} 0 ${outlineColor}`,
    `${offset} -${offset} 0 ${outlineColor}`,
    `-${offset} 0 0 ${outlineColor}`,
    `${offset} 0 0 ${outlineColor}`,
    `-${offset} ${offset} 0 ${outlineColor}`,
    `0 ${offset} 0 ${outlineColor}`,
    `${offset} ${offset} 0 ${outlineColor}`
  ].join(", ");
}

/** CSS line-height, flex gap, and vertical line padding for HTML subtitles. */
export function subtitleLineSpacingMetrics(
  style = {},
  { isWebOs = false, blockBackground = false } = {}
) {
  const percent = normalizeSubtitleAppearance(style).lineSpacing;
  const baseLineHeight = isWebOs ? 1.2 : 1.28;
  const baseGapEm = isWebOs || blockBackground ? 0 : 0.18;
  const basePaddingBlockEm = isWebOs || blockBackground ? 0 : 0.06;

  let lineHeight = baseLineHeight;
  let gapEm = baseGapEm;
  let paddingBlockEm = basePaddingBlockEm;

  if (percent < SUBTITLE_LINE_SPACING_DEFAULT) {
    const t =
      (percent - SUBTITLE_LINE_SPACING_MIN) /
      (SUBTITLE_LINE_SPACING_DEFAULT - SUBTITLE_LINE_SPACING_MIN);
    const minLineHeight = 1.05;
    lineHeight = minLineHeight + (baseLineHeight - minLineHeight) * t;
    gapEm = baseGapEm * t;
    paddingBlockEm = basePaddingBlockEm * t;
  } else if (percent > SUBTITLE_LINE_SPACING_DEFAULT) {
    const t =
      (percent - SUBTITLE_LINE_SPACING_DEFAULT) /
      (SUBTITLE_LINE_SPACING_MAX - SUBTITLE_LINE_SPACING_DEFAULT);
    const maxLineHeight = 1.9;
    lineHeight = baseLineHeight + (maxLineHeight - baseLineHeight) * t;
    gapEm = baseGapEm * (1 + t);
  }

  const formatNum = (n) => String(Number(n.toFixed(4)));
  return {
    lineHeight: formatNum(lineHeight),
    gap: `${formatNum(gapEm)}em`,
    paddingBlock: `${formatNum(paddingBlockEm)}em`
  };
}

/** Background corner radius in em of the subtitle text. */
export function subtitleBackgroundRadiusCss(style = {}) {
  const radius = normalizeSubtitleAppearance(style).backgroundRadius / SUBTITLE_BASE_TEXT_UNITS;
  return `${radius.toFixed(4)}em`;
}

/** The appearance defaults Android "Reset Appearance" restores, besides the colors and size. */
export const SUBTITLE_APPEARANCE_DEFAULTS = Object.freeze({
  fontId: SUBTITLE_FONT_DEFAULT,
  backgroundRadius: 0,
  shadowEnabled: false,
  shadowOpacity: SUBTITLE_SHADOW_OPACITY_DEFAULT,
  shadowSize: SUBTITLE_SHADOW_SIZE_DEFAULT,
  outlineSize: SUBTITLE_OUTLINE_SIZE_DEFAULT,
  lineSpacing: SUBTITLE_LINE_SPACING_DEFAULT
});

/** Whether a #RRGGBB / #RRGGBBAA background color draws anything. */
export function hasVisibleSubtitleBackground(color = "") {
  const value = String(color || "").trim();
  if (!value || value.toLowerCase() === "transparent") {
    return false;
  }
  const hex = value.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (hex) {
    return hex[2] == null || parseInt(hex[2], 16) > 0;
  }
  const rgba = value.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/i);
  return rgba ? Number(rgba[1]) > 0 : true;
}

/** "#RRGGBB" or "#RRGGBBAA" split into its color and an opacity in percent. */
export function splitSubtitleBackground(value = "") {
  const hex = String(value || "")
    .trim()
    .toUpperCase();
  if (!/^#[0-9A-F]{6}([0-9A-F]{2})?$/.test(hex)) {
    return { color: "#000000", opacity: 0 };
  }
  const alpha = hex.length === 9 ? parseInt(hex.slice(7), 16) : 255;
  return { color: hex.slice(0, 7), opacity: Math.round((alpha / 255) * 100) };
}

export function joinSubtitleBackground(color = "#000000", opacity = 0) {
  const alpha = Math.round((Math.min(100, Math.max(0, Number(opacity) || 0)) / 100) * 255);
  return `${String(color).slice(0, 7).toUpperCase()}${alpha.toString(16).padStart(2, "0").toUpperCase()}`;
}

// Android SubtitleBackgroundColorPresets and SUBTITLE_BACKGROUND_DEFAULT_OPACITY.
export const SUBTITLE_BACKGROUND_COLOR_PRESETS = [
  "#000000",
  "#3A3A3A",
  "#FFFFFF",
  "#FFD700",
  "#1E3A8A"
];
export const SUBTITLE_BACKGROUND_DEFAULT_OPACITY = 75;

/** Android subtitleBackgroundColorFor: a new background color keeps the opacity, or 75% when it had none. */
export function subtitleBackgroundColorFor(color, currentBackground) {
  const { opacity } = splitSubtitleBackground(currentBackground);
  return joinSubtitleBackground(color, opacity > 0 ? opacity : SUBTITLE_BACKGROUND_DEFAULT_OPACITY);
}
