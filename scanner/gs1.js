/**
 * Minimal GS1 element-string parser.
 *
 * Handles the forms scanners actually return:
 *   - raw with FNC1 as ASCII GS (\x1d), optionally prefixed by a symbology
 *     identifier such as "]d2" (DataMatrix), "]C1" (Code 128), "]Q3" (QR), "]e0" (DataBar)
 *   - human-readable with parentheses: "(01)09506000134352(17)261231(10)AB12"
 *
 * Covers the AIs used on retail and healthcare packaging. Returns null when the
 * string isn't a complete, parseable GS1 element string.
 */

const GS = '\u001d';

// [title, fixedLength | null (variable), maxLength, kind]
const AI = {
  '00': ['SSCC', 18, 18, 'n'],
  '01': ['GTIN', 14, 14, 'gtin'],
  '02': ['Content GTIN', 14, 14, 'gtin'],
  '10': ['Batch/Lot', null, 20, 'x'],
  '11': ['Production date', 6, 6, 'date'],
  '12': ['Due date', 6, 6, 'date'],
  '13': ['Packaging date', 6, 6, 'date'],
  '15': ['Best before', 6, 6, 'date'],
  '16': ['Sell by', 6, 6, 'date'],
  '17': ['Expiry', 6, 6, 'date'],
  '20': ['Variant', 2, 2, 'n'],
  '21': ['Serial', null, 20, 'x'],
  '22': ['Consumer product variant', null, 20, 'x'],
  '235': ['Third-party serial (TPX)', null, 28, 'x'],
  '240': ['Additional product ID', null, 30, 'x'],
  '241': ['Customer part no.', null, 30, 'x'],
  '242': ['Made-to-order variation', null, 6, 'n'],
  '30': ['Count', null, 8, 'n'],
  '37': ['Count of trade items', null, 8, 'n'],
  '400': ['Customer PO', null, 30, 'x'],
  '410': ['Ship to GLN', 13, 13, 'n'],
  '414': ['Location GLN', 13, 13, 'n'],
  '422': ['Country of origin', 3, 3, 'n'],
  '7003': ['Expiry date & time', 10, 10, 'n'],
  '710': ['NHRN Germany (PZN)', null, 20, 'x'],
  '711': ['NHRN France (CIP)', null, 20, 'x'],
  '712': ['NHRN Spain (CN)', null, 20, 'x'],
  '713': ['NHRN Brazil (DRN)', null, 20, 'x'],
  '714': ['NHRN Portugal (AIM)', null, 20, 'x'],
  '715': ['NHRN USA (NDC)', null, 20, 'x'],
  '716': ['NHRN Italy (AIC)', null, 20, 'x'],
};

// Measures 310n–369n: 4-digit AI, last digit = implied decimal places, 6-digit value.
function lookup(digits) {
  for (const len of [2, 3, 4]) {
    const key = digits.slice(0, len);
    if (AI[key]) return { ai: key, def: AI[key] };
  }
  const four = digits.slice(0, 4);
  if (/^3[1-6]\d\d$/.test(four)) {
    return { ai: four, def: [`Measure ${four.slice(0, 3)}`, 6, 6, 'measure'] };
  }
  return null;
}

/** GS1 mod-10 check digit validation (GTIN-8/12/13/14, SSCC, GLN). */
export function validCheckDigit(num) {
  if (!/^\d+$/.test(num)) return false;
  const digits = num.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

/** YYMMDD -> ISO date. DD = 00 means last day of the month. Century per GS1 sliding window. */
function gs1Date(yymmdd) {
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  let dd = Number(yymmdd.slice(4, 6));
  if (mm < 1 || mm > 12 || dd > 31) return null;
  const nowYY = new Date().getFullYear() % 100;
  const century = Math.floor(new Date().getFullYear() / 100) * 100;
  const diff = yy - nowYY;
  const year = diff >= 51 ? century - 100 + yy : diff <= -50 ? century + 100 + yy : century + yy;
  if (dd === 0) dd = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function interpret(ai, def, value) {
  const [title, , , kind] = def;
  const el = { ai, title, value };
  if (kind === 'date') el.date = gs1Date(value);
  if (kind === 'gtin') el.valid = validCheckDigit(value);
  if (kind === 'measure') el.number = Number(value) / 10 ** Number(ai[3]);
  return el;
}

/** Turn "(01)…(17)…" into a GS-separated element string. */
function fromParenthesized(s) {
  const parts = [...s.matchAll(/\((\d{2,4})\)([^(]*)/g)];
  if (!parts.length || parts.map((m) => m[0]).join('') !== s) return null;
  return parts.map((m) => m[1] + m[2]).join(GS);
}

/**
 * @param {string} raw scanner output
 * @returns {{elements: {ai:string,title:string,value:string,date?:string,valid?:boolean,number?:number}[],
 *            byAi: Record<string,string>} | null}
 */
export function parseGS1(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let s = raw.trim();
  s = s.replace(/^\][A-Za-z]\d/, ''); // symbology identifier
  if (s.startsWith('(')) {
    s = fromParenthesized(s);
    if (s === null) return null;
  }
  s = s.replace(/^\u001d+/, ''); // leading FNC1
  if (!/^\d{2}/.test(s)) return null;

  const elements = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === GS) { i += 1; continue; }
    const hit = lookup(s.slice(i, i + 4));
    if (!hit) return null;
    const { ai, def } = hit;
    const [, fixed, max, kind] = def;
    i += ai.length;
    let value;
    if (fixed) {
      value = s.slice(i, i + fixed);
      if (value.length !== fixed) return null;
      i += fixed;
    } else {
      const end = s.indexOf(GS, i);
      value = s.slice(i, end === -1 ? s.length : end);
      if (!value.length || value.length > max) return null;
      i += value.length;
    }
    if ((kind === 'n' || kind === 'gtin' || kind === 'date' || kind === 'measure') && !/^\d+$/.test(value)) return null;
    elements.push(interpret(ai, def, value));
  }
  if (!elements.length) return null;
  // A bare 13/14-digit number would "parse" as nothing useful; require GTIN/SSCC or 2+ elements.
  if (elements.length === 1 && !['00', '01', '02'].includes(elements[0].ai)) return null;
  return { elements, byAi: Object.fromEntries(elements.map((e) => [e.ai, e.value])) };
}
