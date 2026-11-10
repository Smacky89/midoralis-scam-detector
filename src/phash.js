// Perceptual hashing (pHash, 64-bit, DCT-based, with auto-crop), plus the
// image prep for thumbnails and OCR. The hash output must never change:
// stored scam-hashes.json files depend on it (see test/phash.test.js).
import sharp from 'sharp';

// sharp keeps up to ~50 MB of decoded images cached by default; the bot
// never processes the same image twice, so that's wasted RAM.
sharp.cache(false);

const SIZE = 32;

// cos((π/N)(n+0.5)k) never changes, so compute the table once.
const COS = Array.from({ length: SIZE }, (_, k) => {
  const row = new Float64Array(SIZE);
  for (let n = 0; n < SIZE; n++) row[n] = Math.cos((Math.PI / SIZE) * (n + 0.5) * k);
  return row;
});

function dct1d(vector) {
  const out = new Float64Array(SIZE);
  for (let k = 0; k < SIZE; k++) {
    const c = COS[k];
    let sum = 0;
    for (let n = 0; n < SIZE; n++) sum += vector[n] * c[n];
    out[k] = sum;
  }
  return out;
}

async function autoCrop(buffer) {
  try {
    return await sharp(buffer).trim({ threshold: 10 }).toBuffer();
  } catch {
    return buffer;
  }
}

export async function perceptualHash(buffer) {
  const cropped = await autoCrop(buffer);

  const { data } = await sharp(cropped)
    .grayscale()
    .resize(SIZE, SIZE, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rowDct = [];
  for (let y = 0; y < SIZE; y++) {
    const row = new Float64Array(SIZE);
    for (let x = 0; x < SIZE; x++) row[x] = data[y * SIZE + x];
    rowDct.push(dct1d(row));
  }

  // Only the top-left 8x8 block of the 2-D DCT is needed.
  const vals = [];
  const colDcts = [];
  for (let x = 0; x < 8; x++) {
    const col = new Float64Array(SIZE);
    for (let y = 0; y < SIZE; y++) col[y] = rowDct[y][x];
    colDcts.push(dct1d(col));
  }
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) vals.push(colDcts[x][y]);

  const sorted = vals.slice(1).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    let nibble = 0;
    for (let j = 0; j < 4; j++) nibble = (nibble << 1) | (vals[i + j] > median ? 1 : 0);
    hex += nibble.toString(16);
  }
  return hex;
}

function popcount32(n) {
  n -= (n >>> 1) & 0x55555555;
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Hamming distance between two 16-char hex hashes.
export function hamming(hexA, hexB) {
  const a = hexA.padStart(16, '0');
  const b = hexB.padStart(16, '0');
  return (
    popcount32((parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0) +
    popcount32((parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16)) >>> 0)
  );
}

// Small compressed copy for storing alongside a hash/log entry, plenty to
// visually confirm what was caught, without needing the (long-gone) original.
export async function makeThumbnail(buffer) {
  try {
    return await sharp(buffer)
      .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
  } catch {
    return null;
  }
}

// Prepares an image for OCR: first frame only, grayscale, sensible size.
// Tesseract reads small screenshots much better when upscaled a bit and is
// needlessly slow on huge ones.
export async function prepareForOcr(buffer) {
  try {
    const img = sharp(buffer, { pages: 1 });
    const { width = 0 } = await img.metadata();
    let pipeline = img.grayscale().normalize();
    if (width && width < 700) pipeline = pipeline.resize({ width: width * 2 });
    else if (width > 2000) pipeline = pipeline.resize({ width: 2000 });
    return await pipeline.png().toBuffer();
  } catch {
    return buffer;
  }
}
