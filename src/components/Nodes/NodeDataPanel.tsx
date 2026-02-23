import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

// ============================================================================
// NODE DATA PANEL
// ============================================================================
// Displays stored data for a selected node (timeseries and websocket messages)
// ============================================================================

interface NodeDataPanelProps {
  nodeId: string;
  nodeType: 'InfoSource' | 'Market';
  onClose?: () => void;
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

export function NodeDataPanel({ nodeId, nodeType: _nodeType, onClose }: NodeDataPanelProps) {
  const [data, setData] = useState<NodeStoredData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'timeseries' | 'websocket'>('timeseries');
  const [selectedMetric, setSelectedMetric] = useState<string | null>(null);

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
    // Timestamp is stored in seconds, but JavaScript Date expects milliseconds
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
            {/* Metric Filter */}
            {data.available_metrics.length > 0 && (
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs text-gray-500">Filter by metric:</span>
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
              </div>
            )}

            {/* Timeseries Data */}
            {data.timeseries
              .filter((point) => !selectedMetric || point.metric === selectedMetric)
              .map((point, index) => (
                <div
                  key={index}
                  className="bg-gray-800/50 rounded p-3 hover:bg-gray-700/50 transition-colors"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-400">
                      {formatTimestamp(point.timestamp)}
                    </span>
                    <span className="text-xs font-mono text-blue-400">
                      {point.metric}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-lg font-mono text-white">
                      {formatValue(point.value)}
                    </span>
                    {point.metadata && (
                      <span className="text-xs text-gray-500 truncate max-w-xs" title={JSON.stringify(point.metadata)}>
                        {JSON.stringify(point.metadata).slice(0, 50)}...
                      </span>
                    )}
                  </div>
                </div>
              ))}
          </div>
        ) : (
          <div className="p-4 space-y-2">
            {/* WebSocket Messages */}
            {data.websocket_messages.map((msg) => (
              <div
                key={msg.id}
                className="bg-gray-800/50 rounded p-3 hover:bg-gray-700/50 transition-colors"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-400">
                    {formatTimestamp(msg.timestamp)}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    msg.processed ? 'bg-green-900/50 text-green-400' : 'bg-yellow-900/50 text-yellow-400'
                  }`}>
                    {msg.processed ? 'Processed' : 'Pending'}
                  </span>
                </div>
                <div className="text-xs text-purple-400 mb-2">
                  {msg.message_type}
                </div>
                <pre className="text-xs text-gray-300 overflow-auto max-h-32 rounded bg-gray-900/50 p-2">
                  {JSON.stringify(msg.payload, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
