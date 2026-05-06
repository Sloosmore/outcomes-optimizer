import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import type {
  InstagramAdapter,
  InstagramSession,
  InstagramCredentials,
  SessionState,
  PhotoPostOptions,
  VideoPostOptions,
  ReelPostOptions,
  PostResult,
  PostStatus,
  ProfileInfo,
  MediaInsights,
} from "../types.js";
import { getProxyFetch } from "../../utils/fetch.js";
import { safeJsonParse } from "../../utils/json.js";
import { GRAPH_API_BASE } from "../../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the Python runner script (at package root) */
const RUNNER_PATH = resolve(__dirname, "../../../runner.py");

/** Result returned by runner.py on stdout */
interface RunnerResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * Spawn runner.py with the given operation payload.
 * The payload is written to stdin as JSON; stdout is parsed as JSON.
 * Password is never logged or persisted — it flows only through stdin.
 * Returns the full parsed result so callers can read extra fields (e.g. profile).
 */
async function runnerOp(
  payload: Record<string, unknown>
): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [RUNNER_PATH], {
      stdio: ["pipe", "pipe", "inherit"], // stdin=pipe, stdout=pipe, stderr=inherit
    });

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn runner.py: ${err.message}`));
    });

    child.on("close", (_code) => {
      let result: RunnerResult;
      try {
        result = JSON.parse(stdout.trim()) as RunnerResult;
      } catch {
        reject(new Error(`runner.py output was not valid JSON: ${stdout.slice(0, 200)}`));
        return;
      }

      if (!result.ok) {
        reject(new Error(result.error ?? "runner.py reported failure"));
        return;
      }

      resolve(result);
    });

    // Write payload to stdin and close it
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

/**
 * Make a Graph API GET request using the provided token.
 * Used for read-back verification after write operations.
 */
async function graphGet<T>(
  path: string,
  accessToken: string,
  params?: Record<string, string>
): Promise<T> {
  const url = new URL(`${GRAPH_API_BASE}${path}`);
  url.searchParams.set("access_token", accessToken);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const proxyFetch = getProxyFetch();
  const res = await proxyFetch(url.toString());

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = `Graph API error: ${res.status} ${res.statusText}`;
    try {
      const j = JSON.parse(body);
      if (j.error?.message) msg = j.error.message;
    } catch {}
    throw new Error(msg);
  }

  return safeJsonParse<T>(res, path);
}

/**
 * InstagrapiSession — wraps runner.py for profile write operations
 * and the Graph API for all read operations.
 *
 * The password is held only in memory and is never written to disk.
 */
export class InstagrapiSession implements InstagramSession {
  readonly accountId: string;
  readonly username: string;
  readonly credentials: SessionState;

  private accessToken: string;
  private password: string;

  constructor(credentials: SessionState, password: string) {
    this.accountId = credentials.businessAccountId;
    this.username = credentials.username;
    this.accessToken = credentials.accessToken;
    this.credentials = credentials;
    this.password = password;
  }

  // ── Profile write operations (via runner.py + instagrapi) ──────────────────

  async setProfileBio(bio: string): Promise<void> {
    await runnerOp({
      op: "set_bio",
      username: this.username,
      password: this.password,
      bio,
    });
  }

  async setProfileName(name: string): Promise<void> {
    await runnerOp({
      op: "set_name",
      username: this.username,
      password: this.password,
      name,
    });
  }

  async setProfileWebsite(url: string): Promise<void> {
    await runnerOp({
      op: "set_website",
      username: this.username,
      password: this.password,
      url,
    });
  }

  async setProfilePicture(imagePath: string): Promise<void> {
    await runnerOp({
      op: "set_pic",
      username: this.username,
      password: this.password,
      image_path: imagePath,
    });
  }

  // ── Profile read ───────────────────────────────────────────────────────────

  async getProfile(): Promise<ProfileInfo> {
    // When password is available (write-capable session), use instagrapi for
    // read-back so we stay within the same auth context and avoid a separate
    // Graph API token dependency.
    if (this.password) {
      const result = await runnerOp({
        op: "get_profile",
        username: this.username,
        password: this.password,
      });
      const p = result["profile"] as ProfileInfo;
      return p;
    }

    // Fall back to Graph API for read-only sessions restored from state file.
    interface ProfileResponse {
      id?: string;
      username?: string;
      name?: string;
      biography?: string;
      followers_count?: number;
      follows_count?: number;
      media_count?: number;
      profile_picture_url?: string;
      website?: string;
    }

    const data = await graphGet<ProfileResponse>(
      `/${encodeURIComponent(this.accountId)}`,
      this.accessToken,
      {
        fields:
          "id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,website",
      }
    );

    return {
      username: data.username ?? this.username,
      name: data.name ?? "",
      biography: data.biography ?? "",
      followersCount: data.followers_count ?? 0,
      followsCount: data.follows_count ?? 0,
      mediaCount: data.media_count ?? 0,
      profilePictureUrl: data.profile_picture_url ?? "",
      website: data.website ?? "",
    };
  }

  // ── Post operations — not supported by this adapter ────────────────────────

  postPhoto(_options: PhotoPostOptions): Promise<PostResult> {
    return Promise.reject(
      new Error("postPhoto is not supported by the instagrapi adapter")
    );
  }

  postVideo(_options: VideoPostOptions): Promise<PostResult> {
    return Promise.reject(
      new Error("postVideo is not supported by the instagrapi adapter")
    );
  }

  postReel(_options: ReelPostOptions): Promise<PostResult> {
    return Promise.reject(
      new Error("postReel is not supported by the instagrapi adapter")
    );
  }

  getPostStatus(_postId: string): Promise<PostStatus> {
    return Promise.reject(
      new Error("getPostStatus is not supported by the instagrapi adapter")
    );
  }

  getMediaInsights(_mediaId: string): Promise<MediaInsights> {
    return Promise.reject(
      new Error("getMediaInsights is not supported by the instagrapi adapter")
    );
  }
}

/**
 * InstagrapiAdapter — creates InstagrapiSession instances.
 *
 * Note: createSession/restoreSession do not receive a password because
 * passwords are never stored. Commands that need write access must construct
 * InstagrapiSession directly with credentials from environment variables.
 */
export class InstagrapiAdapter implements InstagramAdapter {
  readonly name = "instagrapi";

  async createSession(credentials: InstagramCredentials): Promise<InstagramSession> {
    const state: SessionState = {
      accessToken: credentials.accessToken,
      businessAccountId: credentials.businessAccountId,
      username: "",
      created: new Date().toISOString(),
      adapter: this.name,
    };
    // Password is not available here — session can only do Graph API reads
    return new InstagrapiSession(state, "");
  }

  restoreSession(savedState: SessionState): InstagramSession {
    // Password is not stored — session is read-only via Graph API
    return new InstagrapiSession(savedState, "");
  }
}
