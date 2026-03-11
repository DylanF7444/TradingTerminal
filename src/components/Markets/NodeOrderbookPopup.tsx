// ============================================================================
// NodeOrderbookPopup.tsx - Compact orderbook popup for canvas market nodes
// ============================================================================
//
// Renders a small overlay orderbook attached to a market node on the canvas.
// Reads live data from the central Zustand store (populated by the persistent
// orderbook monitor). Shows top bid/ask levels, spread, connection status,
// and an optional raw WebSocket message stream view.
//
// For Polymarket, displays both YES and NO orderbooks side-by-side.
//
// Key props: marketId, tokenIds, platform, position, compact, className.
//
// ============================================================================

import React, { useMemo, useState } from 'react';
import { useRawOrderbookMessages } from '../../hooks/useOrderbook';
import { useStore } from '../../store';
import type { Orderbook } from '../../types/markets';

// =============================================================================
// TYPES
// =============================================================================

interface NodeOrderbookPopupProps {
  /** Market ID to subscribe to (primary token) */
  marketId: string;
  /** All token IDs for the market (e.g., [YES_id, NO_id] for Polymarket) */
  tokenIds?: string[];
  /** Platform: polymarket or kalshi */
  platform: 'polymarket' | 'kalshi';
  /** Position offset for popup */
  position?: { x: number; y: number };
  /** Compact mode (fewer levels) */
  compact?: boolean;
  /** Additional CSS classes */
  className?: string;
}

type ViewMode = 'orderbook' | 'raw';

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function formatPrice(price: number): string {
  return `${(price * 100).toFixed(1)}¢`;
}

function formatSize(size: number): string {
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

// =============================================================================
// COMPONENT
// =============================================================================

export const NodeOrderbookPopup: React.FC<NodeOrderbookPopupProps> = ({
  marketId,
  tokenIds,
  platform,
  position = { x: 0, y: 0 },
  compact = true,
  className = '',
}) => {
  // ---------------------------------------------------------------------------
  // Central Store Orderbook Data
  // ---------------------------------------------------------------------------
  // For Polymarket: tokenIds[0] = YES, tokenIds[1] = NO
  // The primary marketId is typically the YES token
  const allOrderbooks = useStore((s) => s.orderbooks);
  const marketStatusObj = useStore((s) => s.marketStatus[marketId]);
  const { rawMessages, clearMessages } = useRawOrderbookMessages(20, marketId);
  const [viewMode, setViewMode] = useState<ViewMode>('orderbook');

  // Get orderbooks for both tokens
  // For Polymarket: tokenIds[0] = YES, tokenIds[1] = NO
  // For Kalshi: YES is at marketId, NO is always at marketId:no
  const yesOrderbook: Orderbook | undefined = allOrderbooks[marketId];
  const noTokenId = platform === 'kalshi'
    ? `${marketId}:no`
    : (tokenIds && tokenIds.length > 1
        ? tokenIds.find(id => id !== marketId) ?? tokenIds[1]
        : undefined);
  const noOrderbook: Orderbook | undefined = noTokenId ? allOrderbooks[noTokenId] : undefined;
  const hasBothSides = noOrderbook !== undefined;

  // Derive connection status from store data
  const status = useMemo((): 'connected' | 'connecting' | 'stale' | 'error' | 'idle' => {
    const hasYesData = yesOrderbook && (yesOrderbook.bids.length > 0 || yesOrderbook.asks.length > 0);
    const hasNoData = noOrderbook && (noOrderbook.bids.length > 0 || noOrderbook.asks.length > 0);
    if (!hasYesData && !hasNoData) {
      return marketStatusObj?.connecting ? 'connecting' : 'connecting';
    }
    if (marketStatusObj?.errorMessage) return 'error';
    const latestTimestamp = Math.max(yesOrderbook?.timestamp ?? 0, noOrderbook?.timestamp ?? 0);
    const age = Date.now() - latestTimestamp;
    if (age > 30_000) return 'stale';
    return 'connected';
  }, [yesOrderbook, noOrderbook, marketStatusObj]);

  // Get top levels for YES
  const yesTopBids = useMemo(() => {
    if (!yesOrderbook) return [];
    return yesOrderbook.bids.slice(0, compact ? 3 : 5);
  }, [yesOrderbook, compact]);

  const yesTopAsks = useMemo(() => {
    if (!yesOrderbook) return [];
    return yesOrderbook.asks.slice(0, compact ? 3 : 5);
  }, [yesOrderbook, compact]);

  // Get top levels for NO
  const noTopBids = useMemo(() => {
    if (!noOrderbook) return [];
    return noOrderbook.bids.slice(0, compact ? 3 : 5);
  }, [noOrderbook, compact]);

  const noTopAsks = useMemo(() => {
    if (!noOrderbook) return [];
    return noOrderbook.asks.slice(0, compact ? 3 : 5);
  }, [noOrderbook, compact]);

  const yesBestBid = yesTopBids[0]?.price || 0;
  const yesBestAsk = yesTopAsks[0]?.price || 0;
  const yesSpread = yesBestAsk - yesBestBid;

  if (status === 'idle' || status === 'connecting') {
    return (
      <div className={`
        bg-gray-900/95 backdrop-blur-sm rounded-lg shadow-xl border border-gray-700
        p-3 min-w-[160px] text-center
        ${className}
      `} style={{
        position: 'absolute',
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, -100%)',
        marginTop: '-10px',
      }}>
        <div className="w-4 h-4 border-2 border-gray-600 border-t-blue-500 rounded-full animate-spin mx-auto" />
        <span className="text-xs text-gray-400 mt-1 block">Connecting...</span>
      </div>
    );
  }

  return (
    <div
      className={`
        bg-gray-900/95 backdrop-blur-sm rounded-lg shadow-xl border border-gray-700
        overflow-hidden
        ${className}
      `}
      style={{
        position: 'absolute',
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, -100%)',
        marginTop: '-10px',
        minWidth: hasBothSides ? (compact ? '320px' : '400px') : (compact ? '180px' : '220px'),
        maxWidth: '500px',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header with view mode toggle */}
      <div className="flex items-center justify-between px-2 py-1 bg-gray-800/50 border-b border-gray-700">
        <div className="flex items-center space-x-2">
          <span className="text-xs font-medium text-gray-300">
            {viewMode === 'orderbook' ? 'Order Book' : 'Raw Stream'}
          </span>
          <div className="flex rounded bg-gray-700/50">
            <button
              onClick={() => setViewMode('orderbook')}
              className={`px-1.5 py-0.5 text-[9px] rounded-l ${
                viewMode === 'orderbook'
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Book
            </button>
            <button
              onClick={() => setViewMode('raw')}
              className={`px-1.5 py-0.5 text-[9px] rounded-r ${
                viewMode === 'raw'
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Raw
            </button>
          </div>
        </div>
        <div className="flex items-center space-x-1">
          <span className={`w-1.5 h-1.5 rounded-full ${
            status === 'connected' ? 'bg-green-400 animate-pulse' :
            status === 'stale' ? 'bg-yellow-400' : 'bg-red-400'
          }`} />
          <span className="text-[10px] text-gray-500 uppercase">{status}</span>
        </div>
      </div>

      {/* Orderbook View */}
      {viewMode === 'orderbook' && (
        <>
          {hasBothSides ? (
            /* Two-column layout for YES and NO */
            <div className="flex">
              {/* YES column */}
              <div className="flex-1 border-r border-gray-700/50">
                <div className="text-center py-0.5 bg-green-900/20 border-b border-gray-700/50">
                  <span className="text-[10px] font-medium text-green-400">YES</span>
                  {yesBestBid > 0 && (
                    <span className="text-[9px] text-gray-500 ml-1">{formatPrice(yesBestBid)}</span>
                  )}
                </div>
                {/* Asks */}
                <div className="px-1 py-0.5">
                  {yesTopAsks.map((level, i) => (
                    <div key={`yes-ask-${i}`} className="flex justify-between text-[10px] py-0.5">
                      <span className="text-red-400 font-mono">{formatPrice(level.price)}</span>
                      <span className="text-gray-400 font-mono">{formatSize(level.size)}</span>
                    </div>
                  ))}
                </div>
                <div className="h-px bg-gray-700 my-0.5" />
                {/* Bids */}
                <div className="px-1 py-0.5">
                  {yesTopBids.map((level, i) => (
                    <div key={`yes-bid-${i}`} className="flex justify-between text-[10px] py-0.5">
                      <span className="text-green-400 font-mono">{formatPrice(level.price)}</span>
                      <span className="text-gray-400 font-mono">{formatSize(level.size)}</span>
                    </div>
                  ))}
                </div>
              </div>
              {/* NO column */}
              <div className="flex-1">
                <div className="text-center py-0.5 bg-red-900/20 border-b border-gray-700/50">
                  <span className="text-[10px] font-medium text-red-400">NO</span>
                  {(noTopBids[0]?.price ?? 0) > 0 && (
                    <span className="text-[9px] text-gray-500 ml-1">{formatPrice(noTopBids[0]?.price ?? 0)}</span>
                  )}
                </div>
                {/* Asks */}
                <div className="px-1 py-0.5">
                  {noTopAsks.map((level, i) => (
                    <div key={`no-ask-${i}`} className="flex justify-between text-[10px] py-0.5">
                      <span className="text-red-400 font-mono">{formatPrice(level.price)}</span>
                      <span className="text-gray-400 font-mono">{formatSize(level.size)}</span>
                    </div>
                  ))}
                </div>
                <div className="h-px bg-gray-700 my-0.5" />
                {/* Bids */}
                <div className="px-1 py-0.5">
                  {noTopBids.map((level, i) => (
                    <div key={`no-bid-${i}`} className="flex justify-between text-[10px] py-0.5">
                      <span className="text-green-400 font-mono">{formatPrice(level.price)}</span>
                      <span className="text-gray-400 font-mono">{formatSize(level.size)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            /* Single-column layout (original) */
            <>
              {/* Spread */}
              <div className="flex items-center justify-center py-1 bg-gray-800/30 border-b border-gray-700/50">
                <span className="text-[10px] text-gray-400">
                  Spread: {(yesSpread * 100).toFixed(1)}¢
                </span>
              </div>

              {/* Asks */}
              <div className="px-1 py-0.5">
                {yesTopAsks.map((level, i) => (
                  <div key={`ask-${i}`} className="flex justify-between text-[10px] py-0.5">
                    <span className="text-red-400 font-mono">{formatPrice(level.price)}</span>
                    <span className="text-gray-400 font-mono">{formatSize(level.size)}</span>
                  </div>
                ))}
              </div>

              {/* Spread divider */}
              <div className="h-px bg-gray-700 my-0.5" />

              {/* Bids */}
              <div className="px-1 py-0.5">
                {yesTopBids.map((level, i) => (
                  <div key={`bid-${i}`} className="flex justify-between text-[10px] py-0.5">
                    <span className="text-green-400 font-mono">{formatPrice(level.price)}</span>
                    <span className="text-gray-400 font-mono">{formatSize(level.size)}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Last trade */}
          {yesOrderbook?.lastPrice && (
            <div className="flex items-center justify-center py-1 bg-gray-800/30 border-t border-gray-700/50">
              <span className="text-[10px] text-gray-400">
                Last: {formatPrice(yesOrderbook.lastPrice)} × {formatSize(yesOrderbook.lastSize || 0)}
              </span>
            </div>
          )}
        </>
      )}

      {/* Raw Stream View */}
      {viewMode === 'raw' && (
        <div className="max-h-[200px] overflow-y-auto">
          {/* Clear button */}
          <div className="flex justify-end px-2 py-1 border-b border-gray-700/50">
            <button
              onClick={clearMessages}
              className="text-[9px] text-gray-500 hover:text-gray-300"
            >
              Clear
            </button>
          </div>

          {/* Messages */}
          <div className="px-2 py-1 space-y-1">
            {rawMessages.length === 0 ? (
              <div className="text-[10px] text-gray-500 text-center py-2">
                Waiting for messages...
              </div>
            ) : (
              rawMessages.map((msg, i) => (
                <div
                  key={`${msg.timestamp}-${i}`}
                  className="border-b border-gray-700/30 pb-1 last:border-0"
                >
                  <div className="flex items-center justify-between text-[9px]">
                    <span className="text-gray-500 font-mono">
                      {formatTimestamp(msg.timestamp)}
                    </span>
                    <span className={`px-1 rounded text-[8px] ${
                      msg.msg_type === 'trade' ? 'bg-yellow-900/50 text-yellow-400' :
                      msg.msg_type === 'book' || msg.msg_type === 'book_update' ? 'bg-blue-900/50 text-blue-400' :
                      msg.msg_type === 'ticker' ? 'bg-green-900/50 text-green-400' :
                      msg.msg_type === 'orderbook_delta' ? 'bg-purple-900/50 text-purple-400' :
                      'bg-gray-700/50 text-gray-400'
                    }`}>
                      {msg.msg_type || 'unknown'}
                    </span>
                  </div>
                  <pre className="text-[8px] text-gray-300 font-mono whitespace-pre-wrap break-all mt-0.5 max-h-[60px] overflow-y-auto">
                    {msg.raw_message}
                  </pre>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Arrow pointer */}
      <div
        className="absolute left-1/2 bottom-0 transform -translate-x-1/2 translate-y-full
          w-0 h-0 border-l-[6px] border-r-[6px] border-t-[6px]
          border-l-transparent border-r-transparent border-t-gray-700"
      />
    </div>
  );
};

export default NodeOrderbookPopup;
