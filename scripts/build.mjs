// Erzeugt ein Store-fähiges ZIP der Extension unter dist/ – ohne externe Abhängigkeiten.
// Aufruf: node scripts/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const INCLUDE = ['manifest.json', '_locales', 'background', 'content', 'icons', 'options', 'popup'];
const outDir = path.join(root, 'dist');
const outFile = path.join(outDir, `youtube-skipper-${manifest.version}.zip`);

function listFiles(rel) {
  const abs = path.join(root, rel);
  const st = fs.statSync(abs);
  if (st.isFile()) return [rel];
  return fs.readdirSync(abs).flatMap((n) => listFiles(path.join(rel, n)));
}

// ---- minimaler ZIP-Writer (Deflate) ----
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name.split(path.sep).join('/'), 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(time), u16(date),
      u32(crc), u32(comp.length), u32(data.length), u16(nameBuf.length), u16(0), nameBuf,
    ]);
    parts.push(local, comp);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(8), u16(time), u16(date),
      u32(crc), u32(comp.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ]));
    offset += local.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...parts, cd, end]);
}

const files = INCLUDE.flatMap(listFiles).sort();
const entries = files.map((rel) => ({ name: rel, data: fs.readFileSync(path.join(root, rel)) }));
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, buildZip(entries));
console.log(`${path.relative(root, outFile)}: ${files.length} Dateien, ${(fs.statSync(outFile).size / 1024).toFixed(1)} KB`);
