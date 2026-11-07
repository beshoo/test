# Why commercial scanners (Scandit) beat ZXing — and what we can borrow

**Date:** 2026-11-07
**Scope:** Learn, from public sources only, what makes Scandit's barcode engine stronger than open-source ZXing, and add the techniques we legitimately can to our own key-free scanner (`scanner/`).

**Method / ground rules.** Scandit's Web SDK (`@scandit/web-datacapture-barcode` 8.7.0) is proprietary ("Copyright © 2026 Scandit AG. All Rights Reserved"; use governed by Scandit's Terms). Its decoder ships only as compiled WebAssembly (`scandit-datacapture-sdk-barcode*.wasm`, ~8.5 MB each, 4 builds: plain / SIMD / pthreads / SIMD+pthreads). The ~430 JavaScript files in the package are the wrapper (camera, overlay, settings API) and contain no decoding logic. We did **not** decompile or analyse the binary. Everything below comes from patents, Scandit's public documentation, and academic papers.

Note: scandit.com and the patent sites were blocked by this environment's network policy, so the findings come from search-engine summaries of those pages. Patent numbers and their Scandit assignment are as reported in those summaries. Verify against the USPTO record before relying on them legally.

---

## 1. What Scandit does differently (public sources)

| # | Technique | Evidence | Can we copy it? |
|---|---|---|---|
| 1 | **Decoding blurry codes from the greyscale signal**, without first converting to black-and-white | Scandit lists "blurry barcode decoding" in its patent portfolio (50+ patents, 20+ countries). Related published methods: decoding that bypasses binarization to use greyscale information (US9098764B2); restoring blurred barcodes by choosing a blur model (OTF/PSF) and deconvolving (US8867857B2, US8750637B2 "Barcode processing"); simulating the blurred barcode and choosing the digits whose simulation best fits (Rocholl et al., ICPR 2010); blur-robust decoding (Gallo & Manduchi, UCSC). Scandit grew out of ETH Zurich research; an ETH thesis deck (Sörös, 2016) demonstrates live smartphone deblurring. | **Partly.** ZXing always binarizes first, which is why heavy blur reads 0% in our benchmark. A real fix means writing a new greyscale 1D decoder (a research project). Cheap pre-sharpening helps with *mild* blur (done, §2). |
| 2 | **Machine-learning code localization**: finding small, angled or partly hidden codes anywhere in the frame | Scandit markets "AI-powered" scanning, and its docs describe "pattern reconstruction" for damaged codes. Open research shows the approach: YOLO-Barcode (Ershova et al., *Computer Optics* 48(4), 2024: real-time on mobile, F1 98.6% on ZVZ-real), Hansen et al. 2017 (YOLO, 0.991 detection rate on Muenster BarcodeDB), YOLOv8 at ~5 ms per frame on Android (NCU thesis, 2025). | **Yes, with work.** A small detector model (ONNX/TF.js) could feed crops to ZXing. Not done yet: it needs a trained model and adds ~5–10 MB. |
| 3 | **Correcting perspective on angled codes**: estimate the code's corners, compute a homography and rectify the scan line | US 11,893,764 / US 11,562,551, "Image analysis for decoding angled optical patterns" (Scandit AG). A depth-sensor (LiDAR) variant is US 11,810,304. | **Partly.** ZXing's `tryRotate`/`tryHarder` already handle moderate angles. Full homography rectification would build on #2. |
| 4 | **Camera control for speed**: wide-angle lens, high frame rate, very short exposure (1/500 s or shorter) against motion blur, torch | US 11,216,628 "High-speed scanning of optical patterns using a digital camera"; US 11,803,718 (torch as aimer; fixed focus avoids autofocus delay). Camera start-up optimization: US 12,175,327. | **Partly.** The browser exposes zoom, torch and focus on many Android devices (done). Manual exposure exists on few devices and risks dark frames, so it is left out. |
| 5 | **Selection area / region of interest**: decode only where the user is aiming | US 12,307,737 "Adaptive selection area for image-based decoding of optical patterns" (Scandit AG). | **Yes, done**: full-resolution decoding of the on-screen target box (§2). |
| 6 | **Tracking several codes across frames** (MatrixScan) | US 10,963,658 "Image analysis for tracking, decoding, and positioning multiple optical patterns" (Scandit AG). It also notes motion blur from fast phone movement. | **Partly.** We confirm 1D reads across frames (done). Full tracking would come after #2. |
| 7 | **Performance engineering**: WebAssembly with SIMD and multithreading, configurable HD / Full HD / 4K | Scandit's Web SDK docs: multithreading needs a cross-origin-isolated page; SIMD is optional; higher resolution improves range and small codes but lowers frame rate. | **Yes, done**: decoding in a Web Worker, with full resolution only inside the region of interest. |
| 8 | **OCR fallback** when a code is too damaged to decode | Scandit docs/product pages: falls back to reading the printed digits. | **Possible later** (e.g. Tesseract.js on the digits under an EAN). Not done. |

## 2. What we built (`scanner/engine/decode-core.js`) and measured

Benchmark: 216 synthetic 1920×1080 camera frames. Four codes (EAN-13, Code 128, QR, GS1 Data Matrix) at small module sizes (2–4 px), randomly placed near the centre and rotated ±12°, under 9 conditions × 3 random seeds. "v1" is exactly what the first version did: one ZXing call on the frame downscaled to 1280 px. Reproduce with `scanner/bench/`.

| Condition | v1 (one try) | + ROI only | + strategy ladder only | **Full pipeline** |
|---|---|---|---|---|
| **All frames** | **54%** | 60% | 56% | **64%** |
| Clean (small codes) | 83% | 96% | 88% | 96% |
| Low contrast | 88% | 100% | 88% | 100% |
| Sensor noise | 88% | 96% | 88% | 100% |
| Uneven lighting | 88% | 100% | 88% | 100% |
| Glare spot | 83% | 92% | 83% | 92% |
| Mild blur (σ 1.5) | 50% | 50% | 54% | **75%** |
| Blur + low contrast + noise | 4% | 4% | 13% | 17% |
| Heavy blur (σ 2.5) | 0% | 0% | 0% | **0%** |
| Motion blur (9 px) | 0% | 0% | 0% | **0%** |
| Wrong values reported | 0 | | | 0 |

In the browser (headless Chromium, fake 1080p camera), the worker takes ~35 ms per decode attempt. A small Code 128 that v1 could not read was read and confirmed in 0.9 s.

What each piece contributes:

1. **Full-resolution region of interest** (Scandit idea #5). On alternate frames we decode the target box at native camera resolution instead of the whole frame shrunk to 1280 px. This was the biggest single win, for small codes (Code 128 33% → 57%).
2. **Strategy ladder.** Each frame tries the next preprocessing/binarizer: local-average → **unsharp-mask sharpening** → global-histogram → contrast stretch → denoise. Live scanning rotates one strategy per frame, so cost per frame stays flat. Still images try all of them. Sharpening is what lifted mild blur from 50% to 75%. Richardson–Lucy deconvolution was also tested: 10–20× slower (≈440–720 ms per 900×500 crop in JS) and no better, so it was left out.
3. **Ghost-read arbitration** (a bug the benchmark found). On one *clean* frame ZXing returned EAN-13 `4006381333931` **and** a second, checksum-valid but wrong `4006721333911` for the same barcode. The real read was backed by 49 scan lines, the ghost by 5. For overlapping 1D results we now keep only the one with the most agreeing scan lines. A related ghost (`4008381331931`) also disappeared.
4. **Two-frame confirmation for 1D codes**, whose checksums are weak. 2D codes have strong error correction and report immediately.
5. **Camera**: continuous autofocus, tap-to-focus, zoom slider and torch where the device supports them, and 1080p capture.
6. **Web Worker decoding**, so the preview and UI never stall.

## 3. The honest gap

Heavy defocus and motion blur stay at **0%**. That is the core of Scandit's advantage (#1) and can't be fixed by preprocessing before ZXing, because ZXing's first step (black-and-white conversion) destroys the information. Options, in order of value:

1. **Native engine where available.** On Chrome for Android, `BarcodeDetector` is backed by Google ML Kit, which is much stronger than ZXing on blur. The scanner already uses it automatically in `engine: 'auto'` mode. Only iOS Safari, Firefox and desktop Chrome on Windows/Linux fall back to ZXing.
2. **ML localization (#2)** plus rectified crops into ZXing, for small, far and angled codes.
3. **A greyscale 1D decoder** in the style of Rocholl et al. 2010 / US9098764B2 (model-based fit of the blurred profile). This is a substantial research and implementation effort.
4. If blurry or damaged codes are business-critical (e.g. worn pen labels), a **licensed** commercial SDK (Scandit with a paid or trial key, or alternatives such as Scanbot, Dynamsoft or STRICH) is the realistic option.

## Sources

- Scandit Web SDK 8.7.0 npm package contents and LICENSE (inspected file list only): `@scandit/web-datacapture-barcode`, `@scandit/web-datacapture-core`
- [Scandit patents page](https://www.scandit.com/patents/) — "blurry barcode decoding", 50+ patents
- [US 10,963,658 — tracking, decoding, positioning multiple optical patterns (Scandit AG)](https://patents.justia.com/patent/10963658) · [uspto.report](https://uspto.report/patent/grant/10,963,658)
- [US 11,216,628 / US20210312151A1 — High-speed scanning of optical patterns using a digital camera](https://patents.justia.com/patent/11216628) · [US 11,803,718 — torch as aimer](https://patents.google.com/patent/US11803718)
- [US 12,175,327 — Camera start optimization for optical pattern decoding](https://patents.google.com/patent/US12175327B1/en)
- [US 12,307,737 — Adaptive selection area for image-based decoding](https://patents.google.com/patent/US12307737)
- [US 11,893,764 — Image analysis for decoding angled optical patterns](https://patents.google.com/patent/US11893764) · [Justia](https://patents.justia.com/patent/11893764)
- [US 9,098,764 B2 — Image-based barcode reader (bypasses binarization)](https://patents.google.com/patent/US9098764)
- [US 8,867,857 B2 — Restoration of blurred barcode images](https://patents.google.com/patent/US8867857B2/en) · [US 8,750,637 B2 — Barcode processing (deconvolution)](https://patents.google.com/patent/US8750637B2/en)
- [Rocholl, Klenk, Heidemann — Robust 1D Barcode Recognition on Mobile Devices, ICPR 2010](https://projet.liris.cnrs.fr/imagine/pub/proceedings/ICPR-2010/data/4109c712.pdf)
- [Gallo, Manduchi — Reading Challenging Barcodes with Cameras (UCSC)](https://tr.soe.ucsc.edu/sites/default/files/technical-reports/UCSC-SOE-09-26.pdf)
- [Sörös — Wearable barcode scanning: code localization, motion blur compensation (ETH)](https://api.sambuz.com/doc/wearable-barcode-scanning-ppt-presentation-363734)
- [YOLO-Barcode, Computer Optics 48(4), 2024](https://computeroptics.ru/eng/KO/Annot/KO48-4/480414e.html) · [PDF](https://www.computeroptics.ru/KO/PDF/KO48-4/480414.pdf)
- [Hansen et al. — Real-Time Barcode Detection and Classification using Deep Learning, IJCCI 2017](https://www.scitepress.org/Papers/2017/65082/65082.pdf)
- [YOLOv8 barcode detection on Android (NCU thesis, 2025)](https://ir.lib.ncu.edu.tw/handle/987654321/98384)
- [Scandit docs — Optimize scanning performance (resolution, multithreading)](https://docs.scandit.com/data-capture-sdk/web/optimize-performance.html) · [System requirements](https://docs.scandit.com/sdks/web/system-requirements/)
- [Scandit docs — AI-powered barcode scanning](https://docs.scandit.com/sdks/web/ai-powered-barcode-scanning)
- [Scanbot — How to read damaged or blurry barcodes](https://scanbot.io/blog/how-to-read-damaged-or-blurry-barcodes/) (competitor perspective)
