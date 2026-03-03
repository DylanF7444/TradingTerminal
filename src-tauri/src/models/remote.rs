// ============================================================================
// REMOTE CONNECTION DATA MODELS
// ============================================================================
//
// Module: models/remote.rs
// Purpose: Data structures for remote desktop gateway connections
//
// OVERVIEW:
// Defines types for the remote access feature that allows the trading terminal
// running on a home desktop to be accessed from a remote device via a WebSocket
// relay. The home desktop acts as a gateway, proxying market API traffic to/from
// the remote client.
//
// ARCHITECTURE:
//   [Remote Device] <--WebSocket Relay--> [Home Desktop] <---> [Market APIs]
//
// KEY TYPES:
//   - RemoteSession: Active connection between remote device and home desktop
//   - DeviceCredentials: Authentication identity for device pairing
//   - RemoteStatus: Current state of the remote gateway service
//   - RemoteCommand: Protocol messages exchanged over the relay
//   - RelayConfig: Configuration for the relay/signaling server
//
// SECURITY:
//   - Device pairing uses a 6-digit pairing code or QR code
//   - All relay traffic is TLS-encrypted (wss://)
//   - Auth tokens are generated on first pairing and stored locally
//   - Tokens can be revoked to disconnect remote devices
//
// FRONTEND SYNC:
//   These types must remain compatible with:
//   - src/types/remote.ts (TypeScript mirror types)
// ============================================================================

use serde::{Serialize, Deserialize};

// ============================================================================
// REMOTE SESSION
// ============================================================================

/// Represents an active or historical remote connection session.
///
/// Tracks the lifecycle of a remote device connected to the home desktop
/// through the relay server. Sessions are persisted in SQLite for audit
/// and reconnection purposes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSession {
    /// Unique session identifier (UUID v4)
    pub id: String,
    /// Device ID of the remote client
    pub remote_device_id: String,
    /// Human-readable name for the remote device (e.g., "Dylan's Laptop")
    pub device_name: String,
    /// Current session status
    pub status: SessionStatus,
    /// Timestamp when the session was established (Unix epoch ms)
    pub connected_at: i64,
    /// Timestamp when the session ended (None if still active)
    pub disconnected_at: Option<i64>,
    /// Last activity timestamp for keep-alive tracking
    pub last_activity: i64,
    /// IP address of the remote device (for audit logging)
    pub remote_ip: Option<String>,
    /// Total bytes transferred in this session
    pub bytes_transferred: u64,
}

/// Session lifecycle states
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    /// Session is being negotiated (handshake in progress)
    Connecting,
    /// Session is active and exchanging data
    Connected,
    /// Session was gracefully closed
    Disconnected,
    /// Session failed due to an error
    Error,
    /// Session expired due to inactivity timeout
    Expired,
}

// ============================================================================
// DEVICE CREDENTIALS
// ============================================================================

/// Authentication credentials for a paired device.
///
/// Generated during the initial device pairing process. The auth_token is
/// a long-lived secret shared between the home desktop and remote device.
/// It is stored encrypted in the SQLite database.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCredentials {
    /// Unique device identifier (UUID v4, generated on first pairing)
    pub device_id: String,
    /// Human-readable device name
    pub device_name: String,
    /// Authentication token (256-bit random, hex-encoded)
    pub auth_token: String,
    /// Timestamp when the device was first paired
    pub paired_at: i64,
    /// Timestamp of last successful authentication
    pub last_auth_at: Option<i64>,
    /// Whether this device is currently authorized
    pub authorized: bool,
}

// ============================================================================
// REMOTE GATEWAY STATUS
// ============================================================================

/// Current operational status of the remote gateway service.
///
/// Emitted periodically to the frontend for UI display, and returned
/// by the get_remote_status_cmd command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    /// Whether the remote gateway service is enabled
    pub enabled: bool,
    /// Whether the gateway is connected to the relay server
    pub relay_connected: bool,
    /// URL of the relay server currently in use
    pub relay_url: Option<String>,
    /// This device's unique ID (for pairing display)
    pub device_id: String,
    /// Active pairing code (None if not in pairing mode)
    pub pairing_code: Option<String>,
    /// Number of currently connected remote devices
    pub active_connections: u32,
    /// List of active session summaries
    pub sessions: Vec<RemoteSession>,
    /// Total bytes transferred since gateway was enabled
    pub total_bytes_transferred: u64,
    /// Gateway uptime in seconds
    pub uptime_seconds: u64,
}

// ============================================================================
// RELAY CONFIGURATION
// ============================================================================

/// Configuration for the WebSocket relay/signaling server.
///
/// The relay server acts as a meeting point for NAT traversal between
/// the home desktop and remote devices. Traffic flows:
///   Remote -> Relay -> Home Desktop
///
/// Supports both self-hosted and managed relay servers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayConfig {
    /// WebSocket URL of the relay server (wss://relay.example.com/ws)
    pub relay_url: String,
    /// Authentication token for the relay server (if required)
    pub relay_auth_token: Option<String>,
    /// Reconnection interval in seconds (default: 5)
    pub reconnect_interval_secs: u64,
    /// Maximum reconnection attempts before giving up (0 = infinite)
    pub max_reconnect_attempts: u32,
    /// Heartbeat interval in seconds (default: 30)
    pub heartbeat_interval_secs: u64,
    /// Session timeout in seconds (default: 300 = 5 minutes of inactivity)
    pub session_timeout_secs: u64,
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self {
            relay_url: "wss://localhost:9090/ws".to_string(),
            relay_auth_token: None,
            reconnect_interval_secs: 5,
            max_reconnect_attempts: 0, // infinite
            heartbeat_interval_secs: 30,
            session_timeout_secs: 300,
        }
    }
}

// ============================================================================
// REMOTE PROTOCOL MESSAGES
// ============================================================================

/// Protocol messages exchanged between home desktop and remote device
/// over the relay WebSocket connection.
///
/// The protocol is a simple request/response model where the remote device
/// sends commands and the home desktop responds with results. Market data
/// is pushed from home desktop to remote device as it arrives.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum RemoteCommand {
    // -- Authentication --
    /// Remote device sends auth credentials to home desktop
    Authenticate {
        device_id: String,
        auth_token: String,
    },
    /// Home desktop acknowledges authentication
    AuthResult {
        success: bool,
        error: Option<String>,
        session_id: Option<String>,
    },

    // -- Pairing --
    /// Remote device sends pairing code to initiate pairing
    PairRequest {
        pairing_code: String,
        device_name: String,
    },
    /// Home desktop responds with device credentials
    PairResult {
        success: bool,
        device_id: Option<String>,
        auth_token: Option<String>,
        error: Option<String>,
    },

    // -- Data Forwarding --
    /// Forward a Tauri command from remote to home desktop
    ForwardCommand {
        /// Unique request ID for response correlation
        request_id: String,
        /// The Tauri command name (e.g., "get_positions_cmd")
        command: String,
        /// Command arguments as JSON
        args: serde_json::Value,
    },
    /// Response to a forwarded command
    CommandResponse {
        /// Matching request ID
        request_id: String,
        /// Whether the command succeeded
        success: bool,
        /// Command result (serialized JSON)
        result: Option<serde_json::Value>,
        /// Error message if failed
        error: Option<String>,
    },

    // -- Market Data Push --
    /// Push real-time market data to remote device
    MarketDataUpdate {
        /// Event name (matches Tauri event names)
        event: String,
        /// Event payload
        data: serde_json::Value,
    },

    // -- Session Management --
    /// Heartbeat/ping to keep connection alive
    Ping { timestamp: i64 },
    /// Heartbeat/pong response
    Pong { timestamp: i64 },
    /// Graceful disconnect
    Disconnect { reason: String },
}
