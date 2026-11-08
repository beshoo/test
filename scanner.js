/**
 * BarcodeScanner — camera barcode/QR scanner for the browser. No license key.
 *
 * Engines:
 *   - 'zxing'  : ZXing-C++ (WebAssembly, self-hosted) in a Web Worker, with the
 *                multi-strategy / region-of-interest / confirmation pipeline in
 *                engine/decode-core.js. Works in every modern browser.
 *   - 'native' : the browser's Barcode Detection API (Chrome on Android, where it
 *                is backed by Google ML Kit). Fast, but not available on iOS,
 *                Firefox or desktop Chrome on Windows/Linux.
 *   - 'auto'   : both at once ("hybrid") where the browser has a native
 *                detector, otherwise zxing.
 *
 * Camera access needs a secure context: HTTPS, or http://localhost.
 *
 *   import { BarcodeScanner } from './scanner.js';
 *   const scanner = new BarcodeScanner(video, { formats: ['data_matrix', 'ean_13'], onDetect: (codes) => … });
 *   await scanner.start();
 */
import { LINEAR_FORMATS, STRATEGIES } from './engine/decode-core.js?v=6790fe6-202611080102';

/** Formats offered in the UI (both engines understand these names). */
export const COMMON_FORMATS = [
  'qr_code', 'data_matrix', 'aztec', 'pdf417',
  'ean_13', 'ean_8', 'upc_a', 'upc_e',
  'code_128', 'code_39', 'code_93', 'codabar', 'itf',
];

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

/** A module worker with promise-based calls. */
function makeWorker(url) {
  const worker = new Worker(url, { type: 'module' });
  const pending = new Map();
  let nextId = 1;
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.error) p.reject(new Error(data.error));
    else p.resolve(data.results);
  };
  worker.onerror = (e) => {
    const err = new Error(`Decoder worker failed: ${e.message || 'unknown error'}`);
    pending.forEach((p) => p.reject(err));
    pending.clear();
  };
  const call = (msg, transfer = []) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });
  return { worker, call, ready: call({ type: 'ping' }) };
}

let zxingWorker = null;
let greyWorker = null;
const RETAIL = new Set(['ean_13', 'ean_8', 'upc_a', 'upc_e']);

/**
 * ZXing in a module Web Worker, plus (on multi-core devices) a second worker that
 * runs the greyscale EAN/UPC reader at the same time, so a full-resolution frame
 * costs max(ZXing, greyscale) instead of their sum. Shared by all scanners on the page.
 */
class ZXingWorkerEngine {
  constructor() {
    this.name = 'zxing';
    if (!zxingWorker) {
      zxingWorker = makeWorker(new URL('./engine/worker.js?v=6790fe6-202611080102', import.meta.url));
      zxingWorker.ready.catch(() => { zxingWorker = null; });
    }
    if (!greyWorker && (navigator.hardwareConcurrency || 1) >= 2) {
      greyWorker = makeWorker(new URL('./engine/grey-worker.js?v=6790fe6-202611080102', import.meta.url));
      greyWorker.ready.catch(() => { greyWorker = null; });
    }
    this._w = zxingWorker;
    this._g = greyWorker;
    this.parallel = Boolean(greyWorker);
  }

  ready() {
    return this._w.ready;
  }

  /** @param {ImageData} image ownership of image.data.buffer is transferred */
  async decodeImage(image, { formats, strategy, offset, all = false, greyEan = true, tryRotate }) {
    const img = { data: image.data, width: image.width, height: image.height };
    if (!greyEan || all || !this._g) {
      return this._w.call({ image: img, formats, strategy, offset, all, greyEan, tryRotate }, [image.data.buffer]);
    }
    // Parallel: ZXing in one worker, the greyscale reader in the other (on a copy).
    const copy = { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height };
    const [z, g] = await Promise.allSettled([
      this._w.call({ image: img, formats, strategy, offset, greyEan: false, tryRotate }, [image.data.buffer]),
      this._g.call({ image: copy, formats, offset }, [copy.data.buffer]),
    ]);
    if (z.status === 'rejected' && g.status === 'rejected') throw z.reason;
    const zr = z.status === 'fulfilled' ? z.value : [];
    const gr = g.status === 'fulfilled' ? g.value : [];
    // Same rule as the sequential path: greyscale results only when ZXing found no retail code.
    if (zr.some((r) => RETAIL.has(r.format))) return zr;
    return [...zr, ...gr.filter((r) => !zr.some((o) => o.rawValue === r.rawValue))];
  }

  /** @param {{canvas, ctx, width, height}} frame */
  decode(frame, opts) {
    return this.decodeImage(frame.ctx.getImageData(0, 0, frame.width, frame.height), opts);
  }
}

/** The browser's own BarcodeDetector. */
class NativeEngine {
  constructor(formats) {
    this.name = 'native';
    this._detector = new globalThis.BarcodeDetector(formats.length ? { formats } : undefined);
  }

  ready() {
    return Promise.resolve();
  }

  async decode(frame, { offset = { x: 0, y: 0 } } = {}) {
    const codes = await this._detector.detect(frame.canvas);
    return codes.map((c) => {
      const pts = c.cornerPoints.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y }));
      const b = c.boundingBox;
      return {
        rawValue: c.rawValue,
        format: c.format,
        symbologyIdentifier: '',
        isGS1: false,
        cornerPoints: pts,
        boundingBox: { x: b.x + offset.x, y: b.y + offset.y, width: b.width, height: b.height },
        strategy: 'native',
      };
    });
  }
}

/**
 * Both engines on every frame: Android's ML Kit-backed BarcodeDetector and
 * ZXing in the worker, in parallel. Whichever reads the code wins. This guards
 * against devices where BarcodeDetector exists but never returns results.
 */
class HybridEngine {
  constructor(native, zxing) {
    this.name = 'hybrid';
    this.native = native;
    this.zxing = zxing;
    this.hits = { native: 0, zxing: 0 };
    this.errors = { native: null, zxing: null };
    this.attempts = 0;
    this.nativeOff = false; // set when the built-in detector never reads but ZXing does
  }

  ready() {
    return this.zxing.ready();
  }

  async decode(frame, opts) {
    this.attempts += 1;
    // Some devices expose BarcodeDetector but it never finds anything. Every frame
    // would still wait for it, so stop using it once ZXing has clearly taken over.
    if (!this.nativeOff && this.attempts >= 30 && this.hits.native === 0 && this.hits.zxing >= 3) this.nativeOff = true;
    if (this.nativeOff) {
      const zr = await this.zxing.decode(frame, opts);
      if (zr.length) this.hits.zxing += 1;
      return zr;
    }
    // Copy pixels for ZXing first: the canvas is not redrawn until both finish.
    const image = frame.ctx.getImageData(0, 0, frame.width, frame.height);
    const [n, z] = await Promise.allSettled([this.native.decode(frame, opts), this.zxing.decodeImage(image, opts)]);
    if (n.status === 'rejected') this.errors.native = String(n.reason?.message || n.reason);
    if (z.status === 'rejected') this.errors.zxing = String(z.reason?.message || z.reason);
    if (n.status === 'rejected' && z.status === 'rejected') throw z.reason;
    const nr = n.status === 'fulfilled' ? n.value : [];
    const zr = z.status === 'fulfilled' ? z.value : [];
    if (nr.length) this.hits.native += 1;
    if (zr.length) this.hits.zxing += 1;
    const out = [...zr];
    for (const r of nr) if (!out.some((o) => o.rawValue === r.rawValue)) out.push(r);
    return out;
  }
}

/**
 * True when the camera has autofocus (unknown = assume yes). Some Android phones
 * list only "manual" among the focus modes yet report "continuous" as the current
 * mode, so the current setting counts too.
 */
function hasAutofocus(track) {
  const modes = track?.getCapabilities?.().focusMode;
  const current = track?.getSettings?.().focusMode;
  if (current === 'continuous' || current === 'single-shot') return true;
  if (!Array.isArray(modes)) return true; // browser does not report focus (e.g. Safari): don't second-guess it
  return modes.includes('continuous') || modes.includes('single-shot');
}

async function nativeSupports(formats) {
  if (typeof globalThis.BarcodeDetector !== 'function') return false;
  try {
    const supported = await globalThis.BarcodeDetector.getSupportedFormats();
    return supported.length > 0 && formats.every((f) => supported.includes(f));
  } catch {
    return false;
  }
}

/**
 * 'auto'   : hybrid (native + ZXing) where the browser has a BarcodeDetector, else ZXing.
 * 'zxing'  : ZXing only.  'native' : BarcodeDetector only.
 */
export async function createEngine(formats = [], engine = 'auto') {
  const hasNative = engine !== 'zxing' && (await nativeSupports(formats));
  if (engine === 'native') {
    if (!hasNative) throw new Error('The native BarcodeDetector is not available for these formats.');
    return new NativeEngine(formats);
  }
  const z = new ZXingWorkerEngine();
  await z.ready();
  return hasNative ? new HybridEngine(new NativeEngine(formats), z) : z;
}

/**
 * Pick the main back camera. Asking for facingMode "environment" often gets an
 * ultra-wide or secondary lens on multi-camera phones, which cannot focus close.
 *   Android Chrome labels: "camera2 0, facing back" - the lowest number is the main camera.
 *   iOS Safari labels: "Back Camera", "Back Ultra Wide Camera", "Back Triple Camera", ...
 *   The virtual multi-lens cameras switch lenses automatically for close-ups.
 */
export function chooseBackCamera(devices) {
  const back = devices.filter((d) => /back|rear|environment/i.test(d.label));
  if (!back.length) return null;
  const numbered = back.map((d) => ({ d, n: d.label.match(/camera2?\s*(\d+)/i) })).filter((x) => x.n);
  if (numbered.length) return numbered.sort((a, b) => Number(a.n[1]) - Number(b.n[1]))[0].d;
  for (const re of [/triple/i, /dual wide/i, /dual/i, /^back camera$/i]) {
    const hit = back.find((d) => re.test(d.label));
    if (hit) return hit;
  }
  return back.find((d) => !/ultra|tele|depth|infrared/i.test(d.label)) ?? back[0];
}

// ---------------------------------------------------------------------------
// Still images
// ---------------------------------------------------------------------------

/**
 * Decode a still image (File/Blob, <img>, ImageBitmap, canvas). With the zxing
 * engine every strategy is tried until one succeeds.
 */
export async function scanImage(source, { formats = [], engine = 'auto', maxSize = 3000 } = {}) {
  const eng = await createEngine(formats, engine);
  const bitmap = source instanceof Blob ? await createImageBitmap(source) : source;
  try {
    const w0 = bitmap.naturalWidth || bitmap.videoWidth || bitmap.width;
    const h0 = bitmap.naturalHeight || bitmap.videoHeight || bitmap.height;
    const scale = Math.min(1, maxSize / Math.max(w0, h0));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w0 * scale);
    canvas.height = Math.round(h0 * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const frame = { canvas, ctx, width: canvas.width, height: canvas.height };
    const results = await eng.decode(frame, { formats, all: true });
    return results.map((r) => scaleResult(r, 1 / scale));
  } finally {
    if (bitmap !== source) bitmap.close?.();
  }
}

function scaleResult(r, k) {
  if (k === 1) return r;
  return {
    ...r,
    cornerPoints: r.cornerPoints.map((p) => ({ x: p.x * k, y: p.y * k })),
    boundingBox: { x: r.boundingBox.x * k, y: r.boundingBox.y * k, width: r.boundingBox.width * k, height: r.boundingBox.height * k },
  };
}

// ---------------------------------------------------------------------------
// Live camera scanner
// ---------------------------------------------------------------------------

export class BarcodeScanner {
  /**
   * @param {HTMLVideoElement} video
   * @param {object} [options]
   * @param {string[]} [options.formats]               formats to look for ([] = all)
   * @param {(codes: object[]) => void} [options.onDetect]  new, confirmed, de-duplicated codes
   * @param {(err: Error) => void} [options.onError]
   * @param {'auto'|'native'|'zxing'} [options.engine='auto']
   * @param {boolean} [options.continuous=true]        false = stop after the first hit
   * @param {string} [options.deviceId]                camera to use (see listCameras)
   * @param {number} [options.maxDecodeSize=1280]      longest edge of the downscaled full-frame pass
   * @param {() => {x:number,y:number,width:number,height:number}|null} [options.getRegion]
   *        region of interest in video pixels, decoded at full resolution on alternate frames.
   *        Default: the central 76% × 64% of the frame.
   * @param {number} [options.confirmLinear=2]         frames that must agree before a 1D code is reported
   * @param {number} [options.duplicateTimeoutMs=1500] suppress the same value for this long
   * @param {number} [options.scanIntervalMs=0]        minimum time between decode attempts
   */
  constructor(video, options = {}) {
    if (!(video instanceof HTMLVideoElement)) throw new TypeError('BarcodeScanner needs a <video> element');
    this.video = video;
    this.options = {
      formats: [],
      onDetect: () => {},
      onError: (err) => console.error(err),
      engine: 'auto',
      continuous: true,
      deviceId: undefined,
      maxDecodeSize: 1280,
      getRegion: null,
      confirmLinear: 2,
      duplicateTimeoutMs: 1500,
      scanIntervalMs: 0,
      ...options,
    };
    this.engine = null;
    this.stream = null;
    this.lastResults = [];
    this.stats = { frames: 0, decodeMs: 0 };   // reset by the UI every second
    this.totals = { attempts: 0, decodeMs: 0, reads: 0 };
    this.lastError = null;
    this._running = false;
    this._busy = false;
    this._pass = 0;
    this._roiPasses = 0;
    this._fullPasses = 0;
    this._lastRoiHitAt = 0;
    this.firstReadMs = null;
    this.firstSeenMs = null;
    this.passStats = { box: { attempts: 0, reads: 0, ms: 0 }, frame: { attempts: 0, reads: 0, ms: 0 } };
    this._startedAt = 0;
    this._lastScanAt = 0;
    this._seen = new Map();    // rawValue -> last reported time
    this._pending = new Map(); // rawValue -> {count, t} awaiting confirmation
    this._canvas = document.createElement('canvas');
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    this._frameHandle = null;
    this._tick = this._tick.bind(this);

    video.setAttribute('playsinline', ''); // iOS: don't go fullscreen
    video.muted = true;
  }

  get running() {
    return this._running;
  }

  /** Cameras available to the page. Labels are empty until permission is granted. */
  static async listCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  /** @param {{probe?: boolean}} [opts] probe: look for an autofocus camera if this one has none */
  async start({ probe = true } = {}) {
    if (this._running) return;
    if (!window.isSecureContext) throw new Error('Camera access requires HTTPS (or localhost).');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no camera API.');

    this.engine = await createEngine(this.options.formats, this.options.engine);

    const which = this.options.deviceId
      ? { deviceId: { exact: this.options.deviceId } }
      : { facingMode: { ideal: 'environment' } };
    const constraints = (w) => ({
      audio: false,
      video: { ...w, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    });
    this.stream = await navigator.mediaDevices.getUserMedia(constraints(which));

    // Labels are only readable after permission: now switch to the main back camera if needed.
    this.autoSwitched = null;
    this.cameraReport = [];
    try {
      if (!this.options.deviceId) {
        const best = chooseBackCamera(await BarcodeScanner.listCameras());
        const current = this.track?.getSettings?.().deviceId;
        if (best && best.deviceId && best.deviceId !== current) {
          this.stream.getTracks().forEach((t) => t.stop());
          this.stream = await navigator.mediaDevices.getUserMedia(constraints({ deviceId: { exact: best.deviceId } }));
        }
      }
      // A camera without autofocus (often an ultra-wide or macro lens) gives soft
      // images at barcode distance. Probe the other back cameras for one that has it,
      // also when this camera was remembered from an earlier visit; a camera picked
      // from the list during this session (probe: false) is left alone.
      this.cameraReport.push({ camera: this.track?.label, autofocus: hasAutofocus(this.track) });
      if (probe && !hasAutofocus(this.track)) {
        const from = this.track?.label;
        const others = (await BarcodeScanner.listCameras())
          .filter((d) => /back|rear|environment/i.test(d.label) && d.deviceId !== this.track?.getSettings?.().deviceId)
          .slice(0, 5);
        for (const d of others) {
          const trial = await navigator.mediaDevices.getUserMedia(constraints({ deviceId: { exact: d.deviceId } })).catch(() => null);
          if (!trial) { this.cameraReport.push({ camera: d.label, autofocus: null, note: 'could not open' }); continue; }
          const af = hasAutofocus(trial.getVideoTracks()[0]);
          this.cameraReport.push({ camera: d.label, autofocus: af });
          if (af) {
            this.stream.getTracks().forEach((t) => t.stop());
            this.stream = trial;
            this.autoSwitched = { from, to: d.label, deviceId: d.deviceId };
            break;
          }
          trial.getTracks().forEach((t) => t.stop());
        }
      }
    } catch {
      if (!this.stream?.active) this.stream = await navigator.mediaDevices.getUserMedia(constraints(which));
    }
    this.autofocus = hasAutofocus(this.track);

    // Continuous autofocus where the device allows it.
    const caps = this.capabilities;
    if (caps.focusMode?.includes('continuous')) {
      this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }

    this.video.srcObject = this.stream;
    await this.video.play();
    this._running = true;
    this._startedAt = performance.now();
    this.firstReadMs = null;
    this.firstSeenMs = null;
    this.passStats = { box: { attempts: 0, reads: 0, ms: 0 }, frame: { attempts: 0, reads: 0, ms: 0 } };
    this._seen.clear();
    this._pending.clear();
    this._schedule();
  }

  stop() {
    this._running = false;
    if (this._frameHandle !== null) {
      if (this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this._frameHandle);
      else cancelAnimationFrame(this._frameHandle);
      this._frameHandle = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.lastResults = [];
  }

  /** Restart with a different camera. */
  async switchCamera(deviceId) {
    this.options.deviceId = deviceId || undefined;
    if (this._running) {
      this.stop();
      await this.start({ probe: false }); // the user chose this camera: keep it
    }
  }

  /** Change the formats being scanned for. */
  async setFormats(formats) {
    this.options.formats = formats;
    if (this._running) this.engine = await createEngine(formats, this.options.engine);
  }

  /** A snapshot of what the scanner is doing, for troubleshooting on a device. */
  diagnostics() {
    const t = this.track;
    const st = t?.getSettings?.() ?? {};
    const caps = this.capabilities;
    return {
      engine: this.engine?.name ?? null,
      engineHits: this.engine?.hits ?? null,
      nativeRetired: this.engine?.nativeOff ?? null,
      parallelWorkers: (this.engine?.zxing ?? this.engine)?.parallel ?? null,
      firstSeenMs: this.firstSeenMs,
      firstReadMs: this.firstReadMs,
      passes: Object.fromEntries(Object.entries(this.passStats ?? {}).map(([k, v]) => [k,
        `${v.reads}/${v.attempts} frames read, ${v.attempts ? Math.round(v.ms / v.attempts) : 0} ms each`])),
      engineErrors: this.engine?.errors ?? null,
      camera: t?.label ?? null,
      resolution: st.width ? `${st.width}x${st.height} @ ${Math.round(st.frameRate || 0)}fps` : null,
      video: this.video.videoWidth ? `${this.video.videoWidth}x${this.video.videoHeight}` : null,
      focusMode: st.focusMode ?? null,
      autofocus: this.autofocus ?? null,
      cameras: this.cameraReport ?? null,
      autoSwitched: this.autoSwitched ? `${this.autoSwitched.from} -> ${this.autoSwitched.to}` : null,
      focusModes: caps.focusMode ?? null,
      zoom: caps.zoom ? `${st.zoom ?? '?'} (${caps.zoom.min}-${caps.zoom.max})` : null,
      torch: Boolean(caps.torch),
      attempts: this.totals.attempts,
      avgDecodeMs: this.totals.attempts ? Math.round(this.totals.decodeMs / this.totals.attempts) : null,
      reads: this.totals.reads,
      lastError: this.lastError,
      formats: this.options.formats,
      userAgent: navigator.userAgent,
    };
  }

  /** The current camera frame at full resolution, as a PNG blob (for troubleshooting). */
  async captureFrame() {
    const v = this.video;
    if (!v.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  }

  // --- camera controls ------------------------------------------------------

  get track() {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  get capabilities() {
    return this.track?.getCapabilities?.() ?? {};
  }

  get torchSupported() {
    return Boolean(this.capabilities.torch);
  }

  async setTorch(on) {
    if (!this.torchSupported) return false;
    await this.track.applyConstraints({ advanced: [{ torch: Boolean(on) }] });
    return true;
  }

  /** {min, max, step} when the camera supports zoom, else null. */
  get zoomRange() {
    const z = this.capabilities.zoom;
    return z && z.max > z.min ? z : null;
  }

  async setZoom(value) {
    if (!this.zoomRange) return false;
    await this.track.applyConstraints({ advanced: [{ zoom: value }] });
    return true;
  }

  /**
   * Focus on a point (0..1 in video coordinates) where the camera supports it,
   * otherwise re-trigger autofocus. Returns true if a focus command was sent.
   */
  async focusAt(x, y) {
    const caps = this.capabilities;
    const advanced = {};
    if (caps.pointsOfInterest || 'pointsOfInterest' in (this.track?.getSettings?.() ?? {})) {
      advanced.pointsOfInterest = [{ x, y }];
    }
    if (caps.focusMode?.includes('single-shot')) advanced.focusMode = 'single-shot';
    else if (caps.focusMode?.includes('continuous')) advanced.focusMode = 'continuous';
    if (!Object.keys(advanced).length) return false;
    try {
      await this.track.applyConstraints({ advanced: [advanced] });
      if (advanced.focusMode === 'single-shot' && caps.focusMode.includes('continuous')) {
        setTimeout(() => this.track?.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}), 1500);
      }
      return true;
    } catch {
      return false;
    }
  }

  // --- frame loop -------------------------------------------------------------

  _schedule() {
    if (!this._running) return;
    this._frameHandle = this.video.requestVideoFrameCallback
      ? this.video.requestVideoFrameCallback(this._tick)
      : requestAnimationFrame(this._tick);
  }

  _region(vw, vh) {
    const r = this.options.getRegion?.();
    if (r && r.width > 16 && r.height > 16) {
      const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
      return { x, y, width: Math.min(vw - x, Math.ceil(r.width)), height: Math.min(vh - y, Math.ceil(r.height)) };
    }
    return { x: Math.round(vw * 0.12), y: Math.round(vh * 0.18), width: Math.round(vw * 0.76), height: Math.round(vh * 0.64) };
  }

  /**
   * Choose what this frame decodes. Passes alternate between
   *   - the region of interest at full camera resolution (small/far codes), and
   *   - the whole frame downscaled to maxDecodeSize (codes anywhere in view),
   * and with the zxing engine each pair of passes uses the next strategy on the ladder.
   */
  _plan(vw, vh) {
    const pass = this._pass++;
    const needsDownscale = Math.max(vw, vh) > this.options.maxDecodeSize;
    // The box gets most passes (users aim at it): 3 of 4, and 7 of 8 while codes keep
    // turning up there. Whole-frame passes remain as a fallback for codes outside it.
    // (On a phone, 12 of 41 whole-frame passes read nothing while the code sat in the box.)
    const boxBusy = performance.now() - (this._lastRoiHitAt || -1e9) < 3000;
    const roiPass = needsDownscale && (boxBusy ? pass % 8 !== 7 : pass % 4 !== 3);
    const strategy = (roiPass ? this._roiPasses++ : this._fullPasses++) % STRATEGIES.length;
    if (roiPass) {
      const r = this._region(vw, vh);
      return { sx: r.x, sy: r.y, sw: r.width, sh: r.height, scale: 1, strategy, greyEan: true, tryRotate: false };
    }
    const scale = Math.min(1, this.options.maxDecodeSize / Math.max(vw, vh));
    // without a separate region pass (small video), the whole frame is full resolution
    return { sx: 0, sy: 0, sw: vw, sh: vh, scale, strategy, greyEan: !needsDownscale };
  }

  async _tick() {
    if (!this._running) return;
    const now = performance.now();
    const video = this.video;
    if (this._busy || now - this._lastScanAt < this.options.scanIntervalMs || video.readyState < 2 || !video.videoWidth) {
      this._schedule();
      return;
    }
    this._busy = true;
    this._lastScanAt = now;
    this._schedule();

    try {
      const vw = video.videoWidth, vh = video.videoHeight;
      const plan = this._plan(vw, vh);
      const w = Math.round(plan.sw * plan.scale), h = Math.round(plan.sh * plan.scale);
      if (this._canvas.width !== w || this._canvas.height !== h) {
        this._canvas.width = w;
        this._canvas.height = h;
      }
      this._ctx.drawImage(video, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, w, h);

      const engine = this.engine;
      const frame = { canvas: this._canvas, ctx: this._ctx, width: w, height: h };
      const t0 = performance.now();
      const found = await engine.decode(frame, { formats: this.options.formats, strategy: plan.strategy, greyEan: plan.greyEan, tryRotate: plan.tryRotate });
      const dt = performance.now() - t0;
      this.stats.frames += 1;
      this.stats.decodeMs += dt;
      this.totals.attempts += 1;
      this.totals.decodeMs += dt;
      if (found.length) this.totals.reads += 1;
      const ps = this.passStats[plan.scale === 1 && plan.greyEan ? 'box' : 'frame'];
      ps.attempts += 1; ps.ms += dt;
      if (found.length) {
        ps.reads += 1;
        if (this.firstSeenMs === null) this.firstSeenMs = Math.round(performance.now() - this._startedAt);
      }
      if (!this._running) return;

      // Back to video pixel coordinates.
      const inv = 1 / plan.scale;
      const results = found.map((r) => {
        const s = scaleResult(r, inv);
        const pts = s.cornerPoints.map((p) => ({ x: p.x + plan.sx, y: p.y + plan.sy }));
        return { ...s, cornerPoints: pts, boundingBox: { ...s.boundingBox, x: s.boundingBox.x + plan.sx, y: s.boundingBox.y + plan.sy } };
      });
      // Keep outlines on screen briefly so they don't flicker between passes.
      const tNow = performance.now();
      if (results.length) {
        this.lastResults = results;
        this._lastHitAt = tNow;
        if (plan.scale === 1 && plan.greyEan) this._lastRoiHitAt = tNow;
      } else if (!this._lastHitAt || tNow - this._lastHitAt > 300) {
        this.lastResults = [];
      }

      const fresh = this._accept(results, tNow);
      if (fresh.length) {
        if (this.firstReadMs === null) this.firstReadMs = Math.round(tNow - this._startedAt);
        this.options.onDetect(fresh);
        if (!this.options.continuous) this.stop();
      }
    } catch (err) {
      this.lastError = String(err?.message || err);
      this.options.onError(err);
    } finally {
      this._busy = false;
    }
  }

  /** Multi-frame confirmation for 1D codes + duplicate suppression. */
  /**
   * Decide which reads to report. 1D codes have weak checksums (a wrong EAN passes
   * its check digit 1 time in 10), so for them:
   *   - every read is a vote, kept for 2 s;
   *   - a value needs `confirmLinear` (2) votes, 3 if only the greyscale reader
   *     sees it (soft frames), or 1 for a ZXing read backed by >= 12 scan lines
   *     (ghost reads had 5, real ones ~49) with no rival;
   *   - if a different 1D value was also seen in the last 2 s, a value must have at
   *     least twice the votes of every rival. A rare bad frame cannot win against
   *     the real code, which shows up on most frames.
   * 2D codes (strong error correction) are reported at once.
   */
  _accept(results, now) {
    const out = [];
    for (const [value, p] of this._pending) if (now - p.t > 2000) this._pending.delete(value);
    for (const r of results) {
      if (LINEAR_FORMATS.has(r.format)) {
        const p = this._pending.get(r.rawValue) ?? { count: 0, t: now, format: r.format };
        p.count += 1;
        p.t = now;
        this._pending.set(r.rawValue, p);
        let rival = 0;
        for (const [value, q] of this._pending) if (value !== r.rawValue && LINEAR_FORMATS.has(q.format)) rival = Math.max(rival, q.count);
        const strong = r.strategy !== 'greyscale-ean' && RETAIL.has(r.format) && (r.lineCount || 0) >= 12;
        // Values only the greyscale reader can see come from soft frames: ask for one more frame.
        const base = r.strategy === 'greyscale-ean' ? this.options.confirmLinear + 1 : this.options.confirmLinear;
        const needed = rival ? Math.max(base, 2 * rival) : (strong ? 1 : base);
        if (p.count < needed) continue;
      }
      const last = this._seen.get(r.rawValue);
      this._seen.set(r.rawValue, now);
      if (last === undefined || now - last > this.options.duplicateTimeoutMs) out.push(r);
    }
    return out;
  }
}
