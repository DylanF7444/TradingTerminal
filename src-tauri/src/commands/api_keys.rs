// ============================================================================
// API KEY MANAGEMENT COMMAND HANDLERS
// ============================================================================
//
// Module: commands/api_keys.rs
// Purpose: Tauri command handlers for secure API key storage and retrieval
//
// OVERVIEW:
// This module provides secure storage and retrieval of API credentials for
// prediction market platforms (Polymarket, Kalshi). Keys are stored in the
// local SQLite database and can be retrieved when adding new markets without
// requiring re-entry.
//
// SECURITY MODEL:
// - API keys are stored in the local SQLite database
// - Keys are transmitted over Tauri IPC (secure, not HTTP)
// - Frontend never persists keys in localStorage or Redux
// - Keys are only returned to frontend when explicitly requested
// - Consider adding encryption at rest for production use
//
// COMMANDS:
// 1. save_api_key_cmd - Store credentials for a platform
// 2. get_api_key_cmd - Retrieve credentials for a platform
// 3. get_all_api_keys_cmd - List all stored credentials (for UI display)
// 4. delete_api_key_cmd - Remove credentials for a platform
// 5. has_api_key_cmd - Check if credentials exist for a platform
// 6. get_configured_platforms_cmd - Get list of platforms with stored keys
//
// USAGE FLOW:
// 1. User opens Settings/API Keys panel
// 2. User enters API credentials for Polymarket or Kalshi
// 3. Frontend calls save_api_key_cmd with platform and credentials
// 4. Keys stored in database
// 5. When user adds a market, frontend checks has_api_key_cmd
// 6. If keys exist, they're pre-populated or used automatically
// 7. User can still override if needed
//
// ============================================================================

use crate::db::{get_connection, save_api_key, get_api_key, get_all_api_keys, delete_api_key, has_api_key, get_configured_platforms, ApiKeyData, StoredApiKey};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::State;
use tokio::sync::Mutex;
use std::sync::Arc;
use rusqlite::Connection;

// ============================================================================
// DATA STRUCTURES
// ============================================================================

/// Request payload for saving an API key
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveApiKeyRequest {
    pub platform: String,
    pub api_key: String,
    pub api_secret: Option<String>,
    pub private_key: Option<String>,
    pub environment: Option<String>,
    pub additional_config: Option<JsonValue>,
}

/// Response for API key retrieval (includes sensitive data)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeyResponse {
    pub platform: String,
    pub has_key: bool,
    pub api_key: Option<String>,
    pub api_secret: Option<String>,
    pub private_key: Option<String>,
    pub environment: Option<String>,
    pub additional_config: Option<JsonValue>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}

/// Response for listing API keys (without sensitive data for security)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeySummary {
    pub platform: String,
    pub has_key: bool,
    pub has_api_key: bool,
    pub has_api_secret: bool,
    pub has_private_key: bool,
    pub environment: String,
    pub created_at: i64,
    pub updated_at: i64,
}

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

/// Save API key for a platform
/// 
/// Stores credentials securely in the database. If credentials already exist
/// for the platform, they will be updated.
/// 
/// # Arguments
/// * `platform` - "Polymarket" or "Kalshi"
/// * `api_key` - The API key from the platform
/// * `api_secret` - Optional API secret (required for Kalshi)
/// * `private_key` - Optional private key (for Polymarket blockchain signing)
/// * `environment` - "demo" or "production"
/// * `additional_config` - Optional JSON config for platform-specific settings
pub async fn save_api_key_command(
    request: SaveApiKeyRequest,
) -> Result<(), String> {
    println!("Saving API key for platform: {}", request.platform);
    
    // Validate platform
    if request.platform != "Polymarket" && request.platform != "Kalshi" {
        return Err("Invalid platform. Must be 'Polymarket' or 'Kalshi'".to_string());
    }
    
    // Validate required fields
    if request.api_key.is_empty() {
        return Err("API key is required".to_string());
    }
    
    // Kalshi requires private key for RSA-PSS signing
    if request.platform == "Kalshi" && request.private_key.is_none() {
        return Err("Private key is required for Kalshi (used for RSA-PSS signing)".to_string());
    }
    
    // Get database connection
    let db = get_connection().await
        .map_err(|e| format!("Database error: {}", e))?;
    
    let db_guard = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    let conn = db_guard.as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;
    
    // Create API key data
    let key_data = ApiKeyData {
        api_key: request.api_key,
        api_secret: request.api_secret,
        private_key: request.private_key,
        environment: request.environment,
        additional_config: request.additional_config,
    };
    
    // Save to database
    save_api_key(conn, &request.platform, &key_data)
        .map_err(|e| format!("Failed to save API key: {}", e))?;
    
    println!("API key saved successfully for platform: {}", request.platform);
    Ok(())
}

/// Get API key for a platform
/// 
/// Returns the full credentials for a platform. Use with caution as this
/// returns sensitive data.
pub async fn get_api_key_command(platform: String) -> Result<ApiKeyResponse, String> {
    println!("Retrieving API key for platform: {}", platform);
    
    // Get database connection
    let db = get_connection().await
        .map_err(|e| format!("Database error: {}", e))?;
    
    let db_guard = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    let conn = db_guard.as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;
    
    // Get from database
    match get_api_key(conn, &platform)
        .map_err(|e| format!("Failed to get API key: {}", e))?
    {
        Some(key) => Ok(ApiKeyResponse {
            platform: key.platform,
            has_key: true,
            api_key: Some(key.api_key),
            api_secret: key.api_secret,
            private_key: key.private_key,
            environment: Some(key.environment),
            additional_config: key.additional_config,
            created_at: Some(key.created_at),
            updated_at: Some(key.updated_at),
        }),
        None => Ok(ApiKeyResponse {
            platform,
            has_key: false,
            api_key: None,
            api_secret: None,
            private_key: None,
            environment: None,
            additional_config: None,
            created_at: None,
            updated_at: None,
        }),
    }
}

/// Get all API keys (summary only, no sensitive data)
/// 
/// Returns a list of all configured platforms with metadata but without
/// the actual API keys. Use this for displaying the list of configured
/// platforms in the UI.
pub async fn get_all_api_keys_command() -> Result<Vec<ApiKeySummary>, String> {
    println!("Retrieving all API keys summary");
    
    // Get database connection
    let db = get_connection().await
        .map_err(|e| format!("Database error: {}", e))?;
    
    let db_guard = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    let conn = db_guard.as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;
    
    // Get all keys from database
    let keys = get_all_api_keys(conn)
        .map_err(|e| format!("Failed to get API keys: {}", e))?;
    
    // Convert to summary (without sensitive data)
    let summaries: Vec<ApiKeySummary> = keys.into_iter().map(|key| {
        ApiKeySummary {
            platform: key.platform,
            has_key: true,
            has_api_key: !key.api_key.is_empty(),
            has_api_secret: key.api_secret.is_some(),
            has_private_key: key.private_key.is_some(),
            environment: key.environment,
            created_at: key.created_at,
            updated_at: key.updated_at,
        }
    }).collect();
    
    Ok(summaries)
}

/// Delete API key for a platform
pub async fn delete_api_key_command(platform: String) -> Result<bool, String> {
    println!("Deleting API key for platform: {}", platform);
    
    // Get database connection
    let db = get_connection().await
        .map_err(|e| format!("Database error: {}", e))?;
    
    let db_guard = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    let conn = db_guard.as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;
    
    // Delete from database
    let deleted = delete_api_key(conn, &platform)
        .map_err(|e| format!("Failed to delete API key: {}", e))?;
    
    if deleted {
        println!("API key deleted for platform: {}", platform);
    } else {
        println!("No API key found to delete for platform: {}", platform);
    }
    
    Ok(deleted)
}

/// Check if API key exists for a platform
pub async fn has_api_key_command(platform: String) -> Result<bool, String> {
    // Get database connection
    let db = get_connection().await
        .map_err(|e| format!("Database error: {}", e))?;
    
    let db_guard = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    let conn = db_guard.as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;
    
    // Check if key exists
    has_api_key(conn, &platform)
        .map_err(|e| format!("Failed to check API key: {}", e))
}

/// Get list of platforms with configured API keys
pub async fn get_configured_platforms_command() -> Result<Vec<String>, String> {
    // Get database connection
    let db = get_connection().await
        .map_err(|e| format!("Database error: {}", e))?;
    
    let db_guard = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    let conn = db_guard.as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;
    
    // Get configured platforms
    get_configured_platforms(conn)
        .map_err(|e| format!("Failed to get configured platforms: {}", e))
}