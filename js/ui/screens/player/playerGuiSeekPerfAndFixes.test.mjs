import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { syncHtmlSubtitleClearance } from "./subtitleOverlayClearance.js";
import { createPlayerControllerMethods01 } from "../../../core/player/playerControllerMethods-01-is-expected-play-interruption.js";
import { createPlayerControllerMethods03 } from "../../../core/player/playerControllerMethods-03-start-av-play-tick-timer.js";
import { createWebOsExactSeekMethods } from "../../../platform/webos/webosExactSeek.js";

function loadMethodsFile(relativePath, exportName, internals = {}, extraBindings = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const stripped = source
    .replace(/^import .*;\r?\n/gm, "")
    .replace(/export function /g, "function ");
  const extraKeys = Object.keys(extraBindings);
  const extraValues = Object.values(extraBindings);
  return new Function(
    "internals",
    ...extraKeys,
    `"use strict";\n${stripped}\nreturn ${exportName}();`
  )(internals, ...extraValues);
}

function makeClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    contains: (name) => set.has(name),
    toggle: (name, force) => {
      if (force === undefined) {
        if (set.has(name)) {
          set.delete(name);
          return false;
        }
        set.add(name);
        return true;
      }
      if (force) set.add(name);
      else set.delete(name);
      return Boolean(force);
    }
  };
}

test("syncHtmlSubtitleClearance caches layout reads until visibility, size, offset, or force changes", () => {
  let rootRectCalls = 0;
  let childRectCalls = 0;
  let clientRectCalls = 0;
  let computedStyleCalls = 0;
  const originalGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => {
    computedStyleCalls += 1;
    return { display: "block", visibility: "visible" };
  };

  try {
    const props = new Map();
    const makeOverlayNode = (top) => ({
      classList: makeClassList(),
      getClientRects: () => {
        clientRectCalls += 1;
        return [1];
      },
      getBoundingClientRect: () => {
        childRectCalls += 1;
        return { top, height: 40 };
      }
    });

    const root = {
      clientWidth: 1920,
      clientHeight: 1080,
      style: {
        getPropertyValue: (k) => props.get(k) || "",
        setProperty: (k, v) => props.set(k, v)
      },
      getBoundingClientRect: () => {
        rootRectCalls += 1;
        return { bottom: 1080, height: 1080 };
      }
    };

    const placements = [];
    const screen = {
      controlsVisible: true,
      controlsHideUntil: 0,
      seekOverlayVisible: false,
      subtitleDialogVisible: false,
      subtitleStyleSettings: { verticalOffset: 0 },
      assSubtitleRenderer: { setPlacement: (p) => placements.push(p) },
      uiRefs: {
        root,
        controlsOverlay: { classList: makeClassList() },
        controlsBottom: makeOverlayNode(880),
        skipIntro: makeOverlayNode(800),
        nextEpisodeCard: makeOverlayNode(760),
        seekOverlay: makeOverlayNode(920)
      }
    };

    syncHtmlSubtitleClearance(screen);
    assert.equal(rootRectCalls, 1);
    assert.ok(childRectCalls > 0);
    assert.ok(computedStyleCalls > 0);
    assert.equal(placements.length, 1);

    const prevRoot = rootRectCalls;
    const prevChild = childRectCalls;
    const prevClient = clientRectCalls;
    const prevStyle = computedStyleCalls;

    // Repeated ticks with identical layout state perform zero reflow reads.
    syncHtmlSubtitleClearance(screen);
    syncHtmlSubtitleClearance(screen);
    assert.equal(rootRectCalls, prevRoot);
    assert.equal(childRectCalls, prevChild);
    assert.equal(clientRectCalls, prevClient);
    assert.equal(computedStyleCalls, prevStyle);

    // Assigning a new assSubtitleRenderer pushes cached placement without reflow.
    const latePlacements = [];
    screen.assSubtitleRenderer = { setPlacement: (p) => latePlacements.push(p) };
    syncHtmlSubtitleClearance(screen);
    assert.equal(latePlacements.length, 1);
    assert.equal(rootRectCalls, prevRoot);

    // Changing root dimensions or force busts cache cleanly.
    root.clientHeight = 720;
    syncHtmlSubtitleClearance(screen);
    assert.equal(rootRectCalls, prevRoot + 1);

    syncHtmlSubtitleClearance(screen, { force: true });
    assert.equal(rootRectCalls, prevRoot + 2);
  } finally {
    globalThis.getComputedStyle = originalGetComputedStyle;
  }
});

test("syncPlayerActionOverlayOffset caches measurements across ticks until controls reopen or resize", () => {
  const methods29 = loadMethodsFile(
    "./playerScreenMethods-29-sync-post-play-player-surface.js",
    "createPlayerScreenMethods29",
    {
      PlayerController: {},
      Environment: { isTizen: () => false, isWebOS: () => false },
      STARTUP_PLAYBACK_ADVANCE_EPSILON_SECONDS: 0.1,
      BUFFERING_SPINNER_STALL_MS: 500,
      interpolatePostPlayRect: () => ({})
    },
    {
      LiveDurationGrowth: class {},
      isLivePlayback: () => false,
      nextLiveDurationGrowth: () => ({}),
      focusWithoutScroll: () => {},
      CONTROLS_HIDE_TRANSITION_MS: 200,
      syncHtmlSubtitleClearance: () => {}
    }
  );

  let measureCalls = 0;
  const props = new Map();
  const root = {
    clientWidth: 1920,
    clientHeight: 1080,
    style: {
      setProperty: (k, v) => props.set(k, v),
      removeProperty: (k) => props.delete(k)
    }
  };
  const screen = Object.assign(Object.create(methods29), {
    controlsVisible: true,
    renderedControlSignature: "sig-1",
    lastActionOverlayBottomPx: null,
    lastActionOverlayMeasureKey: "",
    lastActionOverlayRoot: null,
    isExternalFrameMode: () => false,
    measurePlayerActionOverlayOffset: () => {
      measureCalls += 1;
      return 240;
    },
    uiRefs: {
      root,
      playbackBadges: { hidden: true },
      chapterTitle: { classList: makeClassList(["hidden"]) },
      progressShell: { classList: makeClassList() }
    }
  });

  screen.syncPlayerActionOverlayOffset();
  assert.equal(measureCalls, 1);
  assert.equal(props.get("--player-action-controls-open-bottom"), "240px");

  // Repeated 250ms ticks do not re-measure.
  screen.syncPlayerActionOverlayOffset();
  screen.syncPlayerActionOverlayOffset();
  assert.equal(measureCalls, 1);

  // Closing and reopening controls re-measures once.
  screen.controlsVisible = false;
  screen.syncPlayerActionOverlayOffset();
  assert.equal(props.has("--player-action-controls-open-bottom"), false);
  screen.controlsVisible = true;
  screen.syncPlayerActionOverlayOffset();
  assert.equal(measureCalls, 2);

  // Changing markup signature re-measures once.
  screen.renderedControlSignature = "sig-2";
  screen.syncPlayerActionOverlayOffset();
  assert.equal(measureCalls, 3);
});

test("syncControlFocusDom skips heavy overlay work on pure focus moves when controls DOM matches", () => {
  const originalDocument = globalThis.document;
  const makeButton = (action) => ({
    dataset: { action },
    classList: makeClassList(),
    focused: false,
    focus() {
      this.focused = true;
      globalThis.document.activeElement = this;
    },
    blur() {
      this.focused = false;
    }
  });
  const btn0 = makeButton("playPause");
  const btn1 = makeButton("source");
  globalThis.document = { activeElement: btn0 };

  try {
    const methods28 = loadMethodsFile(
      "./playerScreenMethods-28-unbind-video-events.js",
      "createPlayerScreenMethods28",
      {
        PlayerController: {},
        t: (_k, _p, f) => f,
        clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
        escapeHtml: (v) => String(v || "")
      },
      { PartyRepository: { getState: () => ({}) } }
    );

    const calls = [];
    const controls = [{ action: "playPause" }, { action: "source" }];
    const screen = Object.assign(Object.create(methods28), {
      controlFocusZone: "buttons",
      controlFocusIndex: 1,
      isExternalFrameMode: () => false,
      getControlDefinitions: () => controls,
      getControlRenderSignature: () => "sig-match",
      renderedControlSignature: "sig-match",
      uiRefs: {
        controlButtons: { querySelectorAll: () => [btn0, btn1] },
        progressShell: { classList: makeClassList(), focus() {}, blur() {} }
      },
      renderControlButtons: () => calls.push("renderControlButtons"),
      syncSkipIntroFocusState: () => calls.push("syncSkipIntroFocusState"),
      syncNextEpisodeCardFocusState: () => calls.push("syncNextEpisodeCardFocusState"),
      renderNextEpisodeCard: () => calls.push("renderNextEpisodeCard"),
      syncPlayerOverlayLayoutState: () => calls.push("syncPlayerOverlayLayoutState"),
      renderBitmapSubtitleAtCurrentTime: () => calls.push("renderBitmapSubtitleAtCurrentTime")
    });

    screen.syncControlFocusDom();
    assert.equal(btn0.classList.contains("focused"), false);
    assert.equal(btn1.classList.contains("focused"), true);
    assert.equal(globalThis.document.activeElement, btn1);
    assert.deepEqual(calls, ["syncSkipIntroFocusState", "syncNextEpisodeCardFocusState"]);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("beginSeekPreview toggles is-seeking on uiRefs.root and clears it on commit/cancel", () => {
  const methods32 = loadMethodsFile(
    "./playerScreenMethods-32-update-ui-tick.js",
    "createPlayerScreenMethods32",
    {
      renderPlayerImageBadgeChip: () => "",
      getTrackLanguageLabel: () => "",
      PlayerController: { video: {} },
      PlayerSettingsStore: { get: () => ({}) },
      deltaMsForKeyRepeat: () => 10000,
      calculateRemainingPlaybackMilliseconds: () => 0,
      t: (_k, _p, f) => f,
      formatTime: (s) => `${Math.floor(s)}`,
      formatClock: () => "",
      formatEndsAt: () => "",
      clamp: (v, min, max) => Math.min(max, Math.max(min, v))
    },
    {
      syncPlayerPlaybackBadges: () => {},
      syncHtmlSubtitleClearance: () => {},
      MediaServerScrobbleService: { update() {} }
    }
  );

  const root = { classList: makeClassList() };
  const makeNode = () => ({
    textContent: "",
    style: {},
    classList: makeClassList(),
    setAttribute() {}
  });
  const screen = Object.assign(Object.create(methods32), {
    controlsVisible: true,
    controlFocusZone: "progress",
    seekPreviewSeconds: null,
    seekPreviewDirection: 0,
    seekRepeatCount: 0,
    uiRefs: {
      root,
      progressFill: makeNode(),
      timeLabel: makeNode(),
      progressShell: makeNode(),
      seekOverlay: makeNode(),
      seekDirection: makeNode(),
      seekPreview: makeNode(),
      seekFill: makeNode()
    },
    isSeekBarAvailable: () => true,
    isLivePlayback: () => false,
    getPlaybackCurrentSeconds: () => 100,
    getPlaybackDisplayCurrentSeconds: () => 100,
    getPlaybackDurationSeconds: () => 1000,
    getPlaybackDisplayDurationSeconds: () => 1000,
    seekPlaybackSeconds() {},
    suppressControlsForHiddenSeek() {},
    focusProgressBar() {},
    scheduleProgressBarRefocus() {},
    resetControlsAutoHide() {}
  });

  screen.beginSeekPreview(1, false, true);
  assert.equal(root.classList.contains("is-seeking"), true);
  screen.commitSeekPreview();
  clearTimeout(screen.seekOverlayTimer);
  assert.equal(root.classList.contains("is-seeking"), false);

  screen.beginSeekPreview(1, false, true);
  assert.equal(root.classList.contains("is-seeking"), true);
  screen.cancelSeekPreview();
  assert.equal(root.classList.contains("is-seeking"), false);
});

test("playerPlaybackBadges avoids Array.from and JSON.stringify on steady-state ticks", async () => {
  const storage = new Map();
  globalThis.localStorage ??= {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k)
  };
  const { StreamBadgeSettingsStore } =
    await import("../../../data/local/streamBadgeSettingsStore.js");
  const { syncPlayerPlaybackBadges } = await import("./playerPlaybackBadges.js");
  StreamBadgeSettingsStore.set({ showInPlayer: true }, { silentSync: true });

  const node = { innerHTML: "", hidden: true };
  const screen = {
    uiRefs: { playbackBadges: node },
    controlsVisible: true,
    selectedAudioTrackIndex: 0
  };
  const controller = {
    playbackEngine: "html5",
    video: {
      currentSrc: "https://example.test/a.mp4",
      videoWidth: 1920,
      videoHeight: 1080,
      audioTracks: [{ enabled: true }]
    }
  };

  syncPlayerPlaybackBadges(
    screen,
    controller,
    () => "",
    () => ""
  );

  const origArrayFrom = Array.from;
  const origJsonStringify = JSON.stringify;
  let allocations = 0;
  Array.from = (...args) => {
    allocations += 1;
    return origArrayFrom(...args);
  };
  JSON.stringify = (...args) => {
    allocations += 1;
    return origJsonStringify(...args);
  };
  try {
    syncPlayerPlaybackBadges(
      screen,
      controller,
      () => "",
      () => ""
    );
    assert.equal(allocations, 0);
  } finally {
    Array.from = origArrayFrom;
    JSON.stringify = origJsonStringify;
  }
});

test("renderBitmapSubtitleAtCurrentTime preserves canvas dimensions when viewport and cue size are unchanged", () => {
  const methods45 = loadMethodsFile(
    "./playerScreenMethods-45-load-bitmap-subtitle-window.js",
    "createPlayerScreenMethods45",
    {
      PlayerController: { video: {}, getPlayerViewportSize: () => ({ width: 3840, height: 2160 }) },
      localMediaBitmapSubtitleRepository: {},
      getSubtitleVerticalOffsetVh: () => 0,
      BitmapSubtitleDecoder: class {},
      BITMAP_SUBTITLE_WINDOW_SECONDS: 60,
      BITMAP_SUBTITLE_PREFETCH_SECONDS: 10,
      BITMAP_SUBTITLE_WINDOW_BUCKET_SECONDS: 30,
      normalizeWebOsHtmlSubtitleText: (v) => v,
      getEmbeddedSubtitleSupportState: () => ({ supported: true }),
      isBitmapSubtitleSupportError: () => false,
      clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
      normalizeSubtitleFontSize: (v) => Number(v || 100)
    },
    {
      stripSubtitleSdh: (v) => v,
      buildHtmlSubtitleCueIndex: () => null,
      findActiveHtmlSubtitleCues: () => ({ activeCues: [], nextBoundarySeconds: 0 }),
      hdrSubtitleBrightnessFactor: () => 1,
      scaleRgbaBrightness: () => {}
    }
  );

  let mainWidthWrites = 0;
  let mainHeightWrites = 0;
  let clearRectCalls = 0;
  let createImageDataCalls = 0;
  const makeTrackedCanvas = (trackMain) => {
    let _w = 0;
    let _h = 0;
    const ctx = {
      clearRect: () => {
        clearRectCalls += 1;
      },
      createImageData: (w, h) => {
        createImageDataCalls += 1;
        return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      },
      putImageData: () => {},
      drawImage: () => {}
    };
    return {
      get width() {
        return _w;
      },
      set width(v) {
        if (trackMain) mainWidthWrites += 1;
        _w = v;
      },
      get height() {
        return _h;
      },
      set height(v) {
        if (trackMain) mainHeightWrites += 1;
        _h = v;
      },
      classList: makeClassList(["hidden"]),
      setAttribute() {},
      getContext: () => ctx
    };
  };

  let cueKey = "cue-1";
  const rgba = new Uint8ClampedArray(4 * 4 * 4).fill(255);
  const screen = Object.assign(Object.create(methods45), {
    bitmapSubtitleTrack: { bitmapSubtitle: true },
    bitmapSubtitleWindowStart: 0,
    bitmapSubtitleWindowEnd: 60,
    bitmapSubtitleLoading: false,
    bitmapSubtitleScratchCanvas: makeTrackedCanvas(false),
    bitmapSubtitleDecoder: {
      renderAtSeconds: () => ({
        key: cueKey,
        screenWidth: 1920,
        screenHeight: 1080,
        compositions: [{ x: 100, y: 100, width: 4, height: 4, rgba }]
      })
    },
    subtitleDelayMs: 0,
    subtitleStyleSettings: { fontSize: 100, verticalOffset: 0 },
    uiRefs: { bitmapSubtitles: makeTrackedCanvas(true) },
    getPlaybackCurrentSeconds: () => 2,
    getAspectModeDefinition: () => ({ id: "fit" }),
    calculateAspectRect: () => ({ x: 0, y: 0, width: 3840, height: 2160, scaleX: 1, scaleY: 1 })
  });

  assert.equal(screen.renderBitmapSubtitleAtCurrentTime(), true);
  assert.equal(mainWidthWrites, 1);
  assert.equal(mainHeightWrites, 1);
  assert.equal(createImageDataCalls, 1);

  cueKey = "cue-2";
  assert.equal(screen.renderBitmapSubtitleAtCurrentTime(), true);
  assert.equal(mainWidthWrites, 1, "must not reallocate 4K canvas on second cue");
  assert.equal(mainHeightWrites, 1, "must not reallocate 4K canvas on second cue");
  assert.equal(createImageDataCalls, 1, "reuses scratch ImageData for same cue dimensions");
  assert.ok(clearRectCalls >= 2);
});

test("pluginWorker settles async fetch without setTimeout(0) busy polling", async () => {
  const workerSource = await readFile(
    new URL("../../../core/player/pluginWorker.js", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(workerSource, /setTimeout\s*\(\s*resolve\s*,\s*0\s*\)/);

  const builtWorkerSource = await readFile(
    new URL("../../../../dist/assets/runtime/plugin-worker.js", import.meta.url),
    "utf8"
  );
  const quickJsSource = await readFile(
    new URL("../../../../dist/assets/libs/quickjs-emscripten.global.js", import.meta.url),
    "utf8"
  );

  const posted = [];
  const timeoutDelays = [];
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });

  const sandbox = {
    console,
    WebAssembly,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    setTimeout: (fn, ms) => {
      timeoutDelays.push(Number(ms));
      return setTimeout(fn, ms);
    },
    clearTimeout,
    atob,
    btoa,
    postMessage: (msg) => {
      posted.push(msg);
      if (msg.type === "fetch") {
        setTimeout(() => {
          sandbox.onmessage({
            data: {
              type: "fetchResult",
              requestId: msg.requestId,
              payload: {
                ok: true,
                status: 200,
                statusText: "OK",
                url: "https://example.test/api",
                headers: {},
                body: JSON.stringify([{ name: "Test", url: "https://example.test/video.mp4" }])
              }
            }
          });
        }, 15);
      } else if (msg.type === "result" || msg.type === "error") {
        finish(msg);
      }
    }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext("self = this", context);
  sandbox.importScripts = () => vm.runInContext(quickJsSource, context);
  vm.runInContext(builtWorkerSource, context);

  sandbox.onmessage({
    data: {
      type: "execute",
      filename: "async-fetch-test.js",
      code: "module.exports.getStreams = async function(){ var r = await fetch('https://example.test/api'); return await r.json(); };",
      timeoutMs: 5000
    }
  });

  const result = await done;
  assert.equal(result.type, "result", result.error);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].name, "Test");
  assert.ok(
    !timeoutDelays.includes(0),
    `unexpected setTimeout(0) busy loop delays: ${timeoutDelays}`
  );
});

test("source startup timeout arms for switched/initial stream and always clears in cleanup", async () => {
  const methods34 = loadMethodsFile(
    "./playerScreenMethods-34-play-stream-by-url.js",
    "createPlayerScreenMethods34",
    {
      PlayerController: { playRequestToken: 1, clearWebOsTrackSelections() {} },
      shouldAllowNativePlaybackDuringStartupAudioGate: () => false,
      isExpiredStreamUrl: () => false,
      Environment: { isWebOS: () => false, isTizen: () => false },
      WEBOS_REMOTE_MKV_AUDIO_GATE_MAX_WAIT_MS: 0,
      claimEngineFsPlayback: () => ""
    },
    {
      LastPlaybackStore: { remember() {} }
    }
  );
  const methods35 = loadMethodsFile(
    "./playerScreenMethods-35-play-stream-candidate.js",
    "createPlayerScreenMethods35",
    {
      streamRepository: { setLocalPluginSearchPaused() {} },
      TorrentSettingsStore: { get: () => ({ p2pEnabled: false }) },
      DirectDebridResolver: { canResolveStream: () => false },
      WebOsEngineFsResolver: { canResolveStream: () => false },
      TizenStreamingServerResolver: {
        canResolveStream: () => false,
        isUnsupportedOnCurrentTizen: () => false
      },
      logEngineFsDebug() {},
      getP2pInfoHash: () => "",
      t: (_k, _p, f) => f,
      streamDirectPlaybackUrl: (s) => s?.url || "",
      canResolveMediaServerStream: () => false,
      normalizeItemType: (x) => x,
      flattenStreamGroups: () => [],
      mergeStreamItems: (a, b) => [...a, ...b],
      PlayerSettingsStore: {
        get: () => ({
          streamAutoPlayMode: "FIRST_STREAM",
          streamAutoPlayFallbackOnFailure: true,
          streamAutoPlayFallbackStartupTimeoutSeconds: 0.02,
          streamAutoPlayFallbackMaxSources: 3
        })
      },
      addonRepository: { getInstalledAddons: async () => [] }
    },
    {
      canResolveMediaServerStream: () => false,
      isSourceFallbackActive: () => true,
      nextSourceFallbackCandidate: () => null,
      sourceFallbackKey: () => ""
    }
  );
  const methods73 = loadMethodsFile(
    "./playerScreenMethods-73-cleanup.js",
    "createPlayerScreenMethods73",
    {
      PlayerController: { stop() {} },
      streamRepository: { setLocalPluginSearchPaused() {} },
      TrackingScrobbleService: { isEnabled: () => false, cancel() {} },
      ENGINEFS_NAVIGATION_CLEANUP_GRACE_MS: 0
    }
  );

  const fallbacks = [];
  const screen = Object.assign(Object.create(Object.assign({}, methods34, methods35, methods73)), {
    playerMountToken: 1,
    activePlaybackUrl: "https://example.test/old.mp4",
    autoSelectedSourceKey: "url:https://example.test/new.mp4",
    sourceFallbackAttempts: 0,
    sourceFallbackInFlight: false,
    hasPresentedPlaybackFrame: false,
    streamCandidates: [{ id: "2", url: "https://example.test/new.mp4" }],
    silentAudioFallbackAttempts: new Set(),
    isActiveMountToken: (t) => t == null || t === 1,
    isExternalFrameMode: () => false,
    getCurrentStreamCandidate: () => null,
    getStreamCandidateByUrl: (u) => ({ id: "2", url: u }),
    isCurrentSourceLikelyHls: () => false,
    shouldPreserveWebOsTrackSelections: () => false,
    getPlaybackSourceContext: () => null,
    getEngineFsStateForStream: () => null,
    isSameEngineFsState: () => true,
    resetPlaybackEngineValidation() {},
    clearStartupError() {},
    updateLoadingVisibility() {},
    clearBufferingSpinnerTimer() {},
    enableStartupAudioGate() {},
    cancelSeekPreview() {},
    markPlaybackProgress() {},
    clearPlaybackStallGuard() {},
    clearSubtitleCueStyleBindings() {},
    clearEmbeddedSubtitleCueRefreshTimers() {},
    closeSourcesPanel() {},
    clearSubtitleDelayOverlayTimer() {},
    resetSubtitleAutoSyncState() {},
    resetAutomaticSubtitleSyncState() {},
    clearStartupAudioPreferenceRetry() {},
    clearBitmapSubtitleOverlay() {},
    destroyAssSubtitleRenderer() {},
    clearMountedExternalSubtitleTracks() {},
    clearTrackDiscoveryTimer() {},
    resetLivePlaybackState() {},
    fetchSkipIntervals() {},
    stopEngineFsKeepAlive() {},
    prefetchTizenEmbeddedAudioTracks() {},
    buildPlaybackContext: () => ({}),
    startPlayerControllerPlayback: async () => {},
    loadSubtitles() {},
    startTrackDiscoveryWindow() {},
    loadEmbeddedSubtitleTracks: async () => {},
    waitForInitialEmbeddedTrackBootstrap: async () => {},
    updateModalBackdrop() {},
    renderSubtitleDialog() {},
    renderAudioDialog() {},
    renderSpeedDialog() {},
    loadManifestTrackDataForCurrentStream() {},
    refreshTrackDialogs() {},
    updateUiTick() {},
    setControlsVisible() {},
    schedulePlaybackStallGuard() {},
    isStartupErrorVisible: () => false,
    tryFallbackToNextSourceAfterError: (msg) => {
      fallbacks.push(msg);
      return true;
    }
  });

  await screen.playStreamByUrl("https://example.test/new.mp4", { mountToken: 1 });
  assert.ok(screen.sourceStartupTimeoutTimer, "timer should be armed for new stream");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fallbacks.length, 1, "startup timeout should fire for switched activePlaybackUrl");

  // Cleanup without aspectToastTimer must clear sourceStartupTimeoutTimer & sourceFallbackInFlight.
  screen.scheduleSourceStartupTimeout("https://example.test/new.mp4");
  screen.sourceFallbackInFlight = true;
  screen.aspectToastTimer = null;
  let timerFiredAfterCleanup = false;
  screen.tryFallbackToNextSourceAfterError = () => {
    timerFiredAfterCleanup = true;
    return true;
  };
  Object.assign(screen, {
    closeStreamInfo() {},
    stopTrackingBeforeTeardown() {},
    leavePartyPlayback() {},
    unbindParty() {},
    cancelSourceLoad() {},
    cancelTizenAvPlayConnectionRetryBudgetReset() {},
    resetNextEpisodeLaunchPresentation() {},
    resetStillWatchingPromptState() {},
    clearPostPlayFocusTimer() {},
    clearPostPlayLongPressTimer() {},
    clearPostPlaySynopsisScrollAnimation() {},
    cancelPostPlayPlayerSurfaceAnimation() {},
    stopPostPlayTrailer() {},
    clearPostPlaySummaryTransition() {},
    unbindVideoEvents() {},
    unbindPlayerExitCleanup() {},
    releaseCurrentEngineFsStreamBestEffort() {},
    dismissPauseOverlay() {},
    clearWebOsEmbeddedTextSubtitleOverlay() {},
    clearHtmlSubtitleOverlay() {},
    cancelScheduledSourcesPanelRender() {},
    stopLoadingLogoFillAnimation() {},
    stopSeekLoadingWatchdog() {},
    clearControlsAutoHide() {},
    stopSkipIntroCountdownAnimation() {},
    stopSkipIntervalCheckTimer() {},
    stopParentalGuideLineAnimation() {},
    clearMediaSessionHandlers() {},
    releaseStartupAudioGate() {}
  });
  screen.cleanup();
  assert.equal(screen.sourceStartupTimeoutTimer, null);
  assert.equal(screen.sourceFallbackInFlight, false);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(timerFiredAfterCleanup, false);
});

test("playStreamCandidate cleans up tizenP2p when mount token expires during resolve", async () => {
  const cleaned = [];
  const methods35 = loadMethodsFile(
    "./playerScreenMethods-35-play-stream-candidate.js",
    "createPlayerScreenMethods35",
    {
      streamRepository: { setLocalPluginSearchPaused() {} },
      TorrentSettingsStore: { get: () => ({ p2pEnabled: true }) },
      DirectDebridResolver: { canResolveStream: () => false },
      WebOsEngineFsResolver: { canResolveStream: () => false },
      TizenStreamingServerResolver: {
        canResolveStream: () => true,
        isUnsupportedOnCurrentTizen: () => false,
        resolve: async () => ({
          status: "success",
          stream: {
            url: "http://127.0.0.1:2710/abc/0",
            tizenP2p: { kind: "tizen-streaming-server", infoHash: "abc123" }
          }
        })
      },
      logEngineFsDebug() {},
      getP2pInfoHash: () => "abc123",
      t: (_k, _p, f) => f,
      streamDirectPlaybackUrl: () => "",
      canResolveMediaServerStream: () => false,
      normalizeItemType: (x) => x,
      flattenStreamGroups: () => [],
      mergeStreamItems: (a, b) => [...a, ...b],
      PlayerSettingsStore: { get: () => ({}) },
      addonRepository: { getInstalledAddons: async () => [] }
    },
    {
      canResolveMediaServerStream: () => false
    }
  );

  let active = true;
  const screen = Object.assign(Object.create(methods35), {
    isActiveMountToken: () => {
      const current = active;
      active = false;
      return current;
    },
    cleanupEngineFsState: async (state, reason) => {
      cleaned.push({ state, reason });
    }
  });

  await screen.playStreamCandidate({ id: "tizen-torrent" }, { mountToken: 1 });
  assert.deepEqual(cleaned, [
    { state: { kind: "tizen-streaming-server", infoHash: "abc123" }, reason: "stale-p2p-resolve" }
  ]);
});

test("webOS exact seek does not leak keyframe audio or stay muted when startup audio gate releases mid-seek", () => {
  const listeners = new Map();
  const video = {
    currentTime: 0,
    duration: 200,
    readyState: 4,
    seeking: false,
    paused: false,
    ended: false,
    muted: true,
    defaultMuted: true,
    volume: 1,
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
    pause() {
      this.paused = true;
    },
    play: () => Promise.resolve()
  };

  let pollCb = null;
  const controller = {
    ...createPlayerControllerMethods03(),
    ...createWebOsExactSeekMethods({
      every: (cb) => {
        pollCb = cb;
        return 1;
      },
      stopEvery: () => {},
      later: () => 2,
      stopLater: () => {}
    }),
    video,
    playRequestToken: 1,
    startupAudioGateActive: true,
    startupPresentationAudioMuted: true,
    isPlaying: true,
    isUsingAvPlay: () => false,
    emitVideoEvent() {},
    cancelProgressSyncAfterSeek() {},
    syncWebOsPlaybackKeepAwake() {},
    scheduleProgressSyncAfterSeek() {}
  };

  assert.equal(controller.seekWebOsExactly(60), true);
  assert.equal(video.muted, true);

  // Gate releases mid-seek: video MUST remain muted during decode pass!
  controller.setStartupAudioGate(false, { resume: false });
  controller.setStartupPresentationAudioMuted(false);
  assert.equal(video.muted, true, "decode pass must stay muted until target frame settles");

  // Once exact seek settles, playback MUST unmute cleanly!
  video.currentTime = 59.5;
  pollCb();
  video.currentTime = 59.8;
  pollCb();
  video.currentTime = 60.1;
  pollCb();
  assert.equal(controller.isWebOsExactSeekInFlight(), false);
  assert.equal(video.muted, false, "playback must not remain permanently muted after gate release");
});

test("staged webOS native playback continues when proxy rewrites currentPlaybackUrl", async () => {
  const methods18 = loadMethodsFile(
    "../../../core/player/playerControllerMethods-18-play.js",
    "createPlayerControllerMethods18",
    {
      Platform: { isTizen: () => false, isWebOS: () => true },
      TizenPlaybackProxy: null,
      WebOsPlaybackProxy: {
        requiresProxy: () => true,
        resolve: async () => ({ proxied: true, url: "http://127.0.0.1:8888/proxy/proxied.mkv" })
      },
      logEngineFsDebug() {},
      logTizenAvPlayDebug() {},
      logWebOsPlaybackDebug() {}
    },
    {
      observeProxyRedirects: () => () => {},
      describeSourceHost: () => "",
      isDirectMediaProbeResponse: () => false,
      resolveTizenDirectRedirect: async () => ({})
    }
  );

  let playAttempted = false;
  let progressStarted = false;
  const controller = {
    ...createPlayerControllerMethods01(),
    ...methods18,
    video: {
      querySelectorAll: () => [],
      pause() {},
      removeAttribute() {},
      load() {}
    },
    playRequestToken: 0,
    stopWebOsDtsAudioTranscode() {},
    stopProgressSaving() {},
    cancelProgressSyncAfterSeek() {},
    flushCurrentProgress: async () => {},
    stopWebOsServiceKeepAlive() {},
    clearWebOsTrackSelections() {},
    applyStartupAudioGateToVideo() {},
    resolveRuntimeSourceType: () => "video/x-matroska",
    guessMediaMimeType: () => "video/x-matroska",
    resolveRemoteMediaSourceType: async () => "video/x-matroska",
    choosePlaybackEngine: () => "native-file",
    ensureAdaptiveLibrariesForSource: async () => {},
    isLikelyHlsMimeType: () => false,
    isTizenHlsSource: () => false,
    isLikelyDashMimeType: () => false,
    startWebOsPlaybackKeepAlive() {},
    startWebOsServiceKeepAlive() {},
    rememberPlaybackEngineAttempt() {},
    teardownAdaptiveInstances() {},
    teardownAvPlay() {},
    resetNativeMediaState() {},
    isEngineFsPlaybackUrl: () => false,
    applyWebOsStagedNativeSource() {},
    prepareWebOsStagedNativePlayback: async () => {},
    attemptVideoPlay() {
      playAttempted = true;
    },
    syncWebOsPlaybackKeepAwake() {},
    startProgressSaving() {
      progressStarted = true;
    }
  };

  await controller.play("https://cdn.example.test/movie.mkv", {
    requestHeaders: { Cookie: "a=b" }
  });
  assert.equal(controller.currentPlaybackUrl, "http://127.0.0.1:8888/proxy/proxied.mkv");
  assert.equal(playAttempted, true);
  assert.equal(progressStarted, true);
  assert.equal(controller.isPlaying, true);
});

test("ensureAudioAmplificationGraph reuses MediaElementSource across remounts on singleton video", () => {
  const video = { id: "videoPlayer" };
  let createSourceCount = 0;
  let resumeCount = 0;
  const gainNode = { gain: { value: 1 }, connect() {} };
  const audioContext = {
    state: "suspended",
    destination: {},
    resume: async () => {
      resumeCount += 1;
      audioContext.state = "running";
    },
    createMediaElementSource: () => {
      createSourceCount += 1;
      if (createSourceCount > 1) throw new Error("InvalidStateError");
      return { connect() {} };
    },
    createGain: () => gainNode
  };

  globalThis.AudioContext = function MockAudioContext() {
    return audioContext;
  };
  const methods24 = loadMethodsFile(
    "./playerScreenMethods-24-open-next-episode-stream-picker.js",
    "createPlayerScreenMethods24",
    {
      SubtitleAppearance: {},
      PlayerController: { video },
      PlayerSettingsStore: {},
      Environment: {},
      resolveHdrSubtitleStyle: () => ({}),
      Router: {},
      getSubtitleVerticalOffsetVh: () => 0,
      getSubtitleVerticalResidualOffsetVh: () => 0,
      normalizeSubtitleTextOpacity: (v) => v,
      subtitleTextColorWithOpacity: (c) => c,
      ENGINEFS_NAVIGATION_CLEANUP_GRACE_MS: 0,
      t: (_k, _p, f) => f,
      normalizeItemType: (x) => x,
      isSeriesItemType: () => false,
      normalizeSubtitleFontSize: (v) => v,
      formatHtmlSubtitleFontSize: (v) => `${v}%`,
      dbToGain: (db) => Math.pow(10, db / 20),
      supportsTvWebAudioAmplification: () => true,
      streamDirectPlaybackUrl: () => ""
    },
    { syncHtmlSubtitleClearance: () => {} }
  );

  const session1 = Object.assign(Object.create(methods24), { audioAmplificationDb: 6 });
  session1.applyAudioAmplification();
  assert.equal(createSourceCount, 1);
  assert.ok(gainNode.gain.value > 1.9);

  // Simulate remount where fields were cleared on PlayerScreen, then session 2 applies 0 dB then 6 dB.
  const session2 = Object.assign(Object.create(methods24), {
    audioContext: null,
    audioGainNode: null,
    audioMediaSource: null,
    audioAmplificationDb: 0
  });
  audioContext.state = "suspended";
  session2.syncExistingAudioAmplificationGraph();
  session2.applyAudioAmplification();
  assert.equal(gainNode.gain.value, 1);
  assert.equal(resumeCount, 2);

  session2.audioAmplificationDb = 6;
  session2.applyAudioAmplification();
  assert.equal(createSourceCount, 1, "must reuse existing MediaElementSource via WeakMap");
  assert.ok(gainNode.gain.value > 1.9);
});
