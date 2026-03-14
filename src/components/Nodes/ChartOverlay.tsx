import { useState, useEffect, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TimeseriesChart } from './TimeseriesChart';

// ============================================================================
// CHART OVERLAY - Full-screen timeseries chart panel
// ============================================================================
// Opens over the center of the screen (same pattern as GlobalOrderbookOverlay).
// Shows one chart per metric, with time range selection and auto-refresh.
// ============================================================================

interface TimeseriesPoint {
  timestamp: number;
  source_id: string;
  metric: string;
  value: number;
  metadata: Record<string, unknown> | null;
}

/** Shape returned by query_timeseries_cmd (uses metric_type, not metric) */
interface RawTimeseriesPoint {
  timestamp: number;
  source_id: string;
  metric_type: string;
  value: number;
  metadata: Record<string, unknown> | null;
}

interface NodeStoredData {
  timeseries: TimeseriesPoint[];
  websocket_messages: unknown[];
  available_metrics: string[];
  total_points: number;
  oldest_timestamp: number | null;
  newest_timestamp: number | null;
}

interface ChartOverlayProps {
  nodeId: string;
  nodeName: string;
  metrics: string[];
  onClose: () => void;
}

const TIME_RANGES = [
  { label: '1H', seconds: 3600 },
  { label: '6H', seconds: 21600 },
  { label: '24H', seconds: 86400 },
  { label: '7D', seconds: 604800 },
  { label: '30D', seconds: 2592000 },
  { label: 'All', seconds: 0 },
] as const;

export function ChartOverlay({ nodeId, nodeName, metrics, onClose }: ChartOverlayProps) {
  const [data, setData] = useState<TimeseriesPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState(86400);
  const [selectedMetric, setSelectedMetric] = useState<string | null>(null);

  // Escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Load data
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (timeRange === 0) {
        // "All" — fetch everything via get_node_stored_data_cmd
        const result = await invoke<NodeStoredData>('get_node_stored_data_cmd', {
          nodeId,
          limit: 5000,
        });
        setData(result.timeseries);
      } else {
        // Time-ranged query via query_timeseries_cmd
        // This command returns {metric_type} not {metric}, so we normalize
        const now = Math.floor(Date.now() / 1000);
        const startTime = now - timeRange;
        const metricsToFetch = selectedMetric ? [selectedMetric] : metrics;
        const allData: TimeseriesPoint[] = [];

        for (const m of metricsToFetch) {
          try {
            const raw = await invoke<RawTimeseriesPoint[]>('query_timeseries_cmd', {
              sourceId: nodeId,
              metricType: m,
              startTime,
              endTime: now,
              limit: 2000,
            });
            // Normalize metric_type -> metric
            for (const p of raw) {
              allData.push({
                timestamp: p.timestamp,
                source_id: p.source_id,
                metric: p.metric_type,
                value: p.value,
                metadata: p.metadata,
              });
            }
          } catch {
            // Skip metrics with no data for this range
          }
        }
        setData(allData);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [nodeId, timeRange, selectedMetric, metrics]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Auto-refresh every 10 seconds
  useEffect(() => {
    const interval = setInterval(loadData, 10000);
    return () => clearInterval(interval);
  }, [loadData]);

  // Group data by metric
  const metricGroups = useMemo(() => {
    const groups: Record<string, TimeseriesPoint[]> = {};
    const filtered = selectedMetric
      ? data.filter((p) => p.metric === selectedMetric)
      : data;
    for (const point of filtered) {
      if (!groups[point.metric]) groups[point.metric] = [];
      groups[point.metric].push(point);
    }
    return groups;
  }, [data, selectedMetric]);

  const metricNames = Object.keys(metricGroups);

  // Chart height adapts to number of metrics visible
  const chartHeight = metricNames.length <= 1 ? 400 : metricNames.length <= 3 ? 280 : 200;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 rounded-xl shadow-2xl border border-gray-700 w-[92vw] max-w-[1400px] h-[88vh] max-h-[900px] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 bg-gray-800 border-b border-gray-700 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <svg className="w-5 h-5 text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
            </svg>
            <h2 className="text-sm font-semibold text-gray-100 truncate">{nodeName}</h2>
            <span className="text-xs text-gray-500 shrink-0">
              {data.length.toLocaleString()} points
            </span>
          </div>

          <div className="flex items-center gap-3">
            {/* Time Range Selector */}
            <div className="flex items-center bg-gray-700/50 rounded-lg p-0.5">
              {TIME_RANGES.map((range) => (
                <button
                  key={range.label}
                  onClick={() => setTimeRange(range.seconds)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                    timeRange === range.seconds
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-600/50'
                  }`}
                >
                  {range.label}
                </button>
              ))}
            </div>

            {/* Metric Filter (only show if multiple metrics) */}
            {metrics.length > 1 && (
              <select
                value={selectedMetric || ''}
                onChange={(e) => setSelectedMetric(e.target.value || null)}
                className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 focus:border-blue-500 focus:outline-none"
              >
                <option value="">All metrics</option>
                {metrics.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            )}

            {/* Close */}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading && data.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 border-t-transparent"></div>
              <span className="ml-3 text-gray-400">Loading chart data...</span>
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-full">
              <div className="bg-red-900/20 border border-red-500 rounded-lg p-4 max-w-md">
                <p className="text-red-400 text-sm">{error}</p>
                <button
                  onClick={loadData}
                  className="mt-2 px-3 py-1 bg-red-700 hover:bg-red-600 rounded text-xs text-white"
                >
                  Retry
                </button>
              </div>
            </div>
          ) : metricNames.length === 0 ? (
            <div className="flex items-center justify-center h-full text-gray-500">
              No data available for the selected time range.
            </div>
          ) : (
            <div className="space-y-6">
              {metricNames.map((metricName) => (
                <div key={metricName} className="bg-gray-800/30 rounded-lg p-4 border border-gray-800">
                  {metricNames.length > 1 && (
                    <h3 className="text-sm font-medium text-gray-300 mb-3">{metricName}</h3>
                  )}
                  <TimeseriesChart
                    data={metricGroups[metricName]}
                    metric={metricName}
                    height={chartHeight}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-2 bg-gray-800/50 border-t border-gray-700 text-xs text-gray-500 shrink-0">
          <div className="flex items-center gap-4">
            <span>Node: <span className="text-gray-400 font-mono">{nodeId.slice(0, 8)}...</span></span>
            <span>Metrics: <span className="text-gray-400">{metrics.join(', ')}</span></span>
          </div>
          <div className="flex items-center gap-2">
            {loading && data.length > 0 && (
              <div className="animate-spin rounded-full h-3 w-3 border-b border-blue-400 border-t-transparent"></div>
            )}
            <span>Auto-refresh: 10s</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ChartOverlay;
