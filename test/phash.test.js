// Tests for image hashing: stable output and matching of re-encoded copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { perceptualHash, hamming } from '../src/phash.js';

// A plain, slow reference implementation. The fast one in src/phash.js must
// give exactly the same hashes, so existing scam-hashes.json files keep working.
function dct1d(vector) {
  const N = vector.length;
  const out = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    for (let n = 0; n < N; n++) sum += vector[n] * Math.cos((Math.PI / N) * (n + 0.5) * k);
    out[k] = sum;
  }
  return out;
}
async function referenceHash(buffer) {
  const SIZE = 32;
  let cropped;
  try { cropped = await sharp(buffer).trim({ threshold: 10 }).toBuffer(); } catch { cropped = buffer; }
  const { data } = await sharp(cropped).grayscale().resize(SIZE, SIZE, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const matrix = [];
  for (let y = 0; y < SIZE; y++) {
    const row = new Float64Array(SIZE);
    for (let x = 0; x < SIZE; x++) row[x] = data[y * SIZE + x];
    matrix.push(row);
  }
  const rowDct = matrix.map(dct1d);
  const dct = Array.from({ length: SIZE }, () => new Float64Array(SIZE));
  for (let x = 0; x < SIZE; x++) {
    const col = new Float64Array(SIZE);
    for (let y = 0; y < SIZE; y++) col[y] = rowDct[y][x];
    const colDct = dct1d(col);
    for (let y = 0; y < SIZE; y++) dct[y][x] = colDct[y];
  }
  const vals = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) vals.push(dct[y][x]);
  const sorted = vals.slice(1).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let bits = '';
  for (let i = 0; i < 64; i++) bits += vals[i] > median ? '1' : '0';
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}
function referenceHamming(a, b) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let c = 0;
  while (x > 0n) { c += Number(x & 1n); x >>= 1n; }
  return c;
}

async function randomImage(seed, w = 200, h = 150) {
  const px = Buffer.alloc(w * h * 3);
  let s = seed;
  for (let i = 0; i < px.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; px[i] = (s >> 16) & 0xff; }
  // blur so there is low-frequency structure like a real picture
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).blur(8).png().toBuffer();
}

test('hash output identical to the reference implementation', async () => {
  for (let seed = 1; seed <= 8; seed++) {
    const img = await randomImage(seed);
    assert.equal(await perceptualHash(img), await referenceHash(img));
  }
});

test('hamming matches the reference BigInt version', () => {
  const hashes = ['0000000000000000', 'ffffffffffffffff', '0123456789abcdef', 'fedcba9876543210', '8000000000000001'];
  for (const a of hashes) for (const b of hashes) assert.equal(hamming(a, b), referenceHamming(a, b));
});

test('re-encoded / resized copies stay within the match threshold', async () => {
  const img = await randomImage(42, 400, 300);
  const jpeg = await sharp(img).resize(300, 225).jpeg({ quality: 40 }).toBuffer();
  const padded = await sharp(img).extend({ top: 30, bottom: 30, left: 30, right: 30, background: '#ffffff' }).png().toBuffer();
  const h = await perceptualHash(img);
  assert.ok(hamming(h, await perceptualHash(jpeg)) <= 10);
  assert.ok(hamming(h, await perceptualHash(padded)) <= 10);
  const other = await perceptualHash(await randomImage(7, 400, 300));
  assert.ok(hamming(h, other) > 10);
});
