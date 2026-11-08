/**
 * Fast 1D-barcode localizer + rectifier, so linear codes read at ANY angle.
 *
 * ZXing scans 1D codes along pixel rows (and, with tryRotate, columns). A code
 * tilted 30-60 degrees is crossed by no row from end to end, so it never reads;
 * a long Code 128 already fails past ~10 degrees. Commercial engines find the
 * code first and decode along its own axis. This does the same with a classic,
 * published technique (gradient structure tensor, e.g. Tekin & Coughlan 2012;
 * Katona & Nyul 2012):
 *
 *   1. Luminance at half resolution, central-difference gradients.
 *   2. Per 8x8 cell: structure tensor J = sum(g g^T). Bars give strong gradients
 *      that all point the same way, i.e. high energy AND high coherence
 *      (text and texture have high energy but low coherence).
 *   3. Neighbouring barcode-like cells with the same orientation are joined.
 *      Each group gives a centre, the scan direction u (across the bars) and an
 *      oriented extent.
 *   4. rectify() samples the group along u at full resolution into a small,
 *      level image: ZXing then reads it with tryRotate off, quickly.
 *
 * No DOM; runs in a Web Worker and in Node.
 */

const DS = 2;   // analysis at half resolution
const CELL = 8; // cell size in analysis pixels (16 px at full resolution)

/**
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img RGBA
 * @param {{maxCandidates?: number, minCells?: number}} [opts]
 * @returns {{cx: number, cy: number, angle: number, len: number, thick: number, score: number}[]}
 *   centre in image pixels, angle of the scan direction (radians), extent along / across it
 */
export function locateLinear(img, { maxCandidates = 3, minCells = 3 } = {}) {
  const { data, width: W, height: H } = img;
  const w = Math.floor(W / DS), h = Math.floor(H / DS);
  const L = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const r0 = y * DS * W, r1 = r0 + W;
    for (let x = 0; x < w; x += 1) {
      const p = (r0 + x * DS) * 4, q = (r1 + x * DS) * 4;
      // green channel is a good, cheap luma proxy; average a 2x2 block
      L[y * w + x] = (data[p + 1] + data[p + 5] + data[q + 1] + data[q + 5]) * 0.25;
    }
  }
  const cw = Math.floor(w / CELL), ch = Math.floor(h / CELL);
  const n = cw * ch;
  const jxx = new Float32Array(n), jyy = new Float32Array(n), jxy = new Float32Array(n);
  for (let y = 1; y < ch * CELL - 1; y += 1) {
    const row = y * w, crow = ((y / CELL) | 0) * cw;
    for (let x = 1; x < cw * CELL - 1; x += 1) {
      const i = row + x;
      const gx = L[i + 1] - L[i - 1], gy = L[i + w] - L[i - w];
      const c = crow + ((x / CELL) | 0);
      jxx[c] += gx * gx; jyy[c] += gy * gy; jxy[c] += gx * gy;
    }
  }
  // Candidate cells: coherent and strong. The energy threshold adapts to the frame
  // (a dim, low-contrast frame still has its bars as its strongest structure).
  const energy = new Float32Array(n), coh = new Float32Array(n), ang2x = new Float32Array(n), ang2y = new Float32Array(n);
  let maxE = 0;
  for (let c = 0; c < n; c += 1) {
    const e = jxx[c] + jyy[c];
    energy[c] = e;
    if (e > maxE) maxE = e;
    const d = jxx[c] - jyy[c], o = 2 * jxy[c];
    const m = Math.sqrt(d * d + o * o);
    coh[c] = e > 0 ? m / e : 0;
    ang2x[c] = m > 0 ? d / m : 1; // unit vector of the doubled angle
    ang2y[c] = m > 0 ? o / m : 0;
  }
  const minE = Math.max(CELL * CELL * 60, maxE * 0.08);
  const cand = new Uint8Array(n);
  for (let c = 0; c < n; c += 1) cand[c] = energy[c] >= minE && coh[c] >= 0.55 ? 1 : 0;

  // Union-find over 8-neighbours with similar orientation (doubled-angle dot > cos 30deg).
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let cy = 0; cy < ch; cy += 1) {
    for (let cx = 0; cx < cw; cx += 1) {
      const c = cy * cw + cx;
      if (!cand[c]) continue;
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) {
        const x2 = cx + dx, y2 = cy + dy;
        if (x2 < 0 || x2 >= cw || y2 >= ch) continue;
        const d = y2 * cw + x2;
        if (cand[d] && ang2x[c] * ang2x[d] + ang2y[c] * ang2y[d] > 0.866) {
          const a = find(c), b = find(d);
          if (a !== b) parent[a] = b;
        }
      }
    }
  }
  const groups = new Map();
  for (let c = 0; c < n; c += 1) {
    if (!cand[c]) continue;
    const r = find(c);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = { cells: [], vx: 0, vy: 0, e: 0 }));
    g.cells.push(c);
    g.vx += ang2x[c] * energy[c] * coh[c];
    g.vy += ang2y[c] * energy[c] * coh[c];
    g.e += energy[c] * coh[c];
  }

  const out = [];
  const s = DS * CELL; // cell size in image pixels
  for (const g of groups.values()) {
    if (g.cells.length < minCells) continue;
    const theta = 0.5 * Math.atan2(g.vy, g.vx); // gradient direction = across the bars = scan direction
    const ux = Math.cos(theta), uy = Math.sin(theta);
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity, sx = 0, sy = 0;
    for (const c of g.cells) {
      const x = ((c % cw) + 0.5) * s, y = (((c / cw) | 0) + 0.5) * s;
      sx += x; sy += y;
      const a = x * ux + y * uy, b = -x * uy + y * ux;
      if (a < a0) a0 = a; if (a > a1) a1 = a;
      if (b < b0) b0 = b; if (b > b1) b1 = b;
    }
    const len = a1 - a0 + s, thick = b1 - b0 + s;
    // a thin strip of cells along the bars is a single edge (a box, a shelf), not a code
    if (len < 2.5 * s) continue;
    const am = (a0 + a1) / 2, bm = (b0 + b1) / 2;
    out.push({
      cx: am * ux - bm * uy, cy: am * uy + bm * ux,
      angle: theta, len, thick,
      score: g.e,
    });
  }
  out.sort((p, q) => q.score - p.score);
  return out.slice(0, maxCandidates);
}

/**
 * Sample a located code into a level RGBA image (bars vertical, scan along x),
 * at full resolution, with a quiet-zone margin. Bilinear on luminance.
 * @returns {{image: {data, width, height}, map: (x: number, y: number) => {x: number, y: number}}}
 *   map() takes a point in the rectified image back to the source image.
 */
export function rectify(img, c, { margin = 0.18, maxThick = 96 } = {}) {
  const { data, width: W, height: H } = img;
  const len = Math.round(c.len * (1 + 2 * margin) + 32);
  const thick = Math.max(24, Math.min(maxThick, Math.round(c.thick)));
  const ux = Math.cos(c.angle), uy = Math.sin(c.angle), vx = -uy, vy = ux;
  const out = new Uint8ClampedArray(len * thick * 4);
  const x0 = c.cx - (len / 2) * ux - (thick / 2) * vx, y0 = c.cy - (len / 2) * uy - (thick / 2) * vy;
  for (let j = 0; j < thick; j += 1) {
    let fx = x0 + j * vx, fy = y0 + j * vy;
    for (let i = 0; i < len; i += 1, fx += ux, fy += uy) {
      let v = 255;
      if (fx >= 0 && fy >= 0 && fx < W - 1 && fy < H - 1) {
        const xi = fx | 0, yi = fy | 0, ax = fx - xi, ay = fy - yi;
        const p = (yi * W + xi) * 4 + 1, q = p + W * 4;
        v = (data[p] * (1 - ax) + data[p + 4] * ax) * (1 - ay) + (data[q] * (1 - ax) + data[q + 4] * ax) * ay;
      }
      const o = (j * len + i) * 4;
      out[o] = out[o + 1] = out[o + 2] = v;
      out[o + 3] = 255;
    }
  }
  const map = (x, y) => ({ x: x0 + x * ux + y * vx, y: y0 + x * uy + y * vy });
  return { image: { data: out, width: len, height: thick }, map };
}
