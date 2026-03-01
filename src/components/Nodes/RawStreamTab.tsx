// ============================================================================
// RAW INPUT STREAM TAB COMPONENT
// ============================================================================
//
// Module: components/Nodes/RawStreamTab.tsx
// Purpose: Displays real-time raw data stream for a selected node,
//          showing connection status and recent data entries.
//
// Extracted from App.tsx to improve modularity.
//
// Data Flow:
//   Backend WebSocket scraper → Tauri 'infosource:update' event
//     → Global listener (useInfoSourceEvents hook) → rawDataStreams store
//       → This component reads from the store
//
// For Market nodes with incoming connections, this component also
// simulates quality metrics (latency, success rate) and generates
// simulated market data entries.
// ============================================================================

import { useEffect, useRef, type ReactNode } from 'react';
import { useStore, type StoreState } from '../../store';
import type { RawStreamEntry } from '../../store/nodesSlice';
import { isMarket } from '../../utils/nodeHelpers';

// =============================================================================
// TYPES
// =============================================================================

export interface RawStreamTabProps {
  nodeId: string | undefined;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Tab component showing raw input data for a node.
 *
 * Features:
 * - Connection status indicator (green pulse = connected, gray = none)
 * - Incoming/outgoing connection counts
 * - Scrollable list of raw data entries with timestamp, source, status, and JSON payload
 * - Clear button to flush stream history
 * - Market node simulation: generates mock quality metrics for connected market nodes
 */
export function RawStreamTab({ nodeId }: RawStreamTabProps): ReactNode {
  const rawDataStreams = useStore((state: StoreState) => state.rawDataStreams);
  const appendRawDataEntry = useStore((state: StoreState) => state.appendRawDataEntry);
  const clearRawDataStream = useStore((state: StoreState) => state.clearRawDataStream);
  const connections = useStore((state: StoreState) => state.connections);
  const nodes = useStore((state: StoreState) => state.nodes);
  const updateNodeMetadata = useStore((state: StoreState) => state.updateNodeMetadata);

  const streamData = nodeId ? rawDataStreams[nodeId] || [] : [];

  const incomingConnections = connections.filter((conn) => conn.target === nodeId);
  const outgoingConnections = connections.filter((conn) => conn.source === nodeId);

  const node = nodeId ? nodes[nodeId] : null;
  const nodeIsMarket = node ? isMarket(node) : false;

  // Refs for rolling quality metric simulation
  const latencyHistoryRef = useRef<number[]>([]);
  const successCountRef = useRef<number>(0);
  const totalCountRef = useRef<number>(0);

  // Market node simulation — generates mock data from connected sources
  useEffect(() => {
    if (!nodeId || !node || !nodeIsMarket || incomingConnections.length === 0) return;

    const interval = setInterval(() => {
      const currentLatency = Math.floor(Math.random() * 140) + 10;
      const isSuccess = Math.random() > 0.05; // 95% success rate

      // Rolling latency window (keep last 20 samples)
      latencyHistoryRef.current.push(currentLatency);
      if (latencyHistoryRef.current.length > 20) latencyHistoryRef.current.shift();

      totalCountRef.current++;
      if (isSuccess) successCountRef.current++;

      const avgLatency =
        latencyHistoryRef.current.reduce((a, b) => a + b, 0) / latencyHistoryRef.current.length;
      const successRate =
        totalCountRef.current > 0 ? successCountRef.current / totalCountRef.current : 0;

      updateNodeMetadata(nodeId, {
        quality: {
          successRate,
          avgLatency,
          lastError: isSuccess ? undefined : 'Connection timeout',
        },
        lastData: { timestamp: Date.now(), value: undefined },
      });

      appendRawDataEntry(nodeId, {
        data: {
          type: 'market_data',
          bestBid: Math.random() * 0.5 + 0.25,
          bestAsk: Math.random() * 0.5 + 0.5,
          volume: Math.floor(Math.random() * 10000),
        },
        source: 'connected_sources',
        status: isSuccess ? 'success' : 'error',
      });
    }, 2000);

    return () => clearInterval(interval);
  }, [nodeId, node, nodeIsMarket, incomingConnections.length, appendRawDataEntry, updateNodeMetadata]);

  const handleClearStream = () => {
    if (nodeId) clearRawDataStream(nodeId);
  };

  const hasConnections = incomingConnections.length > 0 || outgoingConnections.length > 0;

  return (
    <div className="text-sm">
      {/* Connection Status */}
      <div className="mb-4 p-3 bg-gray-800/50 rounded-lg">
        <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Connection Status</h3>
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${hasConnections ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`}
          />
          <span className="text-gray-300">{hasConnections ? 'Connected' : 'No connections'}</span>
        </div>
        <div className="mt-2 text-xs text-gray-500">
          <span className="text-blue-400">{incomingConnections.length}</span> incoming ·{' '}
          <span className="text-emerald-400">{outgoingConnections.length}</span> outgoing
        </div>
      </div>

      {/* Stream Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-gray-400 uppercase">
          Raw Input Stream ({streamData.length} entries)
        </h3>
        {streamData.length > 0 && (
          <button
            onClick={handleClearStream}
            className="text-xs text-red-400 hover:text-red-300 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Stream Entries */}
      <div className="space-y-2 max-h-80 overflow-y-auto">
        {streamData.length === 0 ? (
          <EmptyStreamPlaceholder />
        ) : (
          streamData.map((entry: RawStreamEntry, index: number) => (
            <StreamEntry key={`${entry.timestamp}-${index}`} entry={entry} />
          ))
        )}
      </div>
    </div>
  );
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function EmptyStreamPlaceholder() {
  return (
    <div className="text-gray-500 text-center py-8">
      <svg
        className="w-8 h-8 mx-auto mb-2 opacity-50"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M13 10V3L4 14h7v7l9-11h-7z"
        />
      </svg>
      <p>No data received yet</p>
      <p className="text-xs mt-1">Connect nodes to see data flow</p>
    </div>
  );
}

function StreamEntry({ entry }: { entry: RawStreamEntry }) {
  const statusClasses: Record<string, string> = {
    success: 'bg-green-900/50 text-green-400',
    error: 'bg-red-900/50 text-red-400',
  };
  const statusClass = (entry.status && statusClasses[entry.status]) || 'bg-yellow-900/50 text-yellow-400';

  return (
    <div className="p-2 bg-gray-800/30 rounded border border-gray-700/50">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-500">
          {new Date(entry.timestamp).toLocaleTimeString()}
        </span>
        <div className="flex items-center gap-2">
          {entry.source && (
            <span className="text-xs px-1.5 py-0.5 bg-gray-700 rounded text-gray-400">
              {entry.source}
            </span>
          )}
          {entry.status && (
            <span className={`text-xs px-1.5 py-0.5 rounded ${statusClass}`}>{entry.status}</span>
          )}
        </div>
      </div>
      <pre className="text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap break-all">
        {JSON.stringify(entry.data, null, 2)}
      </pre>
    </div>
  );
}

export default RawStreamTab;
