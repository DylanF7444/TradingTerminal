// ============================================================================
// REMOTE ACCESS COMMANDS
// ============================================================================
//
// Module: commands/remote.rs
// Purpose: Tauri IPC command handlers for remote desktop gateway management
//
// OVERVIEW:
// Exposes the remote gateway service to the React frontend via Tauri's invoke
// system. These commands allow users to enable/disable remote access, manage
// device pairing, monitor connection status, and configure relay settings.
//
// ARCHITECTURE:
// Frontend (React) --invoke()--> Commands (this) --channel--> Gateway Service
//
// All commands follow the _cmd suffix convention required by this codebase.
// They receive the RemoteConnectionManager from Tauri managed state and
// delegate to the gateway service via async channels.
//
// SECURITY:
// - Pairing codes are only displayed on the home desktop (physical access required)
// - Auth tokens are never exposed to the frontend (only existence is confirmed)
// - Device revocation immediately disconnects the remote device
// - Relay URL changes require explicit user action
//
// COMMAND NAMING CONVENTION:
// All commands registered in main.rs use the `_cmd` suffix:
//   - enable_remote_access_cmd
//   - disable_remote_access_cmd
//   - get_remote_status_cmd
//   - generate_pairing_code_cmd
//   - revoke_remote_device_cmd
//   - get_paired_devices_cmd
//   - update_relay_config_cmd
//
// FRONTEND USAGE:
//   await invoke('enable_remote_access_cmd', { relayUrl: 'wss://...' })
//   await invoke('get_remote_status_cmd')
//   await invoke('generate_pairing_code_cmd')
// ============================================================================

use std::sync::Arc;
use log::info;
use serde::{Serialize, Deserialize};

use crate::models::remote::{
    RemoteStatus, DeviceCredentials, RelayConfig,
};
use crate::services::remote_gateway::RemoteConnectionManager;

// ============================================================================
// REQUEST/RESPONSE TYPES
// ============================================================================

/// Request to enable remote access with relay configuration.
///
/// Sent from frontend when user toggles remote access on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnableRemoteRequest {
    /// WebSocket URL of the relay server
    pub relay_url: String,
    /// Optional authentication token for the relay server
    pub relay_auth_token: Option<String>,
    /// Heartbeat interval in seconds (default: 30)
    pub heartbeat_interval_secs: Option<u64>,
    /// Session timeout in seconds (default: 300)
    pub session_timeout_secs: Option<u64>,
}

/// Summary of a paired device (safe for frontend display).
///
/// Excludes the auth_token for security - only metadata is exposed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDeviceSummary {
    /// Device unique identifier
    pub device_id: String,
    /// Human-readable device name
    pub device_name: String,
    /// When the device was first paired (Unix epoch ms)
    pub paired_at: i64,
    /// Last successful authentication time
    pub last_auth_at: Option<i64>,
    /// Whether the device is currently authorized
    pub authorized: bool,
}

impl From<DeviceCredentials> for PairedDeviceSummary {
    fn from(creds: DeviceCredentials) -> Self {
        Self {
            device_id: creds.device_id,
            device_name: creds.device_name,
            paired_at: creds.paired_at,
            last_auth_at: creds.last_auth_at,
            authorized: creds.authorized,
        }
    }
}

// ============================================================================
// COMMAND IMPLEMENTATIONS
// ============================================================================

/// Enable remote access and connect to the relay server.
///
/// Creates a RelayConfig from the request parameters and sends an Enable
/// command to the gateway task. The gateway will attempt to connect to the
/// relay server and begin accepting remote connections.
///
/// # Arguments
/// * `request` - Relay configuration (URL, auth token, timeouts)
///
/// # Returns
/// * `Ok(RemoteStatus)` - Current gateway status after enabling
/// * `Err(String)` - Error message if enabling failed
pub async fn enable_remote_access(
    request: EnableRemoteRequest,
    manager: Arc<RemoteConnectionManager>,
) -> Result<RemoteStatus, String> {
    info!("Enabling remote access with relay: {}", request.relay_url);

    let config = RelayConfig {
        relay_url: request.relay_url,
        relay_auth_token: request.relay_auth_token,
        reconnect_interval_secs: 5,
        max_reconnect_attempts: 0, // infinite
        heartbeat_interval_secs: request.heartbeat_interval_secs.unwrap_or(30),
        session_timeout_secs: request.session_timeout_secs.unwrap_or(300),
    };

    manager.enable(config).await.map_err(|e| e.to_string())?;

    // Return current status
    manager.get_status().await.map_err(|e| e.to_string())
}

/// Disable remote access and disconnect all remote devices.
///
/// Sends a Disable command to the gateway task. All active sessions are
/// terminated and the relay connection is closed.
///
/// # Returns
/// * `Ok(())` - Gateway disabled successfully
/// * `Err(String)` - Error message if disabling failed
pub async fn disable_remote_access(
    manager: Arc<RemoteConnectionManager>,
) -> Result<(), String> {
    info!("Disabling remote access");
    manager.disable().await.map_err(|e| e.to_string())
}

/// Get the current status of the remote gateway.
///
/// Returns a snapshot of the gateway's operational state including
/// connection status, active sessions, and transfer statistics.
///
/// # Returns
/// * `Ok(RemoteStatus)` - Current gateway status
/// * `Err(String)` - Error message if status retrieval failed
pub async fn get_remote_status(
    manager: Arc<RemoteConnectionManager>,
) -> Result<RemoteStatus, String> {
    manager.get_status().await.map_err(|e| e.to_string())
}

/// Generate a new pairing code for device enrollment.
///
/// Creates a 6-digit numeric code that is displayed on the home desktop
/// UI. The remote device enters this code to initiate pairing. The code
/// expires after 5 minutes.
///
/// The code is also emitted as a `remote:pairing_code` event to the frontend.
///
/// # Returns
/// * `Ok(())` - Pairing code generated and emitted
/// * `Err(String)` - Error if gateway is not running
pub async fn generate_pairing_code(
    manager: Arc<RemoteConnectionManager>,
) -> Result<(), String> {
    info!("Generating new pairing code");
    manager.generate_pairing_code().await.map_err(|e| e.to_string())
}

/// Revoke a paired device's access and disconnect it.
///
/// Removes the device from the paired devices list and disconnects
/// any active sessions. The device will need to re-pair to connect again.
///
/// # Arguments
/// * `device_id` - UUID of the device to revoke
///
/// # Returns
/// * `Ok(())` - Device revoked successfully
/// * `Err(String)` - Error if device not found or gateway not running
pub async fn revoke_remote_device(
    device_id: String,
    manager: Arc<RemoteConnectionManager>,
) -> Result<(), String> {
    info!("Revoking remote device: {}", device_id);
    manager.revoke_device(device_id).await.map_err(|e| e.to_string())
}

/// Get all paired devices (without sensitive auth tokens).
///
/// Returns a list of all devices that have been paired with this
/// home desktop, including their current authorization status.
///
/// # Returns
/// * `Ok(Vec<PairedDeviceSummary>)` - List of paired devices
/// * `Err(String)` - Error if gateway not running
pub async fn get_paired_devices(
    manager: Arc<RemoteConnectionManager>,
) -> Result<Vec<PairedDeviceSummary>, String> {
    let devices = manager.get_paired_devices().await.map_err(|e| e.to_string())?;
    Ok(devices.into_iter().map(PairedDeviceSummary::from).collect())
}

/// Update the relay server configuration.
///
/// Changes the relay URL and/or authentication settings. If the gateway
/// is currently enabled, it will disconnect and reconnect with the new
/// configuration.
///
/// # Arguments
/// * `request` - New relay configuration
///
/// # Returns
/// * `Ok(RemoteStatus)` - Status after reconfiguration
/// * `Err(String)` - Error if reconfiguration failed
pub async fn update_relay_config(
    request: EnableRemoteRequest,
    manager: Arc<RemoteConnectionManager>,
) -> Result<RemoteStatus, String> {
    info!("Updating relay config: {}", request.relay_url);

    // Disable and re-enable with new config
    if manager.is_enabled() {
        manager.disable().await.map_err(|e| e.to_string())?;
    }

    enable_remote_access(request, manager).await
}
