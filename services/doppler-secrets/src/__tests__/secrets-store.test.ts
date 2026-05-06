import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSecretsStore, DopplerUnavailableError } from "../index.js";
import type { KVFallback } from "../index.js";

const SECRETS = { API_KEY: "secret123", DB_URL: "postgres://localhost/db" };
const OPTIONS_BASE = {
  serviceToken: "dt.token",
  project: "my-project",
  config: "prd",
};

function makeFetchSuccess(secrets: Record<string, string> = SECRETS) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => secrets,
    text: async () => JSON.stringify(secrets),
  });
}

function makeFetchFailure(status = 503, body = "Service Unavailable") {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  });
}

function makeFetchNetworkError(message = "network failure") {
  return vi.fn().mockRejectedValue(new Error(message));
}

function makeKV(initialValue: string | null = null): KVFallback {
  let stored: string | null = initialValue;
  return {
    get: vi.fn().mockImplementation(async () => stored),
    put: vi.fn().mockImplementation(async (_key: string, value: string) => {
      stored = value;
    }),
  };
}

describe("createSecretsStore", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Doppler fetch succeeds → store populated, KV written", async () => {
    const mockFetch = makeFetchSuccess();
    vi.stubGlobal("fetch", mockFetch);
    const kv = makeKV();

    const store = await createSecretsStore({ ...OPTIONS_BASE, fallback: kv });

    expect(store.get("API_KEY")).toBe("secret123");
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(kv.put).toHaveBeenCalledOnce();
    const [putKey, putVal] = (kv.put as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(putKey).toBe("doppler:secrets");
    expect(JSON.parse(putVal as string)).toEqual(SECRETS);
  });

  it("Doppler fetch fails, KV hit → store populated from KV, no throw", async () => {
    vi.stubGlobal("fetch", makeFetchFailure());
    const kv = makeKV(JSON.stringify(SECRETS));

    const store = await createSecretsStore({ ...OPTIONS_BASE, fallback: kv });

    expect(store.get("API_KEY")).toBe("secret123");
    expect(kv.get).toHaveBeenCalledWith("doppler:secrets");
  });

  it("Doppler fetch fails, KV miss → throws DopplerUnavailableError", async () => {
    vi.stubGlobal("fetch", makeFetchFailure());
    const kv = makeKV(null);

    await expect(
      createSecretsStore({ ...OPTIONS_BASE, fallback: kv })
    ).rejects.toThrow(DopplerUnavailableError);
  });

  it("Doppler fetch fails, no KV → throws DopplerUnavailableError", async () => {
    vi.stubGlobal("fetch", makeFetchNetworkError());

    await expect(
      createSecretsStore({ ...OPTIONS_BASE })
    ).rejects.toThrow(DopplerUnavailableError);
  });

  it("TTL not expired → no extra Doppler fetch after cold start", async () => {
    const mockFetch = makeFetchSuccess();
    vi.stubGlobal("fetch", mockFetch);

    const store = await createSecretsStore({
      ...OPTIONS_BASE,
      ttlSeconds: 300,
    });

    // Multiple get() calls should not trigger additional fetches
    store.get("API_KEY");
    store.get("DB_URL");
    store.getOptional("MISSING");

    // Allow any microtasks to settle
    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("TTL expired → next get() triggers refresh", async () => {
    const mockFetch = makeFetchSuccess();
    vi.stubGlobal("fetch", mockFetch);

    const store = await createSecretsStore({
      ...OPTIONS_BASE,
      ttlSeconds: 0, // expire immediately
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Wait a tick so TTL=0 has expired
    await new Promise((r) => setTimeout(r, 1));

    store.get("API_KEY");
    await new Promise((r) => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("two concurrent get() on expired TTL → Doppler fetch called exactly once (coalescing)", async () => {
    // Use a controlled fetch: first call returns a pending promise so we can
    // issue two get() calls synchronously before the refresh completes.
    let resolveRefresh!: (v: Response) => void;
    const pendingRefresh = new Promise<Response>((res) => {
      resolveRefresh = res;
    });

    const mockFetch = vi
      .fn()
      // cold start
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => SECRETS,
        text: async () => JSON.stringify(SECRETS),
      } as unknown as Response)
      // refresh after TTL expires — pending until we resolve it
      .mockReturnValueOnce(pendingRefresh);

    vi.stubGlobal("fetch", mockFetch);

    const store = await createSecretsStore({
      ...OPTIONS_BASE,
      ttlSeconds: 0, // expire immediately
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    mockFetch.mockClear();

    // Ensure TTL=0 has elapsed
    await new Promise((r) => setTimeout(r, 1));

    // Call get() twice synchronously — both must use the same in-flight refresh
    const v1p = store.getOptional("API_KEY"); // void ensureFresh() fires refresh #1
    const v2p = store.getOptional("API_KEY"); // void ensureFresh() must reuse same promise

    // At this point fetch should have been called exactly once (refresh pending)
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Now resolve the refresh
    resolveRefresh({
      ok: true,
      status: 200,
      json: async () => SECRETS,
      text: async () => JSON.stringify(SECRETS),
    } as unknown as Response);

    // Let the async resolution settle
    await new Promise((r) => setTimeout(r, 20));

    // Still exactly one fetch call total
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Both get() calls returned the cached value (cache was warm from cold start)
    expect(v1p).toBe("secret123");
    expect(v2p).toBe("secret123");
  });

  it("get() on missing key throws SecretNotFoundError", async () => {
    vi.stubGlobal("fetch", makeFetchSuccess({ ONLY: "this" }));
    const store = await createSecretsStore({ ...OPTIONS_BASE });
    expect(() => store.get("MISSING")).toThrow("MISSING");
  });

  it("getOptional() on missing key returns undefined", async () => {
    vi.stubGlobal("fetch", makeFetchSuccess({ ONLY: "this" }));
    const store = await createSecretsStore({ ...OPTIONS_BASE });
    expect(store.getOptional("MISSING")).toBeUndefined();
  });

  it("uses default TTL of 300 seconds when not specified", async () => {
    const mockFetch = makeFetchSuccess();
    vi.stubGlobal("fetch", mockFetch);
    const kv = makeKV();

    await createSecretsStore({ ...OPTIONS_BASE, fallback: kv });

    const [, , kvOpts] = (kv.put as ReturnType<typeof vi.fn>).mock.calls[0];
    // KV expiry = ttlSeconds * 4 = 300 * 4 = 1200
    expect((kvOpts as { expirationTtl: number }).expirationTtl).toBe(1200);
  });
});
