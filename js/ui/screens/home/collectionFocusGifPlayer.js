const MAX_RAW_CACHE_ENTRIES = 20;
const MAX_RAW_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_SINGLE_RAW_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ACTIVE_BITMAP_BYTES = 36 * 1024 * 1024;
const LOOKAHEAD_BUFFER_FRAMES = 18;
const INITIAL_PREBUFFER_CAP = 10;
const DECODE_BATCH_CONCURRENCY = 4;
const TAIL_AHEAD_TARGET = 12;
const NEIGHBOR_PREFETCH_DELAY_MS = 700;
const MAX_NEIGHBOR_PREFETCH_ITEMS = 2;
const DEFAULT_FRAME_DURATION_MS = 40;
const MIN_FRAME_DURATION_MS = 16;
const TAIL_DECODE_PACE_MS = 12;

function yieldToRenderer(delayMs = 0) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

const rawByteCache = new Map();
let rawCacheTotalBytes = 0;
const rawInFlight = new Map();
const nodeSessions = new WeakMap();
let activeNode = null;
let neighborPrefetchTimer = null;
let neighborPrefetchAbort = null;

function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || "").trim());
}

function detectImageMimeType(url, buffer) {
  if (buffer && buffer.byteLength >= 12) {
    const view = new Uint8Array(buffer, 0, 12);
    if (
      view[0] === 0x52 &&
      view[1] === 0x49 &&
      view[2] === 0x46 &&
      view[3] === 0x46 &&
      view[8] === 0x57 &&
      view[9] === 0x45 &&
      view[10] === 0x42 &&
      view[11] === 0x50
    ) {
      return "image/webp";
    }
    if (view[0] === 0x47 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x38) {
      return "image/gif";
    }
  }
  const cleanUrl = String(url || "")
    .split(/[?#]/, 1)[0]
    .toLowerCase();
  if (cleanUrl.endsWith(".gif") || cleanUrl.endsWith(".gifv")) {
    return "image/gif";
  }
  if (cleanUrl.endsWith(".webp")) {
    return "image/webp";
  }
  return "";
}

function getCachedRawEntry(url) {
  const entry = rawByteCache.get(url);
  if (!entry) {
    return null;
  }
  rawByteCache.delete(url);
  rawByteCache.set(url, entry);
  return entry;
}

function putCachedRawEntry(url, buffer, contentType = "") {
  const byteLength = Number(buffer?.byteLength || 0);
  if (!url || !byteLength || byteLength > MAX_SINGLE_RAW_FILE_BYTES) {
    return;
  }
  const existing = rawByteCache.get(url);
  if (existing) {
    rawCacheTotalBytes = Math.max(0, rawCacheTotalBytes - existing.byteLength);
    rawByteCache.delete(url);
  }
  while (
    rawByteCache.size >= MAX_RAW_CACHE_ENTRIES ||
    (rawByteCache.size > 0 && rawCacheTotalBytes + byteLength > MAX_RAW_CACHE_BYTES)
  ) {
    const oldestKey = rawByteCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    const oldest = rawByteCache.get(oldestKey);
    rawCacheTotalBytes = Math.max(0, rawCacheTotalBytes - Number(oldest?.byteLength || 0));
    rawByteCache.delete(oldestKey);
  }
  if (byteLength <= MAX_RAW_CACHE_BYTES) {
    rawByteCache.set(url, { buffer, contentType, byteLength });
    rawCacheTotalBytes += byteLength;
  }
}

async function fetchRawGifBytes(url, signal = null) {
  const cached = getCachedRawEntry(url);
  if (cached) {
    return cached;
  }
  if (!isHttpUrl(url) || typeof globalThis.fetch !== "function") {
    return null;
  }
  let sharedPromise = rawInFlight.get(url);
  if (!sharedPromise) {
    sharedPromise = (async () => {
      const response = await globalThis.fetch(url, {
        mode: "cors",
        credentials: "omit"
      });
      if (!response || !response.ok) {
        return null;
      }
      const contentType = String(response.headers?.get?.("content-type") || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      const buffer = await response.arrayBuffer();
      if (!buffer || !buffer.byteLength) {
        return null;
      }
      putCachedRawEntry(url, buffer, contentType);
      return {
        buffer,
        contentType,
        byteLength: buffer.byteLength
      };
    })().finally(() => {
      if (rawInFlight.get(url) === sharedPromise) {
        rawInFlight.delete(url);
      }
    });
    rawInFlight.set(url, sharedPromise);
  }
  if (!signal) {
    return sharedPromise;
  }
  if (signal.aborted) {
    return null;
  }
  return Promise.race([
    sharedPromise,
    new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(null), { once: true });
    })
  ]);
}

function getTargetCanvasDimensions(node, gifNode, sourceWidth, sourceHeight) {
  const safeSrcW = Math.max(1, Math.round(Number(sourceWidth || 1)));
  const safeSrcH = Math.max(1, Math.round(Number(sourceHeight || 1)));
  const host =
    gifNode?.parentElement || node?.querySelector?.(".home-poster-frame") || gifNode || node;
  const cssW = Number(host?.clientWidth || 0);
  const cssH = Number(host?.clientHeight || 0);
  if (!(cssW > 0) || !(cssH > 0)) {
    return { width: safeSrcW, height: safeSrcH };
  }
  // Keep decoded frames at 1x CSS card dimensions on 4K TVs (2x DPR would
  // allocate up to 4x more pixels per frame and push loops over RAM budget).
  return {
    width: Math.max(1, Math.min(safeSrcW, Math.round(cssW))),
    height: Math.max(1, Math.min(safeSrcH, Math.round(cssH)))
  };
}

function cancelNeighborPrefetch() {
  if (neighborPrefetchTimer) {
    clearTimeout(neighborPrefetchTimer);
    neighborPrefetchTimer = null;
  }
  if (neighborPrefetchAbort) {
    try {
      neighborPrefetchAbort.abort();
    } catch (_) {}
    neighborPrefetchAbort = null;
  }
}

export function canUseCollectionFocusGifWebCodecs() {
  return Boolean(
    typeof globalThis.ImageDecoder === "function" &&
    typeof globalThis.fetch === "function" &&
    typeof globalThis.createImageBitmap === "function" &&
    typeof globalThis.document?.createElement === "function"
  );
}

function disposeSessionFrames(session) {
  if (!session?.frames) {
    return;
  }
  session.frames.forEach((slot) => {
    if (slot?.bitmap && typeof slot.bitmap.close === "function") {
      try {
        slot.bitmap.close();
      } catch (_) {}
    }
  });
  session.frames.clear();
}

function stopSession(node, session, { resetVisibility = true, cancelToken = true } = {}) {
  if (!session) {
    return;
  }
  if (cancelToken) {
    session.cancelled = true;
    session.token += 1;
  }
  if (session.rafId) {
    cancelAnimationFrame(session.rafId);
    session.rafId = 0;
  }
  if (session.abortController) {
    try {
      session.abortController.abort();
    } catch (_) {}
    session.abortController = null;
  }
  if (session.decoder && typeof session.decoder.close === "function") {
    try {
      session.decoder.close();
    } catch (_) {}
    session.decoder = null;
  }
  disposeSessionFrames(session);
  if (session.canvas) {
    try {
      session.canvas.width = 0;
      session.canvas.height = 0;
      if (typeof session.canvas.remove === "function") {
        session.canvas.remove();
      } else {
        session.canvas.parentNode?.removeChild?.(session.canvas);
      }
    } catch (_) {}
    session.canvas = null;
  }
  if (resetVisibility && node) {
    node.classList?.remove?.("is-focus-gif-canvas-mode");
    node.classList?.remove?.("is-focus-gif-active");
  }
  if (activeNode === node) {
    activeNode = null;
  }
}

function scheduleAdjacentCollectionGifPrefetch(screen, focusedNode) {
  cancelNeighborPrefetch();
  if (
    !screen?.navModel?.rows ||
    !focusedNode ||
    !isHttpUrl(focusedNode?.querySelector?.(".home-poster-focus-gif")?.dataset?.src)
  ) {
    return;
  }
  if (!canUseCollectionFocusGifWebCodecs()) {
    return;
  }
  neighborPrefetchTimer = setTimeout(() => {
    neighborPrefetchTimer = null;
    if (screen?.modernVerticalFastScrollState || typeof globalThis.fetch !== "function") {
      return;
    }
    if (
      typeof screen.getCurrentFocusedNode === "function" &&
      screen.getCurrentFocusedNode() !== focusedNode
    ) {
      return;
    }
    const rowIdx = Number(focusedNode.dataset?.navRow);
    const colIdx = Number(focusedNode.dataset?.navCol);
    const rows = screen.navModel?.rows || [];
    const candidates = [];
    const currentRow = Number.isInteger(rowIdx) ? rows[rowIdx] || [] : [];
    [colIdx + 1, colIdx + 2, colIdx - 1].forEach((col) => {
      if (col >= 0 && col < currentRow.length) {
        candidates.push(currentRow[col]);
      }
    });
    const nextRow = Number.isInteger(rowIdx) ? rows[rowIdx + 1] || [] : [];
    if (nextRow.length && Number.isInteger(colIdx)) {
      const nextCard = nextRow[Math.min(colIdx, nextRow.length - 1)];
      if (nextCard) {
        candidates.push(nextCard);
      }
    }
    const urls = [];
    for (const candidate of candidates) {
      const url = String(
        candidate?.querySelector?.(".home-poster-focus-gif")?.dataset?.src || ""
      ).trim();
      if (url && isHttpUrl(url) && !rawByteCache.has(url) && !urls.includes(url)) {
        urls.push(url);
        if (urls.length >= MAX_NEIGHBOR_PREFETCH_ITEMS) {
          break;
        }
      }
    }
    if (!urls.length) {
      return;
    }
    const abortController = new AbortController();
    neighborPrefetchAbort = abortController;
    void (async () => {
      for (const url of urls) {
        if (abortController.signal.aborted) {
          return;
        }
        try {
          await fetchRawGifBytes(url, abortController.signal);
        } catch (_) {
          // Best-effort warmup only.
        }
        if (!abortController.signal.aborted) {
          await yieldToRenderer(40);
        }
      }
    })();
  }, NEIGHBOR_PREFETCH_DELAY_MS);
}

function applyImageFallback(node, gifNode, src, session, token) {
  if (!gifNode || session.cancelled || session.token !== token || node?.isConnected === false) {
    return;
  }
  node.classList?.remove?.("is-focus-gif-canvas-mode");
  if (!gifNode.getAttribute?.("src")) {
    gifNode.setAttribute("src", src);
  }
  if (typeof gifNode.decode === "function") {
    Promise.resolve(gifNode.decode())
      .catch(() => {})
      .then(() => {
        if (session.cancelled || session.token !== token || node?.isConnected === false) {
          return;
        }
        if (node.classList?.contains?.("focused") !== false) {
          node.classList?.add?.("is-focus-gif-active");
        }
      });
    return;
  }
  node.classList?.add?.("is-focus-gif-active");
}

export const collectionFocusGifPlayer = {
  activate({ screen = null, node, gifNode, src } = {}) {
    if (!node || !gifNode || !src) {
      return;
    }
    if (activeNode && activeNode !== node) {
      this.deactivate(activeNode);
    }
    let session = nodeSessions.get(node);
    if (session) {
      if (
        !session.cancelled &&
        session.src === src &&
        node.classList?.contains?.("is-focus-gif-active")
      ) {
        return;
      }
      stopSession(node, session, { resetVisibility: false });
    }
    session = {
      src,
      token: (session?.token || 0) + 1,
      cancelled: false,
      abortController:
        typeof globalThis.AbortController === "function" ? new AbortController() : null,
      decoder: null,
      frames: new Map(),
      canvas: null,
      rafId: 0
    };
    nodeSessions.set(node, session);
    activeNode = node;
    const token = session.token;

    if (!canUseCollectionFocusGifWebCodecs() || !isHttpUrl(src)) {
      applyImageFallback(node, gifNode, src, session, token);
      return;
    }

    const isStillValid = () =>
      !session.cancelled &&
      session.token === token &&
      node.isConnected !== false &&
      (!node.classList?.contains || node.classList.contains("focused")) &&
      (!screen ||
        typeof screen.getCurrentFocusedNode !== "function" ||
        screen.getCurrentFocusedNode() === node);

    void (async () => {
      try {
        const fetched = await fetchRawGifBytes(src, session.abortController?.signal || null);
        if (!isStillValid()) {
          return;
        }
        if (!fetched?.buffer) {
          applyImageFallback(node, gifNode, src, session, token);
          return;
        }
        const mimeType = detectImageMimeType(src, fetched.buffer) || fetched.contentType;
        if (!mimeType) {
          applyImageFallback(node, gifNode, src, session, token);
          return;
        }
        const supported = await globalThis.ImageDecoder.isTypeSupported(mimeType).catch(
          () => false
        );
        if (!isStillValid()) {
          return;
        }
        if (!supported) {
          applyImageFallback(node, gifNode, src, session, token);
          return;
        }
        const decoder = new globalThis.ImageDecoder({
          data: fetched.buffer.slice(0),
          type: mimeType
        });
        session.decoder = decoder;
        await decoder.tracks.ready;
        if (!isStillValid()) {
          stopSession(node, session);
          return;
        }
        const track = decoder.tracks.selectedTrack;
        const frameCount = Math.max(0, Number(track?.frameCount || 0));
        if (frameCount <= 1) {
          stopSession(node, session, { resetVisibility: false, cancelToken: false });
          applyImageFallback(node, gifNode, src, session, token);
          return;
        }

        const firstResult = await decoder.decode({ frameIndex: 0 });
        const firstVideoFrame = firstResult?.image || null;
        if (!isStillValid() || !firstVideoFrame) {
          try {
            firstVideoFrame?.close?.();
          } catch (_) {}
          if (isStillValid()) {
            applyImageFallback(node, gifNode, src, session, token);
          }
          return;
        }

        const dims = getTargetCanvasDimensions(
          node,
          gifNode,
          firstVideoFrame.displayWidth || firstVideoFrame.codedWidth,
          firstVideoFrame.displayHeight || firstVideoFrame.codedHeight
        );
        const needResize =
          dims.width < (firstVideoFrame.displayWidth || firstVideoFrame.codedWidth) ||
          dims.height < (firstVideoFrame.displayHeight || firstVideoFrame.codedHeight);
        const resizeOpts = needResize
          ? { resizeWidth: dims.width, resizeHeight: dims.height, resizeQuality: "low" }
          : undefined;
        const firstBitmap = await globalThis.createImageBitmap(firstVideoFrame, resizeOpts);
        const firstDurationMs = Math.max(
          MIN_FRAME_DURATION_MS,
          Number(firstVideoFrame.duration || 0) > 0
            ? Number(firstVideoFrame.duration) / 1000
            : DEFAULT_FRAME_DURATION_MS
        );
        try {
          firstVideoFrame.close();
        } catch (_) {}
        if (!isStillValid()) {
          firstBitmap.close?.();
          return;
        }
        session.frames.set(0, { bitmap: firstBitmap, durationMs: firstDurationMs });

        const bytesPerFrame = dims.width * dims.height * 4;
        const cacheAllFrames = frameCount * bytesPerFrame <= MAX_ACTIVE_BITMAP_BYTES;
        const maxWindowFrames = cacheAllFrames
          ? frameCount
          : Math.max(
              8,
              Math.min(
                LOOKAHEAD_BUFFER_FRAMES,
                Math.floor(MAX_ACTIVE_BITMAP_BYTES / Math.max(1, bytesPerFrame))
              )
            );
        const initialTargetCount = Math.min(
          frameCount,
          cacheAllFrames ? Math.min(frameCount, INITIAL_PREBUFFER_CAP) : maxWindowFrames
        );

        const decodeFrameAt = async (index) => {
          if (session.frames.has(index) || !session.decoder || !isStillValid()) {
            return Boolean(session.frames.has(index));
          }
          const result = await session.decoder.decode({ frameIndex: index });
          const videoFrame = result?.image || null;
          if (!videoFrame) {
            return false;
          }
          let bitmap = null;
          const durationMs = Math.max(
            MIN_FRAME_DURATION_MS,
            Number(videoFrame.duration || 0) > 0
              ? Number(videoFrame.duration) / 1000
              : DEFAULT_FRAME_DURATION_MS
          );
          try {
            if (!isStillValid()) {
              return false;
            }
            bitmap = await globalThis.createImageBitmap(videoFrame, resizeOpts);
          } finally {
            try {
              videoFrame.close();
            } catch (_) {}
          }
          if (!isStillValid()) {
            bitmap?.close?.();
            return false;
          }
          session.frames.set(index, { bitmap, durationMs });
          return true;
        };

        for (let i = 1; i < initialTargetCount; i += DECODE_BATCH_CONCURRENCY) {
          const batchIndices = [];
          for (let k = i; k < Math.min(initialTargetCount, i + DECODE_BATCH_CONCURRENCY); k += 1) {
            batchIndices.push(k);
          }
          const results = await Promise.all(batchIndices.map((idx) => decodeFrameAt(idx)));
          if (!isStillValid() || results.some((ok) => !ok)) {
            break;
          }
        }
        if (!isStillValid()) {
          stopSession(node, session);
          return;
        }

        const parent = gifNode.parentElement || gifNode.parentNode;
        const canvas = globalThis.document.createElement("canvas");
        canvas.className = "home-poster-focus-gif-canvas";
        canvas.setAttribute("aria-hidden", "true");
        canvas.width = dims.width;
        canvas.height = dims.height;
        const ctx = canvas.getContext("2d", { alpha: true });
        if (!parent || !ctx) {
          stopSession(node, session, { resetVisibility: false, cancelToken: false });
          applyImageFallback(node, gifNode, src, session, token);
          return;
        }

        gifNode.removeAttribute?.("src");
        parent.insertBefore(canvas, gifNode.nextSibling || null);
        session.canvas = canvas;
        ctx.globalCompositeOperation = "copy";
        ctx.drawImage(firstBitmap, 0, 0, dims.width, dims.height);
        node.classList.add("is-focus-gif-canvas-mode");
        node.classList.add("is-focus-gif-active");
        scheduleAdjacentCollectionGifPrefetch(screen, node);

        let playIndex = 0;
        let nextDecodeCursor = initialTargetCount % frameCount;
        let decodingActive = false;
        let lastTickAt = globalThis.performance?.now?.() || Date.now();
        let accumulatedMs = 0;

        const countDecodedAhead = () => {
          let ahead = 0;
          for (let offset = 1; offset < frameCount; offset += 1) {
            if (!session.frames.has((playIndex + offset) % frameCount)) {
              break;
            }
            ahead += 1;
            if (ahead >= TAIL_AHEAD_TARGET) break;
          }
          return ahead;
        };

        const nextBatchIndices = () => {
          const batchIndices = [];
          if (cacheAllFrames) {
            let scanned = 0;
            while (
              scanned < frameCount &&
              batchIndices.length < DECODE_BATCH_CONCURRENCY &&
              session.frames.size + batchIndices.length < frameCount
            ) {
              const idx = nextDecodeCursor;
              nextDecodeCursor = (nextDecodeCursor + 1) % frameCount;
              scanned += 1;
              if (!session.frames.has(idx) && !batchIndices.includes(idx)) {
                batchIndices.push(idx);
              }
            }
            return batchIndices;
          }
          for (
            let offset = 0;
            offset < maxWindowFrames && batchIndices.length < DECODE_BATCH_CONCURRENCY;
            offset += 1
          ) {
            const candidateIdx = (playIndex + offset) % frameCount;
            if (!session.frames.has(candidateIdx) && !batchIndices.includes(candidateIdx)) {
              batchIndices.push(candidateIdx);
            }
          }
          return batchIndices;
        };

        const pumpDecodeAhead = async () => {
          if (decodingActive || !session.decoder || !isStillValid()) {
            return;
          }
          decodingActive = true;
          try {
            const targetSize = cacheAllFrames ? frameCount : maxWindowFrames;
            while (isStillValid() && session.frames.size < targetSize) {
              const batchIndices = nextBatchIndices();
              if (!batchIndices.length) {
                break;
              }
              const results = await Promise.all(batchIndices.map((idx) => decodeFrameAt(idx)));
              if (!results.some(Boolean)) {
                break;
              }
              if (isStillValid()) {
                const delayMs = countDecodedAhead() >= TAIL_AHEAD_TARGET ? TAIL_DECODE_PACE_MS : 0;
                await yieldToRenderer(delayMs);
              }
            }
            if (cacheAllFrames && session.frames.size >= frameCount && session.decoder) {
              try {
                session.decoder.close();
              } catch (_) {}
              session.decoder = null;
            }
          } catch (_) {
            // Decode error during background loop falls back cleanly on next check.
          } finally {
            decodingActive = false;
          }
        };

        void pumpDecodeAhead();

        const tick = (now) => {
          if (!isStillValid() || session.canvas !== canvas) {
            return;
          }
          const deltaMs = Math.max(0, Math.min(120, now - lastTickAt));
          lastTickAt = now;
          accumulatedMs += deltaMs;

          let currentSlot = session.frames.get(playIndex);
          let frameChanged = false;
          let guard = 0;
          while (currentSlot && accumulatedMs + 2 >= currentSlot.durationMs && guard < 4) {
            const nextIndex = (playIndex + 1) % frameCount;
            const nextSlot = session.frames.get(nextIndex);
            if (!nextSlot) {
              accumulatedMs = currentSlot.durationMs;
              break;
            }
            accumulatedMs = Math.max(0, accumulatedMs - currentSlot.durationMs);
            if (!cacheAllFrames && playIndex !== nextIndex) {
              const expired = session.frames.get(playIndex);
              session.frames.delete(playIndex);
              expired?.bitmap?.close?.();
            }
            playIndex = nextIndex;
            currentSlot = nextSlot;
            frameChanged = true;
            guard += 1;
          }

          if (frameChanged && currentSlot?.bitmap) {
            ctx.globalCompositeOperation = "copy";
            ctx.drawImage(currentSlot.bitmap, 0, 0, dims.width, dims.height);
            if (!cacheAllFrames && !decodingActive) {
              void pumpDecodeAhead();
            }
          }

          session.rafId = requestAnimationFrame(tick);
        };

        session.rafId = requestAnimationFrame(tick);
      } catch (_) {
        if (isStillValid()) {
          stopSession(node, session, { resetVisibility: false, cancelToken: false });
          applyImageFallback(node, gifNode, src, session, token);
        } else {
          stopSession(node, session);
        }
      }
    })();
  },

  deactivate(node) {
    if (!node) {
      return;
    }
    const session = nodeSessions.get(node);
    if (session) {
      stopSession(node, session, { resetVisibility: true });
    } else {
      node.classList?.remove?.("is-focus-gif-canvas-mode");
      node.classList?.remove?.("is-focus-gif-active");
    }
    const gifNode = node.querySelector?.(".home-poster-focus-gif") || null;
    if (gifNode) {
      gifNode.removeAttribute?.("src");
    }
  },

  teardown() {
    cancelNeighborPrefetch();
    if (activeNode) {
      this.deactivate(activeNode);
      activeNode = null;
    }
    rawByteCache.clear();
    rawCacheTotalBytes = 0;
  },

  _debugStats() {
    return {
      rawEntries: rawByteCache.size,
      rawBytes: rawCacheTotalBytes,
      activeNode
    };
  }
};
