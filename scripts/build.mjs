import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'icons'), { recursive: true });

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

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBuffer.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), data.length + 8);
  return output;
}

function icon(size) {
  const pixels = Buffer.alloc(size * size * 4, 0);
  const center = (size - 1) / 2;
  const radius = size * 0.38;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      const thickness = Math.max(1, size * 0.1);
      const ring = distance <= radius && distance >= radius - thickness;
      const inside = distance < radius - thickness;
      let color = [0, 0, 0, 0];
      if (ring || inside) color = ring ? [91, 85, 231, 255] : [255, 255, 255, 255];
      if (inside && Math.abs(x - center) < Math.max(1, size * 0.07) && y >= center - radius * 0.55 && y <= center) {
        color = [91, 85, 231, 255];
      }
      if (inside && Math.abs(y - center) < Math.max(1, size * 0.07) && x >= center && x <= center + radius * 0.55) {
        color = [91, 85, 231, 255];
      }
      pixels.set(color, (y * size + x) * 4);
    }
  }
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    rows.push(Buffer.concat([Buffer.from([0]), pixels.subarray(y * size * 4, (y + 1) * size * 4)]));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(dist, 'icons', `icon${size}.png`), icon(size));
}
