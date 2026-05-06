import type { SessionState } from "../adapters/types.js";

// Mock the fetch utility so no real network calls are made
const mockFetch = vi.fn();
vi.mock("../utils/fetch.js", () => ({
  getProxyFetch: () => mockFetch,
}));

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    accessToken: "test-token",
    businessAccountId: "acct-123",
    username: "testuser",
    created: "2024-01-01T00:00:00.000Z",
    adapter: "instagram-api",
    ...overrides,
  };
}

function makeResponse(data: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 400,
    statusText: ok ? "OK" : "Bad Request",
    headers: { get: () => null },
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

function buildInsightsData(
  metrics: Record<string, number>
): { data: { name: string; values: { value: number }[] }[] } {
  return {
    data: Object.entries(metrics).map(([name, value]) => ({
      name,
      values: [{ value }],
    })),
  };
}

async function getSession() {
  const { adapterRegistry } = await import("../adapters/index.js");
  return adapterRegistry.get("instagram-api").restoreSession(makeState());
}

describe("getMediaInsights", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("maps all metrics correctly for a photo post", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse({ media_type: "IMAGE" }))
      .mockResolvedValueOnce(
        makeResponse(
          buildInsightsData({
            impressions: 1234,
            reach: 567,
            saved: 12,
            likes: 34,
            comments: 5,
            shares: 3,
          })
        )
      );

    const session = await getSession();
    const insights = await session.getMediaInsights("post-abc");

    expect(insights.impressions).toBe(1234);
    expect(insights.reach).toBe(567);
    expect(insights.videoViews).toBeUndefined(); // IMAGE: no video_views
    expect(insights.saved).toBe(12);
    expect(insights.likes).toBe(34);
    expect(insights.comments).toBe(5);
    expect(insights.shares).toBe(3);
  });

  it("includes videoViews for a VIDEO post", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse({ media_type: "VIDEO" }))
      .mockResolvedValueOnce(
        makeResponse(
          buildInsightsData({
            impressions: 500,
            reach: 400,
            saved: 10,
            likes: 20,
            comments: 2,
            shares: 1,
            video_views: 300,
          })
        )
      );

    const session = await getSession();
    const insights = await session.getMediaInsights("video-xyz");

    expect(insights.videoViews).toBe(300);
    expect(insights.impressions).toBe(500);
  });

  it("includes videoViews for a REELS post", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse({ media_type: "REELS" }))
      .mockResolvedValueOnce(
        makeResponse(buildInsightsData({ video_views: 99 }))
      );

    const session = await getSession();
    const insights = await session.getMediaInsights("reel-abc");

    expect(insights.videoViews).toBe(99);
    expect(insights.impressions).toBe(0); // missing metric defaults to 0
  });

  it("defaults all metrics to 0 when API returns empty data array", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse({ media_type: "IMAGE" }))
      .mockResolvedValueOnce(makeResponse({ data: [] }));

    const session = await getSession();
    const insights = await session.getMediaInsights("empty-post");

    expect(insights.impressions).toBe(0);
    expect(insights.reach).toBe(0);
    expect(insights.saved).toBe(0);
    expect(insights.likes).toBe(0);
    expect(insights.comments).toBe(0);
    expect(insights.shares).toBe(0);
    expect(insights.videoViews).toBeUndefined();
  });

  it("defaults missing individual metrics to 0", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse({ media_type: "IMAGE" }))
      .mockResolvedValueOnce(
        makeResponse(buildInsightsData({ impressions: 100 }))
      );

    const session = await getSession();
    const insights = await session.getMediaInsights("partial-post");

    expect(insights.impressions).toBe(100);
    expect(insights.reach).toBe(0);
    expect(insights.likes).toBe(0);
  });

  it("handles a metric with an empty values array by defaulting to 0", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse({ media_type: "IMAGE" }))
      .mockResolvedValueOnce(
        makeResponse({
          data: [{ name: "impressions", values: [] }],
        })
      );

    const session = await getSession();
    const insights = await session.getMediaInsights("no-values-post");

    expect(insights.impressions).toBe(0);
  });

  it("throws for an empty mediaId", async () => {
    const session = await getSession();
    await expect(session.getMediaInsights("")).rejects.toThrow(
      "Media ID is required"
    );
    await expect(session.getMediaInsights("   ")).rejects.toThrow(
      "Media ID is required"
    );
  });

  it("does not request video_views metric for IMAGE posts", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse({ media_type: "IMAGE" }))
      .mockResolvedValueOnce(makeResponse({ data: [] }));

    const session = await getSession();
    await session.getMediaInsights("img-post");

    // The second fetch call is the /insights request
    const insightsUrl = String(mockFetch.mock.calls[1][0]);
    expect(insightsUrl).not.toContain("video_views");
  });

  it("requests video_views metric for VIDEO posts", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse({ media_type: "VIDEO" }))
      .mockResolvedValueOnce(makeResponse({ data: [] }));

    const session = await getSession();
    await session.getMediaInsights("vid-post");

    const insightsUrl = String(mockFetch.mock.calls[1][0]);
    expect(insightsUrl).toContain("video_views");
  });
});
