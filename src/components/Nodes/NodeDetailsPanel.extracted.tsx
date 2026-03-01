// ============================================================================
// NODE DETAILS PANEL COMPONENT
// ============================================================================
//
// Module: components/Nodes/NodeDetailsPanel.extracted.tsx
// Purpose: Displays detailed information about a selected node including
//          monitoring sources, connections, incoming data, and configuration.
//
// Extracted from App.tsx to improve modularity and reduce file size.
// ============================================================================

import { type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStore, type StoreState } from '../../store';
import type { Node } from '../../types/nodes';
import {
  isInfoSource,
  isMarket,
  isAnalyzer,
  isAlert,
  getNodeSubtype,
  getTypeDisplayName,
  getNodeColorScheme,
  getNodeDisplayName,
  getMetadata,
  getNodeCategoryEmoji,
  getNodeCategoryLabel,
} from '../../utils/nodeHelpers';

// =============================================================================
// TYPES
// =============================================================================

export interface NodeDetailsPanelProps {
  node: Node | null;
  connections: { source: string; target: string; strength?: number }[];
  nodes: Record<string, Node>;
}

// =============================================================================
// MONITORING INFO HELPERS
// =============================================================================

interface MonitoringInfo {
  label: string;
  items: string[];
}

/**
 * Determines what a node is monitoring based on its type and metadata.
 * Returns a label and list of monitored items for display.
 */
function getMonitoringInfo(
  node: Node,
  nodes: Record<string, Node>,
): MonitoringInfo | null {
  const metadata = getMetadata(node) as Record<string, any>;

  if (isInfoSource(node)) {
    const subtype = getNodeSubtype(node.node_type);

    const MONITORING_CONFIG: Record<string, { label: string; fallback: string[]; field: string }> = {
      CryptoPrices:       { label: 'Monitoring Cryptos',      field: 'symbols',    fallback: ['BTC', 'ETH', 'SOL'] },
      FinancialPrices:    { label: 'Monitoring Stocks',       field: 'symbols',    fallback: ['SPY', 'QQQ'] },
      CommodityPrices:    { label: 'Monitoring Commodities',  field: 'symbols',    fallback: ['Gold', 'Oil', 'Silver'] },
      NewsSource:         { label: 'News Sources',            field: 'feeds',      fallback: ['Reuters', 'AP', 'Bloomberg'] },
      SocialMedia:        { label: 'Social Platforms',         field: 'platforms',  fallback: ['Twitter/X', 'Reddit'] },
      Weather:            { label: 'Locations',               field: 'locations',  fallback: ['NYC', 'London'] },
      Livestream:         { label: 'Platforms',               field: 'platforms',  fallback: ['YouTube', 'Twitch'] },
      EconomicIndicators: { label: 'Indicators',             field: 'indicators', fallback: ['CPI', 'Unemployment', 'GDP'] },
      OnChainData:        { label: 'Metrics',                field: 'metrics',    fallback: ['Transaction Volume', 'Gas Fees'] },
      CustomAPI:          { label: 'Endpoints',              field: 'endpoints',  fallback: [metadata.endpoint || 'Custom API'] },
    };

    const config = MONITORING_CONFIG[subtype];
    if (config) {
      return {
        label: config.label,
        items: metadata[config.field] || metadata.symbols || metadata.sources || config.fallback,
      };
    }

    return {
      label: 'Data Sources',
      items: metadata.symbols || metadata.sources || ['Unknown'],
    };
  }

  if (isMarket(node)) {
    const subtype = getNodeSubtype(node.node_type);
    const marketId = metadata.marketId || metadata.market_id;
    const question = metadata.question || metadata.marketQuestion;

    const items: string[] = [];
    if (question) items.push(question);
    if (marketId) items.push(`Market ID: ${marketId}`);
    if (metadata.symbols) items.push(...metadata.symbols);
    if (items.length === 0) {
      items.push(subtype === 'Polymarket' ? 'Prediction Markets' : 'Event Contracts');
    }

    return {
      label: subtype === 'Polymarket' ? 'Polymarket Markets' : 'Kalshi Markets',
      items,
    };
  }

  if (isAnalyzer(node)) {
    const inputs = (metadata.inputs as string[]) || [];
    const inputNames = inputs.map((id: string) => {
      const inputNode = nodes[id];
      if (!inputNode) return id;
      const inputMeta = getMetadata(inputNode) as Record<string, any>;
      return inputMeta.name || inputNode.name || inputNode.id || id;
    });

    return {
      label: 'Analyzing From',
      items: inputNames.length > 0 ? inputNames : ['No inputs configured'],
    };
  }

  if (isAlert(node)) {
    const condition = metadata.condition as { sourceId?: string; operator?: string; threshold?: number } | undefined;
    if (condition) {
      const sourceNode = condition.sourceId ? nodes[condition.sourceId] : undefined;
      const sourceMeta = sourceNode ? (getMetadata(sourceNode) as Record<string, any>) : undefined;
      return {
        label: 'Watching',
        items: [
          sourceMeta?.name || sourceNode?.name || sourceNode?.id || condition.sourceId || 'Unknown source',
          `Condition: ${condition.operator} ${condition.threshold}`,
        ],
      };
    }
    return { label: 'Alert Status', items: ['Not configured'] };
  }

  return null;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Displays detailed information about a selected node:
 * - Type & name header with color-coded indicator
 * - Monitoring targets (symbols, markets, sources, etc.)
 * - Incoming/outgoing connections
 * - Incoming data (for Market nodes receiving from InfoSources)
 * - Configuration details (update interval, exchange, provider, etc.)
 * - Technical details (ID, position, timestamps) in a collapsible section
 */
export function NodeDetailsPanelExtracted({
  node,
  connections,
  nodes,
}: NodeDetailsPanelProps): ReactNode {
  if (!node) {
    return (
      <div className="text-gray-500 text-center py-8">
        <p>No node selected</p>
      </div>
    );
  }

  const metadata = getMetadata(node) as Record<string, any>;
  const nodeSubtype = getNodeSubtype(node.node_type);
  const colorScheme = getNodeColorScheme(node);
  const monitoringInfo = getMonitoringInfo(node, nodes);

  // Compute connected nodes
  const incomingNodes = connections
    .filter((conn) => conn.target === node.id)
    .map((conn) => ({ node: nodes[conn.source], strength: conn.strength }))
    .filter((c) => c.node);

  const outgoingNodes = connections
    .filter((conn) => conn.source === node.id)
    .map((conn) => ({ node: nodes[conn.target], strength: conn.strength }))
    .filter((c) => c.node);

  return (
    <div className="text-gray-300 text-sm space-y-4">
      {/* Node Type Header */}
      <div className="pb-3 border-b border-gray-700">
        <div className="flex items-center gap-2 mb-1">
          <div className={`w-3 h-3 rounded-full ${colorScheme.dot}`} />
          <span className="font-semibold text-white">{getNodeDisplayName(node)}</span>
        </div>
        <p className="text-xs text-gray-500">
          {getNodeCategoryEmoji(node)} {getNodeCategoryLabel(node)}
        </p>
      </div>

      {/* Monitoring Info */}
      {monitoringInfo && (
        <div className="bg-gray-800/50 rounded-lg p-3">
          <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">
            {monitoringInfo.label}
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {monitoringInfo.items.map((item, idx) => (
              <span
                key={idx}
                className={`px-2 py-1 rounded text-xs font-medium ${colorScheme.tagBg} ${colorScheme.tagText} border ${colorScheme.tagBorder}`}
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
                const nMeta = getMetadata(n) as Record<string, any>;
                return (
                  <div key={idx} className="flex items-center gap-2 text-xs">
                    <div className="w-2 h-2 rounded-full bg-blue-500" />
                    <span className="text-blue-300">{nMeta.name || n.name || n.id?.slice(0, 8)}</span>
                    {strength != null && (
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
                const nMeta = getMetadata(n) as Record<string, any>;
                return (
                  <div key={idx} className="flex items-center gap-2 text-xs">
                    <div className="w-2 h-2 rounded-full bg-emerald-500" />
                    <span className="text-emerald-300">{nMeta.name || n.name || n.id?.slice(0, 8)}</span>
                    {strength != null && (
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

      {/* Incoming Data from InfoSources (for Market nodes) */}
      {isMarket(node) && metadata.incomingData && Object.keys(metadata.incomingData).length > 0 && (
        <div className="bg-gray-800/50 rounded-lg p-3">
          <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">
            Incoming Data ({Object.keys(metadata.incomingData).length} sources)
          </h3>
          <div className="space-y-2">
            {Object.entries(metadata.incomingData).map(([sourceId, sourceData]: [string, any]) => (
              <div key={sourceId} className="bg-gray-900/50 rounded p-2 text-xs">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-blue-300 font-medium">{sourceData.sourceName}</span>
                  {sourceData.strength && (
                    <span className="text-gray-500">{Math.round(sourceData.strength * 100)}% strength</span>
                  )}
                </div>
                {sourceData.symbol && (
                  <div className="flex items-center gap-2 text-gray-400">
                    <span className="font-mono">{sourceData.symbol}</span>
                    {sourceData.price !== undefined && (
                      <>
                        <span className="text-emerald-400">${sourceData.price.toFixed(2)}</span>
                        {sourceData.bid && sourceData.ask && (
                          <span className="text-gray-600">
                            (bid: ${sourceData.bid.toFixed(2)} / ask: ${sourceData.ask.toFixed(2)})
                          </span>
                        )}
                      </>
                    )}
                  </div>
                )}
                {sourceData.timestamp && (
                  <div className="text-gray-600 mt-1">
                    Last update: {new Date(sourceData.timestamp).toLocaleTimeString()}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Configuration Details */}
      <div className="bg-gray-800/50 rounded-lg p-3">
        <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Configuration</h3>
        <div className="space-y-1 text-xs">
          <ConfigRow label="Type" value={getTypeDisplayName(nodeSubtype)} />
          {metadata.updateIntervalSeconds && (
            <ConfigRow label="Update Interval" value={`${metadata.updateIntervalSeconds}s`} />
          )}
          {metadata.exchange && <ConfigRow label="Exchange" value={metadata.exchange} />}
          {metadata.provider && <ConfigRow label="Provider" value={metadata.provider} />}
          {metadata.storage_interval_seconds && (
            <ConfigRow label="DB Storage Interval" value={`${metadata.storage_interval_seconds}s`} />
          )}
          {metadata.autoTrade !== undefined && (
            <div className="flex justify-between">
              <span className="text-gray-500">Auto Trade:</span>
              <span className={metadata.autoTrade ? 'text-green-400' : 'text-gray-400'}>
                {metadata.autoTrade ? 'Enabled' : 'Disabled'}
              </span>
            </div>
          )}
          {metadata.trading?.maxPositionSize && (
            <ConfigRow label="Max Position" value={`${metadata.trading.maxPositionSize} contracts`} />
          )}
        </div>

        {/* Storage Interval Adjustment for Coinbase CryptoPrices */}
        {isInfoSource(node) && nodeSubtype === 'CryptoPrices' && metadata.provider === 'coinbase' && (
          <StorageIntervalSlider node={node} metadata={metadata} />
        )}
      </div>

      {/* Technical Details (collapsible) */}
      <details className="bg-gray-800/30 rounded-lg">
        <summary className="p-3 cursor-pointer text-xs font-semibold text-gray-400 uppercase hover:bg-gray-800/50 rounded-lg">
          Technical Details
        </summary>
        <div className="px-3 pb-3 space-y-1 text-xs">
          <ConfigRow label="ID" value={node.id} mono />
          <ConfigRow
            label="Position"
            value={`[${node.position?.[0]?.toFixed(0) ?? 0}, ${node.position?.[1]?.toFixed(0) ?? 0}]`}
          />
          <ConfigRow
            label="Created"
            value={node.createdAt ? new Date(node.createdAt).toLocaleString() : 'N/A'}
          />
          <ConfigRow
            label="Updated"
            value={node.updatedAt ? new Date(node.updatedAt).toLocaleString() : 'N/A'}
          />
        </div>
      </details>
    </div>
  );
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

/** Simple label/value row for configuration display. */
function ConfigRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}:</span>
      <span className={mono ? 'text-gray-400 font-mono' : 'text-gray-300'}>{value}</span>
    </div>
  );
}

/** Slider to adjust the DB storage interval for Coinbase CryptoPrices nodes. */
function StorageIntervalSlider({
  node,
  metadata,
}: {
  node: Node;
  metadata: Record<string, any>;
}) {
  const updateNodeMetadata = useStore((state: StoreState) => state.updateNodeMetadata);

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const newInterval = parseInt(e.target.value);
    try {
      await invoke('update_data_source_cmd', {
        node_id: node.id,
        config: {
          ...metadata,
          storage_interval_seconds: newInterval,
          storageIntervalMs: newInterval * 1000,
        },
      });
      updateNodeMetadata(node.id, {
        ...metadata,
        storage_interval_seconds: newInterval,
        storageIntervalMs: newInterval * 1000,
      });
    } catch (err) {
      console.error('Failed to update storage interval:', err);
    }
  };

  return (
    <div className="mt-3 pt-3 border-t border-gray-700">
      <label className="block text-xs text-gray-400 mb-1">Adjust DB Storage Interval</label>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min="10"
          max="300"
          step="10"
          value={metadata.storage_interval_seconds || 60}
          onChange={handleChange}
          className="flex-1 h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer"
        />
        <span className="text-xs text-gray-400 w-8">{metadata.storage_interval_seconds || 60}s</span>
      </div>
      <p className="text-xs text-gray-600 mt-1">
        Raw stream updates in real-time. DB writes at this interval.
      </p>
    </div>
  );
}

export default NodeDetailsPanelExtracted;
