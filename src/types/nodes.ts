// ============================================================================
// NODE GRAPH TYPE DEFINITIONS
// ============================================================================
//
// Purpose: Core TypeScript interfaces for the prediction market node graph system.
// Defines the type system for the visual node graph connecting information
// sources to prediction markets (Polymarket, Kalshi).
//
// Architecture: Heterogeneous graph with discriminated node types.
//   Node = InfoSourceNode | MarketNode | ...
//   NodeType determines behavior, visualization, and valid connections.
//   Connections carry correlation strength metadata for visual weight.
//
// Graph Topology (DAG, sources → markets):
//
//   CryptoPricesNode → AnalyzerNode → PolymarketNode
//        ↓                ↓
//   NewsSourceNode  → SentimentNode → KalshiNode
//
// Rust Backend Mapping (src-tauri/src/models/node.rs):
//   - NodeType enum variants map exactly to TypeScript enums
//   - Position [f64, f64] ↔ [number, number]
//   - Connections Vec<String> ↔ string[]
//   - serde_json::Value ↔ Record<string, any>
//
// ============================================================================

// =============================================================================
// NODE TYPE ENUMERATIONS
// =============================================================================

/**
 * Types of information sources that feed data into the graph.
 * 
 * Each variant represents a distinct data category with its own
 * scraping logic, update frequency, and correlation patterns.
 * 
 * Backend Mapping: src-tauri/src/models/node.rs InfoSourceType enum
 */
export enum InfoSourceType {
  /** Cryptocurrency price feeds (BTC, ETH, etc.) */
  CryptoPrices = 'CryptoPrices',
  
  /** Traditional financial markets (stocks, forex, commodities) */
  FinancialPrices = 'FinancialPrices',
  
  /** Physical commodity prices (oil, gold, agricultural) */
  CommodityPrices = 'CommodityPrices',
  
  /** News aggregators and RSS feeds */
  NewsSource = 'NewsSource',
  
  /** Social media sentiment (Twitter/X, Reddit) */
  SocialMedia = 'SocialMedia',
  
  /** Weather data and forecasts */
  Weather = 'Weather',
  
  /** Live streaming data (YouTube, Twitch metrics) */
  Livestream = 'Livestream',
  
  /** Economic indicators (CPI, unemployment, GDP) */
  EconomicIndicators = 'EconomicIndicators',
  
  /** On-chain metrics (transaction volume, gas fees) */
  OnChainData = 'OnChainData',
  
  /** Custom API endpoint (user-defined) */
  CustomAPI = 'CustomAPI',
}

/**
 * Prediction market exchanges where trades are executed.
 * 
 * Each market type has distinct APIs, fee structures, and
 * available markets. The node graph can connect to multiple
 * markets simultaneously for arbitrage strategies.
 * 
 * Backend Mapping: src-tauri/src/models/node.rs MarketType enum
 */
export enum MarketType {
  /** Polymarket - Crypto prediction markets on Polygon */
  Polymarket = 'Polymarket',
  
  /** Kalshi - Regulated US event contracts */
  Kalshi = 'Kalshi',
  
  /** Future: Betfair exchange */
  // Betfair = 'Betfair',
  
  /** Future: PredictIt political markets */
  // PredictIt = 'PredictIt',
  
  /** Future: Smarkets */
  // Smarkets = 'Smarkets',
  
  /** Future: Augur decentralized markets */
  // Augur = 'Augur',
}

/**
 * Discriminated union for node classification.
 * 
 * Used to determine node behavior, visualization, and
 * valid connection patterns. The tagged union structure
 * enables type-safe narrowing in switch statements.
 * 
 * Example:
 *   if ('InfoSource' in node.node_type) {
 *     // TypeScript narrows to InfoSourceType
 *     const sourceType = node.node_type.InfoSource;
 *   }
 */
export type NodeType =
  | { InfoSource: InfoSourceType }
  | { Market: MarketType }
  | { Analyzer: AnalyzerType }
  | { Alert: AlertType };

/**
 * Future: Analysis node types for custom indicators.
 */
export enum AnalyzerType {
  /** Correlation calculator between sources */
  Correlation = 'Correlation',
  
  /** EMA-based momentum detection */
  Momentum = 'Momentum',
  
  /** Sentiment analyzer */
  Sentiment = 'Sentiment',
  
  /** Arbitrage detector */
  Arbitrage = 'Arbitrage',
  
  /** Relative Strength Index (RSI) */
  RSI = 'RSI',
  
  /** Price volatility measurement */
  Volatility = 'Volatility',
  
  /** Custom formula/expression */
  Custom = 'Custom',
}

/**
 * Future: Alert node types for notifications.
 */
export enum AlertType {
  /** Price threshold alert */
  PriceThreshold = 'PriceThreshold',
  
  /** Correlation change alert */
  CorrelationChange = 'CorrelationChange',
  
  /** Webhook notification */
  Webhook = 'Webhook',
  
  /** Desktop notification */
  Desktop = 'Desktop',
}

// =============================================================================
// CORE NODE INTERFACE
// =============================================================================

/**
 * Unique identifier type for nodes.
 * 
 * Using branded type pattern for type safety - prevents
 * accidental mixing with other string IDs (market IDs, order IDs).
 */
export type NodeId = string & { __brand: 'NodeId' };

/**
 * Spatial coordinates in the infinite canvas.
 * 
 * Uses tuple instead of object for compact serialization
 * and to match Rust's (f64, f64) tuple type.
 * 
 * Coordinate System:
 *   - Origin (0, 0) is center of initial viewport
 *   - X increases rightward, Y increases downward
 *   - Units are abstract (pixels at zoom = 1)
 *   - No bounds (infinite canvas)
 */
export type Position = [number, number];

/**
 * Node size dimensions for resizable nodes.
 * Allows nodes to be scaled like windows.
 */
export interface NodeSize {
  /** Width in pixels (default: 192 = w-48) */
  width: number;
  /** Height in pixels (auto-calculated if not set) */
  height: number | null;
}

/**
 * Base node interface - all nodes share this structure.
 * 
 * The node graph is heterogeneous - nodes have different behaviors
 * based on node_type, but share common spatial and connection properties.
 * 
 * Backend Mapping: src-tauri/src/models/node.rs Node struct
 */
export interface Node {
  /** Unique node identifier (UUID v4) */
  id: NodeId;
  
  /** Discriminated node type determining behavior */
  node_type: NodeType;
  
  /** Spatial position on the canvas [x, y] */
  position: Position;
  
  /** IDs of connected target nodes (outgoing edges) */
  connections: NodeId[];
  
  /** 
   * Type-specific configuration and runtime data.
   * 
   * Structure varies by node_type:
   *   - InfoSource: { symbols: string[], interval: number, apiKey?: string }
   *   - Market: { marketId: string, apiKey: string, autoTrade: boolean }
   *   - Analyzer: { formula: string, inputs: string[] }
   * 
   * Stored as flexible Record for extensibility while
   * maintaining type safety through validation functions.
   */
  metadata: NodeMetadata;
  
  /** Display name (user-editable, defaults to type name) */
  name?: string;
  
  /** Visual state flags */
  visualState?: NodeVisualState;
  
  /** Node size for resizable nodes (like windows) */
  size?: NodeSize;
  
  /** Creation timestamp */
  createdAt: number;
  
  /** Last update timestamp */
  updatedAt: number;
}

/**
 * Node metadata variants by type.
 * Uses discriminated union for type-safe access.
 */
export type NodeMetadata =
  | InfoSourceMetadata
  | MarketMetadata
  | AnalyzerMetadata
  | AlertMetadata
  | Record<string, any>; // Fallback for extensibility

/**
 * Visual state for UI rendering (animations, highlights).
 */
export interface NodeVisualState {
  /** Currently selected */
  selected?: boolean;
  
  /** Currently being dragged */
  dragging?: boolean;
  
  /** Has unread updates (pulse animation) */
  hasUpdate?: boolean;
  
  /** Error state (red border) */
  error?: boolean;
  
  /** Loading state (spinner) */
  loading?: boolean;
  
  /** Highlight color override */
  highlightColor?: string;
  
  /** Expanded/collapsed state for composite nodes */
  expanded?: boolean;
}

// =============================================================================
// SPECIALIZED NODE METADATA
// =============================================================================

/**
 * Configuration for information source nodes.
 */
export interface InfoSourceMetadata {
  /** 
   * Data source-specific identifiers.
   * 
   * Crypto: ["BTC", "ETH", "SOL"]
   * News: ["cnn", "reuters", "bloomberg"]
   * Weather: ["nyc", "london", "tokyo"]
   */
  symbols: string[];
  
  /** Update interval in seconds */
  updateInterval: number;
  
  /** API key for authenticated sources (encrypted in backend) */
  apiKey?: string;
  
  /** API endpoint override (for CustomAPI type) */
  endpoint?: string;
  
  /** Data transformation/filtering options */
  filter?: {
    /** Minimum confidence threshold (0-1) */
    minConfidence?: number;
    
    /** Keyword filters for text sources */
    keywords?: string[];
    
    /** Time window for historical data (seconds) */
    lookbackWindow?: number;
  };
  
  /** Last received data snapshot (populated at runtime) */
  lastData?: {
    timestamp: number;
    value: number | string | Record<string, any>;
    raw?: any; // Original API response
  };
  
  /** Data quality metrics */
  quality?: {
    /** Success rate of last 100 fetches (0-1) */
    successRate: number;
    
    /** Average latency in milliseconds */
    avgLatency: number;
    
    /** Last error message if failed */
    lastError?: string;
  };
}

/**
 * Configuration for prediction market nodes.
 */
export interface MarketMetadata {
  /** Exchange-specific market identifier */
  marketId: string;
  
  /** Market question/title (cached from exchange) */
  question?: string;
  
  /** API credentials (stored securely in backend) */
  credentials?: {
    apiKey: string;
    apiSecret?: string;
    passphrase?: string;
  };
  
  /** Trading configuration */
  trading?: {
    /** Enable automated trading from this node */
    autoTrade: boolean;
    
    /** Maximum position size in contracts */
    maxPositionSize: number;
    
    /** Default order type */
    defaultOrderType: 'market' | 'limit';
    
    /** Slippage tolerance for market orders (0.01 = 1%) */
    slippageTolerance: number;
  };
  
  /** Risk management settings */
  risk?: {
    /** Daily loss limit (0 to disable) */
    dailyLossLimit: number;
    
    /** Maximum open positions per market */
    maxPositions: number;
    
    /** Require manual confirmation for trades over size */
    confirmThreshold: number;
  };
  
  /** Linked position IDs (populated at runtime) */
  openPositionIds?: string[];
  
  /** Current market state (synced from marketsSlice) */
  marketState?: {
    status: 'open' | 'closed' | 'suspended';
    bestBid: number;
    bestAsk: number;
    lastPrice: number;
    volume24h: number;
  };
}

/**
 * Configuration for analyzer nodes (future feature).
 */
export interface AnalyzerMetadata {
  /** Analysis type */
  analyzerType: AnalyzerType;
  
  /** Input node IDs (sources for calculation) */
  inputs: NodeId[];
  
  /** 
   * Analysis formula/expression.
   * 
   * Examples:
   *   - "correlation(input0, input1, 24h)"
   *   - "ma(input0, 20)"
   *   - "sentiment(input0) > 0.7"
   */
  formula: string;
  
  /** Output configuration */
  output?: {
    /** Update frequency (seconds) */
    interval: number;
    
    /** Threshold for triggering alerts */
    threshold?: number;
    
    /** Historical values for charting */
    history: Array<{ timestamp: number; value: number }>;
  };
}

/**
 * Configuration for alert nodes (future feature).
 */
export interface AlertMetadata {
  /** Alert type */
  alertType: AlertType;
  
  /** Condition configuration */
  condition: {
    /** Source node to monitor */
    sourceId: NodeId;
    
    /** Comparison operator */
    operator: 'gt' | 'lt' | 'eq' | 'change' | 'pct_change';
    
    /** Threshold value */
    threshold: number;
    
    /** Duration condition must hold (seconds) */
    duration?: number;
  };
  
  /** Notification channels */
  actions: Array<{
    type: 'notification' | 'webhook' | 'email' | 'trade';
    config: Record<string, any>;
  }>;
  
  /** Alert state */
  state?: {
    /** Currently triggered */
    triggered: boolean;
    
    /** Last trigger timestamp */
    lastTriggered?: number;
    
    /** Trigger count (for rate limiting) */
    triggerCount: number;
  };
}

// =============================================================================
// CONNECTION TYPES
// =============================================================================

/**
 * Directed edge between two nodes.
 * 
 * Connections represent data flow and correlation relationships.
 * Strength indicates correlation/confidence level (0.0-1.0).
 * 
 * Backend Mapping: src-tauri/src/models/node.rs connections field
 */
export interface Connection {
  /** Source node ID (data producer) */
  source: NodeId;
  
  /** Target node ID (data consumer) */
  target: NodeId;
  
  /** 
   * Connection strength/correlation (0.0 - 1.0).
   * 
   * Visual representation:
   *   - 0.0-0.3: Weak (thin, transparent line)
   *   - 0.3-0.7: Moderate (medium line)
   *   - 0.7-1.0: Strong (thick, glowing line)
   * 
   * Semantic meaning varies by connection type:
   *   - InfoSource→Market: Historical price correlation
   *   - InfoSource→Analyzer: Input weight/importance
   *   - Analyzer→Market: Signal confidence
   */
  strength: number;
  
  /** 
   * Connection type determines data flow semantics.
   */
  type?: ConnectionType;
  
  /** Last calculated/calibrated timestamp */
  lastUpdated?: number;
  
  /** Lag time in seconds (source leads target by this amount) */
  lag?: number;
  
  /** Statistical significance (p-value) */
  significance?: number;
}

/**
 * Types of semantic connections.
 */
export enum ConnectionType {
  /** Direct data feed (price → market) */
  DataFeed = 'DataFeed',
  
  /** Correlation relationship (discovered via analysis) */
  Correlation = 'Correlation',
  
  /** Causal influence (sentiment → price movement) */
  Causal = 'Causal',
  
  /** Alert trigger (condition → action) */
  Trigger = 'Trigger',
  
  /** Composition (parent → child node) */
  Composition = 'Composition',
}

/**
 * Connection strength categories for UI rendering.
 */
export enum ConnectionStrength {
  None = 0,
  Weak = 0.25,
  Moderate = 0.5,
  Strong = 0.75,
  VeryStrong = 1.0,
}

// =============================================================================
// GRAPH STATE TYPES
// =============================================================================

/**
 * Complete graph state for serialization.
 * 
 * Used for saving/loading strategies and import/export.
 */
export interface NodeGraph {
  /** Schema version for migration */
  version: string;
  
  /** Graph name/description */
  name?: string;
  
  /** All nodes in the graph */
  nodes: Node[];
  
  /** All connections between nodes */
  connections: Connection[];
  
  /** Viewport state */
  viewport: ViewportState;
  
  /** Creation metadata */
  meta?: {
    createdAt: number;
    updatedAt: number;
    author?: string;
    description?: string;
  };
}

/**
 * Canvas viewport transform state.
 * 
 * Maps world coordinates to screen coordinates:
 *   screenX = worldX * zoom + x
 *   screenY = worldY * zoom + y
 */
export interface ViewportState {
  /** Pan offset X (pixels) */
  x: number;
  
  /** Pan offset Y (pixels) */
  y: number;
  
  /** Zoom scale factor (1.0 = 100%) */
  zoom: number;
  
  /** Rotation angle (degrees, for future use) */
  rotation?: number;
}

/**
 * Graph layout algorithm configuration.
 */
export interface LayoutConfig {
  /** Algorithm type */
  type: 'force' | 'hierarchical' | 'circular' | 'grid' | 'custom';
  
  /** Force-directed parameters */
  force?: {
    /** Node repulsion strength */
    repulsion: number;
    
    /** Edge attraction strength */
    attraction: number;
    
    /** Ideal edge length */
    edgeLength: number;
    
    /** Iterations to run */
    iterations: number;
  };
  
  /** Hierarchical parameters */
  hierarchical?: {
    /** Direction of flow */
    direction: 'TB' | 'BT' | 'LR' | 'RL';
    
    /** Level separation */
    levelSeparation: number;
    
    /** Node separation */
    nodeSeparation: number;
  };
}

// =============================================================================
// EVENT TYPES
// =============================================================================

/**
 * Base interface for node-related events.
 */
export interface NodeEvent {
  /** Event type discriminator */
  type: string;
  
  /** Affected node ID */
  nodeId: NodeId;
  
  /** Event timestamp */
  timestamp: number;
}

/**
 * Node data update event.
 * 
 * Emitted when info source receives new data.
 */
export interface NodeDataUpdateEvent extends NodeEvent {
  type: 'data_update';
  
  /** New data payload */
  data: any;
  
  /** Data timestamp */
  dataTimestamp: number;
  
  /** Latency from source to display (ms) */
  latency: number;
}

/**
 * Node connection strength update.
 * 
 * Emitted when correlation analyzer recalculates edge weight.
 */
export interface ConnectionUpdateEvent extends NodeEvent {
  type: 'connection_update';
  
  /** Source node (edge start) */
  sourceId: NodeId;
  
  /** Target node (edge end) */
  targetId: NodeId;
  
  /** New strength value */
  newStrength: number;
  
  /** Old strength value */
  oldStrength: number;
  
  /** Calculation method used */
  method: 'pearson' | 'spearman' | 'granger' | 'manual';
}

/**
 * Node status change event.
 */
export interface NodeStatusEvent extends NodeEvent {
  type: 'status_change';
  
  /** Previous status */
  from: 'active' | 'inactive' | 'error' | 'loading';
  
  /** New status */
  to: 'active' | 'inactive' | 'error' | 'loading';
  
  /** Status message */
  message?: string;
}

/**
 * Union of all node events.
 */
export type NodeEvents =
  | NodeDataUpdateEvent
  | ConnectionUpdateEvent
  | NodeStatusEvent;

// =============================================================================
// VALIDATION & CONSTRAINTS
// =============================================================================

/**
 * Connection validation rules.
 * 
 * Defines which node types can connect to which.
 */
export interface ConnectionRules {
  /** Source node types allowed */
  from: NodeType[];
  
  /** Target node types allowed */
  to: NodeType[];
  
  /** Maximum outgoing connections from source */
  maxOutgoing?: number;
  
  /** Maximum incoming connections to target */
  maxIncoming?: number;
  
  /** Custom validation function */
  validator?: (source: Node, target: Node) => boolean | string;
}

/**
 * Default connection rules for the graph.
 */
export const DEFAULT_CONNECTION_RULES: ConnectionRules[] = [
  // Info sources can connect to markets
  {
    from: [{ InfoSource: InfoSourceType.CryptoPrices }],
    to: [{ Market: MarketType.Polymarket }],
    maxOutgoing: 10,
  },
  // Info sources can connect to analyzers
  {
    from: [{ InfoSource: InfoSourceType.NewsSource }],
    to: [{ Analyzer: AnalyzerType.Sentiment }],
    maxOutgoing: 5,
  },
  // Analyzers can connect to markets
  {
    from: [{ Analyzer: AnalyzerType.Correlation }],
    to: [{ Market: MarketType.Polymarket }, { Market: MarketType.Kalshi }],
    maxIncoming: 3,
  },
];

/**
 * Node validation result.
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  
  /** Error messages if invalid */
  errors: string[];
  
  /** Warning messages (non-blocking) */
  warnings: string[];
}

// =============================================================================
// UTILITY TYPES
// =============================================================================

/**
 * Node statistics for monitoring.
 */
export interface NodeStats {
  /** Node ID */
  nodeId: NodeId;
  
  /** Update frequency (updates per minute) */
  updateRate: number;
  
  /** Average data latency (ms) */
  avgLatency: number;
  
  /** Error rate (0-1) */
  errorRate: number;
  
  /** Data points processed */
  totalDataPoints: number;
  
  /** Last error timestamp */
  lastError?: number;
  
  /** Uptime percentage */
  uptime: number;
}

/**
 * Graph statistics overview.
 */
export interface GraphStats {
  /** Total node count */
  totalNodes: number;
  
  /** Count by type */
  nodesByType: Record<string, number>;
  
  /** Total connections */
  totalConnections: number;
  
  /** Average connection strength */
  avgConnectionStrength: number;
  
  /** Graph density (connections / possible connections) */
  density: number;
  
  /** Connected components (should be 1 for valid strategy) */
  components: number;
  
  /** Average path length from sources to markets */
  avgPathLength: number;
}

/**
 * Serialization formats for export/import.
 */
export enum ExportFormat {
  /** Native JSON format */
  JSON = 'json',
  
  /** Compressed binary */
  Binary = 'binary',
  
  /** GraphML for external tools */
  GraphML = 'graphml',
  
  /** CSV for data analysis */
  CSV = 'csv',
}

// =============================================================================
// TYPE GUARDS
// =============================================================================

/**
 * Type guard for InfoSource nodes.
 */
export function isInfoSourceNode(node: Node): boolean {
  return 'InfoSource' in node.node_type;
}

/**
 * Type guard for Market nodes.
 */
export function isMarketNode(node: Node): boolean {
  return 'Market' in node.node_type;
}

/**
 * Type guard for Analyzer nodes.
 */
export function isAnalyzerNode(node: Node): boolean {
  return 'Analyzer' in node.node_type;
}

/**
 * Get specific info source type if applicable.
 */
export function getInfoSourceType(node: Node): InfoSourceType | null {
  if (isInfoSourceNode(node)) {
    return (node.node_type as { InfoSource: InfoSourceType }).InfoSource;
  }
  return null;
}

/**
 * Get specific market type if applicable.
 */
export function getMarketType(node: Node): MarketType | null {
  if (isMarketNode(node)) {
    return (node.node_type as { Market: MarketType }).Market;
  }
  return null;
}

/**
 * Validate connection between two nodes.
 */
export function validateConnection(source: Node, target: Node): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // Prevent self-connections
  if (source.id === target.id) {
    errors.push('Cannot connect node to itself');
  }
  
  // Prevent duplicate connections
  if (source.connections.includes(target.id)) {
    errors.push('Connection already exists');
  }
  
  // Type compatibility checks
  const sourceType = isInfoSourceNode(source);
  const targetType = isMarketNode(target);
  
  if (sourceType && !targetType && !isAnalyzerNode(target)) {
    warnings.push('Info sources typically connect to markets or analyzers');
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default node dimensions (visual size on canvas) */
export const NODE_DIMENSIONS = {
  InfoSource: { width: 120, height: 80 },
  Market: { width: 160, height: 100 },
  Analyzer: { width: 140, height: 90 },
  Alert: { width: 100, height: 60 },
};

/** Default colors by node type (Tailwind classes) */
export const NODE_COLORS = {
  InfoSource: {
    bg: 'bg-blue-600',
    border: 'border-blue-400',
    text: 'text-blue-100',
  },
  Market: {
    bg: 'bg-green-600',
    border: 'border-green-400',
    text: 'text-green-100',
  },
  Analyzer: {
    bg: 'bg-purple-600',
    border: 'border-purple-400',
    text: 'text-purple-100',
  },
  Alert: {
    bg: 'bg-orange-600',
    border: 'border-orange-400',
    text: 'text-orange-100',
  },
};

/** Update intervals by source type (seconds) */
export const DEFAULT_UPDATE_INTERVALS: Record<InfoSourceType, number> = {
  [InfoSourceType.CryptoPrices]: 5,
  [InfoSourceType.FinancialPrices]: 60,
  [InfoSourceType.CommodityPrices]: 300,
  [InfoSourceType.NewsSource]: 30,
  [InfoSourceType.SocialMedia]: 10,
  [InfoSourceType.Weather]: 600,
  [InfoSourceType.Livestream]: 5,
  [InfoSourceType.EconomicIndicators]: 3600,
  [InfoSourceType.OnChainData]: 15,
  [InfoSourceType.CustomAPI]: 60,
};

/** Maximum connections per node type */
export const MAX_CONNECTIONS = {
  InfoSource: { in: 0, out: 10 },    // Sources only output
  Market: { in: 10, out: 0 },        // Markets only input
  Analyzer: { in: 5, out: 3 },       // Analyzers both directions
  Alert: { in: 5, out: 0 },          // Alerts only trigger
};

// =============================================================================
// EXAMPLE USAGE
// =============================================================================
//
// // Creating a crypto price source node
// const cryptoNode: Node = {
//   id: 'node-123' as NodeId,
//   node_type: { InfoSource: InfoSourceType.CryptoPrices },
//   position: [100, 200],
//   connections: [],
//   metadata: {
//     symbols: ['BTC', 'ETH'],
//     updateInterval: 5,
//     filter: { minConfidence: 0.8 },
//   } as InfoSourceMetadata,
//   name: 'Crypto Feed',
//   createdAt: Date.now(),
//   updatedAt: Date.now(),
// };
//
// // Creating a Polymarket node
// const marketNode: Node = {
//   id: 'node-456' as NodeId,
//   node_type: { Market: MarketType.Polymarket },
//   position: [400, 200],
//   connections: [],
//   metadata: {
//     marketId: '0x789...',
//     question: 'Will BTC hit $100k in 2026?',
//     trading: {
//       autoTrade: true,
//       maxPositionSize: 1000,
//       defaultOrderType: 'limit',
//       slippageTolerance: 0.01,
//     },
//   } as MarketMetadata,
//   createdAt: Date.now(),
//   updatedAt: Date.now(),
// };
//
// // Connecting nodes
// const connection: Connection = {
//   source: cryptoNode.id,
//   target: marketNode.id,
//   strength: 0.75,
//   type: ConnectionType.Correlation,
// };
//
// // Type narrowing
// if (isInfoSourceNode(cryptoNode)) {
//   const sourceType = getInfoSourceType(cryptoNode);
//   console.log(`Source type: ${sourceType}`); // "CryptoPrices"
// }
//
// // Validation
// const validation = validateConnection(cryptoNode, marketNode);
// if (!validation.valid) {
//   console.error(validation.errors);
// }
//
// ============================================================================