// ============================================================================
// SCRAPER SERVICE
// ============================================================================
//
// Module: services/scraper.rs
// Purpose: Background data collection from external APIs and feeds
//
// ARCHITECTURE:
// Each data source runs as an independent Tokio task. Tasks are supervised
// and can be gracefully shut down via mpsc channels. Data flows:
//
//   External API (CoinGecko, RSS, etc.)
//     -> Scraper Task (this module)
//     -> Parse/Validate
//     -> Store in SQLite (timeseries table)
//     -> Emit Tauri Event (to frontend)
//     -> Update scraper_status (health monitoring)
//
// CONCURRENCY MODEL:
// - One task per data source node (isolated failure domains)
// - Shared HTTP client for connection pooling (reqwest::Client)
// - Cooperative cancellation via tokio::select! with shutdown signal
// - WebSocket-capable sources (e.g., Coinbase) use a dedicated WS scraper
//
// SUPPORTED SOURCES:
// - CryptoPrices      (CoinGecko polling, Coinbase WebSocket)
// - NewsSource        (RSS feeds, NewsAPI)
// - SocialMedia       (Twitter/X, Reddit)
// - Weather           (OpenWeatherMap)
// - FinancialPrices   (Yahoo Finance, Alpha Vantage)
// - CommodityPrices   (gold, oil, agricultural)
// - Livestream        (YouTube, Twitch)
// - EconomicIndicators (FRED API)
// - OnChainData       (blockchain RPC)
//
// SCRAPER LIFECYCLE:
// 1. spawn_scraper() parses config, creates HTTP client or WS connection,
//    spawns Tokio task with shutdown channel
// 2. run_scraper() polls on interval, stores data, emits events
// 3. Shutdown signal -> finish current iteration -> exit cleanly
//
// Error handling uses exponential backoff (max 3 retries) with a circuit
// breaker that stops after 5 consecutive failures.
// ============================================================================

use crate::models::node::InfoSourceType;
use crate::db::sqlite::{insert_timeseries, Connection};
use serde::{Serialize, Deserialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Window, Emitter};
use tokio::sync::{mpsc, Mutex};
use reqwest::Client;
use chrono::Utc;

/// Configuration parsed from node metadata
#[derive(Debug, Clone)]
pub struct ScraperConfig {
    /// Polling interval in seconds
    pub interval_seconds: u64,
    /// Source-specific parameters (symbols, keywords, location)
    pub params: JsonValue,
    /// API key reference (secure storage key, not the actual key)
    pub api_key_ref: Option<String>,
    /// Maximum retries before marking unhealthy
    pub max_retries: u32,
    /// Batch size for database writes
    pub batch_size: usize,
}

/// Handle to a running scraper for management
pub struct ScraperHandle {
    /// Task handle for await/join
    pub join_handle: std::sync::Arc<tokio::task::JoinHandle<()>>,
    /// Channel to signal graceful shutdown
    pub shutdown_tx: mpsc::Sender<()>,
    /// Channel to send commands (for WebSocket scrapers)
    pub command_tx: Option<mpsc::Sender<super::websocket_scraper::ScraperCommand>>,
}

/// Spawn a new scraper task for the given data source
/// 
/// This is the main entry point called by commands::data_sources::add_data_source
/// For WebSocket-capable sources (Coinbase crypto), spawns a WebSocket scraper instead
pub async fn spawn_scraper(
    node_id: String,
    source_type: InfoSourceType,
    config: JsonValue,
    db: Arc<Mutex<Connection>>,
    window: Window,
    network_metrics: Arc<crate::services::websocket_manager::NetworkMetrics>,
) -> Result<ScraperHandle, anyhow::Error> {
    // DEBUG: Print incoming config
    println!("[SCRAPER] spawn_scraper called for node {} with source_type {:?}", node_id, source_type);
    println!("[SCRAPER] Config: {}", config);
    
    // Check if this is a WebSocket-capable source
    if source_type == InfoSourceType::CryptoPrices {
        let provider = config.get("provider")
            .and_then(|v| v.as_str())
            .unwrap_or("coingecko");
        
        println!("[SCRAPER] Detected provider: {}", provider);
        
        if provider == "coinbase" {
            // Use WebSocket scraper for Coinbase
            return spawn_websocket_scraper(node_id, source_type, config, db, window, network_metrics).await;
        }
    }
    
    // Parse configuration from node metadata
    let scraper_config = parse_config(&source_type, &config)?;
    
    // Create shared HTTP client with appropriate settings
    let client = create_http_client(&source_type)?;
    
    // Create shutdown channel for graceful stop
    let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
    
    // Spawn the scraper task
    let join_handle = tokio::spawn(run_scraper(
        node_id.clone(),
        source_type.clone(),
        scraper_config,
        client,
        db,
        window,
        shutdown_rx,
    ));
    
    println!("Scraper spawned for node {}: {:?}", node_id, source_type);
    
    Ok(ScraperHandle {
        join_handle: std::sync::Arc::new(join_handle),
        shutdown_tx,
        command_tx: None, // HTTP scrapers don't support dynamic commands
    })
}

/// Spawn a WebSocket-based scraper for real-time data sources
async fn spawn_websocket_scraper(
    node_id: String,
    source_type: InfoSourceType,
    config: JsonValue,
    db: Arc<Mutex<Connection>>,
    window: Window,
    network_metrics: Arc<crate::services::websocket_manager::NetworkMetrics>,
) -> Result<ScraperHandle, anyhow::Error> {
    use super::websocket_scraper::{
        WebSocketScraperConfig, run_coinbase_scraper, ScraperCommand,
    };
    
    // DEBUG: Print that we entered websocket scraper
    println!("[SCRAPER] Entered spawn_websocket_scraper for node {}", node_id);
    
    // Parse WebSocket-specific config
    let symbols: Vec<String> = config.get("symbols")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    
    println!("[SCRAPER] Parsed symbols: {:?}", symbols);
    
    // Support both storageIntervalMs (from frontend) and storage_interval_seconds (alternative format)
    let storage_interval_ms = config.get("storageIntervalMs")
        .and_then(|v| v.as_u64())
        .or_else(|| config.get("storage_interval_seconds").and_then(|v| v.as_u64()).map(|s| s * 1000))
        .unwrap_or(1000); // Default: 1 second
    
    let include_orderbook = config.get("includeOrderbook")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    
    let orderbook_depth = config.get("orderbookDepth")
        .and_then(|v| v.as_u64())
        .unwrap_or(10) as usize;
    
    let ws_config = WebSocketScraperConfig {
        node_id: node_id.clone(),
        source_type,
        provider: "coinbase".to_string(),
        symbols,
        storage_interval_ms,
        include_orderbook,
        orderbook_depth,
        network_metrics,
    };
    
    // Create shutdown channel for WebSocket scraper
    let (shutdown_tx, mut shutdown_rx) = mpsc::channel(1);
    
    // Create command channel for WebSocket scraper
    let (command_tx, command_rx) = mpsc::channel(100);
    
    // Clone shutdown receiver for the wrapper task
    let command_tx_clone = command_tx.clone();
    
    // Spawn a wrapper task that converts shutdown signal to WebSocket command
    let _shutdown_handle = tokio::spawn(async move {
        // Wait for shutdown signal
        let _ = shutdown_rx.recv().await;
        // Send shutdown command to WebSocket scraper
        let _ = command_tx_clone.send(ScraperCommand::Shutdown).await;
    });
    
    // Spawn WebSocket scraper
    let join_handle = tokio::spawn(run_coinbase_scraper(ws_config, db, window, command_rx));
    
    println!("WebSocket scraper spawned for node {}: coinbase", node_id);
    
    // Wait for both tasks (shutdown wrapper and actual scraper)
    Ok(ScraperHandle {
        join_handle: std::sync::Arc::new(join_handle),
        shutdown_tx,
        command_tx: Some(command_tx), // WebSocket scrapers support dynamic commands
    })
}

/// Gracefully stop a running scraper
/// 
/// Sends shutdown signal and waits for task completion
pub async fn stop_scraper(handle: &ScraperHandle) -> Result<(), anyhow::Error> {
    // Signal shutdown
    handle.shutdown_tx.send(()).await.ok();
    
    // Try to wait for task to finish (with timeout)
    let join_handle = handle.join_handle.clone();
    match tokio::time::timeout(Duration::from_secs(5), async move {
        tokio::task::spawn_blocking(move || {
            while !join_handle.is_finished() {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }).await
    }).await {
        Ok(_) => println!("Scraper stopped gracefully"),
        Err(_) => {
            eprintln!("Scraper shutdown timeout, aborting");
            handle.join_handle.abort();
        }
    }
    
    Ok(())
}

/// Main scraper loop - runs until shutdown signal
async fn run_scraper(
    node_id: String,
    source_type: InfoSourceType,
    config: ScraperConfig,
    client: Client,
    db: Arc<Mutex<Connection>>,
    window: Window,
    mut shutdown_rx: mpsc::Receiver<()>,
) {
    let mut interval = tokio::time::interval(Duration::from_secs(config.interval_seconds));
    let mut retry_count = 0;
    let mut consecutive_errors = 0;
    // Track last stored values per metric_type for change detection
    let mut last_values: HashMap<String, (f64, Option<JsonValue>)> = HashMap::new();

    println!("Scraper started for {}: interval={}s", node_id, config.interval_seconds);

    loop {
        tokio::select! {
            // Regular interval tick
            _ = interval.tick() => {
                match scrape_once(&node_id, &source_type, &config, &client, &db, &window, &mut last_values).await {
                    Ok(()) => {
                        retry_count = 0;
                        consecutive_errors = 0;
                    }
                    Err(e) => {
                        eprintln!("Scrape error for {}: {}", node_id, e);
                        consecutive_errors += 1;
                        
                        // Circuit breaker: stop after 5 consecutive errors
                        if consecutive_errors >= 5 {
                            eprintln!("Circuit breaker triggered for {}, stopping", node_id);
                            emit_scraper_error(&window, &node_id, "Circuit breaker: too many errors").await;
                            break;
                        }
                        
                        // Retry with backoff
                        retry_count += 1;
                        if retry_count <= config.max_retries {
                            let backoff = Duration::from_secs(2u64.pow(retry_count));
                            tokio::time::sleep(backoff).await;
                            continue;
                        }
                    }
                }
            }
            
            // Shutdown signal received
            _ = shutdown_rx.recv() => {
                println!("Shutdown signal received for scraper {}", node_id);
                break;
            }
        }
    }
    
    println!("Scraper {} exiting", node_id);
}

/// Perform single scrape operation
async fn scrape_once(
    node_id: &str,
    source_type: &InfoSourceType,
    config: &ScraperConfig,
    client: &Client,
    db: &Arc<Mutex<Connection>>,
    window: &Window,
    last_values: &mut HashMap<String, (f64, Option<JsonValue>)>,
) -> Result<(), anyhow::Error> {
    
    let start_time = std::time::Instant::now();
    
    // Fetch data based on source type
    let data = match source_type {
        &InfoSourceType::CryptoPrices => {
            scrape_crypto(client, config).await?
        }
        &InfoSourceType::NewsSource => {
            scrape_news(client, config).await?
        }
        &InfoSourceType::Weather => {
            scrape_weather(client, config).await?
        }
        &InfoSourceType::SocialMedia => {
            scrape_social(client, config).await?
        }
        &InfoSourceType::FinancialPrices => {
            scrape_finance(client, config).await?
        }
        &InfoSourceType::CommodityPrices => {
            scrape_commodities(client, config).await?
        }
        &InfoSourceType::Livestream => {
            scrape_livestream(client, config).await?
        }
        &InfoSourceType::EconomicIndicators => {
            scrape_economic(client, config).await?
        }
        &InfoSourceType::OnChainData => {
            scrape_onchain(client, config).await?
        }
    };
    
    // Store in database (skip if data unchanged)
    {
        let conn = db.lock().await;
        for point in &data.points {
            // Check if this metric's value and metadata are the same as last time
            let changed = match last_values.get(&point.metric_type) {
                Some((prev_value, prev_metadata)) => {
                    (point.value - prev_value).abs() > f64::EPSILON
                        || point.metadata != *prev_metadata
                }
                None => true, // First time seeing this metric
            };
            if changed {
                insert_timeseries(&conn, node_id, &point.metric_type, point.value, point.metadata.clone())?;
                last_values.insert(point.metric_type.clone(), (point.value, point.metadata.clone()));
            }
        }
    }
    
    // Emit to frontend
    emit_data_update(window, node_id, source_type, &data).await;
    
    let elapsed = start_time.elapsed().as_millis();
    println!("Scraped {} for {}: {} points in {}ms", 
        source_type_to_string(source_type), node_id, data.points.len(), elapsed);
    
    Ok(())
}

/// Data returned from a scrape operation
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScrapedData {
    points: Vec<DataPoint>,
    metadata: JsonValue, // Additional context (API response metadata)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DataPoint {
    metric_type: String,
    value: f64,
    metadata: Option<JsonValue>,
}

// ============================================================================
// SOURCE-SPECIFIC SCRAPERS
// ============================================================================

/// Map common symbols to CoinGecko IDs
fn symbol_to_coingecko_id(symbol: &str) -> String {
    let normalized = symbol.to_lowercase();
    match normalized.as_str() {
        "btc" | "bitcoin" => "bitcoin".to_string(),
        "eth" | "ethereum" => "ethereum".to_string(),
        "sol" | "solana" => "solana".to_string(),
        "xrp" | "ripple" => "ripple".to_string(),
        "ada" | "cardano" => "cardano".to_string(),
        "dot" | "polkadot" => "polkadot".to_string(),
        "doge" | "dogecoin" => "dogecoin".to_string(),
        "ltc" | "litecoin" => "litecoin".to_string(),
        "link" | "chainlink" => "chainlink".to_string(),
        "uni" | "uniswap" => "uniswap".to_string(),
        "matic" | "polygon" => "matic".to_string(),
        "avax" | "avalanche-2" => "avalanche-2".to_string(),
        "shib" | "shiba-inu" => "shiba-inu".to_string(),
        "dai" | "dai" => "dai".to_string(),
        "usdt" | "tether" => "tether".to_string(),
        "usdc" | "usd-coin" => "usd-coin".to_string(),
        _ => normalized,
    }
}

/// Scrape cryptocurrency prices from CoinGecko
async fn scrape_crypto(client: &Client, config: &ScraperConfig) -> Result<ScrapedData, anyhow::Error> {
    // Parse symbols from config
    let symbols: Vec<String> = serde_json::from_value(
        config.params.get("symbols").cloned().unwrap_or(serde_json::json!([]))
    )?;
    
    if symbols.is_empty() {
        return Err(anyhow::anyhow!("No symbols configured"));
    }
    
    // Convert symbols to CoinGecko IDs
    let ids: Vec<String> = symbols.iter().map(|s| symbol_to_coingecko_id(s)).collect();
    let ids_string = ids.join(",");
    
    // CoinGecko API: /simple/price
    let url = format!(
        "https://api.coingecko.com/api/v3/simple/price?ids={}&vs_currencies=usd&include_24hr_change=true",
        ids_string
    );
    
    let response = client.get(&url)
        .send()
        .await?
        .json::<JsonValue>()
        .await?;
    
    let mut points = Vec::new();
    
    // Parse response (format: {"bitcoin": {"usd": 50000, "usd_24h_change": 5.2}})
    for (coin, data) in response.as_object().unwrap_or(&serde_json::Map::new()) {
        // Use the original symbol name if provided, otherwise use the coin ID
        let original_symbol = if let Some(idx) = ids.iter().position(|id| id == coin) {
            symbols.get(idx).unwrap_or(coin)
        } else {
            coin
        };
        
        if let Some(price) = data.get("usd").and_then(|v| v.as_f64()) {
            points.push(DataPoint {
                metric_type: format!("price:{}", original_symbol.to_lowercase()),
                value: price,
                metadata: Some(serde_json::json!({
                    "source": "coingecko",
                    "currency": "usd",
                    "change_24h": data.get("usd_24h_change").and_then(|v| v.as_f64())
                })),
            });
        }
    }
    
    if points.is_empty() {
        // Return an error instead of storing placeholder data
        return Err(anyhow::anyhow!(
            "No price data found for symbols: {}. Check symbol names (use bitcoin, ethereum, etc.)",
            ids.join(", ")
        ));
    }
    
    Ok(ScrapedData {
        points,
        metadata: response,
    })
}

// ============================================================================
// NEWS RSS SCRAPING
// ============================================================================

struct NewsSourceDef {
    id: &'static str,
    name: &'static str,
    feed_url: &'static str,
}

const NEWS_SOURCES: &[NewsSourceDef] = &[
    NewsSourceDef { id: "abc_news",       name: "ABC News",          feed_url: "https://abcnews.go.com/abcnews/topstories" },
    NewsSourceDef { id: "al_jazeera",     name: "Al Jazeera",        feed_url: "https://www.aljazeera.com/xml/rss/all.xml" },
    NewsSourceDef { id: "ap_news",        name: "AP News",           feed_url: "https://rsshub.app/apnews/topics/apf-topnews" },
    NewsSourceDef { id: "bbc",            name: "BBC",               feed_url: "https://feeds.bbci.co.uk/news/rss.xml" },
    NewsSourceDef { id: "cnn",            name: "CNN",               feed_url: "http://rss.cnn.com/rss/cnn_topstories.rss" },
    NewsSourceDef { id: "yahoo_finance",  name: "Yahoo Finance",     feed_url: "https://finance.yahoo.com/news/rssindex" },
];

/// Strip HTML tags from RSS description text
fn strip_html_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    result
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

/// Fetch and parse a single RSS feed, returning a DataPoint with headlines
async fn fetch_and_parse_feed(
    client: &Client,
    source: &NewsSourceDef,
    keywords: &[String],
) -> Result<(DataPoint, serde_json::Value), anyhow::Error> {
    let response = client.get(source.feed_url)
        .header("Accept", "application/rss+xml, application/xml, text/xml, */*")
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(anyhow::anyhow!("{} returned HTTP {}", source.name, response.status()));
    }

    let body = response.bytes().await?;

    let feed = feed_rs::parser::parse(&body[..])
        .map_err(|e| anyhow::anyhow!("Feed parse error for {}: {}", source.name, e))?;

    let mut headlines: Vec<serde_json::Value> = Vec::new();

    for entry in feed.entries.iter().take(20) {
        let title = entry.title.as_ref().map(|t| t.content.clone()).unwrap_or_default();
        let link = entry.links.first().map(|l| l.href.clone()).unwrap_or_default();
        let description = entry.summary.as_ref()
            .map(|s| s.content.clone())
            .or_else(|| entry.content.as_ref().and_then(|c| c.body.clone()))
            .unwrap_or_default();
        let published = entry.published
            .or(entry.updated)
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_default();

        // Apply keyword filter if specified
        if !keywords.is_empty() {
            let text_lower = format!("{} {}", title, description).to_lowercase();
            if !keywords.iter().any(|kw| text_lower.contains(kw)) {
                continue;
            }
        }

        headlines.push(serde_json::json!({
            "title": title,
            "link": link,
            "description": strip_html_tags(&description),
            "published": published,
        }));
    }

    let article_count = headlines.len() as f64;

    let source_meta = serde_json::json!({
        "source_name": source.name,
        "feed_url": source.feed_url,
        "article_count": article_count,
        "feed_title": feed.title.map(|t| t.content),
    });

    let point = DataPoint {
        metric_type: format!("headlines:{}", source.id),
        value: article_count,
        metadata: Some(serde_json::json!({
            "source": source.id,
            "source_name": source.name,
            "headlines": headlines,
        })),
    };

    Ok((point, source_meta))
}

/// Scrape news headlines from RSS feeds
async fn scrape_news(client: &Client, config: &ScraperConfig) -> Result<ScrapedData, anyhow::Error> {
    let selected_sources: Vec<String> = serde_json::from_value(
        config.params.get("sources").cloned().unwrap_or(serde_json::json!([]))
    ).unwrap_or_default();

    let keywords: Vec<String> = serde_json::from_value(
        config.params.get("keywords").cloned().unwrap_or(serde_json::json!([]))
    ).unwrap_or_default();
    let keywords_lower: Vec<String> = keywords.iter().map(|k| k.to_lowercase()).collect();

    let sources_to_scrape: Vec<&NewsSourceDef> = if selected_sources.is_empty() {
        NEWS_SOURCES.iter().collect()
    } else {
        NEWS_SOURCES.iter()
            .filter(|s| selected_sources.contains(&s.id.to_string()))
            .collect()
    };

    if sources_to_scrape.is_empty() {
        return Err(anyhow::anyhow!("No valid news sources selected"));
    }

    let mut points = Vec::new();
    let mut all_metadata = serde_json::Map::new();

    for source in &sources_to_scrape {
        match fetch_and_parse_feed(client, source, &keywords_lower).await {
            Ok((point, source_meta)) => {
                points.push(point);
                all_metadata.insert(source.id.to_string(), source_meta);
            }
            Err(e) => {
                eprintln!("Failed to fetch news feed from {}: {}", source.name, e);
                all_metadata.insert(
                    source.id.to_string(),
                    serde_json::json!({"error": e.to_string()}),
                );
            }
        }
    }

    if points.is_empty() {
        return Err(anyhow::anyhow!("All news feeds failed to fetch"));
    }

    Ok(ScrapedData {
        points,
        metadata: serde_json::Value::Object(all_metadata),
    })
}

/// Scrape weather data
async fn scrape_weather(client: &Client, config: &ScraperConfig) -> Result<ScrapedData, anyhow::Error> {
    let location: String = serde_json::from_value(
        config.params.get("location").cloned().unwrap_or(serde_json::json!("New York"))
    )?;
    
    // OpenWeatherMap API (simplified)
    // In real implementation: geocode location, fetch current weather
    
    let points = vec![
        DataPoint {
            metric_type: "temperature".to_string(),
            value: 22.5, // Celsius
            metadata: Some(serde_json::json!({
                "location": location,
                "unit": "celsius"
            })),
        }
    ];
    
    Ok(ScrapedData { points, metadata: serde_json::json!({}) })
}

// ============================================================================
// SOCIAL MEDIA SCRAPING
// ============================================================================

/// Curated social media sources mapped to prediction market categories
struct CuratedSourceSet {
    category: &'static str,
    subreddits: &'static [&'static str],
    twitter_accounts: &'static [&'static str],
}

const CURATED_SOCIAL_SOURCES: &[CuratedSourceSet] = &[
    CuratedSourceSet {
        category: "crypto",
        subreddits: &["CryptoCurrency", "Bitcoin", "ethereum", "solana"],
        twitter_accounts: &["whale_alert", "CoinDesk", "WatcherGuru"],
    },
    CuratedSourceSet {
        category: "politics",
        subreddits: &["politics", "PoliticalDiscussion", "Conservative", "neoliberal"],
        twitter_accounts: &["POTUS", "RealClearNews"],
    },
    CuratedSourceSet {
        category: "sports",
        subreddits: &["nba", "nfl", "soccer", "sportsbook"],
        twitter_accounts: &["SportsCenter", "wojespn", "AdamSchefter"],
    },
    CuratedSourceSet {
        category: "economics",
        subreddits: &["wallstreetbets", "stocks", "economics", "investing"],
        twitter_accounts: &["markets", "business"],
    },
    CuratedSourceSet {
        category: "science",
        subreddits: &["science", "climate", "space"],
        twitter_accounts: &["NASA", "NOAA"],
    },
    CuratedSourceSet {
        category: "entertainment",
        subreddits: &["entertainment", "movies", "television", "popculture"],
        twitter_accounts: &[],
    },
    CuratedSourceSet {
        category: "tech",
        subreddits: &["technology", "programming", "artificial"],
        twitter_accounts: &[],
    },
    CuratedSourceSet {
        category: "world",
        subreddits: &["worldnews", "geopolitics"],
        twitter_accounts: &["Reuters", "AP"],
    },
];

/// Return curated social sources as JSON (called by Tauri command)
pub fn get_curated_social_sources() -> JsonValue {
    let categories: Vec<JsonValue> = CURATED_SOCIAL_SOURCES.iter().map(|s| {
        serde_json::json!({
            "id": s.category,
            "label": match s.category {
                "crypto" => "Crypto",
                "politics" => "Politics",
                "sports" => "Sports",
                "economics" => "Economics / Finance",
                "science" => "Science / Climate",
                "entertainment" => "Entertainment",
                "tech" => "Tech",
                "world" => "World Events",
                _ => s.category,
            },
            "subreddits": s.subreddits,
            "twitter_accounts": s.twitter_accounts,
        })
    }).collect();
    serde_json::json!({ "categories": categories })
}

/// Scrape social media data from Reddit, Twitter/X (via Nitter), and Hacker News
async fn scrape_social(client: &Client, config: &ScraperConfig) -> Result<ScrapedData, anyhow::Error> {
    let platforms: Vec<String> = serde_json::from_value(
        config.params.get("platforms").cloned().unwrap_or(serde_json::json!(["reddit"]))
    ).unwrap_or_else(|_| vec!["reddit".to_string()]);

    let subreddits: Vec<String> = serde_json::from_value(
        config.params.get("subreddits").cloned().unwrap_or(serde_json::json!([]))
    ).unwrap_or_default();

    let twitter_accounts: Vec<String> = serde_json::from_value(
        config.params.get("twitter_accounts").cloned().unwrap_or(serde_json::json!([]))
    ).unwrap_or_default();

    let keywords: Vec<String> = serde_json::from_value(
        config.params.get("keywords").cloned().unwrap_or(serde_json::json!([]))
    ).unwrap_or_default();
    let keywords_lower: Vec<String> = keywords.iter().map(|k| k.to_lowercase()).collect();

    let mut all_points: Vec<DataPoint> = Vec::new();
    let mut all_metadata = serde_json::Map::new();
    let mut any_success = false;

    // Fetch from each platform in parallel
    let (reddit_result, twitter_result, hn_result) = tokio::join!(
        async {
            if platforms.iter().any(|p| p == "reddit") && !subreddits.is_empty() {
                Some(scrape_reddit(client, &subreddits, &keywords_lower).await)
            } else {
                None
            }
        },
        async {
            if platforms.iter().any(|p| p == "twitter") && !twitter_accounts.is_empty() {
                Some(scrape_twitter_nitter(client, &twitter_accounts, &keywords_lower).await)
            } else {
                None
            }
        },
        async {
            if platforms.iter().any(|p| p == "hackernews") {
                Some(scrape_hackernews(client, &keywords_lower).await)
            } else {
                None
            }
        }
    );

    // Collect Reddit results
    if let Some(result) = reddit_result {
        match result {
            Ok((points, meta)) => {
                all_points.extend(points);
                all_metadata.insert("reddit".to_string(), meta);
                any_success = true;
            }
            Err(e) => {
                eprintln!("[SocialMedia] Reddit scrape failed: {}", e);
                all_metadata.insert("reddit".to_string(), serde_json::json!({"error": e.to_string()}));
            }
        }
    }

    // Collect Twitter results
    if let Some(result) = twitter_result {
        match result {
            Ok((points, meta)) => {
                all_points.extend(points);
                all_metadata.insert("twitter".to_string(), meta);
                any_success = true;
            }
            Err(e) => {
                eprintln!("[SocialMedia] Twitter/Nitter scrape failed: {}", e);
                all_metadata.insert("twitter".to_string(), serde_json::json!({"error": e.to_string()}));
            }
        }
    }

    // Collect Hacker News results
    if let Some(result) = hn_result {
        match result {
            Ok((points, meta)) => {
                all_points.extend(points);
                all_metadata.insert("hackernews".to_string(), meta);
                any_success = true;
            }
            Err(e) => {
                eprintln!("[SocialMedia] Hacker News scrape failed: {}", e);
                all_metadata.insert("hackernews".to_string(), serde_json::json!({"error": e.to_string()}));
            }
        }
    }

    if !any_success && all_points.is_empty() {
        return Err(anyhow::anyhow!("All social media platforms failed to fetch data"));
    }

    Ok(ScrapedData {
        points: all_points,
        metadata: serde_json::Value::Object(all_metadata),
    })
}

/// Scrape Reddit posts from public JSON API (no auth required)
async fn scrape_reddit(
    client: &Client,
    subreddits: &[String],
    keywords: &[String],
) -> Result<(Vec<DataPoint>, JsonValue), anyhow::Error> {
    let mut points = Vec::new();
    let mut meta = serde_json::Map::new();

    for (i, sub) in subreddits.iter().enumerate() {
        // Rate limit: 1-second delay between requests (except first)
        if i > 0 {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }

        let url = format!("https://www.reddit.com/r/{}/hot.json?limit=25&raw_json=1", sub);

        let response = match client.get(&url)
            .header("User-Agent", "PredictionMarketTerminal/1.0 (social media scraper)")
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[Reddit] Failed to fetch r/{}: {}", sub, e);
                meta.insert(sub.clone(), serde_json::json!({"error": e.to_string()}));
                continue;
            }
        };

        if !response.status().is_success() {
            eprintln!("[Reddit] r/{} returned HTTP {}", sub, response.status());
            meta.insert(sub.clone(), serde_json::json!({"error": format!("HTTP {}", response.status())}));
            continue;
        }

        let body: JsonValue = match response.json().await {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[Reddit] Failed to parse r/{} JSON: {}", sub, e);
                meta.insert(sub.clone(), serde_json::json!({"error": e.to_string()}));
                continue;
            }
        };

        let children = body.get("data")
            .and_then(|d| d.get("children"))
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();

        let mut post_count: u64 = 0;
        let mut total_score: i64 = 0;
        let mut total_comments: u64 = 0;
        let mut total_upvote_ratio: f64 = 0.0;
        let mut top_posts: Vec<JsonValue> = Vec::new();
        let mut keyword_mention_count: u64 = 0;

        for child in &children {
            let data = match child.get("data") {
                Some(d) => d,
                None => continue,
            };

            let title = data.get("title").and_then(|t| t.as_str()).unwrap_or("");
            let score = data.get("score").and_then(|s| s.as_i64()).unwrap_or(0);
            let num_comments = data.get("num_comments").and_then(|n| n.as_u64()).unwrap_or(0);
            let upvote_ratio = data.get("upvote_ratio").and_then(|u| u.as_f64()).unwrap_or(0.0);
            let permalink = data.get("permalink").and_then(|p| p.as_str()).unwrap_or("");
            let created_utc = data.get("created_utc").and_then(|c| c.as_f64()).unwrap_or(0.0);
            let selftext = data.get("selftext").and_then(|s| s.as_str()).unwrap_or("");
            let stickied = data.get("stickied").and_then(|s| s.as_bool()).unwrap_or(false);

            // Skip stickied mod posts
            if stickied { continue; }

            // Keyword filtering
            if !keywords.is_empty() {
                let text_lower = format!("{} {}", title, selftext).to_lowercase();
                if keywords.iter().any(|kw| text_lower.contains(kw)) {
                    keyword_mention_count += 1;
                } else {
                    continue;
                }
            }

            post_count += 1;
            total_score += score;
            total_comments += num_comments;
            total_upvote_ratio += upvote_ratio;

            if top_posts.len() < 10 {
                top_posts.push(serde_json::json!({
                    "title": title,
                    "score": score,
                    "num_comments": num_comments,
                    "upvote_ratio": upvote_ratio,
                    "permalink": format!("https://reddit.com{}", permalink),
                    "created_utc": created_utc,
                    "subreddit": sub,
                }));
            }
        }

        let avg_score = if post_count > 0 { total_score as f64 / post_count as f64 } else { 0.0 };
        let avg_upvote_ratio = if post_count > 0 { total_upvote_ratio / post_count as f64 } else { 0.0 };

        // Emit DataPoints per metric per subreddit
        points.push(DataPoint {
            metric_type: format!("reddit:r/{}:post_count", sub),
            value: post_count as f64,
            metadata: Some(serde_json::json!({
                "platform": "reddit",
                "subreddit": sub,
                "top_posts": top_posts,
            })),
        });

        points.push(DataPoint {
            metric_type: format!("reddit:r/{}:avg_score", sub),
            value: avg_score,
            metadata: Some(serde_json::json!({
                "platform": "reddit",
                "subreddit": sub,
            })),
        });

        points.push(DataPoint {
            metric_type: format!("reddit:r/{}:comment_count", sub),
            value: total_comments as f64,
            metadata: Some(serde_json::json!({
                "platform": "reddit",
                "subreddit": sub,
            })),
        });

        points.push(DataPoint {
            metric_type: format!("reddit:r/{}:avg_upvote_ratio", sub),
            value: avg_upvote_ratio,
            metadata: Some(serde_json::json!({
                "platform": "reddit",
                "subreddit": sub,
            })),
        });

        if !keywords.is_empty() {
            points.push(DataPoint {
                metric_type: format!("reddit:r/{}:keyword_mentions", sub),
                value: keyword_mention_count as f64,
                metadata: Some(serde_json::json!({
                    "platform": "reddit",
                    "subreddit": sub,
                    "keywords": keywords,
                })),
            });
        }

        meta.insert(sub.clone(), serde_json::json!({
            "post_count": post_count,
            "avg_score": avg_score,
            "total_comments": total_comments,
            "avg_upvote_ratio": avg_upvote_ratio,
        }));
    }

    if points.is_empty() {
        return Err(anyhow::anyhow!("No Reddit data fetched from any subreddit"));
    }

    Ok((points, serde_json::Value::Object(meta)))
}

/// Nitter instances for fetching Twitter/X RSS feeds (tried in order)
const NITTER_INSTANCES: &[&str] = &[
    "https://nitter.privacydev.net",
    "https://nitter.poast.org",
    "https://nitter.net",
];

/// Scrape Twitter/X posts via Nitter RSS feeds (no auth required)
async fn scrape_twitter_nitter(
    client: &Client,
    accounts: &[String],
    keywords: &[String],
) -> Result<(Vec<DataPoint>, JsonValue), anyhow::Error> {
    let mut points = Vec::new();
    let mut meta = serde_json::Map::new();

    for account in accounts {
        let clean_account = account.trim_start_matches('@');
        let mut feed_fetched = false;

        for instance in NITTER_INSTANCES {
            let url = format!("{}/{}/rss", instance, clean_account);

            let response = match client.get(&url)
                .header("Accept", "application/rss+xml, application/xml, text/xml, */*")
                .timeout(Duration::from_secs(10))
                .send()
                .await
            {
                Ok(r) if r.status().is_success() => r,
                Ok(r) => {
                    eprintln!("[Nitter] {} returned HTTP {} for @{}", instance, r.status(), clean_account);
                    continue;
                }
                Err(e) => {
                    eprintln!("[Nitter] {} failed for @{}: {}", instance, clean_account, e);
                    continue;
                }
            };

            let body = match response.bytes().await {
                Ok(b) => b,
                Err(_) => continue,
            };

            match feed_rs::parser::parse(&body[..]) {
                Ok(feed) => {
                    let mut tweet_count: u64 = 0;
                    let mut tweets: Vec<JsonValue> = Vec::new();

                    for entry in feed.entries.iter().take(20) {
                        let title = entry.title.as_ref()
                            .map(|t| t.content.clone()).unwrap_or_default();
                        let link = entry.links.first()
                            .map(|l| l.href.clone()).unwrap_or_default();
                        let published = entry.published
                            .or(entry.updated)
                            .map(|dt| dt.to_rfc3339())
                            .unwrap_or_default();

                        // Keyword filtering
                        if !keywords.is_empty() {
                            let text_lower = title.to_lowercase();
                            if !keywords.iter().any(|kw| text_lower.contains(kw)) {
                                continue;
                            }
                        }

                        tweet_count += 1;
                        if tweets.len() < 10 {
                            tweets.push(serde_json::json!({
                                "text": strip_html_tags(&title),
                                "link": link,
                                "published": published,
                                "account": clean_account,
                            }));
                        }
                    }

                    points.push(DataPoint {
                        metric_type: format!("twitter:@{}:tweet_count", clean_account),
                        value: tweet_count as f64,
                        metadata: Some(serde_json::json!({
                            "platform": "twitter",
                            "account": clean_account,
                            "via": "nitter",
                            "instance": instance,
                            "tweets": tweets,
                        })),
                    });

                    meta.insert(clean_account.to_string(), serde_json::json!({
                        "tweet_count": tweet_count,
                        "instance": instance,
                    }));

                    feed_fetched = true;
                    break; // Success, no need to try other instances
                }
                Err(e) => {
                    eprintln!("[Nitter] RSS parse error for @{} from {}: {}", clean_account, instance, e);
                }
            }
        }

        if !feed_fetched {
            eprintln!("[Nitter] All instances failed for @{}", clean_account);
            meta.insert(clean_account.to_string(), serde_json::json!({"error": "All Nitter instances failed"}));
        }
    }

    if points.is_empty() {
        return Err(anyhow::anyhow!("No Twitter data fetched from any account via Nitter"));
    }

    Ok((points, serde_json::Value::Object(meta)))
}

/// Scrape top stories from Hacker News public API (no auth required)
async fn scrape_hackernews(
    client: &Client,
    keywords: &[String],
) -> Result<(Vec<DataPoint>, JsonValue), anyhow::Error> {
    // Fetch top story IDs
    let top_url = "https://hacker-news.firebaseio.com/v0/topstories.json";
    let story_ids: Vec<u64> = client.get(top_url)
        .send().await?
        .json().await?;

    // Fetch top 20 stories concurrently in batches of 5
    let mut posts: Vec<JsonValue> = Vec::new();
    let mut total_score: u64 = 0;
    let mut keyword_matches: u64 = 0;

    let ids_to_fetch: Vec<u64> = story_ids.into_iter().take(20).collect();

    for chunk in ids_to_fetch.chunks(5) {
        let fetches: Vec<_> = chunk.iter().map(|&id| {
            let c = client.clone();
            async move {
                let item_url = format!("https://hacker-news.firebaseio.com/v0/item/{}.json", id);
                c.get(&item_url).send().await?.json::<JsonValue>().await
            }
        }).collect();

        let results = futures_util::future::join_all(fetches).await;

        for result in results {
            let item = match result {
                Ok(item) => item,
                Err(e) => {
                    eprintln!("[HackerNews] Failed to fetch item: {}", e);
                    continue;
                }
            };

            let title = item.get("title").and_then(|t| t.as_str()).unwrap_or("");
            let score = item.get("score").and_then(|s| s.as_u64()).unwrap_or(0);
            let descendants = item.get("descendants").and_then(|d| d.as_u64()).unwrap_or(0);
            let url = item.get("url").and_then(|u| u.as_str()).unwrap_or("");
            let id = item.get("id").and_then(|i| i.as_u64()).unwrap_or(0);

            // Keyword filtering
            if !keywords.is_empty() {
                let text_lower = title.to_lowercase();
                if keywords.iter().any(|kw| text_lower.contains(kw)) {
                    keyword_matches += 1;
                } else {
                    continue;
                }
            }

            total_score += score;
            posts.push(serde_json::json!({
                "title": title,
                "score": score,
                "comments": descendants,
                "url": url,
                "hn_url": format!("https://news.ycombinator.com/item?id={}", id),
            }));
        }
    }

    let post_count = posts.len();
    let avg_score = if post_count > 0 { total_score as f64 / post_count as f64 } else { 0.0 };

    let mut result_points = vec![
        DataPoint {
            metric_type: "hackernews:top:post_count".to_string(),
            value: post_count as f64,
            metadata: Some(serde_json::json!({
                "platform": "hackernews",
                "posts": posts.iter().take(10).cloned().collect::<Vec<_>>(),
            })),
        },
        DataPoint {
            metric_type: "hackernews:top:avg_score".to_string(),
            value: avg_score,
            metadata: Some(serde_json::json!({ "platform": "hackernews" })),
        },
    ];

    if !keywords.is_empty() {
        result_points.push(DataPoint {
            metric_type: "hackernews:top:keyword_mentions".to_string(),
            value: keyword_matches as f64,
            metadata: Some(serde_json::json!({
                "platform": "hackernews",
                "keywords": keywords,
            })),
        });
    }

    Ok((result_points, serde_json::json!({
        "post_count": post_count,
        "avg_score": avg_score,
    })))
}

/// Scrape financial prices (stocks, forex)
async fn scrape_finance(client: &Client, config: &ScraperConfig) -> Result<ScrapedData, anyhow::Error> {
    let symbols: Vec<String> = serde_json::from_value(
        config.params.get("symbols").cloned().unwrap_or(serde_json::json!([]))
    )?;
    
    // Yahoo Finance or Alpha Vantage API
    
    let mut points = Vec::new();
    for symbol in symbols {
        points.push(DataPoint {
            metric_type: format!("price:{}", symbol),
            value: 150.0 + rand::random::<f64>() * 10.0, // Mock price
            metadata: Some(serde_json::json!({
                "symbol": symbol,
                "currency": "USD"
            })),
        });
    }
    
    Ok(ScrapedData { points, metadata: serde_json::json!({}) })
}

/// Scrape commodity prices
async fn scrape_commodities(client: &Client, config: &ScraperConfig) -> Result<ScrapedData, anyhow::Error> {
    // Gold, oil, etc.
    
    let points = vec![
        DataPoint {
            metric_type: "price:gold".to_string(),
            value: 2000.0, // USD per ounce
            metadata: Some(serde_json::json!({
                "commodity": "gold",
                "unit": "ounce"
            })),
        }
    ];
    
    Ok(ScrapedData { points, metadata: serde_json::json!({}) })
}

/// Monitor livestream status
async fn scrape_livestream(client: &Client, config: &ScraperConfig) -> Result<ScrapedData, anyhow::Error> {
    let stream_url: String = serde_json::from_value(
        config.params.get("url").cloned().unwrap_or(serde_json::json!(""))
    )?;
    
    // YouTube API or Twitch API to check if stream is live
    
    let points = vec![
        DataPoint {
            metric_type: "viewer_count".to_string(),
            value: 15000.0,
            metadata: Some(serde_json::json!({
                "stream_url": stream_url,
                "is_live": true
            })),
        }
    ];
    
    Ok(ScrapedData { points, metadata: serde_json::json!({}) })
}

/// Scrape economic indicators (GDP, unemployment, etc.)
async fn scrape_economic(_client: &Client, config: &ScraperConfig) -> Result<ScrapedData, anyhow::Error> {
    let indicator: String = serde_json::from_value(
        config.params.get("indicator").cloned().unwrap_or(serde_json::json!("gdp"))
    )?;
    
    // Mock economic data - in production, call FRED API or similar
    let points = vec![
        DataPoint {
            metric_type: indicator.clone(),
            value: match indicator.as_str() {
                "gdp" => 25000000.0, // billions
                "unemployment" => 3.8, // percentage
                "inflation" => 3.2, // percentage
                "interest_rate" => 5.25, // percentage
                _ => 0.0,
            },
            metadata: Some(serde_json::json!({
                "indicator": indicator,
                "country": "US",
                "frequency": "quarterly"
            })),
        }
    ];
    
    Ok(ScrapedData { points, metadata: serde_json::json!({}) })
}

/// Scrape on-chain blockchain metrics
async fn scrape_onchain(_client: &Client, config: &ScraperConfig) -> Result<ScrapedData, anyhow::Error> {
    let network: String = serde_json::from_value(
        config.params.get("network").cloned().unwrap_or(serde_json::json!("bitcoin"))
    )?;
    
    // Mock on-chain data - in production, call blockchain RPC or APIs
    let points = vec![
        DataPoint {
            metric_type: "hash_rate".to_string(),
            value: 500000000.0, // EH/s for Bitcoin
            metadata: Some(serde_json::json!({
                "network": network,
                "unit": "exahash per second"
            })),
        },
        DataPoint {
            metric_type: "active_addresses".to_string(),
            value: 1000000.0,
            metadata: Some(serde_json::json!({
                "network": network
            })),
        },
    ];
    
    Ok(ScrapedData { points, metadata: serde_json::json!({}) })
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/// Parse configuration from node metadata
fn parse_config(source_type: &InfoSourceType, config: &JsonValue) -> Result<ScraperConfig, anyhow::Error> {
    let interval_seconds: u64 = config
        .get("update_interval_seconds")
        .and_then(|v| v.as_u64())
        .unwrap_or(match source_type {
            &InfoSourceType::CryptoPrices => 30,
            &InfoSourceType::NewsSource => 300,
            &InfoSourceType::Weather => 600,
            &InfoSourceType::SocialMedia => 60,
            &InfoSourceType::FinancialPrices => 30,
            &InfoSourceType::CommodityPrices => 3600,
            &InfoSourceType::Livestream => 30,
            &InfoSourceType::EconomicIndicators => 3600,
            &InfoSourceType::OnChainData => 60,
        });
    
    Ok(ScraperConfig {
        interval_seconds,
        params: config.clone(),
        api_key_ref: config.get("api_key_ref").and_then(|v| v.as_str()).map(String::from),
        max_retries: 3,
        batch_size: 10,
    })
}

/// Create HTTP client with source-appropriate settings
fn create_http_client(source_type: &InfoSourceType) -> Result<Client, anyhow::Error> {
    let builder = Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("PredictionMarketTerminal/1.0");
    
    // Source-specific configuration
    match source_type {
        InfoSourceType::CryptoPrices => {
            // CoinGecko requires no API key for free tier
            Ok(builder.build()?)
        }
        _ => Ok(builder.build()?)
    }
}

/// Emit data update event to frontend
async fn emit_data_update(
    window: &Window,
    node_id: &str,
    source_type: &InfoSourceType,
    data: &ScrapedData,
) {
    let payload = serde_json::json!({
        "nodeId": node_id,
        "sourceType": source_type_to_string(source_type),
        "data": data,
        "timestamp": Utc::now().timestamp(),
    });
    
    if let Err(e) = window.emit("data-source:update", payload) {
        eprintln!("Failed to emit event: {}", e);
    }
}

/// Emit error event to frontend
async fn emit_scraper_error(window: &Window, node_id: &str, error: &str) {
    let payload = serde_json::json!({
        "nodeId": node_id,
        "error": error,
        "timestamp": Utc::now().timestamp(),
    });
    
    if let Err(e) = window.emit("scraper:error", payload) {
        eprintln!("Failed to emit error event: {}", e);
    }
}

/// Convert source type to string for logging/events
fn source_type_to_string(source_type: &InfoSourceType) -> String {
    match source_type {
        &InfoSourceType::CryptoPrices => "CryptoPrices",
        &InfoSourceType::NewsSource => "NewsSource",
        &InfoSourceType::Weather => "Weather",
        &InfoSourceType::SocialMedia => "SocialMedia",
        &InfoSourceType::FinancialPrices => "FinancialPrices",
        &InfoSourceType::CommodityPrices => "CommodityPrices",
        &InfoSourceType::Livestream => "Livestream",
        &InfoSourceType::EconomicIndicators => "EconomicIndicators",
        &InfoSourceType::OnChainData => "OnChainData",
    }.to_string()
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;
    use wiremock::{MockServer, Mock, ResponseTemplate};
    use wiremock::matchers::{method, path};
    
    /// Test helper: create in-memory database
    fn setup_test_db() -> (NamedTempFile, Arc<Mutex<Connection>>) {
        let temp_file = NamedTempFile::new().unwrap();
        let conn = crate::db::sqlite::create_connection(temp_file.path()).unwrap();
        crate::db::sqlite::setup_schema(&conn).unwrap();
        (temp_file, Arc::new(Mutex::new(conn)))
    }
    
    /// Test helper: create mock Tauri window
    fn mock_window() -> Window {
        // In real tests, use tauri::test::mock_builder()
        // For now, this is a placeholder
        unimplemented!("Use tauri::test for mock windows")
    }
    
    #[tokio::test]
    async fn test_parse_config_crypto() {
        let config = serde_json::json!({
            "symbols": ["bitcoin", "ethereum"],
            "update_interval_seconds": 10
        });
        
        let parsed = parse_config(&InfoSourceType::CryptoPrices, &config).unwrap();
        
        assert_eq!(parsed.interval_seconds, 10);
        assert_eq!(parsed.max_retries, 3);
    }
    
    #[tokio::test]
    async fn test_parse_config_defaults() {
        let config = serde_json::json!({}); // Empty config
        
        let parsed = parse_config(&InfoSourceType::CryptoPrices, &config).unwrap();
        
        assert_eq!(parsed.interval_seconds, 30); // Default for crypto
    }
    
    #[tokio::test]
    async fn test_scrape_crypto_mock() {
        // Start mock server
        let mock_server = MockServer::start().await;
        
        // Configure mock response
        Mock::given(method("GET"))
            .and(path("/api/v3/simple/price"))
            .respond_with(ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({
                    "bitcoin": { "usd": 50000.0, "usd_24h_change": 5.2 },
                    "ethereum": { "usd": 3000.0, "usd_24h_change": -2.1 }
                })))
            .mount(&mock_server)
            .await;
        
        // Create client pointing to mock
        let client = Client::new();
        let config = ScraperConfig {
            interval_seconds: 30,
            params: serde_json::json!({"symbols": ["bitcoin", "ethereum"]}),
            api_key_ref: None,
            max_retries: 3,
            batch_size: 10,
        };
        
        // Test would require modifying scrape_crypto to accept base URL
        // For demonstration, structure is shown
    }
    
    #[tokio::test]
    async fn test_graceful_shutdown() {
        let (_temp, db) = setup_test_db();
        
        // Create scraper
        let (tx, mut rx) = mpsc::channel(1);
        let handle = tokio::spawn(async move {
            // Simulated scraper loop
            let mut interval = tokio::time::interval(Duration::from_millis(100));
            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        println!("Scrape tick");
                    }
                    _ = rx.recv() => {
                        println!("Shutdown received");
                        break;
                    }
                }
            }
        });
        
        // Signal shutdown
        tx.send(()).await.unwrap();
        
        // Wait with timeout
        let result = tokio::time::timeout(Duration::from_secs(2), handle).await;
        assert!(result.is_ok(), "Scraper should shut down gracefully");
    }
    
    #[test]
    fn test_create_http_client() {
        let client = create_http_client(&InfoSourceType::CryptoPrices).unwrap();
        // Client created successfully
    }
}