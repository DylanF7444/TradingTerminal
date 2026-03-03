// ============================================================================
// NODE ORDERBOOK POPUP COMPONENT
// ============================================================================
//
// Module: components/Markets/NodeOrderbookPopup.tsx
// Purpose: Compact orderbook popup for market nodes on the canvas
//
// OVERVIEW:
// This component provides a compact, inline orderbook view that can be
// displayed when clicking/selecting on a market node. It reads real-time
// orderbook data from the central Zustand store (populated by the always-on
// persistent orderbook monitor) in a condensed format suitable for overlay display.
//
// DATA FLOW:
// - Reads from store.orderbooks[marketId] (populated by usePersistentOrderbooks)
// - No per-component WebSocket subscription needed
// - Raw stream view still uses useRawOrderbookMessages listener
//
// INTEGRATION:
// - Used by Node.tsx to display orderbook when market node is selected/hovered
// - Reads from central Zustand store for live data
// - For Kalshi, auth is handled by the persistent monitor
//
// FEATURES:
// - Displays top 3-5 bid/ask levels (configurable via compact prop)
// - Shows spread calculation (best ask - best bid)
// - Connection status indicator (connecting/connected/error)
// - Color-coded bid (green) and ask (red) levels
// - Price formatting in cents (e.g., "45.5¢")
// - Size formatting with K suffix for large sizes
// - Automatic credential lookup for Kalshi authenticated subscriptions
// - Toggle to view raw WebSocket message stream
//
// PROPS:
// - marketId: Platform-specific market identifier
// - platform: 'polymarket' or 'kalshi'
// - position: Optional offset for popup positioning
// - compact: Show 3 levels (true) or 5 levels (false)
//
// USAGE EXAMPLE:
// ```tsx
// <NodeOrderbookPopup
//   marketId="0x123..."
//   platform="polymarket"
//   compact={true}
//   position={{ x: 100, y: 50 }}
// />
// ```
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
  /** Market ID to subscribe to */
  marketId: string;
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
  platform: _platform,
  position = { x: 0, y: 0 },
  compact = true,
  className = '',
}) => {
  // ---------------------------------------------------------------------------
  // Central Store Orderbook Data
  // ---------------------------------------------------------------------------
  const orderbook: Orderbook | undefined = useStore((s) => s.orderbooks[marketId]);
  const marketStatusObj = useStore((s) => s.marketStatus[marketId]);
  const { rawMessages, clearMessages } = useRawOrderbookMessages(20, marketId);
  const [viewMode, setViewMode] = useState<ViewMode>('orderbook');

  // Derive connection status from store data
  const status = useMemo((): 'connected' | 'connecting' | 'stale' | 'error' | 'idle' => {
    if (!orderbook || (orderbook.bids.length === 0 && orderbook.asks.length === 0)) {
      return marketStatusObj?.connecting ? 'connecting' : 'connecting';
    }
    if (marketStatusObj?.errorMessage) return 'error';
    const age = Date.now() - orderbook.timestamp;
    if (age > 30_000) return 'stale';
    return 'connected';
  }, [orderbook, marketStatusObj]);
  
  // Get top levels
  const topBids = useMemo(() => {
    if (!orderbook) return [];
    return orderbook.bids.slice(0, compact ? 3 : 5);
  }, [orderbook, compact]);
  
  const topAsks = useMemo(() => {
    if (!orderbook) return [];
    return orderbook.asks.slice(0, compact ? 3 : 5);
  }, [orderbook, compact]);
  
  const bestBid = topBids[0]?.price || 0;
  const bestAsk = topAsks[0]?.price || 0;
  const spread = bestAsk - bestBid;
  
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
        minWidth: compact ? '180px' : '220px',
        maxWidth: '400px',
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
          {/* Spread */}
          <div className="flex items-center justify-center py-1 bg-gray-800/30 border-b border-gray-700/50">
            <span className="text-[10px] text-gray-400">
              Spread: {(spread * 100).toFixed(1)}¢
            </span>
          </div>
          
          {/* Asks */}
          <div className="px-1 py-0.5">
            {topAsks.slice().reverse().map((level, i) => (
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
            {topBids.map((level, i) => (
              <div key={`bid-${i}`} className="flex justify-between text-[10px] py-0.5">
                <span className="text-green-400 font-mono">{formatPrice(level.price)}</span>
                <span className="text-gray-400 font-mono">{formatSize(level.size)}</span>
              </div>
            ))}
          </div>
          
          {/* Last trade */}
          {orderbook?.lastPrice && (
            <div className="flex items-center justify-center py-1 bg-gray-800/30 border-t border-gray-700/50">
              <span className="text-[10px] text-gray-400">
                Last: {formatPrice(orderbook.lastPrice)} × {formatSize(orderbook.lastSize || 0)}
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
