/**
 * Shared formatting utilities for display values.
 *
 * Centralizes number, price, size, time, and byte formatting that was
 * previously duplicated across OrderbookView, NodeOrderbookPopup,
 * GlobalOrderbookOverlay, MultiLegPositionView, PerformanceMetrics,
 * RemoteAccessPanel, and other components.
 *
 * All prediction-market prices are stored as decimals (0.0–1.0) and
 * displayed as cents (0–100¢) in binary markets.
 */

// =============================================================================
// PRICE FORMATTING
// =============================================================================

/**
 * Format a binary-market price (0.0–1.0) as cents with one decimal.
 * Example: 0.523 -> "52.3¢"
 */
export function formatCentsPrice(price: number): string {
  return `${(price * 100).toFixed(1)}¢`;
}

/**
 * Format a price for display, handling both binary and scalar markets.
 * Binary prices are shown as cents; scalar prices use fixed-point notation.
 */
export function formatPrice(
  price: number | null | undefined,
  marketType: 'binary' | 'scalar' = 'binary'
): string {
  if (price === null || price === undefined || isNaN(price)) return '--';
  if (marketType === 'binary') return formatCentsPrice(price);
  return price.toFixed(2);
}

/**
 * Format a crypto/financial price with appropriate precision.
 * Very small values (< 0.01) get 6 decimal places; others get 2.
 */
export function formatFinancialPrice(price: number | undefined): string {
  if (price === undefined || price === null || isNaN(price)) return '--';
  if (price < 0.01) return price.toFixed(6);
  return price.toFixed(2);
}

// =============================================================================
// SIZE / QUANTITY FORMATTING
// =============================================================================

/**
 * Format a quantity with K/M suffixes for readability.
 * Example: 1500 -> "1.5K", 2500000 -> "2.50M"
 */
export function formatSize(size: number): string {
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(2)}M`;
  if (size >= 1_000) return `${(size / 1_000).toFixed(1)}K`;
  return size.toFixed(0);
}

/**
 * Format byte counts with appropriate unit (B, KB, MB, GB).
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// =============================================================================
// TIME FORMATTING
// =============================================================================

/**
 * Format a JS timestamp (milliseconds) as HH:MM:SS.mmm (24-hour).
 * Used for orderbook and stream timestamps.
 */
export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

/**
 * Format a Unix timestamp (seconds) as a localized date string.
 * Backend stores timestamps in seconds; this handles the *1000 conversion.
 */
export function formatUnixTimestamp(timestampSecs: number): string {
  return new Date(timestampSecs * 1000).toLocaleString();
}

/**
 * Format a timestamp as relative time ("just now", "5s ago", "3m ago").
 * Falls back to absolute HH:MM:SS for times older than 1 hour.
 */
export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 1000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60000)}m ago`;
  return formatTimestamp(timestamp);
}

/**
 * Format a Date as HH:MM:SS (24-hour, zero-padded).
 * Used by the status bar clock.
 */
export function formatClockTime(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((n) => n.toString().padStart(2, '0'))
    .join(':');
}

/**
 * Format a duration in seconds as a human-readable string.
 * Example: 3661 -> "1h 1m 1s"
 */
export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// =============================================================================
// CSS HELPERS
// =============================================================================

/**
 * Merge CSS class names, filtering out falsy values.
 * Thin wrapper for consistent class string building across the app.
 */
export function cn(...inputs: (string | boolean | undefined | null)[]): string {
  return inputs.filter(Boolean).join(' ');
}
