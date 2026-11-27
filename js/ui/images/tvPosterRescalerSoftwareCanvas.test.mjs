import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { WORKER_SOURCE } from "./tvPosterRescaler.js";

function jpegBytes(width = 800, height = 1200) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
  const sof = [
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01
  ];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}

function webpVp8lBytes(width = 600, height = 900, alpha = true) {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14) | ((alpha ? 1 : 0) << 28);
  const payload = [
    0x2f,
    bits & 0xff,
    (bits >>> 8) & 0xff,
    (bits >>> 16) & 0xff,
    (bits >>> 24) & 0xff
  ];
  const riffSize = 4 + 8 + payload.length + (payload.length & 1);
  return new Uint8Array([
    0x52,
    0x49,
    0x46,
    0x46,
    riffSize & 0xff,
    (riffSize >>> 8) & 0xff,
    (riffSize >>> 16) & 0xff,
    (riffSize >>> 24) & 0xff,
    0x57,
    0x45,
    0x42,
    0x50,
    0x56,
    0x50,
    0x38,
    0x4c,
    payload.length & 0xff,
    (payload.length >>> 8) & 0xff,
    (payload.length >>> 16) & 0xff,
    (payload.length >>> 24) & 0xff,
    ...payload,
    0x00
  ]);
}

function pngBytes(width = 1200, height = 400) {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  const chunk = (type, data) => {
    const head = new Uint8Array(8);
    new DataView(head.buffer).setUint32(0, data.length);
    for (let i = 0; i < 4; i += 1) head[4 + i] = type.charCodeAt(i);
    return [...head, ...data, 0, 0, 0, 0];
  };
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", new Uint8Array(4)),
    ...chunk("IEND", [])
  ]);
}

function createWorkerHarness(fetchHandler) {
  const messages = [];
  const contextCalls = [];
  let activeDecodes = 0;
  let maxActiveDecodes = 0;
  let activeFetches = 0;
  let maxActiveFetches = 0;
  let closedBitmaps = 0;

  class FakeOffscreenCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
    getContext(type, options) {
      contextCalls.push({ width: this.width, height: this.height, type, options });
      return { drawImage: () => {} };
    }
    async convertToBlob(options) {
      await new Promise((r) => setTimeout(r, 5));
      return { type: options?.type || "image/jpeg", size: 123 };
    }
  }

  const context = vm.createContext({
    AbortController,
    Blob,
    Uint8Array,
    Promise,
    Number,
    String,
    Boolean,
    Math,
    Error,
    setTimeout,
    clearTimeout,
    OffscreenCanvas: FakeOffscreenCanvas,
    async fetch(url, opts) {
      activeFetches += 1;
      if (activeFetches > maxActiveFetches) maxActiveFetches = activeFetches;
      try {
        return await fetchHandler(url, opts);
      } finally {
        activeFetches -= 1;
      }
    },
    async createImageBitmap(blob, opts) {
      activeDecodes += 1;
      if (activeDecodes > maxActiveDecodes) maxActiveDecodes = activeDecodes;
      try {
        await new Promise((r) => setTimeout(r, 15));
        const sizeHint = Number(opts?.resizeWidth || 0);
        if (blob?.type === "fail") {
          throw new Error("decode failed");
        }
        return {
          width: sizeHint > 0 ? sizeHint : 800,
          height: 1200,
          close() {
            closedBitmaps += 1;
          }
        };
      } finally {
        activeDecodes -= 1;
      }
    }
  });
  context.self = context;
  context.postMessage = (msg) => messages.push(msg);
  vm.runInContext(WORKER_SOURCE, context);

  return {
    send: (data) => context.onmessage({ data }),
    messages,
    contextCalls,
    getMaxActiveDecodes: () => maxActiveDecodes,
    getMaxActiveFetches: () => maxActiveFetches,
    getClosedBitmaps: () => closedBitmaps
  };
}

test("poster and logo OffscreenCanvas contexts request willReadFrequently software rasterization", async () => {
  const files = new Map([
    ["https://art/poster.jpg", jpegBytes(800, 1200)],
    ["https://art/poster-alpha.webp", webpVp8lBytes(600, 900, true)],
    ["https://art/logo.png", pngBytes(1200, 400)]
  ]);
  const h = createWorkerHarness(async (url) => {
    const bytes = files.get(url);
    return {
      ok: true,
      headers: { get: () => String(bytes.byteLength) },
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
    };
  });

  await h.send({ id: 1, url: "https://art/poster.jpg", width: 220, height: 338, fit: "cover" });
  await h.send({
    id: 2,
    url: "https://art/poster-alpha.webp",
    width: 220,
    height: 338,
    fit: "cover"
  });
  await h.send({
    id: 3,
    url: "https://art/logo.png",
    width: 440,
    height: 200,
    fit: "contain",
    kind: "logo"
  });

  assert.equal(h.messages.length, 3);
  assert.ok(h.messages.every((m) => m.ok === true));
  assert.equal(h.contextCalls.length, 3);
  assert.deepEqual({ ...h.contextCalls[0].options }, { alpha: false, willReadFrequently: true });
  assert.deepEqual({ ...h.contextCalls[1].options }, { alpha: true, willReadFrequently: true });
  assert.deepEqual({ ...h.contextCalls[2].options }, { alpha: true, willReadFrequently: true });
});

test("worker overlaps network fetches while serializing decode/encode and recovers after errors", async () => {
  const bytes = jpegBytes(800, 1200);
  const h = createWorkerHarness(async (url) => {
    await new Promise((r) => setTimeout(r, 10));
    const data = url.includes("small") ? jpegBytes(100, 150) : bytes;
    return {
      ok: true,
      headers: { get: () => String(data.byteLength) },
      async arrayBuffer() {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      }
    };
  });

  await Promise.all([
    h.send({ id: 10, url: "https://art/small.jpg", width: 900, height: 1400, fit: "cover" }),
    h.send({ id: 11, url: "https://art/p1.jpg", width: 220, height: 338, fit: "cover" }),
    h.send({ id: 12, url: "https://art/p2.jpg", width: 220, height: 338, fit: "cover" })
  ]);

  assert.equal(h.getMaxActiveFetches(), 3, "network fetches must still overlap concurrently");
  assert.equal(h.getMaxActiveDecodes(), 1, "decode/encode must run exclusively per worker");
  const byId = new Map(h.messages.map((m) => [m.id, m]));
  assert.equal(byId.get(10)?.ok, false);
  assert.equal(byId.get(10)?.reason, "already small");
  assert.equal(byId.get(11)?.ok, true);
  assert.equal(byId.get(12)?.ok, true);
  assert.equal(h.getClosedBitmaps(), 3, "every created bitmap must be closed, including errors");
});
