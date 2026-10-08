/* VectorForge tracer
 * Pipeline: raster → classify (ink threshold / color quantize / gray levels) → connected components
 * → crack-following contours → smoothing + corner detection → cubic Bézier fitting → compact path data.
 * Stacked layering is used for fills (each boundary is traced once, no holes, no seams), and ink
 * line-art is emitted as Potrace-style black outlines. There is no region cap in any mode. */

export type VectorRegion = {
  id: string;
  name: string;
  kind: 'path';
  d: string;
  fill: string;
  fillRule?: 'evenodd';
  stroke?: string;
  strokeWidth?: number;
  strokeLinecap?: 'round';
  strokeLinejoin?: 'round';
  x: number;
  y: number;
  opacity: number;
};
export type TraceMode = 'stroke' | 'stroke-fill' | 'grayscale' | 'silhouette' | 'max';
export type TraceOptions = {
  tolerance?: number;
  colorCount?: number;
  lineTolerance?: number;
  pathSimplification?: number;
  curveSmoothness?: number;
  cornerThreshold?: number;
  minArea?: number;
  noiseReduction?: number;
  maxTraceSize?: number;
  maxRegions?: number;
  onProgress?: (progress: number) => void;
};
export type TraceResult = { regions: VectorRegion[]; width: number; height: number; truncated: boolean };

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/* ───────────────────────── raster preparation ───────────────────────── */

type Raster = { data: Uint8ClampedArray; w: number; h: number; nw: number; nh: number; transparent: boolean };

function rasterize(image: HTMLImageElement | ImageBitmap, longSide: number, minSide: number): Raster {
  const nw = 'naturalWidth' in image ? image.naturalWidth : image.width;
  const nh = 'naturalHeight' in image ? image.naturalHeight : image.height;
  const longest = Math.max(nw, nh);
  let target = Math.min(longest, longSide);
  if (longest < minSide) target = Math.min(minSide, longest * 4);
  const scale = target / longest;
  const w = Math.max(1, Math.round(nw * scale));
  const h = Math.max(1, Math.round(nh * scale));
  const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Canvas is unavailable in this browser.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let transparent = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) { transparent = true; break; }
  return { data, w, h, nw, nh, transparent };
}

/* ───────────────────────── classification ───────────────────────── */

const SRGB = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; SRGB[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
const labF = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
function toLab(r: number, g: number, b: number, out: Float32Array, o: number) {
  const lr = SRGB[r], lg = SRGB[g], lb = SRGB[b];
  const fx = labF((0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047);
  const fy = labF(0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb);
  const fz = labF((0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883);
  out[o] = 116 * fy - 16; out[o + 1] = 500 * (fx - fy); out[o + 2] = 200 * (fy - fz);
}

function luminance(r: Raster): Uint8Array {
  const { data, w, h } = r;
  const lum = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    const a = data[p + 3] / 255;
    const y = (data[p] * 0.2126 + data[p + 1] * 0.7152 + data[p + 2] * 0.0722) * a + 255 * (1 - a);
    lum[i] = y > 255 ? 255 : y;
  }
  return lum;
}

/** Ink = pixels clearly darker than their neighbourhood (or very dark): the look of a Potrace line drawing. */
function inkClasses(r: Raster, offset: number, darkFloor: number): Int16Array {
  const { data, w, h } = r;
  const lum = luminance(r);
  const W1 = w + 1;
  const sum = new Int32Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += lum[y * w + x]; sum[(y + 1) * W1 + x + 1] = sum[y * W1 + x + 1] + row; }
  }
  const R = Math.max(6, Math.round(Math.max(w, h) * 0.0125));
  const cls = new Int16Array(w * h).fill(-1);
  // cut-out images: the silhouette edge itself is a line (opaque pixels within 2px of transparency)
  let edge: Uint8Array | null = null;
  if (r.transparent) {
    const solid = new Uint8Array(w * h);
    for (let i = 0; i < solid.length; i++) solid[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
    let band = solid;
    for (let pass = 0; pass < 2; pass++) {
      const next = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        next[i] = band[i] && x > 0 && x < w - 1 && y > 0 && y < h - 1 && band[i - 1] && band[i + 1] && band[i - w] && band[i + w] ? 1 : 0;
      }
      band = next;
    }
    edge = new Uint8Array(w * h);
    for (let i = 0; i < edge.length; i++) edge[i] = solid[i] && !band[i] ? 1 : 0;
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - R), y1 = Math.min(h, y + R + 1);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (data[i * 4 + 3] < 128) continue;
      const x0 = Math.max(0, x - R), x1 = Math.min(w, x + R + 1);
      const mean = (sum[y1 * W1 + x1] - sum[y0 * W1 + x1] - sum[y1 * W1 + x0] + sum[y0 * W1 + x0]) / ((x1 - x0) * (y1 - y0));
      if (lum[i] < mean - offset || lum[i] < darkFloor || (edge !== null && edge[i] === 1)) cls[i] = 0;
    }
  }
  return cls;
}

type Quantized = { cls: Int16Array; palette: number[] };

/** Median-cut + k-means in Lab on a 5-bit histogram; pixels are assigned through a lazy 6-bit lookup. */
function quantize(r: Raster, k: number): Quantized {
  const { data, w, h } = r;
  const N = w * h;
  const cnt = new Uint32Array(32768), sr = new Uint32Array(32768), sg = new Uint32Array(32768), sb = new Uint32Array(32768);
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    if (data[p + 3] < 128) continue;
    const key = ((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3);
    cnt[key]++; sr[key] += data[p]; sg[key] += data[p + 1]; sb[key] += data[p + 2];
  }
  const ids: number[] = [];
  for (let key = 0; key < 32768; key++) if (cnt[key]) ids.push(key);
  const nb = ids.length;
  const cls = new Int16Array(N).fill(-1);
  if (nb === 0) return { cls, palette: [] };
  const lab = new Float32Array(nb * 3);
  const wgt = new Float64Array(nb);
  for (let j = 0; j < nb; j++) {
    const key = ids[j], c = cnt[key];
    wgt[j] = c;
    toLab(Math.round(sr[key] / c), Math.round(sg[key] / c), Math.round(sb[key] / c), lab, j * 3);
  }
  k = Math.max(1, Math.min(k, nb));

  const order = new Uint32Array(nb);
  for (let j = 0; j < nb; j++) order[j] = j;
  type Box = { lo: number; hi: number; sse: number; axis: number };
  const stats = (lo: number, hi: number): Box => {
    let tw = 0; const m = [0, 0, 0], v = [0, 0, 0];
    for (let t = lo; t < hi; t++) { const j = order[t]; tw += wgt[j]; for (let a = 0; a < 3; a++) m[a] += wgt[j] * lab[j * 3 + a]; }
    for (let a = 0; a < 3; a++) m[a] /= tw;
    for (let t = lo; t < hi; t++) { const j = order[t]; for (let a = 0; a < 3; a++) { const d = lab[j * 3 + a] - m[a]; v[a] += wgt[j] * d * d; } }
    const axis = v[0] >= v[1] && v[0] >= v[2] ? 0 : v[1] >= v[2] ? 1 : 2;
    return { lo, hi, sse: v[0] + v[1] + v[2], axis };
  };
  const boxes: Box[] = [stats(0, nb)];
  while (boxes.length < k) {
    let best = -1, bestSse = 0;
    for (let b = 0; b < boxes.length; b++) if (boxes[b].hi - boxes[b].lo >= 2 && boxes[b].sse > bestSse) { best = b; bestSse = boxes[b].sse; }
    if (best < 0) break;
    const { lo, hi, axis } = boxes[best];
    order.subarray(lo, hi).sort((a, b) => lab[a * 3 + axis] - lab[b * 3 + axis]);
    let total = 0;
    for (let t = lo; t < hi; t++) total += wgt[order[t]];
    let acc = 0, mid = lo + 1;
    for (let t = lo; t < hi - 1; t++) { acc += wgt[order[t]]; mid = t + 1; if (acc >= total / 2) break; }
    boxes.splice(best, 1, stats(lo, mid), stats(mid, hi));
  }
  const kk = boxes.length;
  const centers = new Float64Array(kk * 3);
  boxes.forEach((box, b) => {
    let tw = 0;
    for (let t = box.lo; t < box.hi; t++) { const j = order[t]; tw += wgt[j]; for (let a = 0; a < 3; a++) centers[b * 3 + a] += wgt[j] * lab[j * 3 + a]; }
    for (let a = 0; a < 3; a++) centers[b * 3 + a] /= tw;
  });
  const assign = new Int16Array(nb);
  for (let it = 0; it < 5; it++) {
    const acc = new Float64Array(kk * 3), aw = new Float64Array(kk);
    for (let j = 0; j < nb; j++) {
      const L = lab[j * 3], A = lab[j * 3 + 1], B = lab[j * 3 + 2];
      let bi = 0, bd = Infinity;
      for (let c = 0; c < kk; c++) {
        const dL = L - centers[c * 3], dA = A - centers[c * 3 + 1], dB = B - centers[c * 3 + 2];
        const d = dL * dL + dA * dA + dB * dB;
        if (d < bd) { bd = d; bi = c; }
      }
      assign[j] = bi; aw[bi] += wgt[j];
      acc[bi * 3] += wgt[j] * L; acc[bi * 3 + 1] += wgt[j] * A; acc[bi * 3 + 2] += wgt[j] * B;
    }
    for (let c = 0; c < kk; c++) if (aw[c] > 0) for (let a = 0; a < 3; a++) centers[c * 3 + a] = acc[c * 3 + a] / aw[c];
  }
  const pr = new Float64Array(kk), pg = new Float64Array(kk), pb = new Float64Array(kk), pw = new Float64Array(kk);
  for (let j = 0; j < nb; j++) { const c = assign[j], key = ids[j]; pr[c] += sr[key]; pg[c] += sg[key]; pb[c] += sb[key]; pw[c] += cnt[key]; }
  const palette: number[] = [];
  const remap = new Int16Array(kk).fill(-1);
  const plab = new Float32Array(kk * 3);
  for (let c = 0; c < kk; c++) {
    if (pw[c] === 0) continue;
    const R = Math.round(pr[c] / pw[c]), G = Math.round(pg[c] / pw[c]), B = Math.round(pb[c] / pw[c]);
    remap[c] = palette.length;
    toLab(R, G, B, plab, palette.length * 3);
    palette.push((R << 16) | (G << 8) | B);
  }
  const np = palette.length;
  const lut = new Int16Array(262144).fill(-2);
  const tmp = new Float32Array(3);
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    if (data[p + 3] < 128) continue;
    const key = ((data[p] >> 2) << 12) | ((data[p + 1] >> 2) << 6) | (data[p + 2] >> 2);
    let v = lut[key];
    if (v === -2) {
      toLab(data[p], data[p + 1], data[p + 2], tmp, 0);
      let bd = Infinity; v = 0;
      for (let c = 0; c < np; c++) {
        const dL = tmp[0] - plab[c * 3], dA = tmp[1] - plab[c * 3 + 1], dB = tmp[2] - plab[c * 3 + 2];
        const d = dL * dL + dA * dA + dB * dB;
        if (d < bd) { bd = d; v = c; }
      }
      lut[key] = v;
    }
    cls[i] = v;
  }
  return { cls, palette };
}

/* ───────────────────────── components & contours ───────────────────────── */

type Components = { lab: Int32Array; n: number; areas: Int32Array; colors: Int16Array; firsts: Int32Array };

function labelComponents(cls: Int16Array, w: number, h: number): Components {
  const N = w * h;
  const lab = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  const areas: number[] = [], colors: number[] = [], firsts: number[] = [];
  let n = 0;
  for (let s = 0; s < N; s++) {
    const c = cls[s];
    if (c < 0 || lab[s] >= 0) continue;
    const id = n++;
    lab[s] = id;
    let head = 0, tail = 0;
    queue[tail++] = s;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w;
      let q: number;
      if (x > 0) { q = p - 1; if (lab[q] < 0 && cls[q] === c) { lab[q] = id; queue[tail++] = q; } }
      if (x < w - 1) { q = p + 1; if (lab[q] < 0 && cls[q] === c) { lab[q] = id; queue[tail++] = q; } }
      if (p >= w) { q = p - w; if (lab[q] < 0 && cls[q] === c) { lab[q] = id; queue[tail++] = q; } }
      if (p < N - w) { q = p + w; if (lab[q] < 0 && cls[q] === c) { lab[q] = id; queue[tail++] = q; } }
    }
    areas.push(tail); colors.push(c); firsts.push(s);
  }
  return { lab, n, areas: Int32Array.from(areas), colors: Int16Array.from(colors), firsts: Int32Array.from(firsts) };
}

type Loop = { pts: Int32Array; area: number; comp: number };
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/** Crack-following boundary tracer. Inside stays on the right, so outer loops are positive and holes negative. */
function traceComponents(lab: Int32Array, w: number, h: number, keep: Uint8Array, minHole: number): Loop[] {
  const N = w * h;
  const visited = new Uint8Array(N);
  const loops: Loop[] = [];
  const buf: number[] = [];
  const inside = (x: number, y: number, id: number) => x >= 0 && x < w && y >= 0 && y < h && lab[y * w + x] === id;
  for (let i = 0; i < N; i++) {
    const id = lab[i];
    if (id < 0 || !keep[id]) continue;
    const px = i % w, py = (i - px) / w;
    for (let d0 = 0; d0 < 4; d0++) {
      const nb = d0 === 0 ? (py > 0 ? lab[i - w] : -2) : d0 === 1 ? (px < w - 1 ? lab[i + 1] : -2) : d0 === 2 ? (py < h - 1 ? lab[i + w] : -2) : (px > 0 ? lab[i - 1] : -2);
      if (nb === id || (visited[i] & (1 << d0))) continue;
      const sx = d0 === 0 ? px : d0 === 1 ? px + 1 : d0 === 2 ? px + 1 : px;
      const sy = d0 === 0 ? py : d0 === 1 ? py : d0 === 2 ? py + 1 : py + 1;
      let vx = sx, vy = sy, d = d0, area2 = 0;
      buf.length = 0;
      for (let guard = 0; guard < 4 * N; guard++) {
        const ox = d === 0 ? vx : d === 1 ? vx - 1 : d === 2 ? vx - 1 : vx;
        const oy = d === 0 ? vy : d === 1 ? vy : d === 2 ? vy - 1 : vy - 1;
        visited[oy * w + ox] |= 1 << d;
        const nx = vx + DX[d], ny = vy + DY[d];
        area2 += vx * ny - nx * vy;
        let rx: number, ry: number, lx: number, ly: number;
        if (d === 0) { rx = nx; ry = ny; lx = nx; ly = ny - 1; }
        else if (d === 1) { rx = nx - 1; ry = ny; lx = nx; ly = ny; }
        else if (d === 2) { rx = nx - 1; ry = ny - 1; lx = nx - 1; ly = ny; }
        else { rx = nx; ry = ny - 1; lx = nx - 1; ly = ny - 1; }
        const nd = !inside(rx, ry, id) ? (d + 1) & 3 : inside(lx, ly, id) ? (d + 3) & 3 : d;
        if (nd !== d) buf.push(nx, ny);
        vx = nx; vy = ny; d = nd;
        if (vx === sx && vy === sy && d === d0) break;
      }
      const area = area2 / 2;
      if (area < 0 && -area < minHole) continue;
      if (buf.length >= 8) loops.push({ pts: Int32Array.from(buf), area, comp: id });
    }
  }
  return loops;
}

/* ───────────────────────── Bézier fitting (Schneider) ───────────────────────── */

type Fit = { err2: number; smooth: number; cornerDeg: number };

function fitCubic(P: Float64Array, a: number, b: number, t1x: number, t1y: number, t2x: number, t2y: number, err2: number, out: number[]) {
  const n = b - a + 1;
  const p0x = P[2 * a], p0y = P[2 * a + 1], p3x = P[2 * b], p3y = P[2 * b + 1];
  if (n <= 2) {
    const d = Math.hypot(p3x - p0x, p3y - p0y) / 3;
    out.push(p0x + t1x * d, p0y + t1y * d, p3x + t2x * d, p3y + t2y * d, p3x, p3y);
    return;
  }
  const u = new Float64Array(n);
  for (let i = 1; i < n; i++) u[i] = u[i - 1] + Math.hypot(P[2 * (a + i)] - P[2 * (a + i - 1)], P[2 * (a + i) + 1] - P[2 * (a + i - 1) + 1]);
  const total = u[n - 1] || 1;
  for (let i = 1; i < n; i++) u[i] /= total;
  const seg = Math.hypot(p3x - p0x, p3y - p0y);
  const bez = [0, 0, 0, 0];
  const gen = () => {
    let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
    for (let i = 0; i < n; i++) {
      const t = u[i], s = 1 - t;
      const b1 = 3 * t * s * s, b2 = 3 * t * t * s, b01 = s * s * s + b1, b23 = b2 + t * t * t;
      const a1x = t1x * b1, a1y = t1y * b1, a2x = t2x * b2, a2y = t2y * b2;
      c00 += a1x * a1x + a1y * a1y; c01 += a1x * a2x + a1y * a2y; c11 += a2x * a2x + a2y * a2y;
      const tx = P[2 * (a + i)] - (p0x * b01 + p3x * b23), ty = P[2 * (a + i) + 1] - (p0y * b01 + p3y * b23);
      x0 += a1x * tx + a1y * ty; x1 += a2x * tx + a2y * ty;
    }
    const det = c00 * c11 - c01 * c01;
    let al1 = seg / 3, al2 = seg / 3;
    if (Math.abs(det) > 1e-12) {
      const A1 = (x0 * c11 - x1 * c01) / det, A2 = (c00 * x1 - c01 * x0) / det;
      const eps = 1e-6 * seg;
      if (A1 >= eps && A2 >= eps) { al1 = A1; al2 = A2; }
    }
    bez[0] = p0x + t1x * al1; bez[1] = p0y + t1y * al1; bez[2] = p3x + t2x * al2; bez[3] = p3y + t2y * al2;
  };
  let split = a + 1;
  const maxErr = () => {
    let worst = 0;
    for (let i = 1; i < n - 1; i++) {
      const t = u[i], s = 1 - t;
      const b0 = s * s * s, b1 = 3 * t * s * s, b2 = 3 * t * t * s, b3 = t * t * t;
      const dx = p0x * b0 + bez[0] * b1 + bez[2] * b2 + p3x * b3 - P[2 * (a + i)];
      const dy = p0y * b0 + bez[1] * b1 + bez[3] * b2 + p3y * b3 - P[2 * (a + i) + 1];
      const d = dx * dx + dy * dy;
      if (d > worst) { worst = d; split = a + i; }
    }
    return worst;
  };
  gen();
  let err = maxErr();
  if (err < err2 * 4) {
    for (let it = 0; it < 4 && err >= err2; it++) {
      for (let i = 1; i < n - 1; i++) {
        const t = u[i], s = 1 - t;
        const b0 = s * s * s, b1 = 3 * t * s * s, b2 = 3 * t * t * s, b3 = t * t * t;
        const qx = p0x * b0 + bez[0] * b1 + bez[2] * b2 + p3x * b3, qy = p0y * b0 + bez[1] * b1 + bez[3] * b2 + p3y * b3;
        const d1x = 3 * (s * s * (bez[0] - p0x) + 2 * s * t * (bez[2] - bez[0]) + t * t * (p3x - bez[2]));
        const d1y = 3 * (s * s * (bez[1] - p0y) + 2 * s * t * (bez[3] - bez[1]) + t * t * (p3y - bez[3]));
        const d2x = 6 * (s * (bez[2] - 2 * bez[0] + p0x) + t * (p3x - 2 * bez[2] + bez[0]));
        const d2y = 6 * (s * (bez[3] - 2 * bez[1] + p0y) + t * (p3y - 2 * bez[3] + bez[1]));
        const ex = qx - P[2 * (a + i)], ey = qy - P[2 * (a + i) + 1];
        const den = d1x * d1x + d1y * d1y + ex * d2x + ey * d2y;
        if (Math.abs(den) > 1e-12) u[i] = clamp(t - (ex * d1x + ey * d1y) / den, 0, 1);
      }
      gen();
      err = maxErr();
    }
  }
  if (err < err2 || n <= 3) { out.push(bez[0], bez[1], bez[2], bez[3], p3x, p3y); return; }
  split = clamp(split, a + 1, b - 1);
  let cx = P[2 * (split - 1)] - P[2 * (split + 1)], cy = P[2 * (split - 1) + 1] - P[2 * (split + 1) + 1];
  const cl = Math.hypot(cx, cy) || 1; cx /= cl; cy /= cl;
  fitCubic(P, a, split, t1x, t1y, cx, cy, err2, out);
  fitCubic(P, split, b, -cx, -cy, t2x, t2y, err2, out);
}

/** Closed Catmull-Rom through a tiny polygon: gives round dots instead of diamonds. */
function blob(M: Float64Array, m: number): number[] {
  const out: number[] = [M[0], M[1]];
  for (let i = 0; i < m; i++) {
    const p0 = (i + m - 1) % m, p1 = i, p2 = (i + 1) % m, p3 = (i + 2) % m;
    out.push(
      M[2 * p1] + (M[2 * p2] - M[2 * p0]) / 6, M[2 * p1 + 1] + (M[2 * p2 + 1] - M[2 * p0 + 1]) / 6,
      M[2 * p2] - (M[2 * p3] - M[2 * p1]) / 6, M[2 * p2 + 1] - (M[2 * p3 + 1] - M[2 * p1 + 1]) / 6,
      M[2 * p2], M[2 * p2 + 1],
    );
  }
  return out;
}

/** Staircase corner list → [x0,y0, (c1,c2,end)*] smooth closed contour. */
function fitLoop(V: Int32Array, o: Fit): number[] | null {
  const m = V.length >> 1;
  if (m < 4) return null;
  const M = new Float64Array(m * 2);
  for (let i = 0; i < m; i++) { const j = (i + 1) % m; M[2 * i] = (V[2 * i] + V[2 * j]) / 2; M[2 * i + 1] = (V[2 * i + 1] + V[2 * j + 1]) / 2; }
  const cum = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) { const j = (i + 1) % m; cum[i + 1] = cum[i] + Math.hypot(M[2 * j] - M[2 * i], M[2 * j + 1] - M[2 * i + 1]); }
  const per = cum[m];
  if (per < 10 || m < 8) return blob(M, m);
  const n = clamp(Math.round(per), 12, 24000);
  const D = new Float64Array(2 * n);
  for (let k = 0, s = 0; k < n; k++) {
    const target = (k * per) / n;
    while (cum[s + 1] < target && s < m - 1) s++;
    const len = cum[s + 1] - cum[s] || 1;
    const t = (target - cum[s]) / len, j = (s + 1) % m;
    D[2 * k] = M[2 * s] + (M[2 * j] - M[2 * s]) * t;
    D[2 * k + 1] = M[2 * s + 1] + (M[2 * j + 1] - M[2 * s + 1]) * t;
  }
  const kw = Math.min(4, Math.floor(n / 16));
  const corner = new Uint8Array(n);
  const corners: number[] = [];
  if (kw >= 2) {
    const cosv = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const ia = (i - kw + n) % n, ic = (i + kw) % n;
      const ax = D[2 * i] - D[2 * ia], ay = D[2 * i + 1] - D[2 * ia + 1], bx = D[2 * ic] - D[2 * i], by = D[2 * ic + 1] - D[2 * i + 1];
      cosv[i] = (ax * bx + ay * by) / ((Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1);
    }
    const thr = Math.cos((o.cornerDeg * Math.PI) / 180);
    for (let i = 0; i < n; i++) {
      if (cosv[i] >= thr) continue;
      let isMin = true;
      for (let d = 1; d <= kw && isMin; d++) {
        const l = cosv[(i - d + n) % n], r = cosv[(i + d) % n];
        if (l < cosv[i] || r <= cosv[i]) isMin = false;
      }
      if (isMin) { corner[i] = 1; corners.push(i); }
    }
  }
  const passes = Math.min(o.smooth, Math.floor(n / 8));
  let src = D, dst = new Float64Array(2 * n);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      if (corner[i]) { dst[2 * i] = src[2 * i]; dst[2 * i + 1] = src[2 * i + 1]; continue; }
      const a = (i + n - 1) % n, b = (i + 1) % n;
      dst[2 * i] = (src[2 * a] + 2 * src[2 * i] + src[2 * b]) / 4;
      dst[2 * i + 1] = (src[2 * a + 1] + 2 * src[2 * i + 1] + src[2 * b + 1]) / 4;
    }
    const t = src; src = dst; dst = t;
  }
  const E = new Float64Array(4 * n + 2);
  E.set(src.subarray(0, 2 * n), 0);
  E.set(src.subarray(0, 2 * n), 2 * n);
  E[4 * n] = src[0]; E[4 * n + 1] = src[1];
  const out: number[] = [];
  const dir = (from: number, to: number): [number, number] => {
    const dx = E[2 * to] - E[2 * from], dy = E[2 * to + 1] - E[2 * from + 1], l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };
  if (corners.length === 0) {
    const half = n >> 1;
    const [ax, ay] = dir(n - 1, 1), [bx, by] = dir(half - 1, half + 1);
    out.push(E[0], E[1]);
    fitCubic(E, 0, half, ax, ay, -bx, -by, o.err2, out);
    fitCubic(E, half, n, bx, by, -ax, -ay, o.err2, out);
  } else {
    out.push(E[2 * corners[0]], E[2 * corners[0] + 1]);
    for (let c = 0; c < corners.length; c++) {
      const a = corners[c];
      const b = c + 1 < corners.length ? corners[c + 1] : corners[0] + n;
      const span = Math.min(3, Math.max(1, (b - a) >> 1));
      const [t1x, t1y] = dir(a, a + span), [t2x, t2y] = dir(b, b - span);
      fitCubic(E, a, b, t1x, t1y, t2x, t2y, o.err2, out);
    }
  }
  return out;
}

/* ───────────────────────── compact path data ───────────────────────── */

function writePath(loops: number[][], sx: number, sy: number, prec: number): string {
  const f = Math.pow(10, prec);
  let s = '';
  let prevLetter = false, prevDot = false;
  const fmt = (v: number) => {
    if (v === 0) return '0';
    const neg = v < 0, a = neg ? -v : v;
    const ip = Math.floor(a / f), fp = a - ip * f;
    let t = fp === 0 ? String(ip) : (ip === 0 ? '' : String(ip)) + '.' + String(fp).padStart(prec, '0').replace(/0+$/, '');
    if (neg) t = '-' + t;
    return t;
  };
  const num = (v: number) => {
    const t = fmt(v);
    if (s && !prevLetter && t[0] !== '-' && !(t[0] === '.' && prevDot)) s += ' ';
    s += t; prevLetter = false; prevDot = t.indexOf('.') >= 0;
  };
  const letter = (c: string) => { s += c; prevLetter = true; prevDot = false; };
  let cx = 0, cy = 0, first = true;
  for (const L of loops) {
    const x0 = Math.round(L[0] * sx * f), y0 = Math.round(L[1] * sy * f);
    if (first) { letter('M'); num(x0); num(y0); first = false; } else { letter('m'); num(x0 - cx); num(y0 - cy); }
    cx = x0; cy = y0;
    let cmd = '';
    const segs = (L.length - 2) / 6;
    for (let k = 0; k < segs; k++) {
      const o = 2 + 6 * k;
      const c1x = Math.round(L[o] * sx * f), c1y = Math.round(L[o + 1] * sy * f), c2x = Math.round(L[o + 2] * sx * f), c2y = Math.round(L[o + 3] * sy * f);
      const ex = Math.round(L[o + 4] * sx * f), ey = Math.round(L[o + 5] * sy * f);
      const dx = ex - cx, dy = ey - cy, len = Math.hypot(dx, dy);
      const tol = 0.12 * f;
      const line = len === 0 || (Math.abs((c1x - cx) * dy - (c1y - cy) * dx) / len < tol && Math.abs((c2x - cx) * dy - (c2y - cy) * dx) / len < tol);
      if (line && dx === 0 && dy === 0) continue;
      if (line && k === segs - 1 && ex === x0 && ey === y0) { cx = ex; cy = ey; continue; }
      if (line) {
        if (dy === 0) { if (cmd !== 'h') letter(cmd = 'h'); num(dx); }
        else if (dx === 0) { if (cmd !== 'v') letter(cmd = 'v'); num(dy); }
        else { if (cmd !== 'l') letter(cmd = 'l'); num(dx); num(dy); }
      } else {
        if (cmd !== 'c') letter(cmd = 'c');
        num(c1x - cx); num(c1y - cy); num(c2x - cx); num(c2y - cy); num(dx); num(dy);
      }
      cx = ex; cy = ey;
    }
    letter('z');
    cx = x0; cy = y0;
  }
  return s;
}

/* ───────────────────────── mode pipelines ───────────────────────── */

type Profile = { side: number; minSide: number; colors: number; levels: number; minArea: number; fit: Fit; inkOffset: number; inkMinArea: number; overlay: boolean };

function profileFor(mode: TraceMode, t: number): Profile {
  const base = { colors: 0, levels: 0, overlay: false, inkOffset: 0, inkMinArea: 0 };
  if (mode === 'stroke') return { ...base, side: 1600, minSide: 900, minArea: 0, inkOffset: 12 + t * 0.6, inkMinArea: 4 + t * 0.15, fit: { err2: 0.6, smooth: 5, cornerDeg: 62 } };
  if (mode === 'stroke-fill') return { ...base, side: 1100, minSide: 800, colors: Math.round(clamp(32 - t * 0.4, 6, 32)), minArea: Math.round(10 + t * 0.5), overlay: true, inkOffset: 22 + t * 0.6, inkMinArea: 10 + t * 0.2, fit: { err2: 0.8, smooth: 5, cornerDeg: 62 } };
  if (mode === 'grayscale') return { ...base, side: 1100, minSide: 800, levels: Math.round(clamp(16 - t * 0.2, 4, 16)), minArea: Math.round(6 + t * 0.4), fit: { err2: 0.8, smooth: 5, cornerDeg: 62 } };
  return { ...base, side: 1600, minSide: 1000, colors: 64, minArea: 4, fit: { err2: 0.5, smooth: 3, cornerDeg: 62 } };
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

function pathFor(loops: Loop[], fit: Fit, sx: number, sy: number, prec: number): string {
  const fitted: number[][] = [];
  for (const loop of loops) { const l = fitLoop(loop.pts, fit); if (l) fitted.push(l); }
  return fitted.length ? writePath(fitted, sx, sy, prec) : '';
}

function inkRegions(r: Raster, p: Profile, offset: number, minArea: number, fill: string, label: string, sx: number, sy: number, prec: number, nextId: () => string, progress: (v: number) => void): VectorRegion[] {
  const { w, h } = r;
  const cls = inkClasses(r, offset, 62);
  const comps = labelComponents(cls, w, h);
  progress(0.5);
  const keep = new Uint8Array(comps.n);
  for (let c = 0; c < comps.n; c++) keep[c] = comps.areas[c] >= minArea ? 1 : 0;
  const loops = traceComponents(comps.lab, w, h, keep, minArea);
  progress(0.65);
  const byComp = new Map<number, Loop[]>();
  for (const l of loops) { const arr = byComp.get(l.comp); if (arr) arr.push(l); else byComp.set(l.comp, [l]); }
  const bigArea = Math.max(40, Math.round((w * h) / 40000));
  const big: number[] = [], small: Loop[] = [];
  for (const [c, list] of byComp) { if (comps.areas[c] >= bigArea) big.push(c); else small.push(...list); }
  big.sort((a, b) => comps.areas[b] - comps.areas[a]);
  const regions: VectorRegion[] = [];
  const mk = (name: string, d: string) => { if (d) regions.push({ id: nextId(), name, kind: 'path', d, fill, x: 0, y: 0, opacity: 1 }); };
  big.forEach((c, i) => { mk(`${label} ${i + 1}`, pathFor(byComp.get(c)!, p.fit, sx, sy, prec)); if (i % 40 === 0) progress(0.65 + 0.3 * (i / big.length)); });
  mk(`${label} fine detail`, pathFor(small, p.fit, sx, sy, prec));
  return regions;
}

function pointInLoop(pts: Int32Array, x: number, y: number): boolean {
  let inside = false;
  const m = pts.length >> 1;
  for (let i = 0, j = m - 1; i < m; j = i++) {
    const xi = pts[2 * i], yi = pts[2 * i + 1], xj = pts[2 * j], yj = pts[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Stacked color layers: containers first, each component filled solid (holes are covered by later layers). */
function stackedRegions(r: Raster, cls: Int16Array, palette: number[], p: Profile, sx: number, sy: number, prec: number, nextId: () => string, progress: (v: number) => void): VectorRegion[] {
  const { w, h } = r;
  const comps = labelComponents(cls, w, h);
  progress(0.4);
  const keep = new Uint8Array(comps.n);
  for (let c = 0; c < comps.n; c++) keep[c] = comps.areas[c] >= p.minArea ? 1 : 0;
  let loops = traceComponents(comps.lab, w, h, keep, 0);
  const holey = new Uint8Array(comps.n);
  for (const l of loops) if (l.area < 0) holey[l.comp] = 1;
  progress(0.5);
  if (r.transparent) {
    // keep only holes that contain enclosed transparent islands
    const tcls = new Int16Array(w * h).fill(-1);
    for (let i = 0; i < tcls.length; i++) if (r.data[i * 4 + 3] < 128) tcls[i] = 0;
    const tc = labelComponents(tcls, w, h);
    const outside = new Uint8Array(tc.n);
    for (let x = 0; x < w; x++) { const a = tc.lab[x], b = tc.lab[(h - 1) * w + x]; if (a >= 0) outside[a] = 1; if (b >= 0) outside[b] = 1; }
    for (let y = 0; y < h; y++) { const a = tc.lab[y * w], b = tc.lab[y * w + w - 1]; if (a >= 0) outside[a] = 1; if (b >= 0) outside[b] = 1; }
    const islands: number[] = [];
    for (let c = 0; c < tc.n; c++) if (!outside[c] && tc.areas[c] >= 4) { const f = tc.firsts[c]; islands.push((f % w) + 0.5, Math.floor(f / w) + 0.5); }
    loops = loops.filter(l => {
      if (l.area >= 0) return true;
      if (!islands.length) return false;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < l.pts.length; i += 2) { x0 = Math.min(x0, l.pts[i]); x1 = Math.max(x1, l.pts[i]); y0 = Math.min(y0, l.pts[i + 1]); y1 = Math.max(y1, l.pts[i + 1]); }
      for (let i = 0; i < islands.length; i += 2) if (islands[i] > x0 && islands[i] < x1 && islands[i + 1] > y0 && islands[i + 1] < y1 && pointInLoop(l.pts, islands[i], islands[i + 1])) return true;
      return false;
    });
  } else {
    loops = loops.filter(l => l.area >= 0);
  }
  const byComp = new Map<number, Loop[]>();
  const filled = new Map<number, number>();
  for (const l of loops) {
    const arr = byComp.get(l.comp);
    if (arr) arr.push(l); else byComp.set(l.comp, [l]);
    if (l.area > 0) filled.set(l.comp, (filled.get(l.comp) ?? 0) + l.area);
  }
  // Containers first (largest to smallest). Leaves hold nothing, so they never overlap each other and
  // can be merged into a single path per color on top: far fewer elements and a smaller file.
  const order = [...byComp.keys()].filter(c => holey[c]).sort((a, b) => (filled.get(b) ?? 0) - (filled.get(a) ?? 0));
  const leaves = new Map<number, Loop[]>();
  const leafArea = new Map<number, number>();
  for (const [c, list] of byComp) {
    if (holey[c]) continue;
    const col = comps.colors[c];
    const arr = leaves.get(col);
    if (arr) arr.push(...list); else leaves.set(col, [...list]);
    leafArea.set(col, (leafArea.get(col) ?? 0) + (filled.get(c) ?? 0));
  }
  const regions: VectorRegion[] = [];
  if (!r.transparent && byComp.size) {
    let bestColor = 0, top = -1;
    const hist = new Map<number, number>();
    for (let c = 0; c < comps.n; c++) hist.set(comps.colors[c], (hist.get(comps.colors[c]) ?? 0) + comps.areas[c]);
    for (const [col, a] of hist) if (a > top) { top = a; bestColor = col; }
    regions.push({ id: nextId(), name: 'Background', kind: 'path', d: `M0 0H${r.nw}V${r.nh}H0z`, fill: hex(palette[bestColor]), x: 0, y: 0, opacity: 1 });
  }
  order.forEach((c, i) => {
    const d = pathFor(byComp.get(c)!, p.fit, sx, sy, prec);
    if (d) regions.push({ id: nextId(), name: `${hex(palette[comps.colors[c]])} shape ${i + 1}`, kind: 'path', d, fill: hex(palette[comps.colors[c]]), x: 0, y: 0, opacity: 1 });
    if (i % 60 === 0) progress(0.5 + 0.4 * (i / order.length));
  });
  [...leaves.keys()].sort((a, b) => (leafArea.get(b) ?? 0) - (leafArea.get(a) ?? 0)).forEach(col => {
    const d = pathFor(leaves.get(col)!, p.fit, sx, sy, prec);
    if (d) regions.push({ id: nextId(), name: `${hex(palette[col])} details`, kind: 'path', d, fill: hex(palette[col]), x: 0, y: 0, opacity: 1 });
  });
  return regions;
}

/** Nested threshold layers: lightest first, each darker layer sits on top, so every edge is traced once. */
function grayRegions(r: Raster, p: Profile, sx: number, sy: number, prec: number, nextId: () => string, progress: (v: number) => void): VectorRegion[] {
  const { w, h, data } = r;
  const N = w * h;
  const L = p.levels;
  const lum = luminance(r);
  const q = new Uint8Array(N);
  const sum = new Float64Array(L), cnt = new Float64Array(L);
  for (let i = 0; i < N; i++) {
    const v = Math.min(L - 1, Math.floor((lum[i] / 256) * L));
    q[i] = v;
    if (data[i * 4 + 3] >= 128) { sum[v] += lum[i]; cnt[v]++; }
  }
  const gray = (v: number) => { const g = cnt[v] ? Math.round(sum[v] / cnt[v]) : Math.round(((v + 0.5) * 255) / L); return hex((g << 16) | (g << 8) | g); };
  const regions: VectorRegion[] = [];
  let lightest = L - 1;
  while (lightest > 0 && cnt[lightest] === 0) lightest--;
  if (r.transparent) {
    const mask = new Int16Array(N).fill(-1);
    for (let i = 0; i < N; i++) if (data[i * 4 + 3] >= 128) mask[i] = 0;
    const comps = labelComponents(mask, w, h);
    const keep = new Uint8Array(comps.n).fill(1);
    const d = pathFor(traceComponents(comps.lab, w, h, keep, p.minArea), p.fit, sx, sy, prec);
    if (d) regions.push({ id: nextId(), name: `Gray base`, kind: 'path', d, fill: gray(lightest), x: 0, y: 0, opacity: 1 });
  } else {
    regions.push({ id: nextId(), name: 'Gray base', kind: 'path', d: `M0 0H${r.nw}V${r.nh}H0z`, fill: gray(lightest), x: 0, y: 0, opacity: 1 });
  }
  for (let level = lightest - 1; level >= 0; level--) {
    progress(0.1 + 0.85 * ((lightest - 1 - level) / Math.max(1, lightest)));
    if (cnt[level] === 0 && level > 0) {
      let any = false;
      for (let v = 0; v <= level; v++) if (cnt[v]) { any = true; break; }
      if (!any) continue;
    }
    const mask = new Int16Array(N).fill(-1);
    for (let i = 0; i < N; i++) if (q[i] <= level && data[i * 4 + 3] >= 128) mask[i] = 0;
    const comps = labelComponents(mask, w, h);
    const keep = new Uint8Array(comps.n);
    for (let c = 0; c < comps.n; c++) keep[c] = comps.areas[c] >= p.minArea ? 1 : 0;
    const d = pathFor(traceComponents(comps.lab, w, h, keep, p.minArea), p.fit, sx, sy, prec);
    if (d) regions.push({ id: nextId(), name: `Gray ${Math.round(((level + 0.5) / L) * 100)}%`, kind: 'path', d, fill: gray(level), x: 0, y: 0, opacity: 1 });
  }
  return regions;
}

export function traceImage(image: HTMLImageElement | ImageBitmap, mode: TraceMode, options: TraceOptions = {}): TraceResult {
  const tolerance = clamp(Number.isFinite(options.tolerance) ? (options.tolerance as number) : 22, 0, 150);
  const progress = (v: number) => options.onProgress?.(clamp(v, 0, 0.99));
  const p = profileFor(mode, tolerance);
  if (Number.isFinite(options.maxTraceSize)) {
    p.side = clamp(options.maxTraceSize as number, 128, 5000);
    p.minSide = Math.min(p.minSide, p.side);
  }
  if (Number.isFinite(options.colorCount)) p.colors = clamp(Math.round(options.colorCount as number), 2, 64);
  if (mode === 'max') p.colors = Math.min(p.colors, Math.max(2, 64 - Math.round(tolerance * 0.2)));
  if (Number.isFinite(options.lineTolerance)) {
    const lineTolerance = clamp(options.lineTolerance as number, 0, 150);
    p.inkOffset = 8 + lineTolerance * 0.6;
    p.inkMinArea = 2 + lineTolerance * 0.15;
  }
  if (Number.isFinite(options.pathSimplification)) p.fit.err2 = 0.1 + clamp(options.pathSimplification as number, 0, 10) * 0.25;
  if (Number.isFinite(options.curveSmoothness)) p.fit.smooth = Math.round(clamp(options.curveSmoothness as number, 0, 10));
  if (Number.isFinite(options.cornerThreshold)) p.fit.cornerDeg = clamp(options.cornerThreshold as number, 20, 150);
  if (Number.isFinite(options.minArea)) p.minArea = Math.round(clamp(options.minArea as number, 0, 1000));
  if (Number.isFinite(options.noiseReduction)) p.minArea += Math.round(clamp(options.noiseReduction as number, 0, 20) * 2);
  p.inkMinArea = Math.max(p.inkMinArea, p.minArea);
  progress(0);
  const r = rasterize(image, p.side, p.minSide);
  const sx = r.nw / r.w, sy = r.nh / r.h;
  const prec = Math.max(r.nw, r.nh) >= 300 ? 1 : 2;
  let counter = 0;
  const nextId = () => `trace-${counter++}`;
  progress(0.05);
  let regions: VectorRegion[];
  if (mode === 'silhouette') {
    const alphaClass = new Int16Array(r.w * r.h).fill(-1);
    for (let i = 0; i < alphaClass.length; i++) if (r.data[i * 4 + 3] >= 128) alphaClass[i] = 0;
    const components = labelComponents(alphaClass, r.w, r.h);
    const keep = new Uint8Array(components.n);
    for (let i = 0; i < components.n; i++) keep[i] = components.areas[i] >= Math.max(1, p.minArea) ? 1 : 0;
    const path = pathFor(traceComponents(components.lab, r.w, r.h, keep, 0), p.fit, sx, sy, prec);
    regions = path ? [{ id: nextId(), name: 'Alpha silhouette', kind: 'path', d: path, fill: 'none', stroke: '#111111', strokeWidth: Math.max(1, Math.max(r.nw, r.nh) / 700), x: 0, y: 0, opacity: 1 }] : [];
    progress(0.85);
  } else if (mode === 'stroke') {
    regions = inkRegions(r, p, p.inkOffset, p.inkMinArea, '#000000', 'Ink', sx, sy, prec, nextId, progress);
  } else if (mode === 'grayscale') {
    regions = grayRegions(r, p, sx, sy, prec, nextId, progress);
  } else {
    const { cls, palette } = quantize(r, p.colors);
    progress(0.3);
    regions = stackedRegions(r, cls, palette, p, sx, sy, prec, nextId, progress);
    if (p.overlay) regions.push(...inkRegions(r, p, p.inkOffset, p.inkMinArea, '#111111', 'Outline', sx, sy, prec, nextId, () => undefined));
  }
  let truncated = false;
  const cap = options.maxRegions;
  if (typeof cap === 'number' && Number.isFinite(cap) && regions.length > cap) { regions = regions.slice(0, Math.max(1, Math.floor(cap))); truncated = true; }
  options.onProgress?.(1);
  return { regions, width: r.nw, height: r.nh, truncated };
}
