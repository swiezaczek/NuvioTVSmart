import assert from "node:assert/strict";
import test from "node:test";
import { PlayerSettingsStore } from "../../data/local/playerSettingsStore.js";
import {
  __resetVetroTrailerResolverForTests,
  attachTrailerVideoStream,
  destroyTrailerVideoStream,
  resetVetroTrailerResolverCircuitBreaker,
  resolveVetroDirectTrailer
} from "./vetroTrailerResolver.js";

function createMockElement(tagName = "div") {
  const attrs = new Map();
  const listeners = new Map();
  const el = {
    tagName: String(tagName).toUpperCase(),
    children: [],
    isConnected: true,
    parentElement: null,
    autoplay: true,
    crossOrigin: "",
    textTracks: [],
    ownerDocument: null,
    _src: "",
    get src() {
      return el._src;
    },
    set src(value) {
      el._src = String(value || "");
      attrs.set("src", el._src);
    },
    setAttribute(k, v) {
      attrs.set(String(k), String(v));
      if (k === "src") {
        el._src = String(v);
      }
    },
    removeAttribute(k) {
      attrs.delete(String(k));
      if (k === "src") {
        el._src = "";
      }
    },
    hasAttribute(k) {
      return attrs.has(String(k));
    },
    getAttribute(k) {
      return attrs.has(String(k)) ? attrs.get(String(k)) : null;
    },
    appendChild(child) {
      child.parentElement = el;
      el.children.push(child);
      if (child.tagName === "TRACK") {
        const trackObj = { mode: "disabled", srclang: child.srclang, label: child.label };
        child.track = trackObj;
        el.textTracks.push(trackObj);
      }
      return child;
    },
    querySelectorAll(sel) {
      if (sel === "track") {
        return el.children.filter((c) => c.tagName === "TRACK");
      }
      return [];
    },
    remove() {
      if (el.parentElement) {
        el.parentElement.children = el.parentElement.children.filter((c) => c !== el);
        el.parentElement = null;
      }
    },
    pause() {
      el.pauseCalls = (el.pauseCalls || 0) + 1;
    },
    load() {
      el.loadCalls = (el.loadCalls || 0) + 1;
    },
    play() {
      el.playCalls = (el.playCalls || 0) + 1;
      return Promise.resolve();
    },
    canPlayType() {
      return "";
    },
    addEventListener(name, fn) {
      if (!listeners.has(name)) {
        listeners.set(name, []);
      }
      listeners.get(name).push(fn);
    },
    removeEventListener(name, fn) {
      const list = listeners.get(name);
      if (!list) {
        return;
      }
      listeners.set(
        name,
        list.filter((entry) => entry !== fn)
      );
    },
    dispatchEvent(name, payload = {}) {
      const list = [...(listeners.get(name) || [])];
      list.forEach((fn) => fn(payload));
    }
  };
  el.ownerDocument = {
    createElement: (tag) => createMockElement(tag)
  };
  return el;
}

function resetGlobals() {
  __resetVetroTrailerResolverForTests();
  delete globalThis.__NUVIO_ENV__;
  delete globalThis.__NUVIO_PLATFORM__;
  delete globalThis.tizen;
  delete globalThis.webapis;
  delete globalThis.localStorage;
  delete globalThis.dashjs;
  delete globalThis.Hls;
  delete globalThis.fetch;
}

test("resolveVetroDirectTrailer skips network when not on Tizen and no override is set", async () => {
  resetGlobals();
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, url: "http://127.0.0.1:8102/x.mp4" })
    };
  };

  const result = await resolveVetroDirectTrailer({ ytId: "dQw4w9WgXcQ" });
  assert.equal(result, null);
  assert.equal(fetchCalls, 0);
  resetGlobals();
});

test("resolveVetroDirectTrailer caches results and deduplicates concurrent in-flight lookups", async () => {
  resetGlobals();
  globalThis.__NUVIO_PLATFORM__ = "tizen";
  globalThis.__NUVIO_ENV__ = { TRAILER_API_URL: "http://127.0.0.1:8102/" };

  let fetchCalls = 0;
  let resolveFetch;
  globalThis.fetch = () => {
    fetchCalls += 1;
    return new Promise((resolve) => {
      resolveFetch = resolve;
    });
  };

  const p1 = resolveVetroDirectTrailer({
    ytId: "abc12345678",
    captionsLanguage: "pl",
    maxHeight: 1080
  });
  const p2 = resolveVetroDirectTrailer({
    ytId: "abc12345678",
    captionsLanguage: "pl",
    maxHeight: 1080
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fetchCalls, 1, "concurrent identical requests must deduplicate in-flight");

  resolveFetch({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      streamType: "dash",
      url: "http://127.0.0.1:8102/manifest.mpd",
      subtitles: [{ lang: "pl", label: "Polski", url: "http://127.0.0.1:8102/sub.vtt" }],
      expiresInMs: 60_000
    })
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.kind, "video");
  assert.equal(r1.streamType, "dash");
  assert.equal(r1.url, "http://127.0.0.1:8102/manifest.mpd");
  assert.equal(r1.subtitles.length, 1);
  assert.equal(r2.url, r1.url);
  assert.notEqual(
    r1,
    r2,
    "cached lookups must return distinct clones so caller mutations stay isolated"
  );

  const r3 = await resolveVetroDirectTrailer({
    ytId: "abc12345678",
    captionsLanguage: "pl",
    maxHeight: 1080
  });
  assert.equal(fetchCalls, 1, "subsequent lookup within TTL must hit cache");
  assert.equal(r3.url, "http://127.0.0.1:8102/manifest.mpd");
  resetGlobals();
});

test("resolveVetroDirectTrailer opens 60s circuit breaker after unreachable endpoint failure", async () => {
  resetGlobals();
  const storage = new Map([["nuvio.trailerResolverUrl", "http://127.0.0.1:8102/"]]);
  globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null };

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("ECONNREFUSED");
  };

  const first = await resolveVetroDirectTrailer({ ytId: "fail1234567" });
  assert.equal(first, null);
  assert.equal(fetchCalls, 1);

  const second = await resolveVetroDirectTrailer({ ytId: "other123456" });
  assert.equal(second, null);
  assert.equal(fetchCalls, 1, "circuit breaker must short-circuit subsequent requests for 60s");
  resetGlobals();
});

test("attachTrailerVideoStream binds dash.js, subtitle tracks, fatal error callback, and WeakMap cleanup", async () => {
  resetGlobals();
  const dashCalls = [];
  const dashHandlers = {};
  const mockDashPlayer = {
    updateSettings: (cfg) => dashCalls.push(["updateSettings", cfg]),
    on: (ev, fn) => {
      dashHandlers[ev] = fn;
    },
    initialize: (el, url, autoplay) => dashCalls.push(["initialize", el, url, autoplay]),
    reset: () => dashCalls.push(["reset"])
  };
  globalThis.dashjs = {
    Debug: { LOG_LEVEL_NONE: 0 },
    MediaPlayer: Object.assign(() => ({ create: () => mockDashPlayer }), {
      events: { ERROR: "error", PLAYBACK_ERROR: "playbackError" }
    })
  };

  const video = createMockElement("video");
  let fatalCalls = 0;
  await attachTrailerVideoStream(
    video,
    {
      kind: "video",
      streamType: "dash",
      url: "http://127.0.0.1:8102/manifest.mpd",
      subtitles: [{ lang: "en", label: "English", url: "http://127.0.0.1:8102/en.vtt" }]
    },
    {
      captionsEnabled: true,
      onFatalError: () => {
        fatalCalls += 1;
      }
    }
  );

  assert.equal(video.crossOrigin, "anonymous");
  assert.equal(video.querySelectorAll("track").length, 1);
  assert.equal(video.textTracks[0].mode, "showing");
  assert.equal(
    dashCalls.find((c) => c[0] === "initialize")?.[2],
    "http://127.0.0.1:8102/manifest.mpd"
  );

  dashHandlers.error?.();
  video.dispatchEvent("error");
  assert.equal(fatalCalls, 1, "fatal error callback must fire at most once");

  destroyTrailerVideoStream(video);
  assert.ok(
    dashCalls.some((c) => c[0] === "reset"),
    "destroyTrailerVideoStream must reset dash.js player"
  );
  assert.equal(video.querySelectorAll("track").length, 0);
  assert.equal(video.hasAttribute("src"), false);
  resetGlobals();
});

test("attachTrailerVideoStream binds hls.js and cleans up on re-attach or destroy", async () => {
  resetGlobals();
  const hlsInstances = [];
  class MockHls {
    static Events = { ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed" };
    static isSupported() {
      return true;
    }
    constructor(cfg) {
      this.cfg = cfg;
      this.handlers = {};
      this.destroyed = false;
      this.loadedUrl = "";
      hlsInstances.push(this);
    }
    on(ev, fn) {
      this.handlers[ev] = fn;
    }
    loadSource(url) {
      this.loadedUrl = url;
    }
    attachMedia(el) {
      this.attachedVideo = el;
    }
    startLoad() {
      this.started = true;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  globalThis.Hls = MockHls;

  const video = createMockElement("video");
  let fatalCalls = 0;
  await attachTrailerVideoStream(
    video,
    {
      kind: "video",
      streamType: "hls",
      url: "http://127.0.0.1:8102/master.m3u8",
      subtitles: [{ lang: "en", label: "English", url: "http://127.0.0.1:8102/en.vtt" }]
    },
    {
      captionsEnabled: false,
      onFatalError: () => {
        fatalCalls += 1;
      }
    }
  );

  assert.equal(hlsInstances.length, 1);
  assert.equal(hlsInstances[0].loadedUrl, "http://127.0.0.1:8102/master.m3u8");
  assert.equal(video.textTracks[0].mode, "disabled");

  hlsInstances[0].handlers.hlsError({}, { fatal: false });
  assert.equal(fatalCalls, 0);
  hlsInstances[0].handlers.hlsError({}, { fatal: true });
  assert.equal(fatalCalls, 1);

  // Re-attaching MP4 must destroy the previous hls.js instance via WeakMap.
  await attachTrailerVideoStream(
    video,
    { kind: "video", streamType: "mp4", url: "http://127.0.0.1:8102/video.mp4" },
    { captionsEnabled: false }
  );
  assert.equal(hlsInstances[0].destroyed, true);
  assert.equal(video.src, "http://127.0.0.1:8102/video.mp4");

  destroyTrailerVideoStream(video);
  assert.equal(video.hasAttribute("src"), false);
  resetGlobals();
});

test("attachTrailerVideoStream invokes onFatalError once so callers can fall back to fallbackYoutube", async () => {
  resetGlobals();
  const video = createMockElement("video");
  const fallbackYoutube = {
    kind: "youtube",
    ytId: "dQw4w9WgXcQ",
    embedUrl: "https://proxy.example.test/?v=dQw4w9WgXcQ"
  };
  const source = {
    kind: "video",
    streamType: "mp4",
    url: "http://127.0.0.1:8102/broken.mp4",
    ytId: "dQw4w9WgXcQ",
    subtitles: [],
    fallbackYoutube
  };

  let activeSource = source;
  let fallbackUsed = 0;
  await attachTrailerVideoStream(video, source, {
    captionsEnabled: false,
    onFatalError: () => {
      if (activeSource.fallbackYoutube) {
        fallbackUsed += 1;
        activeSource = activeSource.fallbackYoutube;
      }
    }
  });

  video.dispatchEvent("error");
  video.dispatchEvent("error");
  assert.equal(fallbackUsed, 1);
  assert.equal(activeSource.kind, "youtube");
  assert.equal(activeSource.ytId, "dQw4w9WgXcQ");

  destroyTrailerVideoStream(video);
  resetGlobals();
});

test("resolveVetroDirectTrailer respects PlayerSettingsStore.vetroDirectTrailersEnabled and resetVetroTrailerResolverCircuitBreaker", async () => {
  resetGlobals();
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k)
  };
  globalThis.__NUVIO_PLATFORM__ = "tizen";
  globalThis.__NUVIO_ENV__ = { TRAILER_API_URL: "http://127.0.0.1:8102" };

  let fetchCalls = 0;
  let shouldFail = false;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (shouldFail) {
      throw new Error("ECONNREFUSED");
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, streamType: "mp4", url: "http://127.0.0.1:8102/ok.mp4" })
    };
  };

  assert.equal(PlayerSettingsStore.get().vetroDirectTrailersEnabled, true);
  PlayerSettingsStore.set({ vetroDirectTrailersEnabled: false }, { silentSync: true });
  assert.equal(PlayerSettingsStore.get().vetroDirectTrailersEnabled, false);

  const disabledResult = await resolveVetroDirectTrailer({ ytId: "toggleOff111" });
  assert.equal(disabledResult, null);
  assert.equal(fetchCalls, 0, "must skip network request when vetroDirectTrailersEnabled is false");

  // Trip the circuit breaker while enabled, then confirm resetVetroTrailerResolverCircuitBreaker clears it.
  PlayerSettingsStore.set({ vetroDirectTrailersEnabled: true }, { silentSync: true });
  shouldFail = true;
  assert.equal(await resolveVetroDirectTrailer({ ytId: "toggleOn2222" }), null);
  assert.equal(fetchCalls, 1);

  shouldFail = false;
  assert.equal(
    await resolveVetroDirectTrailer({ ytId: "toggleOn3333" }),
    null,
    "circuit breaker should still be open"
  );
  assert.equal(fetchCalls, 1);

  resetVetroTrailerResolverCircuitBreaker();
  const enabledResult = await resolveVetroDirectTrailer({ ytId: "toggleOn3333" });
  assert.equal(fetchCalls, 2);
  assert.equal(enabledResult?.kind, "video");
  assert.equal(enabledResult?.url, "http://127.0.0.1:8102/ok.mp4");

  resetGlobals();
});

test("resolveVetroDirectTrailer falls back from unreachable loopback to webapis.network.getIp() and pins activeBaseUrl", async () => {
  resetGlobals();
  globalThis.__NUVIO_PLATFORM__ = "tizen";
  globalThis.webapis = {
    network: {
      getIp: () => "192.168.55.42"
    }
  };

  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    if (String(url).startsWith("http://127.0.0.1:8102/")) {
      throw new Error("ERR_ADDRESS_UNREACHABLE");
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        streamType: "dash",
        url: "http://192.168.55.42:8102/mpd?v=test"
      })
    };
  };

  const first = await resolveVetroDirectTrailer({ ytId: "tizenFallback1" });
  assert.equal(first?.kind, "video");
  assert.equal(first?.url, "http://192.168.55.42:8102/mpd?v=test");
  assert.deepEqual(requestedUrls, [
    "http://127.0.0.1:8102/trailer?v=tizenFallback1&lang=&maxHeight=1080",
    "http://192.168.55.42:8102/trailer?v=tizenFallback1&lang=&maxHeight=1080"
  ]);

  // Subsequent uncached lookup must hit the pinned TV LAN IP directly (0ms loopback probe overhead).
  requestedUrls.length = 0;
  const second = await resolveVetroDirectTrailer({ ytId: "tizenFallback2" });
  assert.equal(second?.kind, "video");
  assert.deepEqual(requestedUrls, [
    "http://192.168.55.42:8102/trailer?v=tizenFallback2&lang=&maxHeight=1080"
  ]);

  // Resetting clears pinned activeBaseUrl so loopback is tried first again.
  resetVetroTrailerResolverCircuitBreaker();
  requestedUrls.length = 0;
  const third = await resolveVetroDirectTrailer({ ytId: "tizenFallback3" });
  assert.equal(third?.kind, "video");
  assert.equal(requestedUrls.length, 2);

  resetGlobals();
});
