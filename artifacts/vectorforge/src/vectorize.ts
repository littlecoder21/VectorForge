export type VectorRegion = {
  id: string;
  name: string;
  kind: 'path';
  d: string;
  fill: string;
  fillRule?: 'evenodd';
  stroke?: string;
  strokeWidth?: number;
  x: number;
  y: number;
  opacity: number;
};
export type TraceMode = 'stroke' | 'stroke-fill' | 'grayscale' | 'max';
export type TraceOptions = { maxRegions?: number; onProgress?: (progress: number) => void };

type Point = { x: number; y: number };
type Edge = Point & { x2: number; y2: number; direction: number };
export type TraceResult = { regions: VectorRegion[]; width: number; height: number; truncated: boolean };

function simplifyOpenPath(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points;
  const first = points[0];
  const last = points[points.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const lengthSquared = dx * dx + dy * dy;
  let farthest = epsilon * epsilon;
  let split = -1;

  for (let i = 1; i < points.length - 1; i++) {
    const point = points[i];
    const projection = lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - first.x) * dx + (point.y - first.y) * dy) / lengthSquared));
    const distanceX = point.x - (first.x + projection * dx);
    const distanceY = point.y - (first.y + projection * dy);
    const distanceSquared = distanceX * distanceX + distanceY * distanceY;
    if (distanceSquared > farthest) {
      farthest = distanceSquared;
      split = i;
    }
  }

  if (split < 0) return [first, last];
  const left = simplifyOpenPath(points.slice(0, split + 1), epsilon);
  const right = simplifyOpenPath(points.slice(split), epsilon);
  return [...left.slice(0, -1), ...right];
}

function simplifyLoop(points: Point[], epsilon: number): Point[] {
  if (points.length < 4) return points;
  const first = points[0];
  let farthestIndex = 1;
  let farthestDistance = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - first.x;
    const dy = points[i].y - first.y;
    const distance = dx * dx + dy * dy;
    if (distance > farthestDistance) {
      farthestIndex = i;
      farthestDistance = distance;
    }
  }

  const firstArc = simplifyOpenPath(points.slice(0, farthestIndex + 1), epsilon);
  const secondArc = simplifyOpenPath([...points.slice(farthestIndex), first], epsilon);
  const simplified = [...firstArc.slice(0, -1), ...secondArc.slice(0, -1)];
  return simplified.length >= 3 ? simplified : points;
}

function outlineRegion(
  pixels: number[],
  palette: Int32Array,
  width: number,
  height: number,
  color: number,
  epsilon: number,
  scaleX: number,
  scaleY: number,
  alphaPalette?: Uint8Array,
  alpha = 255,
): string {
  const edges: Edge[] = [];
  const outgoing = new Map<string, number[]>();
  const matchesRegion = (position: number) => palette[position] === color && (!alphaPalette || alphaPalette[position] === alpha);
  const addEdge = (x: number, y: number, x2: number, y2: number, direction: number) => {
    const index = edges.length;
    edges.push({ x, y, x2, y2, direction });
    const key = `${x},${y}`;
    const atVertex = outgoing.get(key);
    if (atVertex) atVertex.push(index);
    else outgoing.set(key, [index]);
  };

  for (const position of pixels) {
    const x = position % width;
    const y = (position / width) | 0;
    if (y === 0 || !matchesRegion(position - width)) addEdge(x, y, x + 1, y, 0);
    if (x === width - 1 || !matchesRegion(position + 1)) addEdge(x + 1, y, x + 1, y + 1, 1);
    if (y === height - 1 || !matchesRegion(position + width)) addEdge(x + 1, y + 1, x, y + 1, 2);
    if (x === 0 || !matchesRegion(position - 1)) addEdge(x, y + 1, x, y, 3);
  }

  const used = new Uint8Array(edges.length);
  const loops: Point[][] = [];
  for (let initial = 0; initial < edges.length; initial++) {
    if (used[initial]) continue;
    const start = edges[initial];
    const points: Point[] = [{ x: start.x, y: start.y }];
    let current = initial;
    let closed = false;

    for (let step = 0; step <= edges.length; step++) {
      if (used[current]) break;
      used[current] = 1;
      const edge = edges[current];
      points.push({ x: edge.x2, y: edge.y2 });
      if (edge.x2 === start.x && edge.y2 === start.y) {
        closed = true;
        break;
      }

      const candidates = (outgoing.get(`${edge.x2},${edge.y2}`) ?? []).filter(index => !used[index]);
      if (candidates.length === 0) break;
      let next = candidates[0];
      let bestTurn = 5;
      for (const candidate of candidates) {
        const delta = (edges[candidate].direction - edge.direction + 4) % 4;
        const turnRank = delta === 1 ? 0 : delta === 0 ? 1 : delta === 3 ? 2 : 3;
        if (turnRank < bestTurn) {
          bestTurn = turnRank;
          next = candidate;
        }
      }
      current = next;
    }

    if (closed && points.length > 4) {
      points.pop();
      loops.push(simplifyLoop(points, epsilon));
    }
  }

  return loops
    .filter(loop => loop.length >= 3)
    .map(loop => `M${(loop[0].x * scaleX).toFixed(2)} ${(loop[0].y * scaleY).toFixed(2)}${loop.slice(1).map(point => `L${(point.x * scaleX).toFixed(2)} ${(point.y * scaleY).toFixed(2)}`).join('')}Z`)
    .join('');
}

export function traceImage(
  image: HTMLImageElement | ImageBitmap,
  mode: TraceMode,
  options: TraceOptions = {},
): TraceResult {
  const { onProgress } = options;
  const naturalWidth = 'naturalWidth' in image ? image.naturalWidth : image.width;
  const naturalHeight = 'naturalHeight' in image ? image.naturalHeight : image.height;
  const maxSide = mode === 'max' ? 1600 : mode === 'grayscale' ? 280 : 220;
  const scale = Math.min(1, maxSide / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas is unavailable in this browser.');
  context.drawImage(image, 0, 0, width, height);

  const pixels = context.getImageData(0, 0, width, height).data;
  const alphaPalette = mode === 'max' ? new Uint8Array(width * height) : undefined;
  const quantum = mode === 'max' ? 18 : mode === 'grayscale' ? 16 : 1;
  const palette = new Int32Array(width * height);
  for (let i = 0; i < palette.length; i++) {
    const alpha = pixels[i * 4 + 3];
    if (mode === 'max' ? alpha === 0 : alpha < 40) {
      palette[i] = -1;
      continue;
    }
    if (alphaPalette) alphaPalette[i] = alpha;
    if (mode === 'grayscale') {
      const luminance = pixels[i * 4] * 0.2126 + pixels[i * 4 + 1] * 0.7152 + pixels[i * 4 + 2] * 0.0722;
      const gray = Math.min(255, Math.round(luminance / quantum) * quantum);
      palette[i] = (gray << 16) | (gray << 8) | gray;
    } else {
      const red = Math.min(255, Math.round(pixels[i * 4] / quantum) * quantum);
      const green = Math.min(255, Math.round(pixels[i * 4 + 1] / quantum) * quantum);
      const blue = Math.min(255, Math.round(pixels[i * 4 + 2] / quantum) * quantum);
      palette[i] = (red << 16) | (green << 8) | blue;
    }
  }

  const seen = new Uint8Array(palette.length);
  const regions: VectorRegion[] = [];
  const minimumRegionPixels = mode === 'max' ? 3 : 1;
  const simplifyEpsilon = mode === 'max' ? 0.85 : mode === 'grayscale' ? 0.35 : 0.8;
  const configuredLimit = options.maxRegions;
  const maxRegions = mode === 'max'
    ? 3000
    : typeof configuredLimit === 'number' && Number.isFinite(configuredLimit)
      ? Math.max(1, Math.min(100000, Math.floor(configuredLimit)))
      : Number.POSITIVE_INFINITY;
  let truncated = false;
  let lastProgress = 0;
  const matchesComponent = (position: number, color: number, alpha: number) =>
    position >= 0 && !seen[position] && palette[position] === color && (!alphaPalette || alphaPalette[position] === alpha);
  onProgress?.(0);

  for (let start = 0; start < palette.length; start++) {
    if (onProgress && start > 0 && start % 65536 === 0) {
      lastProgress = Math.max(lastProgress, Math.min(0.95, (start / palette.length) * 0.95));
      onProgress(lastProgress);
    }
    const color = palette[start];
    if (seen[start] || color < 0) continue;
    if (regions.length >= maxRegions) {
      truncated = true;
      break;
    }

    const x = start % width;
    const y = (start / width) | 0;
    const alpha = alphaPalette?.[start] ?? 255;
    if (mode === 'max' &&
      !matchesComponent(x > 0 ? start - 1 : -1, color, alpha) &&
      !matchesComponent(x + 1 < width ? start + 1 : -1, color, alpha) &&
      !matchesComponent(y > 0 ? start - width : -1, color, alpha) &&
      !matchesComponent(y + 1 < height ? start + width : -1, color, alpha)) {
      seen[start] = 1;
      continue;
    }

    const queue = [start];
    const componentAlpha = alphaPalette?.[start] ?? 255;
    seen[start] = 1;
    for (let head = 0; head < queue.length; head++) {
      const position = queue[head];
      const currentX = position % width;
      const currentY = (position / width) | 0;
      const left = currentX > 0 ? position - 1 : -1;
      if (matchesComponent(left, color, componentAlpha)) { seen[left] = 1; queue.push(left); }
      const right = currentX + 1 < width ? position + 1 : -1;
      if (matchesComponent(right, color, componentAlpha)) { seen[right] = 1; queue.push(right); }
      const up = currentY > 0 ? position - width : -1;
      if (matchesComponent(up, color, componentAlpha)) { seen[up] = 1; queue.push(up); }
      const down = currentY + 1 < height ? position + width : -1;
      if (matchesComponent(down, color, componentAlpha)) { seen[down] = 1; queue.push(down); }
      if (onProgress && (head & 0x7fff) === 0 && queue.length > 32768) {
        lastProgress = Math.max(lastProgress, Math.min(0.95, (head / palette.length) * 0.95));
        onProgress(lastProgress);
      }
    }

    if (queue.length < minimumRegionPixels) continue;
    const path = outlineRegion(
      queue,
      palette,
      width,
      height,
      color,
      simplifyEpsilon,
      naturalWidth / width,
      naturalHeight / height,
      alphaPalette,
      componentAlpha,
    );
    if (!path) continue;
    const hex = `#${color.toString(16).padStart(6, '0')}`;
    regions.push({
      id: `trace-${start}`,
      name: `Region ${regions.length + 1}`,
      kind: 'path',
      d: path,
      fill: mode === 'stroke' ? 'none' : hex,
      stroke: mode === 'stroke' || mode === 'stroke-fill' ? '#111111' : undefined,
      strokeWidth: mode === 'stroke' || mode === 'stroke-fill' ? Math.max(0.6, 0.55 * Math.max(naturalWidth / width, naturalHeight / height)) : undefined,
      fillRule: 'evenodd',
      x: 0,
      y: 0,
      opacity: componentAlpha / 255,
    });
  }

  onProgress?.(1);
  return { regions, width: naturalWidth, height: naturalHeight, truncated };
}