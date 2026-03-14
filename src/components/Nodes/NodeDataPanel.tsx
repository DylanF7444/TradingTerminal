import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TimeseriesChart } from './TimeseriesChart';

// ============================================================================
// NODE DATA PANEL
// ============================================================================
// Displays stored data for a selected node (timeseries and websocket messages)
// with expandable detail rows and chart view for timeseries data.
// ============================================================================

interface NodeDataPanelProps {
  nodeId: string;
  nodeName?: string;
  nodeType: 'InfoSource' | 'Market';
  onClose?: () => void;
  onOpenChartOverlay?: (nodeId: string, nodeName: string, metrics: string[]) => void;
}

interface TimeseriesPoint {
  timestamp: number;
  source_id: string;
  metric: string;
  value: number;
  metadata: Record<string, unknown> | null;
}

interface WebsocketMessage {
  id: number;
  timestamp: number;
  node_id: string;
  message_type: string;
  payload: Record<string, unknown>;
  processed: boolean;
}

interface NodeStoredData {
  timeseries: TimeseriesPoint[];
  websocket_messages: WebsocketMessage[];
  available_metrics: string[];
  total_points: number;
  oldest_timestamp: number | null;
  newest_timestamp: number | null;
}

export function NodeDataPanel({ nodeId, nodeName, nodeType: _nodeType, onClose, onOpenChartOverlay }: NodeDataPanelProps) {
  const [data, setData] = useState<NodeStoredData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'timeseries' | 'websocket'>('timeseries');
  const [selectedMetric, setSelectedMetric] = useState<string | null>(null);
  const [expandedPointIndex, setExpandedPointIndex] = useState<number | null>(null);
  const [expandedMsgId, setExpandedMsgId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'chart'>('list');

  useEffect(() => {
    loadNodeData();
  }, [nodeId]);

  const loadNodeData = async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await invoke<NodeStoredData>('get_node_stored_data_cmd', {
        nodeId,
        limit: 100,
      });

      setData(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteData = async () => {
    if (!confirm('Are you sure you want to delete all stored data for this node?')) return;

    try {
      await invoke('delete_node_stored_data_cmd', { nodeId });
      loadNodeData();
    } catch (err) {
      setError(String(err));
    }
  };

  const formatTimestamp = (ts: number) => {
    return new Date(ts * 1000).toLocaleString();
  };

  const formatValue = (value: number) => {
    if (value >= 1000000) {
      return value.toLocaleString();
    } else if (value >= 1000) {
      return value.toFixed(2);
    } else if (value >= 1) {
      return value.toFixed(4);
    }
    return value.toFixed(6);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 border-t-transparent"></div>
        <span className="ml-2 text-gray-400">Loading stored data...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-500 rounded-lg p-4">
        <p className="text-red-400 text-sm">{error}</p>
        <button
          onClick={loadNodeData}
          className="mt-2 px-3 py-1 bg-red-700 hover:bg-red-600 rounded text-xs"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="bg-gray-800/50 border border-gray-600 rounded-lg p-4">
        <p className="text-gray-400 text-sm">No stored data found for this node.</p>
        <p className="text-gray-500 text-xs mt-2">
          Data will appear here when the node is active and collecting data.
        </p>
      </div>
    );
  }

  const filteredTimeseries = data.timeseries.filter(
    (point) => !selectedMetric || point.metric === selectedMetric
  );

  // Group timeseries data by metric for separate charts
  const metricGroups: Record<string, TimeseriesPoint[]> = {};
  for (const point of filteredTimeseries) {
    if (!metricGroups[point.metric]) metricGroups[point.metric] = [];
    metricGroups[point.metric].push(point);
  }
  const metricNames = Object.keys(metricGroups);

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-800 border-b border-gray-700">
        <h3 className="text-sm font-medium text-gray-200">
          Stored Data: {data.total_points.toLocaleString()} points
        </h3>
        {onClose && (
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200"
          >
            ✕
          </button>
        )}
      </div>

      {/* Stats Bar */}
      <div className="flex items-center gap-4 px-4 py-2 bg-gray-800/50 text-xs text-gray-400 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <span className="text-gray-500">Oldest:</span>
          <span className="text-gray-300">
            {data.oldest_timestamp ? formatTimestamp(data.oldest_timestamp) : 'N/A'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-gray-500">Newest:</span>
          <span className="text-gray-300">
            {data.newest_timestamp ? formatTimestamp(data.newest_timestamp) : 'N/A'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-gray-500">Metrics:</span>
          <span className="text-gray-300">
            {data.available_metrics.length > 0 ? data.available_metrics.join(', ') : 'None'}
          </span>
        </div>
        <button
          onClick={handleDeleteData}
          className="ml-auto px-2 py-1 text-xs text-red-400 hover:text-red-300 rounded"
        >
          Clear All Data
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-700">
        <button
          onClick={() => setActiveTab('timeseries')}
          className={`px-4 py-2 text-sm font-medium ${
            activeTab === 'timeseries'
              ? 'text-blue-400 border-b-2 border-blue-400'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          Timeseries ({data.timeseries.length})
        </button>
        <button
          onClick={() => setActiveTab('websocket')}
          className={`px-4 py-2 text-sm font-medium ${
            activeTab === 'websocket'
              ? 'text-blue-400 border-b-2 border-blue-400'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          WebSocket ({data.websocket_messages.length})
        </button>
      </div>

      {/* Content */}
      <div className="overflow-auto max-h-96">
        {activeTab === 'timeseries' ? (
          <div className="p-4 space-y-2">
            {/* Filter + View Mode Controls */}
            <div className="flex items-center gap-2 mb-3">
              {data.available_metrics.length > 0 && (
                <>
                  <span className="text-xs text-gray-500">Filter:</span>
                  <select
                    value={selectedMetric || ''}
                    onChange={(e) => setSelectedMetric(e.target.value || null)}
                    className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200"
                  >
                    <option value="">All metrics</option>
                    {data.available_metrics.map((metric) => (
                      <option key={metric} value={metric}>
                        {metric}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <div className="ml-auto flex items-center gap-1">
                <button
                  onClick={() => setViewMode('list')}
                  className={`px-2 py-1 rounded text-xs font-medium ${
                    viewMode === 'list'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  List
                </button>
                <button
                  onClick={() => setViewMode('chart')}
                  className={`px-2 py-1 rounded text-xs font-medium ${
                    viewMode === 'chart'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  Chart
                </button>
              </div>
            </div>

            {viewMode === 'chart' ? (
              <div className="space-y-4">
                {/* Expand button */}
                {onOpenChartOverlay && metricNames.length > 0 && (
                  <button
                    onClick={() => onOpenChartOverlay(nodeId, nodeName || nodeId, data.available_metrics)}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                    </svg>
                    Expand
                  </button>
                )}
                {/* Render one chart per metric */}
                {metricNames.map((metricName) => (
                  <div key={metricName} className="relative">
                    {metricNames.length > 1 && (
                      <div className="text-xs font-medium text-gray-400 mb-1 px-1">{metricName}</div>
                    )}
                    <TimeseriesChart
                      data={metricGroups[metricName]}
                      metric={metricName}
                    />
                  </div>
                ))}
              </div>
            ) : (
              /* Timeseries Data - Expandable Rows */
              filteredTimeseries.map((point, index) => {
                const isExpanded = expandedPointIndex === index;
                return (
                  <div
                    key={index}
                    className="bg-gray-800/50 rounded overflow-hidden transition-colors hover:bg-gray-700/50 cursor-pointer"
                    onClick={() => setExpandedPointIndex(isExpanded ? null : index)}
                  >
                    <div className="p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <svg
                            className={`w-3 h-3 text-gray-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                            fill="none" stroke="currentColor" viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                          <span className="text-xs text-gray-400">
                            {formatTimestamp(point.timestamp)}
                          </span>
                        </div>
                        <span className="text-xs font-mono text-blue-400">
                          {point.metric}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-lg font-mono text-white">
                          {formatValue(point.value)}
                        </span>
                        {point.metadata && !isExpanded && (
                          <span className="text-xs text-gray-500 truncate max-w-xs" title={JSON.stringify(point.metadata)}>
                            {JSON.stringify(point.metadata).slice(0, 50)}...
                          </span>
                        )}
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="border-t border-gray-700 bg-gray-900/50 p-3 space-y-2">
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <span className="text-gray-500">Source ID:</span>
                            <span className="ml-2 text-gray-300 font-mono">{point.source_id}</span>
                          </div>
                          <div>
                            <span className="text-gray-500">Metric:</span>
                            <span className="ml-2 text-blue-300 font-mono">{point.metric}</span>
                          </div>
                          <div>
                            <span className="text-gray-500">Raw Value:</span>
                            <span className="ml-2 text-white font-mono">{point.value}</span>
                          </div>
                          <div>
                            <span className="text-gray-500">Unix Timestamp:</span>
                            <span className="ml-2 text-gray-300 font-mono">{point.timestamp}</span>
                          </div>
                        </div>
                        {point.metadata && (
                          <div>
                            <span className="text-xs text-gray-500 block mb-1">Metadata:</span>
                            <pre className="text-xs text-gray-300 overflow-auto max-h-48 rounded bg-gray-800 p-2 font-mono">
                              {JSON.stringify(point.metadata, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        ) : (
          <div className="p-4 space-y-2">
            {/* WebSocket Messages - Expandable Rows */}
            {data.websocket_messages.map((msg) => {
              const isExpanded = expandedMsgId === msg.id;
              return (
                <div
                  key={msg.id}
                  className="bg-gray-800/50 rounded overflow-hidden transition-colors hover:bg-gray-700/50 cursor-pointer"
                  onClick={() => setExpandedMsgId(isExpanded ? null : msg.id)}
                >
                  <div className="p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <svg
                          className={`w-3 h-3 text-gray-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                          fill="none" stroke="currentColor" viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                        <span className="text-xs text-gray-400">
                          {formatTimestamp(msg.timestamp)}
                        </span>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        msg.processed ? 'bg-green-900/50 text-green-400' : 'bg-yellow-900/50 text-yellow-400'
                      }`}>
                        {msg.processed ? 'Processed' : 'Pending'}
                      </span>
                    </div>
                    <div className="text-xs text-purple-400">
                      {msg.message_type}
                    </div>
                    {!isExpanded && (
                      <div className="text-xs text-gray-500 mt-1 truncate">
                        {JSON.stringify(msg.payload).slice(0, 80)}...
                      </div>
                    )}
                  </div>
                  {isExpanded && (
                    <div className="border-t border-gray-700 bg-gray-900/50 p-3 space-y-2">
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <span className="text-gray-500">Message ID:</span>
                          <span className="ml-2 text-gray-300 font-mono">{msg.id}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Node ID:</span>
                          <span className="ml-2 text-gray-300 font-mono">{msg.node_id}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Type:</span>
                          <span className="ml-2 text-purple-300 font-mono">{msg.message_type}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Status:</span>
                          <span className={`ml-2 font-mono ${msg.processed ? 'text-green-300' : 'text-yellow-300'}`}>
                            {msg.processed ? 'Processed' : 'Pending'}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-500">Unix Timestamp:</span>
                          <span className="ml-2 text-gray-300 font-mono">{msg.timestamp}</span>
                        </div>
                      </div>
                      <div>
                        <span className="text-xs text-gray-500 block mb-1">Full Payload:</span>
                        <pre className="text-xs text-gray-300 overflow-auto max-h-64 rounded bg-gray-800 p-2 font-mono">
                          {JSON.stringify(msg.payload, null, 2)}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
