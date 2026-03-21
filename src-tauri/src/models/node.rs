// ============================================================================
// NODE MODEL
// ============================================================================
//
// Purpose: Core graph data structures for the visual node-based interface.
//
// Each Node is a graph vertex representing either an information source (data
// input) or a prediction market (trading venue). Nodes have spatial positions
// for canvas rendering and an adjacency list of connections.
//
// NODE TYPES:
//   InfoSource variants: CryptoPrices, FinancialPrices, CommodityPrices,
//                        NewsSource, SocialMedia, Weather, Livestream
//   Market variants:     Polymarket, Kalshi
//
// GRAPH ARCHITECTURE:
//   - Directed graph with (x, y) positioned vertices
//   - Connections represent data flow or trading relationships
//   - Metadata (serde_json::Value) stores per-type configuration
//
// DATABASE MAPPING:
//   NodeType is stored as (type_str, subtype_str) string pairs in SQLite.
//   Conversion handled by serialize_node_type() / deserialize_node() in db/sqlite.rs.
//
// All types derive Clone + Serialize + Deserialize for async tasks, database
// storage, and Tauri IPC with the TypeScript frontend.
// ============================================================================

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

/// The core graph vertex representing either a data source or trading market
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    /// Unique identifier (UUID v4)
    pub id: String,

    /// Discriminated union of node categories
    pub node_type: NodeType,

    /// Visual position on Canvas (x, y coordinates in pixels)
    pub position: (f64, f64),

    /// Node size for resizable nodes (width, optional height)
    pub size: Option<(f64, Option<f64>)>,

    /// Graph edges: IDs of connected nodes
    pub connections: Vec<String>,

    /// Flexible configuration (scraper settings, API keys, etc.)
    pub metadata: JsonValue,
}

/// Top-level node category discriminator
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "subtype")]
pub enum NodeType {
    /// Data input source (price feeds, news, etc.)
    #[serde(rename = "InfoSource")]
    InfoSource(InfoSourceType),

    /// Prediction market trading venue
    #[serde(rename = "Market")]
    Market(MarketType),

    /// Analysis node for processing data
    #[serde(rename = "Analyzer")]
    Analyzer(super::analyzer_node::AnalyzerType),
}

/// Specific types of information sources
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum InfoSourceType {
    /// Cryptocurrency price data (Bitcoin, Ethereum, etc.)
    CryptoPrices,

    /// Traditional financial markets (stocks, forex)
    FinancialPrices,

    /// Physical commodity prices (gold, oil, agriculture)
    CommodityPrices,

    /// News articles and headlines (Reuters, AP, etc.)
    NewsSource,

    /// Social media sentiment (Twitter/X, Reddit)
    SocialMedia,

    /// Weather data (temperature, storms, natural disasters)
    Weather,

    /// Live video stream monitoring (debates, press conferences)
    Livestream,

    /// Economic indicators (CPI, unemployment, GDP)
    EconomicIndicators,

    /// On-chain metrics (transaction volume, gas fees)
    OnChainData,

    /// Polymarket user trade history (whale tracking)
    PolymarketUserTrades,
}

/// Supported prediction market platforms
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MarketType {
    /// Polymarket (Polygon blockchain-based)
    Polymarket,

    /// Kalshi (regulated US exchange)
    Kalshi,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_node_serialization() {
        let node = Node {
            id: "test-123".to_string(),
            node_type: NodeType::InfoSource(InfoSourceType::CryptoPrices),
            position: (100.0, 200.0),
            size: None,
            connections: vec!["market-456".to_string()],
            metadata: serde_json::json!({"test": "value"}),
        };

        let json = serde_json::to_string(&node).unwrap();
        assert!(json.contains("\"test-123\""));
        assert!(json.contains("CryptoPrices"));

        let deserialized: Node = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, node.id);
        assert_eq!(deserialized.position, (100.0, 200.0));
    }

    #[test]
    fn test_node_type_variants() {
        let types = vec![
            NodeType::InfoSource(InfoSourceType::CryptoPrices),
            NodeType::InfoSource(InfoSourceType::NewsSource),
            NodeType::Market(MarketType::Polymarket),
        ];

        for node_type in types {
            let json = serde_json::to_string(&node_type).unwrap();
            let _: NodeType = serde_json::from_str(&json).unwrap();
        }
    }
}
