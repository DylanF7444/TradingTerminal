// ============================================================================
// ANALYZER COMMANDS
// ============================================================================
//
// Module: commands/analyzers.rs
// Purpose: Tauri IPC commands for managing analyzer nodes from the frontend
//
// All commands follow the project naming convention:
// - Logic defined here (e.g., create_analyzer)
// - Wrapper in main.rs with _cmd suffix (e.g., create_analyzer_cmd)
// ============================================================================

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::models::analyzer_node::{AnalyzerChain, AnalyzerNode, AnalyzerResult, AnalyzerType};

// ============================================================================
// REQUEST / RESPONSE TYPES
// ============================================================================

/// Request to create a new analyzer attached to a node
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateAnalyzerRequest {
    pub node_id: String,
    pub analyzer_type: String,
    pub name: String,
    pub config: Option<JsonValue>,
}

/// Request to update an existing analyzer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateAnalyzerRequest {
    pub analyzer_id: String,
    pub config: JsonValue,
}

/// Request to create a chain between two analyzers
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateChainRequest {
    pub source_analyzer_id: String,
    pub target_analyzer_id: String,
    pub transform: Option<String>,
}

/// Analyzer status response for the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyzerStatusResponse {
    pub analyzer: AnalyzerNode,
    pub status: JsonValue,
    pub latest_result: Option<AnalyzerResult>,
}

// ============================================================================
// COMMAND IMPLEMENTATIONS
// ============================================================================

/// Create and attach an analyzer to a graph node
pub async fn create_analyzer(
    db: std::sync::Arc<tokio::sync::Mutex<crate::db::sqlite::Connection>>,
    request: CreateAnalyzerRequest,
) -> Result<AnalyzerNode, String> {
    let analyzer_type = AnalyzerType::from_str(&request.analyzer_type)
        .ok_or_else(|| format!("Invalid analyzer type: {}", request.analyzer_type))?;

    let config = request.config
        .unwrap_or_else(|| AnalyzerNode::default_config(&analyzer_type));

    let analyzer_node = AnalyzerNode::new(
        request.node_id,
        analyzer_type,
        request.name,
        config,
    );

    // Persist to database
    {
        let db_guard = db.lock().await;
        crate::db::sqlite::insert_analyzer_node(&db_guard, &analyzer_node)
            .map_err(|e| format!("Failed to save analyzer: {}", e))?;
    }

    Ok(analyzer_node)
}

/// Update an existing analyzer's configuration
pub async fn update_analyzer(
    db: std::sync::Arc<tokio::sync::Mutex<crate::db::sqlite::Connection>>,
    request: UpdateAnalyzerRequest,
) -> Result<(), String> {
    let db_guard = db.lock().await;
    crate::db::sqlite::update_analyzer_node_config(&db_guard, &request.analyzer_id, &request.config)
        .map_err(|e| format!("Failed to update analyzer: {}", e))
}

/// Delete an analyzer
pub async fn delete_analyzer(
    db: std::sync::Arc<tokio::sync::Mutex<crate::db::sqlite::Connection>>,
    analyzer_id: String,
) -> Result<(), String> {
    let db_guard = db.lock().await;
    crate::db::sqlite::delete_analyzer_node(&db_guard, &analyzer_id)
        .map_err(|e| format!("Failed to delete analyzer: {}", e))
}

/// Get all analyzers attached to a specific node
pub async fn get_node_analyzers(
    db: std::sync::Arc<tokio::sync::Mutex<crate::db::sqlite::Connection>>,
    node_id: String,
) -> Result<Vec<AnalyzerNode>, String> {
    let db_guard = db.lock().await;
    crate::db::sqlite::get_analyzers_for_node(&db_guard, &node_id)
        .map_err(|e| format!("Failed to get analyzers: {}", e))
}

/// Get analysis results for an analyzer within a time range
pub async fn get_analyzer_results(
    db: std::sync::Arc<tokio::sync::Mutex<crate::db::sqlite::Connection>>,
    analyzer_id: String,
    start_time: Option<i64>,
    end_time: Option<i64>,
    limit: Option<usize>,
) -> Result<Vec<AnalyzerResult>, String> {
    let db_guard = db.lock().await;
    crate::db::sqlite::get_analyzer_results(&db_guard, &analyzer_id, start_time, end_time, limit)
        .map_err(|e| format!("Failed to get results: {}", e))
}

/// Get a single analyzer by ID
pub async fn get_analyzer(
    db: std::sync::Arc<tokio::sync::Mutex<crate::db::sqlite::Connection>>,
    analyzer_id: String,
) -> Result<Option<AnalyzerNode>, String> {
    let db_guard = db.lock().await;
    crate::db::sqlite::get_analyzer_by_id(&db_guard, &analyzer_id)
        .map_err(|e| format!("Failed to get analyzer: {}", e))
}

/// Toggle an analyzer's enabled state
pub async fn toggle_analyzer(
    db: std::sync::Arc<tokio::sync::Mutex<crate::db::sqlite::Connection>>,
    analyzer_id: String,
    enabled: bool,
) -> Result<(), String> {
    let db_guard = db.lock().await;
    crate::db::sqlite::set_analyzer_enabled(&db_guard, &analyzer_id, enabled)
        .map_err(|e| format!("Failed to toggle analyzer: {}", e))
}

/// Create a chain between two analyzers
pub async fn create_chain(
    db: std::sync::Arc<tokio::sync::Mutex<crate::db::sqlite::Connection>>,
    request: CreateChainRequest,
) -> Result<AnalyzerChain, String> {
    let chain = AnalyzerChain {
        id: uuid::Uuid::new_v4().to_string(),
        source_analyzer_id: request.source_analyzer_id,
        target_analyzer_id: request.target_analyzer_id,
        transform: request.transform,
        enabled: true,
        created_at: chrono::Utc::now().timestamp(),
    };

    let db_guard = db.lock().await;
    crate::db::sqlite::insert_analyzer_chain(&db_guard, &chain)
        .map_err(|e| format!("Failed to create chain: {}", e))?;

    Ok(chain)
}

/// Delete a chain
pub async fn delete_chain(
    db: std::sync::Arc<tokio::sync::Mutex<crate::db::sqlite::Connection>>,
    chain_id: String,
) -> Result<(), String> {
    let db_guard = db.lock().await;
    crate::db::sqlite::delete_analyzer_chain(&db_guard, &chain_id)
        .map_err(|e| format!("Failed to delete chain: {}", e))
}

/// Get all chains for a node
pub async fn get_node_chains(
    db: std::sync::Arc<tokio::sync::Mutex<crate::db::sqlite::Connection>>,
    node_id: String,
) -> Result<Vec<AnalyzerChain>, String> {
    let db_guard = db.lock().await;
    crate::db::sqlite::get_chains_for_node(&db_guard, &node_id)
        .map_err(|e| format!("Failed to get chains: {}", e))
}

/// Get available analyzer types with their default configurations
pub fn get_analyzer_types() -> Vec<JsonValue> {
    let types = vec![
        AnalyzerType::Correlation,
        AnalyzerType::Momentum,
        AnalyzerType::Arbitrage,
        AnalyzerType::Sentiment,
        AnalyzerType::RSI,
        AnalyzerType::Volatility,
    ];

    types.iter().map(|t| {
        serde_json::json!({
            "type": t.to_string(),
            "default_config": AnalyzerNode::default_config(t),
            "description": match t {
                AnalyzerType::Correlation => "Tracks correlation between data sources",
                AnalyzerType::Momentum => "EMA-based momentum detection",
                AnalyzerType::Arbitrage => "Price discrepancy detection between markets",
                AnalyzerType::Sentiment => "News/social media sentiment scoring",
                AnalyzerType::RSI => "Overbought/oversold detection (0-100)",
                AnalyzerType::Volatility => "Price volatility measurement",
                AnalyzerType::Custom => "User-defined analysis",
            }
        })
    }).collect()
}
