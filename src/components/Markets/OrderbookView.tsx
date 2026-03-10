// ============================================================================
// OrderbookView.tsx - Real-time orderbook display with trading controls
// ============================================================================
//
// Renders a professional orderbook interface for prediction markets with
// bid/ask depth visualization, spread indicator, bid/ask imbalance bar,
// recent trades tape, and integrated quick-order buttons. Supports both
// Polymarket and Kalshi markets with normalized price display (cents).
//
// Reads live orderbook data from the central Zustand store (populated by
// the persistent orderbook monitor via usePersistentOrderbooks in App.tsx).
// No per-component WebSocket subscription is needed.
//
// Includes a MultiLegOrderEntry toggle for categorical/multi-outcome markets.
//
// Key props: market, compact, depth, enableTrading, onLevelClick, className.
//
// Sub-components: OrderbookLevel (memoized row), SpreadIndicator,
// RecentTrades, QuickOrderButtons.
//
// ============================================================================

import React, { useState, useCallback, useMemo } from 'react';

// Store hooks
import { useStore } from '../../store';

// API utilities
import { placeOrder } from '../../utils/api';

// Types
import type { Orderbook, Level, Market } from '../../types/markets';
import { OrderSide, OrderType, TimeInForce, OutcomeType } from '../../types/markets';
import { MarketType } from '../../types/nodes';

// Multi-leg order entry component (for categorical/multi-outcome markets)
import MultiLegOrderEntry from './MultiLegOrderEntry';

// =============================================================================
// COMPONENT PROPS
// =============================================================================

interface OrderbookViewProps {
  /** Market metadata */
  market: Market;
  
  /** Optional compact mode for side panels */
  compact?: boolean;
  
  /** Maximum levels to display */
  depth?: number;
  
  /** Show trading controls */
  enableTrading?: boolean;
  
  /** Callback when level clicked (for order entry) */
  onLevelClick?: (side: OrderSide, price: number, size: number) => void;
  
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Format price for display based on market type.
 */
function formatPrice(price: number, marketType: 'binary' | 'scalar'): string {
  if (marketType === 'binary') {
    // Display as percentage (0.52 -> "52.0¢")
    return `${(price * 100).toFixed(1)}¢`;
  }
  // Scalar: show with appropriate precision
  return price.toFixed(2);
}

/**
 * Format size with K/M suffixes for large numbers.
 */
function formatSize(size: number): string {
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(2)}M`;
  if (size >= 1_000) return `${(size / 1_000).toFixed(1)}K`;
  return size.toFixed(0);
}

/**
 * Calculate cumulative volume from level array.
 */
function calculateCumulative(levels: Level[]): Array<Level & { cumulative: number }> {
  let cumSum = 0;
  return levels.map(level => {
    cumSum += level.size;
    return { ...level, cumulative: cumSum };
  });
}

/**
 * Calculate spread metrics.
 */
function calculateSpread(bestBid: number, bestAsk: number): {
  absolute: number;
  relative: number;
  ticks: number;
} {
  const absolute = bestAsk - bestBid;
  const relative = (absolute / ((bestBid + bestAsk) / 2)) * 100;
  // Assume 0.01 tick size for binary markets
  const ticks = Math.round(absolute / 0.01);
  return { absolute, relative, ticks };
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

/**
 * Individual orderbook level row.
 */
const OrderbookLevel: React.FC<{
  level: Level & { cumulative?: number };
  side: 'bid' | 'ask';
  maxCumulative: number;
  totalSize: number;
  onClick: () => void;
  highlighted?: boolean;
  compact?: boolean;
}> = React.memo(({ 
  level, 
  side, 
  maxCumulative, 
  totalSize, 
  onClick, 
  highlighted,
  compact 
}) => {
  const isBid = side === 'bid';
  
  // Calculate bar width percentage
  const barWidth = maxCumulative > 0 
    ? (level.cumulative || level.size) / maxCumulative * 100 
    : 0;
  
  // Individual level width for size-based coloring
  const sizeIntensity = totalSize > 0 ? level.size / totalSize : 0;
  
  return (
    <div
      onClick={onClick}
      className={`
        relative flex items-center justify-between px-3 py-1 cursor-pointer
        transition-colors duration-150 hover:bg-gray-800/50
        ${highlighted ? 'bg-yellow-500/10' : ''}
        ${compact ? 'text-xs py-0.5' : 'text-sm'}
      `}
      role="button"
      tabIndex={0}
      aria-label={`${isBid ? 'Bid' : 'Ask'} at ${level.price}, size ${level.size}`}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
    >
      {/* Background bar for depth visualization */}
      <div 
        className={`absolute ${isBid ? 'right-0' : 'left-0'} top-0 bottom-0 opacity-20
          ${isBid ? 'bg-green-500' : 'bg-red-500'}`}
        style={{ width: `${barWidth}%` }}
      />
      
      {/* Price */}
      <span className={`relative z-10 font-mono font-medium
        ${isBid ? 'text-green-400' : 'text-red-400'}`}>
        {formatPrice(level.price, 'binary')}
      </span>
      
      {/* Size */}
      <span className={`relative z-10 font-mono text-gray-300
        ${sizeIntensity > 0.3 ? 'font-semibold' : ''}`}>
        {formatSize(level.size)}
        {level.orderCount > 1 && !compact && (
          <span className="text-gray-500 text-xs ml-1">({level.orderCount})</span>
        )}
      </span>
      
      {/* Cumulative (non-compact only) */}
      {!compact && level.cumulative !== undefined && (
        <span className="relative z-10 font-mono text-xs text-gray-500 w-16 text-right">
          {formatSize(level.cumulative)}
        </span>
      )}
    </div>
  );
});

OrderbookLevel.displayName = 'OrderbookLevel';

/**
 * Spread indicator between bids and asks.
 */
const SpreadIndicator: React.FC<{
  bestBid: number;
  bestAsk: number;
  className?: string;
}> = ({ bestBid, bestAsk, className }) => {
  const spread = useMemo(() => calculateSpread(bestBid, bestAsk), [bestBid, bestAsk]);
  
  let spreadClass = 'text-gray-400';
  if (spread.ticks <= 1) spreadClass = 'text-green-400';
  else if (spread.ticks >= 5) spreadClass = 'text-yellow-400';
  
  return (
    <div className={`flex items-center justify-between py-2 border-y border-gray-800 bg-gray-900/50 ${className}`}>
      <div className="flex items-center space-x-4 text-sm">
        <span className="text-gray-500">Spread</span>
        <span className={`font-mono font-medium ${spreadClass}`}>
          {spread.ticks} tick{spread.ticks !== 1 ? 's' : ''}
        </span>
        <span className="text-gray-600 font-mono">
          ({spread.absolute.toFixed(3)})
        </span>
      </div>
      <div className="text-xs text-gray-500">
        Mid: {formatPrice((bestBid + bestAsk) / 2, 'binary')}
      </div>
    </div>
  );
};

/**
 * Recent trades tape.
 */
const RecentTrades: React.FC<{
  trades: Array<{ price: number; size: number; side: 'buy' | 'sell'; time: number }>;
  maxTrades?: number;
  className?: string;
}> = ({ trades, maxTrades = 20, className }) => {
  const displayTrades = trades.slice(0, maxTrades);
  
  return (
    <div className={`font-mono text-xs ${className}`}>
      <div className="text-gray-500 text-xs uppercase tracking-wider mb-2">Recent Trades</div>
      <div className="space-y-0.5 max-h-32 overflow-y-auto">
        {displayTrades.map((trade, i) => (
          <div 
            key={i} 
            className={`flex justify-between ${trade.side === 'buy' ? 'text-green-400' : 'text-red-400'}`}
          >
            <span>{formatPrice(trade.price, 'binary')}</span>
            <span>{formatSize(trade.size)}</span>
            <span className="text-gray-600">
              {new Date(trade.time).toLocaleTimeString('en-US', { 
                hour12: false, 
                hour: '2-digit', 
                minute: '2-digit',
                second: '2-digit'
              })}
            </span>
          </div>
        ))}
        {displayTrades.length === 0 && (
          <div className="text-gray-600 italic">No recent trades</div>
        )}
      </div>
    </div>
  );
};

/**
 * Quick order entry buttons.
 */
const QuickOrderButtons: React.FC<{
  bestBid: number;
  bestAsk: number;
  marketId: string;
  maxSize: number;
  onOrderSubmitted: () => void;
  disabled?: boolean;
}> = ({ bestBid, bestAsk, marketId, onOrderSubmitted, disabled }) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const handleQuickOrder = async (side: OrderSide, price: number) => {
    if (disabled || isSubmitting) return;
    
    setIsSubmitting(true);
    try {
      const result = await placeOrder({
        market: MarketType.Polymarket, // TODO: derive from market
        marketNodeId: marketId,
        side,
        size: 1, // Minimum size
        price,
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.GTC,
      });
      
      if (result.ok) {
        onOrderSubmitted();
      } else {
        // TODO: show error toast
        console.error('Order failed:', result.error);
      }
    } finally {
      setIsSubmitting(false);
    }
  };
  
  return (
    <div className="grid grid-cols-2 gap-2 mt-4">
      <button
        onClick={() => handleQuickOrder(OrderSide.Buy, bestAsk)}
        disabled={disabled || isSubmitting}
        className="py-2 px-4 bg-green-600 hover:bg-green-500 disabled:bg-gray-700
          disabled:cursor-not-allowed rounded font-medium text-sm transition-colors"
      >
        Buy {formatPrice(bestAsk, 'binary')}
      </button>
      <button
        onClick={() => handleQuickOrder(OrderSide.Sell, bestBid)}
        disabled={disabled || isSubmitting}
        className="py-2 px-4 bg-red-600 hover:bg-red-500 disabled:bg-gray-700
          disabled:cursor-not-allowed rounded font-medium text-sm transition-colors"
      >
        Sell {formatPrice(bestBid, 'binary')}
      </button>
    </div>
  );
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

/**
 * Orderbook view with real-time updates and trading integration.
 */
export const OrderbookView: React.FC<OrderbookViewProps> = ({
  market,
  compact = false,
  depth = 10,
  enableTrading = true,
  onLevelClick,
  className = '',
}) => {
  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  
  /** Selected price level (for highlighting) */
  const [selectedLevel, setSelectedLevel] = useState<{ side: 'bid' | 'ask'; price: number } | null>(null);

  /** Whether the multi-leg order entry is shown */
  const [showMultiLeg, setShowMultiLeg] = useState(false);

  /** Whether the current market supports multi-outcome trading */
  const isCategorical = market.outcomeType === OutcomeType.Categorical
    || (market.outcomes && market.outcomes.length > 0);
  
  // -------------------------------------------------------------------------
  // Real-time Orderbook from Central Store
  // -------------------------------------------------------------------------
  
  // Read orderbook from central store (populated by usePersistentOrderbooks)
  const storeOrderbook = useStore((s) => s.orderbooks[market.id]);
  const marketStatusObj = useStore((s) => s.marketStatus[market.id]);
  
  // Derive connection status from store data
  const connectionStatus = useMemo((): 'connected' | 'connecting' | 'stale' | 'error' => {
    if (!storeOrderbook || (storeOrderbook.bids.length === 0 && storeOrderbook.asks.length === 0)) {
      return marketStatusObj?.connecting ? 'connecting' : 'connecting';
    }
    if (marketStatusObj?.errorMessage) return 'error';
    // Stale if last update > 30 seconds ago
    const age = Date.now() - storeOrderbook.timestamp;
    if (age > 30_000) return 'stale';
    return 'connected';
  }, [storeOrderbook, marketStatusObj]);
  
  // Recent trades from store (if available)
  const recentTrades: Array<{ price: number; size: number; side: 'buy' | 'sell'; time: number }> = [];
  
  // -------------------------------------------------------------------------
  // Global State
  // -------------------------------------------------------------------------
  
  const getPositionsByMarket = useStore((state: any) => state.getPositionsByMarket);
  
  // Get existing position for this market
  const existingPosition = useMemo(() => {
    if (!getPositionsByMarket) return null;
    const positions = getPositionsByMarket(market.nodeId);
    return positions[0] || null;
  }, [getPositionsByMarket, market.nodeId]);
  
  // -------------------------------------------------------------------------
  // Orderbook from Central Store (already in Orderbook format)
  // -------------------------------------------------------------------------
  
  const orderbook = useMemo((): Orderbook | null => {
    if (!storeOrderbook) return null;
    // Store data is already in Orderbook format with Level[] arrays
    // Return directly (already sorted by updateOrderbook in marketsSlice)
    return storeOrderbook;
  }, [storeOrderbook]);
  
  // -------------------------------------------------------------------------
  // Derived Data
  // -------------------------------------------------------------------------
  
  /** Processed bids with cumulative volume */
  const processedBids = useMemo(() => {
    if (!orderbook) return [];
    const cumBids = calculateCumulative(orderbook.bids.slice(0, depth));
    return cumBids.reverse(); // Highest bid at top
  }, [orderbook, depth]);
  
  /** Processed asks with cumulative volume */
  const processedAsks = useMemo(() => {
    if (!orderbook) return [];
    return calculateCumulative(orderbook.asks.slice(0, depth));
  }, [orderbook, depth]);
  
  /** Maximum cumulative for bar scaling */
  const maxCumulative = useMemo(() => {
    const bidMax = processedBids[processedBids.length - 1]?.cumulative || 0;
    const askMax = processedAsks[processedAsks.length - 1]?.cumulative || 0;
    return Math.max(bidMax, askMax);
  }, [processedBids, processedAsks]);
  
  /** Best bid/ask */
  const bestBid = orderbook?.bids[0]?.price || 0;
  const bestAsk = orderbook?.asks[0]?.price || 0;
  
  /** Total bid/ask size for imbalance */
  const totalBidSize = useMemo(() => 
    processedBids.reduce((sum, b) => sum + b.size, 0),
    [processedBids]
  );
  
  const totalAskSize = useMemo(() => 
    processedAsks.reduce((sum, a) => sum + a.size, 0),
    [processedAsks]
  );
  
  // -------------------------------------------------------------------------
  // Event Handlers
  // -------------------------------------------------------------------------
  
  const handleLevelClick = useCallback((side: 'bid' | 'ask', level: Level) => {
    setSelectedLevel({ side, price: level.price });
    
    if (onLevelClick) {
      onLevelClick(side === 'bid' ? OrderSide.Buy : OrderSide.Sell, level.price, level.size);
    }
  }, [onLevelClick]);
  
  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  
  if (!orderbook) {
    return (
      <div className={`flex items-center justify-center h-64 text-gray-500 ${className}`}>
        <div className="flex flex-col items-center space-y-3">
          <div className="w-8 h-8 border-2 border-gray-600 border-t-blue-500 rounded-full animate-spin" />
          <span className="text-sm">Connecting to market...</span>
        </div>
      </div>
    );
  }
  
  return (
    <div className={`bg-gray-950 rounded-lg overflow-hidden ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <div className="flex items-center space-x-3">
          <h3 className="font-semibold text-gray-200">Order Book</h3>
          <div className={`flex items-center space-x-1.5 text-xs ${
            connectionStatus === 'connected' ? 'text-green-400' : 
            connectionStatus === 'stale' ? 'text-yellow-400' : 'text-red-400'
          }`}>
            <span className={`w-2 h-2 rounded-full ${
              connectionStatus === 'connected' ? 'bg-green-400 animate-pulse' : 
              connectionStatus === 'stale' ? 'bg-yellow-400' : 'bg-red-400'
            }`} />
            <span className="uppercase tracking-wider">{connectionStatus}</span>
          </div>
        </div>
        
        {!compact && (
          <div className="flex items-center space-x-4 text-xs text-gray-500">
            <span>Seq: {orderbook.sequence}</span>
            <span>{new Date(orderbook.timestamp).toLocaleTimeString()}</span>
          </div>
        )}
      </div>
      
      {/* Column Headers */}
      {!compact && (
        <div className="flex px-3 py-1.5 bg-gray-900/50 text-xs text-gray-500 font-medium">
          <span className="flex-1">Price</span>
          <span className="w-20 text-right">Size</span>
          <span className="w-16 text-right">Total</span>
        </div>
      )}
      
      {/* Asks (sell orders) - lowest ask at top, closest to real price */}
      <div className="space-y-0.5">
        {processedAsks.map((level) => (
          <OrderbookLevel
            key={`ask-${level.price}`}
            level={level}
            side="ask"
            maxCumulative={maxCumulative}
            totalSize={totalAskSize}
            onClick={() => handleLevelClick('ask', level)}
            highlighted={selectedLevel?.side === 'ask' && selectedLevel.price === level.price}
            compact={compact}
          />
        ))}
      </div>
      
      {/* Spread Indicator */}
      <SpreadIndicator bestBid={bestBid} bestAsk={bestAsk} />
      
      {/* Bids (buy orders) */}
      <div className="space-y-0.5">
        {processedBids.map((level) => (
          <OrderbookLevel
            key={`bid-${level.price}`}
            level={level}
            side="bid"
            maxCumulative={maxCumulative}
            totalSize={totalBidSize}
            onClick={() => handleLevelClick('bid', level)}
            highlighted={selectedLevel?.side === 'bid' && selectedLevel.price === level.price}
            compact={compact}
          />
        ))}
      </div>
      
      {/* Imbalance Indicator */}
      {!compact && (
        <div className="px-4 py-2 border-t border-gray-800">
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-gray-500">Bid/Ask Imbalance</span>
            <span className={`font-medium ${
              totalBidSize > totalAskSize * 1.5 ? 'text-green-400' :
              totalAskSize > totalBidSize * 1.5 ? 'text-red-400' : 'text-gray-400'
            }`}>
              {((totalBidSize / (totalBidSize + totalAskSize)) * 100).toFixed(1)}% Buy
            </span>
          </div>
          <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div 
              className={`h-full transition-all duration-300 ${
                totalBidSize > totalAskSize ? 'bg-green-500' : 'bg-red-500'
              }`}
              style={{ width: `${(totalBidSize / (totalBidSize + totalAskSize)) * 100}%` }}
            />
          </div>
        </div>
      )}
      
      {/* Recent Trades */}
      {!compact && <RecentTrades trades={recentTrades} className="px-4 py-3 border-t border-gray-800" />}
      
      {/* Quick Trading */}
      {enableTrading && !compact && (
        <div className="px-4 py-3 border-t border-gray-800 bg-gray-900/30">
          {/* Multi-leg toggle for categorical markets */}
          {isCategorical && (
            <button
              onClick={() => setShowMultiLeg(!showMultiLeg)}
              className={`w-full mb-3 py-2 rounded text-xs font-medium transition-colors ${
                showMultiLeg
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {showMultiLeg ? 'Hide Multi-Leg Order' : 'Multi-Leg Order (Categorical)'}
            </button>
          )}

          {/* Multi-leg order entry panel */}
          {showMultiLeg && (
            <div className="mb-3">
              <MultiLegOrderEntry
                market={market}
                onOrderPlaced={() => setShowMultiLeg(false)}
                onClose={() => setShowMultiLeg(false)}
              />
            </div>
          )}

          {/* Standard quick order buttons (always available) */}
          {!showMultiLeg && (
            <QuickOrderButtons
              bestBid={bestBid}
              bestAsk={bestAsk}
              marketId={market.nodeId}
              maxSize={1000} // TODO: calculate from balance
              onOrderSubmitted={() => {}}
              disabled={connectionStatus !== 'connected'}
            />
          )}
          
          {existingPosition && (
            <div className="mt-3 p-2 bg-blue-900/30 rounded text-xs">
              <div className="flex justify-between text-gray-300">
                <span>Position:</span>
                <span className={existingPosition.unrealizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                  {existingPosition.side.toUpperCase()} {existingPosition.size} @ {formatPrice(existingPosition.entryPrice, 'binary')}
                  {' → '}
                  {existingPosition.unrealizedPnl >= 0 ? '+' : ''}
                  ${existingPosition.unrealizedPnl.toFixed(2)}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// =============================================================================
// EXPORTS
// =============================================================================

export default OrderbookView;