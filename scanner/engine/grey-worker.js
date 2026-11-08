/**
 * Second decoding worker, in parallel with ZXing in worker.js, so a full-resolution
 * frame costs max(ZXing, this) instead of their sum. It runs the readers for soft
 * frames: the greyscale EAN/UPC reader, and deblurring of located 1D codes (which
 * decodes the restored profiles with its own ZXing instance).
 *
 * Messages in:  { id, type: 'ping' } | { id, image, formats, offset, strategy, locate, greyFallback, deblur }
 * Messages out: { id, results } | { id, error }
 */
import { prepareZXingModule, readBarcodes } from '../vendor/zxing-wasm/reader/index.js';
import { createDecoder } from './decode-core.js?v=c2abae2-202611081631';
import { warmUp } from './ean-grey.js?v=c2abae2-202611081631';

const wasmDir = new URL('../vendor/zxing-wasm/reader/', import.meta.url);
const ready = prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) => (path.endsWith('.wasm') ? new URL(path, wasmDir).href : prefix + path),
  },
  fireImmediately: true,
});

const decoder = createDecoder(readBarcodes); // ZXing here only decodes deblurred profiles (zxing: false)

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === 'ping') {
      warmUp(); // build the blur-model templates now, not on the first real frame
      await ready;
      self.postMessage({ id: msg.id, results: [] });
      return;
    }
    await ready;
    const results = await decoder.decodeOnce(msg.image, {
      formats: msg.formats, offset: msg.offset, strategy: msg.strategy, zxing: false, greyEan: true,
      locate: msg.locate, greyFallback: msg.greyFallback !== false, deblur: msg.deblur,
    });
    self.postMessage({ id: msg.id, results });
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err?.message || err) });
  }
};
