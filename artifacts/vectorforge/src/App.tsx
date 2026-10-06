import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Brush, Circle, Copy, Download, Eraser, FileImage, Hand, ImagePlus, Layers, Maximize2, Minus, MousePointer2, Redo2, ScanLine, Settings2, Shapes, Square, Trash2, Undo2, Upload, X, ZoomIn, ZoomOut } from 'lucide-react';
import { traceImage, type TraceMode, type VectorRegion } from './vectorize';

type Shape = VectorRegion | { id: string; name: string; kind: 'rect' | 'circle' | 'line'; x: number; y: number; w: number; h: number; fill: string; stroke: string; strokeWidth: number; opacity: number };
type Tool = 'select' | 'hand' | 'brush' | 'rect' | 'circle' | 'line';
type Snapshot = { shapes: Shape[]; selected: string | null };
type TraceProfile = 'normal' | 'max';
type NormalTraceMode = Exclude<TraceMode, 'max'>;
type TraceSettings = { profile: TraceProfile; mode: TraceMode; tolerance: number };
const normalModeOptions: { mode: NormalTraceMode; label: string; detail: string; title: string }[] = [
  { mode: 'stroke', label: 'Stroke only', detail: 'No fill', title: 'Trace region boundaries as strokes without fills' },
  { mode: 'stroke-fill', label: 'Stroke + Fill', detail: 'Color fills', title: 'Fill color regions and outline them with dark strokes' },
  { mode: 'grayscale', label: 'Grayscale fills', detail: 'Black to white', title: 'Use black, white, and gray fills to preserve tonal depth' },
];

const makeId = () => `shape-${Math.random().toString(36).slice(2, 9)}`;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;

function App() {
  const fileRef = useRef<HTMLInputElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<{ id: string; x: number; y: number; startX: number; startY: number; lastX?: number; lastY?: number; type: Tool } | null>(null);
  const history = useRef<Snapshot[]>([{ shapes: [], selected: null }]);
  const historyAt = useRef(0);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageName, setImageName] = useState('');
  const [imageSize, setImageSize] = useState({ width: 640, height: 420 });
  const [hasVectorResult, setHasVectorResult] = useState(false);
  const [lastTraceSettings, setLastTraceSettings] = useState<TraceSettings | null>(null);
  const [editing, setEditing] = useState(false);
  const [showSource, setShowSource] = useState(true);
  const [traceProfile, setTraceProfile] = useState<TraceProfile>('normal');
  const [traceMode, setTraceMode] = useState<NormalTraceMode>('stroke-fill');
  const [tolerance, setTolerance] = useState(22);
  const lastPreviewSettings = useRef('normal:normal:22');
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fill, setFill] = useState('#dcae5c');
  const [stroke, setStroke] = useState('#e9e6df');
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [pngScale, setPngScale] = useState(1);
  const [transparentPng, setTransparentPng] = useState(true);
  const [sheet, setSheet] = useState<'layers' | 'properties' | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState('');
  const activeShape = shapes.find(s => s.id === selected);
  const aspect = imageSize.width / imageSize.height;
  const traceCount = shapes.filter(s => s.id.startsWith('trace-')).length;
  const traceControlLabel = traceMode === 'grayscale' ? 'Grayscale tolerance' : 'Color tolerance';

  useEffect(() => { if (!message) return; const timer = window.setTimeout(() => setMessage(''), 3200); return () => clearTimeout(timer); }, [message]);

  const commit = useCallback((next: Shape[], nextSelected = selected) => {
    const state = { shapes: next, selected: nextSelected };
    history.current = [...history.current.slice(0, historyAt.current + 1), state].slice(-60);
    historyAt.current = history.current.length - 1;
    setShapes(next); setSelected(nextSelected);
  }, [selected]);
  const undo = () => { if (historyAt.current <= 0) return; historyAt.current--; const s = history.current[historyAt.current]; setShapes(s.shapes); setSelected(s.selected); };
  const redo = () => { if (historyAt.current >= history.current.length - 1) return; historyAt.current++; const s = history.current[historyAt.current]; setShapes(s.shapes); setSelected(s.selected); };
  const chooseFile = (file?: File) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setMessage('Choose a PNG, JPG or WEBP image.'); return; }
    if (file.size > MAX_UPLOAD_BYTES) { setMessage('This image is over 25 MB. Choose a smaller file to keep editing responsive.'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      const img = new Image();
      img.onload = () => {
        if (img.naturalWidth * img.naturalHeight > MAX_IMAGE_PIXELS) { setMessage('This image has more than 16 megapixels. Choose a smaller image to avoid slowing down your device.'); return; }
        setImageUrl(src); setImageName(file.name); setImageSize({ width: img.naturalWidth, height: img.naturalHeight }); setShowSource(true); setShapes([]); setSelected(null); setHasVectorResult(false); setLastTraceSettings(null); setDrawerOpen(false); history.current = [{ shapes: [], selected: null }]; historyAt.current = 0;
      };
      img.onerror = () => setMessage('That image could not be opened.');
      img.src = src;
    };
    reader.readAsDataURL(file);
  };
  const vectorize = async (silent = false) => {
    if (!imageUrl) { setMessage('Add an image before tracing.'); return; }
    setBusy(true);
    try {
      const img = new Image(); img.src = imageUrl; await img.decode();
      const mode = traceProfile === 'max' ? 'max' : traceMode;
      const result = traceImage(img, mode, tolerance);
      setImageSize({ width: result.width, height: result.height });
      commit(result.regions, result.regions[0]?.id ?? null);
      setHasVectorResult(true);
      setLastTraceSettings({ profile: traceProfile, mode, tolerance });
      setShowSource(false);
      if (!silent) setMessage(`${result.regions.length} editable vector shapes created.${result.truncated ? ' The 400-shape safety limit applies to Normal mode; Max mode traces without that cap.' : traceProfile === 'max' ? ' Max mode keeps full-resolution colors; large SVGs may take longer to open.' : ''}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not trace this image.'); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    const current = traceProfile === 'max' ? 'max' : `normal:${traceMode}:${tolerance}`;
    const settingsChanged = current !== lastPreviewSettings.current;
    lastPreviewSettings.current = current;
    if (!settingsChanged || !imageUrl || !hasVectorResult || editing) return;
    const timer = window.setTimeout(() => { void vectorize(true); }, 240);
    return () => window.clearTimeout(timer);
  }, [traceProfile, traceMode, tolerance, imageUrl, hasVectorResult, editing]);
  const updateShape = (id: string, patch: Partial<Shape>) => {
    const next = shapes.map(shape => shape.id === id ? { ...shape, ...patch } as Shape : shape);
    history.current = [...history.current.slice(0, historyAt.current + 1), { shapes: next, selected }].slice(-60);
    historyAt.current = history.current.length - 1;
    setShapes(next);
  };
  const finalizeEdit = () => {
    history.current = [...history.current.slice(0, historyAt.current + 1), { shapes, selected }].slice(-60);
    historyAt.current = history.current.length - 1;
  };
  const deleteSelected = () => { if (selected) commit(shapes.filter(s => s.id !== selected), null); };
  const duplicateSelected = () => {
    if (!activeShape) return;
    const clone = { ...activeShape, id: makeId(), name: `${activeShape.name} copy`, x: activeShape.x + 12, y: activeShape.y + 12 };
    commit([...shapes, clone], clone.id);
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
      const toolByKey: Record<string, Tool> = { v: 'select', h: 'hand', b: 'brush', p: 'brush', l: 'line', r: 'rect', c: 'circle' };
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
    const fresh: Shape = tool === 'brush'
      ? { id: makeId(), name: 'Freehand path', kind: 'path', d: `M${p.x} ${p.y}`, fill: 'none', fillRule: 'evenodd', x: 0, y: 0, opacity: 1 }
      : { id: makeId(), name: tool === 'line' ? 'Line' : tool === 'circle' ? 'Ellipse' : 'Rectangle', kind: tool === 'line' ? 'line' : tool === 'circle' ? 'circle' : 'rect', x: p.x, y: p.y, w: 0, h: 0, fill: tool === 'line' ? 'none' : fill, stroke, strokeWidth, opacity: 1 };
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
    else setShapes(current => current.map(s => s.id === g.id ? { ...s, x: Math.min(g.x, p.x), y: Math.min(g.y, p.y), w: Math.abs(p.x - g.x), h: Math.abs(p.y - g.y) } as Shape : s));
  };
  const endPointer = () => { if (gesture.current) finalizeEdit(); gesture.current = null; };

  const svgMarkup = useCallback(() => {
    const shapesMarkup = shapes.map(shape => {
      const attrs = `data-shape-id="${shape.id}" opacity="${shape.opacity}"`;
      if (shape.kind === 'path') return `<path ${attrs} d="${shape.d}" fill="${shape.fill}" fill-rule="${shape.fillRule ?? 'nonzero'}" stroke="${shape.stroke ?? 'none'}" stroke-width="${shape.strokeWidth ?? 0}" transform="translate(${shape.x} ${shape.y})"/>`;
      if (shape.kind === 'rect') return `<rect ${attrs} x="${shape.x}" y="${shape.y}" width="${shape.w}" height="${shape.h}" fill="${shape.fill}" stroke="${shape.stroke}" stroke-width="${shape.strokeWidth}"/>`;
      if (shape.kind === 'circle') return `<ellipse ${attrs} cx="${shape.x + shape.w / 2}" cy="${shape.y + shape.h / 2}" rx="${shape.w / 2}" ry="${shape.h / 2}" fill="${shape.fill}" stroke="${shape.stroke}" stroke-width="${shape.strokeWidth}"/>`;
      return `<line ${attrs} x1="${shape.x}" y1="${shape.y}" x2="${shape.x + shape.w}" y2="${shape.y + shape.h}" fill="none" stroke="${shape.stroke}" stroke-width="${shape.strokeWidth}"/>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${imageSize.width}" height="${imageSize.height}" viewBox="0 0 ${imageSize.width} ${imageSize.height}">${shapesMarkup}</svg>`;
  }, [shapes, imageSize]);
  const exportFile = async (type: 'svg' | 'png') => {
    const markup = svgMarkup();
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
  const copySvg = async () => { try { await navigator.clipboard.writeText(svgMarkup()); setMessage('SVG markup copied to clipboard.'); } catch { setMessage('Clipboard access is unavailable in this browser.'); } };
  const fit = () => { setZoom(100); setPan({ x: 0, y: 0 }); };
  const removeLightBackground = async () => {
    if (!imageUrl) return;
    const img = new Image(); img.src = imageUrl; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (!ctx) return;
    ctx.drawImage(img, 0, 0); const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < data.data.length; i += 4) if (data.data[i] > 242 && data.data[i + 1] > 242 && data.data[i + 2] > 242) data.data[i + 3] = 0;
    ctx.putImageData(data, 0, 0); setImageUrl(canvas.toDataURL('image/png')); setMessage('Near-white pixels removed from the source image.');
  };
  const groups = useMemo(() => [...shapes].reverse(), [shapes]);
  const vectorShapeElements = shapes.map(shape => {
    const props = {
      key: shape.id,
      'data-shape-id': shape.id,
      opacity: shape.opacity,
      style: {
        cursor: editing && tool === 'select' ? 'move' : editing ? 'crosshair' : 'default',
        touchAction: 'none' as const,
        ...(editing && shape.id === selected ? { filter: 'drop-shadow(0 0 1.5px #f0bd63)' } : {}),
      },
    };
    if (shape.kind === 'path') return <path {...props} d={shape.d} transform={`translate(${shape.x} ${shape.y})`} fill={shape.fill} fillRule={shape.fillRule ?? 'nonzero'} stroke={shape.stroke ?? 'none'} strokeWidth={shape.strokeWidth ?? 0} />;
    if (shape.kind === 'rect') return <rect {...props} x={shape.x} y={shape.y} width={shape.w} height={shape.h} fill={shape.fill} stroke={shape.stroke} strokeWidth={shape.strokeWidth} />;
    if (shape.kind === 'circle') return <ellipse {...props} cx={shape.x + shape.w / 2} cy={shape.y + shape.h / 2} rx={Math.max(0, shape.w / 2)} ry={Math.max(0, shape.h / 2)} fill={shape.fill} stroke={shape.stroke} strokeWidth={shape.strokeWidth} />;
    return <line {...props} x1={shape.x} y1={shape.y} x2={shape.x + shape.w} y2={shape.y + shape.h} stroke={shape.stroke} strokeWidth={shape.strokeWidth} />;
  });

  const uploadPanel = <div className="panel-content">
    <div className="section-label">Source image</div>
    <button className="upload-zone" data-testid="button-upload-image" onClick={() => fileRef.current?.click()}><ImagePlus size={19} style={{ margin: '0 auto 6px' }} /><br />{imageName || 'Choose or drop an image'}<br /><span className="mono" style={{ fontSize: 9 }}>PNG · JPG · WEBP · processed on device</span></button>
    {imageUrl && <><div className="field-row"><span>Preview source</span><input aria-label="Show source image" data-testid="toggle-source-preview" type="checkbox" checked={showSource} onChange={e => setShowSource(e.target.checked)} /></div><button className="btn" style={{ width: '100%' }} onClick={() => void removeLightBackground()}><Eraser size={13} /> Remove near-white background</button><div className="notice">Simple edge-independent white removal. Restore by reselecting the original image.</div></>}
    <div style={{ height: 22 }} /><div className="section-label">Local tracing</div>
    <div className="mode-grid profile-grid">
      <button className={`mode-option ${traceProfile === 'normal' ? 'active' : ''}`} title="Normal tracing with three detail submodes" data-testid="profile-normal" onClick={() => setTraceProfile('normal')}><span>Normal</span><small>3 submodes</small></button>
      <button className={`mode-option ${traceProfile === 'max' ? 'active' : ''}`} title="Temporarily paused while we choose a safe output for complex images" data-testid="profile-max" disabled><span>Max</span><small>Fixing</small></button>
    </div>
    {traceProfile === 'normal' ? <>
      <div className="section-label" style={{ marginTop: 15 }}>Normal detail</div>
      <div className="mode-grid">{normalModeOptions.map(option => <button key={option.mode} title={option.title} data-testid={`mode-${option.mode}`} className={`mode-option ${traceMode === option.mode ? 'active' : ''}`} onClick={() => setTraceMode(option.mode)}><span>{option.label}</span><small>{option.detail}</small></button>)}</div>
      <div className="field-row"><label htmlFor="detail-range">{traceControlLabel}</label><span className="small-value">{tolerance}</span></div><input id="detail-range" aria-label={traceControlLabel} data-testid="input-color-tolerance" style={{ width: '100%', accentColor: '#e6b45c' }} type="range" min="0" max="70" value={tolerance} onChange={e => setTolerance(Number(e.target.value))} />
      <div className="notice">{traceMode === 'stroke' ? 'Dark outlines trace region boundaries; the interiors remain unfilled.' : traceMode === 'stroke-fill' ? 'Color-filled vector regions with dark outlines.' : 'Black, white, and gray vector fills preserve more tonal depth than a silhouette.'}</div>
    </> : <div className="notice max-mode-notice">Exact source colors at full resolution. No color tolerance reduction, simplification, or 400-region cap. Large images—especially photos—can take longer and create very large SVGs.</div>}
    <button className="btn btn-primary" data-testid="button-trace-image" style={{ width: '100%', marginTop: 15 }} onClick={() => void vectorize()} disabled={!imageUrl || busy}><ScanLine size={14} /> {busy ? 'Tracing pixels…' : 'Trace to editable shapes'}</button>
    <div style={{ height: 23 }} /><div className="section-label">Document</div>
    <div className="field-row"><span>Canvas</span><span className="small-value">{imageSize.width} × {imageSize.height}</span></div>
    <div className="section-label" style={{ marginTop: 18 }}>PNG export</div>
    <div className="field-row"><label htmlFor="png-scale">Resolution</label><select id="png-scale" className="control" aria-label="PNG export resolution" value={pngScale} onChange={e => setPngScale(Number(e.target.value))}><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option></select></div>
    <div className="field-row"><label htmlFor="png-transparent">Transparent background</label><input id="png-transparent" aria-label="Transparent PNG background" type="checkbox" checked={transparentPng} onChange={e => setTransparentPng(e.target.checked)} /></div>
    <button className="btn" style={{ width: '100%', marginTop: 4 }} onClick={() => { setShapes([]); setSelected(null); setImageUrl(null); setImageName(''); setImageSize({ width: 640, height: 420 }); setHasVectorResult(false); setLastTraceSettings(null); setShowSource(true); setPan({ x: 0, y: 0 }); setZoom(100); history.current = [{ shapes: [], selected: null }]; historyAt.current = 0; }}>New blank document</button>
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

  const converterView = <section className="converter-page">
    <section className="converter-intro">
      <div><div className="section-label">Local image to vector</div><h1>Convert an image to editable SVG</h1><p>Choose an image, pick a trace style, and see the original and vector result stacked below. Files stay on this device.</p></div>
      <span className="local-badge">IN-BROWSER · NO UPLOAD</span>
    </section>
    <section className="converter-controls" aria-label="Conversion settings">
      <div className="converter-upload">
        <div className="section-label">1. Source image</div>
        <button className="upload-zone converter-upload-button" data-testid="converter-upload" onClick={() => fileRef.current?.click()}><ImagePlus size={20} /><span>{imageName || 'Choose PNG, JPG or WEBP'}</span><small>{imageUrl ? `${imageSize.width} × ${imageSize.height} px` : 'or drop an image anywhere on this page'}</small></button>
      </div>
      <div className="converter-settings">
        <div className="section-label">2. Trace mode</div>
        <div className="mode-grid profile-grid">
          <button className={`mode-option ${traceProfile === 'normal' ? 'active' : ''}`} title="Normal tracing with three detail submodes" data-testid="profile-normal" onClick={() => setTraceProfile('normal')}><span>Normal</span><small>3 submodes</small></button>
          <button className={`mode-option ${traceProfile === 'max' ? 'active' : ''}`} title="Temporarily paused while we choose a safe output for complex images" data-testid="profile-max" disabled><span>Max</span><small>Fixing</small></button>
        </div>
        {traceProfile === 'normal' ? <>
          <div className="section-label submode-label">Detail preset</div>
          <div className="mode-grid">{normalModeOptions.map(option => <button key={option.mode} title={option.title} data-testid={`mode-${option.mode}`} className={`mode-option ${traceMode === option.mode ? 'active' : ''}`} onClick={() => setTraceMode(option.mode)}><span>{option.label}</span><small>{option.detail}</small></button>)}</div>
          <div className="field-row"><label htmlFor="converter-tolerance">{traceControlLabel}</label><span className="small-value">{tolerance}</span></div>
          <input id="converter-tolerance" aria-label={traceControlLabel} data-testid="converter-tolerance" style={{ width: '100%', accentColor: '#e6b45c' }} type="range" min="0" max="70" value={tolerance} onChange={e => setTolerance(Number(e.target.value))} />
        </> : <div className="notice max-mode-notice">Exact source colors at full resolution. No tolerance reduction, simplification, or 400-region cap. Large files can take longer to trace.</div>}
      </div>
      <div className="converter-action">
        <div className="section-label">3. Create vectors</div>
        <p>{traceProfile === 'max' ? 'Exact-color, full-resolution vector trace with no region cap.' : traceMode === 'stroke' ? 'Outline only; the interiors stay transparent.' : traceMode === 'stroke-fill' ? 'Color-filled editable vectors with dark outlines.' : 'Black, white, and gray fills with tonal depth and fine detail.'}</p>
        <button className="btn btn-primary convert-button" data-testid="button-trace-image" onClick={() => void vectorize()} disabled={!imageUrl || busy}><ScanLine size={15} />{busy ? 'Converting…' : hasVectorResult ? 'Update vector result' : 'Convert to SVG'}</button>
      </div>
    </section>
    <section className="preview-stack" aria-label="Live before and after preview">
      <article className="preview-panel">
        <div className="preview-heading"><div><span className="preview-index">01</span><h2>Original image</h2></div><span className="preview-badge">{imageName || 'SOURCE'}</span></div>
        <div className="preview-frame">
          {imageUrl ? <img src={imageUrl} alt="Original image selected for tracing" /> : <div className="preview-placeholder"><FileImage size={23} /><span>Choose an image to see it here</span></div>}
        </div>
      </article>
      <article className="preview-panel">
        <div className="preview-heading"><div><span className="preview-index">02</span><h2>Converted SVG</h2></div><span className="preview-badge">{hasVectorResult ? `${shapes.length} vector shapes` : 'LIVE PREVIEW'}</span></div>
        <div className="preview-frame">
          {hasVectorResult ? <svg className="result-svg" xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${imageSize.width} ${imageSize.height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Converted vector preview">{vectorShapeElements}</svg> : <div className="preview-placeholder">{busy ? <ScanLine size={23} /> : <Shapes size={23} />}<span>{imageUrl ? 'Click “Convert to SVG” to generate editable vector shapes' : 'Your vector result will appear here'}</span></div>}
        </div>
        <div className="preview-footer" role="status">{hasVectorResult ? `Vector-only preview · ${lastTraceSettings?.profile === 'max' ? 'max fidelity, exact colors' : lastTraceSettings?.mode === 'stroke' ? 'strokes only' : lastTraceSettings?.mode === 'stroke-fill' ? 'stroke + color fill' : 'grayscale fills'} · ${imageSize.width} × ${imageSize.height} px${lastTraceSettings && (lastTraceSettings.profile !== traceProfile || (traceProfile === 'normal' && (lastTraceSettings.mode !== traceMode || lastTraceSettings.tolerance !== tolerance))) ? busy ? ' · updating preview…' : ' · preview updating shortly' : ''}` : 'No source image is included in the exported SVG.'}</div>
      </article>
    </section>
  </section>;

  return <main className="app-shell" onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }} onDrop={e => { e.preventDefault(); setDragging(false); chooseFile(e.dataTransfer.files[0]); }}>
    <input className="hidden-input" ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" data-testid="input-image-file" onChange={e => { chooseFile(e.target.files?.[0]); e.currentTarget.value = ''; }} />
    <header className="topbar"><div className="brand"><span className="brand-mark"><Shapes size={16} /></span><span>VectorForge</span></div><span className="topbar-meta">{editing ? 'VECTOR EDITOR' : 'LOCAL IMAGE → SVG CONVERTER'}</span><div className="top-actions">
      {editing && <><button className="btn btn-quiet icon-btn" aria-label="Undo" data-testid="button-undo" disabled={historyAt.current <= 0} onClick={undo}><Undo2 size={16} /></button><button className="btn btn-quiet icon-btn" aria-label="Redo" data-testid="button-redo" disabled={historyAt.current >= history.current.length - 1} onClick={redo}><Redo2 size={16} /></button></>}
      {shapes.length > 0 && <><button className="btn" aria-label="Copy SVG code" data-testid="button-copy-svg" onClick={() => void copySvg()}><Copy size={13} /><span>Copy SVG</span></button><button className="btn" aria-label="Download PNG" title="Download PNG" data-testid="button-export-png" onClick={() => void exportFile('png')}><FileImage size={14} /><span>PNG</span></button><button className="btn btn-primary" aria-label="Download SVG" data-testid="button-export-svg" onClick={() => void exportFile('svg')}><Download size={14} /><span>SVG</span></button></>}
      {!editing && <button className="btn" aria-label="Choose another image" onClick={() => fileRef.current?.click()}><ImagePlus size={14} /><span>Choose image</span></button>}
      <button className={`btn edit-mode-toggle ${editing ? '' : 'btn-primary'}`} aria-label={editing ? 'Back to converter' : 'Open vector editor'} disabled={!editing && !hasVectorResult} onClick={() => { setEditing(!editing); setSheet(null); setDrawerOpen(false); }}>{editing ? <><Undo2 size={13} /><span>Back</span></> : <><Layers size={13} /><span>Edit</span></>}</button>
    </div></header>
    {!editing && converterView}
    {!editing && dragging && <div className="converter-drop-overlay">Drop image to open locally</div>}
    {editing && <><div className="workspace">
      <aside className="panel panel-left"><div className="panel-head"><span>Image & trace</span><Settings2 size={14} /></div>{uploadPanel}</aside>
      <section className="workspace-center">
        <div className="canvas-toolbar"><div className="toolset">
          {([{ id: 'select', icon: MousePointer2, title: 'Select' }, { id: 'hand', icon: Hand, title: 'Pan' }, { id: 'brush', icon: Brush, title: 'Freehand' }, { id: 'rect', icon: Square, title: 'Rectangle' }, { id: 'circle', icon: Circle, title: 'Ellipse' }, { id: 'line', icon: Minus, title: 'Line' }] as const).map(item => <button key={item.id} className={`tool-btn ${tool === item.id ? 'active' : ''}`} title={item.title} aria-label={item.title} data-testid={`tool-${item.id}`} onClick={() => setTool(item.id)}><item.icon size={16} /><span className="tool-label">{item.title}</span></button>)}
        </div><div className="toolset"><button className="tool-btn" aria-label="Zoom out" data-testid="button-zoom-out" onClick={() => setZoom(z => Math.max(25, z - 10))}><ZoomOut size={15} /></button><span className="mono" style={{ fontSize: 10, minWidth: 34, textAlign: 'center', color: '#aeb3bc' }}>{zoom}%</span><button className="tool-btn" aria-label="Zoom in" data-testid="button-zoom-in" onClick={() => setZoom(z => Math.min(200, z + 10))}><ZoomIn size={15} /></button><button className="tool-btn" aria-label="Fit canvas" data-testid="button-fit-canvas" onClick={fit}><Maximize2 size={15} /></button></div></div>
        <div className="canvas-area" onDragOver={e => { e.preventDefault(); setDragging(true); }} onDrop={e => { e.preventDefault(); setDragging(false); chooseFile(e.dataTransfer.files[0]); }}>
          <div className="canvas-board" style={{ width: `min(${Math.round(680 * zoom / 100)}px, 88%)`, aspectRatio: `${aspect}`, transform: `translate(${pan.x}px, ${pan.y}px)` }}>
            <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${imageSize.width} ${imageSize.height}`} preserveAspectRatio="none" style={{ touchAction: tool === 'select' ? 'none' : 'none', cursor: tool === 'select' ? 'default' : tool === 'hand' ? 'grab' : 'crosshair' }} onPointerDown={startPointer} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={endPointer}>
              {showSource && imageUrl && <image href={imageUrl} width={imageSize.width} height={imageSize.height} pointerEvents="none" />}
              {vectorShapeElements}
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
      <button className={`dock-item ${tool === 'select' ? 'active' : ''}`} data-testid="mobile-tool-select" onClick={() => { setTool('select'); setSheet(null); setDrawerOpen(false); }}><MousePointer2 size={18} />Select</button>
      <button className={`dock-item ${tool === 'brush' ? 'active' : ''}`} data-testid="mobile-tool-draw" onClick={() => { setTool('brush'); setSheet(null); setDrawerOpen(false); }}><Brush size={18} />Draw</button>
      <button className={`dock-item ${sheet === 'layers' ? 'active' : ''}`} data-testid="mobile-open-layers" onClick={() => { setDrawerOpen(false); setSheet(current => current === 'layers' ? null : 'layers'); }}><Layers size={18} />Layers</button>
      <button className={`dock-item ${drawerOpen ? 'active' : ''}`} aria-label="Open image and trace controls" aria-expanded={drawerOpen} aria-controls="image-trace-drawer" data-testid="mobile-open-trace" onClick={() => { setSheet(null); setDrawerOpen(open => !open); }}><ScanLine size={18} />Trace</button>
      <button className={`dock-item ${sheet === 'properties' ? 'active' : ''}`} data-testid="mobile-open-properties" onClick={() => { setDrawerOpen(false); setSheet(current => current === 'properties' ? null : 'properties'); }}><Settings2 size={18} />Edit</button>
    </nav>
    {drawerOpen && <><div className="backdrop drawer-backdrop" onClick={() => setDrawerOpen(false)} /><aside id="image-trace-drawer" className="panel panel-left mobile-sidebar-drawer" aria-label="Image and trace controls"><div className="panel-head"><span>Image & trace</span><button className="tool-btn" aria-label="Close image and trace drawer" onClick={() => setDrawerOpen(false)}><X size={16} /></button></div>{uploadPanel}</aside></>}
    {sheet && <><div className="backdrop" onClick={() => setSheet(null)} /><section className="mobile-sheet"><div className="sheet-grip" /><div className="panel-head"><span>{sheet === 'layers' ? 'Layers & shapes' : 'Shape properties'}</span><button className="tool-btn" aria-label="Close panel" onClick={() => setSheet(null)}><X size={16} /></button></div>{sheet === 'layers' ? <>{layersPanel}<div className="panel-content"><button className="btn" disabled={!activeShape} onClick={duplicateSelected}><Copy size={14} />Duplicate</button><button className="btn" disabled={!activeShape} style={{ marginLeft: 7 }} onClick={deleteSelected}><Trash2 size={14} />Delete</button></div></> : propertiesPanel}</section></>}
    </>}
    {message && <div role="status" data-testid="status-message" style={{ position: 'fixed', zIndex: 30, bottom: 78, left: '50%', transform: 'translateX(-50%)', background: '#292d33', color: '#eee8da', border: '1px solid #5a4b32', borderRadius: 7, padding: '10px 15px', fontSize: 12, boxShadow: '0 6px 26px #0007', maxWidth: '90vw' }}>{message}</div>}
  </main>;
}

export default App;