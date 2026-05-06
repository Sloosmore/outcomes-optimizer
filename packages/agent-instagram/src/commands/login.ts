import { adapterRegistry } from "../adapters/index.js";
import { saveSession, clearSession } from "../state/session.js";
import { printOutput, exitWithError } from "../utils/output.js";

export interface LoginCommandOptions {
  adapter?: string;
  token?: string;
  accountId?: string;
  json?: boolean;
}

/**
 * Authenticate with Instagram
 *
 * Uses either provided --token or environment variables:
 *   INSTAGRAM_ACCESS_TOKEN
 *   INSTAGRAM_BUSINESS_ACCOUNT_ID
 */
export async function loginCommand(options: LoginCommandOptions): Promise<void> {
  const adapterName = options.adapter || adapterRegistry.getDefault();

  if (!adapterRegistry.has(adapterName)) {
    const available = adapterRegistry.list().join(", ");
    exitWithError(`Unknown adapter: "${adapterName}". Available: ${available}`);
  }

  const accessToken =
    options.token || process.env.INSTAGRAM_ACCESS_TOKEN;
  const businessAccountId =
    options.accountId || process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;

  if (!accessToken) {
    exitWithError(
      "No access token provided. Use --token <token> or set INSTAGRAM_ACCESS_TOKEN."
    );
  }

  if (!businessAccountId) {
    exitWithError(
      "No business account ID provided. Use --account-id <id> or set INSTAGRAM_BUSINESS_ACCOUNT_ID."
    );
  }

  try {
    const adapter = adapterRegistry.get(adapterName);
    const session = await adapter.createSession({
      accessToken,
      businessAccountId,
    });

    // Clear any existing session and save new one
    await clearSession();
    await saveSession(session.credentials);

    const result = {
      username: session.username,
      accountId: session.accountId,
      adapter: adapterName,
    };

    if (options.json) {
      printOutput(result, true);
    } else {
      console.log(`Logged in as @${session.username} (${session.accountId})`);
      console.log(`Adapter: ${adapterName}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      exitWithError(error.message);
    }
    exitWithError("Failed to authenticate with Instagram");
  }
}
