import { useState, useRef, useCallback, useEffect } from 'react';

// ============================================================================
// TIMESERIES CHART - Pure SVG line chart for price/metric data
// ============================================================================

interface TimeseriesPoint {
  timestamp: number;
  source_id: string;
  metric: string;
  value: number;
  metadata: Record<string, unknown> | null;
}

interface TimeseriesChartProps {
  data: TimeseriesPoint[];
  metric: string;
  height?: number;
}

const PADDING = { top: 20, right: 16, bottom: 32, left: 60 };

const METRIC_COLORS: Record<string, string> = {
  price: '#10b981',
  volume: '#3b82f6',
  bid: '#22c55e',
  ask: '#ef4444',
  best_bid: '#22c55e',
  best_ask: '#ef4444',
  spread: '#f59e0b',
};

function getColor(metric: string): string {
  const lower = metric.toLowerCase();
  for (const [key, color] of Object.entries(METRIC_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return '#8b5cf6';
}

function formatAxisValue(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  if (Math.abs(value) >= 1) return value.toFixed(2);
  return value.toFixed(4);
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function TimeseriesChart({ data, metric, height = 240 }: TimeseriesChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; point: TimeseriesPoint } | null>(null);

  // Responsive width
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // Sort data by timestamp ascending
  const sorted = [...data].sort((a, b) => a.timestamp - b.timestamp);

  if (sorted.length < 2) {
    return (
      <div ref={containerRef} className="flex items-center justify-center text-gray-500 text-sm" style={{ height }}>
        Not enough data points to render chart (need at least 2)
      </div>
    );
  }

  const chartW = width - PADDING.left - PADDING.right;
  const chartH = height - PADDING.top - PADDING.bottom;

  const values = sorted.map((p) => p.value);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const valRange = maxVal - minVal || 1;
  const yPad = valRange * 0.05;
  const yMin = minVal - yPad;
  const yMax = maxVal + yPad;

  const tMin = sorted[0].timestamp;
  const tMax = sorted[sorted.length - 1].timestamp;
  const tRange = tMax - tMin || 1;

  const scaleX = (ts: number) => PADDING.left + ((ts - tMin) / tRange) * chartW;
  const scaleY = (v: number) => PADDING.top + (1 - (v - yMin) / (yMax - yMin)) * chartH;

  const polylinePoints = sorted.map((p) => `${scaleX(p.timestamp)},${scaleY(p.value)}`).join(' ');
  const color = getColor(metric);

  // Gradient fill area
  const areaPath = `M${scaleX(sorted[0].timestamp)},${scaleY(sorted[0].value)} ` +
    sorted.slice(1).map((p) => `L${scaleX(p.timestamp)},${scaleY(p.value)}`).join(' ') +
    ` L${scaleX(sorted[sorted.length - 1].timestamp)},${PADDING.top + chartH} ` +
    `L${scaleX(sorted[0].timestamp)},${PADDING.top + chartH} Z`;

  // Y axis grid lines (5 lines)
  const yGridLines = Array.from({ length: 5 }, (_, i) => {
    const v = yMin + ((yMax - yMin) * i) / 4;
    return { y: scaleY(v), label: formatAxisValue(v) };
  });

  // X axis labels (up to 5)
  const xLabelCount = Math.min(5, sorted.length);
  const xLabels = Array.from({ length: xLabelCount }, (_, i) => {
    const idx = Math.round((i / (xLabelCount - 1)) * (sorted.length - 1));
    const p = sorted[idx];
    return { x: scaleX(p.timestamp), label: formatTime(p.timestamp) };
  });

  // Stats
  const current = sorted[sorted.length - 1].value;
  const first = sorted[0].value;
  const change = current - first;
  const changePct = (change / Math.abs(first || 1)) * 100;

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    // Find nearest point
    let closest = sorted[0];
    let closestDist = Infinity;
    for (const p of sorted) {
      const px = scaleX(p.timestamp);
      const dist = Math.abs(px - mx);
      if (dist < closestDist) {
        closestDist = dist;
        closest = p;
      }
    }
    if (closestDist < 30) {
      setTooltip({ x: scaleX(closest.timestamp), y: scaleY(closest.value), point: closest });
    } else {
      setTooltip(null);
    }
  }, [sorted, scaleX, scaleY]);

  return (
    <div ref={containerRef} className="w-full">
      {/* Summary bar */}
      <div className="flex items-center gap-4 mb-2 text-xs">
        <span className="text-gray-400">
          Min: <span className="text-white font-mono">{formatAxisValue(minVal)}</span>
        </span>
        <span className="text-gray-400">
          Max: <span className="text-white font-mono">{formatAxisValue(maxVal)}</span>
        </span>
        <span className="text-gray-400">
          Current: <span className="text-white font-mono">{formatAxisValue(current)}</span>
        </span>
        <span className={`font-mono ${change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {change >= 0 ? '+' : ''}{formatAxisValue(change)} ({changePct.toFixed(2)}%)
        </span>
      </div>

      <svg
        width={width}
        height={height}
        className="select-none"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTooltip(null)}
      >
        <defs>
          <linearGradient id={`grad-${metric}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.3} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>

        {/* Y grid lines */}
        {yGridLines.map((g, i) => (
          <g key={i}>
            <line x1={PADDING.left} y1={g.y} x2={width - PADDING.right} y2={g.y} stroke="#374151" strokeWidth={0.5} />
            <text x={PADDING.left - 8} y={g.y + 4} textAnchor="end" className="fill-gray-500" fontSize={10}>
              {g.label}
            </text>
          </g>
        ))}

        {/* X axis labels */}
        {xLabels.map((l, i) => (
          <text key={i} x={l.x} y={height - 6} textAnchor="middle" className="fill-gray-500" fontSize={10}>
            {l.label}
          </text>
        ))}

        {/* Area fill */}
        <path d={areaPath} fill={`url(#grad-${metric})`} />

        {/* Data line */}
        <polyline points={polylinePoints} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />

        {/* Tooltip crosshair + dot */}
        {tooltip && (
          <>
            <line x1={tooltip.x} y1={PADDING.top} x2={tooltip.x} y2={PADDING.top + chartH} stroke="#6b7280" strokeWidth={0.5} strokeDasharray="3,3" />
            <circle cx={tooltip.x} cy={tooltip.y} r={4} fill={color} stroke="#1f2937" strokeWidth={2} />
          </>
        )}
      </svg>

      {/* Tooltip box */}
      {tooltip && (
        <div
          className="absolute bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs pointer-events-none z-10 shadow-lg"
          style={{
            left: Math.min(tooltip.x, width - 140),
            top: tooltip.y - 44,
          }}
        >
          <div className="text-gray-400">{new Date(tooltip.point.timestamp * 1000).toLocaleString()}</div>
          <div className="font-mono text-white">{formatAxisValue(tooltip.point.value)}</div>
        </div>
      )}
    </div>
  );
}
