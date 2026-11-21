import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadModuleIntoContext(relativePath, context, extraStrip = []) {
  let source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  source = source.replace(/^import [\s\S]*?;\r?\n/gm, "").replace(/^export /gm, "");
  for (const pattern of extraStrip) {
    source = source.replace(pattern, "");
  }
  vm.runInContext(source, context);
}

test("shouldDeferHomeRenderForInput defers on all TV runtimes and requestBackgroundRender coalesces bursts after initial paint", async () => {
  const scheduled = [];
  const context = vm.createContext({
    console,
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Set,
    Map,
    Promise,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (cb) => {
      scheduled.push("raf");
      cb();
      return 1;
    },
    cancelAnimationFrame: () => {},
    getTvRuntimePerformanceProfile: () => ({
      isTvRuntime: true,
      isPerformanceConstrained: false,
      isLegacyTvRuntime: false
    }),
    internals: {
      Router: { getCurrent: () => "home" },
      addonRepository: {},
      CollectionsStore: { get: () => [] },
      ProfileManager: { getActiveProfileId: () => "1" },
      StartupSyncService: {},
      ProfileSettingsSyncService: {},
      watchProgressRepository: {},
      watchedItemsRepository: {},
      LayoutPreferences: { get: () => ({}) },
      HomeCatalogStore: {},
      getSidebarProfileState: async () => null,
      buildSidebarProfileSignature: () => "sig",
      getContinueWatchingNextUpSeedOptions: () => ({}),
      buildCatalogOrderKey: () => "k",
      catalogShouldShowOnHome: () => true,
      catalogSkipStep: () => 20,
      catalogSupportsExtra: () => true,
      MODERN_HOME_CONSTANTS: { verticalScrollSettlePollMs: 60 },
      CW_MAX_VISIBLE_ITEMS: 30,
      HERO_ROTATE_FIRST_DELAY_MS: 20000,
      HERO_ROTATE_INTERVAL_MS: 10000,
      HOME_CATALOG_REFRESH_TTL_MS: 900000,
      HOME_STABLE_GATE_TIMEOUT_MS: 5000,
      HOME_BACKGROUND_RENDER_DELAY_LEGACY_MS: 180,
      HOME_BACKGROUND_RENDER_DELAY_MS: 120,
      HOME_INITIAL_CATALOG_LOAD: 6,
      HOME_LOADING_ROW_ITEMS_CONSTRAINED: 8,
      HOME_LOADING_ROW_ITEMS_DEFAULT: 10,
      HOME_LOADING_ROW_ITEMS_LEGACY_TV: 6,
      HOME_MAX_ITEMS_PER_ROW_CONSTRAINED: 10,
      HOME_MAX_ITEMS_PER_ROW_DEFAULT: 15,
      HOME_MAX_ITEMS_PER_ROW_LEGACY_TV: 8,
      Platform: { isWebOS: () => false, isTizen: () => true, isBrowser: () => false },
      getTvRuntimePerformanceProfile: () => ({
        isTvRuntime: true,
        isPerformanceConstrained: false,
        isLegacyTvRuntime: false
      }),
      isFastHorizontalNavigationEnabled: () => false,
      parseCssPx: () => 0,
      logHomePerf: () => {},
      homePerfNow: () => 0,
      preloadHeroAssets: async () => {},
      buildHeroIdentity: () => "",
      I18n: { getLocale: () => "en" }
    }
  });
  context.globalThis = context;
  await loadModuleIntoContext("./homeScreenMethods-03-is-scroll-animation-active.js", context);
  await loadModuleIntoContext("./homeScreenMethods-04-get-hero-focus-delay.js", context);
  vm.runInContext(
    "globalThis.api = Object.assign(createHomeScreenMethods03(), createHomeScreenMethods04());",
    context
  );

  let renderCalls = 0;
  const screen = Object.assign(Object.create(context.api), {
    container: {},
    layoutMode: "modern",
    hasPaintedInitialHomeContent: true,
    hasUserInteractedSinceHomePaint: true,
    lastHomeInputAt: Date.now(),
    shouldSuspendModernViewportFocusSync: () => false,
    render() {
      renderCalls += 1;
    }
  });

  // Modern Tizen 9.0 M120 (not constrained, not legacy-tizen class) still defers 800ms after D-pad input.
  assert.equal(screen.shouldDeferHomeRenderForInput(), true);
  screen.lastHomeInputAt = Date.now() - 850;
  assert.equal(screen.shouldDeferHomeRenderForInput(), false);

  // Burst of 10 requestBackgroundRender() calls after initial paint coalesces into 1 render.
  assert.equal(screen.getBackgroundRenderDelay(), 180);
  for (let i = 0; i < 10; i += 1) {
    screen.requestBackgroundRender();
  }
  assert.equal(renderCalls, 0);
  await new Promise((resolve) => setTimeout(resolve, 240));
  assert.equal(renderCalls, 1, "coalesced burst must trigger exactly one render");
});

test("refreshHomeAfterRouteReturn waits HOME_ROUTE_RETURN_SETTLE_MS settle before running watch, catalog, and pending descriptor work", async () => {
  let cwCalls = 0;
  let staleCatalogCalls = 0;
  let retryCalls = 0;
  let resumeCalls = 0;
  const context = vm.createContext({
    console,
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Set,
    Map,
    Promise,
    setTimeout,
    clearTimeout,
    getTvRuntimePerformanceProfile: () => ({ isTvRuntime: true, isPerformanceConstrained: false }),
    internals: {
      Router: { getCurrent: () => "home" },
      addonRepository: {
        getCachedInstalledAddons: () => [],
        getInstalledAddonUrls: () => [],
        getAddonEnabledStates: () => ({})
      },
      CollectionsStore: { get: () => [] },
      ProfileManager: { getActiveProfileId: () => "1" },
      StartupSyncService: {},
      ProfileSettingsSyncService: { getHomeInputSignature: () => "p1" },
      watchProgressRepository: { getContinueWatchingSourceKey: () => "cw1" },
      watchedItemsRepository: {},
      LayoutPreferences: { get: () => ({}) },
      HomeCatalogStore: { get: () => ({}) },
      getSidebarProfileState: async () => null,
      buildSidebarProfileSignature: () => "sig",
      getContinueWatchingNextUpSeedOptions: () => ({}),
      buildCatalogOrderKey: () => "k",
      catalogShouldShowOnHome: () => true,
      catalogSkipStep: () => 20,
      catalogSupportsExtra: () => true,
      MODERN_HOME_CONSTANTS: { verticalScrollSettlePollMs: 60 },
      CW_MAX_VISIBLE_ITEMS: 30,
      HERO_ROTATE_FIRST_DELAY_MS: 20000,
      HERO_ROTATE_INTERVAL_MS: 10000,
      HOME_CATALOG_REFRESH_TTL_MS: 900000,
      HOME_ROUTE_RETURN_SETTLE_MS: 500,
      HOME_STABLE_GATE_TIMEOUT_MS: 5000,
      logHomePerf: () => {},
      homePerfNow: () => 0,
      preloadHeroAssets: async () => {},
      buildHeroIdentity: () => "",
      I18n: { getLocale: () => "en" }
    }
  });
  context.globalThis = context;
  await loadModuleIntoContext("./homeScreenMethods-04-get-hero-focus-delay.js", context);
  vm.runInContext("globalThis.api = createHomeScreenMethods04();", context);

  const screen = Object.assign(Object.create(context.api), {
    homeLoadToken: 1,
    sidebarProfile: null,
    lastHomeCatalogRefreshAtMs: Date.now(),
    pendingHomeCatalogDescriptors: [{ addonId: "a", catalogId: "c", type: "movie" }],
    buildSyncSensitiveHomeSignature: () => "sync-1",
    refreshHomeContinueWatchingAfterSync: async () => {
      cwCalls += 1;
    },
    refreshHomeCatalogsIfStale: async () => {
      staleCatalogCalls += 1;
    },
    retryPendingCatalogRows: () => {
      retryCalls += 1;
    },
    resumePendingHomeCatalogDescriptors: async () => {
      resumeCalls += 1;
    }
  });
  screen.loadedHomeRouteInputSignature = screen.buildHomeRouteInputSignature();

  const start = Date.now();
  await screen.refreshHomeAfterRouteReturn({ reason: "route-resume" });
  const elapsed = Date.now() - start;

  assert.ok(elapsed >= 450, `expected ~500ms settle delay, got ${elapsed}ms`);
  assert.equal(cwCalls, 1);
  assert.equal(resumeCalls, 1, "pending deferred descriptors resume without full reload");
  assert.equal(
    staleCatalogCalls,
    1,
    "stale catalog refresh delegates directly to TTL check after settle"
  );
  assert.equal(retryCalls, 1, "pending catalog rows retry after settle without extra cooldown");
});

test("handleHomeDpad checks repeatThrottleMs before isNodeWithinMainViewport", async () => {
  let viewportChecks = 0;
  let focusNodeCalls = 0;
  const context = vm.createContext({
    console,
    Date,
    Number,
    Boolean,
    internals: {
      getLegacySidebarSelectedNode: () => null,
      getModernSidebarSelectedNode: () => null,
      getDirectionFromKeyCode: (code) => (code === 39 ? "right" : null),
      MODERN_HOME_CONSTANTS: {},
      Router: { getCurrent: () => "home" }
    }
  });
  context.globalThis = context;
  await loadModuleIntoContext("./homeScreenMethods-19-handle-home-dpad.js", context);
  vm.runInContext("globalThis.api = createHomeScreenMethods19();", context);

  const current = {
    dataset: { navZone: "main", navRow: "0", navCol: "0" },
    classList: { contains: () => false }
  };
  const next = {
    dataset: { navZone: "main", navRow: "0", navCol: "1" },
    classList: { contains: () => false }
  };
  const screen = Object.assign(Object.create(context.api), {
    layoutMode: "modern",
    navModel: { rows: [[current, next]], sidebar: [] },
    lastDirectionalKeyAtByDirection: { right: Date.now() },
    getCurrentFocusedNode: () => current,
    isSidebarNode: () => false,
    isMainNode: () => true,
    getDirectionalRepeatThrottleMs: () => 100,
    shouldSuspendModernViewportFocusSync: () => false,
    isNodeWithinMainViewport: () => {
      viewportChecks += 1;
      return true;
    },
    focusNode: () => {
      focusNodeCalls += 1;
      return true;
    }
  });

  let stopped = false;
  const handled = screen.handleHomeDpad({
    keyCode: 39,
    repeat: true,
    preventDefault() {},
    stopPropagation() {
      stopped = true;
    }
  });

  assert.equal(handled, true);
  assert.equal(stopped, true);
  assert.equal(
    viewportChecks,
    0,
    "throttled repeat must skip getBoundingClientRect viewport check"
  );
  assert.equal(focusNodeCalls, 0);
});

test("onKeyDown stops sidebar Enter/repeat double-firing", async () => {
  let activated = 0;
  const context = vm.createContext({
    console,
    Number,
    String,
    Boolean,
    registerHomeDomNodes: () => {},
    internals: {
      Router: { getCurrent: () => "home" },
      LayoutPreferences: { get: () => ({}) },
      Platform: { isBackEvent: () => false },
      activateLegacySidebarAction: () => {
        activated += 1;
      },
      setModernSidebarPillIconOnly: () => {},
      CW_RENDER_LOAD_AHEAD_ITEMS: 4,
      HOME_LAYOUT_SEQUENCE: ["modern"],
      shouldAppendContinueWatchingItems: () => false,
      isDirectionalKeyCode: (code) => [37, 38, 39, 40].includes(code),
      getDirectionFromKeyCode: () => null,
      resolveContinueWatchingBlurNextUp: () => false,
      renderContinueWatchingCard: () => ""
    }
  });
  context.globalThis = context;
  await loadModuleIntoContext("./homeScreenMethods-28-on-key-down.js", context);
  vm.runInContext("globalThis.api = createHomeScreenMethods28();", context);

  const sidebarNode = { dataset: { navZone: "sidebar", action: "gotoHome" } };
  const screen = Object.assign(Object.create(context.api), {
    layoutMode: "modern",
    getCurrentFocusedNode: () => sidebarNode,
    markUserInteractionSinceHomePaint() {},
    isHomeHoldTarget: () => false,
    cancelPendingContinueWatchingEnter() {},
    cancelPendingContinueWatchingHold() {},
    handleHomeDpad: () => false
  });

  let prevented = 0;
  let stopped = 0;
  screen.onKeyDown({
    keyCode: 13,
    repeat: false,
    preventDefault() {
      prevented += 1;
    },
    stopPropagation() {
      stopped += 1;
    }
  });
  screen.onKeyDown({
    keyCode: 13,
    repeat: true,
    preventDefault() {
      prevented += 1;
    },
    stopPropagation() {
      stopped += 1;
    }
  });

  assert.equal(activated, 1, "sidebar Enter must fire once and ignore repeats");
  assert.equal(prevented, 2, "preventDefault suppresses native <button> click synthesis");
  assert.equal(stopped, 2);
});

test("buildYoutubeEmbedUrl omits random _cb so existingFrame reuse matches", async () => {
  const context = vm.createContext({
    URL,
    URLSearchParams,
    YOUTUBE_PROXY_URL: "https://proxy.example/yt.html",
    internals: {}
  });
  context.globalThis = context;
  await loadModuleIntoContext(
    "./homeScreenHelpers-05-normalize-collection-folder-item.js",
    context
  );
  const first = context.buildYoutubeEmbedUrl("dQw4w9WgXcQ", { muted: true });
  const second = context.buildYoutubeEmbedUrl("dQw4w9WgXcQ", { muted: true });
  assert.equal(first, second);
  assert.equal(new URL(first).searchParams.has("_cb"), false);
});

test("enrichCurrentHeroAsync commits TMDB backdrop/logo without waiting 3500ms on MDBList and applies rating async", async () => {
  let resolveMdb = null;
  let applyCalls = 0;
  const context = vm.createContext({
    console,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Promise,
    setTimeout,
    clearTimeout,
    MdbListSettingsStore: { get: () => ({ showOnHero: true }) },
    internals: {
      Router: { getCurrent: () => "home" },
      TmdbSettingsStore: {
        get: () => ({ useBasicInfo: true, useArtwork: true, useDetails: true })
      },
      metaRepository: {
        getMetaFromAllAddons: async () => ({ status: "success", data: { name: "Addon Title" } })
      },
      mdbListRepository: {
        getRatingsForMeta: () =>
          new Promise((resolve) => {
            resolveMdb = resolve;
          })
      },
      shouldPreserveHomeRuntimeText: () => false,
      firstNonEmpty: (...vals) => vals.find(Boolean) || "",
      resolveImdbRating: () => null,
      preloadHeroBackdrop: async () => ({ loaded: true, bitmap: null }),
      preloadHeroLogo: async () => ({ loaded: true, displaySrc: "" }),
      preloadImageSource: async () => true,
      parseRuntimeMinutes: () => 0,
      normalizeCollectionFolderItem: (x) => x,
      withTimeout: (promise) => promise,
      fetchModernHeroTmdbEnrichment: async () => ({
        backdrop: "https://tmdb/bg.jpg",
        logo: "https://tmdb/logo.png"
      }),
      buildHeroIdentity: (item) => String(item?.id || ""),
      buildModernHeroPresentation: (item) => ({ backdrop: item?.background, logo: item?.logo })
    }
  });
  context.globalThis = context;
  await loadModuleIntoContext("./homeScreenMethods-11-enrich-current-hero-async.js", context);
  vm.runInContext("globalThis.api = createHomeScreenMethods11();", context);

  const hero = { id: "tt123", type: "movie", name: "Movie" };
  const screen = Object.assign(Object.create(context.api), {
    heroFocusToken: 1,
    heroItem: hero,
    heroCandidates: [hero],
    rows: [],
    lastRapidHorizontalNavAt: 0,
    getNodeHeroSource: () => hero,
    getCurrentFocusedNode: () => ({}),
    applyHeroToDom() {
      applyCalls += 1;
    }
  });

  await screen.enrichCurrentHeroAsync(hero, 1, { deferCommit: true });
  assert.ok(applyCalls >= 1, "TMDB/meta hero committed without waiting on slow MDBList");
  assert.equal(screen.heroItem.background, "https://tmdb/bg.jpg");
  assert.equal(screen.heroItem.imdbRating, undefined);

  resolveMdb({ ratings: { imdb: 8.4 } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    screen.heroItem.imdbRating,
    8.4,
    "MDBList badge applied asynchronously once settled"
  );
});

test("fitSidebarLabel memoizes binary search by text, width, and locale", async () => {
  const originalGetComputedStyle = globalThis.getComputedStyle;
  let scrollReads = 0;
  let locale = "en";
  const context = vm.createContext({
    console,
    Math,
    Number,
    String,
    Map,
    document: { documentElement: { lang: "en" }, fonts: { status: "loaded" } },
    getComputedStyle: () => ({ fontSize: "40px" }),
    I18n: { getLocale: () => locale },
    Router: {},
    ProfileManager: {},
    AvatarRepository: {},
    MemberAccessRepository: {},
    getTvRuntimePerformanceProfile: () => ({})
  });
  context.globalThis = context;
  await loadModuleIntoContext(
    "../../components/sidebarNavigationHelpers-01-root-sidebar-items.js",
    context
  );

  function makeLabel(text, boxWidth) {
    const style = {};
    return {
      isConnected: true,
      textContent: text,
      className: "modern-sidebar-profile-name",
      style,
      clientWidth: Math.round(boxWidth),
      get scrollWidth() {
        scrollReads += 1;
        const size = Number.parseFloat(style.fontSize) || 40;
        return Math.round(size * 5);
      },
      getBoundingClientRect() {
        return { width: boxWidth };
      }
    };
  }

  try {
    const first = makeLabel("LongProfileName", 160);
    assert.equal(context.fitSidebarLabel(first, 18), true);
    const readsAfterFirst = scrollReads;
    assert.ok(readsAfterFirst > 1, "first pass runs binary search");

    const second = makeLabel("LongProfileName", 160);
    assert.equal(context.fitSidebarLabel(second, 18), true);
    assert.equal(
      scrollReads,
      readsAfterFirst,
      "memoized hit skips binary search and scrollWidth reads"
    );
    assert.equal(second.style.fontSize, first.style.fontSize);

    // Locale change invalidates cache key.
    locale = "pl";
    context.document.documentElement.lang = "pl";
    const third = makeLabel("LongProfileName", 160);
    assert.equal(context.fitSidebarLabel(third, 18), true);
    assert.ok(scrollReads > readsAfterFirst, "locale change triggers fresh measurement");
  } finally {
    globalThis.getComputedStyle = originalGetComputedStyle;
  }
});

test("O(1) activeHomeTrailerLayers avoids querySelectorAll scans on cleanup and pause", async () => {
  let queryAllCalls = 0;
  const context = vm.createContext({
    console,
    Set,
    WeakMap,
    Array,
    setTimeout,
    clearTimeout,
    cancelIdleCallback: () => {},
    getTrailerCleanupDelayMs: () => 50,
    internals: {
      getTvRuntimePerformanceProfile: () => ({ isTvRuntime: true }),
      firstNonEmpty: (...vals) => vals.find(Boolean) || "",
      isCollectionFolderItem: () => false,
      normalizeCollectionFolderItem: (x) => x,
      metaRepository: {},
      resolveTrailerSource: () => null,
      withTimeout: (p) => p,
      resolveTrailerMetaWithTmdbFallback: async () => null
    }
  });
  context.globalThis = context;
  await loadModuleIntoContext("./homeScreenMethods-12-sync-collection-hero-media.js", context);
  await loadModuleIntoContext("./homeScreenMethods-13-mount-trailer-layer.js", context);
  vm.runInContext(
    "globalThis.api = Object.assign(createHomeScreenMethods12(), createHomeScreenMethods13());",
    context
  );

  const iframe = {
    dataset: { trailerSrc: "https://example.com/embed", trailerRevealed: "true" },
    contentWindow: { postMessage() {} }
  };
  const layerClasses = new Set(["is-active"]);
  const layer = {
    isConnected: true,
    firstElementChild: iframe,
    innerHTML: "<iframe></iframe>",
    classList: {
      add: (c) => layerClasses.add(c),
      remove: (...cs) => cs.forEach((c) => layerClasses.delete(c)),
      contains: (c) => layerClasses.has(c)
    },
    querySelector: (sel) => (sel === "iframe" ? iframe : null)
  };
  const screen = Object.assign(Object.create(context.api), {
    mountedHomeTrailerLayers: new Set([layer]),
    homeTrailerLayerCleanupTimers: new WeakMap(),
    homeTrailerLayerHideTimers: new WeakMap(),
    shouldUseImmediateFocusScroll: () => false,
    container: {
      querySelectorAll: () => {
        queryAllCalls += 1;
        return [];
      }
    }
  });

  screen.refreshPendingHomeTrailerCleanup();
  screen.pauseActiveTrailerLayersForNavigation();
  screen.clearHomeTrailerLayers();

  assert.equal(queryAllCalls, 0, "tracked mountedHomeTrailerLayers avoids full DOM scans");
  assert.equal(screen.mountedHomeTrailerLayers.size, 0);
});

test("persistHomeCatalogSnapshot defers writes until >1500ms after last Home D-pad press", async () => {
  const writes = [];
  const context = vm.createContext({
    console,
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Set,
    Map,
    Promise,
    setTimeout,
    clearTimeout,
    startHomeContinueWatchingLoad: () => {},
    HomeCatalogSnapshotStore: {
      read: async () => null,
      write: async (payload) => {
        writes.push(payload);
        return true;
      }
    },
    buildHomeCatalogSnapshotKey: () => "1:key",
    internals: {
      Router: { getCurrent: () => "home" },
      addonRepository: {},
      catalogRepository: {},
      watchProgressRepository: {},
      watchedItemsRepository: {},
      LayoutPreferences: {},
      HomeCatalogStore: {},
      CollectionsStore: {},
      ProfileManager: {},
      StartupSyncService: {},
      WatchProgressSource: {},
      buildWatchedTitleIdSet: () => new Set(),
      buildCatalogOrderKey: () => "k",
      catalogShouldShowOnHome: () => true,
      catalogSkipStep: () => 20,
      catalogSupportsExtra: () => true,
      getSidebarProfileState: async () => null,
      CW_MAX_VISIBLE_ITEMS: 30,
      HOME_ADDON_MANIFEST_TIMEOUT_MS: 30000,
      HOME_PERF_DEBUG: false,
      mergeRefreshedHomeRows: (r) => r,
      shouldApplyLateContinueWatchingFocus: () => false,
      homePerfNow: () => 0,
      logHomePerf: () => {},
      uniqueById: (x) => x,
      getContinueWatchingNextUpSeedOptions: () => ({}),
      buildSidebarProfileSignature: () => "sig",
      buildHeroIdentity: () => ""
    }
  });
  context.globalThis = context;
  await loadModuleIntoContext("./homeScreenMethods-21-load-data.js", context);
  vm.runInContext("globalThis.persistFn = persistHomeCatalogSnapshot;", context);

  const screen = {
    homeCatalogSnapshotKey: "1:key",
    homeLoadToken: 1,
    lastHomeInputAt: Date.now(),
    rows: [{ homeCatalogKey: "row1" }]
  };

  // Should NOT write immediately while D-pad input was just pressed (0ms ago).
  context.persistFn(screen, 1, { force: true, Router: { getCurrent: () => "home" } });
  assert.equal(writes.length, 0, "snapshot write must defer while D-pad input is recent");

  // Clean up timer so test exits cleanly, then verify idle path writes immediately.
  clearTimeout(screen.homeCatalogSnapshotWriteTimer);
  screen.lastHomeInputAt = Date.now() - 1600;
  context.persistFn(screen, 1, { force: true, Router: { getCurrent: () => "home" } });
  assert.equal(writes.length, 1, "snapshot writes once >1500ms after last D-pad press");
});

test("animateSpringScroll updates max when container grows mid-flight so rAF settles", async () => {
  const rafQueue = [];
  let fakeNow = 0;
  const context = vm.createContext({
    console,
    Math,
    Number,
    String,
    Boolean,
    WeakMap,
    performance: { now: () => fakeNow },
    requestAnimationFrame: (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    },
    cancelAnimationFrame: () => {},
    isModernTvProfile: () => false,
    getTvRuntimePerformanceProfile: () => ({}),
    globalThis: null,
    internals: {
      MODERN_HOME_CONSTANTS: {
        springScrollStiffness: 300,
        springScrollDampingRatio: 1
      },
      MODERN_CAMERA_PAN_EASING: "linear"
    }
  });
  context.globalThis = context;
  await loadModuleIntoContext("./homeScreenMethods-02-restore-modern-focus-state.js", context);
  vm.runInContext("globalThis.api = createHomeScreenMethods02();", context);

  const screen = Object.assign(Object.create(context.api), {
    shouldUseImmediateFocusScroll: () => false
  });
  const container = {
    scrollLeft: 0,
    scrollWidth: 1000,
    clientWidth: 400
  };
  // First target with initial max = 600
  screen.animateSpringScroll(container, "scrollLeft", 500);
  // Container expands mid-flight (pagination/deferred items) and user moves further right
  container.scrollWidth = 2000;
  screen.animateSpringScroll(container, "scrollLeft", 1200);

  let steps = 0;
  while (rafQueue.length && steps < 300) {
    fakeNow += 16;
    const cb = rafQueue.shift();
    cb(fakeNow);
    steps += 1;
  }
  assert.ok(
    steps < 300,
    `spring scroll must settle instead of looping infinitely (ran ${steps} steps)`
  );
  assert.equal(container.scrollLeft, 1200);
});

test("fitSidebarLabel invalidates cache when --app-font-family changes", async () => {
  let scrollReads = 0;
  let currentFont = "Inter, sans-serif";
  const context = vm.createContext({
    console,
    Math,
    Number,
    String,
    Map,
    document: {
      documentElement: {
        lang: "en",
        style: {
          getPropertyValue: (name) => (name === "--app-font-family" ? currentFont : "")
        }
      },
      fonts: { status: "loaded" }
    },
    getComputedStyle: () => ({ fontSize: "40px" }),
    I18n: { getLocale: () => "en" },
    Router: {},
    ProfileManager: {},
    AvatarRepository: {},
    MemberAccessRepository: {},
    getTvRuntimePerformanceProfile: () => ({})
  });
  context.globalThis = context;
  await loadModuleIntoContext(
    "../../components/sidebarNavigationHelpers-01-root-sidebar-items.js",
    context
  );

  function makeLabel() {
    const style = {};
    return {
      isConnected: true,
      textContent: "MyLongLabel",
      className: "modern-sidebar-nav-label",
      style,
      clientWidth: 150,
      get scrollWidth() {
        scrollReads += 1;
        const size = Number.parseFloat(style.fontSize) || 40;
        return Math.round(size * 5);
      },
      getBoundingClientRect: () => ({ width: 150 })
    };
  }

  context.fitSidebarLabel(makeLabel(), 18);
  const afterFirst = scrollReads;
  context.fitSidebarLabel(makeLabel(), 18);
  assert.equal(scrollReads, afterFirst, "same font hits cache");

  currentFont = "Roboto, sans-serif";
  context.fitSidebarLabel(makeLabel(), 18);
  assert.ok(scrollReads > afterFirst, "changing --app-font-family busts sidebar label fit cache");
});

test("resetForSignOut discards preserved TV Home DOM and resets rescaler pool", async () => {
  let resetRescalerCalls = 0;
  let releaseAllCalls = 0;
  let hideCalls = 0;
  const classes = new Set(["home-dom-preserved"]);
  const removedProps = [];
  const container = {
    childNodes: [{}],
    innerHTML: "<div>old account</div>",
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c)
    },
    style: {
      removeProperty: (p) => removedProps.push(p)
    }
  };
  const context = vm.createContext({
    console,
    Array,
    Boolean,
    String,
    Number,
    Set,
    WeakMap,
    clearTimeout,
    cancelAnimationFrame: () => {},
    resetHomeArtworkRescaler: () => {
      resetRescalerCalls += 1;
    },
    resetHeroLogoRescaleCache: () => {},
    internals: {
      ScreenUtils: {
        hide: () => {
          hideCalls += 1;
        }
      },
      Platform: {
        isTizen: () => true,
        isWebOS: () => false
      }
    }
  });
  context.globalThis = context;
  await loadModuleIntoContext("./homeScreenMethods-30-cleanup.js", context);
  vm.runInContext("globalThis.api = createHomeScreenMethods30();", context);

  const screen = Object.assign(Object.create(context.api), {
    container,
    hasLoadedOnce: true,
    hasPaintedInitialHomeContent: true,
    homeDomPreserved: true,
    rows: [{ id: "row1" }],
    heroCandidates: [{ id: "h1" }],
    heroItem: { id: "h1" },
    loadedProfileId: "1",
    persistCurrentFocusState: () => {},
    cancelInitialHomeLoadTimeout: () => {},
    cancelScheduledRender: () => {},
    cancelModernCameraFollow: () => {},
    endModernVerticalFastScroll: () => {},
    stopHeroRotation: () => {},
    cancelPendingHeroFocus: () => {},
    cancelFocusedPosterFlow: () => {},
    clearFocusedPosterFlowState: () => {},
    collapseFocusedPoster: () => {},
    clearHomeTrailerLayers: () => {},
    teardownGridStickyHeader: () => {},
    teardownModernTrackScrollPagination: () => {},
    teardownContinueWatchingProgressiveRendering: () => {},
    cancelModernSidebarPillAutoCollapse: () => {},
    cancelPendingContinueWatchingEnter: () => {},
    cancelPendingContinueWatchingHold: () => {},
    destroyHomeHoldDialog: () => {},
    unlockHomeHoldFocus: () => {},
    releaseAllHomeLazyImages: () => {
      releaseAllCalls += 1;
    }
  });

  screen.resetForSignOut();
  assert.equal(screen.homeDomPreserved, false);
  assert.equal(screen.hasLoadedOnce, false);
  assert.deepEqual(Array.from(screen.rows), []);
  assert.equal(screen.heroItem, null);
  assert.equal(container.innerHTML, "");
  assert.equal(classes.has("home-dom-preserved"), false);
  assert.ok(releaseAllCalls >= 1);
  assert.ok(resetRescalerCalls >= 1);
  assert.ok(hideCalls >= 1);
});
