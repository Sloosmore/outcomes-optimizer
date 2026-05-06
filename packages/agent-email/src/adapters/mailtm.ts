import { randomBytes } from "node:crypto";
import type {
  EmailAdapter,
  EmailSession,
  SessionOptions,
  SessionCredentials,
  EmailSummary,
  Email,
} from "./types.js";
import { getProxyFetch } from "../utils/fetch.js";
import { safeJsonParse } from "../utils/json.js";

const BASE_URL = "https://api.mail.tm";

// Use proxy-aware fetch with 30s timeout
const proxyFetch = getProxyFetch();

/**
 * Generate a cryptographically secure random string
 */
function generateSecureRandom(length: number, charset: string): string {
  const bytes = randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += charset[bytes[i] % charset.length];
  }
  return result;
}

/**
 * Generate a secure password
 */
function generatePassword(length = 16): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%";
  return generateSecureRandom(length, chars);
}

/**
 * Generate a random login name
 */
function generateLogin(length = 10): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return generateSecureRandom(length, chars);
}

/**
 * mail.tm session - represents an authenticated inbox
 */
class MailTmSession implements EmailSession {
  readonly address: string;
  readonly login: string;
  readonly domain: string;
  readonly credentials: SessionCredentials;

  private token: string;

  constructor(credentials: SessionCredentials) {
    if (!credentials.token) {
      throw new Error("MailTmSession requires a token in credentials");
    }
    this.address = credentials.address;
    this.login = credentials.login;
    this.domain = credentials.domain;
    this.token = credentials.token;
    this.credentials = credentials;
  }

  async list(maxResults?: number): Promise<EmailSummary[]> {
    const res = await proxyFetch(`${BASE_URL}/messages`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (!res.ok) {
      throw new Error(`Failed to list emails: ${res.status} ${res.statusText}`);
    }

    interface MailTmMessage {
      id: string;
      from: { address: string };
      subject: string;
      createdAt: string;
    }
    const data = await safeJsonParse<{ "hydra:member"?: MailTmMessage[] }>(
      res,
      "List emails"
    );
    const messages = data["hydra:member"] || [];

    const summaries = messages.map((msg) => ({
      id: msg.id,
      from: msg.from?.address || "unknown",
      subject: msg.subject || "(no subject)",
      date: msg.createdAt,
    }));
    return maxResults ? summaries.slice(0, maxResults) : summaries;
  }

  async read(id: string): Promise<Email> {
    const res = await proxyFetch(`${BASE_URL}/messages/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (!res.ok) {
      throw new Error(`Failed to read email: ${res.status} ${res.statusText}`);
    }

    interface MailTmFullMessage {
      id: string;
      from: { address: string };
      subject: string;
      createdAt: string;
      text?: string;
      html?: string[];
      attachments?: Array<{
        filename: string;
        contentType: string;
        size: number;
      }>;
    }
    const msg = await safeJsonParse<MailTmFullMessage>(res, "Read email");

    return {
      id: msg.id,
      from: msg.from?.address || "unknown",
      subject: msg.subject || "(no subject)",
      date: msg.createdAt,
      textBody: msg.text || "",
      htmlBody: Array.isArray(msg.html) ? msg.html.join("") : (msg.html || ""),
      attachments: (msg.attachments || []).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
      })),
    };
  }

  async close(): Promise<void> {
    // Could implement account deletion here if needed
    // For now, mail.tm accounts auto-expire
  }
}

/**
 * mail.tm adapter - creates and restores sessions
 */
export class MailTmAdapter implements EmailAdapter {
  readonly name = "mailtm";

  /**
   * Get available domains
   */
  private async getDomains(): Promise<string[]> {
    const res = await proxyFetch(`${BASE_URL}/domains`);
    if (!res.ok) {
      throw new Error(`Failed to get domains: ${res.status} ${res.statusText}`);
    }
    const data = await safeJsonParse<{ "hydra:member"?: Array<{ domain: string }> }>(
      res,
      "Get domains"
    );
    const members = data["hydra:member"];
    if (!Array.isArray(members)) {
      throw new Error("Invalid API response: missing domain list");
    }
    return members.map((d) => d.domain);
  }

  async createSession(options: SessionOptions = {}): Promise<EmailSession> {
    // Get available domains
    const domains = await this.getDomains();
    if (domains.length === 0) {
      throw new Error("No domains available from mail.tm");
    }

    const domain = options.domain && domains.includes(options.domain)
      ? options.domain
      : domains[0];

    const login = options.name || generateLogin();
    const address = `${login}@${domain}`;
    const password = generatePassword();

    // Create account
    const createRes = await proxyFetch(`${BASE_URL}/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, password }),
    });

    if (!createRes.ok) {
      throw new Error(`Failed to create account: ${createRes.status} ${createRes.statusText}`);
    }

    const account = await safeJsonParse<{ id?: string }>(createRes, "Create account");
    if (!account.id) {
      throw new Error("Invalid API response: missing account ID");
    }

    // Get auth token
    const tokenRes = await proxyFetch(`${BASE_URL}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, password }),
    });

    if (!tokenRes.ok) {
      throw new Error(`Failed to get token: ${tokenRes.status} ${tokenRes.statusText}`);
    }

    const tokenData = await safeJsonParse<{ token?: string }>(tokenRes, "Get token");
    if (!tokenData.token) {
      throw new Error("Invalid API response: missing auth token");
    }

    const credentials: SessionCredentials = {
      address,
      login,
      domain,
      token: tokenData.token,
      accountId: account.id,
      password,
    };

    return new MailTmSession(credentials);
  }

  restoreSession(credentials: SessionCredentials): EmailSession {
    return new MailTmSession(credentials);
  }
}
