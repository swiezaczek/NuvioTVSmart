import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

if (!globalThis.localStorage) {
  const storage = new Map();
  globalThis.localStorage = {
    getItem(key) {
      return storage.has(String(key)) ? storage.get(String(key)) : null;
    },
    setItem(key, value) {
      storage.set(String(key), String(value));
    },
    removeItem(key) {
      storage.delete(String(key));
    },
    clear() {
      storage.clear();
    },
    key(index) {
      return Array.from(storage.keys())[index] ?? null;
    },
    get length() {
      return storage.size;
    }
  };
}

const { AuthManager } = await import("../auth/authManager.js");
const { ProfileManager } = await import("../profile/profileManager.js");
const { ProviderCredentialSyncService } =
  await import("../profile/providerCredentialSyncService.js");
const { StartupSyncService } = await import("../profile/startupSyncService.js");
const { LibrarySyncService } = await import("../profile/librarySyncService.js");
const { SavedLibrarySyncService } = await import("../profile/savedLibrarySyncService.js");
const { DebridSettingsStore } = await import("../../data/local/debridSettingsStore.js");
const { DebridApi } = await import("../../data/remote/api/debridApi.js");
const { SupabaseApi } = await import("../../data/remote/supabase/supabaseApi.js");
const { DirectDebridResolver } = await import("./directDebridResolver.js");
const { LocalDebridAvailabilityService } = await import("./localDebridAvailabilityService.js");
const { cloudLibraryRepository } = await import("../../data/repository/cloudLibraryRepository.js");
const { resetSyncBackoff } = await import("../sync/syncBackoffPolicy.js");

const originalState = {
  authState: AuthManager.state,
  getEffectiveUserId: AuthManager.getEffectiveUserId,
  rpc: SupabaseApi.rpc,
  torboxCreateTorrent: DebridApi.torboxCreateTorrent,
  torboxGetTorrent: DebridApi.torboxGetTorrent,
  torboxRequestDownloadLink: DebridApi.torboxRequestDownloadLink,
  torboxCheckCached: DebridApi.torboxCheckCached,
  torboxListCloudItems: DebridApi.torboxListCloudItems,
  torboxRequestCloudDownloadLink: DebridApi.torboxRequestCloudDownloadLink,
  libraryPull: LibrarySyncService.pull,
  savedLibraryPull: SavedLibrarySyncService.pull,
  requestWatchStateSyncNow: StartupSyncService.requestWatchStateSyncNow
};

afterEach(async () => {
  await ProviderCredentialSyncService.stop();
  StartupSyncService.stop();
  resetSyncBackoff();
  AuthManager.state = originalState.authState;
  AuthManager.getEffectiveUserId = originalState.getEffectiveUserId;
  SupabaseApi.rpc = originalState.rpc;
  DebridApi.torboxCreateTorrent = originalState.torboxCreateTorrent;
  DebridApi.torboxGetTorrent = originalState.torboxGetTorrent;
  DebridApi.torboxRequestDownloadLink = originalState.torboxRequestDownloadLink;
  DebridApi.torboxCheckCached = originalState.torboxCheckCached;
  DebridApi.torboxListCloudItems = originalState.torboxListCloudItems;
  DebridApi.torboxRequestCloudDownloadLink = originalState.torboxRequestCloudDownloadLink;
  LibrarySyncService.pull = originalState.libraryPull;
  SavedLibrarySyncService.pull = originalState.savedLibraryPull;
  StartupSyncService.requestWatchStateSyncNow = originalState.requestWatchStateSyncNow;
  localStorage.clear();
});

function setupAuthenticatedTorboxProfile(initialKey = "old-tb-key", remoteKey = "fresh-tb-key") {
  let pullCount = 0;
  resetSyncBackoff();
  AuthManager.state = "authenticated";
  AuthManager.getEffectiveUserId = async () => "user-1";
  DebridSettingsStore.replaceForProfile(
    "1",
    {
      enabled: true,
      cloudLibraryEnabled: true,
      torboxApiKey: initialKey,
      preferredResolverProviderId: "torbox"
    },
    { silentSync: true, silentCredentialSync: true }
  );
  SupabaseApi.rpc = async (fnName) => {
    if (fnName === "sync_pull_provider_credentials") {
      pullCount += 1;
      return [
        { provider: "debrid:torbox", credential_json: { api_key: remoteKey } },
        { provider: "debrid:premiumize", credential_json: { api_key: "" } },
        { provider: "debrid:realdebrid", credential_json: { api_key: "" } },
        { provider: "mdblist", credential_json: { api_key: "" } },
        { provider: "animeskip", credential_json: { client_id: "" } }
      ];
    }
    return [];
  };
  return { getPullCount: () => pullCount };
}

test("refreshDebridApiKeyOnAuthError skips non-auth errors and refreshes on 401", async () => {
  const tracker = setupAuthenticatedTorboxProfile("old-key-1", "new-key-1");

  const ignored = await ProviderCredentialSyncService.refreshDebridApiKeyOnAuthError(
    "torbox",
    "old-key-1",
    { status: 409, data: {} }
  );
  assert.equal(ignored, null);
  assert.equal(tracker.getPullCount(), 0);

  const refreshed = await ProviderCredentialSyncService.refreshDebridApiKeyOnAuthError(
    "torbox",
    "old-key-1",
    { status: 401, data: { error: "BAD_TOKEN" } }
  );
  assert.equal(refreshed, "new-key-1");
  assert.equal(tracker.getPullCount(), 1);
  assert.equal(DebridSettingsStore.get().torboxApiKey, "new-key-1");

  // During the 15s cooldown window, another auth failure with the stale key returns the updated local key without hitting RPC again.
  const fromCooldownCache = await ProviderCredentialSyncService.refreshDebridApiKeyOnAuthError(
    "torbox",
    "old-key-1",
    { status: 403, data: {} }
  );
  assert.equal(fromCooldownCache, "new-key-1");
  assert.equal(tracker.getPullCount(), 1);
});

test("DirectDebridResolver refreshes TorBox API key on 401 during playback resolve", async () => {
  const tracker = setupAuthenticatedTorboxProfile("old-tb-resolve", "new-tb-resolve");
  const seenKeys = [];

  DebridApi.torboxCreateTorrent = async (apiKey) => {
    seenKeys.push(apiKey);
    if (apiKey === "old-tb-resolve") {
      return { ok: false, status: 401, data: { success: false, error: "BAD_TOKEN" } };
    }
    return { ok: true, status: 200, data: { success: true, data: { torrent_id: 42 } } };
  };
  DebridApi.torboxGetTorrent = async () => ({
    ok: true,
    status: 200,
    data: {
      success: true,
      data: { files: [{ id: 7, short_name: "movie.mkv", size: 1024 }] }
    }
  });
  DebridApi.torboxRequestDownloadLink = async (apiKey) => {
    assert.equal(apiKey, "new-tb-resolve");
    return {
      ok: true,
      status: 200,
      data: { success: true, data: "https://cdn.example/movie.mkv" }
    };
  };

  const result = await DirectDebridResolver.resolve({
    infoHash: "0123456789abcdef0123456789abcdef01234567",
    debridCacheStatus: { state: "CACHED" },
    clientResolve: {
      type: "debrid",
      service: "torbox",
      infoHash: "0123456789abcdef0123456789abcdef01234567"
    }
  });

  assert.equal(result.status, "success");
  assert.equal(result.stream.url, "https://cdn.example/movie.mkv");
  assert.deepEqual(seenKeys, ["old-tb-resolve", "new-tb-resolve"]);
  assert.equal(tracker.getPullCount(), 1);
  assert.equal(DebridSettingsStore.get().torboxApiKey, "new-tb-resolve");
});

test("LocalDebridAvailabilityService refreshes TorBox API key on cache check 401", async () => {
  setupAuthenticatedTorboxProfile("old-cache-key", "new-cache-key");
  const hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const seenKeys = [];

  DebridApi.torboxCheckCached = async (apiKey) => {
    seenKeys.push(apiKey);
    if (apiKey === "old-cache-key") {
      return { ok: false, status: 401, data: { success: false, error: "AUTH_ERROR" } };
    }
    return {
      ok: true,
      status: 200,
      data: { success: true, data: { [hash]: { name: "Movie.mkv", size: 2048 } } }
    };
  };

  const annotated = await LocalDebridAvailabilityService.annotateCachedAvailability([
    { streams: [{ infoHash: hash }] }
  ]);
  assert.equal(annotated[0].streams[0].debridCacheStatus.state, "CACHED");
  assert.deepEqual(seenKeys, ["old-cache-key", "new-cache-key"]);
});

test("cloudLibraryRepository refreshes TorBox API key on 401 when listing and playing", async () => {
  setupAuthenticatedTorboxProfile("old-cloud-key", "new-cloud-key");
  const listKeys = [];
  const playKeys = [];

  DebridApi.torboxListCloudItems = async (apiKey, path) => {
    listKeys.push(`${path}:${apiKey}`);
    if (apiKey === "old-cloud-key") {
      return { ok: false, status: 401, data: { success: false, error: "BAD_TOKEN" } };
    }
    if (path === "v1/api/torrents/mylist") {
      return {
        ok: true,
        status: 200,
        data: {
          success: true,
          data: [
            {
              id: 11,
              name: "Example Torrent",
              files: [{ id: 2, short_name: "video.mkv", size: 4096 }]
            }
          ]
        }
      };
    }
    return { ok: true, status: 200, data: { success: true, data: [] } };
  };

  const library = await cloudLibraryRepository.refresh();
  assert.equal(library.items.length, 1);
  assert.equal(listKeys[0], "v1/api/torrents/mylist:old-cloud-key");
  assert.equal(listKeys[1], "v1/api/torrents/mylist:new-cloud-key");

  // Simulate another key rotation while the cloud screen remained open with an older file item.
  DebridSettingsStore.setProviderApiKey("torbox", "stale-cloud-key-2", {
    silentSync: true,
    silentCredentialSync: true
  });
  await ProviderCredentialSyncService.stop();
  setupAuthenticatedTorboxProfile("stale-cloud-key-2", "newest-cloud-key");

  DebridApi.torboxRequestCloudDownloadLink = async (apiKey) => {
    playKeys.push(apiKey);
    if (apiKey === "stale-cloud-key-2") {
      return { ok: false, status: 403, data: { success: false } };
    }
    return {
      ok: true,
      status: 200,
      data: { success: true, data: "https://cdn.example/cloud.mkv" }
    };
  };

  const playback = await cloudLibraryRepository.resolvePlayback(
    { providerId: "torbox", type: "Torrent", id: 11 },
    { id: 2, name: "video.mkv", sizeBytes: 4096, playable: true }
  );
  assert.equal(playback.status, "success");
  assert.equal(playback.url, "https://cdn.example/cloud.mkv");
  assert.deepEqual(playKeys, ["stale-cloud-key-2", "newest-cloud-key"]);
});

test("StartupSyncService.scheduleSurfacePull refreshes provider credentials and addons", async () => {
  const tracker = setupAuthenticatedTorboxProfile("before-periodic", "after-periodic");
  let addonsPullCount = 0;

  StartupSyncService.started = true;
  StartupSyncService.profileScopedSyncEnabled = true;
  StartupSyncService.runGeneration += 1;
  StartupSyncService.requestWatchStateSyncNow = async () => true;
  SavedLibrarySyncService.pull = async () => [];
  LibrarySyncService.pull = async () => {
    addonsPullCount += 1;
    return [];
  };

  const scheduled = StartupSyncService.scheduleSurfacePull("periodic", 0, 0, true);
  assert.equal(scheduled, true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await StartupSyncService.foregroundPullPromise;

  assert.equal(tracker.getPullCount(), 1);
  assert.equal(addonsPullCount, 1);
  assert.equal(DebridSettingsStore.get().torboxApiKey, "after-periodic");
  assert.equal(ProfileManager.getActiveProfileId(), "1");
});
