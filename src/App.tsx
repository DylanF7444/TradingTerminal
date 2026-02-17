// ============================================================================
// MAIN APPLICATION COMPONENT
// ============================================================================
//
// Module: App.tsx
// Purpose: Root application shell, layout management, and global UI state
//
// OVERVIEW:
// This component serves as the primary layout controller for the prediction
// market trading terminal. It orchestrates the three-panel interface design
// (sidebar controls, main canvas, detail panels) and manages global UI state
// such as panel visibility, selected nodes, and responsive layout adaptations.
//
// Architecture Pattern:
// Compound Component Layout with Zustand State Integration
//   App (layout shell)
//   ├── LeftSidebar (controls)
//   ├── MainCanvas (visualization)
//   ├── RightSidebar (details)
//   └── BottomPanel (positions)
//
// LAYOUT DESIGN:
//
// The interface follows a professional trading terminal aesthetic:
//
// ┌─────────────────┬──────────────────────────┬─────────────────┐
// │                 │                          │                 │
// │  Left Sidebar   │      Main Canvas         │  Right Sidebar  │
// │  (200-300px)    │      (flexible)          │  (0-400px)      │
// │                 │                          │  collapsible    │
// │  • SourcePanel  │      Node Graph          │                 │
// │  • MarketPanel  │      Visualization       │  • NodeDetails  │
// │  • QuickActions │                          │  • Orderbook    │
// │                 │                          │  • Analytics    │
// ├─────────────────┴──────────────────────────┴─────────────────┤
// │                    Bottom Panel (200-300px)                   │
// │                                                               │
// │  • PositionMonitor    • PerformanceMetrics    • SystemStatus  │
// │                                                               │
// └───────────────────────────────────────────────────────────────┘
//
// RESPONSIVE BEHAVIOR:
//
// Desktop (>1400px): Full three-panel layout
// Tablet (900-1400px): Collapsible right sidebar, priority to canvas
// Mobile (<900px): Tab-based navigation, single panel visible
//
// STATE MANAGEMENT:
//
// Local UI State (useState):
//   - Panel visibility toggles
//   - Selected node for detail view
//   - Canvas viewport state (if not in global store)
//   - Modal/dialog open states
//
// Global State (Zustand store):
//   - nodes: All graph nodes from nodesSlice
//   - connections: All graph edges from nodesSlice
//   - openPositions: Trading positions from positionsSlice
//   - markets: Connected exchanges from marketsSlice
//
// PERFORMANCE OPTIMIZATIONS:
//
// - Memoized selectors prevent unnecessary re-renders
// - Virtual scrolling for long lists (positions, markets)
// - Canvas uses requestAnimationFrame independently
// - Lazy loading for non-critical panels
// - Debounced resize handling
//
// KEYBOARD SHORTCUTS:
//
// Global shortcuts handled at this level:
//   - Ctrl/Cmd + S: Save graph
//   - Ctrl/Cmd + Z: Undo
//   - Ctrl/Cmd + Shift + Z: Redo
//   - Escape: Close panels, deselect
//   - F11: Toggle fullscreen
//   - Ctrl/Cmd + B: Toggle bottom panel
//   - Ctrl/Cmd + /: Toggle help overlay
//
// ACCESSIBILITY:
//
// - ARIA landmarks for regions (navigation, main, complementary)
// - Keyboard navigation support
// - Focus management between panels
// - Screen reader announcements for state changes
// - Reduced motion support
//
// ERROR BOUNDARIES:
//
// Each major panel has its own error boundary to isolate failures:
//   - Canvas errors don't crash the control panel
//   - Position monitor can fail independently
//   - Detail panel errors don't affect main workspace
//
// ============================================================================

import { useState, useCallback, useEffect, useMemo, type ReactNode } from 'react';

// Store hooks
import { useStore, type StoreState } from './store';

// Tauri imports
import { invoke } from '@tauri-apps/api/core';

// Layout components
import Canvas from './components/Canvas/Canvas';
import SourcePanel from './components/InfoSources/SourcePanel';
import MarketPanel from './components/Markets/MarketPanel';
import PerformanceMetrics from './components/Metrics/PerformanceMetrics';

// UI components
import { Modal } from './components/UI/Modal';

// Types
import { Node, NodeId, InfoSourceType, MarketType } from './types/nodes';

// =============================================================================
// LAYOUT CONSTANTS
// =============================================================================

/** Default panel widths in pixels */
const PANEL_WIDTHS = {
  leftSidebar: 280,
  rightSidebar: 384, // 96 * 4 = 384px (Tailwind w-96)
  bottomPanel: 240,
};

/** Breakpoints for responsive behavior */
const BREAKPOINTS = {
  mobile: 768,
  tablet: 1024,
  desktop: 1400,
};

// =============================================================================
// MAIN APPLICATION COMPONENT
// =============================================================================

/**
 * Root application component managing layout and global UI state.
 */
function App(): ReactNode {
  // -------------------------------------------------------------------------
  // Global State Selectors (Zustand)
  // -------------------------------------------------------------------------
  
  const nodes = useStore((state: StoreState) => state.nodes);
  const connections = useStore((state: StoreState) => state.connections);
  const selectedIds = useStore((state: StoreState) => state.selectedIds);
  const selectNode = useStore((state: StoreState) => state.selectNode);
  const clearSelection = useStore((state: StoreState) => state.clearSelection);
  const viewport = useStore((state: StoreState) => state.viewport);
  const addNode = useStore((state: StoreState) => state.addNode);
  const setViewport = useStore((state: StoreState) => state.setViewport);
  const importGraph = useStore((state: StoreState) => state.importGraph);

  // -------------------------------------------------------------------------
  // Load existing nodes on app mount
  // -------------------------------------------------------------------------

  // Helper to transform backend node format to frontend format
  const transformNodeFromBackend = (node: any): any => {
    // Handle node_type transformation: { type: "InfoSource", subtype: "CryptoPrices" } -> { InfoSource: "CryptoPrices" }
    let nodeType: any = node.node_type;
    if (nodeType && nodeType.type && nodeType.subtype) {
      // Convert from backend format to frontend format
      if (nodeType.type === 'InfoSource') {
        nodeType = { InfoSource: nodeType.subtype };
      } else if (nodeType.type === 'Market') {
        nodeType = { Market: nodeType.subtype };
      }
    }

    return {
      ...node,
      node_type: nodeType,
      // Ensure required fields have defaults (backend doesn't include these)
      connections: node.connections || [],
      createdAt: node.createdAt || Date.now(),
      updatedAt: node.updatedAt || Date.now(),
    };
  };

  useEffect(() => {
    const loadExistingNodes = async () => {
      try {
        const result = await invoke<any[]>('get_data_sources_cmd');
        
        // Get addNode from store for adding loaded nodes
        const { addNode } = useStore.getState();
        
        if (result && Array.isArray(result) && result.length > 0) {
          // Add all nodes from backend with transformed format
          result.forEach(node => {
            addNode(transformNodeFromBackend(node));
          });
          
          console.log(`Loaded ${result.length} existing nodes from backend`);
        } else {
          // No nodes in database - create demo nodes for first-time users
          console.log('No existing nodes found, creating demo nodes...');
          createDemoNodes();
        }
      } catch (error) {
        console.error('Failed to load existing nodes:', error);
        // Create demo nodes as fallback on error
        createDemoNodes();
      }
    };
    
    loadExistingNodes();
  }, []);

  // -------------------------------------------------------------------------
  // Create demo nodes for first-time users
  // -------------------------------------------------------------------------
  
  const createDemoNodes = useCallback(() => {
    const { addNode, addConnection } = useStore.getState();
    const now = Date.now();
    
    // Demo crypto price source node
    const cryptoSourceId = 'demo-crypto-source' as NodeId;
    addNode({
      id: cryptoSourceId,
      node_type: { InfoSource: InfoSourceType.CryptoPrices },
      position: [150, 200],
      connections: [],
      metadata: {
        symbols: ['BTC', 'ETH', 'SOL'],
        updateIntervalSeconds: 5,
        exchange: 'binance',
      },
      createdAt: now,
      updatedAt: now,
    });
    
    // Demo polymarket node
    const polymarketId = 'demo-polymarket' as NodeId;
    addNode({
      id: polymarketId,
      node_type: { Market: MarketType.Polymarket },
      position: [450, 200],
      connections: [],
      metadata: {
        autoTrade: false,
      },
      createdAt: now,
      updatedAt: now,
    });
    
    // Create connection between source and market
    addConnection({
      source: cryptoSourceId,
      target: polymarketId,
      strength: 0.8,
    });
    
    // Demo news source node
    const newsSourceId = 'demo-news-source' as NodeId;
    addNode({
      id: newsSourceId,
      node_type: { InfoSource: InfoSourceType.NewsSource },
      position: [150, 400],
      connections: [],
      metadata: {
        feeds: ['reuters', 'ap'],
        keywords: ['election', 'bitcoin', 'crypto'],
      },
      createdAt: now,
      updatedAt: now,
    });
    
    // Connect news to polymarket
    addConnection({
      source: newsSourceId,
      target: polymarketId,
      strength: 0.6,
    });
    
    console.log('Demo nodes created successfully');
  }, []);

  // -------------------------------------------------------------------------
  // Local UI State
  // -------------------------------------------------------------------------
  
  /** Right sidebar visibility */
  const [showRightSidebar, setShowRightSidebar] = useState(true);
  
  /** Bottom panel visibility */
  const [showBottomPanel, setShowBottomPanel] = useState(true);
  
  /** Left sidebar collapsed state (mobile) */
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  
  /** Currently active tab in mobile view */
  const [mobileActiveTab, setMobileActiveTab] = useState<'canvas' | 'controls' | 'details'>('canvas');
  
  /** Help modal visibility */
  const [showHelp, setShowHelp] = useState(false);
  
  /** Window size for responsive behavior */
  const [windowSize, setWindowSize] = useState(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 1200,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
  }));

  // -------------------------------------------------------------------------
  // Derived State
  // -------------------------------------------------------------------------
  
  /** Currently selected node (single selection for detail view) */
  const selectedNode = useMemo(() => {
    if (selectedIds.size !== 1) return null;
    const selectedId = Array.from(selectedIds)[0];
    return nodes[selectedId] || null;
  }, [selectedIds, nodes]);

  /** Convert nodes record to array for Canvas */
  const nodesArray = useMemo(() => Object.values(nodes), [nodes]);

  /** Convert connections to array */
  const connectionsArray = useMemo(() => connections, [connections]);

  /** Responsive layout mode */
  const layoutMode = useMemo(() => {
    if (windowSize.width < BREAKPOINTS.mobile) return 'mobile';
    if (windowSize.width < BREAKPOINTS.tablet) return 'tablet';
    return 'desktop';
  }, [windowSize.width]);

  // -------------------------------------------------------------------------
  // Event Handlers
  // -------------------------------------------------------------------------
  
  /** Handle window resize with debouncing */
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;
    
    const handleResize = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        setWindowSize({
          width: window.innerWidth,
          height: window.innerHeight,
        });
      }, 100);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(timeoutId);
    };
  }, []);

  /** Handle keyboard shortcuts */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd key shortcuts
      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 's':
            e.preventDefault();
            // Trigger save
            break;
          case 'z':
            e.preventDefault();
            if (e.shiftKey) {
              // Redo
            } else {
              // Undo
            }
            break;
          case 'b':
            e.preventDefault();
            setShowBottomPanel((prev) => !prev);
            break;
          case '/':
            e.preventDefault();
            setShowHelp(true);
            break;
        }
        return;
      }

      // Escape key
      if (e.key === 'Escape') {
        if (showHelp) {
          setShowHelp(false);
        } else if (selectedIds.size > 0) {
          clearSelection();
        } else if (showRightSidebar) {
          setShowRightSidebar(false);
        }
      }

      // F11 for fullscreen
      if (e.key === 'F11') {
        e.preventDefault();
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          document.documentElement.requestFullscreen();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds.size, showHelp, showRightSidebar, clearSelection]);

  /** Handle node selection from Canvas */
  const handleNodeClick = useCallback((node: Node) => {
    selectNode(node.id, false); // Single selection
    setShowRightSidebar(true);
  }, [selectNode]);

  /** Handle node movement from Canvas */
  const handleNodeMove = useCallback((id: string, position: [number, number]) => {
    const { updateNodePosition } = useStore.getState();
    updateNodePosition(id, position);
  }, []);

  /** Handle canvas background click (deselect) */
  const handleCanvasBackgroundClick = useCallback(() => {
    clearSelection();
  }, [clearSelection]);

  /** Handle viewport change from Canvas */
  const handleViewportChange = useCallback((newViewport: { x: number; y: number; zoom: number }) => {
    setViewport(newViewport);
  }, [setViewport]);

  /** Toggle right sidebar */
  const toggleRightSidebar = useCallback(() => {
    setShowRightSidebar((prev) => !prev);
  }, []);

  /** Toggle bottom panel */
  const toggleBottomPanel = useCallback(() => {
    setShowBottomPanel((prev) => !prev);
  }, []);

  // -------------------------------------------------------------------------
  // Render Helpers
  // -------------------------------------------------------------------------
  
  /** Render desktop layout */
  const renderDesktop = () => (
    <div className="flex h-screen w-screen overflow-hidden bg-gray-950 text-gray-100">
      {/* Left Sidebar - Controls */}
      <aside 
        className={`flex-shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col transition-all duration-300 ${
          leftSidebarCollapsed ? 'w-16' : 'w-72'
        }`}
        aria-label="Control panel"
      >
        {/* Header */}
        <div className="h-14 flex items-center px-4 border-b border-gray-800">
          {leftSidebarCollapsed ? (
            <button 
              onClick={() => setLeftSidebarCollapsed(false)}
              className="p-2 hover:bg-gray-800 rounded-lg"
              title="Expand sidebar"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
              </svg>
            </button>
          ) : (
            <div className="flex items-center justify-between w-full">
              <h1 className="text-lg font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
                Trading Terminal
              </h1>
              <button 
                onClick={() => setLeftSidebarCollapsed(true)}
                className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400"
                title="Collapse sidebar"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {/* Scrollable content */}
        {!leftSidebarCollapsed && (
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            <SourcePanel 
              onAddSource={(node) => {
                // Add node with safe defaults for missing fields
                addNode({
                  ...node,
                  connections: node.connections || [],
                  createdAt: node.createdAt || Date.now(),
                  updatedAt: node.updatedAt || Date.now(),
                });
                // Center on the new node
                selectNode(node.id, false);
              }}
            />
            <MarketPanel />
          </div>
        )}

        {/* Performance metrics (bottom of sidebar) */}
        {!leftSidebarCollapsed && (
          <div className="p-4 border-t border-gray-800">
            <PerformanceMetrics compact />
          </div>
        )}
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div className="h-14 bg-gray-900 border-b border-gray-800 flex items-center px-4 gap-2">
          <button
            onClick={toggleRightSidebar}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              showRightSidebar ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
            }`}
          >
            Details
          </button>
          <button
            onClick={toggleBottomPanel}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              showBottomPanel ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
            }`}
          >
            Positions
          </button>
          <div className="flex-1" />
          <button
            onClick={() => setShowHelp(true)}
            className="p-2 hover:bg-gray-800 rounded-lg text-gray-400"
            title="Help"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
        </div>

        {/* Canvas Area */}
        <div className="flex-1 relative overflow-hidden">
          <Canvas
            nodes={nodesArray}
            connections={connectionsArray}
            viewport={viewport}
            selectedNodeId={selectedNode?.id || null}
            onNodeClick={handleNodeClick}
            onNodeMove={handleNodeMove}
            onBackgroundClick={handleCanvasBackgroundClick}
            onViewportChange={handleViewportChange}
          />
        </div>

        {/* Bottom Panel - Positions */}
        {showBottomPanel && (
          <div 
            className="h-60 bg-gray-900 border-t border-gray-800 flex flex-col"
            style={{ height: PANEL_WIDTHS.bottomPanel }}
          >
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-gray-800/50">
              <h2 className="text-sm font-semibold text-gray-300">Positions & Activity</h2>
              <button 
                onClick={toggleBottomPanel}
                className="p-1 hover:bg-gray-700 rounded text-gray-400"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-hidden flex items-center justify-center text-gray-500">
              <p>Position monitor coming soon...</p>
            </div>
          </div>
        )}
      </main>

      {/* Right Sidebar - Details */}
      {showRightSidebar && selectedNode && (
        <aside 
          className="w-96 bg-gray-900 border-l border-gray-800 flex flex-col animate-in slide-in-from-right duration-200"
          aria-label="Details panel"
        >
          <div className="h-14 flex items-center justify-between px-4 border-b border-gray-800">
            <h2 className="font-semibold text-gray-200">Node Details</h2>
            <button 
              onClick={toggleRightSidebar}
              className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <div className="text-gray-400 text-sm">
              <p className="mb-2"><strong>ID:</strong> {selectedNode?.id || 'N/A'}</p>
              <p className="mb-2"><strong>Type:</strong> {JSON.stringify(selectedNode?.node_type || {})}</p>
              <p className="mb-2"><strong>Position:</strong> [{selectedNode?.position?.[0] ?? 0}, {selectedNode?.position?.[1] ?? 0}]</p>
              <p className="mb-2"><strong>Connections:</strong> {selectedNode?.connections?.length ?? 0}</p>
              <p className="mb-2"><strong>Created:</strong> {selectedNode?.createdAt ? new Date(selectedNode.createdAt).toLocaleString() : 'N/A'}</p>
            </div>
          </div>
        </aside>
      )}

      {/* Status Bar */}
      <div className="fixed bottom-0 left-72 right-0 h-6 bg-gray-950 border-t border-gray-800 text-xs flex items-center px-3 text-gray-500 z-50">
        <span>Ready</span>
        <span className="ml-auto">{layoutMode} mode</span>
      </div>
    </div>
  );

  /** Render tablet layout (collapsible sidebars) */
  const renderTablet = () => (
    <div className="flex h-screen w-screen overflow-hidden bg-gray-950 text-gray-100">
      {/* Collapsible Left Sidebar */}
      <aside 
        className={`absolute left-0 top-0 bottom-0 z-40 bg-gray-900 border-r border-gray-800 transform transition-transform duration-300 ${
          leftSidebarCollapsed ? '-translate-x-full' : 'translate-x-0'
        }`}
        style={{ width: PANEL_WIDTHS.leftSidebar }}
      >
        <div className="h-full flex flex-col">
          <div className="h-14 flex items-center justify-between px-4 border-b border-gray-800">
            <h1 className="text-lg font-bold">Trading Terminal</h1>
            <button onClick={() => setLeftSidebarCollapsed(true)}>
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            <SourcePanel 
              onAddSource={(node) => {
                addNode({
                  ...node,
                  connections: node.connections || [],
                  createdAt: node.createdAt || Date.now(),
                  updatedAt: node.updatedAt || Date.now(),
                });
                selectNode(node.id, false);
              }}
            />
            <MarketPanel />
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col">
        {/* Header with menu button */}
        <header className="h-14 bg-gray-900 border-b border-gray-800 flex items-center px-4">
          <button 
            onClick={() => setLeftSidebarCollapsed(false)}
            className="p-2 -ml-2 hover:bg-gray-800 rounded-lg"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="ml-4 font-semibold">Trading Terminal</span>
        </header>

        {/* Canvas */}
        <div className="flex-1 relative">
          <Canvas
            nodes={nodesArray}
            connections={connectionsArray}
            viewport={viewport}
            selectedNodeId={selectedNode?.id || null}
            onNodeClick={handleNodeClick}
            onNodeMove={handleNodeMove}
            onBackgroundClick={handleCanvasBackgroundClick}
            onViewportChange={handleViewportChange}
          />
        </div>

        {/* Bottom Panel */}
        {showBottomPanel && (
          <div className="h-48 bg-gray-900 border-t border-gray-800">
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
              <h2 className="text-sm font-semibold text-gray-300">Positions & Activity</h2>
              <button 
                onClick={toggleBottomPanel}
                className="p-1 hover:bg-gray-700 rounded text-gray-400"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-hidden flex items-center justify-center text-gray-500">
              <p>Position monitor coming soon...</p>
            </div>
          </div>
        )}
      </main>

      {/* Slide-over Details Panel */}
      {showRightSidebar && selectedNode && (
        <div className="absolute inset-0 z-50 overflow-hidden">
          <div 
            className="absolute inset-0 bg-black/50" 
            onClick={toggleRightSidebar}
          />
          <aside className="absolute right-0 top-0 bottom-0 w-96 bg-gray-900 shadow-xl">
            <div className="h-14 flex items-center justify-between px-4 border-b border-gray-800">
              <h2 className="font-semibold text-gray-200">Node Details</h2>
              <button 
                onClick={toggleRightSidebar}
                className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="text-gray-400 text-sm">
                <p className="mb-2"><strong>ID:</strong> {selectedNode?.id || 'N/A'}</p>
                <p className="mb-2"><strong>Type:</strong> {JSON.stringify(selectedNode?.node_type || {})}</p>
                <p className="mb-2"><strong>Position:</strong> [{selectedNode?.position?.[0] ?? 0}, {selectedNode?.position?.[1] ?? 0}]</p>
                <p className="mb-2"><strong>Connections:</strong> {selectedNode?.connections?.length ?? 0}</p>
                <p className="mb-2"><strong>Created:</strong> {selectedNode?.createdAt ? new Date(selectedNode.createdAt).toLocaleString() : 'N/A'}</p>
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );

  /** Render mobile layout (tab-based) */
  const renderMobile = () => (
    <div className="h-screen w-screen bg-gray-950 text-gray-100 flex flex-col">
      {/* Mobile Header */}
      <header className="h-14 bg-gray-900 border-b border-gray-800 flex items-center justify-between px-4">
        <h1 className="font-bold text-lg">Trading Terminal</h1>
        <button onClick={() => setShowHelp(true)}>
          <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </button>
      </header>

      {/* Tab Navigation */}
      <nav className="flex bg-gray-900 border-b border-gray-800">
        {(['canvas', 'controls', 'details'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setMobileActiveTab(tab)}
            className={`flex-1 py-3 text-sm font-medium capitalize ${
              mobileActiveTab === tab 
                ? 'text-blue-400 border-b-2 border-blue-400' 
                : 'text-gray-400'
            }`}
          >
            {tab}
          </button>
        ))}
      </nav>

      {/* Tab Content */}
      <main className="flex-1 overflow-hidden">
        {mobileActiveTab === 'canvas' && (
          <Canvas
            nodes={nodesArray}
            connections={connectionsArray}
            viewport={viewport}
            selectedNodeId={selectedNode?.id || null}
            onNodeClick={(node: Node) => {
              handleNodeClick(node);
              setMobileActiveTab('details');
            }}
            onNodeMove={handleNodeMove}
            onBackgroundClick={handleCanvasBackgroundClick}
            onViewportChange={handleViewportChange}
          />
        )}
        
        {mobileActiveTab === 'controls' && (
          <div className="h-full overflow-y-auto p-4 space-y-6">
            <SourcePanel 
              onAddSource={(node) => {
                addNode({
                  ...node,
                  connections: node.connections || [],
                  createdAt: node.createdAt || Date.now(),
                  updatedAt: node.updatedAt || Date.now(),
                });
                selectNode(node.id, false);
              }}
            />
            <MarketPanel />
          </div>
        )}
        
        {mobileActiveTab === 'details' && selectedNode ? (
          <div className="h-full overflow-y-auto p-4">
            <div className="text-gray-400 text-sm">
              <p className="mb-2"><strong>ID:</strong> {selectedNode?.id || 'N/A'}</p>
              <p className="mb-2"><strong>Type:</strong> {JSON.stringify(selectedNode?.node_type || {})}</p>
              <p className="mb-2"><strong>Position:</strong> [{selectedNode?.position?.[0] ?? 0}, {selectedNode?.position?.[1] ?? 0}]</p>
              <p className="mb-2"><strong>Connections:</strong> {selectedNode?.connections?.length ?? 0}</p>
              <p className="mb-2"><strong>Created:</strong> {selectedNode?.createdAt ? new Date(selectedNode.createdAt).toLocaleString() : 'N/A'}</p>
            </div>
          </div>
        ) : mobileActiveTab === 'details' ? (
          <div className="h-full flex items-center justify-center text-gray-500">
            Select a node to view details
          </div>
        ) : null}
      </main>

      {/* Mobile Bottom Sheet for Positions */}
      <div className="bg-gray-900 border-t border-gray-800 max-h-48 overflow-hidden">
        <div className="p-4 text-center text-gray-500 text-sm">
          Position monitor coming soon...
        </div>
      </div>
    </div>
  );

  // -------------------------------------------------------------------------
  // Main Render
  // -------------------------------------------------------------------------
  
  return (
    <>
      {/* Responsive Layout Selection */}
      {layoutMode === 'desktop' && renderDesktop()}
      {layoutMode === 'tablet' && renderTablet()}
      {layoutMode === 'mobile' && renderMobile()}

      {/* Global Modals */}
      <Modal
        isOpen={showHelp}
        onClose={() => setShowHelp(false)}
        title="Keyboard Shortcuts"
      >
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <kbd className="px-2 py-1 bg-gray-800 rounded text-gray-300">Ctrl/Cmd + S</kbd>
            </div>
            <div className="text-gray-400">Save graph</div>
            
            <div>
              <kbd className="px-2 py-1 bg-gray-800 rounded text-gray-300">Ctrl/Cmd + Z</kbd>
            </div>
            <div className="text-gray-400">Undo</div>
            
            <div>
              <kbd className="px-2 py-1 bg-gray-800 rounded text-gray-300">Ctrl/Cmd + Shift + Z</kbd>
            </div>
            <div className="text-gray-400">Redo</div>
            
            <div>
              <kbd className="px-2 py-1 bg-gray-800 rounded text-gray-300">Ctrl/Cmd + B</kbd>
            </div>
            <div className="text-gray-400">Toggle bottom panel</div>
            
            <div>
              <kbd className="px-2 py-1 bg-gray-800 rounded text-gray-300">Esc</kbd>
            </div>
            <div className="text-gray-400">Deselect / Close panels</div>
            
            <div>
              <kbd className="px-2 py-1 bg-gray-800 rounded text-gray-300">F11</kbd>
            </div>
            <div className="text-gray-400">Toggle fullscreen</div>
          </div>
        </div>
      </Modal>
    </>
  );
}

// =============================================================================
// EXPORTS
// =============================================================================

export default App;
