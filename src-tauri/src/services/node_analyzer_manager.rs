// ============================================================================
// NODE ANALYZER MANAGER
// ============================================================================
//
// Module: services/node_analyzer_manager.rs
// Purpose: Manages analyzer lifecycle tied to graph node events
//
// Responsibilities:
// - Start analyzers when a node connects
// - Stop analyzers when a node disconnects
// - Route data events to appropriate analyzers
// - Aggregate signals from multiple analyzers
// - Persist analyzer configurations to database
// ============================================================================

use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, RwLock};

use crate::db::sqlite::Connection;
use crate::models::analyzer_node::{AnalyzerChain, AnalyzerNode, AnalyzerResult, AnalyzerType};
use crate::models::TradingSignal;
use crate::services::analyzer::DataEvent;
use crate::services::analyzer_pipeline::PipelineHandles;

/// Manages the lifecycle of analyzers attached to graph nodes
pub struct NodeAnalyzerManager {
    /// Database connection for persistence
    db: Arc<Mutex<Connection>>,

    /// Pipeline handles for managing live analyzers
    pipeline_handles: PipelineHandles,

    /// Channel for sending data events to the pipeline
    data_tx: mpsc::Sender<DataEvent>,

    /// Result receiver for caching (runs in background)
    result_cache: Arc<RwLock<Vec<AnalyzerResult>>>,
}

impl NodeAnalyzerManager {
    /// Create a new NodeAnalyzerManager
    pub fn new(
        db: Arc<Mutex<Connection>>,
        pipeline_handles: PipelineHandles,
        data_tx: mpsc::Sender<DataEvent>,
    ) -> Self {
        Self {
            db,
            pipeline_handles,
            data_tx,
            result_cache: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Start a result cache consumer that stores results for UI retrieval
    pub fn start_result_cache(
        result_cache: Arc<RwLock<Vec<AnalyzerResult>>>,
        mut result_rx: mpsc::Receiver<AnalyzerResult>,
        db: Arc<Mutex<Connection>>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            while let Some(result) = result_rx.recv().await {
                // Store in memory cache (most recent 1000 results)
                {
                    let mut cache = result_cache.write().await;
                    cache.push(result.clone());
                    while cache.len() > 1000 {
                        cache.remove(0);
                    }
                }

                // Persist to database
                let db_guard = db.lock().await;
                let _ = crate::db::sqlite::insert_analyzer_result(&db_guard, &result);
            }
        })
    }

    /// Create and attach an analyzer to a node
    pub async fn create_analyzer(
        &self,
        node_id: String,
        analyzer_type: AnalyzerType,
        name: String,
        config: serde_json::Value,
    ) -> Result<AnalyzerNode, String> {
        let analyzer_node = AnalyzerNode::new(node_id, analyzer_type, name, config);

        // Persist to database
        {
            let db_guard = self.db.lock().await;
            crate::db::sqlite::insert_analyzer_node(&db_guard, &analyzer_node)
                .map_err(|e| format!("Failed to persist analyzer: {}", e))?;
        }

        // Add to live pipeline
        self.pipeline_handles.add_analyzer(&analyzer_node).await?;

        Ok(analyzer_node)
    }

    /// Update an existing analyzer's configuration
    pub async fn update_analyzer(
        &self,
        analyzer_id: &str,
        config: serde_json::Value,
    ) -> Result<(), String> {
        // Update in database
        {
            let db_guard = self.db.lock().await;
            crate::db::sqlite::update_analyzer_node_config(&db_guard, analyzer_id, &config)
                .map_err(|e| format!("Failed to update analyzer in DB: {}", e))?;
        }

        // Update live instance
        self.pipeline_handles
            .update_analyzer_config(analyzer_id, config)
            .await
    }

    /// Delete an analyzer
    pub async fn delete_analyzer(&self, analyzer_id: &str) -> Result<(), String> {
        // Remove from live pipeline
        self.pipeline_handles.remove_analyzer(analyzer_id).await?;

        // Remove from database
        {
            let db_guard = self.db.lock().await;
            crate::db::sqlite::delete_analyzer_node(&db_guard, analyzer_id)
                .map_err(|e| format!("Failed to delete analyzer from DB: {}", e))?;
        }

        Ok(())
    }

    /// Get all analyzers for a specific node
    pub async fn get_node_analyzers(
        &self,
        node_id: &str,
    ) -> Result<Vec<AnalyzerNode>, String> {
        let db_guard = self.db.lock().await;
        crate::db::sqlite::get_analyzers_for_node(&db_guard, node_id)
            .map_err(|e| format!("Failed to get analyzers: {}", e))
    }

    /// Get analyzer results within a time range
    pub async fn get_analyzer_results(
        &self,
        analyzer_id: &str,
        start_time: Option<i64>,
        end_time: Option<i64>,
        limit: Option<usize>,
    ) -> Result<Vec<AnalyzerResult>, String> {
        let db_guard = self.db.lock().await;
        crate::db::sqlite::get_analyzer_results(&db_guard, analyzer_id, start_time, end_time, limit)
            .map_err(|e| format!("Failed to get results: {}", e))
    }

    /// Get live status of analyzers for a node
    pub async fn get_node_analyzer_statuses(
        &self,
        node_id: &str,
    ) -> Vec<serde_json::Value> {
        self.pipeline_handles.get_node_analyzer_statuses(node_id).await
    }

    /// Route a data event to the pipeline
    pub async fn route_event(&self, event: DataEvent) -> Result<(), String> {
        self.data_tx.send(event).await
            .map_err(|e| format!("Failed to route event: {}", e))
    }

    /// Handle node connection event - start analyzers
    pub async fn on_node_connected(&self, node_id: &str) -> Result<(), String> {
        // Load saved analyzers from database and start them
        let analyzers = self.get_node_analyzers(node_id).await?;
        for analyzer_node in &analyzers {
            if analyzer_node.enabled {
                self.pipeline_handles.add_analyzer(analyzer_node).await?;
            }
        }

        // Load and apply chains
        {
            let db_guard = self.db.lock().await;
            let chains = crate::db::sqlite::get_chains_for_node(&db_guard, node_id)
                .map_err(|e| format!("Failed to load chains: {}", e))?;
            for chain in &chains {
                if chain.enabled {
                    self.pipeline_handles.add_chain(chain).await;
                }
            }
        }

        Ok(())
    }

    /// Handle node disconnect event - stop analyzers
    pub async fn on_node_disconnected(&self, node_id: &str) -> Result<(), String> {
        self.pipeline_handles.remove_node_analyzers(node_id).await;
        Ok(())
    }

    /// Create a chain between two analyzers
    pub async fn create_chain(
        &self,
        source_analyzer_id: String,
        target_analyzer_id: String,
        transform: Option<String>,
    ) -> Result<AnalyzerChain, String> {
        let chain = AnalyzerChain {
            id: uuid::Uuid::new_v4().to_string(),
            source_analyzer_id,
            target_analyzer_id,
            transform,
            enabled: true,
            created_at: chrono::Utc::now().timestamp(),
        };

        // Persist
        {
            let db_guard = self.db.lock().await;
            crate::db::sqlite::insert_analyzer_chain(&db_guard, &chain)
                .map_err(|e| format!("Failed to persist chain: {}", e))?;
        }

        // Apply to live pipeline
        self.pipeline_handles.add_chain(&chain).await;

        Ok(chain)
    }

    /// Delete a chain
    pub async fn delete_chain(&self, chain_id: &str) -> Result<(), String> {
        // Get chain info first
        let chain = {
            let db_guard = self.db.lock().await;
            crate::db::sqlite::get_chain_by_id(&db_guard, chain_id)
                .map_err(|e| format!("Failed to get chain: {}", e))?
        };

        if let Some(chain) = chain {
            // Remove from live pipeline
            self.pipeline_handles
                .remove_chain(&chain.source_analyzer_id, &chain.target_analyzer_id)
                .await;

            // Remove from database
            let db_guard = self.db.lock().await;
            crate::db::sqlite::delete_analyzer_chain(&db_guard, chain_id)
                .map_err(|e| format!("Failed to delete chain: {}", e))?;
        }

        Ok(())
    }
}
