import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createHomeRowWindow, HOME_ROW_PARKED_CLASS } from "./homeRowWindow.js";

const strip = (source) => source.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "");

const source02 = strip(
  await readFile(
    new URL("./homeScreenMethods-02-restore-modern-focus-state.js", import.meta.url),
    "utf8"
  )
);

function buildHarness({ stiffness = 180, dampingRatio = 0.95 } = {}) {
  let nextRaf = 1;
  let now = 0;
  const scheduledRafs = new Map();
  const context = vm.createContext({
    internals: {
      MODERN_HOME_CONSTANTS: {
        springScrollStiffness: stiffness,
        springScrollDampingRatio: dampingRatio
      },
      findHomeFocusIdentityMatch: () => null,
      MODERN_CAMERA_PAN_EASING: (t) => t
    },
    isModernTvProfile: () => true,
    getTvRuntimePerformanceProfile: () => ({
      isTvRuntime: true,
      isPerformanceConstrained: false,
      isLegacyTvRuntime: false
    }),
    performance: { now: () => now },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (callback) => {
      const id = nextRaf++;
      scheduledRafs.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => {
      scheduledRafs.delete(id);
    },
    WeakMap,
    Set,
    Math,
    Number,
    Array,
    Object,
    String,
    Boolean
  });
  context.globalThis = context;
  vm.runInContext(`${source02}\nglobalThis.api = createHomeScreenMethods02();`, context);

  const screen = Object.assign(Object.create(context.api), {
    shouldUseImmediateFocusScroll: () => false
  });

  const stepFrame = (deltaMs = 16) => {
    now += deltaMs;
    const batch = Array.from(scheduledRafs.entries());
    scheduledRafs.clear();
    batch.forEach(([, cb]) => cb(now));
  };

  return { screen, scheduledRafs, stepFrame };
}

function createTrackedContainer({
  scrollWidth = 4000,
  clientWidth = 1920,
  scrollHeight = 4000,
  clientHeight = 560,
  initialClasses = []
} = {}) {
  const classes = new Set(initialClasses);
  const classEvents = [];
  const xWrites = [];
  const yWrites = [];
  let scrollLeft = 0;
  let scrollTop = 0;
  const container = {
    isConnected: true,
    scrollWidth,
    clientWidth,
    scrollHeight,
    clientHeight,
    classList: {
      add: (name) => {
        classes.add(name);
        classEvents.push(["add", name]);
      },
      remove: (name) => {
        classes.delete(name);
        classEvents.push(["remove", name]);
      },
      contains: (name) => classes.has(name)
    }
  };
  Object.defineProperty(container, "scrollLeft", {
    get: () => scrollLeft,
    set: (value) => {
      const max = Math.max(0, container.scrollWidth - container.clientWidth);
      const next = Math.max(0, Math.min(max, Number(value) || 0));
      xWrites.push(value);
      scrollLeft = next;
    }
  });
  Object.defineProperty(container, "scrollTop", {
    get: () => scrollTop,
    set: (value) => {
      const max = Math.max(0, container.scrollHeight - container.clientHeight);
      const next = Math.max(0, Math.min(max, Number(value) || 0));
      yWrites.push(value);
      scrollTop = next;
    }
  });
  return { container, classes, classEvents, xWrites, yWrites };
}

test("animateSpringScroll writes only changed integer offsets and settles without tail drag", () => {
  const { screen, scheduledRafs, stepFrame } = buildHarness();
  const { container, xWrites } = createTrackedContainer({ initialClasses: ["home-track"] });

  screen.animateSpringScroll(container, "x", 224);
  assert.equal(scheduledRafs.size, 1);
  assert.equal(xWrites.length, 0);

  let frames = 0;
  while (scheduledRafs.size && frames < 120) {
    stepFrame(16);
    frames += 1;
  }

  assert.equal(scheduledRafs.size, 0, "spring must finish scheduling rAF");
  assert.equal(container.scrollLeft, 224);
  assert.ok(frames <= 42, `expected <= 42 frames without tail drag, got ${frames}`);
  assert.ok(xWrites.length > 0 && xWrites.length <= 36, `unexpected write count ${xWrites.length}`);
  for (let i = 0; i < xWrites.length; i += 1) {
    assert.equal(
      Number.isInteger(xWrites[i]),
      true,
      `scrollLeft write #${i} must be integer, got ${xWrites[i]}`
    );
    if (i > 0) {
      assert.notEqual(
        xWrites[i],
        xWrites[i - 1],
        `duplicate consecutive scrollLeft write ${xWrites[i]} at index ${i}`
      );
    }
  }
});

test("animateSpringScroll preserves camera-scrolling hint on active moves, clears on settle, and skips zero-delta springs", () => {
  const { screen, scheduledRafs, stepFrame } = buildHarness();

  const track = createTrackedContainer({ initialClasses: ["home-track"] });
  screen.animateSpringScroll(track.container, "x", 224);
  assert.equal(track.classes.has("is-camera-scrolling"), true);
  while (scheduledRafs.size) stepFrame(16);
  assert.equal(track.classes.has("is-camera-scrolling"), false);

  const zeroViewport = createTrackedContainer({
    scrollHeight: 560,
    clientHeight: 560,
    initialClasses: ["home-modern-rows-viewport"]
  });
  screen.animateSpringScroll(zeroViewport.container, "y", 300);
  assert.equal(scheduledRafs.size, 1, "must still schedule initial rAF for lifecycle parity");
  assert.equal(zeroViewport.classes.has("is-camera-scrolling"), false);
  stepFrame(16);
  assert.equal(scheduledRafs.size, 0);
  assert.equal(zeroViewport.yWrites.length, 0);

  const viewport = createTrackedContainer({ initialClasses: ["home-modern-rows-viewport"] });
  screen.animateSpringScroll(viewport.container, "y", 390);
  assert.equal(viewport.classes.has("is-camera-scrolling"), true);
  while (scheduledRafs.size) stepFrame(16);
  assert.equal(viewport.classes.has("is-camera-scrolling"), false);
  assert.equal(viewport.container.scrollTop, 390);
});

test("animateSpringScroll updates target mid-flight with integer-only writes", () => {
  const { screen, scheduledRafs, stepFrame } = buildHarness();
  const { container, xWrites } = createTrackedContainer();

  screen.animateSpringScroll(container, "x", 224);
  for (let i = 0; i < 6; i += 1) stepFrame(16);
  screen.animateSpringScroll(container, "x", 480);

  let frames = 0;
  while (scheduledRafs.size && frames < 120) {
    stepFrame(16);
    frames += 1;
  }

  assert.equal(scheduledRafs.size, 0);
  assert.equal(container.scrollLeft, 480);
  assert.ok(xWrites.every((value) => Number.isInteger(value)));
  for (let i = 1; i < xWrites.length; i += 1) {
    assert.notEqual(xWrites[i], xWrites[i - 1]);
  }
});

test("homeRowWindow uses bounded 75% rootMargin and prefers entry.boundingClientRect height", () => {
  const observerCalls = [];
  class IntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      observerCalls.push(this);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  let domRectReads = 0;
  const classes = new Set();
  const section = {
    isConnected: true,
    offsetHeight: 392,
    style: { height: "" },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name)
    },
    querySelector: () => null,
    getBoundingClientRect: () => {
      domRectReads += 1;
      return { height: 392 };
    }
  };

  const rowWindow = createHomeRowWindow({ root: {}, scope: { IntersectionObserver } });
  rowWindow.observe([section]);
  assert.equal(observerCalls[0].options.rootMargin, "75% 0px");

  observerCalls[0].callback([
    { target: section, isIntersecting: false, boundingClientRect: { height: 392 } }
  ]);
  assert.equal(domRectReads, 0, "must reuse entry.boundingClientRect.height when provided");
  assert.equal(classes.has(HOME_ROW_PARKED_CLASS), true);
  assert.equal(section.style.height, "392px");
});
