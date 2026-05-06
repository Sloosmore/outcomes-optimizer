/**
 * Options for creating a new inbox session
 */
export interface SessionOptions {
  /** Specific login name (e.g., "mytest") */
  name?: string;
  /** Specific domain (e.g., "esiix.com") */
  domain?: string;
}

/**
 * Credentials for restoring a session
 */
export interface SessionCredentials {
  /** Full email address */
  address: string;
  /** Login portion (before @) */
  login: string;
  /** Domain portion (after @) */
  domain: string;
  /** Auth token (for token-based adapters) */
  token?: string;
  /** Account ID */
  accountId?: string;
  /** Password (for password-based adapters) */
  password?: string;
  /** Additional adapter-specific fields */
  [key: string]: string | undefined;
}

/**
 * Summary of an email (from list endpoint)
 */
export interface EmailSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
}

/**
 * Attachment metadata
 */
export interface Attachment {
  filename: string;
  contentType: string;
  size: number;
}

/**
 * Full email content
 */
export interface Email extends EmailSummary {
  /** Plain text body */
  textBody: string;
  /** HTML body */
  htmlBody: string;
  /** Attachments */
  attachments: Attachment[];
}

/**
 * Email session - represents an active inbox connection
 *
 * Sessions encapsulate the connection state and provide
 * a clean API without leaking adapter-specific parameters.
 */
export interface EmailSession {
  /** Full email address */
  readonly address: string;
  /** Login portion (before @) */
  readonly login: string;
  /** Domain portion (after @) */
  readonly domain: string;
  /** Credentials for session persistence */
  readonly credentials: SessionCredentials;

  /** List emails in the inbox
   * @param maxResults - Maximum number of emails to return (adapter-specific default if not specified)
   */
  list(maxResults?: number): Promise<EmailSummary[]>;

  /** Read a specific email by ID */
  read(id: string): Promise<Email>;

  /** Optional cleanup (logout, etc.) */
  close?(): Promise<void>;

  /** Optional: Send an email (only supported by adapters with send capability) */
  send?(to: string, subject: string, body: string): Promise<void>;
}

/**
 * Email adapter interface - factory for creating sessions
 */
export interface EmailAdapter {
  /** Human-readable name of this adapter */
  readonly name: string;

  /** Whether this adapter supports sending (optional) */
  readonly supportsSend?: boolean;

  /** Create a new inbox session */
  createSession(options?: SessionOptions): Promise<EmailSession>;

  /** Restore a session from saved credentials */
  restoreSession(credentials: SessionCredentials): EmailSession;
}
