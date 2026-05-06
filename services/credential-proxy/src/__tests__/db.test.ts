/**
 * Unit tests for db.ts credential resolution.
 * Mocks the database to avoid real DB access.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// We need to mock the drizzle DB before importing db.ts
// Use vi.mock to mock the postgres module
vi.mock("postgres", () => {
  return {
    default: vi.fn(() => ({
      end: vi.fn(),
    })),
  };
});

vi.mock("drizzle-orm/postgres-js", () => {
  return {
    drizzle: vi.fn(() => ({
      execute: vi.fn(),
    })),
  };
});

import { drizzle } from "drizzle-orm/postgres-js";
import { resolveCredentialForResource, resolveCredentialByHostname, closeDb } from "../db.js";

describe("db - proxyUrlEnvVar resolution", () => {
  let mockExecute: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Reset the DB singleton so getDb() calls drizzle() fresh each test.
    await closeDb();

    vi.clearAllMocks();

    mockExecute = vi.fn();
    (drizzle as ReturnType<typeof vi.fn>).mockReturnValue({
      execute: mockExecute,
    });

    // Set DATABASE_URL to prevent "not set" error
    process.env.DATABASE_URL = "postgresql://fake/db";
  });

  it("returns proxyUrlEnvVar when resource has proxyResourceId", async () => {
    // First call: resource lookup
    mockExecute.mockResolvedValueOnce([{
      id: "test-resource-id",
      name: "instagram-squarebent",
      type: "instagram",
      config: {
        dopplerProject: "test-doppler-project",
        envVars: ["INSTAGRAM_TOKEN"],
        urls: ["graph.instagram.com"],
        proxyResourceId: "80e99213-7959-4245-a352-bfb8f870b0df",
      },
    }]);

    // Second call: resource_links lookup (no credential link — uses inline config)
    mockExecute.mockResolvedValueOnce([]);

    // Third call: proxy resource lookup
    mockExecute.mockResolvedValueOnce([{
      proxy_url_env_var: "PROXY_01_URL",
    }]);

    const result = await resolveCredentialForResource("instagram-squarebent");

    expect(result).not.toBeNull();
    expect(result!.proxyUrlEnvVar).toBe("PROXY_01_URL");
  });

  it("returns proxyUrlEnvVar as undefined when resource has no proxyResourceId", async () => {
    mockExecute.mockResolvedValueOnce([{
      id: "test-resource-id",
      name: "github-pat",
      type: "credential",
      config: {
        dopplerProject: "test-doppler-project",
        envVars: ["GITHUB_PAT"],
        urls: ["api.github.com"],
        // no proxyResourceId
      },
    }]);

    // resource_links lookup
    mockExecute.mockResolvedValueOnce([]);

    const result = await resolveCredentialForResource("github-pat");

    expect(result).not.toBeNull();
    expect(result!.proxyUrlEnvVar).toBeUndefined();
    // Verify proxy query was NOT called (only 2 DB calls total)
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("returns proxyUrlEnvVar as undefined for malformed UUID (no DB query)", async () => {
    mockExecute.mockResolvedValueOnce([{
      id: "test-resource-id",
      name: "test-resource",
      type: "instagram",
      config: {
        dopplerProject: "test-doppler-project",
        envVars: ["SOME_TOKEN"],
        urls: ["api.example.com"],
        proxyResourceId: "not-a-valid-uuid",
      },
    }]);

    // resource_links lookup
    mockExecute.mockResolvedValueOnce([]);

    const result = await resolveCredentialForResource("test-resource");

    expect(result).not.toBeNull();
    expect(result!.proxyUrlEnvVar).toBeUndefined();
    // Malformed UUID should skip the proxy query — only 2 DB calls
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });
});

describe("db - resource_link credential resolution", () => {
  let mockExecute: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await closeDb();
    vi.clearAllMocks();

    mockExecute = vi.fn();
    (drizzle as ReturnType<typeof vi.fn>).mockReturnValue({
      execute: mockExecute,
    });

    process.env.DATABASE_URL = "postgresql://fake/db";
  });

  it("resolves credential via identity -> credential link", async () => {
    // Query 1: resource lookup returns identity resource
    mockExecute.mockResolvedValueOnce([{
      id: "identity-1",
      name: "github-pat",
      type: "identity",
      config: {
        platform: "github",
        urls: ["api.github.com", "github.com"],
      },
    }]);

    // Query 2: resource_links returns a credential link
    mockExecute.mockResolvedValueOnce([{ to_id: "cred-1" }]);

    // Query 3: credential resource lookup
    mockExecute.mockResolvedValueOnce([{
      config: {
        dopplerProject: "test-doppler-project",
        envVars: ["GITHUB_PAT"],
        injectAs: "bearer",
      },
    }]);

    const result = await resolveCredentialForResource("github-pat");

    expect(result).not.toBeNull();
    expect(result!.resourceName).toBe("github-pat");
    expect(result!.urls).toEqual(["api.github.com", "github.com"]);
    expect(result!.dopplerProject).toBe("test-doppler-project");
    expect(result!.envVars).toEqual(["GITHUB_PAT"]);
    expect(result!.injectAs).toBe("bearer");
    // No proxyResourceId on identity config — no proxy query
    expect(mockExecute).toHaveBeenCalledTimes(3);
  });

  it("falls back to inline config when no resource_link exists", async () => {
    // Query 1: resource with inline credential config
    mockExecute.mockResolvedValueOnce([{
      id: "cred-direct",
      name: "credential-github-pat",
      type: "credential",
      config: {
        dopplerProject: "test-doppler-project",
        envVars: ["GITHUB_PAT"],
        injectAs: "bearer",
        urls: [],
      },
    }]);

    // Query 2: no links found
    mockExecute.mockResolvedValueOnce([]);

    const result = await resolveCredentialForResource("credential-github-pat");

    expect(result).not.toBeNull();
    expect(result!.dopplerProject).toBe("test-doppler-project");
    expect(result!.envVars).toEqual(["GITHUB_PAT"]);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("returns null when resource is not found", async () => {
    // Query 1: empty result
    mockExecute.mockResolvedValueOnce([]);

    const result = await resolveCredentialForResource("nonexistent-resource");

    expect(result).toBeNull();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("returns null when linked credential resource is deleted/inactive", async () => {
    // Query 1: identity resource exists
    mockExecute.mockResolvedValueOnce([{
      id: "identity-1",
      name: "github-pat",
      type: "identity",
      config: { urls: ["api.github.com"] },
    }]);

    // Query 2: link exists pointing to a credential
    mockExecute.mockResolvedValueOnce([{ to_id: "deleted-cred" }]);

    // Query 3: credential resource not found (deleted/inactive)
    mockExecute.mockResolvedValueOnce([]);

    const result = await resolveCredentialForResource("github-pat");

    expect(result).toBeNull();
    expect(mockExecute).toHaveBeenCalledTimes(3);
  });

  it("returns null when linked credential has invalid config", async () => {
    // Query 1: identity resource
    mockExecute.mockResolvedValueOnce([{
      id: "identity-1",
      name: "github-pat",
      type: "identity",
      config: { urls: ["api.github.com"] },
    }]);

    // Query 2: link exists
    mockExecute.mockResolvedValueOnce([{ to_id: "bad-cred" }]);

    // Query 3: credential resource with invalid config (missing dopplerProject/envVars)
    mockExecute.mockResolvedValueOnce([{
      config: { somethingElse: true },
    }]);

    const result = await resolveCredentialForResource("github-pat");

    expect(result).toBeNull();
  });
});

describe("db - resolveCredentialByHostname", () => {
  let mockExecute: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await closeDb();
    vi.clearAllMocks();

    mockExecute = vi.fn();
    (drizzle as ReturnType<typeof vi.fn>).mockReturnValue({
      execute: mockExecute,
    });

    process.env.DATABASE_URL = "postgresql://fake/db";
  });

  it("resolves credential by hostname match", async () => {
    // Query 1: hostname lookup finds a resource
    mockExecute.mockResolvedValueOnce([{
      id: "identity-1",
      name: "github-pat",
      config: { urls: ["api.github.com"] },
    }]);

    // resolveCredentialForResource is called internally with "github-pat"
    // Query 2: resource lookup
    mockExecute.mockResolvedValueOnce([{
      id: "identity-1",
      name: "github-pat",
      type: "identity",
      config: {
        platform: "github",
        urls: ["api.github.com", "github.com"],
      },
    }]);

    // Query 3: resource_links
    mockExecute.mockResolvedValueOnce([{ to_id: "cred-1" }]);

    // Query 4: credential resource
    mockExecute.mockResolvedValueOnce([{
      config: {
        dopplerProject: "test-doppler-project",
        envVars: ["GITHUB_PAT"],
        injectAs: "bearer",
      },
    }]);

    const result = await resolveCredentialByHostname("api.github.com");

    expect(result).not.toBeNull();
    expect(result!.resourceName).toBe("github-pat");
  });

  it("returns null for unknown hostname", async () => {
    // Hostname query returns no matches
    mockExecute.mockResolvedValueOnce([]);

    const result = await resolveCredentialByHostname("unknown.example.com");

    expect(result).toBeNull();
  });

  it("returns null for invalid hostname format", async () => {
    const result = await resolveCredentialByHostname("not a valid host!");

    expect(result).toBeNull();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe("db - error propagation", () => {
  let mockExecute: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await closeDb();
    vi.clearAllMocks();

    mockExecute = vi.fn();
    (drizzle as ReturnType<typeof vi.fn>).mockReturnValue({
      execute: mockExecute,
    });

    process.env.DATABASE_URL = "postgresql://fake/db";
  });

  it("propagates DB errors from resolveCredentialForResource", async () => {
    mockExecute.mockRejectedValueOnce(new Error("connection refused"));

    await expect(resolveCredentialForResource("any")).rejects.toThrow("connection refused");
  });

  it("propagates DB errors from resolveCredentialByHostname", async () => {
    mockExecute.mockRejectedValueOnce(new Error("connection refused"));

    await expect(resolveCredentialByHostname("example.com")).rejects.toThrow("connection refused");
  });
});
