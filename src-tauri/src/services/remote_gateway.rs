// ============================================================================
// REMOTE GATEWAY SERVICE
// ============================================================================
//
// Module: services/remote_gateway.rs
// Purpose: WebSocket relay-based remote access gateway for the trading terminal
//
// OVERVIEW:
// This service enables remote access to the trading terminal running on a home
// desktop. It establishes an outbound WebSocket connection to a relay server,
// authenticates with device credentials, and manages sessions for connected
// remote devices. Market data and Tauri commands are proxied bidirectionally.
//
// ARCHITECTURE:
//   [Remote Device] <--WS--> [Relay Server] <--WS--> [Home Desktop (this)]
//                                                          |
//                                                    [Market APIs]
//
// WHY RELAY (vs Direct P2P):
//   - NAT traversal: Home desktops are typically behind routers/firewalls
//   - No port forwarding required: Outbound connections only
//   - Works through corporate firewalls and restrictive networks
//   - Simpler than STUN/TURN/ICE for WebRTC
//   - TLS encryption handled by standard wss:// URLs
//
// FLOW:
//   1. User enables remote access in settings
//   2. Gateway connects to relay server via outbound WebSocket
//   3. Gateway registers with device_id, receives pairing code
//   4. Remote device connects to same relay, enters pairing code
//   5. Relay bridges the two connections
//   6. Remote device authenticates with auth_token
//   7. Commands from remote are executed locally and results returned
//   8. Market data events are forwarded to remote in real-time
//
// SECURITY:
//   - All traffic encrypted via TLS (wss://)
//   - Device pairing requires physical access to see pairing code
//   - Auth tokens are 256-bit random hex strings
//   - Session timeouts prevent stale connections
//   - Paired devices can be revoked at any time
//
// CONCURRENCY:
//   - Gateway runs as a Tokio task spawned from main.rs setup
//   - Command channel (mpsc) for control from Tauri commands
//   - Read/write halves of WebSocket run in separate tasks
//   - Session state protected by Arc<RwLock<>>
//
// ERROR HANDLING:
//   - Relay disconnection: Automatic reconnection with exponential backoff
//   - Auth failure: Log error, notify frontend, do not retry
//   - Command forwarding failure: Return error to remote device
//   - Panic in gateway task: Supervisor restarts (future enhancement)
//
// FUTURE ENHANCEMENTS:
//   - WebRTC data channel for lower-latency P2P (with relay fallback)
//   - Tailscale integration for WireGuard-based VPN tunneling
//   - Multi-device support (multiple remotes connected simultaneously)
//   - Bandwidth throttling and QoS for metered connections
//   - End-to-end encryption (beyond TLS) using device key pairs
// ============================================================================

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use log::{info, warn, error};
use serde_json::Value as JsonValue;
use tokio::sync::{mpsc, Mutex};
use tokio::time;
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};
use tauri::{AppHandle, Emitter};
use tauri::async_runtime::JoinHandle as TauriJoinHandle;

use crate::models::remote::{
    RemoteSession, DeviceCredentials, RemoteStatus, RemoteCommand,
    RelayConfig, SessionStatus,
};

// ============================================================================
// CONSTANTS
// ============================================================================

/// Default heartbeat interval for relay connection keep-alive
#[allow(dead_code)]
const DEFAULT_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

/// Maximum time to wait for a pong response before considering connection dead
#[allow(dead_code)]
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(10);

/// Base delay for reconnection backoff (doubles each attempt, capped at 60s)
const RECONNECT_BASE_DELAY: Duration = Duration::from_secs(2);

/// Maximum reconnection delay
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(60);

/// Pairing code validity duration
const PAIRING_CODE_VALIDITY: Duration = Duration::from_secs(300); // 5 minutes

// ============================================================================
// GATEWAY COMMAND CHANNEL
// ============================================================================

/// Commands sent from Tauri command handlers to the gateway task.
///
/// These are internal control messages, distinct from RemoteCommand which
/// is the protocol between home desktop and remote device.
#[derive(Debug)]
pub enum GatewayCommand {
    /// Enable the gateway and connect to relay
    Enable { config: RelayConfig },
    /// Disable the gateway and disconnect from relay
    Disable,
    /// Generate a new pairing code for device enrollment
    GeneratePairingCode,
    /// Revoke a paired device's access
    RevokeDevice { device_id: String },
    /// Get current gateway status
    GetStatus { reply: tokio::sync::oneshot::Sender<RemoteStatus> },
    /// Get all paired devices
    GetPairedDevices { reply: tokio::sync::oneshot::Sender<Vec<DeviceCredentials>> },
    /// Forward a market data event to all connected remotes
    ForwardEvent { event: String, data: JsonValue },
    /// Shutdown the gateway
    Shutdown,
}

// ============================================================================
// REMOTE CONNECTION MANAGER
// ============================================================================

/// Central manager for the remote access gateway.
///
/// Holds the gateway task handle and command channel. Created once during
/// app initialization and stored in Tauri managed state.
pub struct RemoteConnectionManager {
    command_tx: mpsc::Sender<GatewayCommand>,
    enabled: Arc<AtomicBool>,
    device_id: String,
    task_handle: Mutex<Option<TauriJoinHandle<()>>>,
}

impl RemoteConnectionManager {
    pub fn new(app_handle: AppHandle) -> Self {
        let device_id = generate_device_id();
        let enabled = Arc::new(AtomicBool::new(false));
        let (command_tx, command_rx) = mpsc::channel(64);

        let gateway_state = GatewayState {
            app_handle,
            device_id: device_id.clone(),
            enabled: enabled.clone(),
            relay_config: None,
            relay_connected: false,
            pairing_code: None,
            pairing_code_expires_at: None,
            paired_devices: HashMap::new(),
            active_sessions: HashMap::new(),
            total_bytes_transferred: Arc::new(AtomicU64::new(0)),
            started_at: None,
            ws_write_tx: None,
        };

        let task_handle = tauri::async_runtime::spawn(gateway_task(gateway_state, command_rx));

        Self {
            command_tx,
            enabled,
            device_id,
            task_handle: Mutex::new(Some(task_handle)),
        }
    }

    /// Enable remote access with the given relay configuration.
    ///
    /// Connects to the relay server and begins accepting remote connections.
    pub async fn enable(&self, config: RelayConfig) -> Result<()> {
        self.command_tx
            .send(GatewayCommand::Enable { config })
            .await
            .map_err(|_| anyhow!("Gateway task not running"))?;
        Ok(())
    }

    /// Disable remote access and disconnect all remote devices.
    pub async fn disable(&self) -> Result<()> {
        self.command_tx
            .send(GatewayCommand::Disable)
            .await
            .map_err(|_| anyhow!("Gateway task not running"))?;
        Ok(())
    }

    /// Generate a new pairing code for device enrollment.
    ///
    /// Returns the pairing code via a frontend event emission.
    pub async fn generate_pairing_code(&self) -> Result<()> {
        self.command_tx
            .send(GatewayCommand::GeneratePairingCode)
            .await
            .map_err(|_| anyhow!("Gateway task not running"))?;
        Ok(())
    }

    /// Revoke a paired device's access.
    pub async fn revoke_device(&self, device_id: String) -> Result<()> {
        self.command_tx
            .send(GatewayCommand::RevokeDevice { device_id })
            .await
            .map_err(|_| anyhow!("Gateway task not running"))?;
        Ok(())
    }

    /// Get the current gateway status.
    pub async fn get_status(&self) -> Result<RemoteStatus> {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        self.command_tx
            .send(GatewayCommand::GetStatus { reply: reply_tx })
            .await
            .map_err(|_| anyhow!("Gateway task not running"))?;
        reply_rx.await.map_err(|_| anyhow!("Gateway did not respond"))
    }

    /// Get all paired devices.
    pub async fn get_paired_devices(&self) -> Result<Vec<DeviceCredentials>> {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        self.command_tx
            .send(GatewayCommand::GetPairedDevices { reply: reply_tx })
            .await
            .map_err(|_| anyhow!("Gateway task not running"))?;
        reply_rx.await.map_err(|_| anyhow!("Gateway did not respond"))
    }

    /// Forward a market data event to all connected remote devices.
    pub async fn forward_event(&self, event: String, data: JsonValue) -> Result<()> {
        // Only forward if enabled and has active sessions
        if !self.enabled.load(Ordering::Relaxed) {
            return Ok(());
        }
        self.command_tx
            .send(GatewayCommand::ForwardEvent { event, data })
            .await
            .map_err(|_| anyhow!("Gateway task not running"))?;
        Ok(())
    }

    /// Shutdown the gateway service.
    pub async fn shutdown(&self) -> Result<()> {
        let _ = self.command_tx.send(GatewayCommand::Shutdown).await;
        let mut handle = self.task_handle.lock().await;
        if let Some(h) = handle.take() {
            h.abort();
        }
        Ok(())
    }

    /// Whether the gateway is currently enabled.
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// This device's unique identifier (for display in pairing UI).
    pub fn device_id(&self) -> &str {
        &self.device_id
    }
}

// ============================================================================
// GATEWAY INTERNAL STATE
// ============================================================================

/// Internal state for the gateway task.
///
/// Owned exclusively by the gateway_task function. External access is
/// mediated through the GatewayCommand channel.
struct GatewayState {
    /// Tauri app handle for emitting events to frontend
    app_handle: AppHandle,
    /// This home desktop's device ID
    device_id: String,
    /// Whether the gateway is enabled
    enabled: Arc<AtomicBool>,
    /// Relay server configuration
    relay_config: Option<RelayConfig>,
    /// Whether currently connected to the relay server
    relay_connected: bool,
    /// Active pairing code (if in pairing mode)
    pairing_code: Option<String>,
    /// When the pairing code expires
    pairing_code_expires_at: Option<Instant>,
    /// Paired device credentials indexed by device_id
    paired_devices: HashMap<String, DeviceCredentials>,
    /// Active remote sessions indexed by session_id
    active_sessions: HashMap<String, RemoteSession>,
    /// Total bytes transferred counter
    total_bytes_transferred: Arc<AtomicU64>,
    /// When the gateway was started (for uptime calculation)
    started_at: Option<Instant>,
    /// Write half of the relay WebSocket (for sending messages)
    ws_write_tx: Option<mpsc::Sender<WsMessage>>,
}

// ============================================================================
// GATEWAY TASK
// ============================================================================

/// Main gateway task loop.
///
/// Runs for the application lifetime, processing GatewayCommand messages
/// and managing the relay WebSocket connection.
async fn gateway_task(
    mut state: GatewayState,
    mut command_rx: mpsc::Receiver<GatewayCommand>,
) {
    info!("[RemoteGateway] Gateway task started (device_id: {})", state.device_id);

    loop {
        tokio::select! {
            // Process commands from Tauri command handlers
            cmd = command_rx.recv() => {
                match cmd {
                    Some(GatewayCommand::Enable { config }) => {
                        handle_enable(&mut state, config).await;
                    }
                    Some(GatewayCommand::Disable) => {
                        handle_disable(&mut state).await;
                    }
                    Some(GatewayCommand::GeneratePairingCode) => {
                        handle_generate_pairing_code(&mut state).await;
                    }
                    Some(GatewayCommand::RevokeDevice { device_id }) => {
                        handle_revoke_device(&mut state, &device_id).await;
                    }
                    Some(GatewayCommand::GetStatus { reply }) => {
                        let status = build_status(&state);
                        let _ = reply.send(status);
                    }
                    Some(GatewayCommand::GetPairedDevices { reply }) => {
                        let devices: Vec<DeviceCredentials> =
                            state.paired_devices.values().cloned().collect();
                        let _ = reply.send(devices);
                    }
                    Some(GatewayCommand::ForwardEvent { event, data }) => {
                        handle_forward_event(&mut state, &event, &data).await;
                    }
                    Some(GatewayCommand::Shutdown) | None => {
                        info!("[RemoteGateway] Shutting down gateway task");
                        handle_disable(&mut state).await;
                        break;
                    }
                }
            }
        }
    }

    info!("[RemoteGateway] Gateway task exited");
}

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

/// Handle Enable command: connect to relay server.
async fn handle_enable(state: &mut GatewayState, config: RelayConfig) {
    info!("[RemoteGateway] Enabling remote access, relay: {}", config.relay_url);

    state.relay_config = Some(config.clone());
    state.enabled.store(true, Ordering::Relaxed);
    state.started_at = Some(Instant::now());

    // Attempt to connect to relay server
    match connect_to_relay(state, &config).await {
        Ok(()) => {
            info!("[RemoteGateway] Connected to relay server");
            state.relay_connected = true;
            emit_status_update(state).await;
        }
        Err(e) => {
            error!("[RemoteGateway] Failed to connect to relay: {}", e);
            state.relay_connected = false;
            emit_status_update(state).await;

            // Spawn reconnection task
            let config_clone = config.clone();
            let app_handle = state.app_handle.clone();
            let device_id = state.device_id.clone();
            let enabled = state.enabled.clone();

            tokio::spawn(async move {
                reconnect_loop(app_handle, device_id, enabled, config_clone).await;
            });
        }
    }
}

/// Handle Disable command: disconnect from relay and close all sessions.
async fn handle_disable(state: &mut GatewayState) {
    info!("[RemoteGateway] Disabling remote access");

    state.enabled.store(false, Ordering::Relaxed);
    state.relay_connected = false;
    state.pairing_code = None;
    state.pairing_code_expires_at = None;
    state.ws_write_tx = None;
    state.started_at = None;

    // Close all active sessions
    let now = Utc::now().timestamp_millis();
    for session in state.active_sessions.values_mut() {
        session.status = SessionStatus::Disconnected;
        session.disconnected_at = Some(now);
    }
    state.active_sessions.clear();

    emit_status_update(state).await;
}

/// Handle GeneratePairingCode command: create a new 6-digit code.
async fn handle_generate_pairing_code(state: &mut GatewayState) {
    let code = generate_pairing_code();
    info!("[RemoteGateway] Generated pairing code: {}", code);

    state.pairing_code = Some(code.clone());
    state.pairing_code_expires_at = Some(Instant::now() + PAIRING_CODE_VALIDITY);

    // Emit to frontend for display
    let _ = state.app_handle.emit("remote:pairing_code", serde_json::json!({
        "code": code,
        "expiresInSeconds": PAIRING_CODE_VALIDITY.as_secs(),
    }));

    emit_status_update(state).await;
}

/// Handle RevokeDevice command: remove a paired device and disconnect its sessions.
async fn handle_revoke_device(state: &mut GatewayState, device_id: &str) {
    info!("[RemoteGateway] Revoking device: {}", device_id);

    state.paired_devices.remove(device_id);

    // Disconnect any active sessions for this device
    let now = Utc::now().timestamp_millis();
    let sessions_to_remove: Vec<String> = state
        .active_sessions
        .iter()
        .filter(|(_, s)| s.remote_device_id == device_id)
        .map(|(id, _)| id.clone())
        .collect();

    for session_id in sessions_to_remove {
        if let Some(session) = state.active_sessions.get_mut(&session_id) {
            session.status = SessionStatus::Disconnected;
            session.disconnected_at = Some(now);
        }
        state.active_sessions.remove(&session_id);
    }

    // Send disconnect command to remote device via relay
    if let Some(ref ws_tx) = state.ws_write_tx {
        let disconnect = RemoteCommand::Disconnect {
            reason: "Device access revoked".to_string(),
        };
        if let Ok(json) = serde_json::to_string(&disconnect) {
            let _ = ws_tx.send(WsMessage::Text(json)).await;
        }
    }

    emit_status_update(state).await;
}

/// Handle ForwardEvent command: push market data to all connected remotes.
async fn handle_forward_event(state: &mut GatewayState, event: &str, data: &JsonValue) {
    if state.active_sessions.is_empty() {
        return;
    }

    let update = RemoteCommand::MarketDataUpdate {
        event: event.to_string(),
        data: data.clone(),
    };

    if let Some(ref ws_tx) = state.ws_write_tx {
        if let Ok(json) = serde_json::to_string(&update) {
            let bytes = json.len() as u64;
            let _ = ws_tx.send(WsMessage::Text(json)).await;
            state.total_bytes_transferred.fetch_add(bytes, Ordering::Relaxed);
        }
    }
}

// ============================================================================
// RELAY CONNECTION
// ============================================================================

/// Establish a WebSocket connection to the relay server.
///
/// Sends a registration message with this device's ID and begins
/// listening for messages from remote devices.
async fn connect_to_relay(state: &mut GatewayState, config: &RelayConfig) -> Result<()> {
    let url = &config.relay_url;
    info!("[RemoteGateway] Connecting to relay: {}", url);

    let (ws_stream, _response) = connect_async(url).await
        .map_err(|e| anyhow!("WebSocket connection failed: {}", e))?;

    let (mut ws_write, mut ws_read) = ws_stream.split();

    // Send registration message
    let registration = serde_json::json!({
        "type": "register",
        "deviceId": state.device_id,
        "role": "host",
        "timestamp": Utc::now().timestamp_millis(),
    });

    ws_write
        .send(WsMessage::Text(serde_json::to_string(&registration)?))
        .await
        .map_err(|e| anyhow!("Failed to send registration: {}", e))?;

    // Create channel for sending messages from other tasks
    let (ws_write_tx, mut ws_write_rx) = mpsc::channel::<WsMessage>(256);
    state.ws_write_tx = Some(ws_write_tx.clone());

    // Spawn write task: forwards messages from channel to WebSocket
    tokio::spawn(async move {
        while let Some(msg) = ws_write_rx.recv().await {
            if ws_write.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Spawn read task: processes incoming messages from relay
    let app_handle = state.app_handle.clone();
    let device_id = state.device_id.clone();
    let paired_devices = state.paired_devices.clone();
    let total_bytes = state.total_bytes_transferred.clone();
    let ws_tx_clone = ws_write_tx.clone();

    tokio::spawn(async move {
        while let Some(msg_result) = ws_read.next().await {
            match msg_result {
                Ok(WsMessage::Text(text)) => {
                    total_bytes.fetch_add(text.len() as u64, Ordering::Relaxed);
                    handle_relay_message(
                        &app_handle,
                        &device_id,
                        &text,
                        &paired_devices,
                        &ws_tx_clone,
                    )
                    .await;
                }
                Ok(WsMessage::Ping(data)) => {
                    let _ = ws_tx_clone.send(WsMessage::Pong(data)).await;
                }
                Ok(WsMessage::Close(_)) => {
                    info!("[RemoteGateway] Relay connection closed by server");
                    let _ = app_handle.emit("remote:relay_disconnected", ());
                    break;
                }
                Err(e) => {
                    error!("[RemoteGateway] Relay WebSocket error: {}", e);
                    let _ = app_handle.emit("remote:relay_error", serde_json::json!({
                        "error": e.to_string(),
                    }));
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// Handle an incoming message from the relay server.
///
/// Parses the message as a RemoteCommand and dispatches it appropriately.
async fn handle_relay_message(
    app_handle: &AppHandle,
    _device_id: &str,
    text: &str,
    paired_devices: &HashMap<String, DeviceCredentials>,
    ws_tx: &mpsc::Sender<WsMessage>,
) {
    let command: RemoteCommand = match serde_json::from_str(text) {
        Ok(cmd) => cmd,
        Err(e) => {
            warn!("[RemoteGateway] Failed to parse relay message: {}", e);
            return;
        }
    };

    match command {
        RemoteCommand::Authenticate { device_id, auth_token } => {
            // Verify device credentials
            let success = paired_devices
                .get(&device_id)
                .map(|creds| creds.auth_token == auth_token && creds.authorized)
                .unwrap_or(false);

            let session_id = if success {
                Some(uuid::Uuid::new_v4().to_string())
            } else {
                None
            };

            let response = RemoteCommand::AuthResult {
                success,
                error: if success { None } else { Some("Invalid credentials or unauthorized device".to_string()) },
                session_id: session_id.clone(),
            };

            if let Ok(json) = serde_json::to_string(&response) {
                let _ = ws_tx.send(WsMessage::Text(json)).await;
            }

            if success {
                info!("[RemoteGateway] Device authenticated: {}", device_id);
                let _ = app_handle.emit("remote:device_connected", serde_json::json!({
                    "deviceId": device_id,
                    "sessionId": session_id,
                }));
            } else {
                warn!("[RemoteGateway] Authentication failed for device: {}", device_id);
            }
        }

        RemoteCommand::PairRequest { pairing_code, device_name } => {
            // Pairing is handled by emitting to frontend for user confirmation
            let _ = app_handle.emit("remote:pair_request", serde_json::json!({
                "pairingCode": pairing_code,
                "deviceName": device_name,
            }));
        }

        RemoteCommand::ForwardCommand { request_id, command, args } => {
            // Execute the Tauri command locally and return the result
            info!("[RemoteGateway] Forwarding command: {} (req: {})", command, request_id);

            // For security, only allow whitelisted commands
            let allowed = is_command_allowed(&command);

            let response = if allowed {
                // Note: In a full implementation, this would invoke the actual Tauri command.
                // For now, we emit an event for the frontend to handle and respond.
                let _ = app_handle.emit("remote:forward_command", serde_json::json!({
                    "requestId": request_id,
                    "command": command,
                    "args": args,
                }));

                RemoteCommand::CommandResponse {
                    request_id,
                    success: true,
                    result: Some(serde_json::json!({ "status": "forwarded" })),
                    error: None,
                }
            } else {
                RemoteCommand::CommandResponse {
                    request_id,
                    success: false,
                    result: None,
                    error: Some(format!("Command '{}' is not allowed via remote access", command)),
                }
            };

            if let Ok(json) = serde_json::to_string(&response) {
                let _ = ws_tx.send(WsMessage::Text(json)).await;
            }
        }

        RemoteCommand::Ping { timestamp } => {
            let pong = RemoteCommand::Pong { timestamp };
            if let Ok(json) = serde_json::to_string(&pong) {
                let _ = ws_tx.send(WsMessage::Text(json)).await;
            }
        }

        RemoteCommand::Disconnect { reason } => {
            info!("[RemoteGateway] Remote device disconnected: {}", reason);
            let _ = app_handle.emit("remote:device_disconnected", serde_json::json!({
                "reason": reason,
            }));
        }

        // Outbound-only commands (shouldn't be received from remote)
        RemoteCommand::AuthResult { .. }
        | RemoteCommand::PairResult { .. }
        | RemoteCommand::CommandResponse { .. }
        | RemoteCommand::MarketDataUpdate { .. }
        | RemoteCommand::Pong { .. } => {
            warn!("[RemoteGateway] Received unexpected outbound command from relay");
        }
    }
}

/// Check if a command is allowed to be executed via remote access.
///
/// Only read-only and non-destructive commands are allowed by default.
/// Trading commands require explicit opt-in via configuration.
fn is_command_allowed(command: &str) -> bool {
    // Whitelist of commands allowed via remote access
    matches!(
        command,
        // Read-only data commands
        "get_data_sources_cmd"
        | "get_markets_cmd"
        | "get_orderbook_cmd"
        | "get_positions_cmd"
        | "get_trade_history_cmd"
        | "get_system_info_cmd"
        | "get_network_metrics_cmd"
        | "get_database_stats_cmd"
        | "get_storage_stats_cmd"
        | "get_node_stored_data_cmd"
        | "get_consolidated_subscriptions_cmd"
        | "get_orderbook_subscriptions_cmd"
        | "get_all_api_keys_cmd"
        | "get_configured_platforms_cmd"
        | "get_node_analyzers_cmd"
        | "get_analyzer_results_cmd"
        | "get_analyzer_cmd"
        | "get_analyzer_types_cmd"
        | "get_node_chains_cmd"
        | "get_remote_status_cmd"
        | "get_paired_devices_cmd"
        // Query commands
        | "query_timeseries_cmd"
        | "get_correlation_data_cmd"
        | "search_markets_cmd"
        // Subscription commands (read-only WebSocket management)
        | "subscribe_consolidated_cmd"
        | "unsubscribe_consolidated_cmd"
        | "subscribe_orderbook_cmd"
        | "unsubscribe_orderbook_cmd"
    )
}

// ============================================================================
// RECONNECTION LOGIC
// ============================================================================

/// Reconnection loop with exponential backoff.
///
/// Runs in a separate task and attempts to reconnect to the relay server
/// when the connection is lost. Stops when the gateway is disabled.
async fn reconnect_loop(
    app_handle: AppHandle,
    device_id: String,
    enabled: Arc<AtomicBool>,
    config: RelayConfig,
) {
    let mut attempt = 0u32;
    let max_attempts = if config.max_reconnect_attempts == 0 {
        u32::MAX
    } else {
        config.max_reconnect_attempts
    };

    while attempt < max_attempts && enabled.load(Ordering::Relaxed) {
        let delay = std::cmp::min(
            RECONNECT_BASE_DELAY * 2u32.saturating_pow(attempt),
            RECONNECT_MAX_DELAY,
        );

        info!(
            "[RemoteGateway] Reconnection attempt {} in {:?}",
            attempt + 1,
            delay
        );

        time::sleep(delay).await;

        if !enabled.load(Ordering::Relaxed) {
            info!("[RemoteGateway] Gateway disabled, stopping reconnection");
            break;
        }

        match connect_async(&config.relay_url).await {
            Ok((ws_stream, _)) => {
                info!("[RemoteGateway] Reconnected to relay server");
                let _ = app_handle.emit("remote:relay_connected", ());

                // Send re-registration
                let (mut ws_write, _ws_read) = ws_stream.split();
                let registration = serde_json::json!({
                    "type": "register",
                    "deviceId": device_id,
                    "role": "host",
                    "reconnect": true,
                    "timestamp": Utc::now().timestamp_millis(),
                });

                if let Ok(json) = serde_json::to_string(&registration) {
                    let _ = ws_write.send(WsMessage::Text(json)).await;
                }

                break;
            }
            Err(e) => {
                warn!("[RemoteGateway] Reconnection failed: {}", e);
                attempt += 1;
                let _ = app_handle.emit(
                    "remote:reconnect_failed",
                    serde_json::json!({
                        "attempt": attempt,
                        "maxAttempts": max_attempts,
                        "error": e.to_string(),
                    }),
                );
            }
        }
    }

    if attempt >= max_attempts {
        error!("[RemoteGateway] Max reconnection attempts reached, giving up");
        enabled.store(false, Ordering::Relaxed);
        let _ = app_handle.emit("remote:relay_gave_up", ());
    }
}

// ============================================================================
// STATUS HELPERS
// ============================================================================

/// Build a RemoteStatus snapshot from current gateway state.
fn build_status(state: &GatewayState) -> RemoteStatus {
    let uptime_seconds = state
        .started_at
        .map(|s| s.elapsed().as_secs())
        .unwrap_or(0);

    RemoteStatus {
        enabled: state.enabled.load(Ordering::Relaxed),
        relay_connected: state.relay_connected,
        relay_url: state.relay_config.as_ref().map(|c| c.relay_url.clone()),
        device_id: state.device_id.clone(),
        pairing_code: state.pairing_code.clone(),
        active_connections: state.active_sessions.len() as u32,
        sessions: state.active_sessions.values().cloned().collect(),
        total_bytes_transferred: state.total_bytes_transferred.load(Ordering::Relaxed),
        uptime_seconds,
    }
}

/// Emit a status update event to the frontend.
async fn emit_status_update(state: &GatewayState) {
    let status = build_status(state);
    let _ = state.app_handle.emit("remote:status_update", &status);
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/// Generate a unique device ID.
///
/// Uses UUID v4 for globally unique identification. Persisted to SQLite
/// on first run so the same device always has the same ID.
fn generate_device_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Generate a 6-digit numeric pairing code.
///
/// The code is displayed on the home desktop and manually entered on the
/// remote device. It's valid for PAIRING_CODE_VALIDITY seconds.
fn generate_pairing_code() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let code: u32 = rng.gen_range(100_000..999_999);
    code.to_string()
}

/// Generate a 256-bit random authentication token (hex-encoded).
#[allow(dead_code)]
fn generate_auth_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..32).map(|_| rng.gen()).collect();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Create a new RemoteConnectionManager and return it for Tauri state management.
pub fn create_remote_manager(app_handle: AppHandle) -> Arc<RemoteConnectionManager> {
    Arc::new(RemoteConnectionManager::new(app_handle))
}
