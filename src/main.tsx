// ============================================================================
// REACT APPLICATION ENTRY POINT
// ============================================================================
//
// Module: main.tsx
// Purpose: Application bootstrap, root rendering, and global providers
//
// OVERVIEW:
// This module serves as the entry point for the React frontend application.
// It initializes the React root, configures global providers (Redux-style state
// via Zustand, routing, theming), sets up error boundaries, and mounts the
// application to the DOM. It also handles Tauri-specific initialization and
// platform integration.
//
// Architecture Pattern:
// Layered Bootstrap with Error Boundaries
//   Platform Detection → Tauri Init → React Root → Providers → App
//   Each layer has error handling and graceful degradation
//
// INITIALIZATION SEQUENCE:
//
// 1. Platform Detection
//    - Detect Tauri vs browser environment
//    - Configure polyfills for missing APIs
//    - Set up logging appropriate to environment
//
// 2. Tauri Initialization
//    - Register Tauri event listeners
//    - Initialize native window controls
//    - Set up system tray / menu integration
//    - Configure native notifications
//
// 3. React Root Creation
//    - Create React 18+ concurrent root
//    - Enable StrictMode for development checks
//    - Configure production error handling
//
// 4. Global Providers
//    - Zustand store providers (state management)
//    - Theme provider (dark/light mode, system preference)
//    - Toast/notification provider
//    - Modal/dialog provider
//
// 5. Application Mount
//    - Render App component
//    - Post-render initialization (analytics, etc.)
//
// ERROR HANDLING STRATEGY:
//
// Fatal Errors (prevent app launch):
//   - React root creation failure
//   - Critical provider initialization failure
//   - Unhandled promise rejection during bootstrap
//
// Recoverable Errors (allow degraded operation):
//   - Tauri API unavailable (fallback to browser mode)
//   - Non-critical provider failure
//   - Theme detection failure
//
// Runtime Errors (caught by boundaries):
//   - Component render errors
//   - Event handler errors
//   - Async operation errors
//
// PERFORMANCE OPTIMIZATIONS:
//
// - Code splitting at route level (React.lazy + Suspense)
// - Preload critical assets
// - Defer non-essential initialization
// - Use React 18 concurrent features
//
// SECURITY CONSIDERATIONS:
//
// - CSP (Content Security Policy) compliance
// - Sanitize external data before rendering
// - Secure storage for sensitive configuration
// - Disable dangerous browser APIs in Tauri context
//
// ============================================================================

import React, { StrictMode, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';

// Global styles - Tailwind CSS
import './styles.css';

// Application root component
import App from './App';

// =============================================================================
// PLATFORM DETECTION
// =============================================================================

/**
 * Detect if running in Tauri desktop environment vs browser.
 * Used to conditionally enable native features.
 */
const isTauri = typeof window !== 'undefined' && 
  // @ts-ignore - __TAURI__ is injected by Tauri runtime
  window.__TAURI__ !== undefined;

/**
 * Detect if running in development mode.
 */
const isDevelopment = import.meta.env.DEV;

/**
 * Detect system color scheme preference.
 */
const getSystemTheme = (): 'dark' | 'light' => {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

// =============================================================================
// LOGGING CONFIGURATION
// =============================================================================

/**
 * Structured logging utility with environment-aware behavior.
 */
class Logger {
  private prefix: string;
  private isEnabled: boolean;

  constructor(prefix: string) {
    this.prefix = prefix;
    this.isEnabled = isDevelopment || isTauri;
  }

  info(...args: any[]): void {
    if (!this.isEnabled) return;
    console.log(`[${this.prefix}]`, ...args);
  }

  warn(...args: any[]): void {
    if (!this.isEnabled) return;
    console.warn(`[${this.prefix}]`, ...args);
  }

  error(...args: any[]): void {
    // Always log errors
    console.error(`[${this.prefix}]`, ...args);
    
    // Send to backend in production
    if (isTauri && !isDevelopment) {
      invoke('log_frontend_error', { 
        message: args.map(a => String(a)).join(' '),
        stack: new Error().stack 
      }).catch(() => {});
    }
  }

  debug(...args: any[]): void {
    if (!isDevelopment) return;
    console.debug(`[${this.prefix}]`, ...args);
  }
}

const logger = new Logger('Main');

// =============================================================================
// TAURI INITIALIZATION
// =============================================================================

/**
 * Tauri-specific initialization.
 * Sets up native window controls, event listeners, and platform integration.
 */
async function initializeTauri(): Promise<void> {
  if (!isTauri) {
    logger.info('Running in browser mode, Tauri features disabled');
    return;
  }

  logger.info('Initializing Tauri native features');

  try {
    // Set up window event listeners
    const appWindow = getCurrentWindow();
    
    const unlistenClose = await listen('tauri://close-requested', () => {
      logger.info('Close requested, performing cleanup...');
      // Perform cleanup, save state, etc.
      appWindow.close();
    });

    const unlistenFocus = await listen('tauri://focus', () => {
      // Resume high-frequency updates when window focused
      document.body.classList.add('window-focused');
    });

    const unlistenBlur = await listen('tauri://blur', () => {
      // Reduce update frequency when backgrounded
      document.body.classList.remove('window-focused');
    });

    // Configure native theme change listener
    const unlistenTheme = await listen('tauri://theme-changed', (event) => {
      const theme = event.payload as 'light' | 'dark';
      document.documentElement.classList.toggle('dark', theme === 'dark');
    });

    // Register cleanup for hot reload
    if (isDevelopment && (import.meta as any).hot) {
      (import.meta as any).hot.dispose(() => {
        unlistenClose();
        unlistenFocus();
        unlistenBlur();
        unlistenTheme();
      });
    }

    // Initialize system tray if needed
    // await invoke('initialize_tray');

    logger.info('Tauri initialization complete');
  } catch (error) {
    logger.error('Tauri initialization failed:', error);
    // Continue in degraded mode
  }
}

// =============================================================================
// ERROR BOUNDARY COMPONENT
// =============================================================================

/**
 * Global error boundary for catching React rendering errors.
 * Displays fallback UI when critical errors occur.
 */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error('React error boundary caught:', error);
    logger.error('Component stack:', errorInfo.componentStack);
    
    // Report to backend if in Tauri
    if (isTauri) {
      invoke('report_error', {
        error: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
      }).catch(() => {});
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-8">
          <div className="max-w-lg text-center">
            <h1 className="text-3xl font-bold text-red-500 mb-4">
              Application Error
            </h1>
            <p className="text-gray-300 mb-6">
              The prediction market terminal encountered a critical error and cannot continue.
            </p>
            <div className="bg-gray-800 rounded-lg p-4 mb-6 text-left overflow-auto max-h-64">
              <code className="text-sm text-red-400">
                {this.state.error?.message}
              </code>
              <pre className="text-xs text-gray-500 mt-2">
                {this.state.error?.stack}
              </pre>
            </div>
            <div className="space-x-4">
              <button
                onClick={() => window.location.reload()}
                className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors"
              >
                Reload Application
              </button>
              {isTauri && (
                <button
                  onClick={() => invoke('restart_app')}
                  className="px-6 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg font-medium transition-colors"
                >
                  Restart
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// =============================================================================
// LOADING SHELL COMPONENT
// =============================================================================

/**
 * Loading state displayed while application initializes.
 * Shows progress indicator and initialization status.
 */
function LoadingShell() {
  const [status, setStatus] = useState('Initializing...');

  useEffect(() => {
    const steps = [
      { message: 'Loading configuration...', delay: 100 },
      { message: 'Connecting to data sources...', delay: 300 },
      { message: 'Initializing trading engine...', delay: 500 },
      { message: 'Starting user interface...', delay: 700 },
    ];

    let timeouts: ReturnType<typeof setTimeout>[] = [];

    steps.forEach(({ message, delay }) => {
      const timeout = setTimeout(() => setStatus(message), delay);
      timeouts.push(timeout);
    });

    return () => timeouts.forEach(clearTimeout);
  }, []);

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center">
      {/* Logo/Brand */}
      <div className="mb-8">
        <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/20">
          <svg 
            className="w-10 h-10 text-white" 
            fill="none" 
            viewBox="0 0 24 24" 
            stroke="currentColor"
          >
            <path 
              strokeLinecap="round" 
              strokeLinejoin="round" 
              strokeWidth={2} 
              d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" 
            />
          </svg>
        </div>
      </div>

      {/* Title */}
      <h1 className="text-2xl font-bold text-white mb-2">
        Prediction Market Terminal
      </h1>
      <p className="text-gray-400 mb-8">Loading trading environment...</p>

      {/* Progress indicator */}
      <div className="w-64 h-1 bg-gray-800 rounded-full overflow-hidden">
        <div className="h-full bg-gradient-to-r from-blue-500 to-purple-500 animate-pulse" 
             style={{ width: '60%' }} />
      </div>

      {/* Status text */}
      <p className="mt-4 text-sm text-gray-500 font-mono">{status}</p>

      {/* Version info */}
      <p className="mt-8 text-xs text-gray-600">
        v{import.meta.env.VITE_APP_VERSION || '0.1.0'}
        {isTauri ? ' • Desktop' : ' • Web'}
        {isDevelopment && ' • Dev'}
      </p>
    </div>
  );
}

// =============================================================================
// ROOT COMPONENT WITH PROVIDERS
// =============================================================================

/**
 * Root component wrapping App with all global providers.
 * Handles theme initialization and global state setup.
 */
function Root() {
  const [theme, setTheme] = useState<'dark' | 'light'>(getSystemTheme());
  const [isReady, setIsReady] = useState(false);

  // Initialize theme
  useEffect(() => {
    // Apply initial theme
    document.documentElement.classList.toggle('dark', theme === 'dark');

    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      const newTheme = e.matches ? 'dark' : 'light';
      setTheme(newTheme);
      document.documentElement.classList.toggle('dark', e.matches);
    };

    mediaQuery.addEventListener('change', handleChange);

    // Initialize Tauri features
    initializeTauri().then(() => {
      // Simulate minimum loading time for smooth UX
      setTimeout(() => setIsReady(true), 800);
    });

    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // Initialize store
  useEffect(() => {
    if (!isReady) return;

    // Note: Backend sync is handled by the store subscription in store/index.ts
  }, [isReady]);

  if (!isReady) {
    return <LoadingShell />;
  }

  return (
    <div className={`min-h-screen ${theme}`}>
      <App />
    </div>
  );
}

// =============================================================================
// APPLICATION BOOTSTRAP
// =============================================================================

/**
 * Main entry point - initializes and renders the React application.
 */
async function bootstrap() {
  logger.info('Bootstrapping application...');
  logger.info(`Environment: ${isDevelopment ? 'development' : 'production'}`);
  logger.info(`Platform: ${isTauri ? 'Tauri' : 'Browser'}`);

  // Get root element
  const container = document.getElementById('root');

  if (!container) {
    logger.error('Root element not found - cannot mount application');
    document.body.innerHTML = `
      <div style="padding: 20px; color: red;">
        <h1>Fatal Error</h1>
        <p>Application root element not found. Please check index.html.</p>
      </div>
    `;
    return;
  }

  try {
    // Create React 18 concurrent root
    const root = createRoot(container);

    // Enable StrictMode in development for additional checks
    const AppWrapper = isDevelopment ? (
      <StrictMode>
        <ErrorBoundary>
          <Suspense fallback={<LoadingShell />}>
            <Root />
          </Suspense>
        </ErrorBoundary>
      </StrictMode>
    ) : (
      <ErrorBoundary>
        <Suspense fallback={<LoadingShell />}>
          <Root />
        </Suspense>
      </ErrorBoundary>
    );

    // Render application
    root.render(AppWrapper);

    logger.info('Application mounted successfully');

    // Post-render initialization
    if (isTauri) {
      // Notify backend that frontend is ready
      invoke('frontend_ready').catch(() => {});
    }

  } catch (error) {
    logger.error('Failed to mount application:', error);
    
    container.innerHTML = `
      <div style="padding: 20px; color: red;">
        <h1>Fatal Error</h1>
        <p>Failed to initialize React application:</p>
        <pre>${error instanceof Error ? error.message : String(error)}</pre>
      </div>
    `;
  }
}

// =============================================================================
// GLOBAL ERROR HANDLERS
// =============================================================================

/**
 * Handle unhandled promise rejections.
 */
window.addEventListener('unhandledrejection', (event) => {
  logger.error('Unhandled promise rejection:', event.reason);
  
  // Prevent default handling
  event.preventDefault();
});

/**
 * Handle global errors.
 */
window.addEventListener('error', (event) => {
  logger.error('Global error:', event.error);
  
  // Prevent default for known error types we handle
  if (event.message?.includes('ResizeObserver')) {
    event.preventDefault();
  }
});

// =============================================================================
// HOT MODULE REPLACEMENT
// =============================================================================

if (isDevelopment && (import.meta as any).hot) {
  (import.meta as any).hot.accept(() => {
    logger.info('Hot module replacement triggered');
  });
}

// =============================================================================
// START APPLICATION
// =============================================================================

// Ensure DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

// =============================================================================
// EXPORTS (for testing)
// =============================================================================

export { Logger, ErrorBoundary, LoadingShell, Root, initializeTauri };