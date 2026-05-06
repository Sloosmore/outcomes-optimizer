import { loadState } from "../state/inbox.js";

/**
 * Show the current inbox address
 */
export async function addressCommand(): Promise<void> {
  const state = await loadState();

  if (!state) {
    console.error("Error: No inbox initialized. Run 'throwmail init' first.");
    process.exit(1);
  }

  console.log(state.address);
}
