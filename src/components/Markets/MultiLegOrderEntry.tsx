// ============================================================================
// MULTI-LEG ORDER ENTRY COMPONENT
// ============================================================================
//
// Module: components/Markets/MultiLegOrderEntry.tsx
// Purpose: Order entry form for multi-outcome/categorical market trades
//
// OVERVIEW:
// This component provides a leg-builder interface for constructing multi-leg
// orders across categorical/multi-outcome markets. Users can:
//   - Add/remove individual order legs
//   - Select outcomes from categorical markets
//   - Choose execution strategy (OCO, bracket, spread)
//   - Set per-leg sizing and pricing
//   - Review combined order summary before submission
//
// EXECUTION STRATEGIES:
//   Single: Standard single-market order (backwards compatible)
//   OCO: One-Cancels-Other (first fill cancels remaining)
//   Bracket: Entry + stop-loss + take-profit as atomic unit
//   Spread: Simultaneous buy/sell across related outcomes
//
// INTEGRATION:
//   - Reads market outcomes from Market.outcomes[] (categorical markets)
//   - Places orders via positionsSlice.placeMultiLegOrder()
//   - Displays results from MultiLegTradeResult
//   - Updates positions view on successful fill
//
// ============================================================================

import React, { useState, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Market,
  OrderSide,
  OrderLeg,
  MultiLegOrderType,
  OutcomeSelection,
} from '../../types/markets';

// =============================================================================
// COMPONENT PROPS
// =============================================================================

interface MultiLegOrderEntryProps {
  /** Market with categorical outcomes */
  market: Market;

  /** Callback when order successfully placed */
  onOrderPlaced?: () => void;

  /** Callback to close/dismiss the order entry */
  onClose?: () => void;

  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

/**
 * Outcome selector card for categorical markets.
 *
 * Displays an individual outcome with toggle selection,
 * side selector (buy/sell), size input, and price input.
 */
const OutcomeCard: React.FC<{
  selection: OutcomeSelection;
  onChange: (updated: OutcomeSelection) => void;
}> = ({ selection, onChange }) => {
  const { outcome, selected, side, size, price } = selection;

  return (
    <div
      className={`p-3 rounded-lg border transition-all cursor-pointer ${
        selected
          ? 'border-blue-500 bg-blue-900/20'
          : 'border-gray-700 bg-gray-900/50 hover:border-gray-600'
      }`}
      onClick={() => onChange({ ...selection, selected: !selected })}
    >
      {/* Outcome header */}
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium text-sm text-gray-200 truncate flex-1">
          {outcome.name || outcome.id}
        </span>
        <div
          className={`w-4 h-4 rounded border-2 flex items-center justify-center ${
            selected ? 'border-blue-500 bg-blue-500' : 'border-gray-600'
          }`}
        >
          {selected && (
            <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
              <path d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" />
            </svg>
          )}
        </div>
      </div>

      {/* Probability bar */}
      {outcome.probability !== undefined && (
        <div className="mb-2">
          <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full"
              style={{ width: `${(outcome.probability || 0) * 100}%` }}
            />
          </div>
          <span className="text-xs text-gray-500 mt-0.5">
            {((outcome.probability || 0) * 100).toFixed(1)}%
          </span>
        </div>
      )}

      {/* Order controls (visible when selected) */}
      {selected && (
        <div
          className="mt-3 space-y-2"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Side selector */}
          <div className="flex gap-1">
            <button
              className={`flex-1 py-1 text-xs rounded font-medium transition-colors ${
                side === 'buy'
                  ? 'bg-green-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
              onClick={() => onChange({ ...selection, side: OrderSide.Buy })}
            >
              Buy YES
            </button>
            <button
              className={`flex-1 py-1 text-xs rounded font-medium transition-colors ${
                side === 'sell'
                  ? 'bg-red-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
              onClick={() => onChange({ ...selection, side: OrderSide.Sell })}
            >
              Buy NO
            </button>
          </div>

          {/* Size input */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 w-10">Size</label>
            <input
              type="number"
              min="1"
              value={size || ''}
              onChange={(e) =>
                onChange({ ...selection, size: parseFloat(e.target.value) || 0 })
              }
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1
                text-sm font-mono text-gray-200 focus:border-blue-500 focus:outline-none"
              placeholder="Qty"
            />
          </div>

          {/* Price input */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 w-10">Price</label>
            <input
              type="number"
              min="0.01"
              max="0.99"
              step="0.01"
              value={price || ''}
              onChange={(e) =>
                onChange({ ...selection, price: parseFloat(e.target.value) || 0 })
              }
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1
                text-sm font-mono text-gray-200 focus:border-blue-500 focus:outline-none"
              placeholder="0.01 - 0.99"
            />
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Strategy type selector component.
 *
 * Provides radio-button style selection for multi-leg order types
 * with descriptions of each strategy's execution behavior.
 */
const StrategySelector: React.FC<{
  selected: MultiLegOrderType;
  onChange: (type: MultiLegOrderType) => void;
  legCount: number;
}> = ({ selected, onChange, legCount }) => {
  const strategies = [
    {
      type: MultiLegOrderType.Single,
      label: 'Single',
      description: 'Execute each leg independently',
      minLegs: 1,
    },
    {
      type: MultiLegOrderType.OCO,
      label: 'OCO',
      description: 'First fill cancels remaining legs',
      minLegs: 2,
    },
    {
      type: MultiLegOrderType.Bracket,
      label: 'Bracket',
      description: 'Entry + stop-loss + take-profit',
      minLegs: 2,
    },
    {
      type: MultiLegOrderType.Spread,
      label: 'Spread',
      description: 'All legs execute simultaneously',
      minLegs: 2,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2">
      {strategies.map((s) => (
        <button
          key={s.type}
          disabled={legCount < s.minLegs}
          onClick={() => onChange(s.type)}
          className={`p-2 rounded-lg border text-left transition-all ${
            selected === s.type
              ? 'border-blue-500 bg-blue-900/20'
              : legCount < s.minLegs
                ? 'border-gray-800 bg-gray-900/30 opacity-50 cursor-not-allowed'
                : 'border-gray-700 bg-gray-900/50 hover:border-gray-600 cursor-pointer'
          }`}
        >
          <div className="font-medium text-sm text-gray-200">{s.label}</div>
          <div className="text-xs text-gray-500 mt-0.5">{s.description}</div>
        </button>
      ))}
    </div>
  );
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

/**
 * Multi-leg order entry form with outcome selection and strategy picker.
 *
 * Supports categorical markets (multiple outcomes) and binary markets
 * (YES/NO with multi-leg strategies like bracket orders).
 */
const MultiLegOrderEntry: React.FC<MultiLegOrderEntryProps> = ({
  market,
  onOrderPlaced,
  onClose,
  className = '',
}) => {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  /** Outcome selections (one per market outcome) */
  const [selections, setSelections] = useState<OutcomeSelection[]>(() => {
    // Initialize from market outcomes (categorical) or binary YES/NO
    if (market.outcomes && market.outcomes.length > 0) {
      return market.outcomes.map((outcome) => ({
        outcome,
        selected: false,
        side: OrderSide.Buy,
        size: 0,
        price: outcome.probability || undefined,
      }));
    }
    // Binary market: create YES and NO outcomes
    return [
      {
        outcome: { id: 'yes', name: 'YES', probability: market.bestBid || 0.5, bestBid: market.bestBid || 0.5, bestAsk: market.bestAsk || 0.5, volume: 0 },
        selected: false,
        side: OrderSide.Buy,
        size: 0,
        price: market.bestBid || undefined,
      },
      {
        outcome: { id: 'no', name: 'NO', probability: 1 - (market.bestBid || 0.5), bestBid: 0, bestAsk: 0, volume: 0 },
        selected: false,
        side: OrderSide.Buy,
        size: 0,
        price: market.bestAsk || undefined,
      },
    ];
  });

  /** Selected execution strategy */
  const [orderType, setOrderType] = useState<MultiLegOrderType>(
    MultiLegOrderType.Single
  );

  /** User-defined strategy label */
  const [strategyLabel, setStrategyLabel] = useState('');

  /** Submission state */
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // ---------------------------------------------------------------------------
  // Derived Data
  // ---------------------------------------------------------------------------

  /** Selected legs (outcomes with selection = true and valid size) */
  const selectedLegs = useMemo(
    () => selections.filter((s) => s.selected && (s.size || 0) > 0),
    [selections]
  );

  /** Total order value across all legs */
  const totalValue = useMemo(
    () =>
      selectedLegs.reduce(
        (sum, s) => sum + (s.size || 0) * (s.price || 0),
        0
      ),
    [selectedLegs]
  );

  /** Total estimated fees (2% per leg) */
  const estimatedFees = useMemo(() => totalValue * 0.02, [totalValue]);

  /** Whether the order is valid for submission */
  const isValid = useMemo(() => {
    if (selectedLegs.length === 0) return false;
    if (selectedLegs.some((s) => !s.size || s.size <= 0)) return false;
    if (selectedLegs.some((s) => !s.price || s.price < 0.01 || s.price > 0.99))
      return false;
    // OCO/Bracket/Spread require at least 2 legs
    if (
      orderType !== MultiLegOrderType.Single &&
      selectedLegs.length < 2
    )
      return false;
    return true;
  }, [selectedLegs, orderType]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  /** Update a single outcome selection */
  const handleSelectionChange = useCallback(
    (index: number, updated: OutcomeSelection) => {
      setSelections((prev) => {
        const next = [...prev];
        next[index] = updated;
        return next;
      });
      setError(null);
    },
    []
  );

  /** Submit the multi-leg order */
  const handleSubmit = useCallback(async () => {
    if (!isValid || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    setSuccess(false);

    try {
      // Build order legs from selections
      const legs: OrderLeg[] = selectedLegs.map((s) => ({
        marketId: market.id,
        outcomeId: s.outcome.id,
        side: s.side || OrderSide.Buy,
        ratio: 1,
        size: s.size || 0,
        price: s.price,
        marketNodeId: market.nodeId,
      }));

      // Place order via backend
      await invoke('place_multi_leg_order_cmd', {
        legs: legs.map((l) => ({
          market_id: l.marketId,
          outcome_id: l.outcomeId,
          side: l.side,
          ratio: l.ratio,
          size: l.size,
          price: l.price,
          market_node_id: l.marketNodeId,
        })),
        orderType: orderType,
        timeInForce: 'GTC',
        strategyLabel: strategyLabel || undefined,
      });

      setSuccess(true);
      onOrderPlaced?.();

      // Auto-dismiss after success
      setTimeout(() => {
        onClose?.();
      }, 2000);
    } catch (err: any) {
      setError(err.toString());
    } finally {
      setIsSubmitting(false);
    }
  }, [
    isValid,
    isSubmitting,
    selectedLegs,
    market,
    orderType,
    strategyLabel,
    onOrderPlaced,
    onClose,
  ]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className={`bg-gray-950 rounded-lg border border-gray-800 ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <div>
          <h3 className="font-semibold text-gray-200">Multi-Leg Order</h3>
          <p className="text-xs text-gray-500 mt-0.5 truncate max-w-[300px]">
            {market.question || market.id}
          </p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      <div className="p-4 space-y-4">
        {/* Outcome Selection */}
        <div>
          <h4 className="text-sm font-medium text-gray-400 mb-2">
            Select Outcomes ({selectedLegs.length} selected)
          </h4>
          <div className="grid grid-cols-2 gap-2 max-h-64 overflow-y-auto">
            {selections.map((selection, idx) => (
              <OutcomeCard
                key={selection.outcome.id}
                selection={selection}
                onChange={(updated) => handleSelectionChange(idx, updated)}
              />
            ))}
          </div>
        </div>

        {/* Strategy Selector */}
        <div>
          <h4 className="text-sm font-medium text-gray-400 mb-2">
            Execution Strategy
          </h4>
          <StrategySelector
            selected={orderType}
            onChange={setOrderType}
            legCount={selectedLegs.length}
          />
        </div>

        {/* Strategy Label */}
        <div>
          <label className="text-sm font-medium text-gray-400 block mb-1">
            Strategy Label (optional)
          </label>
          <input
            type="text"
            value={strategyLabel}
            onChange={(e) => setStrategyLabel(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2
              text-sm text-gray-200 focus:border-blue-500 focus:outline-none"
            placeholder="e.g., Presidential Republican Nominee"
          />
        </div>

        {/* Order Summary */}
        {selectedLegs.length > 0 && (
          <div className="bg-gray-900/50 rounded-lg p-3 border border-gray-800">
            <h4 className="text-sm font-medium text-gray-400 mb-2">Order Summary</h4>
            <div className="space-y-1 text-xs">
              {selectedLegs.map((leg) => (
                <div key={leg.outcome.id} className="flex justify-between text-gray-300">
                  <span>
                    {leg.side === 'buy' ? 'BUY' : 'SELL'} {leg.outcome.name}
                  </span>
                  <span className="font-mono">
                    {leg.size} @ {((leg.price || 0) * 100).toFixed(1)}c
                  </span>
                </div>
              ))}
              <div className="border-t border-gray-800 pt-1 mt-1">
                <div className="flex justify-between text-gray-400">
                  <span>Total Value:</span>
                  <span className="font-mono">${totalValue.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-gray-500">
                  <span>Est. Fees:</span>
                  <span className="font-mono">${estimatedFees.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-gray-300 font-medium">
                  <span>Net Cost:</span>
                  <span className="font-mono">${(totalValue + estimatedFees).toFixed(2)}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Error/Success Messages */}
        {error && (
          <div className="bg-red-900/30 border border-red-800 rounded p-2 text-xs text-red-400">
            {error}
          </div>
        )}
        {success && (
          <div className="bg-green-900/30 border border-green-800 rounded p-2 text-xs text-green-400">
            Order placed successfully
          </div>
        )}

        {/* Submit Button */}
        <button
          onClick={handleSubmit}
          disabled={!isValid || isSubmitting}
          className={`w-full py-3 rounded-lg font-medium text-sm transition-all ${
            isValid && !isSubmitting
              ? 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer'
              : 'bg-gray-800 text-gray-500 cursor-not-allowed'
          }`}
        >
          {isSubmitting
            ? 'Submitting...'
            : `Place ${orderType.toUpperCase()} Order (${selectedLegs.length} leg${selectedLegs.length !== 1 ? 's' : ''})`}
        </button>
      </div>
    </div>
  );
};

export default MultiLegOrderEntry;
