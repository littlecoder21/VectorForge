import { type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent, type TouchEvent as ReactTouchEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Brush, Circle, Code2, Copy, Download, Eraser, FileImage, Hand, ImagePlus, Layers, Maximize2, Minus, MousePointer2, Redo2, RotateCcw, ScanLine, Settings2, Shapes, Square, Trash2, Undo2, Upload, X, ZoomIn, ZoomOut } from 'lucide-react';
import { traceImage, type TraceMode, type TraceOptions, type TraceResult, type VectorRegion } from './vectorize';
import { detectBackground, hexToRgb, removeBackground, rgbToHex } from './background';
import { AdvancedTraceControls, getSmartTraceSize, type AdvancedTraceSettings } from './components/AdvancedTraceControls';
import { BackgroundRemover } from './components/BackgroundRemover';
import { formatSvgMarkup } from './lib/format-svg';

type Shape = VectorRegion | { id: string; name: string; kind: 'rect' | 'circle' | 'line'; x: number; y: number; w: number; h: number; fill: string; stroke: string; strokeWidth: number; opacity: number };
type Tool = 'select' | 'hand' | 'brush' | 'rect' | 'circle' | 'ellipse' | 'line' | 'eraser';
type EraserPath = { id: string; d: string; width: number; targetIds: string[] };
type Snapshot = { shapes: Shape[]; selected: string | null; eraserPaths: EraserPath[] };
type TraceProfile = 'normal' | 'max';
type NormalTraceMode = Exclude<TraceMode, 'max'>;
type TraceSettings = { profile: TraceProfile; mode: TraceMode; tolerance: number; advancedKey: string };
const normalModeOptions: { mode: NormalTraceMode; label: string; detail: string; title: string }[] = [
  { mode: 'stroke', label: 'Stroke only', detail: 'Ink line art', title: 'Black ink outlines like a Potrace line drawing, with no fills' },
  { mode: 'stroke-fill', label: 'Stroke + Fill', detail: 'Color fills', title: 'Fill color regions and outline them with dark strokes' },
  { mode: 'grayscale', label: 'Grayscale fills', detail: 'Black to white', title: 'Use black, white, and gray fills to preserve tonal depth' },
];

async function traceInWorker(image: HTMLImageElement, mode: TraceMode, options: Omit<TraceOptions, 'onProgress'>, onProgress: (progress: number) => void): Promise<TraceResult> {
  const direct = () => traceImage(image, mode, { ...options, onProgress });
  if (typeof createImageBitmap !== 'function' || typeof Worker === 'undefined') return direct();
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(image); } catch { return direct(); }
  return new Promise<TraceResult>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./vectorize.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      bitmap.close();
      try { resolve(direct()); } catch (error) { reject(error); }
      return;
    }
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      callback();
    };
    worker.onmessage = (event: MessageEvent<
      | { type: 'progress'; progress: number }
      | { type: 'result'; result: TraceResult }
      | { type: 'error'; message: string }
    >) => {
      const message = event.data;
      if (message.type === 'progress') onProgress(message.progress);
      else if (message.type === 'result') finish(() => resolve(message.result));
      else finish(() => reject(new Error(message.message)));
    };
    worker.onerror = () => finish(() => { try { resolve(direct()); } catch (error) { reject(error); } });
    try {
      worker.postMessage({ image: bitmap, mode, options }, [bitmap]);
    } catch (error) {
      bitmap.close();
      finish(() => reject(error));
    }
  });
}

const sampleColor = async (url: string, x: number, y: number): Promise<string | null> => {
  const img = new Image(); img.src = url; await img.decode();
  const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (!ctx) return null;
  ctx.drawImage(img, Math.max(0, Math.min(img.naturalWidth - 1, Math.floor(x))), Math.max(0, Math.min(img.naturalHeight - 1, Math.floor(y))), 1, 1, 0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return a < 40 ? null : rgbToHex([r, g, b]);
};
const sampleAreaColor = async (url: string, x: number, y: number, radius: number, shape: 'circle' | 'rect'): Promise<{ color: string; spread: number } | null> => {
  const img = new Image(); img.src = url; await img.decode();
  const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  const x0 = Math.max(0, Math.floor(x - radius)), y0 = Math.max(0, Math.floor(y - radius));
  const x1 = Math.min(img.naturalWidth, Math.ceil(x + radius)), y1 = Math.min(img.naturalHeight, Math.ceil(y + radius));
  const pixels = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  let count = 0, r = 0, g = 0, b = 0;
  for (let py = 0; py < pixels.height; py++) for (let px = 0; px < pixels.width; px++) {
    const sampleX = x0 + px, sampleY = y0 + py;
    if (shape === 'circle' && (sampleX - x) ** 2 + (sampleY - y) ** 2 > radius ** 2) continue;
    const i = (py * pixels.width + px) * 4;
    if (pixels.data[i + 3] < 32) continue;
    r += pixels.data[i]; g += pixels.data[i + 1]; b += pixels.data[i + 2]; count++;
  }
  if (!count) return null;
  const mean: [number, number, number] = [r / count, g / count, b / count];
  let variance = 0;
  for (let i = 0; i < pixels.data.length; i += 4) {
    if (pixels.data[i + 3] < 32) continue;
    const px = x0 + (i / 4) % pixels.width, py = y0 + Math.floor(i / 4 / pixels.width);
    if (shape === 'circle' && (px - x) ** 2 + (py - y) ** 2 > radius ** 2) continue;
    variance += (pixels.data[i] - mean[0]) ** 2 + (pixels.data[i + 1] - mean[1]) ** 2 + (pixels.data[i + 2] - mean[2]) ** 2;
  }
  return { color: rgbToHex(mean.map(Math.round) as [number, number, number]), spread: Math.sqrt(variance / (count * 3)) };
};
const SVG_EXPORT_MAX_EDGE = 600;
const SVG_NS = 'http://www.w3.org/2000/svg';

const makeId = () => `shape-${Math.random().toString(36).slice(2, 9)}`;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 50_000_000;
const MAX_IMAGE_HISTORY = 8;

const canvasImageUrl = (canvas: HTMLCanvasElement): Promise<string> => new Promise((resolve, reject) => {
  canvas.toBlob(blob => blob ? resolve(URL.createObjectURL(blob)) : reject(new Error('Could not save the edited image.')), 'image/png');
});

function App() {
  const fileRef = useRef<HTMLInputElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<{ id: string; x: number; y: number; startX: number; startY: number; lastX?: number; lastY?: number; type: Tool } | null>(null);
  const history = useRef<Snapshot[]>([{ shapes: [], selected: null, eraserPaths: [] }]);
  const historyAt = useRef(0);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [eraserPaths, setEraserPaths] = useState<EraserPath[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageName, setImageName] = useState('');
  const [imageSize, setImageSize] = useState({ width: 640, height: 420 });
  const [hasVectorResult, setHasVectorResult] = useState(false);
  const [lastTraceSettings, setLastTraceSettings] = useState<TraceSettings | null>(null);
  const [editing, setEditing] = useState(false);
  const [showSource, setShowSource] = useState(true);
  const [codeStudio, setCodeStudio] = useState(false);
  const [svgCode, setSvgCode] = useState('');
  const [selectedCodePath, setSelectedCodePath] = useState(0);
  const [codePreviewUrl, setCodePreviewUrl] = useState<string | null>(null);
  const [traceProfile, setTraceProfile] = useState<TraceProfile>('normal');
  const [traceMode, setTraceMode] = useState<NormalTraceMode>('stroke-fill');
  const [advancedSettings, setAdvancedSettings] = useState<AdvancedTraceSettings>({
    colorCount: null, tolerance: 22, lineTolerance: 22, pathSimplification: 3,
    curveSmoothness: 5, cornerThreshold: 62, minArea: 10, noiseReduction: 0,
  });
  const [autoTraceSize, setAutoTraceSize] = useState(true);
  const [maxTraceSize, setMaxTraceSize] = useState(2400);
  const [samplingArea, setSamplingArea] = useState(false);
  const [sampleRadius, setSampleRadius] = useState(32);
  const [sampleShape, setSampleShape] = useState<'circle' | 'rect'>('circle');
  const [sampleCursor, setSampleCursor] = useState<{ left: number; top: number; radius: number; shape: 'circle' | 'rect' } | null>(null);
  const samplePinch = useRef<{ distance: number; radius: number } | null>(null);
  const [previewBgAlpha, setPreviewBgAlpha] = useState(100);
  const lastPreviewSettings = useRef('0:normal:stroke-fill:22');
  const [busy, setBusy] = useState(false);
  const [traceProgress, setTraceProgress] = useState<number | null>(null);
  const [zoom, setZoom] = useState(100);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fill, setFill] = useState('#dcae5c');
  const [stroke, setStroke] = useState('#e9e6df');
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [pngScale, setPngScale] = useState(1);
  const [transparentPng, setTransparentPng] = useState(true);
  const [sheet, setSheet] = useState<'tools' | 'layers' | 'properties' | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState('');
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [imageHistoryState, setImageHistoryState] = useState<{ items: string[]; index: number }>({ items: [], index: -1 });
  const imageHistoryRef = useRef<{ items: string[]; index: number }>({ items: [], index: -1 });
  const [sourceRev, setSourceRev] = useState(0);
  const [bgColor, setBgColor] = useState('#ffffff');
  const [previewBgColor, setPreviewBgColor] = useState('#ffffff');
  const [bgTolerance, setBgTolerance] = useState(10);
  const [includeSimilarColors, setIncludeSimilarColors] = useState(true);
  const [bgContiguous, setBgContiguous] = useState(true);
  const [eraseSize, setEraseSize] = useState(24);
  const [picking, setPicking] = useState(false);
  const activeShape = shapes.find(s => s.id === selected);
  const aspect = imageSize.width / imageSize.height;
  const traceCount = shapes.filter(s => s.id.startsWith('trace-')).length;
  const advancedKey = JSON.stringify({ ...advancedSettings, colorCount: advancedSettings.colorCount ?? (traceProfile === 'max' ? 64 : 32), autoTraceSize, maxTraceSize });
  const updateAdvancedSetting = (key: keyof AdvancedTraceSettings, value: number | null) => setAdvancedSettings(current => ({ ...current, [key]: value }));
  const previewBackground = `rgba(${hexToRgb(previewBgColor).join(',')},${previewBgAlpha / 100})`;

  useEffect(() => { if (!message) return; const timer = window.setTimeout(() => setMessage(''), 3200); return () => clearTimeout(timer); }, [message]);
  useEffect(() => () => {
    for (const url of imageHistoryRef.current.items) if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }, []);

  const commit = useCallback((next: Shape[], nextSelected = selected, nextEraserPaths = eraserPaths) => {
    const state = { shapes: next, selected: nextSelected, eraserPaths: nextEraserPaths };
    history.current = [...history.current.slice(0, historyAt.current + 1), state].slice(-60);
    historyAt.current = history.current.length - 1;
    setShapes(next); setSelected(nextSelected); setEraserPaths(nextEraserPaths);
  }, [eraserPaths, selected]);
  const undo = () => { if (historyAt.current <= 0) return; historyAt.current--; const s = history.current[historyAt.current]; setShapes(s.shapes); setSelected(s.selected); setEraserPaths(s.eraserPaths); };
  const redo = () => { if (historyAt.current >= history.current.length - 1) return; historyAt.current++; const s = history.current[historyAt.current]; setShapes(s.shapes); setSelected(s.selected); setEraserPaths(s.eraserPaths); };
  const recordImageEdit = (nextUrl: string) => {
    const current = imageHistoryRef.current;
    const items = [...current.items.slice(0, current.index + 1), nextUrl].slice(-MAX_IMAGE_HISTORY);
    const retained = new Set(items);
    for (const url of current.items) if (url.startsWith('blob:') && !retained.has(url)) URL.revokeObjectURL(url);
    const history = { items, index: items.length - 1 };
    imageHistoryRef.current = history;
    setImageHistoryState(history);
    setImageUrl(nextUrl);
    setSourceRev(rev => rev + 1);
  };
  const undoImageEdit = () => {
    const current = imageHistoryRef.current;
    if (current.index <= 0) return;
    const index = current.index - 1;
    const history = { ...current, index };
    imageHistoryRef.current = history;
    setImageHistoryState(history);
    setImageUrl(current.items[index]);
    setSourceRev(rev => rev + 1);
    setMessage('Image edit undone.');
  };
  const redoImageEdit = () => {
    const current = imageHistoryRef.current;
    if (current.index >= current.items.length - 1) return;
    const index = current.index + 1;
    const history = { ...current, index };
    imageHistoryRef.current = history;
    setImageHistoryState(history);
    setImageUrl(current.items[index]);
    setSourceRev(rev => rev + 1);
    setMessage('Image edit redone.');
  };
  const chooseFile = (file?: File) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setMessage('Choose a PNG, JPG or WEBP image.'); return; }
    if (file.size > MAX_UPLOAD_BYTES) { setMessage('This image is over 25 MB. Choose a smaller file to keep editing responsive.'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      const img = new Image();
      img.onload = () => {
        if (img.naturalWidth * img.naturalHeight > MAX_IMAGE_PIXELS) { setMessage('This image has more than 50 megapixels. Choose a smaller image to avoid slowing down your device.'); return; }
        for (const url of imageHistoryRef.current.items) if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        const initialImageHistory = { items: [src], index: 0 };
        imageHistoryRef.current = initialImageHistory;
        setImageUrl(src); setOriginalUrl(src); setImageHistoryState(initialImageHistory); setSourceRev(0); setPicking(false); setSamplingArea(false); setSampleCursor(null); samplePinch.current = null; setImageName(file.name); setImageSize({ width: img.naturalWidth, height: img.naturalHeight }); setShowSource(true); setShapes([]); setEraserPaths([]); setSelected(null); setHasVectorResult(false); setLastTraceSettings(null); setDrawerOpen(false); history.current = [{ shapes: [], selected: null, eraserPaths: [] }]; historyAt.current = 0;
      };
      img.onerror = () => setMessage('That image could not be opened.');
      img.src = src;
    };
    reader.readAsDataURL(file);
  };
  const vectorize = async (silent = false) => {
    if (!imageUrl) { setMessage('Add an image before tracing.'); return; }
    const mode = traceMode === 'silhouette' ? 'silhouette' : traceProfile === 'max' ? 'max' : traceMode;
    const maxEdge = Math.max(imageSize.width, imageSize.height);
    const traceOptions = {
      tolerance: advancedSettings.tolerance,
      colorCount: advancedSettings.colorCount ?? undefined,
      lineTolerance: advancedSettings.lineTolerance,
      pathSimplification: advancedSettings.pathSimplification,
      curveSmoothness: advancedSettings.curveSmoothness,
      cornerThreshold: advancedSettings.cornerThreshold,
      minArea: advancedSettings.minArea,
      noiseReduction: advancedSettings.noiseReduction,
      ...(traceProfile === 'max' ? { maxTraceSize: autoTraceSize ? getSmartTraceSize(maxEdge) : maxTraceSize } : {}),
    };
    setBusy(true);
    setTraceProgress(0);
    try {
      const started = performance.now();
      const img = new Image(); img.src = imageUrl; await img.decode();
      const result = await traceInWorker(img, mode, traceOptions, setTraceProgress);
      setImageSize({ width: result.width, height: result.height });
      commit(result.regions, result.regions[0]?.id ?? null, []);
      setHasVectorResult(true);
      setLastTraceSettings({ profile: traceProfile, mode, tolerance: advancedSettings.tolerance, advancedKey });
      setShowSource(mode === 'silhouette');
      const kb = result.regions.reduce((total, region) => total + region.d.length, 0) / 1024;
      if (!silent) setMessage(`${result.regions.length} editable vector shapes · ${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB of path data · ${((performance.now() - started) / 1000).toFixed(1)}s.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not trace this image.'); }
    finally { setBusy(false); setTraceProgress(null); }
  };
  useEffect(() => {
    const current = `${sourceRev}:${traceProfile}:${traceMode}:${advancedKey}`;
    const settingsChanged = current !== lastPreviewSettings.current;
    lastPreviewSettings.current = current;
    if (!settingsChanged || !imageUrl || !hasVectorResult || editing) return;
    const timer = window.setTimeout(() => { void vectorize(true); }, 240);
    return () => window.clearTimeout(timer);
  }, [traceProfile, traceMode, advancedKey, sourceRev, imageUrl, hasVectorResult, editing]);
  const updateShape = (id: string, patch: Partial<Shape>) => {
    const next = shapes.map(shape => shape.id === id ? { ...shape, ...patch } as Shape : shape);
    history.current = [...history.current.slice(0, historyAt.current + 1), { shapes: next, selected, eraserPaths }].slice(-60);
    historyAt.current = history.current.length - 1;
    setShapes(next);
  };
  const finalizeEdit = () => {
    history.current = [...history.current.slice(0, historyAt.current + 1), { shapes, selected, eraserPaths }].slice(-60);
    historyAt.current = history.current.length - 1;
  };
  const deleteSelected = () => { if (selected) commit(shapes.filter(s => s.id !== selected), null); };
  const duplicateSelected = () => {
    if (!activeShape) return;
    const clone = { ...activeShape, id: makeId(), name: `${activeShape.name} copy`, x: activeShape.x + 12, y: activeShape.y + 12 };
    const nextEraserPaths = eraserPaths.map(path => path.targetIds.includes(activeShape.id)
      ? { ...path, targetIds: [...path.targetIds, clone.id] }
      : path);
    commit([...shapes, clone], clone.id, nextEraserPaths);
  };
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')) return;
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && key === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selected) {
          event.preventDefault();
          deleteSelected();
        }
        return;
      }
      const toolByKey: Record<string, Tool> = { v: 'select', h: 'hand', b: 'brush', p: 'brush', l: 'line', r: 'rect', c: 'circle', e: 'ellipse', x: 'eraser' };
      const nextTool = toolByKey[key];
      if (nextTool) {
        setTool(nextTool);
        setSheet(null);
        setDrawerOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [deleteSelected, redo, selected, undo]);
  const point = (event: PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * imageSize.width / rect.width, y: (event.clientY - rect.top) * imageSize.height / rect.height };
  };
  const startPointer = (event: PointerEvent<SVGSVGElement>) => {
    const target = (event.target as Element).closest('[data-shape-id]') as Element | null;
    const targetId = target?.getAttribute('data-shape-id') ?? null;
    const p = point(event);
    if (picking && imageUrl) {
      void sampleColor(imageUrl, p.x, p.y).then(color => { if (color) { setBgColor(color); setPicking(false); setMessage(`Picked ${color}. Press Remove background.`); } });
      return;
    }
    if (samplingArea && imageUrl) {
      void sampleBackgroundAt(p.x, p.y);
      return;
    }
    if (tool === 'hand') {
      gesture.current = { id: 'pan', x: pan.x, y: pan.y, startX: event.clientX, startY: event.clientY, type: tool };
      svgRef.current?.setPointerCapture(event.pointerId);
      return;
    }
    if (tool === 'select' && targetId) {
      setSelected(targetId);
      const s = shapes.find(shape => shape.id === targetId);
      gesture.current = { id: targetId, x: s?.x ?? 0, y: s?.y ?? 0, startX: p.x, startY: p.y, type: tool };
      svgRef.current?.setPointerCapture(event.pointerId); return;
    }
    if (tool === 'select') { setSelected(null); return; }
    if (tool === 'eraser') {
      const path = { id: makeId(), d: `M${p.x} ${p.y} L${p.x + 0.01} ${p.y}`, width: eraseSize, targetIds: shapes.map(shape => shape.id) };
      gesture.current = { id: path.id, x: p.x, y: p.y, startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, type: tool };
      setEraserPaths(current => [...current, path]);
      svgRef.current?.setPointerCapture(event.pointerId);
      return;
    }
    const fresh: Shape = tool === 'brush'
      ? { id: makeId(), name: 'Freehand path', kind: 'path', d: `M${p.x} ${p.y}`, fill: 'none', fillRule: 'evenodd', stroke, strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round', x: 0, y: 0, opacity: 1 }
      : { id: makeId(), name: tool === 'line' ? 'Line' : tool === 'circle' ? 'Circle' : tool === 'ellipse' ? 'Ellipse' : 'Rectangle', kind: tool === 'line' ? 'line' : tool === 'circle' || tool === 'ellipse' ? 'circle' : 'rect', x: p.x, y: p.y, w: 0, h: 0, fill: tool === 'line' ? 'none' : fill, stroke, strokeWidth, opacity: 1 };
    gesture.current = { id: fresh.id, x: p.x, y: p.y, startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, type: tool };
    setShapes(current => [...current, fresh]); setSelected(fresh.id); svgRef.current?.setPointerCapture(event.pointerId);
  };
  const movePointer = (event: PointerEvent<SVGSVGElement>) => {
    const g = gesture.current; if (!g) return;
    if (g.type === 'hand') {
      setPan({ x: g.x + event.clientX - g.startX, y: g.y + event.clientY - g.startY });
      return;
    }
    const p = point(event);
    if (g.type === 'select') updateShape(g.id, { x: g.x + p.x - g.startX, y: g.y + p.y - g.startY });
    else if (g.type === 'brush') {
      if (Math.hypot(p.x - (g.lastX ?? p.x), p.y - (g.lastY ?? p.y)) < 2) return;
      g.lastX = p.x;
      g.lastY = p.y;
      setShapes(current => current.map(s => s.id === g.id && s.kind === 'path' ? { ...s, d: `${s.d} L${p.x.toFixed(1)} ${p.y.toFixed(1)}` } : s));
    }
    else if (g.type === 'eraser') {
      if (Math.hypot(p.x - (g.lastX ?? p.x), p.y - (g.lastY ?? p.y)) < 1) return;
      g.lastX = p.x;
      g.lastY = p.y;
      setEraserPaths(current => current.map(path => path.id === g.id ? { ...path, d: `${path.d} L${p.x.toFixed(1)} ${p.y.toFixed(1)}` } : path));
    }
    else {
      const width = Math.abs(p.x - g.x), height = Math.abs(p.y - g.y);
      const size = Math.min(width, height);
      const endX = g.type === 'circle' ? g.x + Math.sign(p.x - g.x) * size : p.x;
      const endY = g.type === 'circle' ? g.y + Math.sign(p.y - g.y) * size : p.y;
      setShapes(current => current.map(s => s.id === g.id ? { ...s, x: Math.min(g.x, endX), y: Math.min(g.y, endY), w: Math.abs(endX - g.x), h: Math.abs(endY - g.y) } as Shape : s));
    }
  };
  const endPointer = () => { if (gesture.current) finalizeEdit(); gesture.current = null; };

  const svgMarkup = useCallback((maxEdge = SVG_EXPORT_MAX_EDGE) => {
    const short = (c: string) => (/^#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3$/i.test(c) ? `#${c[1]}${c[3]}${c[5]}` : c);
    const num = (v: number) => String(Math.round(v * 100) / 100);
    const styleOf = (shape: Shape) => {
      const attrs: string[] = [];
      if (shape.kind !== 'line' && shape.fill !== '#000000') attrs.push(`fill="${short(shape.fill)}"`);
      const width = shape.strokeWidth ?? 0;
      if (shape.stroke && shape.stroke !== 'none' && width > 0) {
        attrs.push(`stroke="${short(shape.stroke)}"`);
        if (width !== 1) attrs.push(`stroke-width="${num(width)}"`);
        if (shape.kind === 'path' && shape.strokeLinecap) attrs.push(`stroke-linecap="${shape.strokeLinecap}"`);
        if (shape.kind === 'path' && shape.strokeLinejoin) attrs.push(`stroke-linejoin="${shape.strokeLinejoin}"`);
      }
      if (shape.opacity !== 1) attrs.push(`opacity="${num(shape.opacity)}"`);
      if (shape.kind === 'path' && shape.fillRule === 'evenodd') attrs.push('fill-rule="evenodd"');
      return attrs.join(' ');
    };
    const element = (shape: Shape, style: string) => {
      const at = style ? ` ${style}` : '';
      if (shape.kind === 'path') return `<path${at}${shape.x || shape.y ? ` transform="translate(${num(shape.x)} ${num(shape.y)})"` : ''} d="${shape.d}"/>`;
      if (shape.kind === 'rect') return `<rect${at} x="${num(shape.x)}" y="${num(shape.y)}" width="${num(shape.w)}" height="${num(shape.h)}"/>`;
      if (shape.kind === 'circle') return `<ellipse${at} cx="${num(shape.x + shape.w / 2)}" cy="${num(shape.y + shape.h / 2)}" rx="${num(shape.w / 2)}" ry="${num(shape.h / 2)}"/>`;
      return `<line${at} x1="${num(shape.x)}" y1="${num(shape.y)}" x2="${num(shape.x + shape.w)}" y2="${num(shape.y + shape.h)}"/>`;
    };
    const scale = Math.min(1, maxEdge / Math.max(imageSize.width, imageSize.height));
    const outputWidth = num(imageSize.width * scale);
    const outputHeight = num(imageSize.height * scale);
    const maskDefinitions = new Map<string, string>();
    const maskForShape = (shapeId: string) => eraserPaths.filter(path => path.targetIds.includes(shapeId));
    const maskIdForPaths = (paths: EraserPath[]) => `vector-eraser-${paths.map(path => path.id).join('--')}`;
    let body = '';
    for (let i = 0; i < shapes.length;) {
      const style = styleOf(shapes[i]);
      const maskPaths = maskForShape(shapes[i].id);
      const maskSignature = maskPaths.map(path => path.id).join('--');
      let j = i + 1;
      while (j < shapes.length && styleOf(shapes[j]) === style && maskForShape(shapes[j].id).map(path => path.id).join('--') === maskSignature) j++;
      let groupBody = '';
      if (j - i > 1 && style && !style.includes('opacity=')) groupBody = `<g ${style}>${shapes.slice(i, j).map(shape => element(shape, '')).join('')}</g>`;
      else for (let k = i; k < j; k++) groupBody += element(shapes[k], style);
      const scaledGroup = scale === 1 ? groupBody : `<g transform="scale(${num(scale)})">${groupBody}</g>`;
      if (maskPaths.length > 0) {
        const maskId = maskIdForPaths(maskPaths);
        if (!maskDefinitions.has(maskId)) {
          const maskDrawing = maskPaths.map(path => `<path d="${path.d}" fill="none" stroke="black" stroke-width="${num(path.width * scale)}" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
          maskDefinitions.set(maskId, `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${outputWidth}" height="${outputHeight}"><rect x="0" y="0" width="${outputWidth}" height="${outputHeight}" fill="white"/>${scale === 1 ? maskDrawing : `<g transform="scale(${num(scale)})">${maskDrawing}</g>`}</mask>`);
        }
        body += `<g mask="url(#${maskId})">${scaledGroup}</g>`;
      } else {
        body += scaledGroup;
      }
      i = j;
    }
    const defs = maskDefinitions.size > 0 ? `<defs>${Array.from(maskDefinitions.values()).join('')}</defs>` : '';
    return `<svg xmlns="${SVG_NS}" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${outputWidth} ${outputHeight}">${defs}${body}</svg>`;
  }, [shapes, imageSize, eraserPaths]);
  const svgKb = useMemo(() => (hasVectorResult && !editing ? svgMarkup().length / 1024 : 0), [hasVectorResult, editing, svgMarkup]);
  const codeStatus = useMemo(() => {
    if (!codeStudio) return { error: null, paths: [] as { d: string; id: string | null }[] };
    const parsed = new DOMParser().parseFromString(svgCode, 'image/svg+xml');
    if (parsed.querySelector('parsererror')) return { error: 'The SVG/XML is invalid. Fix the markup to preview it and copy paths.', paths: [] as { d: string; id: string | null }[] };
    if (parsed.documentElement.localName !== 'svg' || parsed.documentElement.namespaceURI !== SVG_NS) {
      return { error: 'The document root must be an SVG element.', paths: [] as { d: string; id: string | null }[] };
    }
    const paths = Array.from(parsed.getElementsByTagNameNS(SVG_NS, 'path')).map(path => ({
      d: path.getAttribute('d') ?? '',
      id: path.getAttribute('id'),
    }));
    return { error: null, paths };
  }, [codeStudio, svgCode]);
  useEffect(() => {
    if (!codeStudio || codeStatus.error) {
      setCodePreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([svgCode], { type: 'image/svg+xml' }));
    setCodePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [codeStudio, svgCode, codeStatus.error]);
  const currentSvgMarkup = codeStudio ? svgCode : svgMarkup();
  const exportFile = async (type: 'svg' | 'png') => {
    const markup = type === 'png' && !codeStudio
      ? svgMarkup(Math.max(imageSize.width, imageSize.height))
      : currentSvgMarkup;
    if (type === 'svg') {
      const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${imageName.replace(/\.[^.]+$/, '') || 'vectorforge-artwork'}.svg`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    if (imageSize.width * imageSize.height * pngScale * pngScale > 32_000_000) {
      setMessage('This PNG export would be too large to render safely. Choose a lower resolution.');
      return;
    }
    const img = new Image(); img.src = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
    try {
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = imageSize.width * pngScale;
      canvas.height = imageSize.height * pngScale;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable.');
      if (!transparentPng) {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(result => result ? resolve(result) : reject(new Error('PNG encoding failed.')), 'image/png');
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vectorforge-artwork${pngScale > 1 ? `@${pngScale}x` : ''}.png`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    catch { setMessage('PNG export failed. Try SVG export instead.'); }
    finally { URL.revokeObjectURL(img.src); }
  };
  const copySvg = async () => { try { await navigator.clipboard.writeText(currentSvgMarkup); setMessage('SVG markup copied to clipboard.'); } catch { setMessage('Clipboard access is unavailable in this browser.'); } };
  const copyPath = async (pathData: string) => {
    try { await navigator.clipboard.writeText(pathData); setMessage('Path data copied to clipboard.'); }
    catch { setMessage('Clipboard access is unavailable in this browser.'); }
  };
  const addOpacityAnimation = () => {
    const parsed = new DOMParser().parseFromString(svgCode, 'image/svg+xml');
    if (parsed.querySelector('parsererror')) { setMessage('Fix the SVG/XML errors before adding an animation.'); return; }
    const paths = Array.from(parsed.getElementsByTagNameNS(SVG_NS, 'path'));
    const path = paths[selectedCodePath];
    if (!path) { setMessage('Select a path before adding an animation.'); return; }
    const animation = parsed.createElementNS(SVG_NS, 'animate');
    animation.setAttribute('attributeName', 'opacity');
    animation.setAttribute('values', '0;1;0');
    animation.setAttribute('dur', '2s');
    animation.setAttribute('repeatCount', 'indefinite');
    path.appendChild(animation);
    setSvgCode(new XMLSerializer().serializeToString(parsed.documentElement));
    setMessage('Opacity animation added to the selected path.');
  };
  const fit = () => { setZoom(100); setPan({ x: 0, y: 0 }); };
  const readPixels = async (url: string) => {
    const img = new Image(); img.src = url; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (!ctx) throw new Error('Canvas is unavailable in this browser.');
    ctx.drawImage(img, 0, 0);
    return { canvas, ctx, pixels: ctx.getImageData(0, 0, canvas.width, canvas.height) };
  };
  const applyBackgroundRemoval = async () => {
    if (!imageUrl) return;
    setBusy(true);
    try {
      const { canvas, ctx, pixels } = await readPixels(imageUrl);
      const removed = removeBackground(pixels, { color: hexToRgb(bgColor), tolerance: includeSimilarColors ? bgTolerance : 0, contiguous: bgContiguous });
      if (!removed) { setMessage('No pixels matched that color. Raise the tolerance or pick the color from the image.'); return; }
      ctx.putImageData(pixels, 0, 0);
      recordImageEdit(await canvasImageUrl(canvas)); setPicking(false);
      setMessage(`${Math.round(removed / (canvas.width * canvas.height) * 100)}% of the image removed. Trace again to update the vector.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Background removal failed.'); }
    finally { setBusy(false); }
  };
  const sampleBackgroundAt = async (x: number, y: number) => {
    if (!imageUrl) return;
    try {
      const sample = await sampleAreaColor(imageUrl, x, y, sampleRadius, sampleShape);
      if (!sample) { setMessage('The selected area contains no visible pixels. Choose another area.'); return; }
      setBgColor(sample.color);
      setBgTolerance(Math.min(150, Math.max(5, Math.round(sample.spread * 0.9))));
      setSamplingArea(false);
      setSampleCursor(null);
      samplePinch.current = null;
      setMessage(`Sampled ${sample.color} from a ${sampleRadius}px circular area. Adjust tolerance, then remove the background.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not sample the selected area.');
    }
  };
  const autoDetectBackground = async () => {
    if (!imageUrl) return;
    try { const { pixels } = await readPixels(imageUrl); setBgColor(rgbToHex(detectBackground(pixels))); setMessage('Background color detected from the image edges.'); }
    catch { setMessage('Could not read the image.'); }
  };
  const restoreOriginal = () => { if (originalUrl) { recordImageEdit(originalUrl); setMessage('Original image restored.'); } };
  const previewImagePoint = (el: HTMLImageElement, clientX: number, clientY: number) => {
    const rect = el.getBoundingClientRect();
    const fitScale = Math.min(rect.width / el.naturalWidth, rect.height / el.naturalHeight);
    const x = (clientX - rect.left - (rect.width - el.naturalWidth * fitScale) / 2) / fitScale;
    const y = (clientY - rect.top - (rect.height - el.naturalHeight * fitScale) / 2) / fitScale;
    if (x < 0 || y < 0 || x >= el.naturalWidth || y >= el.naturalHeight) return null;
    return { x, y };
  };
  const imageEraseGesture = useRef<{ points: { x: number; y: number }[]; size: number } | null>(null);
  const eraseImageStroke = async (points: { x: number; y: number }[], size: number) => {
    if (!imageUrl || points.length === 0) return;
    setBusy(true);
    try {
      const { canvas, ctx } = await readPixels(imageUrl);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = size;
      ctx.beginPath();
      if (points.length === 1) {
        ctx.arc(points[0].x, points[0].y, size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.moveTo(points[0].x, points[0].y);
        for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
        ctx.stroke();
      }
      recordImageEdit(await canvasImageUrl(canvas));
      setMessage(`Erased with a ${size}px brush.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not erase the selected image area.');
    } finally {
      setBusy(false);
    }
  };
  const startImageErase = (event: PointerEvent<HTMLImageElement>) => {
    if (tool !== 'eraser' || picking || samplingArea || !imageUrl || busy) return;
    const point = previewImagePoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    imageEraseGesture.current = { points: [point], size: eraseSize };
  };
  const moveImageErase = (event: PointerEvent<HTMLImageElement>) => {
    const stroke = imageEraseGesture.current;
    if (!stroke) return;
    const point = previewImagePoint(event.currentTarget, event.clientX, event.clientY);
    if (point) stroke.points.push(point);
  };
  const endImageErase = () => {
    const stroke = imageEraseGesture.current;
    imageEraseGesture.current = null;
    if (stroke) void eraseImageStroke(stroke.points, stroke.size);
  };
  const pickFromPreview = async (event: ReactMouseEvent<HTMLImageElement>) => {
    if ((!picking && !samplingArea) || !imageUrl) return;
    const el = event.currentTarget;
    const point = previewImagePoint(el, event.clientX, event.clientY);
    if (!point) return;
    if (samplingArea) {
      await sampleBackgroundAt(point.x, point.y);
      return;
    }
    const color = await sampleColor(imageUrl, point.x, point.y);
    if (color) { setBgColor(color); setPicking(false); setMessage(`Picked ${color}. Press Remove background.`); }
  };
  const updateSampleCursor = (el: HTMLImageElement, clientX: number, clientY: number, radius = samplingArea ? sampleRadius : eraseSize / 2, shape: 'circle' | 'rect' = samplingArea ? sampleShape : 'circle') => {
    const rect = el.getBoundingClientRect();
    const frameRect = el.closest('.preview-frame')?.getBoundingClientRect();
    const fitScale = Math.min(rect.width / el.naturalWidth, rect.height / el.naturalHeight);
    const left = (rect.width - el.naturalWidth * fitScale) / 2;
    const top = (rect.height - el.naturalHeight * fitScale) / 2;
    const x = clientX - rect.left - left;
    const y = clientY - rect.top - top;
    if (x < 0 || y < 0 || x > el.naturalWidth * fitScale || y > el.naturalHeight * fitScale) {
      setSampleCursor(null);
      return;
    }
    setSampleCursor({ left: (frameRect ? rect.left - frameRect.left : 0) + left + x, top: (frameRect ? rect.top - frameRect.top : 0) + top + y, radius: radius * fitScale, shape });
  };
  const trackSampleCursor = (event: ReactMouseEvent<HTMLImageElement>) => {
    if (samplingArea || tool === 'eraser') updateSampleCursor(event.currentTarget, event.clientX, event.clientY);
  };
  const changeSampleRadius = (radius: number) => {
    setSampleRadius(radius);
    if (sampleCursor && sampleRadius > 0) setSampleCursor(current => current ? { ...current, radius: current.radius * radius / sampleRadius } : null);
  };
  const startSamplePinch = (event: ReactTouchEvent<HTMLImageElement>) => {
    if (!samplingArea || event.touches.length === 0) return;
    if (event.touches.length === 1) {
      updateSampleCursor(event.currentTarget, event.touches[0].clientX, event.touches[0].clientY);
      return;
    }
    const [a, b] = [event.touches[0], event.touches[1]];
    samplePinch.current = { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), radius: sampleRadius };
    updateSampleCursor(event.currentTarget, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
  };
  const moveSamplePinch = (event: ReactTouchEvent<HTMLImageElement>) => {
    if (samplingArea && event.touches.length === 1 && !samplePinch.current) {
      updateSampleCursor(event.currentTarget, event.touches[0].clientX, event.touches[0].clientY);
      return;
    }
    const initial = samplePinch.current;
    if (!samplingArea || !initial || event.touches.length !== 2) return;
    event.preventDefault();
    const [a, b] = [event.touches[0], event.touches[1]];
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const radius = Math.max(4, Math.min(160, Math.round(initial.radius * distance / Math.max(1, initial.distance))));
    changeSampleRadius(radius);
    updateSampleCursor(event.currentTarget, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2, radius);
  };
  const groups = useMemo(() => [...shapes].reverse(), [shapes]);
  const erasersForShape = (shapeId: string) => eraserPaths.filter(path => path.targetIds.includes(shapeId));
  const editorMaskIdFor = (paths: EraserPath[]) => `editor-eraser-${paths.map(path => path.id).join('--')}`;
  const vectorShapeElements = shapes.map(shape => {
    const shapeErasers = erasersForShape(shape.id);
    const props = {
      'data-shape-id': shape.id,
      mask: shapeErasers.length > 0 ? `url(#${editorMaskIdFor(shapeErasers)})` : undefined,
      opacity: shape.opacity,
      style: {
        cursor: editing && tool === 'select' ? 'move' : editing ? 'crosshair' : 'default',
        touchAction: 'none' as const,
        ...(editing && shape.id === selected ? { filter: 'drop-shadow(0 0 1.5px #f0bd63)' } : {}),
      },
    };
    if (shape.kind === 'path') return <path key={shape.id} {...props} d={shape.d} transform={`translate(${shape.x} ${shape.y})`} fill={shape.fill} fillRule={shape.fillRule ?? 'nonzero'} stroke={shape.stroke ?? 'none'} strokeWidth={shape.strokeWidth ?? 0} strokeLinecap={shape.strokeLinecap} strokeLinejoin={shape.strokeLinejoin} />;
    if (shape.kind === 'rect') return <rect key={shape.id} {...props} x={shape.x} y={shape.y} width={shape.w} height={shape.h} fill={shape.fill} stroke={shape.stroke} strokeWidth={shape.strokeWidth} />;
    if (shape.kind === 'circle') return <ellipse key={shape.id} {...props} cx={shape.x + shape.w / 2} cy={shape.y + shape.h / 2} rx={Math.max(0, shape.w / 2)} ry={Math.max(0, shape.h / 2)} fill={shape.fill} stroke={shape.stroke} strokeWidth={shape.strokeWidth} />;
    return <line key={shape.id} {...props} x1={shape.x} y1={shape.y} x2={shape.x + shape.w} y2={shape.y + shape.h} stroke={shape.stroke} strokeWidth={shape.strokeWidth} />;
  });
  const editorMasks = new Map<string, EraserPath[]>();
  for (const shape of shapes) {
    const paths = erasersForShape(shape.id);
    if (paths.length > 0) editorMasks.set(editorMaskIdFor(paths), paths);
  }
  const vectorEraserOverlay = editorMasks.size > 0 ? <defs>{Array.from(editorMasks, ([id, paths]) => <mask key={id} id={id} maskUnits="userSpaceOnUse" x="0" y="0" width={imageSize.width} height={imageSize.height}>
    <rect x="0" y="0" width={imageSize.width} height={imageSize.height} fill="white" />
    {paths.map(path => <path key={path.id} d={path.d} fill="none" stroke="black" strokeWidth={path.width} strokeLinecap="round" strokeLinejoin="round" />)}
  </mask>)}</defs> : null;

  const backgroundPanel = imageUrl ? <BackgroundRemover
    color={bgColor}
    onColorChange={setBgColor}
    tolerance={bgTolerance}
    onToleranceChange={setBgTolerance}
    contiguous={bgContiguous}
    onContiguousChange={setBgContiguous}
    includeSimilarColors={includeSimilarColors}
    onIncludeSimilarColorsChange={setIncludeSimilarColors}
    picking={picking}
    onTogglePicking={() => { setPicking(value => !value); setSamplingArea(false); setSampleCursor(null); setTool('select'); }}
    samplingArea={samplingArea}
    onToggleSamplingArea={() => { setSamplingArea(value => !value); setPicking(false); setSampleCursor(null); samplePinch.current = null; setTool('select'); }}
    sampleRadius={sampleRadius}
    onSampleRadiusChange={changeSampleRadius}
    sampleShape={sampleShape}
    onSampleShapeChange={setSampleShape}
    erasing={!editing && tool === 'eraser'}
    allowPixelErase={!editing}
    onToggleErasing={() => { setTool(current => current === 'eraser' ? 'select' : 'eraser'); setPicking(false); setSamplingArea(false); setSampleCursor(null); }}
    eraseSize={eraseSize}
    onEraseSizeChange={setEraseSize}
    canUndoImage={imageHistoryState.index > 0}
    canRedoImage={imageHistoryState.index < imageHistoryState.items.length - 1}
    onUndoImage={undoImageEdit}
    onRedoImage={redoImageEdit}
    busy={busy}
    onDetect={() => void autoDetectBackground()}
    onRemove={() => void applyBackgroundRemoval()}
    onRestore={restoreOriginal}
    canRestore={Boolean(originalUrl && originalUrl !== imageUrl)}
  /> : null;

  const uploadPanel = <div className="panel-content">
    <div className="section-label">Source image</div>
    <button className="upload-zone" data-testid="button-upload-image" onClick={() => fileRef.current?.click()} disabled={busy}><ImagePlus size={19} style={{ margin: '0 auto 6px' }} /><br />{imageName || 'Choose or drop an image'}<br /><span className="mono" style={{ fontSize: 9 }}>PNG · JPG · WEBP · processed on device</span></button>
    {imageUrl && <><div className="field-row"><span>Preview source</span><input aria-label="Show source image" data-testid="toggle-source-preview" type="checkbox" checked={showSource} onChange={e => setShowSource(e.target.checked)} /></div></>}
    {backgroundPanel}
    <div style={{ height: 22 }} /><div className="section-label">Local tracing</div>
    <div className="mode-grid profile-grid">
      <button className={`mode-option ${traceProfile === 'normal' ? 'active' : ''}`} title="Normal tracing with three detail submodes" data-testid="profile-normal" onClick={() => setTraceProfile('normal')} disabled={busy}><span>Normal</span><small>3 submodes</small></button>
      <button className={`mode-option ${traceProfile === 'max' ? 'active' : ''}`} title="High-detail editable vector trace with a smart or manual trace-size cap" data-testid="profile-max" onClick={() => setTraceProfile('max')} disabled={busy}><span>Max</span><small>High detail</small></button>
    </div>
    <div className="section-label" style={{ marginTop: 15 }}>Conversion type</div>
    <div className="mode-grid profile-grid">
      <button className={`mode-option ${traceMode !== 'silhouette' ? 'active' : ''}`} data-testid="trace-type-color" onClick={() => setTraceMode(mode => mode === 'silhouette' ? 'stroke-fill' : mode)} disabled={busy}><span>Color trace</span><small>Color regions</small></button>
      <button className={`mode-option ${traceMode === 'silhouette' ? 'active' : ''}`} data-testid="trace-type-alpha" onClick={() => setTraceMode('silhouette')} disabled={busy}><span>Alpha outline</span><small>Transparent PNG</small></button>
    </div>
    {traceProfile === 'normal' && traceMode !== 'silhouette' ? <>
      <div className="section-label" style={{ marginTop: 15 }}>Normal detail</div>
      <div className="mode-grid">{normalModeOptions.map(option => <button key={option.mode} title={option.title} data-testid={`mode-${option.mode}`} className={`mode-option ${traceMode === option.mode ? 'active' : ''}`} onClick={() => setTraceMode(option.mode)} disabled={busy}><span>{option.label}</span><small>{option.detail}</small></button>)}</div>
      <div className="notice">{traceMode === 'stroke' ? 'Smooth black ink line art, like a Potrace drawing. Higher tolerance keeps only the stronger lines.' : traceMode === 'stroke-fill' ? 'Stacked color fills with dark ink outlines. Higher tolerance uses fewer colors and shapes.' : 'Nested gray layers preserve tonal depth. Higher tolerance uses fewer gray levels.'}</div>
    </> : traceMode === 'silhouette' ? <div className="notice max-mode-notice">Trace the visible-to-transparent boundary as an editable stroke. Edit mode keeps the original visible as a guide so you can add interior details.</div> : <div className="notice max-mode-notice">High-detail editable vectors run in the background with a smart or manual maximum trace size.</div>}
    <button className="btn btn-primary" data-testid="button-trace-image" style={{ width: '100%', marginTop: 15 }} onClick={() => void vectorize()} disabled={!imageUrl || busy}><ScanLine size={14} /> {busy ? traceProgress === null ? 'Tracing…' : `Tracing ${Math.round(traceProgress * 100)}%…` : 'Trace to editable shapes'}</button>
    <div style={{ height: 23 }} /><div className="section-label">Document</div>
    <div className="field-row"><span>Canvas</span><span className="small-value">{imageSize.width} × {imageSize.height}</span></div>
    <div className="section-label" style={{ marginTop: 18 }}>PNG export</div>
    <div className="field-row"><label htmlFor="png-scale">Resolution</label><select id="png-scale" className="control" aria-label="PNG export resolution" value={pngScale} onChange={e => setPngScale(Number(e.target.value))}><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option></select></div>
    <div className="field-row"><label htmlFor="png-transparent">Transparent background</label><input id="png-transparent" aria-label="Transparent PNG background" type="checkbox" checked={transparentPng} onChange={e => setTransparentPng(e.target.checked)} /></div>
    <button className="btn" style={{ width: '100%', marginTop: 4 }} onClick={() => { for (const url of imageHistoryRef.current.items) if (url.startsWith('blob:')) URL.revokeObjectURL(url); const emptyImageHistory = { items: [], index: -1 }; imageHistoryRef.current = emptyImageHistory; setShapes([]); setEraserPaths([]); setSelected(null); setImageUrl(null); setOriginalUrl(null); setImageHistoryState(emptyImageHistory); setImageName(''); setImageSize({ width: 640, height: 420 }); setHasVectorResult(false); setLastTraceSettings(null); setShowSource(true); setPan({ x: 0, y: 0 }); setZoom(100); history.current = [{ shapes: [], selected: null, eraserPaths: [] }]; historyAt.current = 0; }}>New blank document</button>
  </div>;

  const layersPanel = <><div className="panel-head"><span>Layers <span className="mono" style={{ color: '#838995' }}>{shapes.length}</span></span><button className="tool-btn" aria-label="Duplicate selected shape" data-testid="button-duplicate" disabled={!activeShape} onClick={duplicateSelected}><Copy size={14} /></button></div><div className="panel-content"><div className="layers-list">{groups.map((shape, i) => <button key={shape.id} data-testid={`layer-row-${shape.id}`} className={`layer-row ${selected === shape.id ? 'selected' : ''}`} onClick={() => setSelected(shape.id)}><span className="swatch" style={{ background: shape.fill === 'none' ? 'transparent' : shape.fill, borderColor: shape.stroke || '#555' }} /><span className="layer-name">{shape.name}</span><span className="mono" style={{ fontSize: 9, color: '#7d838d' }}>{groups.length - i}</span></button>)}
      {shapes.length === 0 && <div className="notice" style={{ marginTop: 4 }}>No vector shapes yet. Draw on the canvas or trace a source image into editable regions.</div>}</div></div></>;
  const propertiesPanel = <>{activeShape ? <><div className="panel-head"><span>Properties</span><div className="inline-actions"><button className="tool-btn" aria-label="Duplicate shape" data-testid="button-duplicate-property" onClick={duplicateSelected}><Copy size={14} /></button><button className="tool-btn" aria-label="Delete shape" data-testid="button-delete-shape" onClick={deleteSelected}><Trash2 size={14} /></button></div></div><div className="property-block"><div className="property-title">{activeShape.name}</div>
    <div className="field-row"><label htmlFor="fill-color">Fill</label><input id="fill-color" aria-label="Fill color" data-testid="input-fill-color" type="color" value={activeShape.fill === 'none' ? '#000000' : activeShape.fill} onChange={e => updateShape(activeShape.id, { fill: e.target.value })} /></div>
    <div className="field-row"><label htmlFor="stroke-color">Stroke</label><input id="stroke-color" aria-label="Stroke color" data-testid="input-stroke-color" type="color" value={activeShape.kind === 'path' ? ((activeShape as VectorRegion & { stroke?: string }).stroke ?? '#000000') : activeShape.stroke} onChange={e => updateShape(activeShape.id, { stroke: e.target.value } as Partial<Shape>)} /></div>
    <div className="field-row"><label htmlFor="stroke-width">Width</label><input id="stroke-width" aria-label="Stroke width" data-testid="input-stroke-width" type="range" min="0" max="24" value={activeShape.kind === 'path' ? ((activeShape as VectorRegion & { strokeWidth?: number }).strokeWidth ?? 0) : activeShape.strokeWidth} onChange={e => updateShape(activeShape.id, { strokeWidth: Number(e.target.value) } as Partial<Shape>)} /></div>
    <div className="field-row"><label htmlFor="opacity-range">Opacity</label><input id="opacity-range" aria-label="Opacity" data-testid="input-shape-opacity" type="range" min="0" max="100" value={activeShape.opacity * 100} onChange={e => updateShape(activeShape.id, { opacity: Number(e.target.value) / 100 })} /></div>
    <div className="field-row"><span>Position</span><span className="small-value">{Math.round(activeShape.x)}, {Math.round(activeShape.y)}</span></div>
    <button className="btn" style={{ width: '100%', marginTop: 8 }} onClick={deleteSelected}><Trash2 size={13} /> Delete shape</button>
  </div></> : <><div className="panel-head">Inspector</div><div className="panel-content"><div className="notice">Select a shape on the canvas or in Layers to edit its appearance and position.</div><div className="section-label" style={{ marginTop: 20 }}>Quick style</div><div className="field-row"><span>New fill</span><input aria-label="New shape fill color" data-testid="input-default-fill" type="color" value={fill} onChange={e => setFill(e.target.value)} /></div><div className="field-row"><span>New stroke</span><input aria-label="New shape stroke color" data-testid="input-default-stroke" type="color" value={stroke} onChange={e => setStroke(e.target.value)} /></div><div className="field-row"><span>Stroke width</span><input aria-label="New shape stroke width" type="range" min="0" max="24" value={strokeWidth} onChange={e => setStrokeWidth(Number(e.target.value))} /></div></div></>}</>;

  const codeStudioView = <section className="code-studio-page" aria-label="SVG Code Studio">
    <div className="code-studio-heading"><div><div className="section-label">Advanced SVG tools</div><h1>SVG Code Studio</h1><p>Edit SVG markup directly, inspect and copy individual paths, and add a looping opacity animation to a selected path.</p></div></div>
    <div className="code-studio-layout">
      <section className="code-editor-panel">
        <div className="panel-head"><label htmlFor="svg-code-editor">SVG markup</label><span className="mono">{svgCode.length.toLocaleString()} chars</span></div>
        <textarea id="svg-code-editor" className="svg-code-editor" aria-label="Editable SVG code" data-testid="svg-code-editor" spellCheck={false} wrap="soft" value={svgCode} onChange={event => setSvgCode(event.target.value)} />
        <div className="code-actions">
          <button className="btn" onClick={() => void copySvg()}><Copy size={13} />Copy SVG</button>
        <button className="btn" data-testid="button-prettify-svg" onClick={() => { try { setSvgCode(formatSvgMarkup(svgCode)); setMessage('SVG markup formatted.'); } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not format the SVG markup.'); } }} disabled={codeStatus.error !== null}><Code2 size={13} />Prettify code</button>
        <button className="btn btn-primary" onClick={addOpacityAnimation} disabled={codeStatus.error !== null || codeStatus.paths.length === 0}>Add opacity animation</button>
          <span className="notice">Animation uses SVG/SMIL and repeats every 2 seconds.</span>
        </div>
      </section>
      <div className="code-studio-side">
        <section className="code-preview-panel">
          <div className="panel-head">Live preview</div>
          <div className="code-preview-frame">
            {codeStatus.error ? <div className="notice code-error" role="alert">{codeStatus.error}</div> : codePreviewUrl ? <img src={codePreviewUrl} alt="Live SVG code preview" /> : <div className="notice">Preparing preview…</div>}
          </div>
        </section>
        <section className="code-paths-panel">
          <div className="panel-head">Paths <span className="mono">{codeStatus.paths.length}</span></div>
          <div className="code-path-list">
            {codeStatus.paths.map((path, index) => <div key={`${index}-${path.id ?? ''}`} className={`code-path-row ${index === selectedCodePath ? 'selected' : ''}`}>
              <button className="code-path-select" aria-pressed={index === selectedCodePath} onClick={() => setSelectedCodePath(index)}><span>Path {index + 1}</span><small>{path.id || `${path.d.length} data chars`}</small></button>
              <button className="btn icon-btn" aria-label={`Copy path ${index + 1}`} title="Copy path data" onClick={() => void copyPath(path.d)} disabled={!path.d}><Copy size={13} /></button>
            </div>)}
            {codeStatus.paths.length === 0 && <div className="notice">{codeStatus.error ? 'Paths will appear when the SVG markup is valid.' : 'This SVG contains no path elements yet.'}</div>}
          </div>
        </section>
      </div>
    </div>
  </section>;

  const converterView = <section className="converter-page">
    <section className="converter-intro">
      <div><div className="section-label">Local image to vector</div><h1>Convert an image to editable SVG</h1><p>Choose an image, pick a trace style, and see the original and vector result stacked below. Files stay on this device.</p></div>
      <span className="local-badge">IN-BROWSER · NO UPLOAD</span>
    </section>
    <section className="converter-controls" aria-label="Conversion settings">
      <div className="converter-settings">
        <div className="section-label">Trace quality</div>
        <div className="mode-grid profile-grid">
          <button className={`mode-option ${traceProfile === 'normal' ? 'active' : ''}`} title="Normal tracing with three detail submodes" data-testid="profile-normal" onClick={() => setTraceProfile('normal')} disabled={busy}><span>Normal</span><small>3 submodes</small></button>
          <button className={`mode-option ${traceProfile === 'max' ? 'active' : ''}`} title="High-detail editable vector trace with a smart or manual trace-size cap" data-testid="profile-max" onClick={() => setTraceProfile('max')} disabled={busy}><span>Max</span><small>High detail</small></button>
        </div>
        <div className="section-label submode-label">Conversion type</div>
        <div className="mode-grid profile-grid">
          <button className={`mode-option ${traceMode !== 'silhouette' ? 'active' : ''}`} data-testid="trace-type-color" onClick={() => setTraceMode(mode => mode === 'silhouette' ? 'stroke-fill' : mode)} disabled={busy}><span>Color trace</span><small>Color regions</small></button>
          <button className={`mode-option ${traceMode === 'silhouette' ? 'active' : ''}`} data-testid="trace-type-alpha" onClick={() => setTraceMode('silhouette')} disabled={busy}><span>Alpha outline</span><small>Transparent PNG</small></button>
        </div>
        {traceProfile === 'normal' && traceMode !== 'silhouette' ? <>
          <div className="section-label submode-label">Detail preset</div>
          <div className="mode-grid">{normalModeOptions.map(option => <button key={option.mode} title={option.title} data-testid={`mode-${option.mode}`} className={`mode-option ${traceMode === option.mode ? 'active' : ''}`} onClick={() => setTraceMode(option.mode)} disabled={busy}><span>{option.label}</span><small>{option.detail}</small></button>)}</div>
        </> : traceMode === 'silhouette' ? <div className="notice max-mode-notice">{traceProfile === 'max' ? 'High-detail alpha outline: traces the visible-to-transparent boundary and ignores internal colors.' : 'Traces the visible-to-transparent boundary and ignores internal colors.'} Edit mode keeps the original as a guide; use brush, rectangle, circle, or ellipse tools to add details.</div> : <div className="notice max-mode-notice">High-detail color trace with automatic sizing up to 5,000 px on the longest edge. Change to manual sizing in Advanced controls.</div>}
      </div>
      <div className="converter-action">
        <div className="section-label">Create vectors</div>
        <p>{traceMode === 'silhouette' ? 'Trace the alpha boundary of transparent artwork as one editable outline.' : traceProfile === 'max' ? 'High-detail editable vectors with a smart or manually capped trace size.' : traceMode === 'stroke' ? 'Black ink line art with smooth curves; the interiors stay transparent.' : traceMode === 'stroke-fill' ? 'Stacked color fills with dark ink outlines, grouped into compact paths.' : 'Black, white, and gray fills with tonal depth and fine detail.'}</p>
        <button className="btn btn-primary convert-button" data-testid="button-trace-image" onClick={() => void vectorize()} disabled={!imageUrl || busy}><ScanLine size={15} />{busy ? traceProgress === null ? 'Converting…' : `Tracing ${Math.round(traceProgress * 100)}%…` : hasVectorResult ? 'Update vector result' : 'Convert to SVG'}</button>
      </div>
      <AdvancedTraceControls
        settings={advancedSettings}
        onChange={updateAdvancedSetting}
        traceProfile={traceProfile}
        longestEdge={Math.max(imageSize.width, imageSize.height)}
        autoTraceSize={autoTraceSize}
        maxTraceSize={maxTraceSize}
        onAutoTraceSizeChange={setAutoTraceSize}
        onMaxTraceSizeChange={setMaxTraceSize}
        disabled={busy}
      />
    </section>
    {imageUrl && <section className="converter-bg" aria-label="Background remover">{backgroundPanel}</section>}
    <section className="preview-options" aria-label="Preview background setting">
      <input id="preview-background" type="color" aria-label="Preview background color" data-testid="input-preview-background" value={previewBgColor} onChange={event => setPreviewBgColor(event.target.value)} />
      <input type="range" aria-label="Preview background opacity" data-testid="input-preview-background-alpha" min="0" max="100" value={previewBgAlpha} onChange={event => setPreviewBgAlpha(Number(event.target.value))} />
    </section>
    <section className="preview-stack" aria-label="Live before and after preview" style={{ '--ar': `${imageSize.width} / ${imageSize.height}` } as CSSProperties}>
      <article className="preview-panel">
        <div className="preview-heading"><div><span className="preview-index">01</span><h2>Original image</h2></div><div className="preview-heading-actions"><span className="preview-badge">{imageName || 'SOURCE'}</span><button className="btn preview-choose-image" data-testid="converter-upload" onClick={() => fileRef.current?.click()} disabled={busy}><ImagePlus size={13} /><span>{imageUrl ? 'Change image' : 'Choose image'}</span></button></div></div>
        <div className="preview-frame" style={{ backgroundColor: previewBackground, backgroundImage: 'none' }}>
          {imageUrl ? <img src={imageUrl} alt="Original image selected for tracing" className={picking || samplingArea ? 'is-picking' : undefined} style={{ touchAction: samplingArea || tool === 'eraser' ? 'none' : 'auto', cursor: tool === 'eraser' ? 'none' : undefined }} onClick={event => void pickFromPreview(event)} onMouseMove={trackSampleCursor} onMouseLeave={() => setSampleCursor(null)} onPointerDown={startImageErase} onPointerMove={moveImageErase} onPointerUp={endImageErase} onPointerCancel={endImageErase} onTouchStart={startSamplePinch} onTouchMove={moveSamplePinch} onTouchEnd={() => { samplePinch.current = null; }} /> : <div className="preview-placeholder"><FileImage size={23} /><span>Choose an image to see it here</span></div>}
          {(samplingArea || tool === 'eraser') && sampleCursor && <div className={`sample-area-cursor ${tool === 'eraser' && !samplingArea ? 'eraser-cursor' : ''} ${sampleCursor.shape === 'rect' ? 'rect-cursor' : ''}`} style={{ left: sampleCursor.left, top: sampleCursor.top, width: sampleCursor.radius * 2, height: sampleCursor.radius * 2 }} />}
        </div>
      </article>
      <article className="preview-panel">
        <div className="preview-heading"><div><span className="preview-index">02</span><h2>Converted SVG</h2></div><span className="preview-badge">{hasVectorResult ? `${shapes.length} vector shapes` : 'LIVE PREVIEW'}</span></div>
        <div className="preview-frame" style={{ backgroundColor: previewBackground, backgroundImage: 'none' }}>
          {hasVectorResult ? <svg className="result-svg" xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${imageSize.width} ${imageSize.height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Converted vector preview">{vectorShapeElements}</svg> : <div className="preview-placeholder">{busy ? <ScanLine size={23} /> : <Shapes size={23} />}<span>{imageUrl ? 'Click “Convert to SVG” to generate editable vector shapes' : 'Your vector result will appear here'}</span></div>}
        </div>
        <div className="preview-footer" role="status">{hasVectorResult ? `Vector-only preview · ${svgKb > 0 ? `${svgKb < 10 ? svgKb.toFixed(1) : Math.round(svgKb)} KB SVG · ` : ''}${lastTraceSettings?.mode === 'silhouette' ? 'alpha outline' : lastTraceSettings?.profile === 'max' ? 'high-detail vector' : lastTraceSettings?.mode === 'stroke' ? 'strokes only' : lastTraceSettings?.mode === 'stroke-fill' ? 'stroke + color fill' : 'grayscale fills'} · ${imageSize.width} × ${imageSize.height} px${lastTraceSettings && (lastTraceSettings.profile !== traceProfile || lastTraceSettings.mode !== (traceMode === 'silhouette' ? 'silhouette' : traceProfile === 'max' ? 'max' : traceMode) || lastTraceSettings.advancedKey !== advancedKey) ? busy ? ' · updating preview…' : ' · preview updating shortly' : ''}` : 'No source image is included in the exported SVG.'}</div>
      </article>
    </section>
  </section>;

  return <main className="app-shell" onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }} onDrop={e => { e.preventDefault(); setDragging(false); chooseFile(e.dataTransfer.files[0]); }}>
    <input className="hidden-input" ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" data-testid="input-image-file" onChange={e => { chooseFile(e.target.files?.[0]); e.currentTarget.value = ''; }} disabled={busy} />
    <header className="topbar"><div className="brand"><span className="brand-mark"><Shapes size={16} /></span><span>VectorForge</span></div><span className="topbar-meta">{codeStudio ? 'SVG CODE STUDIO' : editing ? 'VECTOR EDITOR' : 'LOCAL IMAGE → SVG CONVERTER'}</span><div className="top-actions">
      {codeStudio ? <><button className="btn" aria-label="Copy SVG code" data-testid="button-copy-svg" onClick={() => void copySvg()}><Copy size={13} /><span>Copy SVG</span></button><button className="btn btn-primary" aria-label="Download SVG" data-testid="button-export-svg" onClick={() => void exportFile('svg')}><Download size={14} /><span>Download</span></button><button className="btn" onClick={() => setCodeStudio(false)}><Undo2 size={13} /><span>Back</span></button></> : <>
        {editing && <><button className="btn btn-quiet icon-btn" aria-label="Undo" data-testid="button-undo" disabled={historyAt.current <= 0} onClick={undo}><Undo2 size={16} /></button><button className="btn btn-quiet icon-btn" aria-label="Redo" data-testid="button-redo" disabled={historyAt.current >= history.current.length - 1} onClick={redo}><Redo2 size={16} /></button></>}
        {shapes.length > 0 && <><button className="btn" aria-label="Copy SVG code" data-testid="button-copy-svg" onClick={() => void copySvg()}><Copy size={13} /><span>Copy SVG</span></button><button className="btn" aria-label="View SVG code" data-testid="button-view-svg-code" onClick={() => { setSvgCode(svgMarkup()); setSelectedCodePath(0); setCodeStudio(true); }}><Code2 size={13} /><span>View SVG code</span></button><button className="btn" aria-label="Download PNG" title="Download PNG" data-testid="button-export-png" onClick={() => void exportFile('png')}><FileImage size={14} /><span>PNG</span></button><button className="btn btn-primary" aria-label="Download SVG" data-testid="button-export-svg" onClick={() => void exportFile('svg')}><Download size={14} /><span>SVG</span></button></>}
        <button className={`btn edit-mode-toggle ${editing ? '' : 'btn-primary'}`} aria-label={editing ? 'Back to converter' : 'Open vector editor'} disabled={!editing && !hasVectorResult} onClick={() => { setEditing(!editing); setSheet(null); setDrawerOpen(false); }}>{editing ? <><Undo2 size={13} /><span>Back</span></> : <><Layers size={13} /><span>Edit</span></>}</button>
      </>}
    </div></header>
    {codeStudio && codeStudioView}
    {!codeStudio && !editing && converterView}
    {!editing && dragging && <div className="converter-drop-overlay">Drop image to open locally</div>}
    {!codeStudio && editing && <><div className="workspace">
      <aside className="panel panel-left"><div className="panel-head"><span>Image & trace</span><Settings2 size={14} /></div>{uploadPanel}</aside>
      <section className="workspace-center">
        <div className="canvas-toolbar"><div className="toolset">
          {([{ id: 'select', icon: MousePointer2, title: 'Select' }, { id: 'hand', icon: Hand, title: 'Pan' }, { id: 'brush', icon: Brush, title: 'Brush' }, { id: 'rect', icon: Square, title: 'Rectangle' }, { id: 'circle', icon: Circle, title: 'Circle' }, { id: 'ellipse', icon: Circle, title: 'Ellipse' }, { id: 'line', icon: Minus, title: 'Line' }, { id: 'eraser', icon: Eraser, title: 'Eraser' }] as const).map(item => <button key={item.id} className={`tool-btn ${tool === item.id ? 'active' : ''}`} title={item.title} aria-label={item.title} data-testid={`tool-${item.id}`} onClick={() => setTool(item.id)}><item.icon size={16} /><span className="tool-label">{item.title}</span></button>)}
        </div><div className="toolset">{tool === 'eraser' && <label className="eraser-size-control" htmlFor="vector-eraser-size">Eraser {eraseSize}px<input id="vector-eraser-size" aria-label="Vector eraser size" data-testid="input-vector-eraser-size" type="range" min="1" max="100" value={eraseSize} onChange={event => setEraseSize(Number(event.target.value))} /></label>}<button className="tool-btn" aria-label="Zoom out" data-testid="button-zoom-out" onClick={() => setZoom(z => Math.max(25, z - 10))}><ZoomOut size={15} /></button><span className="mono" style={{ fontSize: 10, minWidth: 34, textAlign: 'center', color: '#aeb3bc' }}>{zoom}%</span><button className="tool-btn" aria-label="Zoom in" data-testid="button-zoom-in" onClick={() => setZoom(z => Math.min(200, z + 10))}><ZoomIn size={15} /></button><button className="tool-btn" aria-label="Fit canvas" data-testid="button-fit-canvas" onClick={fit}><Maximize2 size={15} /></button></div></div>
        <div className="canvas-area" onDragOver={e => { e.preventDefault(); setDragging(true); }} onDrop={e => { e.preventDefault(); setDragging(false); chooseFile(e.dataTransfer.files[0]); }}>
          <div className="canvas-board" style={{ width: `min(${Math.round(680 * zoom / 100)}px, 88%)`, aspectRatio: `${aspect}`, transform: `translate(${pan.x}px, ${pan.y}px)` }}>
            <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${imageSize.width} ${imageSize.height}`} preserveAspectRatio="none" style={{ touchAction: tool === 'select' ? 'none' : 'none', cursor: tool === 'select' ? 'default' : tool === 'hand' ? 'grab' : 'crosshair' }} onPointerDown={startPointer} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={endPointer}>
              {showSource && imageUrl && <image href={imageUrl} width={imageSize.width} height={imageSize.height} pointerEvents="none" />}
              {vectorShapeElements}
              {vectorEraserOverlay}
            </svg>
            {!imageUrl && shapes.length === 0 && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}><div className="mono" style={{ color: '#a6a7a2', fontSize: 10, letterSpacing: '.12em' }}>640 × 420 <span style={{ color: '#d3a650' }}>·</span> VECTOR ARTBOARD</div></div>}
          </div>
          {!imageUrl && shapes.length === 0 && <div style={{ position: 'absolute', bottom: 23, left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}><div className="drop-empty" style={{ pointerEvents: 'auto' }}><div className="drop-glyph"><FileImage size={21} /></div><h1>A clean canvas, or a starting image.</h1><p>Drop in raster artwork to trace its colors into editable vector regions, or start drawing right here.</p><button className="btn btn-primary" data-testid="button-open-image" onClick={() => fileRef.current?.click()}><Upload size={14} /> Open an image</button></div></div>}
          {dragging && <div style={{ position: 'absolute', inset: 10, border: '1px dashed #e6b45c', background: '#171a20c9', display: 'grid', placeItems: 'center', color: '#e6b45c', fontSize: 13, pointerEvents: 'none' }}>Drop image to open locally</div>}
        </div>
        <div className="canvas-status"><span>{imageName || 'Untitled vector document'}{traceCount > 0 ? `  ·  ${traceCount} traced regions` : ''}</span><span>{imageSize.width} × {imageSize.height} px</span></div>
      </section>
      <aside className="panel panel-right"><div style={{ borderBottom: '1px solid #2c3038' }}>{layersPanel}</div>{propertiesPanel}</aside>
    </div>
    <nav className="mobile-dock" aria-label="Mobile workspace tools">
      <button className={`dock-item ${sheet === 'tools' ? 'active' : ''}`} data-testid="mobile-open-tools" onClick={() => { setDrawerOpen(false); setSheet(current => current === 'tools' ? null : 'tools'); }}><Brush size={18} />Tools</button>
      <button className={`dock-item ${sheet === 'layers' ? 'active' : ''}`} data-testid="mobile-open-layers" onClick={() => { setDrawerOpen(false); setSheet(current => current === 'layers' ? null : 'layers'); }}><Layers size={18} />Layers</button>
      <button className={`dock-item ${drawerOpen ? 'active' : ''}`} aria-label="Open image and trace controls" aria-expanded={drawerOpen} aria-controls="image-trace-drawer" data-testid="mobile-open-trace" onClick={() => { setSheet(null); setDrawerOpen(open => !open); }}><ScanLine size={18} />Trace</button>
      <button className={`dock-item ${sheet === 'properties' ? 'active' : ''}`} data-testid="mobile-open-properties" onClick={() => { setDrawerOpen(false); setSheet(current => current === 'properties' ? null : 'properties'); }}><Settings2 size={18} />Edit</button>
    </nav>
    {drawerOpen && <><div className="backdrop drawer-backdrop" onClick={() => setDrawerOpen(false)} /><aside id="image-trace-drawer" className="panel panel-left mobile-sidebar-drawer" aria-label="Image and trace controls"><div className="panel-head"><span>Image & trace</span><button className="tool-btn" aria-label="Close image and trace drawer" onClick={() => setDrawerOpen(false)}><X size={16} /></button></div>{uploadPanel}</aside></>}
    {sheet && <><div className="backdrop" onClick={() => setSheet(null)} /><section className="mobile-sheet"><div className="sheet-grip" /><div className="panel-head"><span>{sheet === 'tools' ? 'Canvas tools' : sheet === 'layers' ? 'Layers & shapes' : 'Shape properties'}</span><button className="tool-btn" aria-label="Close panel" onClick={() => setSheet(null)}><X size={16} /></button></div>{sheet === 'tools' ? <><div className="mobile-tools-list">{([{ id: 'select', icon: MousePointer2, title: 'Select' }, { id: 'hand', icon: Hand, title: 'Pan' }, { id: 'brush', icon: Brush, title: 'Brush' }, { id: 'rect', icon: Square, title: 'Rectangle' }, { id: 'circle', icon: Circle, title: 'Circle' }, { id: 'ellipse', icon: Circle, title: 'Ellipse' }, { id: 'line', icon: Minus, title: 'Line' }, { id: 'eraser', icon: Eraser, title: 'Eraser' }] as const).map(item => <button key={item.id} className={`tool-btn ${tool === item.id ? 'active' : ''}`} aria-label={item.title} data-testid={`mobile-tool-${item.id}`} onClick={() => setTool(item.id)}><item.icon size={17} /><span className="tool-label">{item.title}</span></button>)}</div>{tool === 'eraser' && <div className="mobile-tool-style"><label className="field-row" htmlFor="mobile-vector-eraser-size"><span>Erase size</span><span className="small-value">{eraseSize}px</span></label><input id="mobile-vector-eraser-size" aria-label="Vector eraser size" type="range" min="1" max="100" value={eraseSize} onChange={event => setEraseSize(Number(event.target.value))} /></div>}</> : sheet === 'layers' ? <>{layersPanel}<div className="panel-content"><button className="btn" disabled={!activeShape} onClick={duplicateSelected}><Copy size={14} />Duplicate</button><button className="btn" disabled={!activeShape} style={{ marginLeft: 7 }} onClick={deleteSelected}><Trash2 size={14} />Delete</button></div></> : propertiesPanel}</section></>}
    </>}
    {message && <div role="status" data-testid="status-message" style={{ position: 'fixed', zIndex: 30, bottom: 78, left: '50%', transform: 'translateX(-50%)', background: '#292d33', color: '#eee8da', border: '1px solid #5a4b32', borderRadius: 7, padding: '10px 15px', fontSize: 12, boxShadow: '0 6px 26px #0007', maxWidth: '90vw' }}>{message}</div>}
  </main>;
}

export default App;