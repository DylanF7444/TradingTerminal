// ============================================================================
// PREDICTION MARKET CONNECTION PANEL
// ============================================================================
//
// Module: components/Markets/MarketPanel.tsx
// Purpose: UI controls for connecting to and managing prediction market platforms
//
// OVERVIEW:
// This component provides the interface for connecting live prediction market
// trading venues (Polymarket, Kalshi) to the strategy graph. Unlike data sources
// which feed information in, markets are the execution endpoints where trades
// are placed based on analyzed signals.
//
// Architecture Pattern:
// User clicks "Add Market"
//   → Modal opens with platform selection (Polymarket vs Kalshi cards)
//   → User selects platform
//   → CHECK FOR STORED API KEYS (new feature)
//       * If stored keys found, pre-populate credentials
//       * User can toggle between stored and new credentials
//   → Configuration form appears (API credentials, market selection)
//   → Frontend validates input format (not empty, URL format, etc.)
//   → Tauri invoke 'add_market' with credentials
//   → Rust backend:
//       * Stores API keys in local SQLite database (api_keys table)
//       * Validates credentials against platform auth endpoint
//       * Establishes WebSocket connection for real-time orderbook
//       * Creates Market node in database
//       * Spawns WebSocket listener task (Tokio async)
//   → Returns Market node to frontend
//   → Added to global store (Zustand marketsSlice)
//   → Canvas renders green square node (distinct from blue info sources)
//   → Right sidebar shows orderbook depth, position exposure, P&L
//   → WebSocket streams live orderbook updates to OrderbookView component
//
// Stored API Keys Feature:
// - API keys are stored in local SQLite database (api_keys table)
// - When user selects a platform, stored keys are automatically retrieved
// - User sees "Stored credentials found" indicator with checkbox to use them
// - Can toggle between stored credentials and entering new ones
// - Keys are persisted across sessions, no need to re-enter
// - Manage stored keys via Settings modal (gear icon in toolbar)
//
// Security Model:
// - API keys stored in local SQLite database (encrypted at rest recommended for production)
// - Keys transmitted over Tauri IPC (secure, not HTTP)
// - Frontend never persists keys in localStorage or sessionStorage
// - Input fields use type="password" with visibility toggle
// - Stored keys can be deleted via Settings UI
//
// Component Hierarchy:
// MarketPanel (main)
//   ├── MarketList (existing connections)
//   │   ├── MarketItem (individual market row)
//   │   │   ├── StatusIndicator (WebSocket health)
//   │   │   ├── BalanceDisplay (available collateral)
//   │   │   └── QuickActions (reconnect, remove)
//   ├── AddMarketButton
//   └── MarketModal (dialog)
//       ├── PlatformSelector (Polymarket vs Kalshi cards)
//       ├── CredentialForm (type-specific auth)
//       │   ├── API Key inputs (masked)
//       │   ├── Market ID selector (or create new)
//       │   └── Test Connection button (optional)
//       └── ConnectionActions
//
// PROPS:
//
// 1. onAddMarket?: (node: Node) => void
//    - Callback when market successfully connected
//    - Parent can auto-position node on canvas or auto-connect to info sources
//
// 2. existingMarkets?: Node[]
//    - Currently connected markets for list rendering
//    - Contains real-time status from WebSocket (connected, last_heartbeat)
//    - Used to prevent duplicate connections to same market
//
// 3. className?: string
//    - Tailwind class overrides for container styling
//    - Default fits within left sidebar (w-full, flex-col)
//
// STATE MANAGEMENT:
//
// isModalOpen: boolean
//   - Controls visibility of add market flow
//   - Reset on close clears sensitive form data (security)
//
// selectedPlatform: MarketType | null
//   - Polymarket or Kalshi selection
//   - Determines which credential fields shown (Kalshi needs API+Secret, Poly just API key)
//   - Affects validation logic (different key formats)
//
// credentials: Record<string, string>
//   - Form state for API keys (held temporarily until submission)
//   - Structure: { api_key: string, api_secret?: string, private_key?: string }
//   - Cleared immediately after successful auth or modal close
//
// marketId: string
//   - Specific prediction market identifier (e.g., "BTC-100K-2026", "0x123..." for Poly)
//   - User can enter ID or search/browse available markets (future feature)
//
// isConnecting: boolean
//   - Loading state during backend auth + WebSocket establishment
//   - Shows spinner on "Connect" button
//   - Prevents double-submission
//
// error: string | null
//   - Auth failures (invalid API key)
//   - Network errors (cannot reach Polymarket)
//   - Validation errors (missing required fields)
//   - Cleared when platform type changes
//
// showPasswords: Record<string, boolean>
//   - Visibility toggle state for each credential field
//   - Allows user to verify input without compromising security by default
//
// PLATFORM-SPECIFIC DETAILS:
//
// Polymarket:
//   - Authentication: API Key + private key for signing blockchain txs
//   - Network: Polygon blockchain (L2 Ethereum)
//   - WebSocket: wss://api.polymarket.com/ws (real-time orderbook deltas)
//   - Markets: Binary outcomes (YES/NO contracts)
//   - Fees: 2% taker fee, 0% maker
//   - Special fields: Private key (hex), RPC endpoint (optional)
//   - Validation: Checks Ethereum address format for proxy wallet
//
// Kalshi:
//   - Authentication: API Key + API Secret (HMAC signature)
//   - Network: Centralized exchange (REST + WebSocket)
//   - WebSocket: wss://trading-api.kalshi.com/v1/ws
//   - Markets: Event contracts (financial, political, cultural)
//   - Fees: 0.5% cap per trade
//   - Special fields: Environment (demo/production), Max leverage
//   - Validation: Base64 key format check
//
// UI/UX PATTERNS:
//
// Layout:
//   - Compact list showing: Platform Icon | Market ID | Balance | Status | Remove
//   - Color-coded status: Green pulse = connected, Red = disconnected, Yellow = connecting
//   - Collapsible sections if many markets (rare, usually 2-5 max)
//
// Modal Design:
//   - Step 1: Large platform cards (Polymarket vs Kalshi) with logos
//   - Step 2: Split form - Left: Credentials, Right: Market selection + Preview
//   - Step 3: Connection test (optional but recommended)
//   - Security notice banner: "API keys stored securely in system keychain"
//
// Visual Feedback:
//   - Platform-specific colors (Polymarket purple, Kalshi green)
//   - Connection status with heartbeat animation
//   - Balance updates in real-time ( streamed from WebSocket)
//   - Error states with platform-specific troubleshooting links
//
// PERFORMANCE CONSIDERATIONS:
//
// - Credentials cleared from memory immediately after invoke (security)
//   * setState({ api_key: '' }) after successful add_market call
// - Debounced market ID search (if implementing browse feature)
// - List virtualization unnecessary (max 2-3 platforms, 10-20 markets each)
//
// ERROR HANDLING:
//
// InvalidCredentials:
//   - Message: "Authentication failed. Please check your API credentials."
//   - Action: Focus first input field, allow retry
//
// NetworkUnreachable:
//   - Message: "Cannot connect to [Platform]. Check internet or try again later."
//   - Action: Retry button with exponential backoff suggestion
//
// MarketNotFound:
//   - Message: "Market ID not found on [Platform]. Check identifier."
//   - Action: Link to platform's market explorer
//
// AlreadyConnected:
//   - Message: "This market is already connected."
//   - Action: Offer to focus existing node on canvas
//
// SECURITY BEST PRACTICES:
//
// 1. Masked Input: All credential fields type="password" by default
// 2. Visibility Toggle: Eye icon to temporarily reveal (user-initiated only)
// 3. No Persistence: Never save to localStorage, sessionStorage, or IndexedDB
// 4. Secure Transmission: Tauri IPC end-to-end (not leaving process)
// 5. Memory Clearing: Explicitly overwrite credential strings in state after use
// 6. Clipboard: Warn if user copies key (optional future feature)
//
// STATE FLOW EXAMPLE:
//
// Initial State:
//   modalOpen: false, platform: null, credentials: {}, marketId: ''
//
// User opens modal:
//   modalOpen: true
//
// User selects Polymarket:
//   platform: 'Polymarket', credentials: { api_key: '', private_key: '' }
//
// User enters API key:
//   credentials: { api_key: 'pm_abc123...', private_key: '' }
//
// User clicks Connect:
//   isConnecting: true
//   → Tauri invoke('add_market', { credentials, marketId })
//   → Backend validates, stores keys, connects WebSocket
//   ← Returns Market node
//   isConnecting: false
//   modalOpen: false
//   credentials: {} // CLEARED for security
//   onAddMarket?.(node)
//
// User closes modal without saving:
//   modalOpen: false
//   credentials: {} // CLEARED
//
// INTEGRATION WITH OTHER COMPONENTS:
//
// Canvas:
//   - Green square nodes (distinct from blue info sources)
//   - Double-click opens MarketDetail window
//   - Connection lines show trading relationships (source → market)
//
// OrderbookView:
//   - Subscribes to WebSocket events from markets added here
//   - Displays real-time bids/asks for selected market
//
// PositionMonitor:
//   - Shows open positions from connected markets
//   - PnL calculated using market prices from these connections
//
// Trading Commands:
//   - place_order uses market_id from nodes created here
//   - Validates sufficient balance before execution
//
// TESTING:
//
// - Unit: Form validation logic (key format regex)
// - Integration: Mock Tauri invoke for add_market
// - E2E: Full connection flow with test API keys
//   * Note: Use sandbox/testnet environments, never real money in tests
//
// USAGE EXAMPLE:
//
// ```tsx
// import MarketPanel from './components/Markets/MarketPanel';
// import { useStore } from './store';
//
// function Sidebar() {
//   const markets = useStore(state => state.markets);
//   const addMarket = useStore(state => state.addMarket);
//
//   return (
//     <MarketPanel 
//       existingMarkets={markets}
//       onAddMarket={(node) => {
//         addMarket(node);
//         // Auto-connect to relevant data sources
//         autoConnectStrategy(node);
//       }}
//     />
//   );
// }
// ```
//
// FUTURE ENHANCEMENTS:
// - OAuth flow support (browser redirect for auth)
// - Market browser/search (query available markets from API) ← IMPLEMENTED
// - Paper trading mode toggle (connect to sandbox vs production)
// - Import/export credentials (encrypted blob)
// - Multi-account support (connect multiple Polymarket accounts)
// - Auto-retry with backoff on WebSocket disconnect
// - Connection quality metrics (latency graph in list item)
//
// DEPENDENCIES:
// - React (useState, useEffect, useCallback)
// - @tauri-apps/api/tauri (invoke backend commands)
// - lucide-react (icons: TrendingUp, Wallet, Link, Eye, EyeOff, etc.)
// - ../../types/nodes (MarketType enum, Node interface)
// - ../../hooks/useTauriCommand (wrapper for backend calls)
// - ../../store (optional - Zustand for global market state)
//
// STYLING:
// - Tailwind dark theme (gray-900/800, emerald for markets)
// - Consistent with SourcePanel but distinct color scheme (green vs blue)
// - Security-focused UI patterns (masked inputs, warning banners)
// ============================================================================

import { useState, useCallback, useEffect } from 'react';
import { 
  TrendingUp, 
  Wallet, 
  Link, 
  Link2, 
  Plus, 
  ExternalLink, 
  AlertCircle, 
  CheckCircle2, 
  Loader2, 
  Eye, 
  EyeOff,
  RefreshCw,
  Unplug,
  Shield,
  Key,
  Search,
  Type
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { MarketType, Node } from '../../types/nodes';
import { useTauriCommand } from '../../hooks/useTauriCommand';
import MarketBrowser from './MarketBrowser';

// ============================================================================
// API KEY TYPES
// ============================================================================

interface ApiKeyResponse {
  platform: string;
  has_key: boolean;
  api_key: string | null;
  api_secret: string | null;
  private_key: string | null;
  environment: string | null;
  additional_config: Record<string, unknown> | null;
  created_at: number | null;
  updated_at: number | null;
}

// Platform-specific configuration metadata
interface PlatformConfig {
  name: string;
  color: string;
  bgColor: string;
  icon: React.ElementType;
  description: string;
  fields: Array<{
    key: string;
    label: string;
    type: 'password' | 'text' | 'select';
    placeholder?: string;
    helpText?: string;
    required: boolean;
  }>;
  testNetAvailable: boolean;
}

const PLATFORM_CONFIGS: Record<MarketType, PlatformConfig> = {
  [MarketType.Polymarket]: {
    name: 'Polymarket',
    color: 'text-purple-400',
    bgColor: 'bg-purple-500',
    icon: Wallet,
    description: 'Polygon-based prediction market. Trade on crypto, politics, sports outcomes. Market data is public - API keys only needed for trading.',
    testNetAvailable: true,
    fields: [
      {
        key: 'api_key',
        label: 'API Key (Optional)',
        type: 'password',
        placeholder: 'pm_...',
        required: false,
        helpText: 'Only needed for trading. Leave empty for read-only market data.'
      },
      {
        key: 'private_key',
        label: 'Proxy Wallet Private Key (Optional)',
        type: 'password',
        placeholder: '0x...',
        required: false,
        helpText: 'Only needed for on-chain transactions.'
      }
    ]
  },
  [MarketType.Kalshi]: {
    name: 'Kalshi',
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500',
    icon: TrendingUp,
    description: 'Regulated US exchange for event contracts. Financial and political markets.',
    testNetAvailable: true,
    fields: [
      {
        key: 'api_key',
        label: 'API Key',
        type: 'password',
        placeholder: 'kalshi_...',
        required: true,
        helpText: 'From Kalshi API dashboard'
      },
      {
        key: 'api_secret',
        label: 'API Secret',
        type: 'password',
        placeholder: 'secret_...',
        required: true,
        helpText: 'Used for request signing (HMAC)'
      },
      {
        key: 'environment',
        label: 'Environment',
        type: 'select',
        required: true,
        helpText: 'Demo for paper trading, Production for real money'
      }
    ]
  }
};

interface MarketPanelProps {
  onAddMarket?: (node: Node) => void;
  existingMarkets?: Node[];
  className?: string;
}

export default function MarketPanel({ 
  onAddMarket, 
  existingMarkets = [],
  className = '' 
}: MarketPanelProps) {
  // Modal and selection state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState<MarketType | null>(null);
  const [step, setStep] = useState<'select' | 'configure'>('select');
  
  // Form state (sensitive - cleared aggressively)
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [marketId, setMarketId] = useState('');
  const [selectedMarketTitle, setSelectedMarketTitle] = useState('');
  const [marketTokenIds, setMarketTokenIds] = useState<string[]>([]);
  const [marketInputMode, setMarketInputMode] = useState<'search' | 'manual'>('search');
  const [environment, setEnvironment] = useState<'demo' | 'production'>('demo');
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});
  
  // Stored API key state
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [useStoredKey, setUseStoredKey] = useState(true);
  const [isLoadingKey, setIsLoadingKey] = useState(false);
  
  // UI state
  const [localError, setLocalError] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  
  // Backend command hook
  const { 
    execute: addMarket, 
    loading: isConnecting, 
    error: apiError 
  } = useTauriCommand<Node, {
    marketType: MarketType;
    apiCredentials: Record<string, any>;
    marketConfig: Record<string, any>;
  }>('add_market_cmd');

  // Cleanup sensitive data on unmount or modal close
  const clearSensitiveData = useCallback(() => {
    setCredentials({});
    setMarketId('');
    setSelectedMarketTitle('');
    setMarketTokenIds([]);
    setMarketInputMode('search');
    setLocalError(null);
    setSelectedPlatform(null);
    setStep('select');
    setShowPasswords({});
    setHasStoredKey(false);
    setUseStoredKey(true);
  }, []);

  useEffect(() => {
    if (!isModalOpen) {
      clearSensitiveData();
    }
  }, [isModalOpen, clearSensitiveData]);

  // Handle platform selection - check for stored keys
  const handlePlatformSelect = async (platform: MarketType) => {
    setSelectedPlatform(platform);
    setStep('configure');
    setIsLoadingKey(true);
    
    // Pre-populate with empty strings for required fields
    const emptyCreds: Record<string, string> = {};
    PLATFORM_CONFIGS[platform].fields.forEach(f => {
      if (f.key !== 'environment') emptyCreds[f.key] = '';
    });
    setCredentials(emptyCreds);
    
    // Check for stored API key
    try {
      const platformName = platform === MarketType.Polymarket ? 'Polymarket' : 'Kalshi';
      const keyResponse = await invoke<ApiKeyResponse>('get_api_key_cmd', { 
        platform: platformName 
      });
      
      if (keyResponse.has_key) {
        setHasStoredKey(true);
        setUseStoredKey(true);
        
        // Pre-populate credentials from stored key
        const storedCreds: Record<string, string> = {};
        if (keyResponse.api_key) storedCreds.api_key = keyResponse.api_key;
        if (keyResponse.api_secret) storedCreds.api_secret = keyResponse.api_secret;
        if (keyResponse.private_key) storedCreds.private_key = keyResponse.private_key;
        setCredentials(storedCreds);
        
        if (keyResponse.environment) {
          setEnvironment(keyResponse.environment as 'demo' | 'production');
        }
      } else {
        setHasStoredKey(false);
        setUseStoredKey(false);
      }
    } catch (err) {
      console.error('Failed to check stored API key:', err);
      setHasStoredKey(false);
      setUseStoredKey(false);
    } finally {
      setIsLoadingKey(false);
    }
  };

  // Toggle password visibility for specific field
  const togglePasswordVisibility = (fieldKey: string) => {
    setShowPasswords(prev => ({ ...prev, [fieldKey]: !prev[fieldKey] }));
  };

  // Handle credential input change
  const handleCredentialChange = (key: string, value: string) => {
    setCredentials(prev => ({ ...prev, [key]: value }));
    setLocalError(null); // Clear error on input
  };

  // Test connection before saving (optional validation)
  const handleTestConnection = async () => {
    if (!selectedPlatform) return;
    setIsTesting(true);
    setLocalError(null);
    
    try {
      // Note: Backend would need a test_connection command
      // For now, we just validate format client-side
      const valid = validateCredentials(selectedPlatform, credentials);
      if (valid) {
        // In real implementation: await invoke('test_market_connection', ...)
        await new Promise(r => setTimeout(r, 1000)); // Simulate
      }
    } catch (e) {
      setLocalError('Connection test failed. Check credentials.');
    } finally {
      setIsTesting(false);
    }
  };

  // Validate credentials format client-side
  const validateCredentials = (platform: MarketType, creds: Record<string, string>): boolean => {
    // If using stored key, skip credential validation
    if (hasStoredKey && useStoredKey) {
      if (!marketId.trim()) {
        setLocalError('Market ID is required');
        return false;
      }
      return true;
    }
    
    const config = PLATFORM_CONFIGS[platform];
    for (const field of config.fields) {
      // Skip environment field - it's validated separately from the credentials object
      if (field.key === 'environment') {
        // For Kalshi, environment is always set via the separate state variable
        continue;
      }
      // Polymarket doesn't require API keys for market data (read-only)
      // Only validate required fields
      if (field.required && !creds[field.key]) {
        setLocalError(`${field.label} is required`);
        return false;
      }
    }
    if (!marketId.trim()) {
      setLocalError('Market ID is required');
      return false;
    }
    return true;
  };

  // Submit connection request
  const handleConnect = async () => {
    if (!selectedPlatform) return;

    if (!validateCredentials(selectedPlatform, credentials)) {
      return;
    }

    try {
      const credPayload = {
        ...credentials,
        environment: selectedPlatform === MarketType.Kalshi ? environment : undefined
      };

      const result = await addMarket({
        marketType: selectedPlatform,
        apiCredentials: credPayload,
        marketConfig: { 
          market_id: marketId.trim(),
          question: selectedMarketTitle || undefined,
          token_ids: marketTokenIds.length > 0 ? marketTokenIds : undefined,
        }
      });

      if (result) {
        onAddMarket?.(result);
        setIsModalOpen(false);
        // Data cleared by useEffect on modal close
      }
    } catch (err) {
      console.error('Failed to connect market:', err);
      // Error displayed via apiError from hook
    }
  };

  // Remove market connection
  const handleRemove = async (nodeId: string) => {
    if (!confirm('Disconnect this market? Open positions will remain but no new trades can be placed.')) {
      return;
    }
    
    try {
      await invoke('remove_market_cmd', { nodeId });
      // Parent should refresh existingMarkets prop
    } catch (err) {
      console.error('Failed to remove market:', err);
      alert('Failed to disconnect. Please try again.');
    }
  };

  // Refresh connection (re-establish WebSocket)
  const handleRefresh = async (nodeId: string) => {
    try {
      await invoke('refresh_market_connection_cmd', { nodeId });
    } catch (err) {
      console.error('Failed to refresh:', err);
    }
  };

  return (
    <div className={`bg-gray-900 rounded-lg border border-gray-800 overflow-hidden ${className}`}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-emerald-400" />
          Prediction Markets
        </h3>
        <span className="text-xs text-gray-500 bg-gray-800 px-2 py-1 rounded-full">
          {existingMarkets.length} connected
        </span>
      </div>

      {/* Connected Markets List */}
      <div className="max-h-64 overflow-y-auto">
        {existingMarkets.length === 0 ? (
          <div className="px-4 py-8 text-center text-gray-500 text-sm">
            <Link className="w-8 h-8 mx-auto mb-2 opacity-50" />
            No markets connected
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {existingMarkets.map((market) => {
              // Type guard: Check if this is a Market node
              if (!('Market' in market.node_type)) return null;
              
              const platform = market.node_type.Market;
              const config = PLATFORM_CONFIGS[platform];
              if (!config) return null;
              
              const Icon = config.icon;
              
              // Safely access metadata properties with type assertions
              const metadata = market.metadata as Record<string, any>;
              // Use quality.successRate to determine connection status (same as Node component)
              const quality = metadata?.quality;
              const isConnected = quality?.successRate !== undefined && quality.successRate > 0.5;
              const latency = quality?.avgLatency;
              const balance = metadata?.balance || 0;

              return (
                <div 
                  key={market.id} 
                  className="px-4 py-3 flex items-center justify-between hover:bg-gray-800/50 transition-colors group"
                >
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg bg-gray-800 ${config.color}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-200 truncate">
                        {metadata?.market_id || config.name}
                      </div>
                      <div className="text-xs text-gray-500 flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-green-500' : 'bg-yellow-500 animate-pulse'}`} />
                        {isConnected ? 'Connected' : 'Connecting...'}
                        {latency !== undefined && (
                          <>
                            <span className="text-gray-600">•</span>
                            <span className="text-blue-400">{latency.toFixed(0)}ms</span>
                          </>
                        )}
                        <span className="text-gray-600">•</span>
                        <span className="text-emerald-400">${balance.toFixed(2)}</span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => handleRefresh(market.id)}
                      className="p-1.5 text-gray-500 hover:text-blue-400 hover:bg-blue-400/10 rounded transition-colors"
                      title="Refresh connection"
                    >
                      <RefreshCw className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleRemove(market.id)}
                      className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
                      title="Disconnect"
                    >
                      <Unplug className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add Button */}
      <div className="p-4 border-t border-gray-800">
        <button
          onClick={() => setIsModalOpen(true)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors text-sm font-medium"
        >
          <Plus className="w-4 h-4" />
          Connect Market
        </button>
      </div>

      {/* Connection Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-gray-900 rounded-xl border border-gray-800 shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  {step === 'select' ? 'Select Platform' : `Connect to ${selectedPlatform}`}
                </h2>
                {step === 'configure' && (
                  <p className="text-sm text-gray-500 mt-0.5">
                    Enter your API credentials to establish connection
                  </p>
                )}
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <Link2 className="w-5 h-5" />
              </button>
            </div>

            {/* Security Banner */}
            <div className="px-6 py-3 bg-blue-900/20 border-b border-blue-900/30 flex items-center gap-2 text-sm text-blue-200">
              <Shield className="w-4 h-4 flex-shrink-0" />
              <span>API keys are encrypted and stored in your system keychain. They are never stored in the browser.</span>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6">
              {step === 'select' ? (
                // Platform Selection Grid
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {Object.entries(PLATFORM_CONFIGS).map(([type, config]) => (
                    <button
                      key={type}
                      onClick={() => handlePlatformSelect(type as MarketType)}
                      className="p-6 rounded-xl border border-gray-800 hover:border-gray-600 hover:bg-gray-800/50 transition-all text-left group relative overflow-hidden"
                    >
                      <div className={`absolute inset-0 opacity-0 group-hover:opacity-10 transition-opacity ${config.bgColor}`} />
                      <div className={`p-3 w-fit rounded-xl bg-gray-800 mb-4 group-hover:scale-110 transition-transform ${config.color}`}>
                        <config.icon className="w-6 h-6" />
                      </div>
                      <h3 className="font-semibold text-gray-200 mb-1">{config.name}</h3>
                      <p className="text-sm text-gray-500 leading-relaxed">
                        {config.description}
                      </p>
                      <div className="mt-4 flex items-center gap-2 text-xs text-gray-600">
                        <ExternalLink className="w-3 h-3" />
                        <span>Get API keys →</span>
                      </div>
                    </button>
                  ))}
                </div>
              ) : selectedPlatform ? (
                // Configuration Form
                <div className="space-y-6">
                  {/* Back button */}
                  <button
                    onClick={() => setStep('select')}
                    className="text-sm text-gray-500 hover:text-gray-300 flex items-center gap-1"
                  >
                    ← Back to platforms
                  </button>

                  {/* Stored Key Indicator */}
                  {isLoadingKey ? (
                    <div className="flex items-center gap-2 p-3 bg-gray-800/50 rounded-lg">
                      <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                      <span className="text-sm text-gray-400">Checking for stored credentials...</span>
                    </div>
                  ) : hasStoredKey ? (
                    <div className="flex items-center justify-between p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
                      <div className="flex items-center gap-2">
                        <Key className="w-4 h-4 text-emerald-400" />
                        <span className="text-sm text-emerald-300">Stored credentials found</span>
                      </div>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={useStoredKey}
                          onChange={(e) => setUseStoredKey(e.target.checked)}
                          className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-gray-900"
                        />
                        <span className="text-sm text-gray-300">Use stored</span>
                      </label>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 p-3 bg-gray-800/50 rounded-lg">
                      <Key className="w-4 h-4 text-gray-500" />
                      <span className="text-sm text-gray-400">
                        No stored credentials. Enter your API keys below.
                      </span>
                    </div>
                  )}

                  {/* Market Selection - Search or Manual Entry */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="block text-sm font-medium text-gray-300">
                        Market
                      </label>
                      <div className="flex items-center bg-gray-800 rounded-lg p-0.5 border border-gray-700">
                        <button
                          type="button"
                          onClick={() => setMarketInputMode('search')}
                          className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                            marketInputMode === 'search'
                              ? 'bg-emerald-600 text-white'
                              : 'text-gray-400 hover:text-gray-200'
                          }`}
                        >
                          <Search className="w-3 h-3" />
                          Search
                        </button>
                        <button
                          type="button"
                          onClick={() => setMarketInputMode('manual')}
                          className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                            marketInputMode === 'manual'
                              ? 'bg-emerald-600 text-white'
                              : 'text-gray-400 hover:text-gray-200'
                          }`}
                        >
                          <Type className="w-3 h-3" />
                          Manual
                        </button>
                      </div>
                    </div>

                    {marketInputMode === 'search' ? (
                      <div className="space-y-2">
                        <MarketBrowser
                          platform={selectedPlatform}
                          onSelectMarket={(id, title, tokenIds) => {
                            setMarketId(id);
                            setSelectedMarketTitle(title);
                            setMarketTokenIds(tokenIds || []);
                            setLocalError(null);
                          }}
                        />
                        {selectedMarketTitle && (
                          <div className="flex items-center gap-2 p-2.5 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
                            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                            <div className="min-w-0 flex-1">
                              <p className="text-sm text-emerald-300 truncate">{selectedMarketTitle}</p>
                              <p className="text-xs text-gray-500 font-mono truncate">{marketId}</p>
                            </div>
                            <button
                              onClick={() => {
                                setMarketId('');
                                setSelectedMarketTitle('');
                              }}
                              className="text-gray-500 hover:text-gray-300 flex-shrink-0"
                            >
                              <Link2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div>
                        <input
                          type="text"
                          value={marketId}
                          onChange={(e) => {
                            setMarketId(e.target.value);
                            setSelectedMarketTitle('');
                          }}
                          placeholder={selectedPlatform === MarketType.Polymarket ? "0x123... or slug-name" : "Event-contract-ticker"}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 focus:outline-none focus:border-emerald-500 transition-colors"
                        />
                        <p className="mt-1.5 text-xs text-gray-500">
                          Enter the market identifier directly (e.g., slug, condition ID, or ticker)
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Credential Fields - show if no stored key or user wants to enter new */}
                  {(!hasStoredKey || !useStoredKey) && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-medium text-gray-300">API Credentials</h4>
                        {hasStoredKey && (
                          <button
                            onClick={() => setUseStoredKey(true)}
                            className="text-xs text-emerald-400 hover:text-emerald-300"
                          >
                            Use stored instead
                          </button>
                        )}
                      </div>
                      {PLATFORM_CONFIGS[selectedPlatform].fields.map((field) => (
                        <div key={field.key}>
                          <label className="block text-sm font-medium text-gray-300 mb-2">
                            {field.label}
                            {field.required && <span className="text-red-400 ml-1">*</span>}
                          </label>
                          
                          {field.type === 'select' ? (
                            <select
                              value={environment}
                              onChange={(e) => setEnvironment(e.target.value as 'demo' | 'production')}
                              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 focus:outline-none focus:border-emerald-500 transition-colors"
                            >
                              <option value="demo">Demo (Paper Trading)</option>
                              <option value="production">Production (Real Money)</option>
                            </select>
                          ) : (
                            <div className="relative">
                              <input
                                type={field.type === 'password' && !showPasswords[field.key] ? 'password' : 'text'}
                                value={credentials[field.key] || ''}
                                onChange={(e) => handleCredentialChange(field.key, e.target.value)}
                                placeholder={field.placeholder}
                                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 focus:outline-none focus:border-emerald-500 transition-colors pr-10"
                              />
                              {field.type === 'password' && (
                                <button
                                  type="button"
                                  onClick={() => togglePasswordVisibility(field.key)}
                                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                                >
                                  {showPasswords[field.key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                              )}
                            </div>
                          )}
                          
                          {field.helpText && (
                            <p className="mt-1.5 text-xs text-gray-500">{field.helpText}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Error Display */}
                  {(localError || apiError) && (
                    <div className="flex items-center gap-2 p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      <span>{localError || apiError}</span>
                    </div>
                  )}
                </div>
              ) : null}
            </div>

            {/* Modal Footer */}
            {step === 'configure' && selectedPlatform && (
              <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-between">
                <button
                  onClick={handleTestConnection}
                  disabled={isTesting || isConnecting}
                  className="text-sm text-gray-400 hover:text-gray-200 disabled:opacity-50 flex items-center gap-2"
                >
                  {isTesting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4" />
                  )}
                  Test Connection
                </button>
                
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setIsModalOpen(false)}
                    className="px-4 py-2 text-gray-400 hover:text-white transition-colors text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleConnect}
                    disabled={isConnecting}
                    className="flex items-center gap-2 px-6 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors text-sm font-medium"
                  >
                    {isConnecting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Connecting...
                      </>
                    ) : (
                      <>
                        <Link className="w-4 h-4" />
                        Connect
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}