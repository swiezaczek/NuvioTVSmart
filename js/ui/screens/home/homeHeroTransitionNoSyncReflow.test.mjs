import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const helpers02Source = await readFile(
  new URL("./homeScreenHelpers-02-extract-release-date-text.js", import.meta.url),
  "utf8"
);
const backdropSwapSource = await readFile(
  new URL("./homeScreenHelpers-03-animate-hero-backdrop-swap.js", import.meta.url),
  "utf8"
);
const logoSwapSource = await readFile(
  new URL("./homeScreenHelpers-04-animate-hero-logo-swap.js", import.meta.url),
  "utf8"
);

const strip = (src) => src.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "");

function createDomMocks() {
  let offsetWidthReads = 0;
  const rafQueue = [];
  const nextRaf = (cb) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  const flushRafs = async () => {
    const batch = rafQueue.splice(0);
    batch.forEach((cb) => cb?.());
    await new Promise((r) => setTimeout(r, 0));
  };

  class FakeElement {
    constructor(tagName = "div") {
      this.tagName = String(tagName).toUpperCase();
      this.attributes = {};
      const tokens = new Set();
      this.classList = {
        add: (...names) => names.forEach((n) => tokens.add(n)),
        remove: (...names) => names.forEach((n) => tokens.delete(n)),
        contains: (n) => tokens.has(n),
        has: (n) => tokens.has(n)
      };
      const props = {};
      const prios = {};
      this.style = {
        getPropertyValue: (name) => props[name] || "",
        getPropertyPriority: (name) => prios[name] || "",
        setProperty: (name, value, prio = "") => {
          props[name] = String(value);
          prios[name] = String(prio || "");
        },
        removeProperty: (name) => {
          delete props[name];
          delete prios[name];
        },
        props,
        prios
      };
      this.children = [];
      this.parentElement = null;
      Object.defineProperty(this, "offsetWidth", {
        get() {
          offsetWidthReads += 1;
          return 1920;
        }
      });
    }
    set className(value) {
      this.classList = this.classList;
      const next = new Set(
        String(value || "")
          .split(/\s+/)
          .filter(Boolean)
      );
      const existing = [
        "home-hero-backdrop",
        "home-hero-backdrop-canvas",
        "home-hero-backdrop-transition-enter",
        "is-visible",
        "home-hero-backdrop-transition-ghost"
      ];
      existing.forEach((n) => this.classList.remove(n));
      next.forEach((n) => this.classList.add(n));
    }
    getAttribute(name) {
      return name in this.attributes ? this.attributes[name] : null;
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
    removeAttribute(name) {
      delete this.attributes[name];
    }
    cloneNode() {
      const clone = new this.constructor(this.tagName);
      Object.assign(clone.attributes, this.attributes);
      return clone;
    }
    getContext() {
      return { drawImage: () => {} };
    }
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
    }
    insertBefore(child, ref) {
      child.parentElement = this;
      this.children.splice(Math.max(0, this.children.indexOf(ref)), 0, child);
    }
    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
        this.parentElement = null;
      }
    }
    querySelectorAll(selector) {
      const ghostsOnly =
        selector === ".home-hero-backdrop-transition-ghost" ||
        selector === ".home-hero-logo-transition-ghost";
      return this.children.filter((node) =>
        ghostsOnly
          ? node.classList.has(selector.slice(1))
          : node.classList.has("home-hero-backdrop-canvas") &&
            !node.classList.has("home-hero-backdrop-transition-ghost")
      );
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
  }
  class FakeImage extends FakeElement {}

  const prepareStart = helpers02Source.indexOf("export function prepareHeroImageEnter");
  const helperCode = strip(helpers02Source.slice(prepareStart));

  const preloadResults = new Map();
  const context = vm.createContext({
    HTMLImageElement: FakeImage,
    HOME_MODERN_HERO_BACKDROP_CROSSFADE_MS: 20,
    document: { createElement: (tag) => new FakeElement(tag) },
    requestAnimationFrame: nextRaf,
    setTimeout,
    clearTimeout,
    preloadHeroBackdrop: async (src) => preloadResults.get(src) || { loaded: true, bitmap: null },
    preloadHeroLogo: async (src) => preloadResults.get(src) || { loaded: true, src },
    shouldRescaleHeroLogo: () => false
  });
  context.globalThis = context;
  vm.runInContext(
    [
      helperCode,
      strip(
        backdropSwapSource.slice(
          backdropSwapSource.indexOf("export function animateHeroBackdropSwap")
        )
      ),
      strip(logoSwapSource.slice(logoSwapSource.indexOf("export function animateHeroLogoSwap")))
    ].join("\n"),
    context
  );

  return {
    FakeElement,
    FakeImage,
    context,
    preloadResults,
    flushRafs,
    getOffsetWidthReads: () => offsetWidthReads
  };
}

test("hero backdrop (<canvas> and <img>) and logo transitions never force synchronous offsetWidth reflow and restore inline transitions cleanly", async () => {
  const { FakeElement, FakeImage, context, preloadResults, flushRafs, getOffsetWidthReads } =
    createDomMocks();

  // 1. Fresh <canvas> backdrop swap
  const wrap = new FakeElement("div");
  const backdrop = new FakeImage("img");
  backdrop.classList.add("home-hero-backdrop");
  backdrop.setAttribute("src", "https://img/old.jpg");
  wrap.appendChild(backdrop);

  preloadResults.set("https://img/canvas.jpg", {
    loaded: true,
    bitmap: { width: 1280, height: 720 }
  });
  context.animateHeroBackdropSwap(backdrop, "https://img/canvas.jpg", "", 20, {
    transitionMode: "single-layer"
  });
  await new Promise((r) => setTimeout(r, 0));
  const canvas = wrap.children.at(-1);
  assert.equal(canvas.tagName, "CANVAS");
  assert.ok(canvas.classList.contains("home-hero-backdrop-transition-enter"));
  assert.equal(
    canvas.classList.contains("is-visible"),
    false,
    "canvas must remain invisible on frame 1"
  );
  await flushRafs();
  assert.equal(
    canvas.classList.contains("is-visible"),
    false,
    "single-layer canvas waits two rAF ticks for enter paint commit"
  );
  await flushRafs();
  assert.equal(canvas.classList.contains("is-visible"), true);

  // 2. Reused <img> backdrop fallback swap preserves caller transition
  backdrop.style.setProperty("transition", "opacity 120ms ease", "");
  preloadResults.set("https://img/fallback.jpg", { loaded: true, bitmap: null });
  context.animateHeroBackdropSwap(backdrop, "https://img/fallback.jpg", "", 20, {
    transitionMode: "crossfade"
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(
    backdrop.style.getPropertyValue("transition"),
    "none",
    "transition suppressed during enter reset"
  );
  assert.equal(backdrop.classList.contains("is-visible"), false);
  await flushRafs();
  assert.equal(backdrop.classList.contains("is-visible"), false);
  await flushRafs();
  assert.equal(backdrop.classList.contains("is-visible"), true);
  assert.equal(backdrop.style.getPropertyValue("transition"), "opacity 120ms ease");

  // 3. Reused logo swap with mid-flight rapid replacement does not overwrite original inline transition with "none"
  const logoWrap = new FakeElement("div");
  const logo = new FakeImage("img");
  logo.style.setProperty("transition", "opacity 150ms linear", "");
  logoWrap.appendChild(logo);

  context.animateHeroLogoSwap(logo, "https://img/logo1.png", "L1", 20, {
    transitionMode: "single-layer"
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(logo.style.getPropertyValue("transition"), "none");
  // Cancel mid-flight by immediately swapping to logo2 while logo is still suppressed
  context.animateHeroLogoSwap(logo, "https://img/logo2.png", "L2", 20, {
    transitionMode: "single-layer"
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(logo.style.getPropertyValue("transition"), "none");
  await flushRafs();
  await flushRafs();
  assert.equal(logo.classList.contains("is-visible"), true);
  assert.equal(
    logo.style.getPropertyValue("transition"),
    "opacity 150ms linear",
    "rapid mid-flight replacement must restore original inline transition rather than 'none'"
  );

  assert.equal(
    getOffsetWidthReads(),
    0,
    "hero transitions must perform 0 synchronous offsetWidth reads"
  );

  // 4. single-layer canvas swap reuses previousCanvas in place without creating/removing a new <canvas>
  let canvasCreates = 0;
  const origCreate = context.document.createElement;
  context.document.createElement = (tag) => {
    if (String(tag).toUpperCase() === "CANVAS") canvasCreates += 1;
    return origCreate(tag);
  };
  const singleWrap = new FakeElement("div");
  const singleBackdrop = new FakeImage("img");
  singleBackdrop.classList.add("home-hero-backdrop");
  singleWrap.appendChild(singleBackdrop);
  preloadResults.set("https://img/s1.jpg", {
    loaded: true,
    bitmap: { width: 1280, height: 720 }
  });
  preloadResults.set("https://img/s2.jpg", {
    loaded: true,
    bitmap: { width: 1920, height: 1080 }
  });
  context.animateHeroBackdropSwap(singleBackdrop, "https://img/s1.jpg", "", 20, {
    transitionMode: "single-layer"
  });
  await new Promise((r) => setTimeout(r, 0));
  await flushRafs();
  await flushRafs();
  assert.equal(canvasCreates, 1);
  const reusedCanvas = singleWrap.children.at(-1);

  context.animateHeroBackdropSwap(singleBackdrop, "https://img/s2.jpg", "", 20, {
    transitionMode: "single-layer"
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(canvasCreates, 1, "single-layer canvas swap must reuse existing canvas in place");
  assert.equal(singleWrap.children.at(-1), reusedCanvas);
  assert.equal(reusedCanvas.width, 1920);
  assert.equal(reusedCanvas.height, 1080);
  await flushRafs();
  await flushRafs();
  assert.equal(reusedCanvas.classList.contains("is-visible"), true);
});
