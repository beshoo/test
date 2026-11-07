/**
 * Decoding Web Worker: runs ZXing-WASM off the main thread so the camera
 * preview and UI stay smooth while frames are being decoded.
 *
 * Messages in:  { id, image: {data, width, height}, formats, strategy, offset, all }
 * Messages out: { id, results } | { id, error }
 */
import { prepareZXingModule, readBarcodes } from '../vendor/zxing-wasm/reader/index.js';
import { createDecoder } from './decode-core.js';

const wasmDir = new URL('../vendor/zxing-wasm/reader/', import.meta.url);

const ready = prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) => (path.endsWith('.wasm') ? new URL(path, wasmDir).href : prefix + path),
  },
  fireImmediately: true,
});

const decoder = createDecoder(readBarcodes);

self.onmessage = async ({ data: msg }) => {
  if (msg.type === 'ping') {
    try {
      await ready;
      self.postMessage({ id: msg.id, results: [] });
    } catch (err) {
      self.postMessage({ id: msg.id, error: String(err?.message || err) });
    }
    return;
  }
  try {
    await ready;
    const opts = { formats: msg.formats, strategy: msg.strategy, offset: msg.offset };
    const results = msg.all ? await decoder.decodeAll(msg.image, opts) : await decoder.decodeOnce(msg.image, opts);
    self.postMessage({ id: msg.id, results });
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err?.message || err) });
  }
};
