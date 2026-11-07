// Benchmark: first version (one ZXing call on the downscaled frame) vs the upgraded pipeline.
//   node bench.mjs <repoRoot> <framesDir>     (framesDir from make-frames.py)
import { readFileSync } from 'node:fs';
const [repo, frames] = process.argv.slice(2);
const zx = await import(`${repo}/scanner/vendor/zxing-wasm/reader/index.js`);
const { createDecoder, STRATEGIES } = await import(`${repo}/scanner/engine/decode-core.js`);
await zx.prepareZXingModule({ overrides: { wasmBinary: readFileSync(`${repo}/scanner/vendor/zxing-wasm/reader/zxing_reader.wasm`) }, fireImmediately: true });
const dec = createDecoder(zx.readBarcodes);
const KEY = { ean13: '4006381333931', code128: 'LOT-2027-AB12C-998877', qr: 'https://example.com/p/09506000134352?lot=AB12C', gs1dm: 'SN998877' };

function crop(img, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) out.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
  return { data: out, width: w, height: h };
}
function downscale(img, s) { // bilinear, like canvas drawImage
  const w = Math.round(img.width * s), h = Math.round(img.height * s), out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const fx = Math.min(img.width - 1.001, (x + 0.5) / s - 0.5), fy = Math.min(img.height - 1.001, (y + 0.5) / s - 0.5);
    const x0 = Math.max(0, Math.floor(fx)), y0 = Math.max(0, Math.floor(fy)), ax = fx - x0, ay = fy - y0;
    for (let c = 0; c < 4; c++) {
      const p = (yy, xx) => img.data[(yy * img.width + xx) * 4 + c];
      out[(y * w + x) * 4 + c] = (p(y0, x0) * (1 - ax) + p(y0, x0 + 1) * ax) * (1 - ay) + (p(y0 + 1, x0) * (1 - ax) + p(y0 + 1, x0 + 1) * ax) * ay;
    }
  }
  return { data: out, width: w, height: h };
}
const hit = (res, code) => res.some((r) => r.rawValue.includes(KEY[code]));
const wrong = (res, code) => res.some((r) => !r.rawValue.includes(KEY[code]));

const manifest = JSON.parse(readFileSync(`${frames}/manifest.json`));
const rows = {}; let times = { base: 0, n: 0 }; let misreadsV1 = 0, misreadsNew = 0;
for (const f of manifest) {
  const img = { data: new Uint8ClampedArray(readFileSync(`${frames}/${f.file}`).buffer), width: f.w, height: f.h };
  const full = downscale(img, 1280 / 1920);
  const roi = crop(img, Math.round(f.w * 0.12), Math.round(f.h * 0.18), Math.round(f.w * 0.76), Math.round(f.h * 0.64));
  const t0 = performance.now();
  // v1 = exactly what the first version did: one raw ZXing call (barcode-detector defaults) on the downscaled frame
  const base = (await zx.readBarcodes(full, { tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, textMode: 'Plain' }))
    .filter((r) => r.isValid).map((r) => ({ rawValue: r.text }));
  times.base += performance.now() - t0; times.n++;
  const r = { base: hit(base, f.code), roi0: false, ladderFull: false, pipeline: false }; if (wrong(base, f.code)) misreadsV1++;
  for (let s = 0; s < STRATEGIES.length; s++) {
    const a = await dec.decodeOnce(roi, { strategy: s });
    const b = await dec.decodeOnce(full, { strategy: s });
    if (wrong(a, f.code) || wrong(b, f.code)) misreadsNew++;
    if (s === 0 && hit(a, f.code)) r.roi0 = true;
    if (hit(b, f.code)) r.ladderFull = true;
    if (hit(a, f.code) || hit(b, f.code)) r.pipeline = true;
  }
  for (const k of [f.kind, `code:${f.code}`, 'ALL']) {
    rows[k] ??= { n: 0, base: 0, roi0: 0, ladderFull: 0, pipeline: 0 };
    rows[k].n++; for (const m of ['base', 'roi0', 'ladderFull', 'pipeline']) rows[k][m] += r[m] ? 1 : 0;
  }
}
const pct = (a, n) => `${Math.round((100 * a) / n)}%`.padStart(5);
console.log('condition'.padEnd(14), 'frames', ' v1 (1 try)', ' +ROI', ' +ladder', ' full pipeline');
for (const [k, v] of Object.entries(rows)) console.log(k.padEnd(14), String(v.n).padStart(6), pct(v.base, v.n).padStart(11), pct(v.roi0, v.n), pct(v.ladderFull, v.n).padStart(8), pct(v.pipeline, v.n).padStart(14));
console.log(`avg single attempt (1280px frame): ${(times.base / times.n).toFixed(1)} ms; wrong values: v1 ${misreadsV1} frames, new pipeline ${misreadsNew} attempts`);
