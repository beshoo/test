/**
 * Decode strategies on top of ZXing-C++ (zxing-wasm).
 *
 * Plain ZXing makes one attempt per image with one set of options. Commercial
 * engines get much of their extra robustness from trying harder and smarter on
 * each frame. Everything here is a published, generic technique (see
 * docs/scanner-research.md), not taken from any proprietary engine:
 *
 *   1. Strategy ladder: each attempt prepares/binarizes the image differently
 *      (sharpening, local-average vs. global-histogram thresholds, contrast
 *      stretching, denoising). A code that fails under one binarizer often reads under
 *      another (glare, low contrast, uneven light, noise). Live scanning tries
 *      one strategy per frame and rotates, so the cost per frame stays flat;
 *      still images try the whole ladder.
 *   2. Region of interest at full resolution: decoding a centre crop at native
 *      camera resolution instead of a downscaled whole frame keeps small codes
 *      (pen labels, far-away codes) above the minimum module size.
 *   3. Ghost-read arbitration + multi-frame confirmation for 1D codes, whose
 *      checksums are weak (see arbitrate() below).
 *
 * This module has no DOM dependencies, so it runs in a Web Worker and in Node.
 */

/** BarcodeDetector-style names (used in the public API) -> zxing-wasm names. */
export const FORMAT_TO_ZXING = {
  qr_code: 'QRCode',
  micro_qr_code: 'MicroQRCode',
  data_matrix: 'DataMatrix',
  aztec: 'Aztec',
  pdf417: 'PDF417',
  ean_13: 'EAN13',
  ean_8: 'EAN8',
  upc_a: 'UPCA',
  upc_e: 'UPCE',
  code_128: 'Code128',
  code_39: 'Code39',
  code_93: 'Code93',
  codabar: 'Codabar',
  itf: 'ITF',
  databar: 'DataBar',
  databar_expanded: 'DataBarExp',
  databar_limited: 'DataBarLtd',
};
const ZXING_TO_FORMAT = Object.fromEntries(Object.entries(FORMAT_TO_ZXING).map(([k, v]) => [v, k]));

import { decodeEanGrey } from './ean-grey.js?v=1ad4166-202611080027';

export const LINEAR_FORMATS = new Set([
  'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'codabar', 'itf',
  'databar', 'databar_expanded', 'databar_limited',
]);

const BASE = {
  tryHarder: true,
  tryRotate: true,
  tryInvert: false, // white-on-black codes are rare: only the contrast-stretch step looks for them
  tryDownscale: true,
  textMode: 'Plain', // keep GS1 FNC1 separators as \x1d
  maxNumberOfSymbols: 8,
};

/**
 * The ladder. Order matters: cheapest / most often successful first.
 * `prep` is an optional pixel transform applied before decoding.
 */
export const STRATEGIES = [
  { name: 'local-average', options: { binarizer: 'LocalAverage' } },
  { name: 'sharpen', options: { binarizer: 'LocalAverage' }, prep: 'sharpen' },
  { name: 'global-histogram', options: { binarizer: 'GlobalHistogram' } },
  { name: 'contrast-stretch', options: { binarizer: 'LocalAverage', tryInvert: true }, prep: 'stretch' },
  { name: 'denoise', options: { binarizer: 'LocalAverage', tryDenoise: true } },
];

/**
 * Percentile contrast stretch on luminance, in place on an RGBA buffer.
 * Clips the darkest/brightest 1% so a single glare spot doesn't flatten the range.
 */
export function contrastStretch(img) {
  const { data } = img;
  const n = data.length / 4;
  const hist = new Uint32Array(256);
  const luma = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i += 1, p += 4) {
    const y = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    luma[i] = y;
    hist[y] += 1;
  }
  const clip = Math.max(1, Math.floor(n * 0.01));
  let lo = 0, hi = 255, acc = 0;
  while (lo < 255 && (acc += hist[lo]) < clip) lo += 1;
  acc = 0;
  while (hi > 0 && (acc += hist[hi]) < clip) hi -= 1;
  if (hi - lo < 8) return img; // nothing to stretch
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v += 1) lut[v] = Math.max(0, Math.min(255, Math.round(((v - lo) * 255) / (hi - lo))));
  for (let i = 0, p = 0; i < n; i += 1, p += 4) {
    const y = lut[luma[i]];
    data[p] = y; data[p + 1] = y; data[p + 2] = y;
  }
  return img;
}

function gaussKernel(sigma) {
  const r = Math.ceil(3 * sigma), k = new Float32Array(2 * r + 1);
  let t = 0;
  for (let i = -r; i <= r; i += 1) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); t += k[i + r]; }
  for (let i = 0; i < k.length; i += 1) k[i] /= t;
  return k;
}

/**
 * Unsharp mask on luminance, in place on an RGBA buffer:
 *   out = L + amount * (L - gaussian(L, sigma))
 * Restores edge contrast lost to mild defocus. In the benchmark it lifted
 * mildly blurred (sigma 1.5) codes from 3/8 to 7/8 reads; proper deconvolution
 * (Richardson-Lucy) cost 10-20x more for no extra reads.
 */
export function sharpen(img, sigma = 1.5, amount = 2) {
  const { data, width: w, height: h } = img;
  const n = w * h;
  const L = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i += 1, p += 4) L[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) / 256;
  const k = gaussKernel(sigma), r = (k.length - 1) / 2;
  const tmp = new Float32Array(n), blur = new Float32Array(n);
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      let s = 0;
      for (let j = -r; j <= r; j += 1) s += L[row + Math.min(w - 1, Math.max(0, x + j))] * k[j + r];
      tmp[row + x] = s;
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let s = 0;
      for (let j = -r; j <= r; j += 1) s += tmp[Math.min(h - 1, Math.max(0, y + j)) * w + x] * k[j + r];
      blur[y * w + x] = s;
    }
  }
  for (let i = 0, p = 0; i < n; i += 1, p += 4) {
    const v = L[i] + amount * (L[i] - blur[i]);
    data[p] = v; data[p + 1] = v; data[p + 2] = v; // Uint8ClampedArray clamps
  }
  return img;
}

function copyImage(img) {
  return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
}

function normalize(r, offset) {
  const p = r.position;
  const pts = [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft].map((q) => ({ x: q.x + offset.x, y: q.y + offset.y }));
  const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return {
    rawValue: r.text,
    format: ZXING_TO_FORMAT[r.format] ?? String(r.format).toLowerCase(),
    symbologyIdentifier: r.symbologyIdentifier,
    isGS1: /^\](d2|C1|Q3|e0|J1)/.test(r.symbologyIdentifier || ''),
    lineCount: r.lineCount,
    cornerPoints: pts,
    boundingBox: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y },
  };
}

const RETAIL = new Set(['ean_13', 'ean_8', 'upc_a', 'upc_e']);
const formatsAllowRetail = (formats) => !formats.length || formats.some((f) => f === 'ean_13' || f === 'ean_8' || f === 'upc_a');

function overlaps(a, b) {
  const ax2 = a.x + a.width, ay2 = a.y + a.height, bx2 = b.x + b.width, by2 = b.y + b.height;
  const iw = Math.min(ax2, bx2) - Math.max(a.x, b.x), ih = Math.min(ay2, by2) - Math.max(a.y, b.y);
  if (iw <= 0 || ih <= 0) return false;
  return iw * ih >= 0.3 * Math.min(a.width * a.height || 1, b.width * b.height || 1);
}

/**
 * ZXing can return two different values for the SAME 1D barcode in one pass
 * (different scan lines, each with a valid checksum). The benchmark caught
 * EAN-13 4006381333931 also being reported as 4006721333911. The ghost is
 * supported by far fewer scan lines (5 vs 49), so for overlapping 1D results
 * keep only the one with the most agreeing lines.
 */
export function arbitrate(results) {
  const kept = [];
  const sorted = [...results].sort((a, b) => (b.lineCount || 0) - (a.lineCount || 0));
  for (const r of sorted) {
    const linear = LINEAR_FORMATS.has(r.format);
    const clash = kept.some((k) => linear && LINEAR_FORMATS.has(k.format) && overlaps(k.boundingBox, r.boundingBox));
    const dup = kept.some((k) => k.rawValue === r.rawValue && k.format === r.format && overlaps(k.boundingBox, r.boundingBox));
    if (!clash && !dup) kept.push(r);
  }
  return kept;
}

/**
 * @param {(img: {data,width,height}, opts: object) => Promise<any[]>} readBarcodes zxing-wasm reader
 */
export function createDecoder(readBarcodes) {
  /**
   * Decode one image with one strategy.
   * @param {{data: Uint8ClampedArray, width: number, height: number}} img RGBA pixels
   * @param {{formats?: string[], strategy?: number, offset?: {x:number,y:number}}} [opts]
   */
  async function decodeOnce(img, { formats = [], strategy = 0, offset = { x: 0, y: 0 }, greyEan = true, zxing = true } = {}) {
    const s = STRATEGIES[strategy % STRATEGIES.length];
    const zxFormats = formats.map((f) => FORMAT_TO_ZXING[f]).filter(Boolean);
    let input = img;
    if (s.prep === 'stretch') input = contrastStretch(copyImage(img));
    else if (s.prep === 'sharpen') input = sharpen(copyImage(img));
    const results = zxing ? await readBarcodes(input, { ...BASE, ...s.options, formats: zxFormats }) : [];
    const found = arbitrate(results.filter((r) => r.isValid).map((r) => ({ ...normalize(r, offset), strategy: s.name })));
    // ZXing binarizes first, which loses thin bars on soft images. If it found no
    // retail code, try the greyscale EAN/UPC reader (edge + blur-model decoding).
    if (greyEan && !found.some((r) => RETAIL.has(r.format)) && formatsAllowRetail(formats)) {
      for (const g of decodeEanGrey(img, formats)) {
        const pts = g.cornerPoints.map((q) => ({ x: q.x + offset.x, y: q.y + offset.y }));
        const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
        found.push({
          rawValue: g.rawValue,
          format: g.format,
          symbologyIdentifier: g.format === 'ean_8' ? ']E4' : ']E0',
          isGS1: false,
          lineCount: g.lines,
          cornerPoints: pts,
          boundingBox: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
          strategy: 'greyscale-ean',
        });
      }
    }
    return found;
  }

  /** Try every strategy until one finds something (for still images). */
  async function decodeAll(img, opts = {}) {
    for (let i = 0; i < STRATEGIES.length; i += 1) {
      const found = await decodeOnce(img, { ...opts, strategy: i, greyEan: false });
      if (found.length) return found;
    }
    // the greyscale reader does not depend on the ZXing strategy: run it once
    return opts.greyEan === false ? [] : decodeOnce(img, { ...opts, strategy: 0, greyEan: true, zxing: false });
  }

  return { decodeOnce, decodeAll };
}
