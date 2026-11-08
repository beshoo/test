# JavaScript barcode scanner (no license key)

A browser camera scanner for QR, GS1 Data Matrix, EAN/UPC, Code 128 and more. Everything is self-hosted: no CDN, no license key, and no images leave the device.

- **Engine:** ZXing-C++ compiled to WebAssembly ([zxing-wasm](https://github.com/Sec-ant/zxing-wasm) 3.1.3, MIT; vendored in `vendor/zxing-wasm/`), running in a Web Worker. Where the browser has a built-in `BarcodeDetector` (Chrome on Android: Google ML Kit), both engines run on every frame and the first read wins, so a device whose built-in detector returns nothing still scans.
- **On top of ZXing:** full-resolution decoding of the target box, a preprocessing/binarizer ladder including sharpening, ghost-read arbitration and two-frame confirmation for 1D codes. On the benchmark this raises read rate from 54% to 64%, with 0 wrong values. Details and sources: [`../docs/scanner-research.md`](../docs/scanner-research.md).
- **Greyscale EAN/UPC reader** (`engine/ean-grey.js`), our own decoder for retail barcodes, used whenever ZXing finds none. ZXing converts each scan line to pure black and white first, so on a soft image the thin white gaps between thick bars disappear. This reader never thresholds:
  1. *Edge reader:* bar edges are taken from the brightness gradient at sub-pixel precision, so a blurred gap still shows up as a dip.
  2. *Blur-model reader:* when edges merge, it locates only the barcode's two outer ends, maps the 95 modules across them (with perspective), estimates blur and bar thinning from the guard patterns, and decodes the digits by beam search. Each candidate digit is simulated next to its already-decoded neighbour, blurred, and compared with the brightness profile.

  Acceptance requires a valid check digit and two agreeing scan lines, plus quality limits set from measurements (see the research doc). It reads a real phone frame of an EAN-13 that both ZXing and Android's ML Kit failed on.
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
| `engine/ean-grey.js` | Greyscale EAN-13 / UPC-A / EAN-8 reader: edge reader + blur-model beam-search reader |
| `engine/worker.js` | Web Worker: ZXing (and the greyscale reader when there is no second worker) |
| `engine/grey-worker.js` | Second Web Worker: greyscale EAN/UPC reader only, runs in parallel |
| `gs1.js` | GS1 element-string parser |
| `index.html` | Demo UI |
| `vendor/zxing-wasm/` | Vendored zxing-wasm 3.1.3 reader (+ `.wasm`, SHA-256 `2ebda08a…c6d1ba`), MIT |
| `bench/` | Benchmark: `make-codes.mjs` → `make-frames.py` → `bench.mjs` |
| `stamp-version.sh` | Adds `?v=` cache-busting versions to the module URLs. Run it after every change |

## Speed

- **Two workers in parallel** on multi-core devices: ZXing in `engine/worker.js`, the greyscale EAN/UPC reader in `engine/grey-worker.js`. A full-resolution frame costs the slower of the two, not their sum.
- **1D codes are voted across frames.** EAN check digits pass for 1 wrong code in 10, so every 1D read is a vote kept for 2 s. A value needs 2 votes (3 if only the greyscale reader sees it). If a different 1D value was also seen, it needs at least twice the votes of every rival. Only a ZXing read backed by ≥ 12 scan lines, with no rival, is reported at once. (Added after a phone reported `9277146613147` for `6211136613147`, which had briefly been allowed through on a single frame.)
- **A built-in detector that never reads is retired.** If `BarcodeDetector` has found nothing after 30 frames while ZXing has read at least 3, it is no longer called.
- **The box gets priority.** While codes keep turning up in the target box, it is decoded 3 frames out of 4 at full resolution.
- **The greyscale reader remembers the barcode's angle.** It starts scanning at the angle that worked last time, tries the blur model on those lines first, and stops once 4 lines agree with no rival. Consecutive frames: about 20 ms for sharp codes and 40–60 ms for blurred ones (desktop), down from 70–90 ms.
- **Templates are built at start-up** (`warmUp()`, in the worker), not on the first frames.
- `diagnostics()` reports `firstReadMs`, `parallelWorkers`, `nativeRetired`, and `cameras` (each back camera checked, with or without autofocus).

## Camera choice

On multi-camera phones, `facingMode: "environment"` often opens an ultra-wide or secondary lens that can't focus up close. After permission is granted, `start()` switches to the main back camera (`chooseBackCamera()`: lowest-numbered `camera2 N, facing back` on Android; Triple, then Dual Wide, then Back Camera on iOS). The demo remembers a camera picked by hand. If the camera it opens, remembered or not, has no autofocus, `start()` checks the other back cameras and switches to one that has it (`autoSwitched`). A camera picked from the list during the session is kept as chosen.

## Known limits

Heavy defocus and motion blur are not readable (0% in the benchmark). ZXing converts to black-and-white before decoding, which destroys that information. See §3 of the research doc for the options.
