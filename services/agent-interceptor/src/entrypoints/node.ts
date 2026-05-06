import { serve } from "@hono/node-server";
import { createApp } from "../app.js";
import { parseConfig, DEFAULT_PORT } from "../config.js";
import { MemoryEventStore } from "../store/memory.js";
import { createStaticStore } from "@skill-networks/doppler-secrets";
import { createLogger, registerDrain, DatabaseDrain } from "@skill-networks/logger";
import { getDb, isDatabaseEnabled } from "@skill-networks/database/drizzle";
import { logs } from "@skill-networks/database/schema";

registerDrain(new DatabaseDrain({ getDb, isDatabaseEnabled, logsTable: logs }));

const config = parseConfig(createStaticStore(
  Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)
  )
));
const store = new MemoryEventStore();
const logger = createLogger('webhook');
const app = createApp(config, store, logger);
const port = Number(process.env.PORT ?? DEFAULT_PORT);
serve({ fetch: app.fetch, port });
logger.info(`agent-interceptor listening on :${port}`, { mode: 'in-memory', port });
