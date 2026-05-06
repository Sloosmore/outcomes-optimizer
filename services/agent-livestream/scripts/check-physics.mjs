import { chromium } from '@playwright/test';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  await page.goto('http://localhost:5173');
  await page.waitForTimeout(5000); // wait 5s for physics to settle

  // Check 1: Node count in viewport
  const nodeRects = await page.evaluate(() => {
    const nodes = document.querySelectorAll('[data-node-id]');
    return Array.from(nodes).map(el => {
      const rect = el.getBoundingClientRect();
      return {
        id: el.getAttribute('data-node-id'),
        x: rect.left, y: rect.top,
        w: rect.width, h: rect.height,
        inViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight
      };
    });
  });

  const inViewport = nodeRects.filter(n => n.inViewport).length;
  const total = nodeRects.length;
  console.log(`Total nodes: ${total}, In viewport: ${inViewport}`);

  // Check 2: Zero overlap
  let overlappingPairs = 0;
  for (let i = 0; i < nodeRects.length; i++) {
    for (let j = i + 1; j < nodeRects.length; j++) {
      const a = nodeRects[i], b = nodeRects[j];
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
        overlappingPairs++;
      }
    }
  }
  console.log(`Overlapping pairs: ${overlappingPairs}`);

  // Take screenshot of full page
  await page.screenshot({
    path: '/root/dispatch/9cd505f0/docs/screenshots/agent-livestream/graph-settled.png',
    fullPage: false  // viewport-only for the canvas view
  });
  console.log('Screenshot saved to docs/screenshots/agent-livestream/graph-settled.png');

  await browser.close();

  if (overlappingPairs > 0) {
    console.error(`FAIL: ${overlappingPairs} overlapping node pairs`);
    process.exit(1);
  }
  if (inViewport < 40) {
    console.error(`FAIL: only ${inViewport} nodes visible in viewport (need >=40)`);
    process.exit(1);
  }
  console.log('PASS: zero overlap, >=40 nodes in viewport');
}

main().catch(e => { console.error(e); process.exit(1); });
