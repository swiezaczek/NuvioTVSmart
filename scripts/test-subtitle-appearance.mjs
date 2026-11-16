import test from "node:test";
import assert from "node:assert/strict";

import {
  hasVisibleSubtitleBackground,
  normalizeSubtitleAppearance,
  subtitleBackgroundRadiusCss,
  subtitleDropShadowCss,
  subtitleFontFamilyCss,
  subtitleOutlineShadowCss
} from "../js/core/player/subtitleAppearance.js";

test("appearance values are kept in Android's ranges", () => {
  assert.deepEqual(normalizeSubtitleAppearance({}), {
    fontId: "default",
    backgroundRadius: 0,
    shadowEnabled: false,
    shadowOpacity: 75,
    shadowSize: 2,
    outlineSize: 2
  });
  const clamped = normalizeSubtitleAppearance({
    fontId: "custom-x",
    backgroundRadius: 99,
    shadowOpacity: -3,
    shadowSize: 40,
    outlineSize: 0
  });
  assert.equal(clamped.fontId, "default");
  assert.equal(clamped.backgroundRadius, 24);
  assert.equal(clamped.shadowOpacity, 0);
  assert.equal(clamped.shadowSize, 8);
  assert.equal(clamped.outlineSize, 1);
  assert.equal(normalizeSubtitleAppearance({ outlineSize: 20 }).outlineSize, 8);
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
