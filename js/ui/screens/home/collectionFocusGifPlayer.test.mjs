import assert from "node:assert/strict";
import test from "node:test";
import { collectionFocusGifPlayer } from "./collectionFocusGifPlayer.js";

function createWebpBytes(size = 64) {
  const buf = new Uint8Array(Math.max(16, size));
  // "RIFF"
  buf[0] = 0x52;
  buf[1] = 0x49;
  buf[2] = 0x46;
  buf[3] = 0x46;
  // "WEBP"
  buf[8] = 0x57;
  buf[9] = 0x45;
  buf[10] = 0x42;
  buf[11] = 0x50;
  return buf.buffer;
}

function makeFakeCard(url, width = 360, height = 202) {
  const classes = new Set(["focused"]);
  const attrs = new Map([["data-src", url]]);
  const children = [];
  const frame = {
    clientWidth: width,
    clientHeight: height,
    children,
    insertBefore(el) {
      children.push(el);
      el.parentNode = frame;
      el.parentElement = frame;
      return el;
    },
    removeChild(el) {
      const idx = children.indexOf(el);
      if (idx >= 0) children.splice(idx, 1);
    }
  };
  const gifNode = {
    dataset: { src: url },
    parentElement: frame,
    parentNode: frame,
    nextSibling: null,
    getAttribute: (k) => attrs.get(k),
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k)
  };
  children.push(gifNode);
  const node = {
    isConnected: true,
    dataset: { navRow: "0", navCol: "0" },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c)
    },
    querySelector: (sel) => {
      if (sel === ".home-poster-focus-gif") return gifNode;
      if (sel === ".home-poster-frame") return frame;
      return null;
    }
  };
  return { node, gifNode, frame, classes };
}

test("WebCodecs pre-buffers initial frames before reveal, animates canvas, and closes bitmaps on deactivate", async () => {
  const saved = {
    ImageDecoder: globalThis.ImageDecoder,
    fetch: globalThis.fetch,
    createImageBitmap: globalThis.createImageBitmap,
    document: globalThis.document,
    devicePixelRatio: globalThis.devicePixelRatio,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    performance: globalThis.performance
  };

  let createdBitmaps = 0;
  let closedBitmaps = 0;
  let closedDecoders = 0;
  const drawnFrames = [];
  let rafQueue = [];
  let fakeNow = 1000;

  try {
    globalThis.performance = { now: () => fakeNow };
    globalThis.devicePixelRatio = 1;
    globalThis.requestAnimationFrame = (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    };
    globalThis.cancelAnimationFrame = () => {
      rafQueue = [];
    };
    globalThis.fetch = async () => ({
      ok: true,
      headers: { get: () => "image/webp" },
      arrayBuffer: async () => createWebpBytes(128)
    });
    globalThis.ImageDecoder = class FakeImageDecoder {
      static async isTypeSupported(type) {
        return type === "image/webp";
      }
      constructor() {
        this.tracks = {
          ready: Promise.resolve(),
          selectedTrack: { frameCount: 4 }
        };
      }
      async decode({ frameIndex }) {
        return {
          image: {
            frameIndex,
            codedWidth: 640,
            codedHeight: 360,
            displayWidth: 640,
            displayHeight: 360,
            duration: 33000,
            close() {}
          }
        };
      }
      close() {
        closedDecoders += 1;
      }
    };
    globalThis.createImageBitmap = async (videoFrame) => {
      const id = videoFrame.frameIndex;
      createdBitmaps += 1;
      return {
        id,
        close() {
          closedBitmaps += 1;
        }
      };
    };
    globalThis.document = {
      createElement(tag) {
        assert.equal(tag, "canvas");
        const el = {
          className: "",
          width: 0,
          height: 0,
          setAttribute() {},
          remove() {
            el.parentNode?.removeChild?.(el);
          },
          getContext() {
            return {
              clearRect() {},
              drawImage(bmp) {
                drawnFrames.push(bmp.id);
              }
            };
          }
        };
        return el;
      }
    };

    const { node, gifNode, frame, classes } = makeFakeCard(
      "https://example.invalid/a.webp",
      360,
      202
    );
    collectionFocusGifPlayer.activate({ node, gifNode, src: "https://example.invalid/a.webp" });
    assert.equal(
      classes.has("is-focus-gif-active"),
      false,
      "not visible before pre-buffer finishes"
    );

    for (let i = 0; i < 15 && !classes.has("is-focus-gif-active"); i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }

    assert.equal(classes.has("is-focus-gif-active"), true);
    assert.equal(classes.has("is-focus-gif-canvas-mode"), true);
    assert.equal(createdBitmaps, 4);
    assert.equal(drawnFrames[0], 0);
    const canvas = frame.children.find((c) => c.className === "home-poster-focus-gif-canvas");
    assert.ok(canvas);
    assert.equal(canvas.width, 360);
    assert.equal(canvas.height, 202);

    // Advance clock by 40 ms -> draws frame 1
    assert.ok(rafQueue.length > 0);
    const tick = rafQueue.shift();
    fakeNow = 1040;
    tick(fakeNow);
    assert.ok(drawnFrames.includes(1));

    collectionFocusGifPlayer.deactivate(node);
    assert.equal(classes.has("is-focus-gif-active"), false);
    assert.equal(classes.has("is-focus-gif-canvas-mode"), false);
    assert.equal(closedBitmaps, 4, "every ImageBitmap closed on blur");
    assert.ok(closedDecoders >= 1, "decoder closed cleanly");
  } finally {
    collectionFocusGifPlayer.teardown();
    Object.assign(globalThis, saved);
  }
});

test("pipelines concurrent WebCodecs frame decodes for prebuffer and tail decode ahead", async () => {
  const saved = {
    ImageDecoder: globalThis.ImageDecoder,
    fetch: globalThis.fetch,
    createImageBitmap: globalThis.createImageBitmap,
    document: globalThis.document,
    devicePixelRatio: globalThis.devicePixelRatio,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    performance: globalThis.performance
  };

  let inFlight = 0;
  let maxInFlight = 0;
  let closedBitmaps = 0;

  try {
    globalThis.performance = { now: () => 1000 };
    globalThis.devicePixelRatio = 1;
    globalThis.requestAnimationFrame = () => 1;
    globalThis.cancelAnimationFrame = () => {};
    globalThis.fetch = async () => ({
      ok: true,
      headers: { get: () => "image/webp" },
      arrayBuffer: async () => createWebpBytes(128)
    });
    globalThis.ImageDecoder = class FakeBatchDecoder {
      static async isTypeSupported(type) {
        return type === "image/webp";
      }
      constructor() {
        this.tracks = {
          ready: Promise.resolve(),
          selectedTrack: { frameCount: 16 }
        };
      }
      async decode({ frameIndex }) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 4));
        inFlight -= 1;
        return {
          image: {
            frameIndex,
            codedWidth: 640,
            codedHeight: 360,
            displayWidth: 640,
            displayHeight: 360,
            duration: 100000,
            close() {}
          }
        };
      }
      close() {}
    };
    globalThis.createImageBitmap = async (videoFrame) => ({
      id: videoFrame.frameIndex,
      close() {
        closedBitmaps += 1;
      }
    });
    globalThis.document = {
      createElement: () => ({
        className: "",
        width: 0,
        height: 0,
        setAttribute() {},
        remove() {},
        getContext: () => ({ drawImage() {} })
      })
    };

    const url = "https://example.invalid/batched-16.webp";
    const { node, gifNode, classes } = makeFakeCard(url, 320, 180);
    collectionFocusGifPlayer.activate({ node, gifNode, src: url });

    for (let i = 0; i < 40 && closedBitmaps === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 6));
      if (classes.has("is-focus-gif-active") && i >= 12) {
        break;
      }
    }
    assert.equal(classes.has("is-focus-gif-active"), true);
    assert.ok(
      maxInFlight >= 2,
      `expected concurrent batch decodes, got maxInFlight=${maxInFlight}`
    );

    collectionFocusGifPlayer.deactivate(node);
    assert.ok(
      closedBitmaps >= 10,
      `expected >= 10 prebuffered/tail frames closed, got ${closedBitmaps}`
    );
  } finally {
    collectionFocusGifPlayer.teardown();
    Object.assign(globalThis, saved);
  }
});

test("falls back to img decode wait when CORS fetch fails", async () => {
  const saved = {
    ImageDecoder: globalThis.ImageDecoder,
    fetch: globalThis.fetch,
    createImageBitmap: globalThis.createImageBitmap,
    document: globalThis.document
  };

  try {
    globalThis.fetch = async () => {
      throw new TypeError("CORS blocked");
    };
    globalThis.ImageDecoder = class {
      static async isTypeSupported() {
        return true;
      }
    };
    globalThis.createImageBitmap = async () => ({ close() {} });
    globalThis.document = { createElement: () => ({}) };

    const url = "https://no-cors.invalid/fallback.webp";
    const { node, gifNode, classes } = makeFakeCard(url);
    let resolveDecode;
    gifNode.decode = () =>
      new Promise((resolve) => {
        resolveDecode = resolve;
      });

    collectionFocusGifPlayer.activate({ node, gifNode, src: url });
    for (let i = 0; i < 8 && !gifNode.getAttribute("src"); i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(gifNode.getAttribute("src"), url);
    assert.equal(classes.has("is-focus-gif-active"), false, "waits for img.decode()");

    resolveDecode();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(classes.has("is-focus-gif-active"), true);
    assert.equal(classes.has("is-focus-gif-canvas-mode"), false);
  } finally {
    collectionFocusGifPlayer.teardown();
    Object.assign(globalThis, saved);
  }
});
