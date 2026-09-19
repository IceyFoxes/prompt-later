import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'icons'), { recursive: true });
fs.cpSync(path.join(root, 'static/fonts'), path.join(dist, 'fonts'), { recursive: true });

for (const file of ['app.html', 'styles.css']) {
  fs.copyFileSync(path.join(root, 'static', file), path.join(dist, file));
}
fs.copyFileSync(path.join(root, 'manifest.json'), path.join(dist, 'manifest.json'));

await build({
  entryPoints: [path.join(root, 'src/background.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  outfile: path.join(dist, 'worker.js'),
  legalComments: 'eof',
});
await build({
  entryPoints: [path.join(root, 'src/app.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  outfile: path.join(dist, 'app.js'),
  legalComments: 'eof',
});
await build({
  entryPoints: [path.join(root, 'src/content.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  outfile: path.join(dist, 'content.js'),
  legalComments: 'eof',
});

for (const size of [16, 32, 48, 128]) {
  fs.copyFileSync(path.join(root, 'assets/brand', `icon${size}.png`), path.join(dist, 'icons', `icon${size}.png`));
}
