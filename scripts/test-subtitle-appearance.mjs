import test from "node:test";
import assert from "node:assert/strict";

import {
  hasVisibleSubtitleBackground,
  normalizeSubtitleAppearance,
  subtitleBackgroundRadiusCss,
  subtitleDropShadowCss,
  subtitleFontFamilyCss,
  subtitleLineSpacingMetrics,
  subtitleOutlineShadowCss
} from "../js/core/player/subtitleAppearance.js";
import { resolveSubtitleStyleControlAvailability } from "../js/core/player/subtitlePresentationCapabilities.js";
import { buildSubtitleAppearancePreviewHtml } from "../js/ui/screens/settings/subtitleAppearanceEditor.js";

test("appearance values are kept in Android's ranges", () => {
  assert.deepEqual(normalizeSubtitleAppearance({}), {
    fontId: "default",
    backgroundRadius: 0,
    shadowEnabled: false,
    shadowOpacity: 75,
    shadowSize: 2,
    outlineSize: 2,
    lineSpacing: 100
  });
  const clamped = normalizeSubtitleAppearance({
    fontId: "custom-x",
    backgroundRadius: 99,
    shadowOpacity: -3,
    shadowSize: 40,
    outlineSize: 0,
    lineSpacing: 12
  });
  assert.equal(clamped.fontId, "default");
  assert.equal(clamped.backgroundRadius, 24);
  assert.equal(clamped.shadowOpacity, 0);
  assert.equal(clamped.shadowSize, 8);
  assert.equal(clamped.outlineSize, 1);
  assert.equal(clamped.lineSpacing, 50);
  assert.equal(normalizeSubtitleAppearance({ outlineSize: 20 }).outlineSize, 8);
  assert.equal(normalizeSubtitleAppearance({ lineSpacing: 97 }).lineSpacing, 95);
  assert.equal(normalizeSubtitleAppearance({ lineSpacing: 98 }).lineSpacing, 100);
  assert.equal(normalizeSubtitleAppearance({ lineSpacing: 220 }).lineSpacing, 150);
});

test("line spacing preserves current defaults at 100% and maps 50%-150% cleanly", () => {
  assert.deepEqual(subtitleLineSpacingMetrics({ lineSpacing: 100 }), {
    lineHeight: "1.28",
    gap: "0.18em",
    paddingBlock: "0.06em"
  });
  assert.deepEqual(subtitleLineSpacingMetrics({ lineSpacing: 100 }, { isWebOs: true }), {
    lineHeight: "1.2",
    gap: "0em",
    paddingBlock: "0em"
  });
  assert.deepEqual(subtitleLineSpacingMetrics({ lineSpacing: 100 }, { blockBackground: true }), {
    lineHeight: "1.28",
    gap: "0em",
    paddingBlock: "0em"
  });
  assert.deepEqual(subtitleLineSpacingMetrics({ lineSpacing: 50 }), {
    lineHeight: "1.05",
    gap: "0em",
    paddingBlock: "0em"
  });
  assert.deepEqual(subtitleLineSpacingMetrics({ lineSpacing: 150 }), {
    lineHeight: "1.9",
    gap: "0.36em",
    paddingBlock: "0.06em"
  });
});

test("outline shadow scales across Tizen/browser blur and webOS/preview crisp offsets", () => {
  assert.equal(subtitleOutlineShadowCss({ outlineEnabled: false, outlineSize: 4 }), "");
  assert.equal(
    subtitleOutlineShadowCss({ outlineEnabled: true, outlineSize: 2 }, { outlineColor: "#000000" }),
    "0 0 2px #000000, 0 0 4px #000000"
  );
  assert.equal(
    subtitleOutlineShadowCss({ outlineEnabled: true, outlineSize: 4 }, { outlineColor: "#112233" }),
    "0 0 4px #112233, 0 0 8px #112233"
  );
  assert.equal(
    subtitleOutlineShadowCss(
      { outlineEnabled: true, outlineSize: 3 },
      { outlineColor: "#000000", crisp: true, unit: "px" }
    ),
    "-3px -3px 0 #000000, 0 -3px 0 #000000, 3px -3px 0 #000000, -3px 0 0 #000000, 3px 0 0 #000000, -3px 3px 0 #000000, 0 3px 0 #000000, 3px 3px 0 #000000"
  );
  assert.match(
    subtitleOutlineShadowCss(
      { outlineEnabled: true, outlineSize: 4 },
      { outlineColor: "#000000", crisp: true, unit: "em" }
    ),
    /^-0\.1667em -0\.1667em 0 #000000/
  );
});

test("the drop shadow is offset by its size and blurred by twice it, in 24-unit text", () => {
  assert.equal(subtitleDropShadowCss({ shadowEnabled: false }), "none");
  assert.equal(
    subtitleDropShadowCss({ shadowEnabled: true, shadowSize: 2, shadowOpacity: 75 }),
    "0.0833em 0.0833em 0.1667em rgba(0, 0, 0, 0.75)"
  );
});

test("roundness, fonts and background visibility", () => {
  assert.equal(subtitleBackgroundRadiusCss({ backgroundRadius: 12 }), "0.5000em");
  assert.equal(subtitleFontFamilyCss("default"), null);
  assert.match(subtitleFontFamilyCss("serif"), /serif$/);
  assert.match(subtitleFontFamilyCss("mono"), /monospace$/);
  assert.equal(hasVisibleSubtitleBackground("#00000000"), false);
  assert.equal(hasVisibleSubtitleBackground("#00000080"), true);
  assert.equal(hasVisibleSubtitleBackground("#000000"), true);
  assert.equal(hasVisibleSubtitleBackground("transparent"), false);
});

test("lineSpacing is disabled for bitmap and native webOS cue renderers, and preview uses two lines", () => {
  assert.equal(resolveSubtitleStyleControlAvailability({ bitmap: true }).lineSpacing, false);
  assert.equal(
    resolveSubtitleStyleControlAvailability({ isWebOsNative: true, rendererMode: "none" })
      .lineSpacing,
    false
  );
  assert.equal(
    resolveSubtitleStyleControlAvailability({ isWebOsNative: true, rendererMode: "html" })
      .lineSpacing,
    true
  );

  const html = buildSubtitleAppearancePreviewHtml(
    { lineSpacing: 140 },
    {
      t: (_key, _params, fallback) => fallback,
      escapeHtml: (value) => String(value)
    }
  );
  assert.match(html, /line-height:1\.776/);
  assert.match(html, /Every story begins with\na little curiosity\./);
});
