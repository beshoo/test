// Generate the clean test barcodes. Needs the full zxing-wasm build (reader + writer):
//   npm i zxing-wasm@3.1.3   (in this folder or any parent), then: node make-codes.mjs <outDir>
import { writeBarcode, prepareZXingModule } from 'zxing-wasm/full';
import { writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const wasm = createRequire(import.meta.url).resolve('zxing-wasm/full/zxing_full.wasm');
await prepareZXingModule({ overrides: { wasmBinary: readFileSync(wasm) }, fireImmediately: true });
const out = process.argv[2];
const items = [
  ['ean13', 'EAN13', '4006381333931', ''],
  ['code128', 'Code128', 'LOT-2027-AB12C-998877', ''],
  ['qr', 'QRCode', 'https://example.com/p/09506000134352?lot=AB12C', ''],
  ['gs1dm', 'DataMatrix', '(01)09506000134352(17)271231(10)AB12C(21)SN998877', 'gs1'],
];
for (const [name, format, text, opt] of items) {
  const r = await writeBarcode(text, { format, scale: 1, options: opt });
  if (r.error) { console.error(name, r.error); continue; }
  writeFileSync(out + '/' + name + '.png', Buffer.from(await r.image.arrayBuffer()));
  writeFileSync(out + '/' + name + '.txt', text);
}
console.log('ok');
