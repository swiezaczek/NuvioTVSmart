import test from "node:test";
import assert from "node:assert/strict";

const storageMap = new Map();
let getItemCount = 0;
globalThis.localStorage = {
  getItem(key) {
    getItemCount += 1;
    return storageMap.has(key) ? storageMap.get(key) : null;
  },
  setItem(key, value) {
    storageMap.set(key, String(value));
  },
  removeItem(key) {
    storageMap.delete(key);
  },
  clear() {
    storageMap.clear();
  }
};

const { WatchedItemsStore } = await import("./watchedItemsStore.js");
const { SavedLibraryStore } = await import("./savedLibraryStore.js");
const { setBoundedCacheEntry } =
  await import("../../core/tmdb/tmdbMetadataServiceHelpers-01-tmdb-base-url.js");
const { metaRepository } = await import("../repository/metaRepository.js");

test("WatchedItemsStore memoizes listAll by raw localStorage string and returns defensive copies", () => {
  storageMap.clear();
  WatchedItemsStore.upsert(
    { contentId: "tt100", contentType: "movie", title: "Movie", watchedAt: 1000 },
    "1"
  );

  const origParse = JSON.parse;
  let parseCount = 0;
  JSON.parse = (...args) => {
    parseCount += 1;
    return origParse(...args);
  };
  try {
    const first = WatchedItemsStore.listAll();
    assert.equal(first.length, 1);
    assert.equal(parseCount, 1);

    first[0].title = "Mutated";
    const second = WatchedItemsStore.listAll();
    assert.equal(parseCount, 1, "unchanged raw string hits memoized cache");
    assert.equal(second[0].title, "Movie", "caller mutation does not corrupt cache");

    // External storage mutation invalidates cache cleanly.
    const rawArr = origParse(storageMap.get("watchedItems"));
    rawArr.push({
      profileId: "1",
      contentId: "tt101",
      contentType: "movie",
      title: "Next",
      watchedAt: 2000
    });
    storageMap.set("watchedItems", JSON.stringify(rawArr));
    const third = WatchedItemsStore.listAll();
    assert.equal(parseCount, 2);
    assert.equal(third.length, 2);
  } finally {
    JSON.parse = origParse;
  }
});

test("SavedLibraryStore memoizes listAll by raw localStorage string and returns defensive copies", () => {
  storageMap.clear();
  SavedLibraryStore.upsert(
    { contentId: "tt200", contentType: "movie", title: "Saved", updatedAt: 1000 },
    "1"
  );

  const origParse = JSON.parse;
  let parseCount = 0;
  JSON.parse = (...args) => {
    parseCount += 1;
    return origParse(...args);
  };
  try {
    const first = SavedLibraryStore.listAll();
    assert.equal(first.length, 1);
    assert.equal(parseCount, 1);

    first[0].title = "Mutated";
    const second = SavedLibraryStore.listAll();
    assert.equal(parseCount, 1);
    assert.equal(second[0].title, "Saved");
  } finally {
    JSON.parse = origParse;
  }
});

test("setBoundedCacheEntry enforces maxEntries with LRU eviction", () => {
  const cache = new Map();
  setBoundedCacheEntry(cache, "a", 1, 2);
  setBoundedCacheEntry(cache, "b", 2, 2);
  setBoundedCacheEntry(cache, "a", 10, 2); // promotes "a"
  setBoundedCacheEntry(cache, "c", 3, 2); // evicts "b"
  assert.deepEqual(Array.from(cache.entries()), [
    ["a", 10],
    ["c", 3]
  ]);
});

test("MetaRepository bounds metaCache to 200 entries with LRU refresh", () => {
  metaRepository.clearCache();
  for (let i = 0; i < 205; i += 1) {
    metaRepository.setMetaCache(`k${i}`, { id: i });
  }
  assert.equal(metaRepository.metaCache.size, 200);
  assert.equal(metaRepository.metaCache.has("k0"), false);
  assert.equal(metaRepository.metaCache.has("k5"), true);
  // Touch k5 via getMetaCache so it moves to MRU and k6 gets evicted next.
  assert.deepEqual(metaRepository.getMetaCache("k5"), { id: 5 });
  metaRepository.setMetaCache("k205", { id: 205 });
  assert.equal(metaRepository.metaCache.has("k5"), true);
  assert.equal(metaRepository.metaCache.has("k6"), false);
});
