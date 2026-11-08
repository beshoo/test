// Score make-clips.py clips like live scanning: each frame is one box pass (same pass
// plan as scanner.js), both workers' readers, and the scanner's 1D vote rule.
//   node clip-bench.mjs <repoRoot> <clipsDir> [clipNameFilter]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [repo, dir, filter] = process.argv.slice(2);
const u = (p) => pathToFileURL(`${repo}/scanner/${p}`).href;
const zx = await import(u('vendor/zxing-wasm/reader/index.js'));
const core = await import(u('engine/decode-core.js'));
(await import(u('engine/ean-grey.js'))).warmUp();
await zx.prepareZXingModule({ overrides: { wasmBinary: readFileSync(`${repo}/scanner/vendor/zxing-wasm/reader/zxing_reader.wasm`) }, fireImmediately: true });
const dec = core.createDecoder(zx.readBarcodes);
const FORMATS = ['qr_code', 'data_matrix', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];
const RETAIL = new Set(['ean_13', 'ean_8', 'upc_a', 'upc_e']);
const MODEL_BASED = new Set(['greyscale-ean', 'deblur']);

// Box-pass options, as BarcodeScanner._plan() sets them.
const plan = (n) => ({ strategy: n % 5, tryRotate: n % 2 === 0, locate: true, fallback: n % 4 === 3, greyFallback: n % 8 === 7, deblur: true });

/** BarcodeScanner._accept(), without duplicate suppression: returns values confirmed by this frame. */
function voter() {
  const pending = new Map();
  return (results, now) => {
    for (const [v, p] of pending) if (now - p.t > 2000) pending.delete(v);
    const out = [];
    for (const r of results) {
      if (!core.LINEAR_FORMATS.has(r.format)) { out.push(r.rawValue); continue; }
      const p = pending.get(r.rawValue) ?? { count: 0, t: now, format: r.format };
      p.count += MODEL_BASED.has(r.strategy) && r.strong ? 2 : 1;
      p.t = now;
      pending.set(r.rawValue, p);
      let rival = 0;
      for (const [v, q] of pending) if (v !== r.rawValue && core.LINEAR_FORMATS.has(q.format)) rival = Math.max(rival, q.count);
      const strong = !MODEL_BASED.has(r.strategy) && RETAIL.has(r.format) && (r.lineCount || 0) >= 12;
      const base = MODEL_BASED.has(r.strategy) ? 3 : 2;
      if (p.count >= (rival ? Math.max(base, 2 * rival) : strong ? 1 : base)) out.push(r.rawValue);
    }
    return out;
  };
}

const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`)).filter((c) => !filter || c.clip.includes(filter));
console.log('clip'.padEnd(20), 'first seen', ' confirmed', ' frames read', ' wrong', ' ms/frame');
for (const c of manifest) {
  const buf = readFileSync(`${dir}/${c.clip}`);
  const n = c.w * c.h, accept = voter();
  let seen = null, confirmed = null, read = 0, shown = 0, wrong = 0, ms = 0;
  for (let i = 0; i < c.frames; i++) {
    const t = i / c.fps;
    const rgba = new Uint8ClampedArray(n * 4);
    for (let k = 0, o = i * n; k < n; k++) { const v = buf[o + k]; rgba[4 * k] = rgba[4 * k + 1] = rgba[4 * k + 2] = v; rgba[4 * k + 3] = 255; }
    const img = () => ({ data: new Uint8ClampedArray(rgba), width: c.w, height: c.h });
    const p = plan(i);
    const t0 = performance.now();
    const z = await dec.decodeOnce(img(), { formats: FORMATS, ...p, greyEan: false, deblur: false }); // deblur runs in the second worker
    const t1 = performance.now();
    const g = await dec.decodeOnce(img(), { formats: FORMATS, ...p, zxing: false, greyEan: true });
    ms += Math.max(t1 - t0, performance.now() - t1); // two workers in parallel
    // the scanner merges like ZXingWorkerEngine.decodeImage: greyscale only if ZXing found no retail code
    const all = z.some((r) => RETAIL.has(r.format)) ? z : [...z, ...g.filter((r) => !z.some((o) => o.rawValue === r.rawValue))];
    if (t >= c.appearsAt) shown++;
    if (all.some((r) => r.rawValue.includes(c.expected))) { read++; seen ??= t - c.appearsAt; }
    for (const v of accept(all, t * 1000)) {
      if (v.includes(c.expected)) confirmed ??= t - c.appearsAt;
      else wrong++;
    }
  }
  const s = (x) => (x === null ? 'never' : `${x.toFixed(2)} s`).padStart(10);
  console.log(c.clip.replace('.grey', '').padEnd(20), s(seen), s(confirmed), `${read}/${shown}`.padStart(12), String(wrong).padStart(6), (ms / c.frames).toFixed(0).padStart(9));
}
