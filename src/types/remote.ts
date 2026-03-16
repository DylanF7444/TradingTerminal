// ============================================================================
// REMOTE ACCESS TYPES
// ============================================================================
//
// Module: types/remote.ts
// Purpose: TypeScript type definitions mirroring Rust remote access models
//
// OVERVIEW:
// These types define the data structures used by the remote desktop gateway
// feature. They mirror the Rust models in src-tauri/src/models/remote.rs
// and are used by the frontend hooks and components.
//
// ARCHITECTURE:
//   [Remote Device] <--WebSocket Relay--> [Home Desktop] <---> [Market APIs]
//
// TYPE MAPPINGS (Rust -> TypeScript):
//   RemoteSession -> RemoteSession
//   DeviceCredentials -> PairedDeviceSummary (sans auth_token for security)
//   RemoteStatus -> RemoteStatus
//   RelayConfig -> EnableRemoteRequest (subset for frontend usage)
//   SessionStatus -> SessionStatus (string literal union)
//
// FEATURES:
//   - Remote gateway enable/disable control
//   - Device pairing via 6-digit codes
//   - Connected device monitoring
//   - Relay server configuration
//   - Transfer statistics
// ============================================================================

// ============================================================================
// SESSION TYPES
// ============================================================================

/**
 * Session lifecycle states.
 *
 * Maps to Rust `SessionStatus` enum with camelCase serialization.
 */
export type SessionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'expired';

/**
 * Represents an active or historical remote connection session.
 *
 * Maps to Rust `RemoteSession` struct.
 */
export interface RemoteSession {
  /** Unique session identifier (UUID v4) */
  id: string;
  /** Device ID of the remote client */
  remoteDeviceId: string;
  /** Human-readable name for the remote device */
  deviceName: string;
  /** Current session status */
  status: SessionStatus;
  /** Timestamp when the session was established (Unix epoch ms) */
  connectedAt: number;
  /** Timestamp when the session ended (undefined if still active) */
  disconnectedAt?: number;
  /** Last activity timestamp for keep-alive tracking */
  lastActivity: number;
  /** IP address of the remote device */
  remoteIp?: string;
  /** Total bytes transferred in this session */
  bytesTransferred: number;
}

// ============================================================================
// DEVICE TYPES
// ============================================================================

/**
 * Summary of a paired device (safe for frontend display).
 *
 * Maps to Rust `PairedDeviceSummary` (auth_token excluded for security).
 */
export interface PairedDeviceSummary {
  /** Device unique identifier */
  deviceId: string;
  /** Human-readable device name */
  deviceName: string;
  /** When the device was first paired (Unix epoch ms) */
  pairedAt: number;
  /** Last successful authentication time */
  lastAuthAt?: number;
  /** Whether the device is currently authorized */
  authorized: boolean;
}

// ============================================================================
// GATEWAY STATUS
// ============================================================================

/**
 * Current operational status of the remote gateway.
 *
 * Maps to Rust `RemoteStatus` struct. Returned by `get_remote_status_cmd`.
 */
export interface RemoteStatus {
  /** Whether the remote gateway service is enabled */
  enabled: boolean;
  /** Whether the gateway is connected to the relay server */
  relayConnected: boolean;
  /** URL of the relay server currently in use */
  relayUrl?: string;
  /** This device's unique ID (for pairing display) */
  deviceId: string;
  /** Active pairing code (undefined if not in pairing mode) */
  pairingCode?: string;
  /** Number of currently connected remote devices */
  activeConnections: number;
  /** List of active session summaries */
  sessions: RemoteSession[];
  /** Total bytes transferred since gateway was enabled */
  totalBytesTransferred: number;
  /** Gateway uptime in seconds */
  uptimeSeconds: number;
}

// ============================================================================
// REQUEST TYPES
// ============================================================================

/**
 * Request to enable remote access with relay configuration.
 *
 * Maps to Rust `EnableRemoteRequest` struct.
 */
export interface EnableRemoteRequest {
  /** WebSocket URL of the relay server */
  relayUrl: string;
  /** Optional authentication token for the relay server */
  relayAuthToken?: string;
  /** Heartbeat interval in seconds (default: 30) */
  heartbeatIntervalSecs?: number;
  /** Session timeout in seconds (default: 300) */
  sessionTimeoutSecs?: number;
}

// ============================================================================
// EVENT TYPES
// ============================================================================

/**
 * Pairing code event payload (emitted by backend).
 *
 * Received via Tauri event `remote:pairing_code`.
 */
export interface PairingCodeEvent {
  /** 6-digit pairing code */
  code: string;
  /** How long the code is valid (seconds) */
  expiresInSeconds: number;
}

/**
 * Device connected event payload.
 *
 * Received via Tauri event `remote:device_connected`.
 */
export interface DeviceConnectedEvent {
  /** Device ID of the connected remote */
  deviceId: string;
  /** Session ID for the new connection */
  sessionId: string;
}

/**
 * Device disconnected event payload.
 *
 * Received via Tauri event `remote:device_disconnected`.
 */
export interface DeviceDisconnectedEvent {
  /** Reason for disconnection */
  reason: string;
}

/**
 * Reconnection failed event payload.
 *
 * Received via Tauri event `remote:reconnect_failed`.
 */
export interface ReconnectFailedEvent {
  /** Reconnection attempt number */
  attempt: number;
  /** Maximum reconnection attempts */
  maxAttempts: number;
  /** Error message */
  error: string;
}

/**
 * Pair result event payload (received after submitting a pairing code).
 *
 * Received via Tauri event `remote:pair_result`.
 */
export interface PairResultEvent {
  /** Whether pairing succeeded */
  success: boolean;
  /** Assigned device ID (if successful) */
  deviceId?: string;
  /** Auth token for future connections (if successful) */
  authToken?: string;
  /** Error message (if failed) */
  error?: string;
}
