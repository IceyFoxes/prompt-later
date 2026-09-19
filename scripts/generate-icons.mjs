import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'assets/brand/Prompt_Later_Icon.svg');
const source = fs.readFileSync(sourcePath, 'utf8');
if (!/<svg\b/i.test(source)) throw new Error(`Icon source is not an SVG: ${sourcePath}`);
if (!/viewBox\s*=\s*["']0 0 1024 1024["']/.test(source)) {
  throw new Error(`Icon source must contain viewBox="0 0 1024 1024": ${sourcePath}`);
}
for (const color of ['#6957ED', '#FFFFFF']) {
  if (!source.includes(color)) throw new Error(`Icon source is missing required color ${color}: ${sourcePath}`);
}

const sizes = [16, 32, 48, 128];
let browser;
const contexts = [];
try {
  browser = await chromium.launch({ headless: true });
  for (const size of sizes) {
    const context = await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    contexts.push(context);
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><head><style>html,body{width:${size}px;height:${size}px;margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style></head><body>${source}</body></html>`);
    const output = path.join(root, 'assets/brand', `icon${size}.png`);
    await page.screenshot({ path: output, omitBackground: true });
    console.log(`Generated ${output} (${size}x${size})`);
  }
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
}
