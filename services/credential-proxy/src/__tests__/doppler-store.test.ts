/**
 * Unit tests for DopplerCredentialStore.
 *
 * Uses fetch mocking — no real Doppler connection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DopplerCredentialStore } from "../store/doppler.js";

const MOCK_SECRETS: Record<string, string> = {
  GITHUB_PAT: "ghp_fakepat",
  YOUTUBE_REALENTRY_REFRESH_TOKEN: "ya29.faketoken",
};

function mockFetchSuccess(secrets = MOCK_SECRETS) {
  return vi.fn().mockResolvedValueOnce({
    ok: true,
    json: async () => secrets,
    text: async () => JSON.stringify(secrets),
  } as Response);
}

describe("DopplerCredentialStore", () => {
  const ALLOWED_KEYS = new Set(["GITHUB_PAT", "YOUTUBE_REALENTRY_REFRESH_TOKEN"]);

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and returns a secret from Doppler", async () => {
    const mockFetch = mockFetchSuccess();
    vi.stubGlobal("fetch", mockFetch);

    const store = new DopplerCredentialStore({
      serviceToken: "dp.st.test",
      project: "test-doppler-project",
      config: "prd",
      allowedKeys: ALLOWED_KEYS,
    });

    const value = await store.get("GITHUB_PAT");
    expect(value).toBe("ghp_fakepat");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("caches secrets and avoids redundant Doppler fetches", async () => {
    const mockFetch = mockFetchSuccess();
    vi.stubGlobal("fetch", mockFetch);

    const store = new DopplerCredentialStore({
      serviceToken: "dp.st.test",
      project: "test-doppler-project",
      config: "prd",
      allowedKeys: ALLOWED_KEYS,
    });

    await store.get("GITHUB_PAT");
    await store.get("YOUTUBE_REALENTRY_REFRESH_TOKEN");

    // Only one network fetch despite two gets.
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("re-fetches after cache is invalidated", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => MOCK_SECRETS,
      } as Response);
    vi.stubGlobal("fetch", mockFetch);

    const store = new DopplerCredentialStore({
      serviceToken: "dp.st.test",
      project: "test-doppler-project",
      config: "prd",
      ttlMs: 60_000,
      allowedKeys: ALLOWED_KEYS,
    });

    await store.get("GITHUB_PAT");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    store.invalidate();

    await store.get("GITHUB_PAT");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws for keys not on the allowlist", async () => {
    const store = new DopplerCredentialStore({
      serviceToken: "dp.st.test",
      project: "test-doppler-project",
      config: "prd",
      allowedKeys: ALLOWED_KEYS,
    });

    await expect(store.get("SOME_OTHER_SECRET")).rejects.toThrow("allowlist");
  });

  it("throws on Doppler API error", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    } as Response);
    vi.stubGlobal("fetch", mockFetch);

    const store = new DopplerCredentialStore({
      serviceToken: "bad-token",
      project: "test-doppler-project",
      config: "prd",
      allowedKeys: ALLOWED_KEYS,
    });

    await expect(store.get("GITHUB_PAT")).rejects.toThrow("401");
  });

  it("normalizes cache keys to prevent cache-miss amplification", async () => {
    const mockFetch = mockFetchSuccess();
    vi.stubGlobal("fetch", mockFetch);

    const store = new DopplerCredentialStore({
      serviceToken: "dp.st.test",
      project: "test-doppler-project",
      config: "prd",
      allowedKeys: new Set(["GITHUB_PAT", "github_pat"]),
    });

    // Both fetches should hit the same cache entry after normalization.
    await store.get("GITHUB_PAT");
    await store.get("GITHUB_PAT"); // Second call should use cache.

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent fetches (stampede prevention)", async () => {
    let fetchCallCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      await new Promise((r) => setTimeout(r, 10));
      return {
        ok: true,
        json: async () => MOCK_SECRETS,
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    const store = new DopplerCredentialStore({
      serviceToken: "dp.st.test",
      project: "test-doppler-project",
      config: "prd",
      allowedKeys: ALLOWED_KEYS,
    });

    // Fire 5 concurrent gets.
    await Promise.all([
      store.get("GITHUB_PAT"),
      store.get("GITHUB_PAT"),
      store.get("GITHUB_PAT"),
      store.get("YOUTUBE_REALENTRY_REFRESH_TOKEN"),
      store.get("YOUTUBE_REALENTRY_REFRESH_TOKEN"),
    ]);

    // Only one Doppler fetch despite 5 concurrent requests.
    expect(fetchCallCount).toBe(1);
  });
});
