import { Minus, Plus } from 'lucide-react';

export type AdvancedTraceSettings = {
  colorCount: number | null;
  tolerance: number;
  lineTolerance: number;
  pathSimplification: number;
  curveSmoothness: number;
  cornerThreshold: number;
  minArea: number;
  noiseReduction: number;
};

type Props = {
  settings: AdvancedTraceSettings;
  onChange: (key: keyof AdvancedTraceSettings, value: number | null) => void;
  traceProfile: 'normal' | 'max';
  longestEdge: number;
  autoTraceSize: boolean;
  maxTraceSize: number;
  onAutoTraceSizeChange: (value: boolean) => void;
  onMaxTraceSizeChange: (value: number) => void;
  disabled: boolean;
};

export function getSmartTraceSize(longestEdge: number): number {
  if (longestEdge <= 1600) return longestEdge;
  if (longestEdge <= 3000) return 2400;
  if (longestEdge <= 4000) return 3000;
  if (longestEdge <= 5000) return 3500;
  return 5000;
}

function Control({
  label,
  value,
  min,
  max,
  step = 1,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const update = (next: number) => onChange(Math.max(min, Math.min(max, next)));
  return <div className="advanced-control">
    <div className="field-row"><label>{label}</label><span className="small-value">{value}</span></div>
    <div className="advanced-slider">
      <button className="btn icon-btn" type="button" aria-label={`Decrease ${label}`} onClick={() => update(value - step)} disabled={disabled || value <= min}><Minus size={13} /></button>
      <input aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={event => update(Number(event.target.value))} disabled={disabled} />
      <button className="btn icon-btn" type="button" aria-label={`Increase ${label}`} onClick={() => update(value + step)} disabled={disabled || value >= max}><Plus size={13} /></button>
    </div>
  </div>;
}

export function AdvancedTraceControls({
  settings,
  onChange,
  traceProfile,
  longestEdge,
  autoTraceSize,
  maxTraceSize,
  onAutoTraceSizeChange,
  onMaxTraceSizeChange,
  disabled,
}: Props) {
  const traceSize = getSmartTraceSize(longestEdge);
  const colorCount = settings.colorCount ?? (traceProfile === 'max' ? 64 : 32);
  return <details className="advanced-controls">
    <summary>Advanced controls</summary>
    <div className="advanced-controls-body">
      <div className="advanced-group">
        <h3>Color</h3>
        <Control label="Color Count" value={colorCount} min={2} max={64} step={1} disabled={disabled} onChange={value => onChange('colorCount', value)} />
        <Control label="Color Tolerance" value={settings.tolerance} min={0} max={150} step={1} disabled={disabled} onChange={value => onChange('tolerance', value)} />
      </div>
      <div className="advanced-group">
        <h3>Geometry</h3>
        <Control label="Line Tolerance" value={settings.lineTolerance} min={0} max={150} step={1} disabled={disabled} onChange={value => onChange('lineTolerance', value)} />
        <Control label="Path Simplification" value={settings.pathSimplification} min={0} max={10} step={1} disabled={disabled} onChange={value => onChange('pathSimplification', value)} />
        <Control label="Curve Smoothness" value={settings.curveSmoothness} min={0} max={10} step={1} disabled={disabled} onChange={value => onChange('curveSmoothness', value)} />
        <Control label="Corner Threshold" value={settings.cornerThreshold} min={20} max={150} step={1} disabled={disabled} onChange={value => onChange('cornerThreshold', value)} />
      </div>
      <div className="advanced-group">
        <h3>Cleanup</h3>
        <Control label="Minimum Area" value={settings.minArea} min={0} max={500} step={1} disabled={disabled} onChange={value => onChange('minArea', value)} />
        <Control label="Noise Reduction" value={settings.noiseReduction} min={0} max={20} step={1} disabled={disabled} onChange={value => onChange('noiseReduction', value)} />
      </div>
      {traceProfile === 'max' && <div className="advanced-group trace-size-control">
        <h3>Maximum trace size</h3>
        <div className="field-row"><label htmlFor="auto-trace-size">Smart size</label><input id="auto-trace-size" aria-label="Use smart maximum trace size" type="checkbox" checked={autoTraceSize} onChange={event => onAutoTraceSizeChange(event.target.checked)} disabled={disabled} /></div>
        <div className="small-value">{autoTraceSize ? `${traceSize}px automatic` : `${maxTraceSize}px manual`}</div>
        {!autoTraceSize && <div className="advanced-slider">
          <button className="btn icon-btn" type="button" aria-label="Decrease maximum trace size" onClick={() => onMaxTraceSizeChange(Math.max(128, maxTraceSize - 128))} disabled={disabled || maxTraceSize <= 128}><Minus size={13} /></button>
          <input aria-label="Maximum trace size" type="range" min="128" max="5000" step="8" value={maxTraceSize} onChange={event => onMaxTraceSizeChange(Number(event.target.value))} disabled={disabled} />
          <button className="btn icon-btn" type="button" aria-label="Increase maximum trace size" onClick={() => onMaxTraceSizeChange(Math.min(5000, maxTraceSize + 128))} disabled={disabled || maxTraceSize >= 5000}><Plus size={13} /></button>
        </div>}
      </div>}
    </div>
  </details>;
}
