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

import { type ReactNode, useState, useEffect } from 'react';
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
    // Check if this is a series node
    if (metadata.is_series === true) {
      const markets = (metadata.series_markets as Array<{ title?: string; is_resolved?: boolean }>) || [];
      const activeMarkets = markets.filter((m) => !m?.is_resolved);
      const items = activeMarkets.slice(0, 5).map((m) => m?.title || 'Unknown');
      if (activeMarkets.length > 5) {
        items.push(`+${activeMarkets.length - 5} more`);
      }
      return {
        label: `Series Markets (${activeMarkets.length} active)`,
        items: items.length > 0 ? items : ['No active markets'],
      };
    }

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

      {/* Storage Usage - shown for ALL node types */}
      <StorageUsageIndicator nodeId={node.id} />

      {/* Data Retention - shown for InfoSource and Market nodes */}
      {(isInfoSource(node) || isMarket(node)) && (
        <DataRetentionSelector node={node} metadata={metadata} />
      )}

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
          <StorageIntervalSlider node={node} metadata={metadata} nodeCategory="infosource" />
        )}
        {/* Storage Interval Adjustment for Finnhub FinancialPrices */}
        {isInfoSource(node) && nodeSubtype === 'FinancialPrices' && metadata.provider === 'finnhub' && (
          <StorageIntervalSlider node={node} metadata={metadata} nodeCategory="infosource" />
        )}
        {/* Storage Interval Adjustment for CommodityPrices (Finnhub or Binance) */}
        {isInfoSource(node) && nodeSubtype === 'CommodityPrices' && (metadata.provider === 'finnhub' || metadata.provider === 'binance') && (
          <StorageIntervalSlider node={node} metadata={metadata} nodeCategory="infosource" />
        )}
      </div>

      {/* Market Node Details - Static Info */}
      {isMarket(node) && (
        <div className="bg-gray-800/50 rounded-lg p-3">
          <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Market Details</h3>
          <div className="space-y-1.5 text-xs">
            {(metadata.title || metadata.question) && (
              <div className="text-gray-300 font-medium">
                {metadata.title || metadata.question}
              </div>
            )}
            {metadata.description && (
              <p className="text-gray-500 text-wrap">{metadata.description}</p>
            )}
            {metadata.category && (
              <ConfigRow label="Category" value={metadata.category} />
            )}
            {(metadata.market_status || metadata.status) && (
              <div className="flex justify-between">
                <span className="text-gray-500">Status:</span>
                <span className={`${
                  (metadata.market_status || metadata.status) === 'open' ? 'text-green-400' :
                  (metadata.market_status || metadata.status) === 'closed' ? 'text-yellow-400' :
                  (metadata.market_status || metadata.status) === 'resolved' ? 'text-blue-400' : 'text-gray-400'
                }`}>
                  {(metadata.market_status || metadata.status).charAt(0).toUpperCase() + (metadata.market_status || metadata.status).slice(1)}
                </span>
              </div>
            )}
            {(metadata.created_at || metadata.createdAt) && (
              <ConfigRow
                label="Created"
                value={new Date(metadata.created_at || metadata.createdAt).toLocaleDateString()}
              />
            )}
            {metadata.end_date && (
              <ConfigRow
                label="Closes"
                value={new Date(metadata.end_date).toLocaleDateString()}
              />
            )}
            {metadata.resolution_date && (
              <ConfigRow
                label="Resolves"
                value={new Date(metadata.resolution_date).toLocaleDateString()}
              />
            )}
            {metadata.slug && (
              <ConfigRow label="Slug" value={metadata.slug} mono />
            )}
            {metadata.condition_id && (
              <ConfigRow label="Condition ID" value={metadata.condition_id} mono />
            )}
            {metadata.market_id && (
              <ConfigRow label="Market ID" value={metadata.market_id} mono />
            )}
            {metadata.tags && Array.isArray(metadata.tags) && metadata.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {metadata.tags.map((tag: string, idx: number) => (
                  <span
                    key={idx}
                    className="px-2 py-0.5 bg-gray-700 text-gray-400 rounded text-xs"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
            {(metadata.image_url || metadata.imageUrl) && (
              <div className="mt-2">
                <img
                  src={metadata.image_url || metadata.imageUrl}
                  alt="Market"
                  className="w-full h-24 object-cover rounded"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              </div>
            )}

            {/* Show placeholder if no details available */}
            {!metadata.title && !metadata.question && !metadata.description && !metadata.category &&
             !metadata.market_status && !metadata.status && !metadata.created_at &&
             !metadata.end_date && !metadata.slug && !metadata.condition_id && (
              <p className="text-gray-600 italic">No additional details available</p>
            )}
          </div>

          {/* Storage Interval Adjustment for Market nodes */}
          <StorageIntervalSlider node={node} metadata={metadata} nodeCategory="market" />
        </div>
      )}

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

/** Slider to adjust the DB storage interval for nodes that persist data. */
function StorageIntervalSlider({
  node,
  metadata,
  nodeCategory = 'infosource',
}: {
  node: Node;
  metadata: Record<string, any>;
  nodeCategory?: 'infosource' | 'market';
}) {
  const updateNodeMetadata = useStore((state: StoreState) => state.updateNodeMetadata);
  const [localMode, setLocalMode] = useState<string>(metadata.storage_mode || 'off');
  const [localInterval, setLocalInterval] = useState<number>(metadata.storage_interval_seconds || 1);

  // Sync from metadata if it changes externally
  useEffect(() => {
    setLocalMode(metadata.storage_mode || 'off');
    setLocalInterval(metadata.storage_interval_seconds || 1);
  }, [metadata.storage_mode, metadata.storage_interval_seconds]);

  const handleIntervalChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const newInterval = parseInt(e.target.value);
    setLocalInterval(newInterval);
    try {
      if (nodeCategory === 'market') {
        await invoke('set_market_storage_interval_cmd', {
          nodeId: node.id,
          intervalMs: newInterval * 1000,
          storageMode: localMode,
        });
      } else {
        await invoke('update_data_source_cmd', {
          node_id: node.id,
          config: {
            ...metadata,
            storage_interval_seconds: newInterval,
            storageIntervalMs: newInterval * 1000,
          },
        });
      }
      updateNodeMetadata(node.id, {
        ...metadata,
        storage_interval_seconds: newInterval,
        storageIntervalMs: newInterval * 1000,
        ...(nodeCategory === 'market' ? { storage_mode: localMode } : {}),
      });
    } catch (err) {
      console.error('Failed to update storage interval:', err);
    }
  };

  const handleModeChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newMode = e.target.value;
    setLocalMode(newMode);
    try {
      await invoke('set_market_storage_interval_cmd', {
        nodeId: node.id,
        intervalMs: localInterval * 1000,
        storageMode: newMode,
      });
      updateNodeMetadata(node.id, {
        ...metadata,
        storage_mode: newMode,
        storage_interval_seconds: localInterval,
        storageIntervalMs: localInterval * 1000,
      });
    } catch (err) {
      console.error('Failed to update storage mode:', err);
    }
  };

  return (
    <div className="mt-3 pt-3 border-t border-gray-700">
      {/* Storage mode selector for market nodes */}
      {nodeCategory === 'market' && (
        <div className="mb-3">
          <label className="block text-xs text-gray-400 mb-1">DB Storage Mode</label>
          <select
            value={localMode}
            onChange={handleModeChange}
            className="w-full bg-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 border border-gray-600 focus:border-blue-500 focus:outline-none"
          >
            <option value="off">Off - No DB storage</option>
            <option value="best_bid_ask">Best Bid/Ask - Top of book only</option>
            <option value="full_orderbook">Full Orderbook - All price levels</option>
          </select>
          <p className="text-xs text-gray-600 mt-1">
            {localMode === 'off' && 'Orderbook data streams in real-time but is not persisted.'}
            {localMode === 'best_bid_ask' && 'Stores best bid/ask prices and sizes at each interval.'}
            {localMode === 'full_orderbook' && 'Stores all orderbook levels at each interval. Uses more storage.'}
          </p>
        </div>
      )}

      {/* Interval slider - shown when storage is enabled (or for infosource nodes) */}
      {(nodeCategory !== 'market' || localMode !== 'off') && (
        <>
          <label className="block text-xs text-gray-400 mb-1">DB Storage Interval</label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min="1"
              max="300"
              step="1"
              value={localInterval}
              onChange={handleIntervalChange}
              className="flex-1 h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer"
            />
            <span className="text-xs text-gray-400 w-8">{localInterval}s</span>
          </div>
          <p className="text-xs text-gray-600 mt-1">
            Raw stream updates in real-time. DB writes at this interval.
          </p>
        </>
      )}
    </div>
  );
}

/** Displays per-node storage usage: estimated size, data rate, row counts. */
function StorageUsageIndicator({ nodeId }: { nodeId: string }) {
  const [usage, setUsage] = useState<{
    timeseries_rows: number;
    websocket_message_rows: number;
    estimated_bytes: number;
    data_rate_bytes_per_sec: number;
  } | null>(null);

  useEffect(() => {
    let mounted = true;
    const fetchUsage = async () => {
      try {
        const result = await invoke<{
          node_id: string;
          timeseries_rows: number;
          websocket_message_rows: number;
          estimated_bytes: number;
          data_rate_bytes_per_sec: number;
        }>('get_node_storage_usage_cmd', { nodeId });
        if (mounted) setUsage(result);
      } catch (err) {
        console.error('Failed to fetch storage usage:', err);
      }
    };
    fetchUsage();
    const timer = setInterval(fetchUsage, 10000);
    return () => { mounted = false; clearInterval(timer); };
  }, [nodeId]);

  if (!usage) return null;

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const formatRate = (bps: number): string => {
    if (bps < 1) return `< 1 B/s`;
    if (bps < 1024) return `${bps.toFixed(1)} B/s`;
    if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
    return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  };

  const totalRows = usage.timeseries_rows + usage.websocket_message_rows;

  return (
    <div className="bg-gray-800/50 rounded-lg p-3">
      <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Storage Usage</h3>
      <div className="space-y-1 text-xs">
        <ConfigRow label="Total Size" value={formatBytes(usage.estimated_bytes)} />
        <ConfigRow label="Data Rate" value={formatRate(usage.data_rate_bytes_per_sec)} />
        <ConfigRow label="Total Rows" value={totalRows.toLocaleString()} />
        {usage.timeseries_rows > 0 && (
          <ConfigRow label="Timeseries" value={usage.timeseries_rows.toLocaleString()} />
        )}
        {usage.websocket_message_rows > 0 && (
          <ConfigRow label="WS Messages" value={usage.websocket_message_rows.toLocaleString()} />
        )}
      </div>
    </div>
  );
}

/** Dropdown to set auto-deletion retention period for node data. */
function DataRetentionSelector({
  node,
  metadata,
}: {
  node: Node;
  metadata: Record<string, any>;
}) {
  const updateNodeMetadata = useStore((state: StoreState) => state.updateNodeMetadata);
  const currentRetention = metadata.retentionPeriodSeconds as number | null | undefined;

  const RETENTION_OPTIONS: { label: string; value: number | null }[] = [
    { label: 'Keep Forever', value: null },
    { label: '1 Hour', value: 3600 },
    { label: '6 Hours', value: 21600 },
    { label: '24 Hours', value: 86400 },
    { label: '3 Days', value: 259200 },
    { label: '7 Days', value: 604800 },
    { label: '30 Days', value: 2592000 },
  ];

  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const raw = e.target.value;
    const newRetention = raw === '' ? null : parseInt(raw);

    try {
      await invoke('set_node_retention_period_cmd', {
        nodeId: node.id,
        retentionSeconds: newRetention,
      });
      updateNodeMetadata(node.id, {
        ...metadata,
        retentionPeriodSeconds: newRetention,
      });
    } catch (err) {
      console.error('Failed to update retention period:', err);
    }
  };

  const formatRetention = (seconds: number): string => {
    if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} hours`;
    return `${Math.round(seconds / 86400)} days`;
  };

  return (
    <div className="bg-gray-800/50 rounded-lg p-3">
      <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Data Retention</h3>
      <select
        value={currentRetention ?? ''}
        onChange={handleChange}
        className="w-full bg-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 border border-gray-600 focus:border-blue-500 focus:outline-none"
      >
        {RETENTION_OPTIONS.map((opt) => (
          <option key={opt.value ?? 'forever'} value={opt.value ?? ''}>
            {opt.label}
          </option>
        ))}
      </select>
      <p className="text-xs text-gray-600 mt-1">
        {currentRetention
          ? `Data older than ${formatRetention(currentRetention)} will be automatically deleted.`
          : 'All stored data will be kept indefinitely.'}
      </p>
    </div>
  );
}

export default NodeDetailsPanelExtracted;
