// ============================================================================
// MULTI-LEG POSITION VIEW COMPONENT
// ============================================================================
//
// Module: components/Markets/MultiLegPositionView.tsx
// Purpose: Display and manage multi-leg positions with combined metrics
//
// OVERVIEW:
// This component renders a detailed view of multi-leg positions showing:
//   - Position header with strategy info and aggregate P&L
//   - Individual leg breakdown with per-leg metrics
//   - Hedge ratio visualization
//   - Combined entry/current value comparison
//   - Close controls (per-leg or entire position)
//
// DATA FLOW:
//   positionsSlice.multiLegPositions -> MultiLegPositionView
//   User actions -> positionsSlice.closeMultiLegPosition / closePositionLeg
//   Price updates -> positionsSlice.updateMultiLegPrice
//
// ============================================================================

import React, { useState, useMemo, useCallback } from 'react';
import {
  MultiLegPosition,
  PositionLeg,
} from '../../types/markets';

// =============================================================================
// COMPONENT PROPS
// =============================================================================

interface MultiLegPositionViewProps {
  /** Multi-leg position to display */
  position: MultiLegPosition;

  /** Callback to close entire multi-leg position */
  onClosePosition?: (positionId: string) => void;

  /** Callback to close a single leg */
  onCloseLeg?: (positionId: string, legId: string) => void;

  /** Compact display mode */
  compact?: boolean;

  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Format price as cents for binary markets.
 */
function formatPrice(price: number): string {
  return `${(price * 100).toFixed(1)}c`;
}

/**
 * Format P&L with sign and color class.
 */
function pnlClass(pnl: number): string {
  if (pnl > 0) return 'text-green-400';
  if (pnl < 0) return 'text-red-400';
  return 'text-gray-400';
}

/**
 * Format strategy type for display.
 */
function formatStrategyType(type: string): string {
  switch (type) {
    case 'single': return 'Single';
    case 'multi-leg': return 'Multi-Leg';
    case 'arbitrage': return 'Arbitrage';
    default: return type;
  }
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

/**
 * Individual position leg row.
 *
 * Displays leg direction, size, entry/current price, P&L, and
 * optional close button for open legs.
 */
const LegRow: React.FC<{
  leg: PositionLeg;
  onClose?: () => void;
  compact?: boolean;
}> = ({ leg, onClose, compact }) => {
  const pnl = leg.status === 'open' ? leg.unrealizedPnl : leg.realizedPnl;

  return (
    <div
      className={`flex items-center justify-between py-2 px-3 ${
        leg.status === 'closed' ? 'opacity-60' : ''
      } ${compact ? 'text-xs' : 'text-sm'}`}
    >
      {/* Leg direction and market */}
      <div className="flex items-center space-x-2 flex-1 min-w-0">
        <span
          className={`px-1.5 py-0.5 rounded text-xs font-medium ${
            leg.side === 'buy'
              ? 'bg-green-900/40 text-green-400'
              : 'bg-red-900/40 text-red-400'
          }`}
        >
          {leg.side === 'buy' ? 'LONG' : 'SHORT'}
        </span>
        <span className="text-gray-300 truncate">
          {leg.outcomeId || leg.marketId}
        </span>
        {leg.status === 'closed' && (
          <span className="text-xs text-gray-600">(closed)</span>
        )}
      </div>

      {/* Size and prices */}
      <div className="flex items-center space-x-4 font-mono">
        <span className="text-gray-400 w-12 text-right">{leg.size}</span>
        <span className="text-gray-500 w-14 text-right">
          {formatPrice(leg.entryPrice)}
        </span>
        {!compact && (
          <span className="text-gray-300 w-14 text-right">
            {formatPrice(leg.currentPrice)}
          </span>
        )}
        <span className={`w-16 text-right font-medium ${pnlClass(pnl)}`}>
          {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
        </span>
      </div>

      {/* Close button for open legs */}
      {leg.status === 'open' && onClose && (
        <button
          onClick={onClose}
          className="ml-2 text-xs text-gray-500 hover:text-red-400 transition-colors"
          title="Close this leg"
        >
          X
        </button>
      )}
    </div>
  );
};

/**
 * Hedge ratio visualization bar.
 *
 * Shows a horizontal bar from 0% (fully hedged) to 100% (fully directional).
 * Green when hedged, yellow when partially hedged, red when directional.
 */
const HedgeRatioBar: React.FC<{ ratio: number }> = ({ ratio }) => {
  const percentage = (ratio * 100).toFixed(0);
  const color =
    ratio < 0.3
      ? 'bg-green-500'
      : ratio < 0.7
        ? 'bg-yellow-500'
        : 'bg-red-500';
  const label =
    ratio < 0.3
      ? 'Hedged'
      : ratio < 0.7
        ? 'Partial'
        : 'Directional';

  return (
    <div className="flex items-center space-x-2">
      <span className="text-xs text-gray-500 w-16">Hedge:</span>
      <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${percentage}%` }} />
      </div>
      <span className="text-xs text-gray-400 w-20 text-right">
        {percentage}% {label}
      </span>
    </div>
  );
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

/**
 * Multi-leg position view with leg breakdown and combined metrics.
 */
const MultiLegPositionView: React.FC<MultiLegPositionViewProps> = ({
  position,
  onClosePosition,
  onCloseLeg,
  compact = false,
  className = '',
}) => {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  /** Whether the leg breakdown is expanded */
  const [expanded, setExpanded] = useState(!compact);

  /** Confirmation state for close actions */
  const [confirmClose, setConfirmClose] = useState(false);

  // ---------------------------------------------------------------------------
  // Derived Data
  // ---------------------------------------------------------------------------

  /** Open legs count */
  const openLegs = useMemo(
    () => position.legs.filter((l) => l.status === 'open').length,
    [position.legs]
  );

  /** Total P&L (unrealized + realized) */
  const totalPnl = useMemo(
    () => position.unrealizedPnl + position.realizedPnl,
    [position]
  );

  /** Time since position opened */
  const holdingTime = useMemo(() => {
    const ms = Date.now() - position.openedAt;
    const hours = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    if (hours > 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }, [position.openedAt]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  /** Handle close entire position */
  const handleCloseAll = useCallback(() => {
    if (!confirmClose) {
      setConfirmClose(true);
      return;
    }
    onClosePosition?.(position.id);
    setConfirmClose(false);
  }, [confirmClose, onClosePosition, position.id]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      className={`bg-gray-900/50 rounded-lg border border-gray-800 overflow-hidden ${className}`}
    >
      {/* Position Header */}
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-800/30"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center space-x-3">
          {/* Strategy badge */}
          <span
            className={`px-2 py-0.5 rounded text-xs font-medium ${
              position.strategyType === 'arbitrage'
                ? 'bg-purple-900/40 text-purple-400'
                : position.strategyType === 'multi-leg'
                  ? 'bg-blue-900/40 text-blue-400'
                  : 'bg-gray-800 text-gray-400'
            }`}
          >
            {formatStrategyType(position.strategyType)}
          </span>

          {/* Label or strategy ID */}
          <span className="text-sm font-medium text-gray-200">
            {position.strategyLabel || position.strategyId.slice(0, 8)}
          </span>

          {/* Leg count */}
          <span className="text-xs text-gray-500">
            {openLegs}/{position.legs.length} legs open
          </span>
        </div>

        {/* Aggregate P&L */}
        <div className="flex items-center space-x-4">
          <span className={`text-sm font-mono font-medium ${pnlClass(totalPnl)}`}>
            {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
          </span>
          <span className="text-xs text-gray-500">{holdingTime}</span>
          <svg
            className={`w-4 h-4 text-gray-500 transition-transform ${
              expanded ? 'rotate-180' : ''
            }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      {/* Expanded Details */}
      {expanded && (
        <div className="border-t border-gray-800">
          {/* Combined Metrics */}
          <div className="px-4 py-2 bg-gray-900/30 space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-gray-500">Entry Value:</span>
              <span className="font-mono text-gray-300">
                ${position.combinedEntryValue.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-500">Current Value:</span>
              <span className="font-mono text-gray-300">
                ${position.combinedCurrentValue.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-500">Total Fees:</span>
              <span className="font-mono text-gray-400">
                -${position.totalFees.toFixed(2)}
              </span>
            </div>
            <HedgeRatioBar ratio={position.hedgeRatio} />
          </div>

          {/* Leg Column Headers */}
          <div className="flex items-center justify-between px-3 py-1 bg-gray-900/20 text-xs text-gray-600 font-medium">
            <span className="flex-1">Leg</span>
            <div className="flex items-center space-x-4 font-mono">
              <span className="w-12 text-right">Size</span>
              <span className="w-14 text-right">Entry</span>
              {!compact && <span className="w-14 text-right">Current</span>}
              <span className="w-16 text-right">P&L</span>
            </div>
            <span className="w-6" />
          </div>

          {/* Leg Rows */}
          <div className="divide-y divide-gray-800/50">
            {position.legs.map((leg) => (
              <LegRow
                key={leg.legId}
                leg={leg}
                compact={compact}
                onClose={
                  leg.status === 'open' && onCloseLeg
                    ? () => onCloseLeg(position.id, leg.legId)
                    : undefined
                }
              />
            ))}
          </div>

          {/* Actions */}
          {position.status === 'open' && onClosePosition && (
            <div className="px-4 py-3 border-t border-gray-800 bg-gray-900/30">
              <button
                onClick={handleCloseAll}
                className={`w-full py-2 rounded text-sm font-medium transition-colors ${
                  confirmClose
                    ? 'bg-red-600 hover:bg-red-500 text-white'
                    : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                }`}
              >
                {confirmClose ? 'Confirm Close All Legs' : 'Close Entire Position'}
              </button>
              {confirmClose && (
                <button
                  onClick={() => setConfirmClose(false)}
                  className="w-full mt-1 py-1 text-xs text-gray-500 hover:text-gray-400"
                >
                  Cancel
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default MultiLegPositionView;
