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
export type TraceMode = 'detailed' | 'normal' | 'basic';

type Point = { x: number; y: number };
type Edge = Point & { x2: number; y2: number; direction: number };
type TraceResult = { regions: VectorRegion[]; width: number; height: number; truncated: boolean };

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

function outlineRegion(pixels: number[], palette: Int32Array, width: number, height: number, color: number, epsilon: number): string {
  const edges: Edge[] = [];
  const outgoing = new Map<string, number[]>();
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
    if (y === 0 || palette[position - width] !== color) addEdge(x, y, x + 1, y, 0);
    if (x === width - 1 || palette[position + 1] !== color) addEdge(x + 1, y, x + 1, y + 1, 1);
    if (y === height - 1 || palette[position + width] !== color) addEdge(x + 1, y + 1, x, y + 1, 2);
    if (x === 0 || palette[position - 1] !== color) addEdge(x, y + 1, x, y, 3);
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
    .map(loop => `M${loop[0].x} ${loop[0].y}${loop.slice(1).map(point => `L${point.x} ${point.y}`).join('')}Z`)
    .join('');
}

export function traceImage(image: HTMLImageElement, mode: TraceMode, tolerance = 22): TraceResult {
  const maxSide = mode === 'detailed' ? 280 : mode === 'normal' ? 220 : 128;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas is unavailable in this browser.');
  context.drawImage(image, 0, 0, width, height);

  const pixels = context.getImageData(0, 0, width, height).data;
  const baseQuantum = mode === 'detailed' ? 14 : mode === 'normal' ? 27 : 50;
  const quantum = Math.max(8, Math.min(100, Math.round(baseQuantum + tolerance * 0.7)));
  const palette = new Int32Array(width * height);
  for (let i = 0; i < palette.length; i++) {
    const alpha = pixels[i * 4 + 3];
    if (alpha < 40) {
      palette[i] = -1;
      continue;
    }
    const red = Math.min(255, Math.round(pixels[i * 4] / quantum) * quantum);
    const green = Math.min(255, Math.round(pixels[i * 4 + 1] / quantum) * quantum);
    const blue = Math.min(255, Math.round(pixels[i * 4 + 2] / quantum) * quantum);
    palette[i] = (red << 16) | (green << 8) | blue;
  }

  const seen = new Uint8Array(palette.length);
  const regions: VectorRegion[] = [];
  const minimumRegionPixels = mode === 'detailed' ? 2 : mode === 'normal' ? 4 : 9;
  const simplifyEpsilon = mode === 'detailed' ? 0.35 : mode === 'normal' ? 0.8 : 1.6;
  const maxRegions = 400;
  let truncated = false;

  for (let start = 0; start < palette.length; start++) {
    const color = palette[start];
    if (seen[start] || color < 0) continue;
    if (regions.length >= maxRegions) {
      truncated = true;
      break;
    }

    const queue = [start];
    const component: number[] = [];
    seen[start] = 1;
    for (let head = 0; head < queue.length; head++) {
      const position = queue[head];
      component.push(position);
      const x = position % width;
      const y = (position / width) | 0;
      const neighbors = [
        x > 0 ? position - 1 : -1,
        x + 1 < width ? position + 1 : -1,
        y > 0 ? position - width : -1,
        y + 1 < height ? position + width : -1,
      ];
      for (const next of neighbors) {
        if (next >= 0 && !seen[next] && palette[next] === color) {
          seen[next] = 1;
          queue.push(next);
        }
      }
    }

    if (component.length < minimumRegionPixels) continue;
    const path = outlineRegion(component, palette, width, height, color, simplifyEpsilon);
    if (!path) continue;
    const hex = `#${color.toString(16).padStart(6, '0')}`;
    regions.push({
      id: `trace-${start}`,
      name: `Region ${regions.length + 1}`,
      kind: 'path',
      d: path,
      fill: hex,
      fillRule: 'evenodd',
      x: 0,
      y: 0,
      opacity: 1,
    });
  }

  return { regions, width: image.naturalWidth, height: image.naturalHeight, truncated };
}