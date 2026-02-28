// ============================================================================
// ORDERBOOK COMMANDS
// ============================================================================
//
// Module: commands/orderbook.rs
// Purpose: Tauri IPC commands for orderbook subscription management
//
// OVERVIEW:
// This module provides the command interface between the frontend and the
// orderbook WebSocket service. It exposes functions that can be invoked
// from the TypeScript frontend via Tauri's IPC mechanism.
//
// AVAILABLE COMMANDS:
// - subscribe_orderbook(platform, market_id) - Start WebSocket subscription
// - unsubscribe_orderbook(platform, market_id) - Stop specific subscription
// - get_orderbook_subscriptions() - List all active subscriptions
// - unsubscribe_all_orderbooks() - Stop all subscriptions
// - reconnect_orderbook(platform, market_id) - Force reconnection
//
// CONSOLIDATED STREAM MANAGER:
// The new consolidated stream manager pools WebSocket connections by platform.
// Instead of one connection per market, it maintains one connection per platform
// and multiplexes subscriptions. This reduces connection overhead and allows
// adding/removing channels without reconnecting.
//
// USAGE FROM FRONTEND:
// ```typescript
// import { invoke } from '@tauri-apps/api/core';
// 
// // Subscribe to Polymarket orderbook (uses consolidated manager)
// await invoke('subscribe_orderbook_cmd', { 
//   platform: 'polymarket', 
//   marketId: '0x123...' 
// });
//
// // Listen for updates
// import { listen } from '@tauri-apps/api/event';
// const unlisten = await listen('orderbook:update', (event) => {
//   console.log('Orderbook update:', event.payload);
// });
// ```
//
// STATE MANAGEMENT:
// OrderbookState holds the WebSocketManager which tracks all running
// WebSocket connections. State is managed by Tauri and injected into commands.
//
// ============================================================================

use std::sync::Arc;
use tauri::{AppHandle, State};
use serde::{Serialize, Deserialize};

use crate::services::orderbook::{
    ActiveSubscriptions, Platform, KalshiCredentials,
    subscribe_polymarket_orderbook,
    subscribe_polymarket_market,
    subscribe_kalshi_orderbook,
    unsubscribe_orderbook as unsubscribe_orderbook_service,
    unsubscribe_all as unsubscribe_all_service,
    get_active_subscriptions,
    create_subscriptions_state,
};
use crate::services::websocket_manager::{
    WebSocketManager, PlatformType, create_websocket_manager,
};

// ============================================================================
// TYPES
// ============================================================================

/// Platform identifier for commands
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrderbookPlatform {
    Polymarket,
    Kalshi,
    Binance,
}

impl From<OrderbookPlatform> for PlatformType {
    fn from(value: OrderbookPlatform) -> Self {
        match value {
            OrderbookPlatform::Polymarket => PlatformType::Polymarket,
            OrderbookPlatform::Kalshi => PlatformType::Kalshi,
            OrderbookPlatform::Binance => PlatformType::Binance,
        }
    }
}

impl From<OrderbookPlatform> for Platform {
    fn from(value: OrderbookPlatform) -> Self {
        match value {
            OrderbookPlatform::Polymarket => Platform::Polymarket,
            OrderbookPlatform::Kalshi => Platform::Kalshi,
            _ => Platform::Polymarket, // Default fallback
        }
    }
}

/// Subscription info returned to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionInfo {
    pub market_id: String,
    pub platform: String,
}

/// Consolidated subscription info (grouped by platform)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsolidatedSubscriptionInfo {
    pub platform: String,
    pub markets: Vec<String>,
}

/// State managed by Tauri
pub struct OrderbookState {
    /// Legacy per-market subscriptions (for backward compatibility)
    pub subscriptions: ActiveSubscriptions,
    /// New consolidated WebSocket manager
    pub ws_manager: Arc<WebSocketManager>,
}

impl OrderbookState {
    pub fn new(app_handle: AppHandle, ws_manager: Arc<WebSocketManager>) -> Self {
        Self {
            subscriptions: create_subscriptions_state(),
            ws_manager,
        }
    }
}

// ============================================================================
// CONSOLIDATED COMMANDS (NEW)
// ============================================================================

/// Subscribe to orderbook updates using the consolidated stream manager
/// 
/// This uses a single WebSocket connection per platform, multiplexing
/// subscriptions. Adding a new market to an existing platform connection
/// just sends a new subscription message without reconnecting.
/// 
/// # Arguments
/// * `platform` - Platform name: "polymarket", "kalshi", or "binance"
/// * `market_id` - Market identifier (platform-specific)
/// 
/// # Example
/// ```typescript
/// await invoke('subscribe_consolidated_cmd', {
///   platform: 'polymarket',
///   marketId: '0x123...'
/// });
/// ```
pub async fn subscribe_consolidated_cmd(
    platform: String,
    market_id: String,
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    let platform_enum = match platform.to_lowercase().as_str() {
        "polymarket" => PlatformType::Polymarket,
        "kalshi" => PlatformType::Kalshi,
        "binance" => PlatformType::Binance,
        _ => return Err(format!("Unknown platform: {}", platform)),
    };
    
    println!("[Consolidated] Subscribing to {} for market: {}", platform, market_id);
    
    match state.ws_manager.subscribe(platform_enum, market_id.clone()).await {
        Ok(_) => Ok(format!("Subscribed to {} for {}", platform, market_id)),
        Err(e) => Err(format!("Failed to subscribe: {}", e)),
    }
}

/// Unsubscribe from a market using the consolidated stream manager
/// 
/// This removes the market from the subscription list without closing
/// the WebSocket connection (unless it was the last market for that platform).
pub async fn unsubscribe_consolidated_cmd(
    platform: String,
    market_id: String,
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    let platform_enum = match platform.to_lowercase().as_str() {
        "polymarket" => PlatformType::Polymarket,
        "kalshi" => PlatformType::Kalshi,
        "binance" => PlatformType::Binance,
        _ => return Err(format!("Unknown platform: {}", platform)),
    };
    
    println!("[Consolidated] Unsubscribing from {} for market: {}", platform, market_id);
    
    match state.ws_manager.unsubscribe(platform_enum, &market_id).await {
        Ok(_) => Ok(format!("Unsubscribed from {} for {}", platform, market_id)),
        Err(e) => Err(format!("Failed to unsubscribe: {}", e)),
    }
}

/// Get all consolidated subscriptions grouped by platform
pub async fn get_consolidated_subscriptions_cmd(
    state: State<'_, OrderbookState>,
) -> Result<Vec<ConsolidatedSubscriptionInfo>, String> {
    let subs = state.ws_manager.get_subscriptions().await;
    
    Ok(subs.into_iter()
        .map(|(platform, markets)| ConsolidatedSubscriptionInfo {
            platform: platform.as_str().to_string(),
            markets,
        })
        .collect())
}

/// Unsubscribe from all markets on a platform
pub async fn unsubscribe_platform_cmd(
    platform: String,
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    let platform_enum = match platform.to_lowercase().as_str() {
        "polymarket" => PlatformType::Polymarket,
        "kalshi" => PlatformType::Kalshi,
        "binance" => PlatformType::Binance,
        _ => return Err(format!("Unknown platform: {}", platform)),
    };
    
    println!("[Consolidated] Unsubscribing from all {} markets", platform);
    
    match state.ws_manager.unsubscribe_all(platform_enum).await {
        Ok(_) => Ok(format!("Unsubscribed from all {} markets", platform)),
        Err(e) => Err(format!("Failed to unsubscribe: {}", e)),
    }
}

/// Set Kalshi credentials for authenticated WebSocket connections
pub async fn set_kalshi_credentials_cmd(
    api_key: String,
    private_key_pem: String,
    demo: bool,
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    let credentials = KalshiCredentials {
        api_key,
        private_key_pem,
        demo,
    };
    
    state.ws_manager.set_kalshi_credentials(Some(credentials)).await;
    
    Ok("Kalshi credentials set".to_string())
}

/// Clear Kalshi credentials
pub async fn clear_kalshi_credentials_cmd(
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    state.ws_manager.set_kalshi_credentials(None).await;
    Ok("Kalshi credentials cleared".to_string())
}

// ============================================================================
// LEGACY COMMANDS (BACKWARD COMPATIBLE)
// ============================================================================

/// Subscribe to orderbook updates for a market (legacy, uses per-market connections)
pub async fn subscribe_orderbook_cmd(
    platform: String,
    market_id: String,
    app_handle: AppHandle,
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    let platform_enum = match platform.to_lowercase().as_str() {
        "polymarket" => OrderbookPlatform::Polymarket,
        "kalshi" => OrderbookPlatform::Kalshi,
        _ => return Err(format!("Unknown platform: {}", platform)),
    };
    
    println!("Subscribing to {} orderbook for market: {}", platform, market_id);
    
    let result = match platform_enum {
        OrderbookPlatform::Polymarket => {
            subscribe_polymarket_orderbook(market_id.clone(), app_handle, state.subscriptions.clone())
                .await
        }
        OrderbookPlatform::Kalshi => {
            // For now, subscribe without credentials (public channels only)
            // Credentials can be added later via a separate function
            subscribe_kalshi_orderbook(market_id.clone(), app_handle, state.subscriptions.clone(), None)
                .await
        }
        _ => return Err(format!("Platform {} not supported in legacy mode", platform)),
    };
    
    match result {
        Ok(_) => Ok(format!("Subscribed to {} orderbook for {}", platform, market_id)),
        Err(e) => Err(format!("Failed to subscribe: {}", e)),
    }
}

/// Subscribe to Polymarket market updates using the ws/market endpoint
/// This uses a different subscription format (assets_ids + type: "market")
/// 
/// # Arguments
/// * `asset_ids` - List of Polymarket asset/token IDs to subscribe to
/// 
/// # Example
/// ```typescript
/// // Subscribe to BTC up/down market
/// await invoke('subscribe_polymarket_market_cmd', {
///   assetIds: [
///     '107505882767731489358349912513945399560393482969656700824895970500493757150417',
///     '7305630249804085635496399869905769372294302716159034447326228509068694952392'
///   ]
/// });
/// ```
pub async fn subscribe_polymarket_market_cmd(
    asset_ids: Vec<String>,
    app_handle: AppHandle,
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    println!("Subscribing to Polymarket market for {} assets", asset_ids.len());
    
    match subscribe_polymarket_market(asset_ids.clone(), app_handle, state.subscriptions.clone()).await {
        Ok(_) => Ok(format!("Subscribed to Polymarket market for {} assets", asset_ids.len())),
        Err(e) => Err(format!("Failed to subscribe: {}", e)),
    }
}

/// Subscribe to Kalshi orderbook with authentication (legacy)
pub async fn subscribe_kalshi_orderbook_with_auth_cmd(
    market_id: String,
    api_key: String,
    private_key_pem: String,
    demo: bool,
    app_handle: AppHandle,
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    println!("Subscribing to Kalshi orderbook with auth for market: {}", market_id);
    
    let credentials = KalshiCredentials {
        api_key,
        private_key_pem,
        demo,
    };
    
    match subscribe_kalshi_orderbook(market_id.clone(), app_handle, state.subscriptions.clone(), Some(credentials))
        .await
    {
        Ok(_) => Ok(format!("Subscribed to Kalshi orderbook for {} with authentication", market_id)),
        Err(e) => Err(format!("Failed to subscribe: {}", e)),
    }
}

/// Unsubscribe from orderbook updates for a market (legacy)
pub async fn unsubscribe_orderbook_cmd(
    market_id: String,
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    println!("Unsubscribing from orderbook for market: {}", market_id);
    
    match unsubscribe_orderbook_service(&market_id, state.subscriptions.clone()).await {
        Ok(_) => Ok(format!("Unsubscribed from orderbook for {}", market_id)),
        Err(e) => Err(format!("Failed to unsubscribe: {}", e)),
    }
}

/// Get list of active orderbook subscriptions (legacy)
pub async fn get_orderbook_subscriptions_cmd(
    state: State<'_, OrderbookState>,
) -> Result<Vec<SubscriptionInfo>, String> {
    let subs = get_active_subscriptions(state.subscriptions.clone()).await;
    
    Ok(subs.into_iter()
        .map(|(market_id, platform)| SubscriptionInfo { market_id, platform })
        .collect())
}

/// Unsubscribe from all orderbook streams (legacy)
pub async fn unsubscribe_all_orderbooks_cmd(
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    println!("Unsubscribing from all orderbooks");
    
    // Also shutdown consolidated connections
    state.ws_manager.shutdown().await;
    
    match unsubscribe_all_service(state.subscriptions.clone()).await {
        Ok(_) => Ok("Unsubscribed from all orderbooks".to_string()),
        Err(e) => Err(format!("Failed to unsubscribe: {}", e)),
    }
}

/// Reconnect a stale orderbook connection (legacy)
pub async fn reconnect_orderbook_cmd(
    market_id: String,
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    println!("Reconnecting orderbook for market: {}", market_id);
    
    let subs = state.subscriptions.read().await;
    
    if let Some(subscription) = subs.get(&market_id) {
        let _ = subscription.control_tx.send(
            crate::services::orderbook::SubscriptionControl::Reconnect
        ).await;
        Ok(format!("Reconnection triggered for {}", market_id))
    } else {
        Err(format!("No active subscription for {}", market_id))
    }
}

/// Initialize orderbook state (called from main.rs)
pub fn init_state(app_handle: AppHandle, ws_manager: Arc<WebSocketManager>) -> OrderbookState {
    OrderbookState::new(app_handle, ws_manager)
}
