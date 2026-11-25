/**
 * Build the JARVIS browser extension: node browser-extension/build.mjs  (npm run build:browser-extension)
 * Emits browser-extension/dist/chromium and browser-extension/dist/firefox from the single src/ tree.
 * No bundler and no dependencies: files are copied, a target manifest is written and icons are drawn.
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { buildManifest, TARGETS } from './manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** Original ASAA/JARVIS mark: navy rounded square with a teal ring and core. */
export function iconPng(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const dx = x - c, dy = y - c, d = Math.hypot(dx, dy) / (size / 2);
      const corner = Math.max(Math.abs(dx), Math.abs(dy)) / (size / 2);
      let px = [0, 0, 0, 0];
      if (corner <= 1 && !(Math.abs(dx) > size * 0.36 && Math.abs(dy) > size * 0.36 && Math.hypot(Math.abs(dx) - size * 0.36, Math.abs(dy) - size * 0.36) > size * 0.14)) px = [14, 22, 32, 255];
      if (d > 0.52 && d < 0.74) px = [60, 198, 192, 255];
      else if (d < 0.2) px = [230, 237, 243, 255];
      raw.set(px, y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function build(outRoot = join(here, 'dist')) {
  rmSync(outRoot, { recursive: true, force: true });
  for (const target of TARGETS) {
    const out = join(outRoot, target);
    mkdirSync(out, { recursive: true });
    cpSync(join(here, 'src'), out, { recursive: true });
    mkdirSync(join(out, 'icons'), { recursive: true });
    for (const size of [16, 32, 48, 128]) writeFileSync(join(out, 'icons', `icon-${size}.png`), iconPng(size));
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(buildManifest(target), null, 2) + '\n');
  }
  return outRoot;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = build();
  console.log(`Built JARVIS browser extension: ${join(out, 'chromium')} and ${join(out, 'firefox')}`);
}
