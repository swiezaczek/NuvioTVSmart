import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { mapWithConcurrency } from "../../../core/network/mapWithConcurrency.js";

function createMemoryStorage() {
  const storage = new Map();
  let setCalls = 0;
  let getCalls = 0;
  return {
    storage,
    get setCalls() {
      return setCalls;
    },
    get getCalls() {
      return getCalls;
    },
    resetCounts() {
      setCalls = 0;
      getCalls = 0;
    },
    api: {
      getItem: (key) => {
        getCalls += 1;
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem: (key, value) => {
        setCalls += 1;
        storage.set(key, String(value));
      },
      removeItem: (key) => storage.delete(key),
      clear: () => storage.clear()
    }
  };
}

function createEventTargetMock(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(event) {
      const set = listeners.get(event?.type);
      if (!set) return;
      for (const fn of Array.from(set)) {
        fn(event);
      }
    }
  };
}

function makeItem(id, title) {
  return {
    contentId: id,
    contentType: "movie",
    title,
    name: title,
    poster: `https://img/${id}.jpg`,
    background: `https://img/${id}-bg.jpg`,
    genres: ["Drama"]
  };
}

test("CW enrichment batch persistence, external invalidation guard, visibility flush, and load cancellation", async () => {
  const prevStorage = globalThis.localStorage;
  const prevDocument = globalThis.document;
  const prevWindow = globalThis.window;

  const mem = createMemoryStorage();
  const docMock = createEventTargetMock({ hidden: false });
  const winMock = createEventTargetMock();

  globalThis.localStorage = mem.api;
  globalThis.document = docMock;
  globalThis.window = winMock;

  try {
    const { LocalStore } = await import("../../../core/storage/localStore.js");
    const helpers =
      await import("./homeScreenHelpers-10-get-cached-continue-watching-enrichment.js");
    const {
      saveContinueWatchingEnrichment,
      getCachedContinueWatchingEnrichment,
      flushContinueWatchingEnrichmentCache
    } = helpers;

    LocalStore.clear();
    mem.resetCounts();

    // 1. Deferred writes stay in memory, remain readable, and flush in a single LocalStore.set.
    assert.equal(typeof flushContinueWatchingEnrichmentCache, "function");
    saveContinueWatchingEnrichment(makeItem("tt101", "First"), { deferWrite: true });
    saveContinueWatchingEnrichment(makeItem("tt102", "Second"), { deferWrite: true });
    assert.equal(mem.setCalls, 0, "deferred writes must not hit localStorage.setItem per item");
    assert.equal(
      getCachedContinueWatchingEnrichment({ contentId: "tt101", contentType: "movie" })?.title,
      "First"
    );
    assert.equal(
      getCachedContinueWatchingEnrichment({ contentId: "tt102", contentType: "movie" })?.title,
      "Second"
    );

    const flushed = flushContinueWatchingEnrichmentCache();
    assert.equal(flushed, true);
    assert.equal(mem.setCalls, 1, "flushing a batch writes localStorage once");
    const persisted = JSON.parse(mem.storage.get("homeContinueWatchingEnrichmentCache"));
    assert.equal(persisted["movie:tt101::"]?.title, "First");
    assert.equal(persisted["movie:tt102::"]?.title, "Second");

    // 2. External LocalStore.remove / clear while deferred writes are pending must not be resurrected.
    mem.resetCounts();
    saveContinueWatchingEnrichment(makeItem("tt103", "Third"), { deferWrite: true });
    assert.equal(mem.setCalls, 0);
    LocalStore.remove("homeContinueWatchingEnrichmentCache");
    assert.equal(
      flushContinueWatchingEnrichmentCache(),
      false,
      "stale deferred batch must abort after external remove"
    );
    assert.equal(mem.setCalls, 0, "aborted flush must not rewrite removed cache");
    assert.equal(mem.storage.has("homeContinueWatchingEnrichmentCache"), false);
    assert.equal(
      getCachedContinueWatchingEnrichment({ contentId: "tt103", contentType: "movie" }),
      null
    );

    // 3. Visibility hide flushes pending deferred writes synchronously.
    mem.resetCounts();
    saveContinueWatchingEnrichment(makeItem("tt104", "Fourth"), { deferWrite: true });
    assert.equal(mem.setCalls, 0);
    docMock.hidden = true;
    docMock.dispatchEvent({ type: "visibilitychange" });
    assert.equal(
      mem.setCalls,
      1,
      "hiding the document must flush pending deferred enrichment writes"
    );
    assert.equal(
      JSON.parse(mem.storage.get("homeContinueWatchingEnrichmentCache"))["movie:tt104::"]?.title,
      "Fourth"
    );
    docMock.hidden = false;

    // 4. Drive real enrichContinueWatching: batches writes once and aborts when shouldContinue becomes false.
    const raw27 = (
      await readFile(
        new URL("./homeScreenMethods-27-enrich-continue-watching.js", import.meta.url),
        "utf8"
      )
    )
      .replace(/^import [\s\S]*?;\r?\n/gm, "")
      .replace(/^export /gm, "");

    const context = vm.createContext({
      console,
      Promise,
      Set,
      Map,
      Math,
      Number,
      String,
      Array,
      Object,
      Boolean,
      flushContinueWatchingEnrichmentCache,
      resolveContinueWatchingEpisodeRating: async () => null,
      dedupeContinueWatchingInProgress: (list) => list,
      isServerContentId: () => false,
      resolveContinueWatchingSeriesContentId: (id) => id,
      internals: {
        Router: { getCurrent: () => "home" },
        mapWithConcurrency,
        TmdbService: {},
        TmdbMetadataService: {},
        TmdbSettingsStore: { get: () => ({ enabled: false }) },
        TMDB_API_KEY: "",
        CW_MAX_ENRICHMENT_CONCURRENCY: 1,
        CW_MAX_VISIBLE_ITEMS: 30,
        firstNonEmpty: (...vals) => vals.find((v) => v != null && String(v).trim() !== "") || "",
        prettyId: (id) => id,
        resolveImdbRating: () => null,
        parseRuntimeMinutes: () => 100,
        isCollectionFolderItem: () => false,
        normalizeCollectionFolderItem: (x) => x,
        normalizeHomeRowItem: (_r, x) => x,
        withTimeout: (p) => p,
        isSeriesTypeForContinueWatching: () => false,
        findEpisodeEntry: () => null,
        sortContinueWatchingItemsForDisplay: (list) => list,
        normalizeCatalogItem: (x) => x,
        isCloudContinueWatchingItem: () => false,
        needsContinueWatchingMetadataRefresh: () => true,
        applyCachedContinueWatchingEnrichment: (x) => x,
        saveContinueWatchingEnrichment
      }
    });
    vm.runInContext(`${raw27}\nglobalThis.createMethods = createHomeScreenMethods27;`, context);

    LocalStore.clear();
    mem.resetCounts();

    const fetchedIds = [];
    let allowContinue = true;
    const screen = Object.assign(Object.create(context.createMethods()), {
      layoutPrefs: {},
      async fetchMetaForContinueWatching(_type, contentId) {
        fetchedIds.push(contentId);
        if (contentId === "tt202") {
          // Simulate leaving Home while item 2 is in flight.
          allowContinue = false;
        }
        return {
          id: contentId,
          type: "movie",
          name: `Title ${contentId}`,
          poster: `https://img/${contentId}.jpg`,
          background: `https://img/${contentId}-bg.jpg`
        };
      },
      async enrichContinueWatchingMetaWithTmdb(meta) {
        return meta;
      },
      async buildNextUpItems() {
        return [];
      }
    });

    await screen.enrichContinueWatching(
      [makeItem("tt201", "One"), makeItem("tt202", "Two"), makeItem("tt203", "Three")],
      { shouldContinue: () => allowContinue }
    );

    assert.deepEqual(
      fetchedIds,
      ["tt201", "tt202"],
      "cancelled enrichment must stop before starting subsequent items"
    );
    assert.equal(mem.setCalls, 1, "completed items in a batch must flush with a single setItem");
    const saved = JSON.parse(mem.storage.get("homeContinueWatchingEnrichmentCache"));
    assert.ok(saved["movie:tt201::"], "completed item before cancellation is persisted");
    assert.equal(
      saved["movie:tt202::"],
      undefined,
      "in-flight item cancelled before commit must not be saved"
    );
    assert.equal(saved["movie:tt203::"], undefined, "skipped item must not be saved");
  } finally {
    globalThis.localStorage = prevStorage;
    globalThis.document = prevDocument;
    globalThis.window = prevWindow;
  }
});
