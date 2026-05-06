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

const BASE_URL = "https://www.1secmail.com/api/v1/";

// Use proxy-aware fetch with 30s timeout
const proxyFetch = getProxyFetch();

/** Available domains for 1secmail */
export const DOMAINS = [
  "1secmail.com",
  "1secmail.org",
  "1secmail.net",
  "esiix.com",
  "wwjmp.com",
] as const;

export type OneSecMailDomain = (typeof DOMAINS)[number];

/**
 * Raw response from 1secmail getMessages endpoint
 */
interface OneSecMailMessage {
  id: number;
  from: string;
  subject: string;
  date: string;
}

/**
 * Raw response from 1secmail readMessage endpoint
 */
interface OneSecMailFullMessage extends OneSecMailMessage {
  body: string;
  textBody: string;
  htmlBody: string;
  attachments: Array<{
    filename: string;
    contentType: string;
    size: number;
  }>;
}

/**
 * 1secmail session - represents an inbox (stateless, no auth needed)
 */
class OneSecMailSession implements EmailSession {
  readonly address: string;
  readonly login: string;
  readonly domain: string;
  readonly credentials: SessionCredentials;

  constructor(credentials: SessionCredentials) {
    this.address = credentials.address;
    this.login = credentials.login;
    this.domain = credentials.domain;
    this.credentials = credentials;
  }

  async list(maxResults?: number): Promise<EmailSummary[]> {
    const url = `${BASE_URL}?action=getMessages&login=${encodeURIComponent(this.login)}&domain=${encodeURIComponent(this.domain)}`;
    const res = await proxyFetch(url);
    if (!res.ok) {
      throw new Error(`Failed to list emails: ${res.status} ${res.statusText}`);
    }
    const messages = await safeJsonParse<OneSecMailMessage[]>(res, "List emails");
    if (!Array.isArray(messages)) {
      throw new Error("Invalid API response: expected message array");
    }
    const summaries = messages.map((msg) => ({
      id: String(msg.id),
      from: msg.from || "unknown",
      subject: msg.subject || "(no subject)",
      date: msg.date,
    }));
    return maxResults ? summaries.slice(0, maxResults) : summaries;
  }

  async read(id: string): Promise<Email> {
    const url = `${BASE_URL}?action=readMessage&login=${encodeURIComponent(this.login)}&domain=${encodeURIComponent(this.domain)}&id=${encodeURIComponent(id)}`;
    const res = await proxyFetch(url);
    if (!res.ok) {
      throw new Error(`Failed to read email: ${res.status} ${res.statusText}`);
    }
    const msg = await safeJsonParse<OneSecMailFullMessage>(res, "Read email");
    return {
      id: String(msg.id),
      from: msg.from || "unknown",
      subject: msg.subject || "(no subject)",
      date: msg.date,
      textBody: msg.textBody || msg.body || "",
      htmlBody: msg.htmlBody || "",
      attachments: msg.attachments || [],
    };
  }

  // No cleanup needed for 1secmail - inboxes are public and ephemeral
}

/**
 * 1secmail.com adapter
 *
 * Note: 1secmail doesn't require "creating" an inbox.
 * Any address works - you just check for emails.
 * This means named inboxes work immediately but have no privacy.
 */
export class OneSecMailAdapter implements EmailAdapter {
  readonly name = "1secmail";

  async createSession(options: SessionOptions = {}): Promise<EmailSession> {
    let login: string;
    let domain: string;
    let address: string;

    if (options.name) {
      // User specified a name - use it directly
      domain = options.domain || DOMAINS[0];
      if (options.domain && !DOMAINS.includes(options.domain as OneSecMailDomain)) {
        throw new Error(
          `Invalid domain: ${options.domain}. Available: ${DOMAINS.join(", ")}`
        );
      }
      login = options.name;
      address = `${login}@${domain}`;
    } else {
      // No name specified - get random inbox from API
      const res = await proxyFetch(`${BASE_URL}?action=genRandomMailbox&count=1`);
      if (!res.ok) {
        throw new Error(`Failed to generate inbox: ${res.status} ${res.statusText}`);
      }
      const data = await safeJsonParse<string[]>(res, "Generate inbox");
      if (!Array.isArray(data) || data.length === 0 || typeof data[0] !== "string") {
        throw new Error("Invalid API response: expected email address array");
      }
      address = data[0];
      const atIndex = address.indexOf("@");
      if (atIndex === -1) {
        throw new Error(`Invalid email format from API: ${address}`);
      }
      login = address.slice(0, atIndex);
      domain = address.slice(atIndex + 1);
    }

    const credentials: SessionCredentials = {
      address,
      login,
      domain,
    };

    return new OneSecMailSession(credentials);
  }

  restoreSession(credentials: SessionCredentials): EmailSession {
    return new OneSecMailSession(credentials);
  }
}
