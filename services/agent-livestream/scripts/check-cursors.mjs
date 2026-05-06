import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

// Valid v4 UUIDs for process IDs (13th char must be 4, 17th must be 8/9/a/b)
const PROCESSES = [
  {
    id: 'f5f58a8a-8013-4f98-8aa1-eb3c2cc888f6',
    name: 'agent-alpha',
    resourceId: '300f052b-f496-488d-b482-49375074d348',
  },
  {
    id: 'a0a3830e-c964-486c-99fc-6d2d3f37c15d',
    name: 'agent-beta',
    resourceId: '2fe45d18-6d62-4f5e-84d9-e0997986c23d',
  },
  {
    id: 'a2d1204d-4ad7-42fc-9e27-e75919e2954b',
    name: 'agent-gamma',
    resourceId: '9d7d3c49-a59a-4f9f-b34d-d81c9fad7181',
  },
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const EMITTER_SCRIPT = resolve(__dirname, '../../../scripts/emit-cursor-events.mjs');

function spawnEmitter(proc) {
  return new Promise((resolveP, reject) => {
    const child = spawn(
      process.execPath,
      [EMITTER_SCRIPT, proc.id, proc.name, proc.resourceId],
      {
        stdio: 'inherit',
        env: {
          SUPABASE_URL,
          SUPABASE_SERVICE_KEY,
        },
      },
    );
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Emitter ${proc.name} exited with code ${code}`));
      } else {
        resolveP();
      }
    });
  });
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  await page.goto('http://localhost:5173');
  console.log('Page loaded, waiting 5s for graph to render and SSE to subscribe...');
  await page.waitForTimeout(5000);

  // Spawn 3 concurrent sub-processes that each emit 5 AgentEvent rows.
  // Environment variables are explicitly forwarded via the env option.
  console.log('Spawning 3 emitter sub-processes...');
  await Promise.all(PROCESSES.map(p => spawnEmitter(p)));
  console.log('All emitter sub-processes completed.');

  console.log('Waiting 5s for SSE propagation to frontend...');
  await page.waitForTimeout(5000);

  // Check cursor nodes
  const cursorData = await page.evaluate(() => {
    const nodes = document.querySelectorAll('[data-cursor-node]');
    return Array.from(nodes).map(el => ({
      resourceId: el.getAttribute('data-cursor-node'),
      processId: el.getAttribute('data-cursor-process'),
      processName: el.getAttribute('data-cursor-name'),
    }));
  });

  console.log('Cursor nodes found:', JSON.stringify(cursorData, null, 2));

  const distinctResourceIds = new Set(cursorData.map(c => c.resourceId)).size;
  console.log(`Total cursor nodes: ${cursorData.length}, Distinct resource_ids: ${distinctResourceIds}`);

  // Take screenshot — path relative to repo root, not an absolute dispatch directory
  const screenshotPath = resolve(__dirname, '../../../../docs/screenshots/agent-livestream/cursors-live.png');
  await page.screenshot({
    path: screenshotPath,
    fullPage: false,
  });
  console.log(`Screenshot saved to ${screenshotPath}`);

  await browser.close();

  if (cursorData.length < 3) {
    console.error(`FAIL: only ${cursorData.length} cursor nodes (need >=3)`);
    process.exit(1);
  }
  if (distinctResourceIds < 3) {
    console.error(`FAIL: only ${distinctResourceIds} distinct resource_ids (need >=3)`);
    process.exit(1);
  }
  console.log('PASS: >=3 cursor nodes with distinct resource_ids');
}

main().catch(e => { console.error(e); process.exit(1); });
