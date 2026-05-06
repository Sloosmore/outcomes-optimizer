/**
 * Integration test: GitHub API via credential proxy
 *
 * Verifies:
 *   1. fetch('https://api.github.com/user') with X-Resource: github-pat returns 200
 *   2. process.env.GITHUB_PAT is undefined in this (agent) process
 *
 * Requires:
 *   - CREDENTIAL_PROXY_URL env var pointing to a running proxy sidecar
 *   - The proxy sidecar has DOPPLER_SERVICE_TOKEN set and can resolve GITHUB_PAT
 *
 * Run with: CREDENTIAL_PROXY_URL=http://127.0.0.1:7447 vitest run integration/github
 */
import { describe, it, expect, beforeAll } from "vitest";
import { installFetchInterceptor } from "../../interceptor.js";

const SKIP = !process.env.CREDENTIAL_PROXY_URL && process.env.CI !== "true";

describe.skipIf(SKIP)("GitHub integration via credential proxy", () => {
  beforeAll(() => {
    installFetchInterceptor();
  });

  it("agent process has no raw GITHUB_PAT in environment", () => {
    expect(process.env.GITHUB_PAT).toBeUndefined();
  });

  it("GET /user returns 200 — proxy attests credential injection", async () => {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        "X-Resource": "github-pat",
        "Accept": "application/vnd.github+json",
      },
    });

    // Explicit proxy chain verification — proves request went through proxy
    // and credentials were injected (not passed directly from agent env).
    expect(response.headers.get("x-proxied-by")).toBe("credential-proxy");
    expect(response.headers.get("x-credential-injected")).toBe("true");
    expect(response.headers.get("x-resource-resolved")).toBe("github-pat");

    expect(response.status).toBe(200);
    const data = await response.json() as Record<string, unknown>;
    expect(data).toHaveProperty("login");
  }, 15_000);

  it("GET /repos/<your-org>/<your-repo>/pulls?state=open returns 200 with array result", async () => {
    const response = await fetch(
      "https://api.github.com/repos/<your-org>/<your-repo>/pulls?state=open",
      {
        headers: {
          "X-Resource": "github-pat",
          "Accept": "application/vnd.github+json",
        },
      }
    );

    expect(response.status).toBe(200);

    const data = await response.json() as unknown[];
    expect(Array.isArray(data)).toBe(true);
  }, 15_000);

  it("GET /user/repos returns 200 with array result", async () => {
    const response = await fetch("https://api.github.com/user/repos", {
      headers: {
        "X-Resource": "github-pat",
        "Accept": "application/vnd.github+json",
      },
    });

    expect(response.status).toBe(200);

    const data = await response.json() as unknown[];
    expect(Array.isArray(data)).toBe(true);
  }, 15_000);

  it("POST comment to open PR then DELETE it (write action)", async () => {
    // Fetch open PRs to get the first PR number dynamically
    const pullsResponse = await fetch(
      "https://api.github.com/repos/<your-org>/<your-repo>/pulls?state=open",
      {
        headers: {
          "X-Resource": "github-pat",
          "Accept": "application/vnd.github+json",
        },
      }
    );
    expect(pullsResponse.status).toBe(200);
    const pulls = await pullsResponse.json() as Array<{ number: number }>;

    if (pulls.length === 0) {
      // No open PRs — skip write test gracefully
      console.warn("No open PRs found; skipping write action test");
      return;
    }

    const prNumber = pulls[0].number;

    // POST a comment to the PR (PRs share the issues comments endpoint)
    const postResponse = await fetch(
      `https://api.github.com/repos/<your-org>/<your-repo>/issues/${prNumber}/comments`,
      {
        method: "POST",
        headers: {
          "X-Resource": "github-pat",
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: "(automated test — please ignore)" }),
      }
    );
    expect(postResponse.status).toBe(201);

    const commentData = await postResponse.json() as Record<string, unknown>;
    expect(commentData).toHaveProperty("id");

    const commentId = commentData.id as number;

    // DELETE the comment to clean up — no orphaned comments
    const deleteResponse = await fetch(
      `https://api.github.com/repos/<your-org>/<your-repo>/issues/comments/${commentId}`,
      {
        method: "DELETE",
        headers: {
          "X-Resource": "github-pat",
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
        },
      }
    );
    expect(deleteResponse.status).toBe(204);
  }, 30_000);
});
