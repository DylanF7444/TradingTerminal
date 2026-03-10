// ============================================================================
// GLOBAL ORDERBOOK OVERLAY COMPONENT
// ============================================================================
//
// Module: components/Markets/GlobalOrderbookOverlay.tsx
// Purpose: Full-screen overlay for displaying orderbook data for market nodes
//
// OVERVIEW:
// This component provides an expanded orderbook view that appears as an overlay
// on top of the canvas when a market node is selected. It reads real-time
// orderbook data from the central Zustand store (populated by the always-on
// persistent orderbook monitor) and displays price charts, raw WebSocket
// message streams in a comprehensive layout suitable for detailed analysis.
//
// DATA FLOW:
// - Reads from store.orderbooks[marketId] (populated by usePersistentOrderbooks)
// - For Polymarket, reads both YES and NO token orderbooks
// - No per-component WebSocket subscription needed
// - Raw stream view still uses useRawOrderbookMessages listener
//
// FEATURES:
// - Full orderbook view with multiple price levels
// - Shows both YES and NO orderbooks for Polymarket markets
// - Real-time price updates and spread calculation
// - Raw WebSocket message stream viewer
// - Trade history
// - Connection status indicator
// - Close button and keyboard escape handling
//
// ============================================================================

import React, { useMemo, useEffect, useState, useCallback } from 'react';
import { useRawOrderbookMessages } from '../../hooks/useOrderbook';
import { useStore } from '../../store';
import type { Orderbook } from '../../types/markets';

// =============================================================================
// TYPES
// =============================================================================

interface GlobalOrderbookOverlayProps {
  /** Market ID to subscribe to */
  marketId: string;
  /** Platform: polymarket or kalshi */
  platform: 'polymarket' | 'kalshi';
  /** Market question/description */
  marketQuestion?: string;
  /** CLOB token IDs for Polymarket (asset IDs for WebSocket subscription) */
  tokenIds?: string[];
  /** Callback when overlay is closed */
  onClose: () => void;
  /** Additional CSS classes */
  className?: string;
}

type ViewTab = 'orderbook' | 'raw' | 'trades';

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function formatPrice(price: number): string {
  return `${(price * 100).toFixed(1)}¢`;
}

function formatSize(size: number): string {
  if (size >= 1000000) return `${(size / 1000000).toFixed(2)}M`;
  if (size >= 1000) return `${(size / 1000).toFixed(1)}K`;
  return size.toFixed(0);
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  });
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  if (diff < 1000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return formatTimestamp(timestamp);
}

// =============================================================================
// SINGLE SIDE ORDERBOOK SUB-COMPONENT
// =============================================================================

const OrderbookSide: React.FC<{
  label: string;
  labelColor: string;
  headerBg: string;
  orderbook: Orderbook | undefined;
  maxSize: number;
}> = ({ label, labelColor, headerBg, orderbook, maxSize }) => {
  if (!orderbook || (orderbook.bids.length === 0 && orderbook.asks.length === 0)) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className={`text-center py-2 ${headerBg} border-b border-gray-700/50`}>
          <span className={`text-sm font-medium ${labelColor}`}>{label}</span>
        </div>
        <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
          No data
        </div>
      </div>
    );
  }

  const bestBid = orderbook.bids[0]?.price ?? 0;
  const bestAsk = orderbook.asks[0]?.price ?? 0;
  const spread = bestAsk - bestBid;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Side header */}
      <div className={`flex items-center justify-between px-3 py-2 ${headerBg} border-b border-gray-700/50`}>
        <span className={`text-sm font-medium ${labelColor}`}>{label}</span>
        <div className="flex items-center space-x-3 text-xs text-gray-500">
          <span>Bid: <span className="text-green-400 font-mono">{formatPrice(bestBid)}</span></span>
          <span>Ask: <span className="text-red-400 font-mono">{formatPrice(bestAsk)}</span></span>
          <span>Spread: <span className="text-gray-300 font-mono">{(spread * 100).toFixed(1)}¢</span></span>
        </div>
      </div>

      {/* Orderbook levels */}
      <div className="flex-1 flex overflow-hidden">
        {/* Asks */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-2 py-1 bg-red-900/20 border-b border-red-900/30">
            <span className="text-xs font-medium text-red-400">ASKS</span>
            <span className="text-xs text-gray-500">{orderbook.asks.length} lvls</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {orderbook.asks.slice(0, 20).map((level, i) => (
              <div
                key={`ask-${i}`}
                className="relative flex items-center justify-between px-2 py-1 hover:bg-red-900/10"
              >
                <div
                  className="absolute right-0 top-0 bottom-0 bg-red-500/10"
                  style={{ width: `${(level.size / maxSize) * 100}%` }}
                />
                <span className="relative text-red-400 font-mono text-sm">{formatPrice(level.price)}</span>
                <span className="relative text-gray-400 font-mono text-sm">{formatSize(level.size)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="w-px bg-gray-700 mx-1" />

        {/* Bids */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-2 py-1 bg-green-900/20 border-b border-green-900/30">
            <span className="text-xs font-medium text-green-400">BIDS</span>
            <span className="text-xs text-gray-500">{orderbook.bids.length} lvls</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {orderbook.bids.slice(0, 20).map((level, i) => (
              <div
                key={`bid-${i}`}
                className="relative flex items-center justify-between px-2 py-1 hover:bg-green-900/10"
              >
                <div
                  className="absolute left-0 top-0 bottom-0 bg-green-500/10"
                  style={{ width: `${(level.size / maxSize) * 100}%` }}
                />
                <span className="relative text-green-400 font-mono text-sm">{formatPrice(level.price)}</span>
                <span className="relative text-gray-400 font-mono text-sm">{formatSize(level.size)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Last trade */}
      {orderbook.lastPrice && (
        <div className="flex items-center justify-center px-2 py-1 bg-gray-800/30 border-t border-gray-700/50">
          <span className="text-xs text-gray-400">
            Last: <span className="text-white font-mono">{formatPrice(orderbook.lastPrice)}</span>
            {orderbook.lastSize ? ` × ${formatSize(orderbook.lastSize)}` : ''}
          </span>
        </div>
      )}
    </div>
  );
};

// =============================================================================
// COMPONENT
// =============================================================================

export const GlobalOrderbookOverlay: React.FC<GlobalOrderbookOverlayProps> = ({
  marketId,
  platform,
  marketQuestion,
  tokenIds,
  onClose,
  className = '',
}) => {
  // ---------------------------------------------------------------------------
  // Central Store Orderbook Data
  // ---------------------------------------------------------------------------
  const allOrderbooks = useStore((s) => s.orderbooks);
  const marketStatusObj = useStore((s) => s.marketStatus[marketId]);
  const { rawMessages, clearMessages } = useRawOrderbookMessages(100, marketId);
  const [activeTab, setActiveTab] = useState<ViewTab>('orderbook');

  // For Polymarket: get both YES and NO orderbooks
  const yesOrderbook: Orderbook | undefined = allOrderbooks[marketId];
  const noTokenId = tokenIds && tokenIds.length > 1
    ? tokenIds.find(id => id !== marketId) ?? tokenIds[1]
    : undefined;
  const noOrderbook: Orderbook | undefined = noTokenId ? allOrderbooks[noTokenId] : undefined;
  const hasBothSides = platform === 'polymarket' && noTokenId !== undefined;

  // Use "orderbook" for backwards compat (refers to YES / primary token)
  const orderbook = yesOrderbook;

  // Derive connection status from store data
  const status = useMemo((): 'connected' | 'connecting' | 'stale' | 'error' => {
    const hasYesData = yesOrderbook && (yesOrderbook.bids.length > 0 || yesOrderbook.asks.length > 0);
    const hasNoData = noOrderbook && (noOrderbook.bids.length > 0 || noOrderbook.asks.length > 0);
    if (!hasYesData && !hasNoData) {
      return 'connecting';
    }
    if (marketStatusObj?.errorMessage) return 'error';
    const latestTimestamp = Math.max(yesOrderbook?.timestamp ?? 0, noOrderbook?.timestamp ?? 0);
    const age = Date.now() - latestTimestamp;
    if (age > 30_000) return 'stale';
    return 'connected';
  }, [yesOrderbook, noOrderbook, marketStatusObj]);

  const error = marketStatusObj?.errorMessage ?? null;

  // Recent trades placeholder (derived from orderbook if available)
  const recentTrades: Array<{ price: number; size: number; side: 'buy' | 'sell'; time: number }> = [];

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Calculate orderbook statistics (for YES / primary token)
  const stats = useMemo(() => {
    if (!orderbook) return null;

    const bids = orderbook.bids || [];
    const asks = orderbook.asks || [];

    const bestBid = bids[0]?.price || 0;
    const bestAsk = asks[0]?.price || 0;
    const spread = bestAsk - bestBid;
    const mid = (bestBid + bestAsk) / 2;

    const totalBidSize = bids.reduce((sum, b) => sum + b.size, 0);
    const totalAskSize = asks.reduce((sum, a) => sum + a.size, 0);
    const imbalance = totalBidSize + totalAskSize > 0
      ? (totalBidSize - totalAskSize) / (totalBidSize + totalAskSize)
      : 0;

    return {
      bestBid,
      bestAsk,
      spread,
      mid,
      totalBidSize,
      totalAskSize,
      imbalance,
      bidLevels: bids.length,
      askLevels: asks.length,
    };
  }, [orderbook]);

  // Calculate max size for depth chart scaling (across both sides)
  const maxSize = useMemo(() => {
    const allSizes: number[] = [];
    if (yesOrderbook) {
      allSizes.push(...yesOrderbook.bids.map(l => l.size), ...yesOrderbook.asks.map(l => l.size));
    }
    if (noOrderbook) {
      allSizes.push(...noOrderbook.bids.map(l => l.size), ...noOrderbook.asks.map(l => l.size));
    }
    return Math.max(...allSizes, 1);
  }, [yesOrderbook, noOrderbook]);

  // Prevent click propagation
  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm ${className}`}
      onClick={onClose}
    >
      <div
        className="bg-gray-900 rounded-xl shadow-2xl border border-gray-700 w-[90vw] max-w-[1200px] h-[85vh] max-h-[800px] flex flex-col overflow-hidden"
        onClick={handleOverlayClick}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-gray-800/50 border-b border-gray-700">
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <span className={`w-2 h-2 rounded-full ${
                status === 'connected' ? 'bg-green-400 animate-pulse' :
                status === 'connecting' ? 'bg-yellow-400 animate-pulse' :
                status === 'stale' ? 'bg-orange-400' : 'bg-red-400'
              }`} />
              <span className="text-sm font-medium text-gray-200">
                {platform === 'polymarket' ? 'Polymarket' : 'Kalshi'}
              </span>
            </div>
            {marketQuestion && (
              <span className="text-sm text-gray-400 truncate max-w-[400px]">
                {marketQuestion}
              </span>
            )}
          </div>

          <div className="flex items-center space-x-2">
            {/* Tab buttons */}
            <div className="flex rounded-lg bg-gray-700/50 p-0.5">
              {(['orderbook', 'raw', 'trades'] as ViewTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    activeTab === tab
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {tab === 'orderbook' ? 'Order Book' : tab === 'raw' ? 'Raw Stream' : 'Trades'}
                </button>
              ))}
            </div>

            {/* Close button */}
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

        {/* Main content */}
        <div className="flex-1 overflow-hidden flex">
          {/* Orderbook View */}
          {activeTab === 'orderbook' && (
            <>
              {/* Main orderbook area */}
              <div className="flex-1 flex flex-col overflow-hidden p-4">
                {status === 'connecting' ? (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center">
                      <div className="w-8 h-8 border-2 border-gray-600 border-t-blue-500 rounded-full animate-spin mx-auto mb-2" />
                      <span className="text-sm text-gray-400">Connecting...</span>
                    </div>
                  </div>
                ) : error ? (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center text-red-400">
                      <svg className="w-8 h-8 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <span className="text-sm">{error}</span>
                    </div>
                  </div>
                ) : !orderbook && !noOrderbook ? (
                  <div className="flex-1 flex items-center justify-center">
                    <span className="text-gray-500">No orderbook data</span>
                  </div>
                ) : hasBothSides ? (
                  /* Two-panel layout for YES and NO */
                  <>
                    {/* Stats bar (YES token) */}
                    {stats && (
                      <div className="flex items-center justify-between mb-3 px-2 py-2 bg-gray-800/30 rounded-lg">
                        <div className="flex items-center space-x-6">
                          <div>
                            <span className="text-xs text-gray-500">YES Bid</span>
                            <div className="text-green-400 font-mono font-medium">{formatPrice(stats.bestBid)}</div>
                          </div>
                          <div>
                            <span className="text-xs text-gray-500">YES Ask</span>
                            <div className="text-red-400 font-mono font-medium">{formatPrice(stats.bestAsk)}</div>
                          </div>
                          <div>
                            <span className="text-xs text-gray-500">Spread</span>
                            <div className="text-gray-300 font-mono">{(stats.spread * 100).toFixed(1)}¢</div>
                          </div>
                          <div>
                            <span className="text-xs text-gray-500">Mid</span>
                            <div className="text-gray-300 font-mono">{formatPrice(stats.mid)}</div>
                          </div>
                        </div>
                        <div className="flex items-center space-x-6">
                          <div>
                            <span className="text-xs text-gray-500">Imbalance</span>
                            <div className={`font-mono ${stats.imbalance > 0 ? 'text-green-400' : stats.imbalance < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                              {(stats.imbalance * 100).toFixed(1)}%
                            </div>
                          </div>
                          <div>
                            <span className="text-xs text-gray-500">Levels</span>
                            <div className="text-gray-300 font-mono">{stats.bidLevels} / {stats.askLevels}</div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Side-by-side YES/NO orderbooks */}
                    <div className="flex-1 flex gap-3 overflow-hidden">
                      <OrderbookSide
                        label="YES"
                        labelColor="text-green-400"
                        headerBg="bg-green-900/20"
                        orderbook={yesOrderbook}
                        maxSize={maxSize}
                      />
                      <OrderbookSide
                        label="NO"
                        labelColor="text-red-400"
                        headerBg="bg-red-900/20"
                        orderbook={noOrderbook}
                        maxSize={maxSize}
                      />
                    </div>
                  </>
                ) : (
                  /* Single orderbook layout (Kalshi or single-token) */
                  <>
                    {/* Stats bar */}
                    {stats && (
                      <div className="flex items-center justify-between mb-4 px-2 py-2 bg-gray-800/30 rounded-lg">
                        <div className="flex items-center space-x-6">
                          <div>
                            <span className="text-xs text-gray-500">Best Bid</span>
                            <div className="text-green-400 font-mono font-medium">{formatPrice(stats.bestBid)}</div>
                          </div>
                          <div>
                            <span className="text-xs text-gray-500">Best Ask</span>
                            <div className="text-red-400 font-mono font-medium">{formatPrice(stats.bestAsk)}</div>
                          </div>
                          <div>
                            <span className="text-xs text-gray-500">Spread</span>
                            <div className="text-gray-300 font-mono">{(stats.spread * 100).toFixed(1)}¢</div>
                          </div>
                          <div>
                            <span className="text-xs text-gray-500">Mid</span>
                            <div className="text-gray-300 font-mono">{formatPrice(stats.mid)}</div>
                          </div>
                        </div>
                        <div className="flex items-center space-x-6">
                          <div>
                            <span className="text-xs text-gray-500">Imbalance</span>
                            <div className={`font-mono ${stats.imbalance > 0 ? 'text-green-400' : stats.imbalance < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                              {(stats.imbalance * 100).toFixed(1)}%
                            </div>
                          </div>
                          <div>
                            <span className="text-xs text-gray-500">Levels</span>
                            <div className="text-gray-300 font-mono">{stats.bidLevels} / {stats.askLevels}</div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Orderbook table */}
                    <div className="flex-1 flex overflow-hidden">
                      {/* Asks */}
                      <div className="flex-1 flex flex-col overflow-hidden">
                        <div className="flex items-center justify-between px-2 py-1 bg-red-900/20 border-b border-red-900/30">
                          <span className="text-xs font-medium text-red-400">ASKS</span>
                          <span className="text-xs text-gray-500">{orderbook?.asks.length ?? 0} levels</span>
                        </div>
                        <div className="flex-1 overflow-y-auto">
                          {(orderbook?.asks ?? []).slice(0, 20).map((level, i) => (
                            <div
                              key={`ask-${i}`}
                              className="relative flex items-center justify-between px-2 py-1 hover:bg-red-900/10"
                            >
                              <div
                                className="absolute right-0 top-0 bottom-0 bg-red-500/10"
                                style={{ width: `${(level.size / maxSize) * 100}%` }}
                              />
                              <span className="relative text-red-400 font-mono text-sm">{formatPrice(level.price)}</span>
                              <span className="relative text-gray-400 font-mono text-sm">{formatSize(level.size)}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="w-px bg-gray-700 mx-2" />

                      {/* Bids */}
                      <div className="flex-1 flex flex-col overflow-hidden">
                        <div className="flex items-center justify-between px-2 py-1 bg-green-900/20 border-b border-green-900/30">
                          <span className="text-xs font-medium text-green-400">BIDS</span>
                          <span className="text-xs text-gray-500">{orderbook?.bids.length ?? 0} levels</span>
                        </div>
                        <div className="flex-1 overflow-y-auto">
                          {(orderbook?.bids ?? []).slice(0, 20).map((level, i) => (
                            <div
                              key={`bid-${i}`}
                              className="relative flex items-center justify-between px-2 py-1 hover:bg-green-900/10"
                            >
                              <div
                                className="absolute left-0 top-0 bottom-0 bg-green-500/10"
                                style={{ width: `${(level.size / maxSize) * 100}%` }}
                              />
                              <span className="relative text-green-400 font-mono text-sm">{formatPrice(level.price)}</span>
                              <span className="relative text-gray-400 font-mono text-sm">{formatSize(level.size)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Last trade */}
                    {orderbook?.lastPrice && (
                      <div className="flex items-center justify-center py-2 bg-gray-800/30 border-t border-gray-700/50 mt-2 rounded-lg">
                        <span className="text-sm text-gray-400">
                          Last: <span className="text-white font-mono">{formatPrice(orderbook.lastPrice)}</span>
                          {orderbook.lastSize ? ` × ${formatSize(orderbook.lastSize)}` : ''}
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Right side: Last trade & info (only for single-side layout) */}
              {!hasBothSides && (
                <div className="w-64 border-l border-gray-700 p-4 flex flex-col">
                  <h3 className="text-sm font-medium text-gray-300 mb-3">Last Trade</h3>
                  {orderbook?.lastPrice ? (
                    <div className="bg-gray-800/30 rounded-lg p-3 mb-4">
                      <div className="text-2xl font-mono font-medium text-white mb-1">
                        {formatPrice(orderbook.lastPrice)}
                      </div>
                      <div className="text-sm text-gray-400">
                        Size: {formatSize(orderbook.lastSize || 0)}
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-gray-500 mb-4">No recent trades</div>
                  )}

                  <h3 className="text-sm font-medium text-gray-300 mb-3">Recent Trades</h3>
                  <div className="flex-1 overflow-y-auto">
                    {recentTrades.length === 0 ? (
                      <div className="text-sm text-gray-500">No trades yet</div>
                    ) : (
                      recentTrades.slice(0, 10).map((trade, i) => (
                        <div key={i} className="flex items-center justify-between py-1 text-sm">
                          <span className={`font-mono ${trade.side === 'buy' ? 'text-green-400' : 'text-red-400'}`}>
                            {formatPrice(trade.price)}
                          </span>
                          <span className="text-gray-500 font-mono">{formatSize(trade.size)}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Raw Stream View */}
          {activeTab === 'raw' && (
            <div className="flex-1 flex flex-col overflow-hidden p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-gray-300">Raw WebSocket Messages</h3>
                <button
                  onClick={clearMessages}
                  className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1 rounded hover:bg-gray-700"
                >
                  Clear
                </button>
              </div>
              <div className="flex-1 overflow-y-auto space-y-2">
                {rawMessages.length === 0 ? (
                  <div className="text-center text-gray-500 py-8">
                    Waiting for messages...
                  </div>
                ) : (
                  rawMessages.map((msg, i) => (
                    <div
                      key={`${msg.timestamp}-${i}`}
                      className="border border-gray-700 rounded-lg overflow-hidden"
                    >
                      <div className="flex items-center justify-between px-3 py-2 bg-gray-800/50">
                        <div className="flex items-center space-x-2">
                          <span className="text-xs text-gray-500 font-mono">
                            {formatTimestamp(msg.timestamp)}
                          </span>
                          <span className={`px-1.5 py-0.5 rounded text-xs ${
                            msg.msg_type === 'trade' ? 'bg-yellow-900/50 text-yellow-400' :
                            msg.msg_type === 'book' || msg.msg_type === 'book_update' ? 'bg-blue-900/50 text-blue-400' :
                            msg.msg_type === 'ticker' ? 'bg-green-900/50 text-green-400' :
                            msg.msg_type === 'orderbook_delta' ? 'bg-purple-900/50 text-purple-400' :
                            'bg-gray-700/50 text-gray-400'
                          }`}>
                            {msg.msg_type || 'unknown'}
                          </span>
                        </div>
                        <span className="text-xs text-gray-600">{msg.platform}</span>
                      </div>
                      <pre className="p-3 text-xs text-gray-300 font-mono whitespace-pre-wrap break-all max-h-[150px] overflow-y-auto">
                        {msg.raw_message}
                      </pre>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Trades View */}
          {activeTab === 'trades' && (
            <div className="flex-1 flex flex-col overflow-hidden p-4">
              <h3 className="text-sm font-medium text-gray-300 mb-3">Trade History</h3>
              <div className="flex-1 overflow-y-auto">
                {recentTrades.length === 0 ? (
                  <div className="text-center text-gray-500 py-8">
                    No trades recorded yet
                  </div>
                ) : (
                  <table className="w-full">
                    <thead className="text-xs text-gray-500 border-b border-gray-700">
                      <tr>
                        <th className="text-left py-2 font-medium">Time</th>
                        <th className="text-right py-2 font-medium">Price</th>
                        <th className="text-right py-2 font-medium">Size</th>
                        <th className="text-right py-2 font-medium">Side</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentTrades.map((trade, i) => (
                        <tr key={i} className="border-b border-gray-800 hover:bg-gray-800/30">
                          <td className="py-2 text-xs text-gray-500 font-mono">
                            {formatRelativeTime(trade.time)}
                          </td>
                          <td className="py-2 text-right text-sm font-mono text-white">
                            {formatPrice(trade.price)}
                          </td>
                          <td className="py-2 text-right text-sm font-mono text-gray-400">
                            {formatSize(trade.size)}
                          </td>
                          <td className="py-2 text-right">
                            <span className={`text-xs px-1.5 py-0.5 rounded ${
                              trade.side === 'buy'
                                ? 'bg-green-900/50 text-green-400'
                                : 'bg-red-900/50 text-red-400'
                            }`}>
                              {trade.side}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 bg-gray-800/30 border-t border-gray-700 flex items-center justify-between text-xs text-gray-500">
          <div className="flex items-center space-x-4">
            <span>Market ID: {marketId.slice(0, 16)}...</span>
            {hasBothSides && <span>•</span>}
            {hasBothSides && <span>2 tokens (YES + NO)</span>}
            <span>•</span>
            <span>Last update: {orderbook ? formatRelativeTime(orderbook.timestamp) : (noOrderbook ? formatRelativeTime(noOrderbook.timestamp) : 'N/A')}</span>
          </div>
          <div className="flex items-center space-x-2">
            <span className={`w-1.5 h-1.5 rounded-full ${
              status === 'connected' ? 'bg-green-400' :
              status === 'connecting' ? 'bg-yellow-400' :
              'bg-red-400'
            }`} />
            <span className="uppercase">{status}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GlobalOrderbookOverlay;
