// ============================================================================
// FED SENTIMENT ANALYZER
// ============================================================================
//
// Classifies Federal Reserve speeches as Hawkish/Neutral/Dovish.
// Used for FOMC rate decision markets on Polymarket/Kalshi.
//
// METHODOLOGY:
// Keyword scoring with configurable weights
// Aggregate score: Σ(keyword_weight) / Σ(total_words)
// Classification: > hawkish_threshold = Hawkish, < dovish_threshold = Dovish
// ============================================================================

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use std::collections::VecDeque;

use crate::models::analyzer_node::{AnalyzerResult, AnalyzerType, FedSentimentConfig};
use crate::models::market::TradeSide;
use crate::models::TradingSignal;
use crate::services::analyzer::DataEvent;
use super::AnalyzerInstance;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SentimentClass {
    Hawkish,
    Neutral,
    Dovish,
}

pub struct FedSentimentAnalyzer {
    analyzer_id: String,
    node_id: String,
    config: FedSentimentConfig,
    /// Recent speech sentiment scores
    recent_scores: VecDeque<(i64, f64)>, // (timestamp, score)
    /// Current aggregate sentiment (-1.0 to 1.0)
    current_sentiment: f64,
    /// Previous sentiment (for change detection)
    prev_sentiment: Option<f64>,
    /// Latest computed result
    latest_result: Option<AnalyzerResult>,
}

impl FedSentimentAnalyzer {
    pub fn new(analyzer_id: String, node_id: String, config: FedSentimentConfig) -> Self {
        Self {
            analyzer_id,
            node_id,
            config,
            recent_scores: VecDeque::with_capacity(50),
            current_sentiment: 0.0,
            prev_sentiment: None,
            latest_result: None,
        }
    }

    /// Score a text for hawkish/dovish sentiment
    fn score_text(&self, text: &str) -> f64 {
        let text_lower = text.to_lowercase();
        let mut score = 0.0;
        let mut matches = 0;

        // Check hawkish keywords
        for (keyword, weight) in &self.config.hawkish_keywords {
            let keyword_lower = keyword.to_lowercase();
            let count = text_lower.matches(&keyword_lower).count();
            if count > 0 {
                score += *weight * count as f64;
                matches += count;
            }
        }

        // Check dovish keywords (subtract from score)
        for (keyword, weight) in &self.config.dovish_keywords {
            let keyword_lower = keyword.to_lowercase();
            let count = text_lower.matches(&keyword_lower).count();
            if count > 0 {
                score -= *weight * count as f64;
                matches += count;
            }
        }

        // Normalize by number of matches (to avoid bias toward longer texts)
        if matches > 0 {
            score / matches as f64
        } else {
            0.0
        }
    }

    /// Classify sentiment based on score
    fn classify(&self, score: f64) -> SentimentClass {
        if score > self.config.hawkish_threshold {
            SentimentClass::Hawkish
        } else if score < self.config.dovish_threshold {
            SentimentClass::Dovish
        } else {
            SentimentClass::Neutral
        }
    }

    /// Calculate aggregate sentiment from recent scores with decay
    fn aggregate_sentiment(&self) -> f64 {
        if self.recent_scores.is_empty() {
            return 0.0;
        }

        let mut weighted_sum = 0.0;
        let mut weight_sum = 0.0;
        let decay = self.config.decay_factor;

        for (i, (_, score)) in self.recent_scores.iter().rev().enumerate() {
            let weight = decay.powi(i as i32);
            weighted_sum += score * weight;
            weight_sum += weight;
        }

        if weight_sum > 0.0 {
            weighted_sum / weight_sum
        } else {
            0.0
        }
    }
}

#[async_trait]
impl AnalyzerInstance for FedSentimentAnalyzer {
    fn analyzer_type(&self) -> AnalyzerType {
        AnalyzerType::FedSentiment
    }

    fn analyzer_id(&self) -> &str {
        &self.analyzer_id
    }

    fn node_id(&self) -> &str {
        &self.node_id
    }

    async fn process_event(&mut self, event: &DataEvent) -> Option<TradingSignal> {
        if event.source_id != self.node_id {
            return None;
        }

        // Process speech/news events
        if event.metric_type != "speech" && event.metric_type != "news" && event.metric_type != "fed_speech" {
            return None;
        }

        // Extract text content from metadata
        let text = event.metadata.as_ref()
            .and_then(|m| m.get("content"))
            .and_then(|v| v.as_str())
            .or_else(|| event.metadata.as_ref()
                .and_then(|m| m.get("text"))
                .and_then(|v| v.as_str()))
            .or_else(|| event.metadata.as_ref()
                .and_then(|m| m.get("title"))
                .and_then(|v| v.as_str()));

        let text = match text {
            Some(t) if !t.is_empty() => t,
            _ => return None,
        };

        // Score the text
        let score = self.score_text(text);
        
        // Add to recent scores
        self.recent_scores.push_back((event.timestamp, score));
        while self.recent_scores.len() > 50 {
            self.recent_scores.pop_front();
        }

        // Save previous sentiment
        self.prev_sentiment = Some(self.current_sentiment);

        // Update aggregate sentiment
        self.current_sentiment = self.aggregate_sentiment();
        let classification = self.classify(self.current_sentiment);

        // Extract speaker info if available
        let speaker = event.metadata.as_ref()
            .and_then(|m| m.get("speaker"))
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown");

        // Cache result
        self.latest_result = Some(AnalyzerResult {
            id: uuid::Uuid::new_v4().to_string(),
            analyzer_id: self.analyzer_id.clone(),
            result_type: "FedSentiment".to_string(),
            value: self.current_sentiment,
            confidence: (self.current_sentiment.abs() / self.config.hawkish_threshold).min(1.0),
            metadata: serde_json::json!({
                "sentiment_score": self.current_sentiment,
                "classification": format!("{:?}", classification),
                "latest_speech_score": score,
                "speaker": speaker,
                "recent_speech_count": self.recent_scores.len(),
                "hawkish_threshold": self.config.hawkish_threshold,
                "dovish_threshold": self.config.dovish_threshold,
            }),
            timestamp: event.timestamp,
        });

        // Check for sentiment shift that warrants a signal
        if let Some(prev) = self.prev_sentiment {
            let prev_class = self.classify(prev);
            
            // Signal on classification change
            if classification != prev_class && classification != SentimentClass::Neutral {
                let (side, confidence_boost) = match classification {
                    SentimentClass::Hawkish => (TradeSide::Buy, 1.0),  // Buy "Fed holds/hikes"
                    SentimentClass::Dovish => (TradeSide::Sell, 1.0), // Sell "Fed holds" (buy cut)
                    SentimentClass::Neutral => return None,
                };

                return Some(TradingSignal {
                    signal_id: uuid::Uuid::new_v4().to_string(),
                    strategy: "fed_sentiment".to_string(),
                    confidence: (self.current_sentiment.abs() * confidence_boost).min(1.0),
                    market_id: self.node_id.clone(),
                    side,
                    suggested_size: 100.0,
                    max_slippage: 0.02,
                    timestamp: event.timestamp,
                    metadata: serde_json::json!({
                        "prev_classification": format!("{:?}", prev_class),
                        "new_classification": format!("{:?}", classification),
                        "sentiment_score": self.current_sentiment,
                        "speech_score": score,
                        "speaker": speaker,
                        "analyzer_id": self.analyzer_id,
                    }),
                    ttl_ms: 180000, // 3 minute TTL for Fed speech reaction
                });
            }
        }

        None
    }

    async fn get_latest_result(&self) -> Option<AnalyzerResult> {
        self.latest_result.clone()
    }

    fn update_config(&mut self, config: JsonValue) -> Result<(), String> {
        self.config = serde_json::from_value(config)
            .map_err(|e| format!("Invalid Fed sentiment config: {}", e))?;
        Ok(())
    }

    fn reset(&mut self) {
        self.recent_scores.clear();
        self.current_sentiment = 0.0;
        self.prev_sentiment = None;
        self.latest_result = None;
    }

    fn is_ready(&self) -> bool {
        !self.recent_scores.is_empty()
    }

    fn status(&self) -> JsonValue {
        serde_json::json!({
            "type": "FedSentiment",
            "ready": self.is_ready(),
            "current_sentiment": self.current_sentiment,
            "classification": format!("{:?}", self.classify(self.current_sentiment)),
            "recent_speech_count": self.recent_scores.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::node::InfoSourceType;

    fn make_speech_event(source_id: &str, content: &str, ts: i64) -> DataEvent {
        DataEvent {
            source_id: source_id.to_string(),
            source_type: InfoSourceType::NewsSource,
            metric_type: "fed_speech".to_string(),
            value: 0.0,
            timestamp: ts,
            metadata: Some(serde_json::json!({
                "content": content,
                "speaker": "Powell"
            })),
        }
    }

    #[tokio::test]
    async fn test_hawkish_speech() {
        let config = FedSentimentConfig::default();
        let mut analyzer = FedSentimentAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        let hawkish_speech = "Inflation remains elevated and we may need to tighten monetary policy further. A rate hike could be necessary to maintain a restrictive stance.";
        analyzer.process_event(&make_speech_event("node-1", hawkish_speech, 0)).await;

        assert!(analyzer.current_sentiment > 0.0, "Hawkish speech should have positive score");
        assert_eq!(analyzer.classify(analyzer.current_sentiment), SentimentClass::Hawkish);
    }

    #[tokio::test]
    async fn test_dovish_speech() {
        let config = FedSentimentConfig::default();
        let mut analyzer = FedSentimentAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        let dovish_speech = "We see labor market slack developing and may need to accommodate growth. A rate cut could be appropriate to support the economy. We may pause.";
        analyzer.process_event(&make_speech_event("node-1", dovish_speech, 0)).await;

        assert!(analyzer.current_sentiment < 0.0, "Dovish speech should have negative score");
        assert_eq!(analyzer.classify(analyzer.current_sentiment), SentimentClass::Dovish);
    }
}
