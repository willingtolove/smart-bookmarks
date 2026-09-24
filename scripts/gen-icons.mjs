// 一次性生成 4 个尺寸的占位 PNG 图标（紫色圆角底 + 白色"🔖"风格的"SB"）
// 用纯 Node 写最小 PNG（无依赖）。颜色：#4F46E5，文字：白。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'public', 'icons');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function makePng(size) {
  // 像素缓冲：每像素 4 字节 (RGBA)，每行 1 个 filter byte
  const W = size, H = size;
  const rowSize = W * 4 + 1;
  const raw = Buffer.alloc(rowSize * H);

  const bg = [0x4f, 0x46, 0xe5, 0xff]; // accent
  const fg = [0xff, 0xff, 0xff, 0xff];

  for (let y = 0; y < H; y++) {
    const rowStart = y * rowSize;
    raw[rowStart] = 0; // filter type
    for (let x = 0; x < W; x++) {
      const i = rowStart + 1 + x * 4;
      // 圆角半径
      const r = Math.round(size * 0.18);
      const dx = Math.max(0, r - x, x - (W - 1 - r));
      const dy = Math.max(0, r - y, y - (H - 1 - r));
      const dist = Math.sqrt(dx * dx + dy * dy);
      const inRound = dist <= r;

      // 在中心画一个简化的"书签"形状（折角矩形）
      const cx = W / 2, cy = H / 2;
      const bkW = size * 0.5, bkH = size * 0.65;
      const lx = x - (cx - bkW / 2);
      const ly = y - (cy - bkH / 2);
      const inBody = lx >= 0 && lx <= bkW && ly >= 0 && ly <= bkH;
      // 底部 V 形缺口
      const notchHalf = bkW * 0.25;
      const t = ly / bkH; // 0..1
      const inNotch = t > 0.7 && Math.abs(lx - bkW / 2) < notchHalf * (1 - (t - 0.7) / 0.3);

      const isFg = inBody && !inNotch;
      const isBg = inRound;
      const c = isFg ? fg : isBg ? bg : [0, 0, 0, 0];
      raw[i] = c[0]; raw[i + 1] = c[1]; raw[i + 2] = c[2]; raw[i + 3] = c[3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;     // bit depth
  ihdr[9] = 6;     // color type RGBA
  ihdr[10] = 0;    // compression
  ihdr[11] = 0;    // filter
  ihdr[12] = 0;    // interlace

  const idat = deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

for (const s of [16, 32, 48, 128]) {
  const buf = makePng(s);
  const out = resolve(OUT, `icon-${s}.png`);
  writeFileSync(out, buf);
  console.log('wrote', out, buf.length, 'bytes');
}
