import { BoundedCache } from "../util/boundedCache.js";
import { withRequestTimeout } from "../network/requestTimeout.js";
import { loadStreamingLibs } from "../../runtime/loadStreamingLibs.js";
import { PlayerSettingsStore } from "../../data/local/playerSettingsStore.js";

const DEFAULT_TRAILER_RESOLVER_URL = "http://127.0.0.1:8102";
const RESOLVER_TIMEOUT_MS = 1600;
const CIRCUIT_BREAKER_BACKOFF_MS = 60_000;
const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 48;

const resolvedTrailerCache = new BoundedCache(MAX_CACHE_ENTRIES);
const inFlightRequests = new Map();
const videoDestroyMap = new WeakMap();
let circuitOpenUntilMs = 0;
let activeBaseUrl = null;

function trimTrailingSlash(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

function getExplicitResolverUrlOverride() {
  const envUrl = trimTrailingSlash(globalThis.__NUVIO_ENV__?.TRAILER_API_URL || "");
  if (envUrl) {
    return envUrl;
  }
  try {
    return trimTrailingSlash(globalThis.localStorage?.getItem?.("nuvio.trailerResolverUrl") || "");
  } catch (_) {
    return "";
  }
}

function isTizenRuntime() {
  return Boolean(
    globalThis.__NUVIO_PLATFORM__ === "tizen" || globalThis.tizen || globalThis.webapis?.avplay
  );
}

function isVetroDirectTrailersEnabled() {
  if (typeof globalThis.localStorage?.getItem !== "function") {
    return true;
  }
  try {
    return PlayerSettingsStore.get()?.vetroDirectTrailersEnabled !== false;
  } catch (_) {
    return true;
  }
}

function isValidIpv4(value) {
  const ip = String(value || "").trim();
  if (!ip || ip === "0.0.0.0" || ip === "127.0.0.1") {
    return false;
  }
  const parts = ip.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
}

function getTvLanIp() {
  try {
    const ip = String(globalThis.webapis?.network?.getIp?.() || "").trim();
    return isValidIpv4(ip) ? ip : "";
  } catch (_) {
    return "";
  }
}

function getResolverCandidateBaseUrls() {
  if (!isVetroDirectTrailersEnabled()) {
    return [];
  }
  const override = getExplicitResolverUrlOverride();
  if (override) {
    if (/^(off|disabled|false|none)$/i.test(override)) {
      return [];
    }
    return [override];
  }
  if (!isTizenRuntime()) {
    return [];
  }
  const candidates = [];
  if (activeBaseUrl) {
    candidates.push(activeBaseUrl);
  }
  if (!candidates.includes(DEFAULT_TRAILER_RESOLVER_URL)) {
    candidates.push(DEFAULT_TRAILER_RESOLVER_URL);
  }
  const tvIp = getTvLanIp();
  if (tvIp) {
    const lanUrl = `http://${tvIp}:8102`;
    if (!candidates.includes(lanUrl)) {
      candidates.push(lanUrl);
    }
  }
  return candidates;
}

function normalizeStreamType(value) {
  const normalized = String(value || "mp4")
    .trim()
    .toLowerCase();
  if (normalized === "dash" || normalized === "hls" || normalized === "mp4") {
    return normalized;
  }
  return "mp4";
}

function cloneResolvedSource(source) {
  return {
    ...source,
    subtitles: Array.isArray(source.subtitles)
      ? source.subtitles.map((entry) => ({ ...entry }))
      : []
  };
}

/**
 * Resolve a YouTube trailer id to a direct/adaptive media stream via the local
 * Vetro trailer-resolver Shard when running on Tizen or explicitly configured.
 */
export async function resolveVetroDirectTrailer({
  ytId,
  captionsLanguage = "",
  maxHeight = 1080
} = {}) {
  const cleanYtId = String(ytId || "").trim();
  if (!cleanYtId) {
    return null;
  }
  const candidates = getResolverCandidateBaseUrls();
  if (!candidates.length) {
    return null;
  }

  const lang = String(captionsLanguage || "").trim();
  const height = Math.max(144, Math.min(2160, Number(maxHeight) || 1080));
  const cacheKey = `${cleanYtId}|${lang}|${height}`;

  const cached = resolvedTrailerCache.get(cacheKey);
  if (cached) {
    if (Date.now() < cached.expiresAt) {
      return cloneResolvedSource(cached.value);
    }
    resolvedTrailerCache.delete(cacheKey);
  }

  if (Date.now() < circuitOpenUntilMs) {
    return null;
  }

  const existing = inFlightRequests.get(cacheKey);
  if (existing) {
    const sharedResult = await existing;
    return sharedResult ? cloneResolvedSource(sharedResult) : null;
  }

  const fetchFn = globalThis.fetch;
  if (typeof fetchFn !== "function") {
    return null;
  }

  const querySuffix =
    `/trailer?v=${encodeURIComponent(cleanYtId)}` +
    `&lang=${encodeURIComponent(lang)}` +
    `&maxHeight=${height}`;

  const promise = (async () => {
    let sawTransportFailure = false;
    try {
      for (const baseUrl of candidates) {
        const requestUrl = `${baseUrl}${querySuffix}`;
        try {
          const outcome = await withRequestTimeout(async (signal) => {
            const response = await fetchFn(requestUrl, signal ? { signal } : undefined);
            if (!response) {
              throw new Error("Empty trailer resolver response");
            }
            if (Number(response.status || 0) >= 500) {
              throw new Error(`Trailer resolver HTTP ${response.status}`);
            }
            if (!response.ok) {
              return { reachable: true, data: null };
            }
            return { reachable: true, data: await response.json() };
          }, RESOLVER_TIMEOUT_MS);

          activeBaseUrl = baseUrl;
          circuitOpenUntilMs = 0;

          const data = outcome?.data;
          if (!data || data.ok !== true || !data.url) {
            return null;
          }

          const value = {
            kind: "video",
            streamType: normalizeStreamType(data.streamType),
            url: String(data.url),
            ytId: cleanYtId,
            subtitles: Array.isArray(data.subtitles)
              ? data.subtitles
                  .filter((sub) => sub && (sub.url || sub.src))
                  .map((sub) => ({
                    lang: String(sub.lang || sub.srclang || "en").trim(),
                    label: String(sub.label || sub.lang || sub.srclang || "Subtitles").trim(),
                    url: String(sub.url || sub.src).trim()
                  }))
              : [],
            fallbackYoutube: null
          };

          const ttlMs =
            Number(data.expiresInMs) > 0 ? Number(data.expiresInMs) : DEFAULT_CACHE_TTL_MS;
          resolvedTrailerCache.set(cacheKey, {
            value,
            expiresAt: Date.now() + ttlMs
          });
          return value;
        } catch (_) {
          sawTransportFailure = true;
        }
      }
      if (sawTransportFailure) {
        activeBaseUrl = null;
        circuitOpenUntilMs = Date.now() + CIRCUIT_BREAKER_BACKOFF_MS;
      }
      return null;
    } finally {
      if (inFlightRequests.get(cacheKey) === promise) {
        inFlightRequests.delete(cacheKey);
      }
    }
  })();

  inFlightRequests.set(cacheKey, promise);
  const resolved = await promise;
  return resolved ? cloneResolvedSource(resolved) : null;
}

/**
 * Tear down any dash.js / hls.js instance, subtitle tracks, and src bound to a
 * trailer <video> element.
 */
export function destroyTrailerVideoStream(video) {
  if (!video) {
    return;
  }
  const destroy = videoDestroyMap.get(video);
  if (typeof destroy === "function") {
    destroy();
    return;
  }
  try {
    video.pause?.();
  } catch (_) {}
  try {
    video.querySelectorAll?.("track")?.forEach?.((track) => track.remove?.());
  } catch (_) {}
  try {
    video.removeAttribute?.("src");
    video.querySelectorAll?.("source")?.forEach?.((sourceEl) => sourceEl.removeAttribute?.("src"));
    video.load?.();
  } catch (_) {}
}

function attachSubtitleTracks(video, subtitles, captionsEnabled, trackElements) {
  const doc = video.ownerDocument || globalThis.document;
  const entries = Array.isArray(subtitles) ? subtitles : [];
  if (doc?.createElement && typeof video.appendChild === "function") {
    entries.forEach((sub, index) => {
      const subUrl = String(sub?.url || sub?.src || "").trim();
      if (!subUrl) {
        return;
      }
      const trackEl = doc.createElement("track");
      trackEl.kind = "subtitles";
      trackEl.srclang = String(sub.lang || sub.srclang || "en");
      trackEl.label = String(sub.label || sub.lang || sub.srclang || "Subtitles");
      trackEl.src = subUrl;
      if (index === 0) {
        trackEl.default = true;
        trackEl.setAttribute?.("default", "");
      }
      video.appendChild(trackEl);
      trackElements.push(trackEl);
      if (trackEl.track) {
        try {
          trackEl.track.mode = captionsEnabled ? "showing" : "disabled";
        } catch (_) {}
      }
    });
  }
  if (video.textTracks) {
    try {
      Array.from(video.textTracks).forEach((track) => {
        track.mode = captionsEnabled ? "showing" : "disabled";
      });
    } catch (_) {}
  }
}

/**
 * Attach a resolved trailer stream (dash / hls / mp4) and optional WebVTT
 * subtitle tracks to a <video> element, registering cleanup in a WeakMap.
 */
export async function attachTrailerVideoStream(
  video,
  source,
  { captionsEnabled = false, onFatalError = null } = {}
) {
  if (!video || !source?.url) {
    return () => {};
  }

  destroyTrailerVideoStream(video);

  const state = {
    destroyed: false,
    fatalReported: false,
    dashPlayer: null,
    hlsInstance: null,
    trackElements: []
  };

  const triggerFatalError = () => {
    if (state.destroyed || state.fatalReported) {
      return;
    }
    state.fatalReported = true;
    onFatalError?.();
  };

  const onVideoError = () => {
    triggerFatalError();
  };

  const destroy = () => {
    if (state.destroyed) {
      return;
    }
    state.destroyed = true;
    if (videoDestroyMap.get(video) === destroy) {
      videoDestroyMap.delete(video);
    }
    video.removeEventListener?.("error", onVideoError);
    if (state.hlsInstance) {
      try {
        state.hlsInstance.destroy?.();
      } catch (_) {}
      state.hlsInstance = null;
    }
    if (state.dashPlayer) {
      try {
        if (typeof state.dashPlayer.reset === "function") {
          state.dashPlayer.reset();
        } else {
          state.dashPlayer.destroy?.();
        }
      } catch (_) {}
      state.dashPlayer = null;
    }
    try {
      video.pause?.();
    } catch (_) {}
    state.trackElements.forEach((trackEl) => {
      try {
        trackEl.remove?.();
      } catch (_) {}
    });
    state.trackElements = [];
    try {
      video.querySelectorAll?.("track")?.forEach?.((track) => track.remove?.());
    } catch (_) {}
    try {
      video.removeAttribute?.("src");
      video
        .querySelectorAll?.("source")
        ?.forEach?.((sourceEl) => sourceEl.removeAttribute?.("src"));
      video.load?.();
    } catch (_) {}
  };

  videoDestroyMap.set(video, destroy);

  try {
    video.crossOrigin = "anonymous";
    video.setAttribute?.("crossorigin", "anonymous");
  } catch (_) {}

  attachSubtitleTracks(video, source.subtitles, Boolean(captionsEnabled), state.trackElements);
  video.addEventListener?.("error", onVideoError);

  const streamType = normalizeStreamType(source.streamType);
  const streamUrl = String(source.url);

  if (streamType === "dash") {
    await loadStreamingLibs({ hls: false, dash: true });
    if (state.destroyed || video.isConnected === false) {
      return destroy;
    }
    const dashjs = globalThis.dashjs;
    if (!dashjs || typeof dashjs.MediaPlayer !== "function") {
      triggerFatalError();
      return destroy;
    }
    try {
      const player = dashjs.MediaPlayer().create();
      if (!player) {
        triggerFatalError();
        return destroy;
      }
      state.dashPlayer = player;
      const logLevel = dashjs.Debug?.LOG_LEVEL_NONE ?? 0;
      player.updateSettings?.({
        debug: {
          logLevel
        },
        streaming: {
          scheduling: { scheduleWhilePaused: false },
          liveCatchup: { enabled: false }
        }
      });
      const events = dashjs.MediaPlayer?.events || {};
      if (events.ERROR) {
        player.on?.(events.ERROR, triggerFatalError);
      }
      if (events.PLAYBACK_ERROR) {
        player.on?.(events.PLAYBACK_ERROR, triggerFatalError);
      }
      player.initialize(video, streamUrl, Boolean(video.autoplay));
    } catch (_) {
      triggerFatalError();
    }
    return destroy;
  }

  if (streamType === "hls") {
    await loadStreamingLibs({ hls: true, dash: false });
    if (state.destroyed || video.isConnected === false) {
      return destroy;
    }
    const Hls = globalThis.Hls;
    if (Hls && typeof Hls.isSupported === "function" && Hls.isSupported()) {
      try {
        const hls = new Hls({
          enableWorker: true,
          startLevel: -1
        });
        state.hlsInstance = hls;
        if (Hls.Events?.ERROR) {
          hls.on?.(Hls.Events.ERROR, (_event, data = {}) => {
            if (data?.fatal) {
              triggerFatalError();
            }
          });
        }
        if (Hls.Events?.MANIFEST_PARSED) {
          hls.on?.(Hls.Events.MANIFEST_PARSED, () => {
            if (state.destroyed) {
              return;
            }
            try {
              hls.startLoad?.();
            } catch (_) {}
            if (video.autoplay) {
              const playPromise = video.play?.();
              playPromise?.catch?.(() => {});
            }
          });
        }
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        return destroy;
      } catch (_) {
        triggerFatalError();
        return destroy;
      }
    }
    if (
      typeof video.canPlayType === "function" &&
      video.canPlayType("application/vnd.apple.mpegurl")
    ) {
      video.src = streamUrl;
      try {
        video.load?.();
      } catch (_) {}
      if (video.autoplay) {
        video.play?.()?.catch?.(() => {});
      }
      return destroy;
    }
  }

  video.src = streamUrl;
  try {
    video.load?.();
  } catch (_) {}
  if (video.autoplay) {
    video.play?.()?.catch?.(() => {});
  }
  return destroy;
}

export function resetVetroTrailerResolverCircuitBreaker() {
  circuitOpenUntilMs = 0;
  activeBaseUrl = null;
}

export function __resetVetroTrailerResolverForTests() {
  resolvedTrailerCache.clear();
  inFlightRequests.clear();
  resetVetroTrailerResolverCircuitBreaker();
}
