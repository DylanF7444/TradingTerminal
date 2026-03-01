// ============================================================================
// ANALYZER PIPELINE SERVICE
// ============================================================================
//
// Module: services/analyzer_pipeline.rs
// Purpose: Manages analyzer instances per node, handles data routing and signal emission
//
// DATA FLOW:
// Scraper → DataEvent → AnalyzerPipeline → AnalyzerInstance → TradingSignal → Executor
//
// The pipeline maintains a map of node_id → Vec<AnalyzerInstance>.
// Each instance wraps analysis logic for a specific node.
// Supports chaining: output of one analyzer feeds into another.
// ============================================================================

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};

use crate::models::analyzer_node::{AnalyzerChain, AnalyzerNode, AnalyzerResult};
use crate::models::TradingSignal;
use crate::services::analyzer::DataEvent;
use crate::services::analyzers::{self, AnalyzerInstance};

/// The analyzer pipeline routes data events to the correct analyzer instances
/// and forwards generated signals to the executor.
pub struct AnalyzerPipeline {
    /// Map of node_id → list of analyzer instances
    node_analyzers: Arc<RwLock<HashMap<String, Vec<Box<dyn AnalyzerInstance>>>>>,

    /// Map of analyzer_id → (node_id, index) for fast lookup
    analyzer_index: Arc<RwLock<HashMap<String, (String, usize)>>>,

    /// Chaining relationships: source_analyzer_id → Vec<target_analyzer_id>
    chains: Arc<RwLock<HashMap<String, Vec<String>>>>,

    /// Channel for receiving data events from scrapers
    data_rx: mpsc::Receiver<DataEvent>,

    /// Channel for sending trading signals to executor
    signal_tx: mpsc::Sender<TradingSignal>,

    /// Channel for caching analysis results (for UI display)
    result_tx: mpsc::Sender<AnalyzerResult>,
}

impl AnalyzerPipeline {
    /// Create a new analyzer pipeline
    pub fn new(
        data_rx: mpsc::Receiver<DataEvent>,
        signal_tx: mpsc::Sender<TradingSignal>,
        result_tx: mpsc::Sender<AnalyzerResult>,
    ) -> Self {
        Self {
            node_analyzers: Arc::new(RwLock::new(HashMap::new())),
            analyzer_index: Arc::new(RwLock::new(HashMap::new())),
            chains: Arc::new(RwLock::new(HashMap::new())),
            data_rx,
            signal_tx,
            result_tx,
        }
    }

    /// Get shared handles for external management
    pub fn handles(&self) -> PipelineHandles {
        PipelineHandles {
            node_analyzers: self.node_analyzers.clone(),
            analyzer_index: self.analyzer_index.clone(),
            chains: self.chains.clone(),
        }
    }

    /// Main processing loop - consumes data events and routes to analyzers
    pub async fn run(mut self) {
        println!("AnalyzerPipeline started");

        while let Some(event) = self.data_rx.recv().await {
            self.process_event(&event).await;
        }

        println!("AnalyzerPipeline stopped");
    }

    /// Process a single data event through all relevant analyzers
    async fn process_event(&self, event: &DataEvent) {
        let mut node_analyzers = self.node_analyzers.write().await;
        let chains = self.chains.read().await;

        // Collect which analyzers are relevant for this event's source
        // Events are routed to analyzers attached to:
        // 1. The source node itself
        // 2. Any node that monitors the source node
        let mut relevant_node_ids: Vec<String> = vec![event.source_id.clone()];

        // Also check all nodes (for analyzers monitoring multiple sources)
        for node_id in node_analyzers.keys() {
            if !relevant_node_ids.contains(node_id) {
                relevant_node_ids.push(node_id.clone());
            }
        }

        let mut chained_results: Vec<(String, AnalyzerResult)> = Vec::new();

        for node_id in &relevant_node_ids {
            if let Some(analyzers) = node_analyzers.get_mut(node_id) {
                for analyzer in analyzers.iter_mut() {
                    // Process the event
                    if let Some(signal) = analyzer.process_event(event).await {
                        if let Err(e) = self.signal_tx.send(signal).await {
                            eprintln!("Failed to send signal from pipeline: {}", e);
                        }
                    }

                    // Cache latest result
                    if let Some(result) = analyzer.get_latest_result().await {
                        // Check for chains originating from this analyzer
                        let analyzer_id = analyzer.analyzer_id().to_string();
                        if let Some(targets) = chains.get(&analyzer_id) {
                            for target_id in targets {
                                chained_results.push((target_id.clone(), result.clone()));
                            }
                        }

                        // Send result for caching
                        let _ = self.result_tx.send(result).await;
                    }
                }
            }
        }

        // Process chained results
        drop(chains); // Release read lock before re-acquiring write

        for (target_analyzer_id, result) in chained_results {
            let analyzer_index = self.analyzer_index.read().await;
            if let Some((node_id, idx)) = analyzer_index.get(&target_analyzer_id) {
                let node_id = node_id.clone();
                let idx = *idx;
                drop(analyzer_index);

                if let Some(analyzers) = node_analyzers.get_mut(&node_id) {
                    if idx < analyzers.len() {
                        if let Some(signal) = analyzers[idx].process_chained_input(&result).await {
                            if let Err(e) = self.signal_tx.send(signal).await {
                                eprintln!("Failed to send chained signal: {}", e);
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Shared handles for managing the pipeline externally
#[derive(Clone)]
pub struct PipelineHandles {
    pub node_analyzers: Arc<RwLock<HashMap<String, Vec<Box<dyn AnalyzerInstance>>>>>,
    pub analyzer_index: Arc<RwLock<HashMap<String, (String, usize)>>>,
    pub chains: Arc<RwLock<HashMap<String, Vec<String>>>>,
}

impl PipelineHandles {
    /// Add an analyzer to a node
    pub async fn add_analyzer(&self, analyzer_node: &AnalyzerNode) -> Result<(), String> {
        let instance = analyzers::create_analyzer(analyzer_node)?;
        let analyzer_id = analyzer_node.id.clone();
        let node_id = analyzer_node.node_id.clone();

        let mut node_analyzers = self.node_analyzers.write().await;
        let analyzers = node_analyzers
            .entry(node_id.clone())
            .or_insert_with(Vec::new);
        let idx = analyzers.len();
        analyzers.push(instance);

        let mut index = self.analyzer_index.write().await;
        index.insert(analyzer_id, (node_id, idx));

        Ok(())
    }

    /// Remove an analyzer by ID
    pub async fn remove_analyzer(&self, analyzer_id: &str) -> Result<(), String> {
        let mut index = self.analyzer_index.write().await;
        if let Some((node_id, idx)) = index.remove(analyzer_id) {
            let mut node_analyzers = self.node_analyzers.write().await;
            if let Some(analyzers) = node_analyzers.get_mut(&node_id) {
                if idx < analyzers.len() {
                    analyzers.remove(idx);
                    // Rebuild index for this node (indices shifted)
                    for (i, analyzer) in analyzers.iter().enumerate() {
                        let aid = analyzer.analyzer_id().to_string();
                        index.insert(aid, (node_id.clone(), i));
                    }
                }
            }
            Ok(())
        } else {
            Err(format!("Analyzer not found: {}", analyzer_id))
        }
    }

    /// Update an analyzer's configuration
    pub async fn update_analyzer_config(
        &self,
        analyzer_id: &str,
        config: serde_json::Value,
    ) -> Result<(), String> {
        let index = self.analyzer_index.read().await;
        if let Some((node_id, idx)) = index.get(analyzer_id) {
            let node_id = node_id.clone();
            let idx = *idx;
            drop(index);

            let mut node_analyzers = self.node_analyzers.write().await;
            if let Some(analyzers) = node_analyzers.get_mut(&node_id) {
                if idx < analyzers.len() {
                    return analyzers[idx].update_config(config);
                }
            }
            Err(format!("Analyzer instance not found at index: {}", idx))
        } else {
            Err(format!("Analyzer not found: {}", analyzer_id))
        }
    }

    /// Get the status of all analyzers for a node
    pub async fn get_node_analyzer_statuses(&self, node_id: &str) -> Vec<serde_json::Value> {
        let node_analyzers = self.node_analyzers.read().await;
        if let Some(analyzers) = node_analyzers.get(node_id) {
            analyzers.iter().map(|a| {
                serde_json::json!({
                    "analyzer_id": a.analyzer_id(),
                    "type": format!("{:?}", a.analyzer_type()),
                    "node_id": a.node_id(),
                    "ready": a.is_ready(),
                    "status": a.status(),
                })
            }).collect()
        } else {
            Vec::new()
        }
    }

    /// Get the latest result for a specific analyzer
    pub async fn get_analyzer_result(&self, analyzer_id: &str) -> Option<AnalyzerResult> {
        let index = self.analyzer_index.read().await;
        if let Some((node_id, idx)) = index.get(analyzer_id) {
            let node_id = node_id.clone();
            let idx = *idx;
            drop(index);

            let node_analyzers = self.node_analyzers.read().await;
            if let Some(analyzers) = node_analyzers.get(&node_id) {
                if idx < analyzers.len() {
                    return analyzers[idx].get_latest_result().await;
                }
            }
        }
        None
    }

    /// Add a chain link between two analyzers
    pub async fn add_chain(&self, chain: &AnalyzerChain) {
        let mut chains = self.chains.write().await;
        chains
            .entry(chain.source_analyzer_id.clone())
            .or_insert_with(Vec::new)
            .push(chain.target_analyzer_id.clone());
    }

    /// Remove a chain link
    pub async fn remove_chain(&self, source_id: &str, target_id: &str) {
        let mut chains = self.chains.write().await;
        if let Some(targets) = chains.get_mut(source_id) {
            targets.retain(|t| t != target_id);
        }
    }

    /// Remove all analyzers for a node (cleanup on node disconnect)
    pub async fn remove_node_analyzers(&self, node_id: &str) {
        let mut node_analyzers = self.node_analyzers.write().await;
        let mut index = self.analyzer_index.write().await;
        let mut chains = self.chains.write().await;

        if let Some(analyzers) = node_analyzers.remove(node_id) {
            for analyzer in &analyzers {
                let aid = analyzer.analyzer_id().to_string();
                index.remove(&aid);
                chains.remove(&aid);
                // Also remove as target from other chains
                for targets in chains.values_mut() {
                    targets.retain(|t| t != &aid);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::analyzer_node::AnalyzerType;

    #[tokio::test]
    async fn test_add_remove_analyzer() {
        let (_data_tx, data_rx) = mpsc::channel(100);
        let (signal_tx, _signal_rx) = mpsc::channel(100);
        let (result_tx, _result_rx) = mpsc::channel(100);

        let pipeline = AnalyzerPipeline::new(data_rx, signal_tx, result_tx);
        let handles = pipeline.handles();

        let analyzer_node = AnalyzerNode::new(
            "node-1".to_string(),
            AnalyzerType::RSI,
            "Test RSI".to_string(),
            AnalyzerNode::default_config(&AnalyzerType::RSI),
        );

        // Add analyzer
        handles.add_analyzer(&analyzer_node).await.unwrap();

        let statuses = handles.get_node_analyzer_statuses("node-1").await;
        assert_eq!(statuses.len(), 1);

        // Remove analyzer
        handles.remove_analyzer(&analyzer_node.id).await.unwrap();
        let statuses = handles.get_node_analyzer_statuses("node-1").await;
        assert_eq!(statuses.len(), 0);
    }

    #[tokio::test]
    async fn test_pipeline_event_processing() {
        use crate::models::node::InfoSourceType;

        let (data_tx, data_rx) = mpsc::channel(100);
        let (signal_tx, mut signal_rx) = mpsc::channel(100);
        let (result_tx, _result_rx) = mpsc::channel(100);

        let pipeline = AnalyzerPipeline::new(data_rx, signal_tx, result_tx);
        let handles = pipeline.handles();

        // Add a momentum analyzer
        let analyzer_node = AnalyzerNode::new(
            "node-1".to_string(),
            AnalyzerType::Momentum,
            "Test Momentum".to_string(),
            serde_json::json!({
                "ema_short_period": 3,
                "ema_long_period": 5,
                "threshold": 0.001,
                "lookback_period": 50
            }),
        );
        handles.add_analyzer(&analyzer_node).await.unwrap();

        // Spawn pipeline
        tokio::spawn(pipeline.run());

        // Feed events
        for i in 0..20 {
            let event = DataEvent {
                source_id: "node-1".to_string(),
                source_type: InfoSourceType::CryptoPrices,
                metric_type: "price".to_string(),
                value: 100.0 + (i as f64 * 2.0),
                timestamp: i,
                metadata: None,
            };
            data_tx.send(event).await.unwrap();
        }

        // Give pipeline time to process
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

        // Drop sender to close pipeline
        drop(data_tx);
    }
}
