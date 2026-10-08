export type RGB = [number, number, number];
export type BackgroundOptions = {
  color: RGB;
  /** 0–150: how far a pixel's color may drift from the target and still count as background. */
  tolerance: number;
  /** true: only background connected to the image edges; false: every matching pixel (also enclosed areas). */
  contiguous: boolean;
};

export const hexToRgb = (hex: string): RGB => {
  const v = parseInt(hex.replace('#', '').padStart(6, '0').slice(0, 6), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
export const rgbToHex = ([r, g, b]: RGB) => `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;

/** Most common color along the image border (4-bit bins, averaged inside the winning bin). */
export function detectBackground(img: ImageData): RGB {
  const { data, width: w, height: h } = img;
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  const add = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 200) return;
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const e = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += data[i]; e.g += data[i + 1]; e.b += data[i + 2];
    bins.set(key, e);
  };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { add(0, y); add(w - 1, y); }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const e of bins.values()) if (!best || e.n > best.n) best = e;
  return best ? [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)] : [255, 255, 255];
}

/** Removes a color (not just white) in place. Edge pixels get a soft alpha ramp and the background tint is peeled off them. */
export function removeBackground(img: ImageData, o: BackgroundOptions): number {
  const { data, width: w, height: h } = img;
  const N = w * h;
  const [br, bg, bb] = o.color;
  const limit = (o.tolerance / 100) * 255 * 1.35;
  const soft = limit * 1.35 + 1;
  const dist = (i: number) => {
    const dr = data[i * 4] - br, dg = data[i * 4 + 1] - bg, db = data[i * 4 + 2] - bb;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };
  const gone = new Uint8Array(N);
  let removed = 0;
  if (o.contiguous) {
    const queue = new Int32Array(N);
    let tail = 0;
    const seed = (i: number) => { if (!gone[i] && data[i * 4 + 3] > 0 && dist(i) <= limit) { gone[i] = 1; queue[tail++] = i; } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    for (let head = 0; head < tail; head++) {
      const p = queue[head], x = p % w;
      if (x > 0) seed(p - 1);
      if (x < w - 1) seed(p + 1);
      if (p >= w) seed(p - w);
      if (p < N - w) seed(p + w);
    }
  } else {
    for (let i = 0; i < N; i++) if (data[i * 4 + 3] > 0 && dist(i) <= limit) gone[i] = 1;
  }
  for (let i = 0; i < N; i++) if (gone[i]) { data[i * 4 + 3] = 0; removed++; }
  // soft fringe: pixels next to removed background that are still close to it
  for (let i = 0; i < N; i++) {
    if (gone[i] || data[i * 4 + 3] === 0) continue;
    const x = i % w;
    const touches = (x > 0 && gone[i - 1]) || (x < w - 1 && gone[i + 1]) || (i >= w && gone[i - w]) || (i < N - w && gone[i + w]);
    if (!touches) continue;
    const d = dist(i);
    if (d >= soft) continue;
    const a = Math.max(0.04, (d - limit) / (soft - limit));
    const p = i * 4;
    data[p] = Math.max(0, Math.min(255, Math.round((data[p] - br * (1 - a)) / a)));
    data[p + 1] = Math.max(0, Math.min(255, Math.round((data[p + 1] - bg * (1 - a)) / a)));
    data[p + 2] = Math.max(0, Math.min(255, Math.round((data[p + 2] - bb * (1 - a)) / a)));
    data[p + 3] = Math.round(data[p + 3] * a);
  }
  return removed;
}
