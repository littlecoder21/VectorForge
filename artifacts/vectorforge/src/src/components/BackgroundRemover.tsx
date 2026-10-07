import { Circle, Eraser, Pipette, RotateCcw, Wand2 } from 'lucide-react';

type Props = {
  color: string;
  onColorChange: (color: string) => void;
  tolerance: number;
  onToleranceChange: (value: number) => void;
  contiguous: boolean;
  onContiguousChange: (value: boolean) => void;
  picking: boolean;
  onTogglePicking: () => void;
  samplingArea: boolean;
  onToggleSamplingArea: () => void;
  sampleRadius: number;
  onSampleRadiusChange: (value: number) => void;
  busy: boolean;
  onDetect: () => void;
  onRemove: () => void;
  onRestore: () => void;
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
  picking,
  onTogglePicking,
  samplingArea,
  onToggleSamplingArea,
  sampleRadius,
  onSampleRadiusChange,
  busy,
  onDetect,
  onRemove,
  onRestore,
  canRestore,
}: Props) {
  return <div className="bg-tool">
    <div className="section-label">Background remover</div>
    <div className="swatch-row">
      {bgPresets.map(preset => <button key={preset} className={`swatch-btn ${color === preset ? 'active' : ''}`} style={{ background: preset }} title={preset} aria-label={`Use ${preset}`} onClick={() => onColorChange(preset)} />)}
      <input type="color" aria-label="Background color to remove" data-testid="input-bg-color" value={color} onChange={event => onColorChange(event.target.value)} />
      <button className={`btn icon-btn ${picking ? 'btn-primary' : ''}`} title="Pick the color from the image" aria-label="Pick background color from the image" data-testid="button-pick-bg" onClick={onTogglePicking} disabled={busy}><Pipette size={14} /></button>
      <button className="btn icon-btn" title="Detect the dominant color along the image edges" aria-label="Detect background color from image edges" data-testid="button-detect-bg" onClick={onDetect} disabled={busy}><Wand2 size={14} /></button>
      <button className={`btn icon-btn ${samplingArea ? 'btn-primary' : ''}`} title="Sample a circular area from the image" aria-label="Sample background from a circular area" data-testid="button-sample-bg-area" onClick={onToggleSamplingArea} disabled={busy}><Circle size={14} /></button>
    </div>
    <div className="bg-field">
      <div className="field-row"><label htmlFor="bg-sample-radius">Sample area radius</label><span className="small-value">{sampleRadius}px</span></div>
      <input id="bg-sample-radius" aria-label="Background sample area radius" style={{ width: '100%', accentColor: '#e6b45c' }} type="range" min="4" max="160" value={sampleRadius} onChange={event => onSampleRadiusChange(Number(event.target.value))} disabled={busy} />
    </div>
    <div className="bg-field">
      <div className="field-row"><span>Tolerance</span><span className="small-value">{tolerance} / 150</span></div>
      <input aria-label="Background tolerance" data-testid="input-bg-tolerance" style={{ width: '100%', accentColor: '#e6b45c' }} type="range" min="0" max="150" value={tolerance} onChange={event => onToleranceChange(Number(event.target.value))} disabled={busy} />
    </div>
    <div className="field-row bg-field"><span>Only areas touching the edges</span><input aria-label="Only remove background connected to the edges" type="checkbox" checked={contiguous} onChange={event => onContiguousChange(event.target.checked)} /></div>
    <div className="bg-actions">
      <button className="btn btn-primary" data-testid="button-remove-bg" onClick={onRemove} disabled={busy}><Eraser size={13} /> Remove background</button>
      <button className="btn icon-btn" title="Restore the original image" aria-label="Restore original image" data-testid="button-restore-original" onClick={onRestore} disabled={busy || !canRestore}><RotateCcw size={13} /></button>
    </div>
    <div className="notice">{samplingArea ? 'Click to sample inside the circle; adjust its radius above or pinch on a touch screen.' : picking ? 'Click the image to pick the color to remove.' : 'Sample a color area for a more precise background match, or detect the dominant edge color.'}</div>
  </div>;
}
