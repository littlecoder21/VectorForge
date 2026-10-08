import { Circle, Eraser, Palette, Pipette, Redo2, RotateCcw, Square, Undo2, Wand2 } from 'lucide-react';

type Props = {
  color: string;
  onColorChange: (color: string) => void;
  tolerance: number;
  onToleranceChange: (value: number) => void;
  contiguous: boolean;
  onContiguousChange: (value: boolean) => void;
  includeSimilarColors: boolean;
  onIncludeSimilarColorsChange: (value: boolean) => void;
  picking: boolean;
  onTogglePicking: () => void;
  samplingArea: boolean;
  onToggleSamplingArea: () => void;
  sampleRadius: number;
  onSampleRadiusChange: (value: number) => void;
  sampleShape: 'circle' | 'rect';
  onSampleShapeChange: (value: 'circle' | 'rect') => void;
  erasing: boolean;
  allowPixelErase: boolean;
  onToggleErasing: () => void;
  eraseSize: number;
  onEraseSizeChange: (value: number) => void;
  busy: boolean;
  onDetect: () => void;
  onRemove: () => void;
  onRestore: () => void;
  canUndoImage: boolean;
  canRedoImage: boolean;
  onUndoImage: () => void;
  onRedoImage: () => void;
  canRestore: boolean;
};

const bgPresets = ['#ffffff', '#000000', '#00b140', '#0047ff'];

export function BackgroundRemover({
  color,
  onColorChange,
  tolerance,
  onToleranceChange,
  contiguous,
  onContiguousChange,
  includeSimilarColors,
  onIncludeSimilarColorsChange,
  picking,
  onTogglePicking,
  samplingArea,
  onToggleSamplingArea,
  sampleRadius,
  onSampleRadiusChange,
  sampleShape,
  onSampleShapeChange,
  erasing,
  allowPixelErase,
  onToggleErasing,
  eraseSize,
  onEraseSizeChange,
  busy,
  onDetect,
  onRemove,
  onRestore,
  canUndoImage,
  canRedoImage,
  onUndoImage,
  onRedoImage,
  canRestore,
}: Props) {
  return <div className="bg-tool">
    <div className="section-label">Background remover</div>
    <div className="swatch-row">
      {bgPresets.map(preset => <button key={preset} className={`swatch-btn ${color === preset ? 'active' : ''}`} style={{ background: preset }} title={preset} aria-label={`Use ${preset}`} onClick={() => onColorChange(preset)} />)}
      <label className="bg-color-trigger" title="Choose a precise background color" aria-label="Choose a precise background color"><Palette size={14} /><input type="color" aria-label="Background color to remove" data-testid="input-bg-color" value={color} onChange={event => onColorChange(event.target.value)} /></label>
      <button className={`btn icon-btn ${picking ? 'btn-primary' : ''}`} title="Pick the color from the image" aria-label="Pick background color from the image" data-testid="button-pick-bg" onClick={onTogglePicking} disabled={busy}><Pipette size={14} /></button>
      <button className="btn icon-btn" title="Detect the dominant color along the image edges" aria-label="Detect background color from image edges" data-testid="button-detect-bg" onClick={onDetect} disabled={busy}><Wand2 size={14} /></button>
      <button className={`btn icon-btn ${samplingArea && sampleShape === 'circle' ? 'btn-primary' : ''}`} title="Sample a circular area from the image" aria-label="Sample background from a circular area" data-testid="button-sample-bg-area" onClick={() => { if (samplingArea && sampleShape === 'circle') onToggleSamplingArea(); else { onSampleShapeChange('circle'); if (!samplingArea) onToggleSamplingArea(); } }} disabled={busy}><Circle size={14} /></button>
      <button className={`btn icon-btn ${samplingArea && sampleShape === 'rect' ? 'btn-primary' : ''}`} title="Sample a rectangular area from the image" aria-label="Sample background from a rectangular area" data-testid="button-sample-bg-rect" onClick={() => { if (samplingArea && sampleShape === 'rect') onToggleSamplingArea(); else { onSampleShapeChange('rect'); if (!samplingArea) onToggleSamplingArea(); } }} disabled={busy}><Square size={14} /></button>
      {allowPixelErase && <button className={`btn icon-btn ${erasing ? 'btn-primary' : ''}`} title="Erase the image with a transparent brush" aria-label="Erase image area" data-testid="button-image-eraser" onClick={onToggleErasing} disabled={busy}><Eraser size={14} /></button>}
    </div>
    <div className="bg-history-actions" aria-label="Image edit history">
      <button className="btn icon-btn" title="Undo image edit" aria-label="Undo image edit" data-testid="button-image-undo" onClick={onUndoImage} disabled={busy || !canUndoImage}><Undo2 size={14} /></button>
      <button className="btn icon-btn" title="Redo image edit" aria-label="Redo image edit" data-testid="button-image-redo" onClick={onRedoImage} disabled={busy || !canRedoImage}><Redo2 size={14} /></button>
      <button className="btn icon-btn" title="Restore the original image" aria-label="Restore original image" data-testid="button-restore-original" onClick={onRestore} disabled={busy || !canRestore}><RotateCcw size={14} /></button>
    </div>
    {erasing && <div className="bg-field">
      <div className="field-row"><label htmlFor="image-eraser-size">Eraser size</label><span className="small-value">{eraseSize}px</span></div>
      <input id="image-eraser-size" aria-label="Image eraser brush size" data-testid="input-image-eraser-size" style={{ width: '100%', accentColor: '#e6b45c' }} type="range" min="1" max="100" value={eraseSize} onChange={event => onEraseSizeChange(Number(event.target.value))} disabled={busy} />
    </div>}
    <div className="bg-field">
      <div className="field-row"><label htmlFor="bg-sample-radius">Sample area radius</label><span className="small-value">{sampleRadius}px</span></div>
      <input id="bg-sample-radius" aria-label="Background sample area radius" style={{ width: '100%', accentColor: '#e6b45c' }} type="range" min="1" max="160" value={sampleRadius} onChange={event => onSampleRadiusChange(Number(event.target.value))} disabled={busy} />
    </div>
    <div className="bg-field bg-tolerance">
      <div className="field-row"><label htmlFor="bg-tolerance">Nearby color tolerance</label><input aria-label="Nearby color tolerance value" data-testid="input-bg-tolerance-value" className="bg-tolerance-value" type="number" min="0" max="150" value={tolerance} onChange={event => onToleranceChange(Math.max(0, Math.min(150, Number(event.target.value))))} disabled={busy || !includeSimilarColors} /></div>
      <input id="bg-tolerance" aria-label="Background tolerance" data-testid="input-bg-tolerance" style={{ width: '100%', accentColor: '#e6b45c' }} type="range" min="0" max="150" value={tolerance} onChange={event => onToleranceChange(Number(event.target.value))} disabled={busy || !includeSimilarColors} />
    </div>
    <div className="bg-checks">
      <label className="field-row bg-field"><span>Remove nearby colors</span><input aria-label="Remove nearby colors" data-testid="toggle-bg-similar-colors" type="checkbox" checked={includeSimilarColors} onChange={event => onIncludeSimilarColorsChange(event.target.checked)} /></label>
      <label className="field-row bg-field"><span>Only remove edge-connected areas</span><input aria-label="Only remove background connected to the edges" type="checkbox" checked={contiguous} onChange={event => onContiguousChange(event.target.checked)} /></label>
    </div>
    <div className="bg-actions">
      <button className="btn btn-primary" data-testid="button-remove-bg" onClick={onRemove} disabled={busy}><Eraser size={13} /> Remove background</button>
    </div>
    <div className="notice">{erasing ? 'Drag over the source image to erase pixels transparently.' : samplingArea ? `Click to sample inside the ${sampleShape === 'circle' ? 'circle' : 'rectangle'}; adjust its radius above or pinch on a touch screen.` : picking ? 'Click the image to pick the color to remove.' : 'Sample a color area for a more precise background match, or detect the dominant edge color.'}</div>
  </div>;
}
