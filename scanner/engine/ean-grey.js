/**
 * Greyscale EAN-13 / UPC-A / EAN-8 decoder.
 *
 * ZXing first turns every scan line into pure black and white. On a soft or
 * blurred image the thin white gaps between thick bars never get bright enough
 * to cross that threshold, so they vanish and the barcode becomes unreadable.
 * (A real phone frame of a plain EAN-13 showed 24-28 dark bars instead of 30.)
 *
 * This decoder never thresholds. It finds every bar edge as a local extreme of
 * the brightness gradient along a scan line, at sub-pixel precision. A blurred
 * gap is still a small dip in brightness, so its two edges still show up. This
 * is the classic edge-based approach from the literature (e.g. Gallo & Manduchi,
 * "Reading Challenging Barcodes with Cameras"); see docs/scanner-research.md.
 *
 * Safety: a result needs matching guard patterns, every digit within a match
 * tolerance, a valid check digit, and agreement between at least two scan lines.
 *
 * Pure JS, no DOM: runs in the worker and in Node.
 */

// Widths of the L-code digits (space, bar, space, bar), in modules.
const L = [
  [3, 2, 1, 1], [2, 2, 2, 1], [2, 1, 2, 2], [1, 4, 1, 1], [1, 1, 3, 2],
  [1, 2, 3, 1], [1, 1, 1, 4], [1, 3, 1, 2], [1, 2, 1, 3], [3, 1, 1, 2],
];
const G = L.map((w) => [...w].reverse()); // G-code = mirrored widths
// Parity of the six left digits (true = G) -> first digit of an EAN-13.
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** Match 4 measured widths against a code table. Returns {digit, err} of the best match. */
function bestDigit(w, table) {
  const sum = w[0] + w[1] + w[2] + w[3];
  const u = sum / 7;
  let best = -1, err = Infinity;
  for (let d = 0; d < 10; d += 1) {
    const t = table[d];
    // Compare edge-to-similar-edge distances too (bar+space pairs): they are
    // insensitive to bars growing or shrinking uniformly under blur/ink spread.
    const e = Math.abs(w[0] + w[1] - (t[0] + t[1]) * u) + Math.abs(w[1] + w[2] - (t[1] + t[2]) * u)
      + Math.abs(w[2] + w[3] - (t[2] + t[3]) * u) + 0.5 * (Math.abs(w[0] - t[0] * u) + Math.abs(w[3] - t[3] * u));
    if (e < err) { err = e; best = d; }
  }
  return { digit: best, err: err / u };
}

// ---------------------------------------------------------------------------
// Model-based digit matching (after Rocholl, Klenk & Heidemann, ICPR 2010):
// render each candidate digit as an ideal bar pattern, blur it, and compare it
// with the measured brightness profile. Robust where edges are displaced.
// ---------------------------------------------------------------------------
const K = 6;                       // samples per module
const SIGMAS = [0.25, 0.45, 0.65, 0.85]; // blur, in modules
// Bar-width bias, in modules: how much wider (+) or narrower (-) every dark bar
// prints/photographs than its nominal width. Glare and overexposure make bars
// thinner; ink spread and dark exposure make them thicker. Estimated per scan line.
const BIASES = [-0.75, -0.5, -0.25, 0, 0.25];
const CTX = 1;                     // modules of known context on each side

function gaussBlur1(src, sigma) {
  const r = Math.max(1, Math.ceil(3 * sigma)), k = [];
  let t = 0;
  for (let i = -r; i <= r; i += 1) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); t += v; }
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 1) {
    let a = 0;
    for (let j = -r; j <= r; j += 1) a += src[Math.min(src.length - 1, Math.max(0, i + j))] * k[j + r];
    out[i] = a / t;
  }
  return out;
}

/**
 * Ideal signal (1 = dark) for a digit's element widths, with one context module
 * on each side. Every dark bar is widened by `bias` modules (half on each side).
 */
function renderTemplate(widths, startDark, sigma, bias) {
  const SUB = 4; // render at 4x, then average down to K samples per module
  const PAD = 2;  // unknown neighbouring modules beyond the known context, rendered as 50% grey
  const total = widths.reduce((a, b) => a + b, 0) + 2 * CTX + 2 * PAD;
  // element boundaries in modules, including the context elements
  const els = [{ dark: !startDark, from: PAD, to: PAD + CTX }];
  let x = PAD + CTX, dark = startDark;
  for (const w of widths) { els.push({ dark, from: x, to: x + w }); x += w; dark = !dark; }
  els.push({ dark, from: x, to: x + CTX });
  const scale = K * SUB;
  const fine = new Float32Array(total * scale);
  for (let i = 0; i < PAD * scale; i += 1) { fine[i] = 0.5; fine[fine.length - 1 - i] = 0.5; }
  for (const e of els) {
    if (!e.dark) continue;
    const a = Math.max(0, (e.from - bias / 2) * scale), b = Math.min(fine.length, (e.to + bias / 2) * scale);
    for (let i = Math.floor(a); i < Math.ceil(b); i += 1) {
      const cover = Math.min(i + 1, b) - Math.max(i, a); // partial coverage at the ends
      fine[i] = Math.max(fine[i], Math.max(0, Math.min(1, cover)));
    }
  }
  const bl = gaussBlur1(fine, sigma * K * SUB);
  const out = new Float32Array((total - 2 * PAD) * K); // drop the padding again
  for (let i = 0; i < out.length; i += 1) {
    let a = 0;
    for (let j = 0; j < SUB; j += 1) a += bl[(i + PAD * K) * SUB + j];
    out[i] = a / SUB;
  }
  return out;
}

// Precomputed templates: TEMPL[biasIndex][set][digit][sigmaIndex].
// Sets: 0 = L (starts light), 1 = G (starts light), 2 = R (starts dark).
const TEMPL = BIASES.map((bias) => [L, G, L].map((table, set) => table.map((w) => SIGMAS.map((sg) => renderTemplate(w, set === 2, sg, bias)))));

/** Resample profile between x0 and x1 (pixels) to `count` samples. */
function resample(p, n, x0, x1, count) {
  const out = new Float32Array(count);
  const step = (x1 - x0) / count;
  for (let i = 0; i < count; i += 1) {
    const x = x0 + (i + 0.5) * step;
    const xi = Math.max(0, Math.min(n - 2, Math.floor(x)));
    const f = Math.max(0, Math.min(1, x - xi));
    out[i] = p[xi] * (1 - f) + p[xi + 1] * f;
  }
  return out;
}

/** Centred template statistics, cached per template array. */
const TSTAT = new WeakMap();
function tstat(t) {
  let st = TSTAT.get(t);
  if (st) return st;
  let m = 0;
  for (let i = 0; i < t.length; i += 1) m += t[i];
  m /= t.length;
  const c = new Float32Array(t.length);
  let sxx = 0;
  for (let i = 0; i < t.length; i += 1) { c[i] = t[i] - m; sxx += c[i] * c[i]; }
  st = { c, sxx };
  TSTAT.set(t, st);
  return st;
}
const SSTAT = new WeakMap();
function sstat(seg) {
  let syy = SSTAT.get(seg);
  if (syy !== undefined) return syy;
  let m = 0;
  for (let i = 0; i < seg.length; i += 1) m += seg[i];
  m /= seg.length;
  syy = 0;
  for (let i = 0; i < seg.length; i += 1) syy += (seg[i] - m) ** 2;
  SSTAT.set(seg, syy);
  return syy;
}

/**
 * Least-squares fit of a template to a segment, profile = a + slope * template with
 * slope < 0 (dark template = darker profile). Returns 1 - R^2: the share of the
 * profile's variation the template leaves unexplained. One dot product per call.
 */
function fitErr(seg, t) {
  const { c, sxx } = tstat(t);
  const syy = sstat(seg);
  if (!(sxx > 0) || !(syy > 0)) return Infinity;
  let sxy = 0;
  for (let i = 0; i < c.length; i += 1) sxy += c[i] * seg[i];
  if (sxy >= 0) return Infinity;
  return 1 - (sxy * sxy) / (sxx * syy);
}

// Guard templates: GUARD[biasIndex][sigmaIndex] for 101 (start/end) and 01010 (middle).
const GUARD3 = BIASES.map((b) => SIGMAS.map((sg) => renderTemplate([1, 1, 1], true, sg, b)));
const GUARD5 = BIASES.map((b) => SIGMAS.map((sg) => renderTemplate([1, 1, 1, 1, 1], false, sg, b)));
// Perspective: module position -> fraction of the barcode's width, g(t) = t / (t + r (1 - t)).
const R_GRID = [0.7, 0.78, 0.86, 0.93, 1, 1.07, 1.16, 1.28, 1.42];

/**
 * Model-based EAN-13 read of one scan line between the outer edges of the first
 * and last bar (xa, xb, in samples). Digits sit at fixed module positions, so no
 * interior edge is needed: a gap that blur has merged away cannot shift the
 * digits after it. Perspective, blur and bar-width bias are estimated from the
 * three guard patterns; one bias is used for the whole line (a per-digit bias
 * would let a 1 pose as a 7). Returns the code text or null.
 */
function modelLine(p, n, xa0, xb0) {
  const segAtX = (xa, xb) => (r, u0, len) => {
    const count = (len + 2 * CTX) * K;
    const out = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      const u = u0 - CTX + (i + 0.5) / K;
      const t = u / 95;
      const g = t <= 0 || t >= 1 ? t : t / (t + r * (1 - t));
      const x = xa + (xb - xa) * g;
      const xi = Math.max(0, Math.min(n - 2, Math.floor(x)));
      const f = Math.max(0, Math.min(1, x - xi));
      out[i] = p[xi] * (1 - f) + p[xi + 1] * f;
    }
    return out;
  };
  const guardErr = (seg, r, bi, si) => fitErr(seg(r, 0, 3), GUARD3[bi][si]) + fitErr(seg(r, 45, 5), GUARD5[bi][si]) + fitErr(seg(r, 92, 3), GUARD3[bi][si]);

  // 0. refine the outer ends: blur smears the outermost thin bars, so the detected
  //    edges drift. Coarse grid (half-module steps, +-1 module), then refine
  //    around the best by quarter modules.
  const m0 = (xb0 - xa0) / 95;
  const endErr = (xa, xb) => {
    const seg = segAtX(xa, xb);
    const s0 = seg(1, 0, 3), s1 = seg(1, 45, 5), s2 = seg(1, 92, 3);
    let e = Infinity;
    for (let bi = 0; bi < BIASES.length; bi += 1) {
      for (let si = 0; si < SIGMAS.length; si += 1) {
        e = Math.min(e, fitErr(s0, GUARD3[bi][si]) + fitErr(s1, GUARD5[bi][si]) + fitErr(s2, GUARD3[bi][si]));
      }
    }
    return e;
  };
  const tried = new Map();
  const evalEnd = (da, db) => {
    const key = `${da},${db}`;
    if (!tried.has(key)) tried.set(key, { xa: xa0 + da * m0, xb: xb0 + db * m0, da, db, e: endErr(xa0 + da * m0, xb0 + db * m0) });
    return tried.get(key);
  };
  for (const da of [-1, -0.5, 0, 0.5, 1]) for (const db of [-1, -0.5, 0, 0.5, 1]) evalEnd(da, db);
  const coarse = [...tried.values()].sort((a, b) => a.e - b.e)[0];
  for (const da of [-0.25, 0, 0.25]) for (const db of [-0.25, 0, 0.25]) evalEnd(coarse.da + da, coarse.db + db);
  const ends = [...tried.values()].sort((a, b) => a.e - b.e);

  // 1. perspective, bias and blur from the guards, for the best two end placements
  const hyps = [];
  for (const end of ends.slice(0, 2)) {
    const segAt = segAtX(end.xa, end.xb);
    for (let bi = 0; bi < BIASES.length; bi += 1) {
      let best = { err: Infinity };
      for (const r of R_GRID) {
        for (let si = 0; si < SIGMAS.length; si += 1) {
          const e = guardErr(segAt, r, bi, si);
          if (e < best.err) best = { err: e, r, si };
        }
      }
      if (Number.isFinite(best.err) && best.err <= 2.0) hyps.push({ bi, ...best, segAt });
    }
  }
  hyps.sort((a, b) => a.err - b.err);
  // 2. digits by beam search, for the best three hypotheses overall
  const cands = [];
  for (const h of hyps.slice(0, 3)) for (const res of beamDigits(h.segAt, h)) cands.push(res);
  if (!cands.length) return null;
  cands.sort((a, b) => a.fit - b.fit);
  const rival = cands.find((c) => c.text !== cands[0].text);
  if (rival && rival.fit < cands[0].fit * 1.25) return null;
  return cands[0].text;
}

// --- beam search over digits, simulating each digit with its real neighbour --
const modsOf = (widths, startDark) => {
  const out = [];
  let dark = startDark;
  for (const w of widths) { for (let i = 0; i < w; i += 1) out.push(dark ? 1 : 0); dark = !dark; }
  return out;
};
const DIGIT_MODS = [L, G, L].map((t, set) => t.map((w) => modsOf(w, set === 2)));
const tmplCache = new Map();

/** Template for [known modules before] + digit + [known modules after], unknown beyond as grey. */
function contextTemplate(before, set, dg, after, si, bi) {
  const key = `${before.join('')}|${set}${dg}|${after.join('')}|${si}|${bi}`;
  let t = tmplCache.get(key);
  if (t) return t;
  const SUB = 4, PAD = 2, scale = K * SUB, bias = BIASES[bi];
  const mods = [...before, ...DIGIT_MODS[set][dg], ...after];
  const total = mods.length + 2 * PAD;
  const fine = new Float32Array(total * scale);
  for (let i = 0; i < PAD * scale; i += 1) { fine[i] = 0.5; fine[fine.length - 1 - i] = 0.5; }
  // dark runs, widened by the bias
  for (let i = 0; i < mods.length;) {
    if (!mods[i]) { i += 1; continue; }
    let j = i;
    while (j < mods.length && mods[j]) j += 1;
    const a = Math.max(0, (PAD + i - bias / 2) * scale), b = Math.min(fine.length, (PAD + j + bias / 2) * scale);
    for (let k = Math.floor(a); k < Math.ceil(b); k += 1) fine[k] = Math.max(fine[k], Math.max(0, Math.min(1, Math.min(k + 1, b) - Math.max(k, a))));
    i = j;
  }
  const bl = gaussBlur1(fine, SIGMAS[si] * scale);
  // keep 1 module of context each side around the 7 digit modules
  const from = PAD + before.length - 1, len = 9;
  t = new Float32Array(len * K);
  for (let i = 0; i < t.length; i += 1) {
    let acc = 0;
    for (let j = 0; j < SUB; j += 1) acc += bl[(from * K + i) * SUB + j];
    t[i] = acc / SUB;
  }
  if (tmplCache.size > 20000) tmplCache.clear();
  tmplCache.set(key, t);
  return t;
}

/**
 * Build every blur-model template ahead of time (about 2,400; a few hundred ms
 * in a worker) so the first real frames are not slowed down by rendering them.
 * The contexts are few: left digits are preceded by 01 or 11 and followed by 0 or 01;
 * right digits are preceded by 10 or 00 and followed by 1 or 10.
 */
export function warmUp() {
  for (let bi = 0; bi < BIASES.length; bi += 1) {
    for (let si = 0; si < SIGMAS.length; si += 1) {
      for (let dg = 0; dg < 10; dg += 1) {
        for (const before of [[0, 1], [1, 1]]) for (const after of [[0], [0, 1]]) {
          contextTemplate(before, 0, dg, after, si, bi);
          contextTemplate(before, 1, dg, after, si, bi);
        }
        for (const before of [[1, 0], [0, 0]]) for (const after of [[1], [1, 0]]) contextTemplate(before, 2, dg, after, si, bi);
      }
    }
  }
}

const BEAM = 5;
const MAX_DIGIT_MISFIT = 0.2; // average 1 - R^2 per digit
const MIN_LEAD = 1.02;        // best sequence must beat the runner-up by 2%
const MODEL_MAX_LINES = 24;   // blur-model attempts per frame
const MODEL_BUDGET_MS = 70;   // and time budget per frame (fail fast, the next frame may be sharper)
function beamDigits(segAt, h) {
  const START_TAIL = [0, 1];            // start guard 101 -> last two modules
  const MID_TAIL = [1, 0];              // middle guard 01010 -> last two modules
  let beam = [{ digits: [], parity: '', fit: 0, tail: START_TAIL }];
  for (let d = 0; d < 12; d += 1) {
    const left = d < 6;
    const seg = segAt(h.r, left ? 3 + 7 * d : 50 + 7 * (d - 6), 7);
    // known modules after this digit
    let after;
    if (left) after = d === 5 ? [0, 1] : [0];      // next L/G digit starts light; middle guard 0 1 ...
    else after = d === 11 ? [1, 0] : [1];          // next R digit starts dark; end guard 1 0 1
    const next = [];
    for (const st of beam) {
      const before = d === 6 ? MID_TAIL : st.tail;
      for (const set of left ? [0, 1] : [2]) {
        for (let dg = 0; dg < 10; dg += 1) {
          const e = fitErr(seg, contextTemplate(before, set, dg, after, h.si, h.bi));
          if (!Number.isFinite(e)) continue;
          const mods = DIGIT_MODS[set][dg];
          next.push({
            digits: [...st.digits, dg],
            parity: left ? st.parity + (set === 1 ? 'G' : 'L') : st.parity,
            fit: st.fit + e,
            tail: mods.slice(-2),
          });
        }
      }
    }
    next.sort((a, b) => a.fit - b.fit);
    beam = next.slice(0, BEAM);
    if (!beam.length) return [];
  }
  // Acceptance (measured on 119 synthetic model reads: correct reads had an average
  // digit misfit of 0.04-0.11 (p90) and led the next beam sequence by ~18%; all 13
  // wrong reads had misfit > 0.23 and led by < 0.5%):
  //   - only the beam's best sequence may be accepted,
  //   - its average digit misfit must be <= 0.2,
  //   - it must beat the next sequence by >= 2%,
  //   - and it must carry a valid check digit.
  const top = beam[0];
  const first = PARITY.indexOf(top.parity);
  if (first < 0) return [];
  const all = [first, ...top.digits];
  if (!checksumOk(all)) return [];
  if (top.fit / 12 > MAX_DIGIT_MISFIT) return [];
  if (beam[1] && beam[1].fit < top.fit * MIN_LEAD) return [];
  return [{ text: all.join(''), fit: top.fit + h.err }];
}

/**
 * Where an EAN could start and end on this line: a bar after a wide light gap,
 * and a bar followed by one, with a plausible number of elements in between
 * (59 nominal; blur merges some, noise adds a few).
 */
function modelCandidates(line) {
  const { widths, xs } = line;
  const out = [];
  const med = (from, to) => {
    const a = widths.slice(Math.max(1, from), Math.min(widths.length - 1, to)).sort((x, y) => x - y);
    return a.length ? a[a.length >> 1] : Infinity;
  };
  for (let s = 1; s < widths.length - 30; s += 2) {
    if (widths[s - 1] < 3 * med(s, s + 20)) continue;
    for (let e = s + 36; e < Math.min(widths.length - 1, s + 66); e += 2) {
      if (widths[e + 1] < 3 * med(e - 20, e)) continue;
      out.push({ xa: xs[s - 1], xb: xs[e], elements: e - s + 1 });
    }
  }
  return out;
}

function checksumOk(digits) {
  const n = digits.length;
  let s = 0;
  for (let i = 0; i < n - 1; i += 1) {
    // weight 3 on positions that are odd counting from the right (excluding the check digit)
    s += digits[i] * ((n - 1 - i) % 2 === 1 ? 3 : 1);
  }
  return (10 - (s % 10)) % 10 === digits[n - 1];
}

const MAX_DIGIT_ERR = 1.3;   // summed deviation per digit, in modules (wrong synthetic reads all had >= 1.35)
const GUARD_TOL = 0.55;      // guard bars within +-55% of one module

function guardOk(w, start, count, m) {
  for (let i = 0; i < count; i += 1) {
    const r = w[start + i] / m;
    if (r < 1 - GUARD_TOL || r > 1 + GUARD_TOL + 0.3) return false;
  }
  return true;
}

/**
 * Try to read an EAN-13 starting at element index i (a bar) of the width list.
 * widths alternate bar/space starting with a bar at even indexes of `w` as given.
 */
function tryEan13(w, i, line) {
  if (i + 59 > w.length) return null;
  let total = 0;
  for (let k = 0; k < 59; k += 1) total += w[i + k];
  const m = total / 95;
  // quiet zones: the spaces before and after should be clearly wider than a module
  const before = i > 0 ? w[i - 1] : 0, after = i + 59 < w.length ? w[i + 59] : 0;
  if (before < 2.5 * m || after < 2.5 * m) return null;
  if (!guardOk(w, i, 3, m) || !guardOk(w, i + 27, 5, m) || !guardOk(w, i + 56, 3, m)) return null;
  const digits = [];
  let parity = '', worst = 0;
  for (let d = 0; d < 6; d += 1) {
    const ww = w.slice(i + 3 + d * 4, i + 7 + d * 4);
    const a = bestDigit(ww, L), b = bestDigit(ww, G);
    const pick = a.err <= b.err ? a : b;
    parity += a.err <= b.err ? 'L' : 'G';
    digits.push(pick.digit);
    worst = Math.max(worst, pick.err);
  }
  for (let d = 0; d < 6; d += 1) {
    const ww = w.slice(i + 32 + d * 4, i + 36 + d * 4);
    const r = bestDigit(ww, L); // R-code has the same widths as L, starting with a bar
    digits.push(r.digit);
    worst = Math.max(worst, r.err);
  }
  const first = PARITY.indexOf(parity);
  if (worst <= MAX_DIGIT_ERR && first >= 0 && checksumOk([first, ...digits])) {
    return { text: [first, ...digits].join(''), format: 'ean_13', err: worst, m, method: 'edges', xa: line ? line.xs[i - 1] : null, xb: line ? line.xs[i + 58] : null };
  }
  return null;
}

function tryEan8(w, i) {
  if (i + 43 > w.length) return null;
  let total = 0;
  for (let k = 0; k < 43; k += 1) total += w[i + k];
  const m = total / 67;
  const before = i > 0 ? w[i - 1] : 0, after = i + 43 < w.length ? w[i + 43] : 0;
  if (before < 2.5 * m || after < 2.5 * m) return null;
  if (!guardOk(w, i, 3, m) || !guardOk(w, i + 19, 5, m) || !guardOk(w, i + 40, 3, m)) return null;
  const digits = [];
  let worst = 0;
  for (let d = 0; d < 4; d += 1) {
    const r = bestDigit(w.slice(i + 3 + d * 4, i + 7 + d * 4), L);
    digits.push(r.digit); worst = Math.max(worst, r.err);
  }
  for (let d = 0; d < 4; d += 1) {
    const r = bestDigit(w.slice(i + 24 + d * 4, i + 28 + d * 4), L);
    digits.push(r.digit); worst = Math.max(worst, r.err);
  }
  if (worst > MAX_DIGIT_ERR || !checksumOk(digits)) return null;
  return { text: digits.join(''), format: 'ean_8', err: worst, m };
}

/**
 * Edges along a brightness profile: local extrema of the smoothed gradient,
 * alternating in sign, refined to sub-pixel. Returns element widths starting
 * with the first bar (dark), plus the space before it.
 */
function profileToWidths(p, n) {
  // light smoothing
  const s = new Float32Array(n);
  for (let i = 1; i < n - 1; i += 1) s[i] = 0.25 * p[i - 1] + 0.5 * p[i] + 0.25 * p[i + 1];
  s[0] = p[0]; s[n - 1] = p[n - 1];
  const d = new Float32Array(n);
  let maxAbs = 0;
  for (let i = 1; i < n - 1; i += 1) {
    d[i] = (s[i + 1] - s[i - 1]) * 0.5;
    const a = Math.abs(d[i]);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs < 4) return null; // flat line
  const thr = maxAbs * 0.12;
  const edges = []; // {x, sign}
  for (let i = 2; i < n - 2; i += 1) {
    const v = d[i], a = Math.abs(v);
    if (a < thr) continue;
    if (a >= Math.abs(d[i - 1]) && a > Math.abs(d[i + 1])) {
      // parabolic sub-pixel refinement
      const y0 = Math.abs(d[i - 1]), y1 = a, y2 = Math.abs(d[i + 1]);
      const den = y0 - 2 * y1 + y2;
      const off = den !== 0 ? 0.5 * (y0 - y2) / den : 0;
      const sign = v < 0 ? -1 : 1; // -1: light->dark (bar starts)
      const last = edges[edges.length - 1];
      if (last && last.sign === sign) {
        if (a > last.a) { last.x = i + off; last.a = a; } // keep the stronger of two same-sign edges
      } else {
        edges.push({ x: i + off, sign, a });
      }
    }
  }
  // drop leading rising edge so the list starts at a bar
  let k = 0;
  while (k < edges.length && edges[k].sign !== -1) k += 1;
  if (edges.length - k < 44) return null;
  const widths = [];
  const xs = [];
  widths.push(edges[k].x); // "space" before the first bar: distance from line start (quiet zone)
  xs.push(edges[k].x);
  for (let j = k + 1; j < edges.length; j += 1) {
    widths.push(edges[j].x - edges[j - 1].x);
    xs.push(edges[j].x);
  }
  widths.push(n - edges[edges.length - 1].x); // trailing
  // element e (e >= 1) spans xs[e-1] .. xs[e]
  return { widths, xs, profile: p, n };
}

/** Bilinear sample of luminance along a line. */
function sampleLine(lum, w, h, x0, y0, dx, dy, n, out) {
  for (let i = 0; i < n; i += 1) {
    const x = x0 + dx * i, y = y0 + dy * i;
    const xi = x | 0, yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= w - 1 || yi >= h - 1) { out[i] = out[i - 1] || 0; continue; }
    const fx = x - xi, fy = y - yi, o = yi * w + xi;
    out[i] = (lum[o] * (1 - fx) + lum[o + 1] * fx) * (1 - fy) + (lum[o + w] * (1 - fx) + lum[o + w + 1] * fx) * fy;
  }
}

function readWidths(line, wantEan13, wantEan8) {
  const { widths } = line;
  // widths[0] is the quiet space before the first bar; bars sit at odd indexes.
  const found = [];
  for (let i = 1; i < widths.length; i += 2) {
    if (wantEan13) {
      const r = tryEan13(widths, i, line);
      if (r) { found.push(r); i += 58; continue; }
    }
    if (wantEan8) {
      const r = tryEan8(widths, i);
      if (r) { found.push(r); i += 42; }
    }
  }
  return found;
}

/**
 * Outline of the whole barcode from the agreeing scan lines: each line knows where
 * the barcode starts and ends along it. Project those end points onto the reading
 * direction and its perpendicular and take the extent; the bars run perpendicular
 * to the scan lines, so extend that way to cover their full height.
 */
function barcodeOutline(spans, lum, w, h) {
  if (!spans.length) return null;
  // Bar direction: the start points of the agreeing lines lie on the barcode's left
  // edge and the end points on its right edge, so the line through them runs along
  // the bars. Scan lines can cross the code diagonally, so their own direction is
  // not the barcode's axis. With a single line (or lines too close together),
  // assume the bars are perpendicular to the scan line.
  let bx = -spans[0].dy, by = spans[0].dx;
  if (spans.length >= 2) {
    let best = 0;
    for (let i = 0; i < spans.length; i += 1) {
      for (let j = i + 1; j < spans.length; j += 1) {
        // start-to-start and end-to-end both run along the bars; when the lines
        // cross in an X they point opposite ways, so align them before adding
        const sx = spans[j].ax - spans[i].ax, sy = spans[j].ay - spans[i].ay;
        let tx = spans[j].bx - spans[i].bx, ty = spans[j].by - spans[i].by;
        if (sx * tx + sy * ty < 0) { tx = -tx; ty = -ty; }
        const ex = sx + tx, ey = sy + ty;
        const d = Math.hypot(ex, ey);
        if (d > best) { best = d; bx = ex / d; by = ey / d; }
      }
    }
    if (best < 20) { bx = -spans[0].dy; by = spans[0].dx; }
  }
  // Barcode axis: perpendicular to the bars, pointing from start to end.
  let ax = by, ay = -bx;
  if ((spans[0].bx - spans[0].ax) * ax + (spans[0].by - spans[0].ay) * ay < 0) { ax = -ax; ay = -ay; }
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const sp of spans) {
    u0 = Math.min(u0, sp.ax * ax + sp.ay * ay); u1 = Math.max(u1, sp.bx * ax + sp.by * ay);
    for (const [x, y] of [[sp.ax, sp.ay], [sp.bx, sp.by]]) { const v = x * bx + y * by; v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  }
  const len = u1 - u0;
  if (!(len > 0)) return null;
  const pt = (u, v) => ({ x: u * ax + v * bx, y: u * ay + v * by });
  // Bar height: walk outward along the bars from the agreeing lines and stop where
  // a line across the code no longer crosses many edges (top and bottom of the bars).
  if (lum) {
    const edgesAt = (v) => {
      const n = Math.max(40, Math.round(len * 0.8));
      let prev = null, count = 0, maxD = 0;
      const vals = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        const p = pt(u0 + len * 0.1 + (len * 0.8 * i) / n, v);
        const xi = Math.round(p.x), yi = Math.round(p.y);
        vals[i] = xi >= 0 && yi >= 0 && xi < w && yi < h ? lum[yi * w + xi] : (i ? vals[i - 1] : 0);
      }
      for (let i = 1; i < n; i += 1) maxD = Math.max(maxD, Math.abs(vals[i] - vals[i - 1]));
      const thr = Math.max(6, maxD * 0.3);
      for (let i = 1; i < n; i += 1) {
        const d = vals[i] - vals[i - 1];
        if (Math.abs(d) < thr) continue;
        const sgn = d > 0;
        if (prev !== null && sgn !== prev) count += 1;
        prev = sgn;
      }
      return count;
    };
    const mid = (v0 + v1) / 2, ref = edgesAt(mid);
    if (ref >= 10) {
      const step = Math.max(1, len * 0.02);
      let top = v0, bottom = v1;
      while (top - mid > -len && edgesAt(top - step) >= ref * 0.4) top -= step;
      while (bottom - mid < len && edgesAt(bottom + step) >= ref * 0.4) bottom += step;
      return [pt(u0, top), pt(u1, top), pt(u1, bottom), pt(u0, bottom)];
    }
  }
  // fallback: EAN bars are often about 0.7x the symbol width tall
  const mid = (v0 + v1) / 2, half = Math.max((v1 - v0) / 2, len * 0.35);
  return [pt(u0, mid - half), pt(u1, mid - half), pt(u1, mid + half), pt(u0, mid + half)];
}

/**
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img RGBA
 * @param {string[]} formats requested formats ([] = all)
 * @param {{angle?: number}} [hint] scan angle in degrees where the localizer found a code
 * @returns {{rawValue: string, format: string, lines: number, cornerPoints: {x,y}[]}[]}
 */
let lastAngle = 0; // scan angle of the last successful read (per worker)

export function decodeEanGrey(img, formats = [], { angle: hintAngle } = {}) {
  const want = (f) => !formats.length || formats.includes(f);
  const wantEan13 = want('ean_13') || want('upc_a');
  const wantEan8 = want('ean_8');
  if (!wantEan13 && !wantEan8) return [];

  const { data, width: w, height: h } = img;
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i += 1, p += 4) lum[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) / 256;

  const votes = new Map(); // text -> {count, format, pts: []}
  const maxLen = Math.ceil(Math.hypot(w, h));
  const prof = new Float32Array(maxLen);
  const rev = new Float32Array(maxLen);
  const cx = w / 2, cy = h / 2;
  const LINES = 13;
  const modelQueue = [];
  const verified = new Map();   // edge-read value -> model checks passed
  const bothAgree = new Set();  // values the edge reader and the blur model both read on one line
  const contradicted = new Set(); // edge-read values the model disagreed with

  // Blur model on lines the edge reader could not read, within a time budget,
  // stopping as soon as two lines agree on a value. Called early with the lines
  // near the last good angle, and again after all angles.
  // Stop at 3 agreeing lines (not 2): a third line from another angle turns this
  // frame into strong evidence (see `strong` below), which halves confirmation time.
  const agreed = () => [...votes.values()].some((v) => v.count >= 3);
  let modelStart = 0; // the budget covers model time only, not the edge scan before it
  let tried = 0;
  const runModel = () => {
    if (agreed() || !modelQueue.length) return;
    if (!modelStart) modelStart = Date.now();
    modelQueue.sort((a, b) => a.pri - b.pri);
    while (modelQueue.length) {
      if (tried >= MODEL_MAX_LINES || Date.now() - modelStart > MODEL_BUDGET_MS) return;
      const q = modelQueue.shift();
      tried += 1;
      const text = modelLine(q.line.profile, q.n, q.c.xa, q.c.xb);
      if (!text) continue;
      const v = votes.get(text) ?? { count: 0, format: 'ean_13', pts: [], spans: [], methods: new Set(), angle: q.deg, angles: new Set() };
      v.methods.add('model');
      v.angles.add(q.deg);
      v.count += 1;
      v.pts.push({ x: q.sx + q.dx * q.n / 2, y: q.sy + q.dy * q.n / 2 });
      const a = q.dir ? q.n - 1 - q.c.xa : q.c.xa, b = q.dir ? q.n - 1 - q.c.xb : q.c.xb;
      v.spans.push({ ax: q.sx + q.dx * a, ay: q.sy + q.dy * a, bx: q.sx + q.dx * b, by: q.sy + q.dy * b, dx: q.dx, dy: q.dy });
      votes.set(text, v);
      if (agreed()) return;
    }
  };

  // Start at the localizer's angle, else the angle that worked last time (or
  // horizontal), and fan out from it; stop once one value has 4 agreeing lines
  // and nothing competes with it.
  const start = hintAngle != null ? Math.round(hintAngle) : lastAngle;
  const angles = [];
  for (let k = 0; k < 18; k += 1) {
    const step = Math.ceil(k / 2) * 10 * (k % 2 ? 1 : -1);
    angles.push(((start + step) % 180 + 180) % 180);
  }
  const settled = () => {
    const counts = [...votes.values()].map((v) => v.count).sort((x, y) => y - x);
    return counts[0] >= 4 && (counts[1] ?? 0) === 0;
  };
  for (const [ai, deg] of angles.entries()) {
    if (settled()) break;
    if (ai === 5) { runModel(); if (agreed()) break; }
    const a = (deg * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a);
    // the line through the centre spans the image; offset it perpendicular
    const half = Math.abs(w * dy) / 2 + Math.abs(h * dx) / 2; // perpendicular half-extent
    for (let li = 0; li < LINES; li += 1) {
      const off = ((li + 0.5) / LINES - 0.5) * 2 * half * 0.9;
      const px = cx - dy * off, py = cy + dx * off;
      // clip the infinite line to the image
      let t0 = -Infinity, t1 = Infinity;
      for (const [p0, dd, lim] of [[px, dx, w - 1], [py, dy, h - 1]]) {
        if (Math.abs(dd) < 1e-9) { if (p0 < 0 || p0 > lim) { t0 = 1; t1 = 0; } continue; }
        let ta = (0 - p0) / dd, tb = (lim - p0) / dd;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      }
      const n = Math.floor(t1 - t0);
      if (n < 120) continue;
      const sx = px + dx * t0, sy = py + dy * t0;
      sampleLine(lum, w, h, sx, sy, dx, dy, n, prof);
      for (let dir = 0; dir < 2; dir += 1) {
        let src = prof;
        if (dir === 1) { for (let i = 0; i < n; i += 1) rev[i] = prof[n - 1 - i]; src = rev; }
        const line = profileToWidths(Float32Array.from(src.subarray(0, n)), n);
        if (!line) continue;
        const read = readWidths(line, wantEan13, wantEan8);
        if (!read.length && wantEan13) {
          for (const c of modelCandidates(line)) {
            // most EAN-like first: 59 elements nominal, a few merged by blur
            modelQueue.push({ line, c, sx, sy, dx, dy, n, dir, deg, pri: Math.abs(c.elements - 57) + Math.abs(off) / half });
          }
        }
        for (const r of read) {
          // Cross-check edge reads with the blur model on the same span: the two
          // fail in different ways, so a contradiction means one of them is wrong.
          if (r.method === 'edges' && r.xa != null && (verified.get(r.text) ?? 0) < 2) {
            const mt = modelLine(line.profile, line.n, r.xa, r.xb);
            if (mt && mt !== r.text) { contradicted.add(r.text); continue; }
            if (mt === r.text) bothAgree.add(r.text); // two independent methods, same value
            verified.set(r.text, (verified.get(r.text) ?? 0) + 1);
          }
          const v = votes.get(r.text) ?? { count: 0, format: r.format, pts: [], spans: [], methods: new Set(), angle: deg, angles: new Set() };
          v.methods.add(r.method || 'edges');
          v.angles.add(deg);
          v.count += 1;
          // approximate location: the scan line's midpoint
          const mid = n / 2;
          v.pts.push({ x: sx + dx * mid, y: sy + dy * mid });
          if (r.xa != null) {
            // on the reversed pass, positions count from the other end of the line
            const a = dir ? n - 1 - r.xa : r.xa, b = dir ? n - 1 - r.xb : r.xb;
            v.spans.push({ ax: sx + dx * a, ay: sy + dy * a, bx: sx + dx * b, by: sy + dy * b, dx, dy });
          }
          votes.set(r.text, v);
        }
      }
    }
  }

  runModel();

  const out = [];
  for (const [text, v] of votes) {
    if (v.count < 2) continue; // at least two scan lines must agree
    if (contradicted.has(text)) continue; // the blur model read something else on one of its lines
    const xs = v.pts.map((p) => p.x), ys = v.pts.map((p) => p.y);
    const x0 = Math.min(...xs) - 20, x1 = Math.max(...xs) + 20, y0 = Math.min(...ys) - 20, y1 = Math.max(...ys) + 20;
    const outline = barcodeOutline(v.spans, lum, w, h);
    let format = v.format, value = text;
    if (format === 'ean_13' && !want('ean_13') && text.startsWith('0')) { format = 'upc_a'; value = text.slice(1); }
    if (format === 'ean_13' && !want('ean_13') && !text.startsWith('0')) continue;
    out.push({
      rawValue: value,
      format,
      lines: v.count,
      method: [...v.methods].join('+'),
      // edge reader and blur model independently agree (same line, or different lines)
      crossChecked: bothAgree.has(text) || (v.methods.has('edges') && v.methods.has('model')),
      // strong single-frame evidence: two methods agree, or >= 3 lines from >= 2 angles
      strong: bothAgree.has(text) || (v.methods.has('edges') && v.methods.has('model')) || (v.count >= 3 && v.angles.size >= 2),
      cornerPoints: outline ?? [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
    });
  }
  // Several values in one frame: either several barcodes, or one barcode read two ways.
  // Report only values with at least half the support of the best one; if the runner-up
  // has more than half, both are suspect, so report nothing for this frame.
  out.sort((a, b) => b.lines - a.lines);
  if (out.length > 1 && out[1].lines * 2 > out[0].lines) return [];
  if (out.length) lastAngle = votes.get(out[0].format === 'upc_a' ? '0' + out[0].rawValue : out[0].rawValue)?.angle ?? lastAngle;
  return out.slice(0, 1);
}
