/**
 * Deblurring for located 1D codes (motion blur and defocus).
 *
 * Every line across a 1D code's bars carries the same signal plus noise.
 * Averaging many of them gives one profile with far less noise (~8x for 64
 * lines), and only blur ACROSS the bars matters: blur along them does not change
 * the profile. That makes classic 1D deconvolution
 * practical (Wiener filter; see e.g. Gonzalez & Woods, Digital Image Processing,
 * ch. 5; for barcodes: Esedoglu 2004, Shellhammer et al. 1999):
 *
 *   1. Refine the code's angle (the localizer's is good to ~5 degrees; averaging
 *      lines that cross the bars at an angle would smear them).
 *   2. Average many lines across the bars, sampled once from the camera frame at
 *      half-pixel steps -> profile p.
 *   3. For each blur hypothesis h (box = motion of L px, Gaussian = defocus of
 *      sigma px), Wiener-deconvolve: P' = conj(H) P / (|H|^2 + lambda).
 *   4. Render each restored profile as a small clean image for ZXing; the
 *      checksum and the scanner's multi-frame vote reject wrong hypotheses.
 *
 * No DOM; runs in a Web Worker and in Node.
 */

/**
 * Blur hypotheses, in crop pixels: defocus (Gaussian sigma) and motion (box length,
 * on top of a little lens blur). Steps are ~15%: a kernel that is off by more
 * than that restores the bars too poorly to decode.
 */
export const BLURS = [
  ...[1.2, 1.5, 1.8, 2.1, 2.5, 2.9, 3.4].map((size) => ({ kind: 'gauss', size })),
  ...[4, 4.7, 5.5, 6.4, 7.4, 8.6, 10, 11.6, 13.4, 15.5, 18].map((size) => ({ kind: 'box', size, sigma: 0.8 })),
];

/** In-place radix-2 complex FFT (re, im of length 2^k). inverse: unscaled. */
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/**
 * Mean luminance (green) across the bars, sampled once from the source image:
 * position i is at distance (i - n/2) * step along u from the centre, averaged
 * over `rows` lines spread across the code's thickness. One bilinear sample per
 * pixel; no resampled intermediate image, so 2 px bars stay sharp.
 */
function sampleProfile(img, cx, cy, angle, len, thick, rows, step) {
  const { data, width: W, height: H } = img;
  const ux = Math.cos(angle), uy = Math.sin(angle), vx = -uy, vy = ux;
  const n = Math.round(len / step), p = new Float32Array(n);
  for (let r = 0; r < rows; r += 1) {
    const v = ((r + 0.5) / rows - 0.5) * thick;
    let fx = cx + v * vx - (n / 2) * step * ux, fy = cy + v * vy - (n / 2) * step * uy;
    const dx = ux * step, dy = uy * step;
    for (let i = 0; i < n; i += 1, fx += dx, fy += dy) {
      if (fx < 0 || fy < 0 || fx >= W - 1 || fy >= H - 1) { p[i] += 255; continue; }
      const xi = fx | 0, yi = fy | 0, ax = fx - xi, ay = fy - yi;
      const q = (yi * W + xi) * 4 + 1, q2 = q + W * 4;
      p[i] += (data[q] * (1 - ax) + data[q + 4] * ax) * (1 - ay) + (data[q2] * (1 - ax) + data[q2 + 4] * ax) * ay;
    }
  }
  for (let i = 0; i < n; i += 1) p[i] /= rows;
  return p;
}

/** Edge energy of a profile: highest when the averaged lines run exactly along the bars. */
function sharpness(p) {
  let e = 0;
  for (let i = 1; i < p.length; i += 1) { const d = p[i] - p[i - 1]; e += d * d; }
  return e;
}

/**
 * Low-noise profile across the bars of a located code (from locateLinear), at
 * half-pixel steps. The localizer's angle is good to ~5 degrees, and averaging
 * lines that cross the bars at an angle smears them, so the angle is refined
 * first: the one whose average has the sharpest edges (coarse, then fine).
 * @returns {{profile: Float32Array, angle: number, step: number, steepness: number}}
 *   steepness: steepest edge as a fraction of the bar contrast per source pixel
 *   (~0.5 or more when sharp, lower the more blurred)
 */
export function barProfile(img, c, { margin = 0.18, step = 0.5 } = {}) {
  const len = c.len * (1 + 2 * margin) + 32;
  const thick = Math.min(120, Math.max(16, c.thick * 0.8)); // stay inside the bars' height
  let best = c.angle, bestE = -1;
  const tryAngle = (a) => {
    const e = sharpness(sampleProfile(img, c.cx, c.cy, a, len, thick, 16, 1));
    if (e > bestE) { bestE = e; best = a; }
  };
  const deg = Math.PI / 180;
  for (let d = -6; d <= 6; d += 1) tryAngle(c.angle + d * deg);
  const coarse = best;
  for (let d = -0.75; d <= 0.76; d += 0.25) tryAngle(coarse + d * deg);
  const rows = Math.max(8, Math.min(64, Math.round(thick)));
  const profile = sampleProfile(img, c.cx, c.cy, best, len, thick, rows, step);
  return { profile, angle: best, step, steepness: steepness(profile, step) };
}

function steepness(p, step) {
  const sorted = Float32Array.from(p).sort();
  const range = sorted[Math.floor(p.length * 0.95)] - sorted[Math.floor(p.length * 0.05)];
  let g = 0;
  for (let i = 1; i < p.length - 1; i += 1) g = Math.max(g, Math.abs(p[i + 1] - p[i - 1]) / (2 * step));
  return range > 0 ? g / range : 0;
}

/** Spectrum of a blur kernel, on a grid of `step` source pixels. */
function kernelSpectrum(blur, n, step) {
  const re = new Float64Array(n), im = new Float64Array(n);
  // box of length L (motion) convolved with a Gaussian (lens), sampled on the pixel grid
  const L = (blur.kind === 'box' ? blur.size : 0) / step, s = (blur.kind === 'box' ? blur.sigma : blur.size) / step;
  const r = Math.ceil(L / 2 + 3 * s);
  for (let i = -r; i <= r; i += 1) {
    let v = 0;
    for (let k = 0; k < 8; k += 1) { // integrate over the box
      const x = i - (L ? -L / 2 + (L * (k + 0.5)) / 8 : 0);
      v += Math.exp(-(x * x) / (2 * s * s));
    }
    re[(i + n) % n] += v;
  }
  let t = 0;
  for (let i = 0; i < n; i += 1) t += re[i];
  for (let i = 0; i < n; i += 1) re[i] /= t;
  fft(re, im, false);
  return { re, im };
}

/**
 * Wiener-deconvolve a profile for each blur hypothesis.
 * @param {Float32Array} profile
 * @param {{step?: number, blurs?: object[], lambda?: number}} [opts] step: source px per profile sample
 * @returns {{blur: object, profile: Float32Array}[]}
 */
export function deconvolve(profile, { step = 1, blurs = BLURS, lambda = 0.004 } = {}) {
  const w = profile.length;
  let n = 1;
  while (n < w * 2) n <<= 1;
  // mirror-pad so the ends do not ring
  const re0 = new Float64Array(n), im0 = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < w; i += 1) mean += profile[i];
  mean /= w;
  for (let i = 0; i < n; i += 1) {
    const k = i < w ? i : Math.max(0, 2 * w - 1 - i);
    re0[i] = (k < w ? profile[k] : profile[0]) - mean;
  }
  fft(re0, im0, false);
  const out = [];
  for (const blur of blurs) {
    const H = kernelSpectrum(blur, n, step);
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const hr = H.re[i], hi = H.im[i], d = hr * hr + hi * hi + lambda;
      re[i] = (re0[i] * hr + im0[i] * hi) / d;
      im[i] = (im0[i] * hr - re0[i] * hi) / d;
    }
    fft(re, im, true);
    const p = new Float32Array(w);
    for (let i = 0; i < w; i += 1) p[i] = re[i] / n + mean;
    out.push({ blur, profile: p });
  }
  return out;
}

/** A clean RGBA image of a profile (contrast-stretched, `rows` identical rows) for ZXing. */
export function profileImage(p, rows = 12) {
  const w = p.length, sorted = Float32Array.from(p).sort();
  const lo = sorted[Math.floor(w * 0.03)], hi = sorted[Math.floor(w * 0.97)], k = 255 / Math.max(1, hi - lo);
  const data = new Uint8ClampedArray(w * rows * 4);
  for (let x = 0; x < w; x += 1) {
    const v = (p[x] - lo) * k;
    for (let y = 0; y < rows; y += 1) {
      const o = (y * w + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { data, width: w, height: rows };
}
