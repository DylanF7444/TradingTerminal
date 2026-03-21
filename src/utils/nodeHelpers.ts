// ============================================================================
// NODE TYPE HELPER UTILITIES
// ============================================================================
//
// Module: utils/nodeHelpers.ts
// Purpose: Reusable helpers for node type checking, display names, and color schemes
//
// These helpers eliminate repeated inline type-checking patterns like:
//   `node.node_type && 'InfoSource' in node.node_type`
// and centralize display-name mappings used across NodeDetailsPanel, Node.tsx, etc.
// ============================================================================

import type { Node, NodeType } from '../types/nodes';

// =============================================================================
// TYPE GUARDS
// =============================================================================

/** Type-safe check: is this an InfoSource node? */
export function isInfoSource(node: Node): boolean {
  return node.node_type != null && 'InfoSource' in node.node_type;
}

/** Type-safe check: is this a Market node? */
export function isMarket(node: Node): boolean {
  return node.node_type != null && 'Market' in node.node_type;
}

/** Type-safe check: is this an Analyzer node? */
export function isAnalyzer(node: Node): boolean {
  return node.node_type != null && 'Analyzer' in node.node_type;
}

/** Type-safe check: is this an Alert node? */
export function isAlert(node: Node): boolean {
  return node.node_type != null && 'Alert' in node.node_type;
}

// =============================================================================
// SUBTYPE EXTRACTION
// =============================================================================

/** Extracts the subtype string (e.g., "CryptoPrices", "Polymarket") from NodeType. */
export function getNodeSubtype(nodeType: NodeType): string {
  if ('InfoSource' in nodeType) return nodeType.InfoSource;
  if ('Market' in nodeType) return nodeType.Market;
  if ('Analyzer' in nodeType) return nodeType.Analyzer;
  if ('Alert' in nodeType) return nodeType.Alert;
  return 'Unknown';
}

/** Gets the top-level category string from NodeType. */
export function getNodeCategory(nodeType: NodeType): 'InfoSource' | 'Market' | 'Analyzer' | 'Alert' | 'Unknown' {
  if ('InfoSource' in nodeType) return 'InfoSource';
  if ('Market' in nodeType) return 'Market';
  if ('Analyzer' in nodeType) return 'Analyzer';
  if ('Alert' in nodeType) return 'Alert';
  return 'Unknown';
}

// =============================================================================
// DISPLAY NAME MAPPING
// =============================================================================

/** Maps subtype strings to human-readable display names. */
const TYPE_DISPLAY_NAMES: Record<string, string> = {
  // Info Sources
  CryptoPrices: 'Cryptocurrency Prices',
  FinancialPrices: 'Financial Markets',
  CommodityPrices: 'Commodity Prices',
  NewsSource: 'News Feed',
  SocialMedia: 'Social Media',
  Weather: 'Weather Data',
  Livestream: 'Livestream Metrics',
  EconomicIndicators: 'Economic Indicators',
  OnChainData: 'On-Chain Data',
  CustomAPI: 'Custom API',
  PolymarketUserTrades: 'Polymarket User Trades',
  // Markets
  Polymarket: 'Polymarket',
  Kalshi: 'Kalshi',
  // Analyzers
  Correlation: 'Correlation Analyzer',
  MovingAverage: 'Moving Average',
  Sentiment: 'Sentiment Analyzer',
  Arbitrage: 'Arbitrage Detector',
  Custom: 'Custom Analyzer',
  WhaleActivity: 'Whale Activity Detector',
  // Alerts
  PriceThreshold: 'Price Threshold Alert',
  CorrelationChange: 'Correlation Change Alert',
  Webhook: 'Webhook Alert',
  Desktop: 'Desktop Notification',
};

/** Returns a human-readable display name for a subtype string. */
export function getTypeDisplayName(subtype: string): string {
  return TYPE_DISPLAY_NAMES[subtype] ?? subtype;
}

/** Gets the category emoji for UI display. */
export function getNodeCategoryEmoji(node: Node): string {
  if (isInfoSource(node)) return '📊';
  if (isMarket(node)) return '📈';
  if (isAnalyzer(node)) return '🔍';
  if (isAlert(node)) return '🔔';
  return '📦';
}

/** Gets the category label for UI display. */
export function getNodeCategoryLabel(node: Node): string {
  if (isInfoSource(node)) return 'Information Source';
  if (isMarket(node)) {
    return 'Prediction Market';
  }
  if (isAnalyzer(node)) return 'Analyzer';
  if (isAlert(node)) return 'Alert';
  return 'Node';
}

// =============================================================================
// COLOR SCHEME
// =============================================================================

export interface NodeColorScheme {
  dot: string;
  tagBg: string;
  tagText: string;
  tagBorder: string;
}

/** Returns the Tailwind color classes for a node category. */
export function getNodeColorScheme(node: Node): NodeColorScheme {
  if (isInfoSource(node)) {
    return {
      dot: 'bg-blue-500',
      tagBg: 'bg-blue-900/50',
      tagText: 'text-blue-300',
      tagBorder: 'border-blue-700/50',
    };
  }
  if (isMarket(node)) {
    return {
      dot: 'bg-emerald-500',
      tagBg: 'bg-emerald-900/50',
      tagText: 'text-emerald-300',
      tagBorder: 'border-emerald-700/50',
    };
  }
  return {
    dot: 'bg-purple-500',
    tagBg: 'bg-purple-900/50',
    tagText: 'text-purple-300',
    tagBorder: 'border-purple-700/50',
  };
}

// =============================================================================
// METADATA HELPERS
// =============================================================================

/**
 * Safely casts node metadata to a flexible record type.
 * Avoids repetitive `as Record<string, any>` casts scattered throughout components.
 */
export function getMetadata(node: Node): Record<string, unknown> {
  return (node.metadata ?? {}) as Record<string, unknown>;
}

/** Returns the display name for a node, falling back through multiple sources. */
export function getNodeDisplayName(node: Node): string {
  const meta = getMetadata(node);
  return (
    (meta.name as string) ||
    node.name ||
    node.id?.slice(0, 12) ||
    'Unknown'
  );
}
