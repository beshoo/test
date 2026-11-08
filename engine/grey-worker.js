/**
 * Second decoding worker: runs only the greyscale EAN/UPC reader, in parallel
 * with ZXing in worker.js, so a full-resolution frame costs max(ZXing, greyscale)
 * instead of their sum. Loads no WebAssembly.
 *
 * Messages in:  { id, type: 'ping' } | { id, image, formats, offset, locate, greyFallback }
 * Messages out: { id, results } | { id, error }
 */
import { createDecoder } from './decode-core.js?v=f73d8bf-202611081555';
import { warmUp } from './ean-grey.js?v=f73d8bf-202611081555';

const decoder = createDecoder(async () => []); // ZXing is never called here (zxing: false)

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === 'ping') {
      warmUp(); // build the blur-model templates now, not on the first real frame
      self.postMessage({ id: msg.id, results: [] });
      return;
    }
    const results = await decoder.decodeOnce(msg.image, {
      formats: msg.formats, offset: msg.offset, zxing: false, greyEan: true, locate: msg.locate, greyFallback: msg.greyFallback !== false,
    });
    self.postMessage({ id: msg.id, results });
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err?.message || err) });
  }
};
