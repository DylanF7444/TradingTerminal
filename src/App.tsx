// ============================================================================
// MAIN APPLICATION COMPONENT
// ============================================================================
//
// Purpose: Root layout shell and global UI state for the trading terminal.
// Orchestrates panel visibility, selected nodes, and responsive layout.
//
// Extracted modules:
//   Components: Clock, ErrorBoundary, NodeDetailsPanel.extracted, RawStreamTab
//   Hooks:      useInfoSourceEvents (event listener + quality metrics)
//   Utilities:  nodeTransform, nodeHelpers, demoData
//
// Shared JSX fragments (computed once, used in desktop/tablet/mobile renderers):
//   controlPanels, canvasProps, detailPanelContent, bottomPanel
//
// ┌─────────────────┬──────────────────────────┬─────────────────┐
// │  Left Sidebar   │      Main Canvas         │  Right Sidebar  │
// │  (280px)        │      (flexible)          │  (384px)        │
// │  • SourcePanel  │      Node Graph          │  • Details tab  │
// │  • MarketPanel  │      Visualization       │  • Raw Stream   │
// │  • Metrics      │                          │  • Stored Data  │
// ├─────────────────┴──────────────────────────┴─────────────────┤
// │                    Bottom Panel (240px)                       │
// └──────────────────────────────────────────────────────────────┘
//
// KEYBOARD SHORTCUTS:
//   Ctrl/Cmd + S: Save graph
//   Ctrl/Cmd + Z / Shift+Z: Undo / Redo
//   Ctrl/Cmd + B: Toggle bottom panel
//   Ctrl/Cmd + /: Toggle help
//   Escape: Close panels / Deselect
//   C: Toggle connection mode
//   F11: Toggle fullscreen
// ============================================================================

import { useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';

// Store
import { useStore, type StoreState } from './store';

// Tauri
import { invoke } from '@tauri-apps/api/core';

// API utilities
import { removeNode as removeNodeFromDb, updateNodeSize, removeConnection as removeConnectionFromDb } from './utils/api';

// Extracted utilities
import { transformNodeFromBackend } from './utils/nodeTransform';
import { createDemoNodes } from './utils/demoData';

// Extracted hooks
import { useInfoSourceEvents, useNodeQualityMetrics, useMarketOrderbookEvents, useAutoMarketSubscriptions } from './hooks/useInfoSourceEvents';
import { usePersistentOrderbooks } from './hooks/usePersistentOrderbooks';

// Layout components
import Canvas from './components/Canvas/Canvas';
import SourcePanel from './components/InfoSources/SourcePanel';
import MarketPanel from './components/Markets/MarketPanel';
import AnalyzerPanel from './components/Analyzers/AnalyzerPanel';
import GlobalOrderbookOverlay from './components/Markets/GlobalOrderbookOverlay';
import PerformanceMetrics from './components/Metrics/PerformanceMetrics';
import ApiKeySettings from './components/Settings/ApiKeySettings';
import { RemoteAccessPanel } from './components/Remote/RemoteAccessPanel';
import { NodeDataPanel } from './components/Nodes/NodeDataPanel';

// Extracted components
import { Clock } from './components/UI/Clock';
import { NodeDetailsPanelExtracted as NodeDetailsPanel } from './components/Nodes/NodeDetailsPanel.extracted';
import { RawStreamTab } from './components/Nodes/RawStreamTab';
import { PanelErrorBoundary } from './components/UI/ErrorBoundary';

// UI components
import { Modal } from './components/UI/Modal';

// Types
import type { Node, NodeId } from './types/nodes';

// =============================================================================
// LAYOUT CONSTANTS
// =============================================================================

/** Default panel widths in pixels */
const PANEL_WIDTHS = {
  leftSidebar: 280,
  rightSidebar: 384,
  bottomPanel: 240,
};

/** Breakpoints for responsive behavior */
const BREAKPOINTS = {
  mobile: 768,
  tablet: 1024,
  desktop: 1400,
};

type LayoutMode = 'desktop' | 'tablet' | 'mobile';

// =============================================================================
// SHARED CALLBACK: ADD NODE FROM PANEL
// =============================================================================

/**
 * Creates a callback for handling nodes returned by SourcePanel or MarketPanel.
 * Eliminates the 4x duplication of this pattern across layout renderers.
 */
function useAddNodeCallback() {
  const addNode = useStore((state: StoreState) => state.addNode);
  const selectNode = useStore((state: StoreState) => state.selectNode);

  return useCallback(
    (result: any) => {
      const rawNode = result.node || result;
      const node = transformNodeFromBackend(rawNode);
      addNode(node);
      selectNode(node.id, false);
    },
    [addNode, selectNode],
  );
}

// =============================================================================
// MAIN APPLICATION COMPONENT
// =============================================================================

/**
 * Root application component managing layout and global UI state.
 */
function App(): ReactNode {
  // -------------------------------------------------------------------------
  // Global State Selectors
  // -------------------------------------------------------------------------

  const nodes = useStore((s: StoreState) => s.nodes);
  const connections = useStore((s: StoreState) => s.connections);
  const selectedIds = useStore((s: StoreState) => s.selectedIds);
  const selectNode = useStore((s: StoreState) => s.selectNode);
  const clearSelection = useStore((s: StoreState) => s.clearSelection);
  const viewport = useStore((s: StoreState) => s.viewport);
  const setViewport = useStore((s: StoreState) => s.setViewport);

  // -------------------------------------------------------------------------
  // Extracted Side-Effect Hooks
  // -------------------------------------------------------------------------

  useInfoSourceEvents();
  useNodeQualityMetrics();
  useMarketOrderbookEvents();
  useAutoMarketSubscriptions();
  usePersistentOrderbooks();

  // -------------------------------------------------------------------------
  // Shared add-node callback (eliminates duplication across layouts)
  // -------------------------------------------------------------------------

  const handleAddNode = useAddNodeCallback();

  // -------------------------------------------------------------------------
  // Load existing nodes on mount
  // -------------------------------------------------------------------------

  const createDemoNodesRef = useRef<() => Promise<void> | void>(createDemoNodes);

  useEffect(() => {
    let isMounted = true;

    const loadExistingNodes = async () => {
      try {
        const result = await invoke<any[]>('get_data_sources_cmd');
        if (!isMounted) return;

        const storeState = useStore.getState();
        const { addNode, addConnection, nodes: existingNodes } = storeState;

        // Skip if nodes already exist (prevents duplicates from React StrictMode)
        if (Object.keys(existingNodes).length > 0) {
          console.log('Nodes already loaded, skipping...');
          return;
        }

        if (result?.length) {
          result.forEach((node) => addNode(transformNodeFromBackend(node)));
          console.log(
            'Node coordinates on startup:',
            result.map((n) => {
              const t = transformNodeFromBackend(n);
              return { id: t.id, position: t.position, type: t.node_type };
            }),
          );
          console.log(`Loaded ${result.length} existing nodes from backend`);
          
          // Load connections from backend
          try {
            const connections = await invoke<any[]>('get_all_connections_cmd');
            if (!isMounted) return;
            if (connections?.length) {
              connections.forEach((conn) => {
                addConnection({
                  source: conn.source as NodeId,
                  target: conn.target as NodeId,
                  strength: conn.strength ?? 0.5,
                });
              });
              console.log(`Loaded ${connections.length} connections from backend`);
            }
          } catch (connError) {
            console.error('Failed to load connections:', connError);
          }
        } else {
          console.log('No existing nodes found, creating demo nodes...');
          createDemoNodesRef.current();
        }
      } catch (error) {
        console.error('Failed to load existing nodes:', error);
        if (isMounted) createDemoNodesRef.current();
      }
    };

    loadExistingNodes();
    return () => {
      isMounted = false;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Local UI State
  // -------------------------------------------------------------------------

  const [showRightSidebar, setShowRightSidebar] = useState(true);
  const [showBottomPanel, setShowBottomPanel] = useState(true);
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [mobileActiveTab, setMobileActiveTab] = useState<'canvas' | 'controls' | 'details'>('canvas');
  const [showHelp, setShowHelp] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [orderbookOverlay, setOrderbookOverlay] = useState<{
    marketId: string;
    platform: 'polymarket' | 'kalshi';
    marketQuestion?: string;
    tokenIds?: string[];
  } | null>(null);
  const [detailPanelTab, setDetailPanelTab] = useState<'details' | 'raw-stream' | 'stored-data'>('details');
  const [connectionMode, setConnectionMode] = useState(false);
  const [windowSize, setWindowSize] = useState(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 1200,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
  }));

  // -------------------------------------------------------------------------
  // Derived State
  // -------------------------------------------------------------------------

  const selectedNode = useMemo(() => {
    if (selectedIds.size !== 1) return null;
    const selectedId = Array.from(selectedIds)[0];
    return nodes[selectedId] || null;
  }, [selectedIds, nodes]);

  const nodesArray = useMemo(
    () => Object.values(nodes).filter((node) => node?.id),
    [nodes],
  );

  const connectionsArray = useMemo(() => connections, [connections]);

  const layoutMode: LayoutMode = useMemo(() => {
    if (windowSize.width < BREAKPOINTS.mobile) return 'mobile';
    if (windowSize.width < BREAKPOINTS.tablet) return 'tablet';
    return 'desktop';
  }, [windowSize.width]);

  // -------------------------------------------------------------------------
  // Event Handlers
  // -------------------------------------------------------------------------

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        setWindowSize({ width: window.innerWidth, height: window.innerHeight });
      }, 100);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 's': e.preventDefault(); break;
          case 'z':
            e.preventDefault();
            // Undo/Redo placeholder
            break;
          case 'b': e.preventDefault(); setShowBottomPanel((p) => !p); break;
          case '/': e.preventDefault(); setShowHelp(true); break;
        }
        return;
      }
      if (e.key === 'Escape') {
        if (showHelp) setShowHelp(false);
        else if (connectionMode) setConnectionMode(false);
        else if (selectedIds.size > 0) clearSelection();
        else if (showRightSidebar) setShowRightSidebar(false);
      }
      if (e.key === 'c' && !e.ctrlKey && !e.metaKey) {
        const el = document.activeElement;
        const isEditing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable);
        if (!isEditing) { e.preventDefault(); setConnectionMode((p) => !p); }
      }
      if (e.key === 'F11') {
        e.preventDefault();
        document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds.size, showHelp, showRightSidebar, clearSelection, connectionMode]);

  const handleNodeClick = useCallback((node: Node) => {
    selectNode(node.id, false);
    setShowRightSidebar(true);
  }, [selectNode]);

  const handleNodeMove = useCallback((id: string, position: [number, number]) => {
    useStore.getState().updateNodePosition(id, position);
  }, []);

  const handleNodeResize = useCallback((id: string, size: { width: number; height: number | null }) => {
    useStore.getState().updateNodeSize(id, size);
    updateNodeSize(id, size).catch((err: unknown) => console.error('Failed to persist node size:', err));
  }, []);

  const handleNodeDelete = useCallback(async (id: string) => {
    useStore.getState().removeNode(id);
    try {
      const result = await removeNodeFromDb(id);
      if (!result.ok) console.error('Failed to delete node from database:', result.error);
    } catch (error) {
      console.error('Error deleting node from database:', error);
    }
  }, []);

  const handleCanvasBackgroundClick = useCallback(() => clearSelection(), [clearSelection]);

  const handleViewportChange = useCallback(
    (v: { x: number; y: number; zoom: number }) => setViewport(v),
    [setViewport],
  );

  const handleOpenOrderbook = useCallback(
    (marketId: string, platform: 'polymarket' | 'kalshi', marketQuestion?: string, tokenIds?: string[]) => {
      setOrderbookOverlay({ marketId, platform, marketQuestion, tokenIds });
    },
    [],
  );

  const handleCloseOrderbook = useCallback(() => setOrderbookOverlay(null), []);

  const handleCreateConnection = useCallback((sourceId: string, targetId: string) => {
    const { addConnection, connections: conns } = useStore.getState();
    if (conns.some((c) => c.source === sourceId && c.target === targetId)) {
      console.warn('Connection already exists');
      return;
    }
    if (sourceId === targetId) {
      console.warn('Cannot connect node to itself');
      return;
    }
    addConnection({ source: sourceId as NodeId, target: targetId as NodeId, strength: 0.8 });
    console.log(`[Connection] Created connection from ${sourceId} to ${targetId}`);
    
    // Persist to backend
    invoke('add_connection_cmd', { source: sourceId, target: targetId, strength: 0.8 })
      .catch((err: unknown) => console.error('Failed to persist connection:', err));
    
    setConnectionMode(false);
  }, []);

  const handleConnectionDelete = useCallback(async (source: string, target: string) => {
    const { removeConnection } = useStore.getState();
    removeConnection(source, target);
    console.log(`[Connection] Deleted connection from ${source} to ${target}`);
    
    // Persist deletion to backend
    try {
      const result = await removeConnectionFromDb(source, target);
      if (!result.ok) {
        console.error('Failed to delete connection from database:', result.error);
      }
    } catch (err) {
      console.error('Error deleting connection from database:', err);
    }
  }, []);

  const toggleRightSidebar = useCallback(() => setShowRightSidebar((p) => !p), []);
  const toggleBottomPanel = useCallback(() => setShowBottomPanel((p) => !p), []);

  // -------------------------------------------------------------------------
  // Shared Canvas Props (eliminates duplication across 3 layouts)
  // -------------------------------------------------------------------------

  const canvasProps = useMemo(
    () => ({
      nodes: nodesArray,
      connections: connectionsArray,
      viewport,
      selectedNodeId: selectedNode?.id || null,
      onNodeClick: handleNodeClick,
      onNodeMove: handleNodeMove,
      onNodeDelete: handleNodeDelete,
      onBackgroundClick: handleCanvasBackgroundClick,
      onViewportChange: handleViewportChange,
      onOpenOrderbook: handleOpenOrderbook,
      onNodeResize: handleNodeResize,
      connectionMode,
      onCreateConnection: handleCreateConnection,
      onConnectionDelete: handleConnectionDelete,
    }),
    [
      nodesArray, connectionsArray, viewport, selectedNode?.id,
      handleNodeClick, handleNodeMove, handleNodeDelete,
      handleCanvasBackgroundClick, handleViewportChange,
      handleOpenOrderbook, handleNodeResize, connectionMode,
      handleCreateConnection, handleConnectionDelete,
    ],
  );

  // -------------------------------------------------------------------------
  // Shared Sub-Components (used across layouts)
  // -------------------------------------------------------------------------

  const infoSources = useMemo(
    () => Object.values(nodes).filter((node) => node?.node_type && 'InfoSource' in node.node_type),
    [nodes],
  );

  const markets = useMemo(
    () => Object.values(nodes).filter((node) => node?.node_type && 'Market' in node.node_type),
    [nodes],
  );

  const analyzers = useMemo(
    () => Object.values(nodes).filter((node) => node?.node_type && 'Analyzer' in node.node_type),
    [nodes],
  );

  /** Source/Market panels — shared between all 3 layouts */
  const controlPanels = (
    <>
      <PanelErrorBoundary panelName="Source Panel">
        <SourcePanel onAddSource={handleAddNode} existingSources={infoSources} />
      </PanelErrorBoundary>
      <PanelErrorBoundary panelName="Market Panel">
        <MarketPanel onAddMarket={handleAddNode} existingMarkets={markets} />
      </PanelErrorBoundary>
      <PanelErrorBoundary panelName="Analyzer Panel">
        <AnalyzerPanel onAddAnalyzer={handleAddNode} existingAnalyzers={analyzers} />
      </PanelErrorBoundary>
    </>
  );

  /** Node detail tabs + content — shared between desktop and mobile */
  const detailPanelContent = selectedNode ? (
    <>
      {/* Tab Navigation */}
      <div className="flex border-b border-gray-800">
        {(['details', 'raw-stream', 'stored-data'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setDetailPanelTab(tab)}
            className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
              detailPanelTab === tab
                ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-800/50'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/30'
            }`}
          >
            {tab === 'details' ? 'Details' : tab === 'raw-stream' ? 'Raw Stream' : 'Stored Data'}
          </button>
        ))}
      </div>
      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-4">
        <PanelErrorBoundary panelName="Node Details">
          {detailPanelTab === 'details' ? (
            <NodeDetailsPanel node={selectedNode} connections={connections} nodes={nodes} />
          ) : detailPanelTab === 'raw-stream' ? (
            <RawStreamTab nodeId={selectedNode.id} />
          ) : (
            <NodeDataPanel
              nodeId={selectedNode.id}
              nodeType={selectedNode.node_type && 'InfoSource' in selectedNode.node_type ? 'InfoSource' : 'Market'}
            />
          )}
        </PanelErrorBoundary>
      </div>
    </>
  ) : null;

  /** Bottom panel — shared between desktop and tablet */
  const bottomPanel = showBottomPanel ? (
    <div className="bg-gray-900 border-t border-gray-800 flex flex-col" style={{ height: PANEL_WIDTHS.bottomPanel }}>
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-gray-800/50">
        <h2 className="text-sm font-semibold text-gray-300">Positions & Activity</h2>
        <button onClick={toggleBottomPanel} className="p-1 hover:bg-gray-700 rounded text-gray-400">
          <ChevronDownIcon />
        </button>
      </div>
      <div className="flex-1 overflow-hidden flex items-center justify-center text-gray-500">
        <p>Position monitor coming soon...</p>
      </div>
    </div>
  ) : null;

  /** Connection mode indicator */
  const connectionModeIndicator = connectionMode ? (
    <span className="text-xs text-yellow-400 animate-pulse">
      Click source node, then target node &bull; ESC to cancel
    </span>
  ) : null;

  // -------------------------------------------------------------------------
  // Layout Renderers
  // -------------------------------------------------------------------------

  const renderDesktop = () => (
    <div className="flex h-screen w-screen overflow-hidden bg-gray-950 text-gray-100">
      {/* Left Sidebar */}
      <aside
        className={`flex-shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col transition-all duration-300 ${
          leftSidebarCollapsed ? 'w-16' : 'w-72'
        }`}
        aria-label="Control panel"
      >
        <div className="flex flex-col border-b border-gray-800">
          {!leftSidebarCollapsed && (
            <div className="px-4 py-2 text-center border-b border-gray-800/50 bg-gray-800/30">
              <Clock />
            </div>
          )}
          <div className="h-14 flex items-center px-4">
            {leftSidebarCollapsed ? (
              <button onClick={() => setLeftSidebarCollapsed(false)} className="p-2 hover:bg-gray-800 rounded-lg" title="Expand sidebar">
                <ExpandIcon />
              </button>
            ) : (
              <div className="flex items-center justify-between w-full">
                <h1 className="text-lg font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
                  Trading Terminal
                </h1>
                <button onClick={() => setLeftSidebarCollapsed(true)} className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400" title="Collapse sidebar">
                  <CollapseIcon />
                </button>
              </div>
            )}
          </div>
        </div>
        {!leftSidebarCollapsed && (
          <div className="flex-1 overflow-y-auto p-4 space-y-6">{controlPanels}</div>
        )}
        {!leftSidebarCollapsed && (
          <div className="p-4 border-t border-gray-800">
            <PerformanceMetrics compact />
          </div>
        )}
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0">
        <Toolbar
          showRightSidebar={showRightSidebar}
          showBottomPanel={showBottomPanel}
          connectionMode={connectionMode}
          connectionModeIndicator={connectionModeIndicator}
          onToggleRightSidebar={toggleRightSidebar}
          onToggleBottomPanel={toggleBottomPanel}
          onToggleConnectionMode={() => setConnectionMode((p) => !p)}
          onOpenSettings={() => setShowSettings(true)}
          onOpenHelp={() => setShowHelp(true)}
        />
        <div className="flex-1 relative overflow-hidden">
          <PanelErrorBoundary panelName="Canvas">
            <Canvas {...canvasProps} />
          </PanelErrorBoundary>
        </div>
        {bottomPanel}
      </main>

      {/* Right Sidebar */}
      {showRightSidebar && selectedNode && (
        <aside className="w-96 bg-gray-900 border-l border-gray-800 flex flex-col animate-in slide-in-from-right duration-200" aria-label="Details panel">
          <div className="h-14 flex items-center justify-between px-4 border-b border-gray-800">
            <h2 className="font-semibold text-gray-200">Node Details</h2>
            <button onClick={toggleRightSidebar} className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400">
              <CloseIcon />
            </button>
          </div>
          {detailPanelContent}
        </aside>
      )}

      {/* Status Bar */}
      <div className="fixed bottom-0 left-72 right-0 h-6 bg-gray-950 border-t border-gray-800 text-xs flex items-center px-3 text-gray-500 z-50">
        <span>Ready</span>
        <span className="ml-auto">{layoutMode} mode</span>
      </div>

      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
      {orderbookOverlay && (
        <GlobalOrderbookOverlay
          marketId={orderbookOverlay.marketId}
          platform={orderbookOverlay.platform}
          marketQuestion={orderbookOverlay.marketQuestion}
          tokenIds={orderbookOverlay.tokenIds}
          onClose={handleCloseOrderbook}
        />
      )}
    </div>
  );

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
              <CloseIcon />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-6">{controlPanels}</div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col">
        <header className="h-14 bg-gray-900 border-b border-gray-800 flex items-center px-4">
          <button onClick={() => setLeftSidebarCollapsed(false)} className="p-2 -ml-2 hover:bg-gray-800 rounded-lg">
            <HamburgerIcon />
          </button>
          <span className="ml-4 font-semibold">Trading Terminal</span>
        </header>
        <div className="flex-1 relative">
          <PanelErrorBoundary panelName="Canvas">
            <Canvas {...canvasProps} />
          </PanelErrorBoundary>
        </div>
        {bottomPanel}
      </main>

      {/* Slide-over Details */}
      {showRightSidebar && selectedNode && (
        <div className="absolute inset-0 z-50 overflow-hidden">
          <div className="absolute inset-0 bg-black/50" onClick={toggleRightSidebar} />
          <aside className="absolute right-0 top-0 bottom-0 w-96 bg-gray-900 shadow-xl flex flex-col">
            <div className="h-14 flex items-center justify-between px-4 border-b border-gray-800">
              <h2 className="font-semibold text-gray-200">Node Details</h2>
              <button onClick={toggleRightSidebar} className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400">
                <CloseIcon />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <PanelErrorBoundary panelName="Node Details">
                <NodeDetailsPanel node={selectedNode} connections={connections} nodes={nodes} />
              </PanelErrorBoundary>
            </div>
          </aside>
        </div>
      )}
    </div>
  );

  const renderMobile = () => (
    <div className="h-screen w-screen bg-gray-950 text-gray-100 flex flex-col">
      <header className="h-14 bg-gray-900 border-b border-gray-800 flex items-center justify-between px-4">
        <h1 className="font-bold text-lg">Trading Terminal</h1>
        <button onClick={() => setShowHelp(true)}>
          <HelpIcon />
        </button>
      </header>

      <nav className="flex bg-gray-900 border-b border-gray-800">
        {(['canvas', 'controls', 'details'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setMobileActiveTab(tab)}
            className={`flex-1 py-3 text-sm font-medium capitalize ${
              mobileActiveTab === tab ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-400'
            }`}
          >
            {tab}
          </button>
        ))}
      </nav>

      <main className="flex-1 overflow-hidden">
        {mobileActiveTab === 'canvas' && (
          <PanelErrorBoundary panelName="Canvas">
            <Canvas
              {...canvasProps}
              onNodeClick={(node: Node) => {
                handleNodeClick(node);
                setMobileActiveTab('details');
              }}
            />
          </PanelErrorBoundary>
        )}
        {mobileActiveTab === 'controls' && (
          <div className="h-full overflow-y-auto p-4 space-y-6">{controlPanels}</div>
        )}
        {mobileActiveTab === 'details' && selectedNode ? (
          <div className="h-full overflow-y-auto p-4">
            <PanelErrorBoundary panelName="Node Details">
              <NodeDetailsPanel node={selectedNode} connections={connections} nodes={nodes} />
            </PanelErrorBoundary>
          </div>
        ) : mobileActiveTab === 'details' ? (
          <div className="h-full flex items-center justify-center text-gray-500">
            Select a node to view details
          </div>
        ) : null}
      </main>

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
      {layoutMode === 'desktop' && renderDesktop()}
      {layoutMode === 'tablet' && renderTablet()}
      {layoutMode === 'mobile' && renderMobile()}

      <Modal isOpen={showHelp} onClose={() => setShowHelp(false)} title="Keyboard Shortcuts">
        <KeyboardShortcutsContent />
      </Modal>
    </>
  );
}

// =============================================================================
// EXTRACTED SUB-COMPONENTS (private to this module)
// =============================================================================

/** Toolbar displayed at the top of the main content area (desktop layout). */
function Toolbar({
  showRightSidebar,
  showBottomPanel,
  connectionMode,
  connectionModeIndicator,
  onToggleRightSidebar,
  onToggleBottomPanel,
  onToggleConnectionMode,
  onOpenSettings,
  onOpenHelp,
}: {
  showRightSidebar: boolean;
  showBottomPanel: boolean;
  connectionMode: boolean;
  connectionModeIndicator: ReactNode;
  onToggleRightSidebar: () => void;
  onToggleBottomPanel: () => void;
  onToggleConnectionMode: () => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
}) {
  const btnClass = (active: boolean) =>
    `px-3 py-1.5 rounded text-sm font-medium transition-colors ${
      active ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
    }`;

  return (
    <div className="h-14 bg-gray-900 border-b border-gray-800 flex items-center px-4 gap-2">
      <button onClick={onToggleRightSidebar} className={btnClass(showRightSidebar)}>Details</button>
      <button onClick={onToggleBottomPanel} className={btnClass(showBottomPanel)}>Positions</button>
      <button
        onClick={onToggleConnectionMode}
        className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
          connectionMode ? 'bg-yellow-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
        }`}
        title="Connect nodes (Press C)"
      >
        Connect
      </button>
      {connectionModeIndicator}
      <div className="flex-1" />
      <button onClick={onOpenSettings} className="p-2 hover:bg-gray-800 rounded-lg text-gray-400" title="Settings">
        <SettingsIcon />
      </button>
      <button onClick={onOpenHelp} className="p-2 hover:bg-gray-800 rounded-lg text-gray-400" title="Help">
        <HelpIcon />
      </button>
    </div>
  );
}

/** Settings modal wrapping ApiKeySettings. */
function SettingsModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 rounded-xl border border-gray-800 shadow-2xl w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Settings</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <CloseIcon />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <ApiKeySettings />
          <div className="mt-6 pt-6 border-t border-gray-800">
            <RemoteAccessPanel />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Keyboard shortcuts content for the help modal. */
function KeyboardShortcutsContent() {
  const shortcuts = [
    ['Ctrl/Cmd + S', 'Save graph'],
    ['Ctrl/Cmd + Z', 'Undo'],
    ['Ctrl/Cmd + Shift + Z', 'Redo'],
    ['Ctrl/Cmd + B', 'Toggle bottom panel'],
    ['Esc', 'Deselect / Close panels'],
    ['F11', 'Toggle fullscreen'],
  ];
  return (
    <div className="space-y-4 text-sm">
      <div className="grid grid-cols-2 gap-4">
        {shortcuts.map(([key, desc]) => (
          <div key={key} className="contents">
            <div><kbd className="px-2 py-1 bg-gray-800 rounded text-gray-300">{key}</kbd></div>
            <div className="text-gray-400">{desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// SVG ICON COMPONENTS (extracted to eliminate inline SVG duplication)
// =============================================================================

function CloseIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
    </svg>
  );
}

function HamburgerIcon() {
  return (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

// =============================================================================
// EXPORTS
// =============================================================================

export default App;
