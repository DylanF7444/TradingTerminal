// ============================================================================
// MAIN APPLICATION COMPONENT
// ============================================================================
//
// Module: App.tsx
// Purpose: Root application shell, layout management, and global UI state
//
// OVERVIEW:
// This component serves as the primary layout controller for the prediction
// market trading terminal. It orchestrates the three-panel interface design
// (sidebar controls, main canvas, detail panels) and manages global UI state
// such as panel visibility, selected nodes, and responsive layout adaptations.
//
// Architecture Pattern:
// Compound Component Layout with Zustand State Integration
//   App (layout shell)
//   ├── LeftSidebar (controls)
//   ├── MainCanvas (visualization)
//   ├── RightSidebar (details)
//   └── BottomPanel (positions)
//
// LAYOUT DESIGN:
//
// The interface follows a professional trading terminal aesthetic:
//
// ┌─────────────────┬──────────────────────────┬─────────────────┐
// │                 │                          │                 │
// │  Left Sidebar   │      Main Canvas         │  Right Sidebar  │
// │  (200-300px)    │      (flexible)          │  (0-400px)      │
// │                 │                          │  collapsible    │
// │  • SourcePanel  │      Node Graph          │                 │
// │  • MarketPanel  │      Visualization       │  • NodeDetails  │
// │  • QuickActions │                          │  • RawStream    │
// │                 │                          │  • Orderbook    │
// ├─────────────────┴──────────────────────────┴─────────────────┤
// │                    Bottom Panel (200-300px)                   │
// │                                                               │
// │  • PositionMonitor    • PerformanceMetrics    • SystemStatus  │
// │                                                               │
// └───────────────────────────────────────────────────────────────┘
//
// RIGHT SIDEBAR - NODE DETAIL PANEL:
//
// The right sidebar displays detailed information about the selected node
// with a tabbed interface:
//
// Tabs:
//   - Details: Shows node ID, type, position, connections, and metadata
//   - Raw Stream: Shows real-time input data stream for debugging
//
// SETTINGS MODAL:
//
// The settings modal (gear icon in toolbar) provides access to:
//   - API Key Management: Store credentials for Polymarket and Kalshi
//   - Stored keys are automatically retrieved when adding markets
//   - Keys are persisted in local SQLite database
//
// TOOLBAR:
//
// The toolbar contains:
//   - Details button: Toggle right sidebar visibility
//   - Positions button: Toggle bottom panel visibility
//   - Settings button (gear): Open settings modal for API key management
//   - Help button (?): Show help overlay
//
// Raw Stream Tab (RawStreamTab component):
//   - Displays connection status indicator (green = connected, gray = none)
//   - Shows count of incoming/outgoing connections
//   - Lists recent raw data entries received by the node
//   - Each entry shows: timestamp, source, status, and JSON payload
//   - Useful for verifying node connectivity and debugging data flow
//   - Data stored in nodesSlice.rawDataStreams (capped at 50 entries/node)
//
// RESPONSIVE BEHAVIOR:
//
// Desktop (>1400px): Full three-panel layout
// Tablet (900-1400px): Collapsible right sidebar, priority to canvas
// Mobile (<900px): Tab-based navigation, single panel visible
//
// STATE MANAGEMENT:
//
// Local UI State (useState):
//   - Panel visibility toggles
//   - Selected node for detail view
//   - Active tab in detail panel ('details' | 'raw-stream')
//   - Canvas viewport state (if not in global store)
//   - Modal/dialog open states
//
// Global State (Zustand store):
//   - nodes: All graph nodes from nodesSlice
//   - connections: All graph edges from nodesSlice
//   - rawDataStreams: Raw input stream data per node
//   - openPositions: Trading positions from positionsSlice
//   - markets: Connected exchanges from marketsSlice
//
// PERFORMANCE OPTIMIZATIONS:
//
// - Memoized selectors prevent unnecessary re-renders
// - Virtual scrolling for long lists (positions, markets)
// - Canvas uses requestAnimationFrame independently
// - Lazy loading for non-critical panels
// - Debounced resize handling
//
// KEYBOARD SHORTCUTS:
//
// Global shortcuts handled at this level:
//   - Ctrl/Cmd + S: Save graph
//   - Ctrl/Cmd + Z: Undo
//   - Ctrl/Cmd + Shift + Z: Redo
//   - Escape: Close panels, deselect
//   - F11: Toggle fullscreen
//   - Ctrl/Cmd + B: Toggle bottom panel
//   - Ctrl/Cmd + /: Toggle help overlay
//
// ACCESSIBILITY:
//
// - ARIA landmarks for regions (navigation, main, complementary)
// - Keyboard navigation support
// - Focus management between panels
// - Screen reader announcements for state changes
// - Reduced motion support
//
// ERROR BOUNDARIES:
//
// Each major panel has its own error boundary to isolate failures:
//   - Canvas errors don't crash the control panel
//   - Position monitor can fail independently
//   - Detail panel errors don't affect main workspace
//
// ============================================================================

import { useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';

// Store hooks
import { useStore, type StoreState } from './store';

// Tauri imports
import { invoke } from '@tauri-apps/api/core';

// API utilities
import { removeNode as removeNodeFromDb } from './utils/api';

// Layout components
import Canvas from './components/Canvas/Canvas';
import SourcePanel from './components/InfoSources/SourcePanel';
import MarketPanel from './components/Markets/MarketPanel';
import GlobalOrderbookOverlay from './components/Markets/GlobalOrderbookOverlay';
import PerformanceMetrics from './components/Metrics/PerformanceMetrics';
import ApiKeySettings from './components/Settings/ApiKeySettings';
import { NodeDataPanel } from './components/Nodes/NodeDataPanel';

// UI components
import { Modal } from './components/UI/Modal';

// Types
import { Node, NodeId, NodeType, InfoSourceType, MarketType } from './types/nodes';
import type { RawStreamEntry } from './store/nodesSlice';

// =============================================================================
// LAYOUT CONSTANTS
// =============================================================================

/** Default panel widths in pixels */
const PANEL_WIDTHS = {
  leftSidebar: 280,
  rightSidebar: 384, // 96 * 4 = 384px (Tailwind w-96)
  bottomPanel: 240,
};

/** Breakpoints for responsive behavior */
const BREAKPOINTS = {
  mobile: 768,
  tablet: 1024,
  desktop: 1400,
};

// =============================================================================
// NODE DETAILS PANEL COMPONENT
// =============================================================================

/**
 * Component to display detailed information about a selected node.
 * Shows monitoring sources/markets, connections, and metadata in a user-friendly format.
 */
function NodeDetailsPanel({ 
  node, 
  connections, 
  nodes 
}: { 
  node: Node | null; 
  connections: { source: string; target: string; strength?: number }[];
  nodes: Record<string, Node>;
}): ReactNode {
  if (!node) {
    return (
      <div className="text-gray-500 text-center py-8">
        <p>No node selected</p>
      </div>
    );
  }

  // Cast metadata to flexible type for accessing various properties
  const metadata = node.metadata as Record<string, any>;
  
  // Determine node type information
  const isInfoSource = node.node_type && 'InfoSource' in node.node_type;
  const isMarket = node.node_type && 'Market' in node.node_type;
  const isAnalyzer = node.node_type && 'Analyzer' in node.node_type;
  const isAlert = node.node_type && 'Alert' in node.node_type;

  // Get the subtype
  const nodeSubtype = isInfoSource 
    ? (node.node_type as { InfoSource: string }).InfoSource
    : isMarket 
    ? (node.node_type as { Market: string }).Market
    : isAnalyzer
    ? (node.node_type as { Analyzer: string }).Analyzer
    : isAlert
    ? (node.node_type as { Alert: string }).Alert
    : 'Unknown';

  // Get human-readable type name
  const getTypeDisplayName = (type: string): string => {
    const typeNames: Record<string, string> = {
      // Info Sources
      'CryptoPrices': 'Cryptocurrency Prices',
      'FinancialPrices': 'Financial Markets',
      'CommodityPrices': 'Commodity Prices',
      'NewsSource': 'News Feed',
      'SocialMedia': 'Social Media',
      'Weather': 'Weather Data',
      'Livestream': 'Livestream Metrics',
      'EconomicIndicators': 'Economic Indicators',
      'OnChainData': 'On-Chain Data',
      'CustomAPI': 'Custom API',
      // Markets
      'Polymarket': 'Polymarket',
      'Kalshi': 'Kalshi',
      // Analyzers
      'Correlation': 'Correlation Analyzer',
      'MovingAverage': 'Moving Average',
      'Sentiment': 'Sentiment Analyzer',
      'Arbitrage': 'Arbitrage Detector',
      'Custom': 'Custom Analyzer',
      // Alerts
      'PriceThreshold': 'Price Threshold Alert',
      'CorrelationChange': 'Correlation Change Alert',
      'Webhook': 'Webhook Alert',
      'Desktop': 'Desktop Notification',
    };
    return typeNames[type] || type;
  };

  // Get monitoring targets based on node type and metadata
  const getMonitoringInfo = (): { label: string; items: string[] } | null => {
    if (isInfoSource) {
      // Info Source nodes monitor specific data sources
      const subtype = (node.node_type as { InfoSource: string }).InfoSource;
      
      switch (subtype) {
        case 'CryptoPrices':
          return {
            label: 'Monitoring Cryptos',
            items: metadata.symbols || ['BTC', 'ETH', 'SOL'],
          };
        case 'FinancialPrices':
          return {
            label: 'Monitoring Stocks',
            items: metadata.symbols || metadata.tickers || ['SPY', 'QQQ'],
          };
        case 'CommodityPrices':
          return {
            label: 'Monitoring Commodities',
            items: metadata.symbols || ['Gold', 'Oil', 'Silver'],
          };
        case 'NewsSource':
          return {
            label: 'News Sources',
            items: metadata.feeds || metadata.sources || ['Reuters', 'AP', 'Bloomberg'],
          };
        case 'SocialMedia':
          return {
            label: 'Social Platforms',
            items: metadata.platforms || ['Twitter/X', 'Reddit'],
          };
        case 'Weather':
          return {
            label: 'Locations',
            items: metadata.locations || metadata.symbols || ['NYC', 'London'],
          };
        case 'Livestream':
          return {
            label: 'Platforms',
            items: metadata.platforms || ['YouTube', 'Twitch'],
          };
        case 'EconomicIndicators':
          return {
            label: 'Indicators',
            items: metadata.indicators || ['CPI', 'Unemployment', 'GDP'],
          };
        case 'OnChainData':
          return {
            label: 'Metrics',
            items: metadata.metrics || ['Transaction Volume', 'Gas Fees'],
          };
        case 'CustomAPI':
          return {
            label: 'Endpoints',
            items: metadata.endpoints || [metadata.endpoint || 'Custom API'],
          };
        default:
          return {
            label: 'Data Sources',
            items: metadata.symbols || metadata.sources || ['Unknown'],
          };
      }
    }
    
    if (isMarket) {
      // Market nodes monitor specific markets on exchanges
      const subtype = (node.node_type as { Market: string }).Market;
      const marketId = metadata.marketId || metadata.market_id;
      const question = metadata.question || metadata.marketQuestion;
      
      const items: string[] = [];
      
      if (question) {
        items.push(question);
      }
      if (marketId) {
        items.push(`Market ID: ${marketId}`);
      }
      if (metadata.symbols) {
        items.push(...metadata.symbols);
      }
      
      // If no specific market info, show exchange name
      if (items.length === 0) {
        items.push(subtype === 'Polymarket' ? 'Prediction Markets' : 'Event Contracts');
      }
      
      return {
        label: subtype === 'Polymarket' ? 'Polymarket Markets' : 'Kalshi Markets',
        items,
      };
    }
    
    if (isAnalyzer) {
      // Analyzer nodes process data from connected sources
      const inputs = metadata.inputs || [];
      const inputNodes = inputs.map((id: string) => {
        const inputNode = nodes[id];
        const inputMeta = inputNode?.metadata as Record<string, any> | undefined;
        return inputMeta?.name || inputNode?.name || inputNode?.id || id;
      });
      
      return {
        label: 'Analyzing From',
        items: inputNodes.length > 0 ? inputNodes : ['No inputs configured'],
      };
    }
    
    if (isAlert) {
      // Alert nodes monitor specific conditions
      const condition = metadata.condition;
      if (condition) {
        const sourceNode = nodes[condition.sourceId];
        const sourceMeta = sourceNode?.metadata as Record<string, any> | undefined;
        return {
          label: 'Watching',
          items: [
            sourceMeta?.name || sourceNode?.name || sourceNode?.id || condition.sourceId || 'Unknown source',
            `Condition: ${condition.operator} ${condition.threshold}`,
          ],
        };
      }
      return {
        label: 'Alert Status',
        items: ['Not configured'],
      };
    }
    
    return null;
  };

  // Get connected nodes info
  const incomingConnections = connections.filter(conn => conn.target === node.id);
  const outgoingConnections = connections.filter(conn => conn.source === node.id);
  
  const incomingNodes = incomingConnections.map(conn => ({
    node: nodes[conn.source],
    strength: conn.strength,
  })).filter(c => c.node);
  
  const outgoingNodes = outgoingConnections.map(conn => ({
    node: nodes[conn.target],
    strength: conn.strength,
  })).filter(c => c.node);

  const monitoringInfo = getMonitoringInfo();

  return (
    <div className="text-gray-300 text-sm space-y-4">
      {/* Node Type Header */}
      <div className="pb-3 border-b border-gray-700">
        <div className="flex items-center gap-2 mb-1">
          <div className={`w-3 h-3 rounded-full ${isInfoSource ? 'bg-blue-500' : isMarket ? 'bg-emerald-500' : 'bg-purple-500'}`} />
          <span className="font-semibold text-white">{metadata?.name || node.name || node.id?.slice(0, 12) || 'Unknown'}</span>
        </div>
        <p className="text-xs text-gray-500">
          {isInfoSource ? '📊 Information Source' : isMarket ? '📈 Prediction Market' : isAnalyzer ? '🔍 Analyzer' : isAlert ? '🔔 Alert' : 'Node'}
        </p>
      </div>

      {/* Monitoring Info - The key new feature */}
      {monitoringInfo && (
        <div className="bg-gray-800/50 rounded-lg p-3">
          <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">{monitoringInfo.label}</h3>
          <div className="flex flex-wrap gap-1.5">
            {monitoringInfo.items.map((item, idx) => (
              <span 
                key={idx}
                className={`px-2 py-1 rounded text-xs font-medium ${
                  isInfoSource 
                    ? 'bg-blue-900/50 text-blue-300 border border-blue-700/50' 
                    : isMarket 
                    ? 'bg-emerald-900/50 text-emerald-300 border border-emerald-700/50'
                    : 'bg-purple-900/50 text-purple-300 border border-purple-700/50'
                }`}
              >
                {item}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Connection Info */}
      <div className="bg-gray-800/50 rounded-lg p-3">
        <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Connections</h3>
        
        {incomingNodes.length > 0 && (
          <div className="mb-2">
            <p className="text-xs text-gray-500 mb-1">Receiving from:</p>
            <div className="space-y-1">
              {incomingNodes.map(({ node: n, strength }, idx) => {
                const nMeta = n?.metadata as Record<string, any> | undefined;
                return (
                  <div key={idx} className="flex items-center gap-2 text-xs">
                    <div className="w-2 h-2 rounded-full bg-blue-500" />
                    <span className="text-blue-300">{nMeta?.name || n?.name || n?.id?.slice(0, 8)}</span>
                    {strength && (
                      <span className="text-gray-600">({Math.round(strength * 100)}%)</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        
        {outgoingNodes.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 mb-1">Sending to:</p>
            <div className="space-y-1">
              {outgoingNodes.map(({ node: n, strength }, idx) => {
                const nMeta = n?.metadata as Record<string, any> | undefined;
                return (
                  <div key={idx} className="flex items-center gap-2 text-xs">
                    <div className="w-2 h-2 rounded-full bg-emerald-500" />
                    <span className="text-emerald-300">{nMeta?.name || n?.name || n?.id?.slice(0, 8)}</span>
                    {strength && (
                      <span className="text-gray-600">({Math.round(strength * 100)}%)</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        
        {incomingNodes.length === 0 && outgoingNodes.length === 0 && (
          <p className="text-xs text-gray-500">No connections</p>
        )}
      </div>

      {/* Configuration Details */}
      <div className="bg-gray-800/50 rounded-lg p-3">
        <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Configuration</h3>
        <div className="space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-gray-500">Type:</span>
            <span className="text-gray-300">{getTypeDisplayName(nodeSubtype)}</span>
          </div>
          {metadata?.updateIntervalSeconds && (
            <div className="flex justify-between">
              <span className="text-gray-500">Update Interval:</span>
              <span className="text-gray-300">{metadata.updateIntervalSeconds}s</span>
            </div>
          )}
          {metadata?.exchange && (
            <div className="flex justify-between">
              <span className="text-gray-500">Exchange:</span>
              <span className="text-gray-300">{metadata.exchange}</span>
            </div>
          )}
          {metadata?.autoTrade !== undefined && (
            <div className="flex justify-between">
              <span className="text-gray-500">Auto Trade:</span>
              <span className={metadata.autoTrade ? 'text-green-400' : 'text-gray-400'}>
                {metadata.autoTrade ? 'Enabled' : 'Disabled'}
              </span>
            </div>
          )}
          {metadata?.trading?.maxPositionSize && (
            <div className="flex justify-between">
              <span className="text-gray-500">Max Position:</span>
              <span className="text-gray-300">{metadata.trading.maxPositionSize} contracts</span>
            </div>
          )}
        </div>
      </div>

      {/* Technical Details (collapsible) */}
      <details className="bg-gray-800/30 rounded-lg">
        <summary className="p-3 cursor-pointer text-xs font-semibold text-gray-400 uppercase hover:bg-gray-800/50 rounded-lg">
          Technical Details
        </summary>
        <div className="px-3 pb-3 space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-gray-500">ID:</span>
            <span className="text-gray-400 font-mono">{node.id}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Position:</span>
            <span className="text-gray-400">[{node.position?.[0]?.toFixed(0) ?? 0}, {node.position?.[1]?.toFixed(0) ?? 0}]</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Created:</span>
            <span className="text-gray-400">{node.createdAt ? new Date(node.createdAt).toLocaleString() : 'N/A'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Updated:</span>
            <span className="text-gray-400">{node.updatedAt ? new Date(node.updatedAt).toLocaleString() : 'N/A'}</span>
          </div>
        </div>
      </details>
    </div>
  );
}

// =============================================================================
// RAW STREAM TAB COMPONENT
// =============================================================================

/**
 * Component to display raw input stream data for a node.
 * Shows recent data entries to verify node connectivity and data flow.
 */
function RawStreamTab({ nodeId }: { nodeId: string | undefined }): ReactNode {
  const rawDataStreams = useStore((state: StoreState) => state.rawDataStreams);
  const appendRawDataEntry = useStore((state: StoreState) => state.appendRawDataEntry);
  const clearRawDataStream = useStore((state: StoreState) => state.clearRawDataStream);
  const connections = useStore((state: StoreState) => state.connections);
  const nodes = useStore((state: StoreState) => state.nodes);
  
  // Get stream data for this node
  const streamData = nodeId ? (rawDataStreams[nodeId] || []) : [];
  
  // Check if node has incoming connections (is receiving data)
  const incomingConnections = connections.filter(conn => conn.target === nodeId);
  const outgoingConnections = connections.filter(conn => conn.source === nodeId);
  
  // Get the current node to check its type
  const node = nodeId ? nodes[nodeId] : null;
  const isInfoSource = node?.node_type && 'InfoSource' in node.node_type;
  const isMarket = node?.node_type && 'Market' in node.node_type;
  
  // Simulate data for demo purposes
  // InfoSource nodes always generate data (they are data sources)
  // Market nodes only show data when they have incoming connections
  useEffect(() => {
    if (!nodeId || !node) return;
    
    // InfoSource nodes always generate their own data stream
    // Market nodes need incoming connections to receive data
    const shouldSimulateData = isInfoSource || (isMarket && incomingConnections.length > 0);
    
    if (shouldSimulateData) {
      const interval = setInterval(() => {
        if (isInfoSource && node.node_type && 'InfoSource' in node.node_type) {
          // Info sources generate data - simulate based on source subtype
          const subtype = (node.node_type as { InfoSource: string }).InfoSource;
          
          if (subtype === 'CryptoPrices') {
            appendRawDataEntry(nodeId, {
              data: {
                type: 'price_update',
                symbol: ['BTC', 'ETH', 'SOL'][Math.floor(Math.random() * 3)],
                price: Math.random() * 50000 + 20000,
                change: (Math.random() - 0.5) * 5,
                volume: Math.floor(Math.random() * 1000000),
              },
              source: 'binance_websocket',
              status: 'success',
            });
          } else if (subtype === 'NewsSource') {
            appendRawDataEntry(nodeId, {
              data: {
                type: 'news_article',
                title: ['Market Update', 'Fed Decision', 'Crypto News'][Math.floor(Math.random() * 3)],
                source: ['Reuters', 'Bloomberg', 'CNBC'][Math.floor(Math.random() * 3)],
                sentiment: Math.random() > 0.5 ? 'bullish' : 'bearish',
              },
              source: 'news_feed',
              status: 'success',
            });
          } else {
            // Generic info source data
            appendRawDataEntry(nodeId, {
              data: {
                type: 'data_update',
                value: Math.random() * 100,
                timestamp: Date.now(),
              },
              source: 'polling',
              status: 'success',
            });
          }
        } else if (isMarket) {
          // Markets receive data from connected sources
          appendRawDataEntry(nodeId, {
            data: {
              type: 'market_data',
              bestBid: Math.random() * 0.5 + 0.25,
              bestAsk: Math.random() * 0.5 + 0.5,
              volume: Math.floor(Math.random() * 10000),
            },
            source: 'connected_sources',
            status: 'success',
          });
        }
      }, 2000); // Every 2 seconds
      
      return () => clearInterval(interval);
    }
  }, [nodeId, node, isInfoSource, isMarket, incomingConnections.length, appendRawDataEntry]);
  
  const handleClearStream = () => {
    if (nodeId) {
      clearRawDataStream(nodeId);
    }
  };
  
  return (
    <div className="text-sm">
      {/* Connection Status */}
      <div className="mb-4 p-3 bg-gray-800/50 rounded-lg">
        <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Connection Status</h3>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${
            incomingConnections.length > 0 || outgoingConnections.length > 0
              ? 'bg-green-500 animate-pulse'
              : 'bg-gray-500'
          }`} />
          <span className="text-gray-300">
            {incomingConnections.length > 0 || outgoingConnections.length > 0
              ? 'Connected'
              : 'No connections'}
          </span>
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
          <div className="text-gray-500 text-center py-8">
            <svg className="w-8 h-8 mx-auto mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <p>No data received yet</p>
            <p className="text-xs mt-1">Connect nodes to see data flow</p>
          </div>
        ) : (
          streamData.map((entry: RawStreamEntry, index: number) => (
            <div
              key={`${entry.timestamp}-${index}`}
              className="p-2 bg-gray-800/30 rounded border border-gray-700/50"
            >
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
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      entry.status === 'success' ? 'bg-green-900/50 text-green-400' :
                      entry.status === 'error' ? 'bg-red-900/50 text-red-400' :
                      'bg-yellow-900/50 text-yellow-400'
                    }`}>
                      {entry.status}
                    </span>
                  )}
                </div>
              </div>
              <pre className="text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap break-all">
                {JSON.stringify(entry.data, null, 2)}
              </pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// =============================================================================
// MAIN APPLICATION COMPONENT
// =============================================================================

/**
 * Root application component managing layout and global UI state.
 */
function App(): ReactNode {
  // -------------------------------------------------------------------------
  // Global State Selectors (Zustand)
  // -------------------------------------------------------------------------
  
  const nodes = useStore((state: StoreState) => state.nodes);
  const connections = useStore((state: StoreState) => state.connections);
  const selectedIds = useStore((state: StoreState) => state.selectedIds);
  const selectNode = useStore((state: StoreState) => state.selectNode);
  const clearSelection = useStore((state: StoreState) => state.clearSelection);
  const viewport = useStore((state: StoreState) => state.viewport);
  const addNode = useStore((state: StoreState) => state.addNode);
  const setViewport = useStore((state: StoreState) => state.setViewport);


  // -------------------------------------------------------------------------
  // Load existing nodes on app mount
  // -------------------------------------------------------------------------

  // Helper to transform backend node format to frontend format
  const transformNodeFromBackend = (node: any): any => {
    // Handle node_type transformation: { type: "InfoSource", subtype: "CryptoPrices" } -> { InfoSource: "CryptoPrices" }
    let nodeType: any = node.node_type;
    if (nodeType && nodeType.type && nodeType.subtype) {
      // Convert from backend format to frontend format
      if (nodeType.type === 'InfoSource') {
        nodeType = { InfoSource: nodeType.subtype };
      } else if (nodeType.type === 'Market') {
        nodeType = { Market: nodeType.subtype };
      }
    }

    // Handle position - backend sends as array [x, y] from Rust tuple serialization
    let position = node.position;
    if (position && Array.isArray(position) && position.length >= 2) {
      position = [position[0], position[1]] as [number, number];
    } else if (!position || !Array.isArray(position)) {
      // Default position if missing
      position = [100, 100] as [number, number];
    }

    return {
      ...node,
      node_type: nodeType,
      position: position,
      // Ensure required fields have defaults (backend doesn't include these)
      connections: node.connections || [],
      createdAt: node.createdAt || Date.now(),
      updatedAt: node.updatedAt || Date.now(),
    };
  };

  // Create ref for createDemoNodes to avoid circular dependency in useEffect
  const createDemoNodesRef = useRef<() => Promise<void> | void>(() => {});

  useEffect(() => {
    let isMounted = true;
    
    const loadExistingNodes = async () => {
      try {
        const result = await invoke<any[]>('get_data_sources_cmd');
        
        // Ensure component is still mounted before updating state
        if (!isMounted) return;
        
        // Get current nodes from store to avoid duplicates
        const storeState = useStore.getState();
        const { addNode, nodes } = storeState;
        
        // Skip if nodes already exist (prevents duplicate from React StrictMode)
        if (Object.keys(nodes).length > 0) {
          console.log('Nodes already loaded, skipping...');
          return;
        }
        
        if (result && Array.isArray(result) && result.length > 0) {
          // Add all nodes from backend with transformed format
          result.forEach(node => {
            addNode(transformNodeFromBackend(node));
          });
          
          // Output node coordinates to console on startup
          const transformedNodes = result.map(n => transformNodeFromBackend(n));
          console.log('Node coordinates on startup:', transformedNodes.map(n => ({ id: n.id, position: n.position, type: n.node_type })));
          
          console.log(`Loaded ${result.length} existing nodes from backend`);
        } else {
          // No nodes in database - create demo nodes for first-time users
          console.log('No existing nodes found, creating demo nodes...');
          createDemoNodesRef.current();
        }
      } catch (error) {
        console.error('Failed to load existing nodes:', error);
        // Create demo nodes as fallback on error
        if (isMounted) {
          createDemoNodesRef.current();
        }
      }
    };
    
    loadExistingNodes();
    
    // Cleanup flag on unmount
    return () => {
      isMounted = false;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Create demo nodes for first-time users
  // -------------------------------------------------------------------------
  
  const createDemoNodes = useCallback(async () => {
    // Set the ref so the useEffect can call it
    createDemoNodesRef.current = createDemoNodes;
    
    const { addNode, addConnection } = useStore.getState();
    const now = Date.now();
    
    // Demo crypto price source node
    const cryptoSourceId = 'demo-crypto-source' as NodeId;
    const cryptoNode = {
      id: cryptoSourceId,
      node_type: { InfoSource: InfoSourceType.CryptoPrices } as NodeType,
      position: [150, 200] as [number, number],
      connections: [],
      metadata: {
        symbols: ['BTC', 'ETH', 'SOL'],
        updateIntervalSeconds: 5,
        exchange: 'binance',
      },
      createdAt: now,
      updatedAt: now,
    };
    
    // Save to backend database for persistence
    try {
      await invoke('add_node_cmd', { 
        nodeId: cryptoSourceId, 
        nodeType: 'InfoSource', 
        nodeSubtype: 'CryptoPrices',
        positionX: 150,
        positionY: 200,
        metadata: JSON.stringify(cryptoNode.metadata)
      });
    } catch (e) {
      console.warn('Could not persist crypto node (backend may not have command):', e);
    }
    
    addNode(cryptoNode);
    
    // Demo polymarket node
    const polymarketId = 'demo-polymarket' as NodeId;
    const polymarketNode = {
      id: polymarketId,
      node_type: { Market: MarketType.Polymarket } as NodeType,
      position: [450, 200] as [number, number],
      connections: [],
      metadata: {
        autoTrade: false,
      },
      createdAt: now,
      updatedAt: now,
    };
    
    // Save polymarket to backend
    try {
      await invoke('add_node_cmd', { 
        nodeId: polymarketId, 
        nodeType: 'Market', 
        nodeSubtype: 'Polymarket',
        positionX: 450,
        positionY: 200,
        metadata: JSON.stringify(polymarketNode.metadata)
      });
    } catch (e) {
      console.warn('Could not persist polymarket node:', e);
    }
    
    addNode(polymarketNode);
    
    // Create connection between source and market
    addConnection({
      source: cryptoSourceId,
      target: polymarketId,
      strength: 0.8,
    });
    
    // Demo news source node
    const newsSourceId = 'demo-news-source' as NodeId;
    const newsNode = {
      id: newsSourceId,
      node_type: { InfoSource: InfoSourceType.NewsSource } as NodeType,
      position: [150, 400] as [number, number],
      connections: [],
      metadata: {
        feeds: ['reuters', 'ap'],
        keywords: ['election', 'bitcoin', 'crypto'],
      },
      createdAt: now,
      updatedAt: now,
    };
    
    // Save news source to backend
    try {
      await invoke('add_node_cmd', { 
        nodeId: newsSourceId, 
        nodeType: 'InfoSource', 
        nodeSubtype: 'NewsSource',
        positionX: 150,
        positionY: 400,
        metadata: JSON.stringify(newsNode.metadata)
      });
    } catch (e) {
      console.warn('Could not persist news node:', e);
    }
    
    addNode(newsNode);
    
    // Connect news to polymarket
    addConnection({
      source: newsSourceId,
      target: polymarketId,
      strength: 0.6,
    });
    
    // Output node coordinates to console on startup (demo nodes)
    const { nodes } = useStore.getState();
    const allNodes = Object.values(nodes).map(n => ({ id: n.id, position: n.position, type: n.node_type }));
    console.log('Node coordinates on startup:', allNodes);
    
    console.log('Demo nodes created successfully');
  }, []);

  // -------------------------------------------------------------------------
  // Local UI State
  // -------------------------------------------------------------------------
  
  /** Right sidebar visibility */
  const [showRightSidebar, setShowRightSidebar] = useState(true);
  
  /** Bottom panel visibility */
  const [showBottomPanel, setShowBottomPanel] = useState(true);
  
  /** Left sidebar collapsed state (mobile) */
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  
  /** Currently active tab in mobile view */
  const [mobileActiveTab, setMobileActiveTab] = useState<'canvas' | 'controls' | 'details'>('canvas');
  
  /** Help modal visibility */
  const [showHelp, setShowHelp] = useState(false);
  
  /** Settings modal visibility */
  const [showSettings, setShowSettings] = useState(false);
  
  /** Orderbook overlay state */
  const [orderbookOverlay, setOrderbookOverlay] = useState<{
    marketId: string;
    platform: 'polymarket' | 'kalshi';
    marketQuestion?: string;
  } | null>(null);
  
  /** Active tab in node detail panel */
  const [detailPanelTab, setDetailPanelTab] = useState<'details' | 'raw-stream' | 'stored-data'>('details');
  
  /** Window size for responsive behavior */
  const [windowSize, setWindowSize] = useState(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 1200,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
  }));

  // -------------------------------------------------------------------------
  // Derived State
  // -------------------------------------------------------------------------
  
  /** Currently selected node (single selection for detail view) */
  const selectedNode = useMemo(() => {
    if (selectedIds.size !== 1) return null;
    const selectedId = Array.from(selectedIds)[0];
    return nodes[selectedId] || null;
  }, [selectedIds, nodes]);

  /** Convert nodes record to array for Canvas (filter out invalid nodes) */
  const nodesArray = useMemo(() => 
    Object.values(nodes).filter((node) => node?.id), 
    [nodes]
  );

  /** Convert connections to array */
  const connectionsArray = useMemo(() => connections, [connections]);

  /** Responsive layout mode */
  const layoutMode = useMemo(() => {
    if (windowSize.width < BREAKPOINTS.mobile) return 'mobile';
    if (windowSize.width < BREAKPOINTS.tablet) return 'tablet';
    return 'desktop';
  }, [windowSize.width]);

  // -------------------------------------------------------------------------
  // Event Handlers
  // -------------------------------------------------------------------------
  
  /** Handle window resize with debouncing */
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;
    
    const handleResize = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        setWindowSize({
          width: window.innerWidth,
          height: window.innerHeight,
        });
      }, 100);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(timeoutId);
    };
  }, []);

  /** Handle keyboard shortcuts */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd key shortcuts
      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 's':
            e.preventDefault();
            // Trigger save
            break;
          case 'z':
            e.preventDefault();
            if (e.shiftKey) {
              // Redo
            } else {
              // Undo
            }
            break;
          case 'b':
            e.preventDefault();
            setShowBottomPanel((prev) => !prev);
            break;
          case '/':
            e.preventDefault();
            setShowHelp(true);
            break;
        }
        return;
      }

      // Escape key
      if (e.key === 'Escape') {
        if (showHelp) {
          setShowHelp(false);
        } else if (selectedIds.size > 0) {
          clearSelection();
        } else if (showRightSidebar) {
          setShowRightSidebar(false);
        }
      }

      // F11 for fullscreen
      if (e.key === 'F11') {
        e.preventDefault();
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          document.documentElement.requestFullscreen();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds.size, showHelp, showRightSidebar, clearSelection]);

  /** Handle node selection from Canvas */
  const handleNodeClick = useCallback((node: Node) => {
    selectNode(node.id, false); // Single selection
    setShowRightSidebar(true);
  }, [selectNode]);

  /** Handle node movement from Canvas */
  const handleNodeMove = useCallback((id: string, position: [number, number]) => {
    const { updateNodePosition } = useStore.getState();
    updateNodePosition(id, position);
  }, []);

  /** Handle node deletion from Canvas */
  const handleNodeDelete = useCallback(async (id: string) => {
    // First, remove from local state
    const { removeNode } = useStore.getState();
    removeNode(id);
    
    // Then, persist to database
    try {
      const result = await removeNodeFromDb(id);
      if (!result.ok) {
        console.error('Failed to delete node from database:', result.error);
        // Note: Node is already removed from local state
        // On app reload, it would reappear if DB delete failed
      }
    } catch (error) {
      console.error('Error deleting node from database:', error);
    }
  }, []);

  /** Handle canvas background click (deselect) */
  const handleCanvasBackgroundClick = useCallback(() => {
    clearSelection();
  }, [clearSelection]);

  /** Handle viewport change from Canvas */
  const handleViewportChange = useCallback((newViewport: { x: number; y: number; zoom: number }) => {
    setViewport(newViewport);
  }, [setViewport]);

  /** Handle opening orderbook overlay for market nodes */
  const handleOpenOrderbook = useCallback((marketId: string, platform: 'polymarket' | 'kalshi', marketQuestion?: string) => {
    setOrderbookOverlay({ marketId, platform, marketQuestion });
  }, []);

  /** Handle closing orderbook overlay */
  const handleCloseOrderbook = useCallback(() => {
    setOrderbookOverlay(null);
  }, []);

  /** Toggle right sidebar */
  const toggleRightSidebar = useCallback(() => {
    setShowRightSidebar((prev) => !prev);
  }, []);

  /** Toggle bottom panel */
  const toggleBottomPanel = useCallback(() => {
    setShowBottomPanel((prev) => !prev);
  }, []);

  // -------------------------------------------------------------------------
  // Render Helpers
  // -------------------------------------------------------------------------
  
  /** Render desktop layout */
  const renderDesktop = () => (
    <div className="flex h-screen w-screen overflow-hidden bg-gray-950 text-gray-100">
      {/* Left Sidebar - Controls */}
      <aside 
        className={`flex-shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col transition-all duration-300 ${
          leftSidebarCollapsed ? 'w-16' : 'w-72'
        }`}
        aria-label="Control panel"
      >
        {/* Header */}
        <div className="h-14 flex items-center px-4 border-b border-gray-800">
          {leftSidebarCollapsed ? (
            <button 
              onClick={() => setLeftSidebarCollapsed(false)}
              className="p-2 hover:bg-gray-800 rounded-lg"
              title="Expand sidebar"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
              </svg>
            </button>
          ) : (
            <div className="flex items-center justify-between w-full">
              <h1 className="text-lg font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
                Trading Terminal
              </h1>
              <button 
                onClick={() => setLeftSidebarCollapsed(true)}
                className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400"
                title="Collapse sidebar"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {/* Scrollable content */}
        {!leftSidebarCollapsed && (
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            <SourcePanel 
              onAddSource={(result: any) => {
                // Backend returns { node: Node, success: boolean } - extract the actual node
                const rawNode = result.node || result;
                // Transform node type format from backend to frontend format
                const node = transformNodeFromBackend(rawNode);
                // Add node to store
                addNode(node);
                // Select the new node
                selectNode(node.id, false);
              }}
            />
            <MarketPanel 
              onAddMarket={(result: any) => {
                // Backend returns { node: Node, success: boolean } - extract the actual node
                const rawNode = result.node || result;
                // Transform node type format from backend to frontend format
                const node = transformNodeFromBackend(rawNode);
                // Add node to store
                addNode(node);
                // Select the new node
                selectNode(node.id, false);
              }}
            />
          </div>
        )}

        {/* Performance metrics (bottom of sidebar) */}
        {!leftSidebarCollapsed && (
          <div className="p-4 border-t border-gray-800">
            <PerformanceMetrics compact />
          </div>
        )}
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div className="h-14 bg-gray-900 border-b border-gray-800 flex items-center px-4 gap-2">
          <button
            onClick={toggleRightSidebar}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              showRightSidebar ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
            }`}
          >
            Details
          </button>
          <button
            onClick={toggleBottomPanel}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              showBottomPanel ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
            }`}
          >
            Positions
          </button>
          <div className="flex-1" />
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 hover:bg-gray-800 rounded-lg text-gray-400"
            title="Settings"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
          <button
            onClick={() => setShowHelp(true)}
            className="p-2 hover:bg-gray-800 rounded-lg text-gray-400"
            title="Help"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
        </div>

        {/* Canvas Area */}
        <div className="flex-1 relative overflow-hidden">
          <Canvas
            nodes={nodesArray}
            connections={connectionsArray}
            viewport={viewport}
            selectedNodeId={selectedNode?.id || null}
            onNodeClick={handleNodeClick}
            onNodeMove={handleNodeMove}
            onNodeDelete={handleNodeDelete}
            onBackgroundClick={handleCanvasBackgroundClick}
            onViewportChange={handleViewportChange}
            onOpenOrderbook={handleOpenOrderbook}
          />
        </div>

        {/* Bottom Panel - Positions */}
        {showBottomPanel && (
          <div 
            className="h-60 bg-gray-900 border-t border-gray-800 flex flex-col"
            style={{ height: PANEL_WIDTHS.bottomPanel }}
          >
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-gray-800/50">
              <h2 className="text-sm font-semibold text-gray-300">Positions & Activity</h2>
              <button 
                onClick={toggleBottomPanel}
                className="p-1 hover:bg-gray-700 rounded text-gray-400"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-hidden flex items-center justify-center text-gray-500">
              <p>Position monitor coming soon...</p>
            </div>
          </div>
        )}
      </main>

      {/* Right Sidebar - Details */}
      {showRightSidebar && selectedNode && (
        <aside 
          className="w-96 bg-gray-900 border-l border-gray-800 flex flex-col animate-in slide-in-from-right duration-200"
          aria-label="Details panel"
        >
          <div className="h-14 flex items-center justify-between px-4 border-b border-gray-800">
            <h2 className="font-semibold text-gray-200">Node Details</h2>
            <button 
              onClick={toggleRightSidebar}
              className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          
          {/* Tab Navigation */}
          <div className="flex border-b border-gray-800">
            <button
              onClick={() => setDetailPanelTab('details')}
              className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                detailPanelTab === 'details'
                  ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-800/50'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/30'
              }`}
            >
              Details
            </button>
            <button
              onClick={() => setDetailPanelTab('raw-stream')}
              className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                detailPanelTab === 'raw-stream'
                  ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-800/50'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/30'
              }`}
            >
              Raw Stream
            </button>
            <button
              onClick={() => setDetailPanelTab('stored-data')}
              className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                detailPanelTab === 'stored-data'
                  ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-800/50'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/30'
              }`}
            >
              Stored Data
            </button>
          </div>
          
          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto p-4">
            {detailPanelTab === 'details' ? (
              <NodeDetailsPanel 
                node={selectedNode} 
                connections={connections}
                nodes={nodes}
              />
            ) : detailPanelTab === 'raw-stream' ? (
              <RawStreamTab nodeId={selectedNode?.id} />
            ) : (
              <NodeDataPanel 
                nodeId={selectedNode.id} 
                nodeType={selectedNode.node_type && 'InfoSource' in selectedNode.node_type ? 'InfoSource' : 'Market'}
              />
            )}
          </div>
        </aside>
      )}

      {/* Status Bar */}
      <div className="fixed bottom-0 left-72 right-0 h-6 bg-gray-950 border-t border-gray-800 text-xs flex items-center px-3 text-gray-500 z-50">
        <span>Ready</span>
        <span className="ml-auto">{layoutMode} mode</span>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-gray-900 rounded-xl border border-gray-800 shadow-2xl w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">Settings</h2>
              <button
                onClick={() => setShowSettings(false)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            {/* Modal Content */}
            <div className="flex-1 overflow-y-auto p-6">
              <ApiKeySettings />
            </div>
          </div>
        </div>
      )}

      {/* Global Orderbook Overlay */}
      {orderbookOverlay && (
        <GlobalOrderbookOverlay
          marketId={orderbookOverlay.marketId}
          platform={orderbookOverlay.platform}
          marketQuestion={orderbookOverlay.marketQuestion}
          onClose={handleCloseOrderbook}
        />
      )}
    </div>
  );

  /** Render tablet layout (collapsible sidebars) */
  const renderTablet = () => (
    <div className="flex h-screen w-screen overflow-hidden bg-gray-950 text-gray-100">
      {/* Collapsible Left Sidebar */}
      <aside 
        className={`absolute left-0 top-0 bottom-0 z-40 bg-gray-900 border-r border-gray-800 transform transition-transform duration-300 ${
          leftSidebarCollapsed ? '-translate-x-full' : 'translate-x-0'
        }`}
        style={{ width: PANEL_WIDTHS.leftSidebar }}
      >
        <div className="h-full flex flex-col">
          <div className="h-14 flex items-center justify-between px-4 border-b border-gray-800">
            <h1 className="text-lg font-bold">Trading Terminal</h1>
            <button onClick={() => setLeftSidebarCollapsed(true)}>
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            <SourcePanel 
              onAddSource={(result: any) => {
                const rawNode = result.node || result;
                const node = transformNodeFromBackend(rawNode);
                addNode(node);
                selectNode(node.id, false);
              }}
            />
            <MarketPanel 
              onAddMarket={(result: any) => {
                const rawNode = result.node || result;
                const node = transformNodeFromBackend(rawNode);
                addNode(node);
                selectNode(node.id, false);
              }}
            />
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col">
        {/* Header with menu button */}
        <header className="h-14 bg-gray-900 border-b border-gray-800 flex items-center px-4">
          <button 
            onClick={() => setLeftSidebarCollapsed(false)}
            className="p-2 -ml-2 hover:bg-gray-800 rounded-lg"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="ml-4 font-semibold">Trading Terminal</span>
        </header>

        {/* Canvas */}
        <div className="flex-1 relative">
          <Canvas
            nodes={nodesArray}
            connections={connectionsArray}
            viewport={viewport}
            selectedNodeId={selectedNode?.id || null}
            onNodeClick={handleNodeClick}
            onNodeMove={handleNodeMove}
            onNodeDelete={handleNodeDelete}
            onBackgroundClick={handleCanvasBackgroundClick}
            onViewportChange={handleViewportChange}
          />
        </div>

        {/* Bottom Panel */}
        {showBottomPanel && (
          <div className="h-48 bg-gray-900 border-t border-gray-800">
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
              <h2 className="text-sm font-semibold text-gray-300">Positions & Activity</h2>
              <button 
                onClick={toggleBottomPanel}
                className="p-1 hover:bg-gray-700 rounded text-gray-400"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-hidden flex items-center justify-center text-gray-500">
              <p>Position monitor coming soon...</p>
            </div>
          </div>
        )}
      </main>

      {/* Slide-over Details Panel */}
      {showRightSidebar && selectedNode && (
        <div className="absolute inset-0 z-50 overflow-hidden">
          <div 
            className="absolute inset-0 bg-black/50" 
            onClick={toggleRightSidebar}
          />
          <aside className="absolute right-0 top-0 bottom-0 w-96 bg-gray-900 shadow-xl">
            <div className="h-14 flex items-center justify-between px-4 border-b border-gray-800">
              <h2 className="font-semibold text-gray-200">Node Details</h2>
              <button 
                onClick={toggleRightSidebar}
                className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <NodeDetailsPanel 
                node={selectedNode} 
                connections={connections}
                nodes={nodes}
              />
            </div>
          </aside>
        </div>
      )}
    </div>
  );

  /** Render mobile layout (tab-based) */
  const renderMobile = () => (
    <div className="h-screen w-screen bg-gray-950 text-gray-100 flex flex-col">
      {/* Mobile Header */}
      <header className="h-14 bg-gray-900 border-b border-gray-800 flex items-center justify-between px-4">
        <h1 className="font-bold text-lg">Trading Terminal</h1>
        <button onClick={() => setShowHelp(true)}>
          <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </button>
      </header>

      {/* Tab Navigation */}
      <nav className="flex bg-gray-900 border-b border-gray-800">
        {(['canvas', 'controls', 'details'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setMobileActiveTab(tab)}
            className={`flex-1 py-3 text-sm font-medium capitalize ${
              mobileActiveTab === tab 
                ? 'text-blue-400 border-b-2 border-blue-400' 
                : 'text-gray-400'
            }`}
          >
            {tab}
          </button>
        ))}
      </nav>

      {/* Tab Content */}
      <main className="flex-1 overflow-hidden">
        {mobileActiveTab === 'canvas' && (
          <Canvas
            nodes={nodesArray}
            connections={connectionsArray}
            viewport={viewport}
            selectedNodeId={selectedNode?.id || null}
            onNodeClick={(node: Node) => {
              handleNodeClick(node);
              setMobileActiveTab('details');
            }}
            onNodeMove={handleNodeMove}
            onNodeDelete={handleNodeDelete}
            onBackgroundClick={handleCanvasBackgroundClick}
            onViewportChange={handleViewportChange}
          />
        )}
        
        {mobileActiveTab === 'controls' && (
          <div className="h-full overflow-y-auto p-4 space-y-6">
            <SourcePanel 
              onAddSource={(result: any) => {
                const rawNode = result.node || result;
                const node = transformNodeFromBackend(rawNode);
                addNode(node);
                selectNode(node.id, false);
              }}
            />
            <MarketPanel 
              onAddMarket={(result: any) => {
                const rawNode = result.node || result;
                const node = transformNodeFromBackend(rawNode);
                addNode(node);
                selectNode(node.id, false);
              }}
            />
          </div>
        )}
        
        {mobileActiveTab === 'details' && selectedNode ? (
          <div className="h-full overflow-y-auto p-4">
            <NodeDetailsPanel 
              node={selectedNode} 
              connections={connections}
              nodes={nodes}
            />
          </div>
        ) : mobileActiveTab === 'details' ? (
          <div className="h-full flex items-center justify-center text-gray-500">
            Select a node to view details
          </div>
        ) : null}
      </main>

      {/* Mobile Bottom Sheet for Positions */}
      <div className="bg-gray-900 border-t border-gray-800 max-h-48 overflow-hidden">
        <div className="p-4 text-center text-gray-500 text-sm">
          Position monitor coming soon...
        </div>
      </div>
    </div>
  );

  // -------------------------------------------------------------------------
  // Main Render
  // -------------------------------------------------------------------------
  
  return (
    <>
      {/* Responsive Layout Selection */}
      {layoutMode === 'desktop' && renderDesktop()}
      {layoutMode === 'tablet' && renderTablet()}
      {layoutMode === 'mobile' && renderMobile()}

      {/* Global Modals */}
      <Modal
        isOpen={showHelp}
        onClose={() => setShowHelp(false)}
        title="Keyboard Shortcuts"
      >
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <kbd className="px-2 py-1 bg-gray-800 rounded text-gray-300">Ctrl/Cmd + S</kbd>
            </div>
            <div className="text-gray-400">Save graph</div>
            
            <div>
              <kbd className="px-2 py-1 bg-gray-800 rounded text-gray-300">Ctrl/Cmd + Z</kbd>
            </div>
            <div className="text-gray-400">Undo</div>
            
            <div>
              <kbd className="px-2 py-1 bg-gray-800 rounded text-gray-300">Ctrl/Cmd + Shift + Z</kbd>
            </div>
            <div className="text-gray-400">Redo</div>
            
            <div>
              <kbd className="px-2 py-1 bg-gray-800 rounded text-gray-300">Ctrl/Cmd + B</kbd>
            </div>
            <div className="text-gray-400">Toggle bottom panel</div>
            
            <div>
              <kbd className="px-2 py-1 bg-gray-800 rounded text-gray-300">Esc</kbd>
            </div>
            <div className="text-gray-400">Deselect / Close panels</div>
            
            <div>
              <kbd className="px-2 py-1 bg-gray-800 rounded text-gray-300">F11</kbd>
            </div>
            <div className="text-gray-400">Toggle fullscreen</div>
          </div>
        </div>
      </Modal>
    </>
  );
}

// =============================================================================
// EXPORTS
// =============================================================================

export default App;
