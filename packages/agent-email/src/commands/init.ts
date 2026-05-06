import { adapterRegistry } from "../adapters/index.js";
import { saveState, clearState } from "../state/inbox.js";

export interface InitCommandOptions {
  name?: string;
  domain?: string;
  adapter?: string;
}

/**
 * Initialize a new inbox for this session
 */
export async function initCommand(options: InitCommandOptions): Promise<void> {
  const adapterName = options.adapter || adapterRegistry.getDefault();

  // Validate adapter exists
  if (!adapterRegistry.has(adapterName)) {
    const available = adapterRegistry.list().join(", ");
    console.error(`Unknown adapter: "${adapterName}". Available: ${available}`);
    process.exit(1);
  }

  try {
    // Get adapter and create session
    const adapter = adapterRegistry.get(adapterName);
    const session = await adapter.createSession({
      name: options.name,
      domain: options.domain,
    });

    // Clear any existing state and save new inbox
    await clearState();
    await saveState({
      address: session.address,
      login: session.login,
      domain: session.domain,
      created: new Date().toISOString(),
      seenIds: [],
      adapter: adapterName,
      credentials: session.credentials,
    });

    console.log(session.address);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error("Error initializing inbox");
    }
    process.exit(1);
  }
}
