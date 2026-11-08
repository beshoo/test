# JavaScript barcode scanner (no license key)

A browser camera scanner for QR, GS1 Data Matrix, EAN/UPC, Code 128 and more. Everything is self-hosted: no CDN, no license key, and no images leave the device.

- **Engine:** ZXing-C++ compiled to WebAssembly ([zxing-wasm](https://github.com/Sec-ant/zxing-wasm) 3.1.3, MIT; vendored in `vendor/zxing-wasm/`), running in a Web Worker. Where the browser has a built-in `BarcodeDetector` (Chrome on Android: Google ML Kit), both engines run on every frame and the first read wins, so a device whose built-in detector returns nothing still scans.
- **On top of ZXing:** full-resolution decoding of the target box, a preprocessing/binarizer ladder including sharpening, ghost-read arbitration and two-frame confirmation for 1D codes. On the benchmark this raises read rate from 54% to 64%, with 0 wrong values. Details and sources: [`../docs/scanner-research.md`](../docs/scanner-research.md).
- **GS1 parsing** (`gs1.js`): GTIN with check-digit validation, expiry/production dates, batch/lot, serial, NHRN, measures.

## Run the demo

Camera access needs HTTPS or `localhost`:

```bash
cd scanner
python3 -m http.server 8080
# open http://localhost:8080/
```

On a phone, serve the folder over HTTPS (any static host, or a tunnel to your machine).

## Use it in your page

```html
<video id="v" playsinline muted></video>
<script type="module">
  import { BarcodeScanner, scanImage } from './scanner/scanner.js';
  import { parseGS1 } from './scanner/gs1.js';

  const scanner = new BarcodeScanner(document.getElementById('v'), {
    formats: ['data_matrix', 'qr_code', 'ean_13', 'code_128'], // [] = all
    onDetect(codes) {
      for (const c of codes) {
        console.log(c.format, c.rawValue, c.isGS1 ? parseGS1(c.rawValue) : '');
      }
    },
  });
  await scanner.start();

  // still image (File/Blob/<img>/canvas): tries every strategy
  // const codes = await scanImage(file, { formats: ['data_matrix'] });
</script>
```

Options: `engine` (`'auto'` = hybrid where available | `'zxing'` | `'native'`), `continuous`, `deviceId`, `getRegion()` (target box in video pixels), `confirmLinear` (default 2), `maxDecodeSize` (default 1280), `duplicateTimeoutMs`.
Methods: `diagnostics()`, `start()`, `stop()`, `switchCamera(id)`, `setFormats(f)`, `setTorch(on)`, `setZoom(v)`, `focusAt(x, y)`, `BarcodeScanner.listCameras()`.

Each result has `{ rawValue, format, isGS1, symbologyIdentifier, cornerPoints, boundingBox, strategy }`. GS1 values keep the FNC1 separator as `\x1d`.

## Files

| Path | What |
|---|---|
| `scanner.js` | Camera, frame loop, engine selection, confirmation, camera controls |
| `engine/decode-core.js` | Strategy ladder, sharpening, contrast stretch, ghost arbitration (no DOM; also runs in Node) |
| `engine/worker.js` | Web Worker wrapper around the decoder |
| `gs1.js` | GS1 element-string parser |
| `index.html` | Demo UI |
| `vendor/zxing-wasm/` | Vendored zxing-wasm 3.1.3 reader (+ `.wasm`, SHA-256 `2ebda08a…c6d1ba`), MIT |
| `bench/` | Benchmark: `make-codes.mjs` → `make-frames.py` → `bench.mjs` |

## Camera choice

On multi-camera phones, `facingMode: "environment"` often opens an ultra-wide or secondary lens that can't focus up close. After permission is granted, `start()` switches to the main back camera (`chooseBackCamera()`: lowest-numbered `camera2 N, facing back` on Android; Triple, then Dual Wide, then Back Camera on iOS). The demo remembers a camera picked by hand.

## Known limits

Heavy defocus and motion blur are not readable (0% in the benchmark). ZXing converts to black-and-white before decoding, which destroys that information. See §3 of the research doc for the options.
