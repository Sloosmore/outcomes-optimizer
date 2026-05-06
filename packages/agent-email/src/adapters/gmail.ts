import type {
  EmailAdapter,
  EmailSession,
  SessionOptions,
  SessionCredentials,
  EmailSummary,
  Email,
} from "./types.js";
import { getProxyFetch, isInterceptorActive } from "../utils/fetch.js";
import { safeJsonParse } from "../utils/json.js";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_GMAIL_ADDRESS = "autoloosmore@gmail.com";
const DEFAULT_MAX_RESULTS = 20;

// Use proxy-aware fetch with 30s timeout
const proxyFetch = getProxyFetch();

/**
 * Gmail session - reads email from a Gmail account via OAuth2
 */
class GmailSession implements EmailSession {
  readonly address: string;
  readonly login: string;
  readonly domain: string;
  readonly credentials: SessionCredentials;

  private accessToken: string;
  private accessTokenExpiry: number;
  private refreshToken: string;
  private clientId: string;
  private clientSecret: string;

  constructor(credentials: SessionCredentials) {
    if (!credentials.refreshToken) {
      throw new Error("GmailSession requires refreshToken in credentials");
    }
    if (!isInterceptorActive() && (!credentials.clientId || !credentials.clientSecret)) {
      throw new Error("GmailSession requires clientId and clientSecret in credentials");
    }

    this.address = credentials.address;
    this.login = credentials.login;
    this.domain = credentials.domain;
    this.credentials = credentials;

    this.refreshToken = credentials.refreshToken;
    this.clientId = credentials.clientId || "proxy-managed";
    this.clientSecret = credentials.clientSecret || "proxy-managed";
    this.accessToken = credentials.accessToken || "";
    this.accessTokenExpiry = credentials.accessTokenExpiry
      ? parseInt(credentials.accessTokenExpiry, 10)
      : 0;
  }

  /**
   * Get a valid access token, refreshing if needed
   */
  private async getAccessToken(): Promise<string> {
    // If we have a valid token (with 60s buffer), use it
    if (this.accessToken && Date.now() < this.accessTokenExpiry - 60000) {
      return this.accessToken;
    }

    let res: Response;

    if (isInterceptorActive()) {
      // Proxy mode: intercepted fetch injects client_id, client_secret,
      // and refresh_token via the oauth2-refresh resource config.
      res = await globalThis.fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Resource": "gmail-oauth",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
        }),
      });
    } else {
      // Standalone fallback: build the full body from instance credentials.
      res = await proxyFetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: this.refreshToken,
          grant_type: "refresh_token",
        }),
      });
    }

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to refresh Gmail token: ${res.status} ${error}`);
    }

    const data = await safeJsonParse<{
      access_token: string;
      expires_in: number;
    }>(res, "Refresh token");

    this.accessToken = data.access_token;
    this.accessTokenExpiry = Date.now() + data.expires_in * 1000;

    // Update credentials for persistence
    this.credentials.accessToken = this.accessToken;
    this.credentials.accessTokenExpiry = String(this.accessTokenExpiry);

    return this.accessToken;
  }

  async list(maxResults: number = DEFAULT_MAX_RESULTS): Promise<EmailSummary[]> {
    const token = await this.getAccessToken();

    // List messages
    const listRes = await proxyFetch(
      `${GMAIL_API_BASE}/messages?maxResults=${maxResults}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (!listRes.ok) {
      throw new Error(`Failed to list Gmail messages: ${listRes.status} ${listRes.statusText}`);
    }

    interface GmailListResponse {
      messages?: Array<{ id: string; threadId: string }>;
    }
    const listData = await safeJsonParse<GmailListResponse>(listRes, "List messages");

    if (!listData.messages || listData.messages.length === 0) {
      return [];
    }

    // Fetch metadata for each message
    const summaries: EmailSummary[] = [];

    for (const msg of listData.messages) {
      const metaRes = await proxyFetch(
        `${GMAIL_API_BASE}/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!metaRes.ok) continue;

      interface GmailMessageMeta {
        id: string;
        payload?: {
          headers?: Array<{ name: string; value: string }>;
        };
      }
      const meta = await safeJsonParse<GmailMessageMeta>(metaRes, "Get message metadata");

      const headers = meta.payload?.headers || [];
      const fromHeader = headers.find((h) => h.name.toLowerCase() === "from");
      const subjectHeader = headers.find((h) => h.name.toLowerCase() === "subject");
      const dateHeader = headers.find((h) => h.name.toLowerCase() === "date");

      summaries.push({
        id: meta.id,
        from: fromHeader?.value || "unknown",
        subject: subjectHeader?.value || "(no subject)",
        date: dateHeader?.value || "",
      });
    }

    return summaries;
  }

  async read(id: string): Promise<Email> {
    const token = await this.getAccessToken();

    const res = await proxyFetch(
      `${GMAIL_API_BASE}/messages/${encodeURIComponent(id)}?format=full`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (!res.ok) {
      throw new Error(`Failed to read Gmail message: ${res.status} ${res.statusText}`);
    }

    interface GmailPart {
      mimeType: string;
      filename?: string;
      body?: {
        size: number;
        data?: string;
        attachmentId?: string;
      };
      parts?: GmailPart[];
    }

    interface GmailMessage {
      id: string;
      payload: {
        headers?: Array<{ name: string; value: string }>;
        mimeType: string;
        body?: {
          size: number;
          data?: string;
        };
        parts?: GmailPart[];
      };
    }

    const msg = await safeJsonParse<GmailMessage>(res, "Read message");

    const headers = msg.payload.headers || [];
    const fromHeader = headers.find((h) => h.name.toLowerCase() === "from");
    const subjectHeader = headers.find((h) => h.name.toLowerCase() === "subject");
    const dateHeader = headers.find((h) => h.name.toLowerCase() === "date");

    // Extract body content
    let textBody = "";
    let htmlBody = "";
    const attachments: Email["attachments"] = [];

    function processPartRecursive(part: GmailPart): void {
      if (part.body?.data) {
        const decoded = Buffer.from(part.body.data, "base64url").toString("utf-8");
        if (part.mimeType === "text/plain") {
          textBody += decoded;
        } else if (part.mimeType === "text/html") {
          htmlBody += decoded;
        }
      }

      if (part.filename && part.body?.attachmentId) {
        attachments.push({
          filename: part.filename,
          contentType: part.mimeType,
          size: part.body.size,
        });
      }

      if (part.parts) {
        for (const subpart of part.parts) {
          processPartRecursive(subpart);
        }
      }
    }

    // Process payload body directly if present
    if (msg.payload.body?.data) {
      const decoded = Buffer.from(msg.payload.body.data, "base64url").toString("utf-8");
      if (msg.payload.mimeType === "text/plain") {
        textBody = decoded;
      } else if (msg.payload.mimeType === "text/html") {
        htmlBody = decoded;
      }
    }

    // Process parts recursively
    if (msg.payload.parts) {
      for (const part of msg.payload.parts) {
        processPartRecursive(part);
      }
    }

    return {
      id: msg.id,
      from: fromHeader?.value || "unknown",
      subject: subjectHeader?.value || "(no subject)",
      date: dateHeader?.value || "",
      textBody,
      htmlBody,
      attachments,
    };
  }

  async close(): Promise<void> {
    // Nothing to clean up - token will expire naturally
  }
}

/**
 * Gmail adapter - creates sessions using OAuth2 refresh tokens
 *
 * Unlike disposable email adapters, Gmail doesn't create new accounts.
 * It uses pre-configured OAuth credentials from environment variables.
 *
 * Dual-mode operation:
 *   - **Interceptor active**: Credentials are proxy-managed; only
 *     GMAIL_ADDRESS (optional) is read from env. The proxy injects
 *     client_id, client_secret, and refresh_token at token-exchange time.
 *   - **Standalone fallback**: Reads GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
 *     and GMAIL_REFRESH_TOKEN from env (original behavior).
 */
export class GmailAdapter implements EmailAdapter {
  readonly name = "gmail";

  async createSession(_options: SessionOptions = {}): Promise<EmailSession> {
    const address = process.env.GMAIL_ADDRESS || DEFAULT_GMAIL_ADDRESS;
    const [login, domain] = address.split("@");

    if (isInterceptorActive()) {
      // Proxy mode: credentials are injected by the interceptor at
      // token-exchange time. Use placeholders for session construction.
      const credentials: SessionCredentials = {
        address,
        login,
        domain,
        refreshToken: "proxy-managed",
        clientId: "proxy-managed",
        clientSecret: "proxy-managed",
      };

      return new GmailSession(credentials);
    }

    // Standalone fallback: require all env vars
    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

    if (!clientId || !clientSecret) {
      throw new Error(
        "Gmail adapter requires GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET environment variables. " +
        "Set these up in Google Cloud Console OAuth credentials."
      );
    }

    if (!refreshToken) {
      throw new Error(
        "Gmail adapter requires GMAIL_REFRESH_TOKEN environment variable. " +
        "Run 'npx tsx scripts/gmail-auth.ts' to generate one."
      );
    }

    const credentials: SessionCredentials = {
      address,
      login,
      domain,
      refreshToken,
      clientId,
      clientSecret,
    };

    return new GmailSession(credentials);
  }

  restoreSession(credentials: SessionCredentials): EmailSession {
    return new GmailSession(credentials);
  }
}
