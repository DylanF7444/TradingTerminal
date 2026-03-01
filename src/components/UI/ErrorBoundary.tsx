// ============================================================================
// PANEL ERROR BOUNDARY COMPONENT
// ============================================================================
//
// Module: components/UI/ErrorBoundary.tsx
// Purpose: Catches rendering errors in individual panels to prevent them from
//          crashing the entire application.
//
// Each major panel (Canvas, SourcePanel, MarketPanel, NodeDetails) should be
// wrapped in its own ErrorBoundary so that a failure in one panel doesn't
// cascade to the rest of the UI.
// ============================================================================

import { Component, type ErrorInfo, type ReactNode } from 'react';

// =============================================================================
// TYPES
// =============================================================================

interface PanelErrorBoundaryProps {
  /** Name of the panel, shown in the fallback UI */
  panelName: string;
  /** Content to render */
  children: ReactNode;
  /** Optional custom fallback renderer */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface PanelErrorBoundaryState {
  error: Error | null;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Error boundary that wraps individual panels.
 *
 * On error, displays a compact fallback with:
 * - Panel name and error message
 * - "Retry" button that resets the error state
 *
 * Usage:
 * ```tsx
 * <PanelErrorBoundary panelName="Canvas">
 *   <Canvas {...props} />
 * </PanelErrorBoundary>
 * ```
 */
export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  constructor(props: PanelErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): PanelErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.panelName}]`, error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) {
        return this.props.fallback(error, this.reset);
      }
      return <DefaultFallback panelName={this.props.panelName} error={error} onReset={this.reset} />;
    }
    return this.props.children;
  }
}

// =============================================================================
// DEFAULT FALLBACK UI
// =============================================================================

function DefaultFallback({
  panelName,
  error,
  onReset,
}: {
  panelName: string;
  error: Error;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-6 text-center">
      <div className="w-12 h-12 rounded-full bg-red-900/30 flex items-center justify-center mb-3">
        <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
          />
        </svg>
      </div>
      <h3 className="text-sm font-semibold text-gray-300 mb-1">{panelName} Error</h3>
      <p className="text-xs text-gray-500 mb-4 max-w-xs">{error.message}</p>
      <button
        onClick={onReset}
        className="px-4 py-1.5 text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
      >
        Retry
      </button>
    </div>
  );
}

export default PanelErrorBoundary;
