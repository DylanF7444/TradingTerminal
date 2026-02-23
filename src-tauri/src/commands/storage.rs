// ============================================================================
// TIME-SERIES STORAGE COMMAND HANDLERS
// ============================================================================
//
// Module: commands/storage.rs
// Purpose: Tauri command handlers for persisting and querying time-series data
//
// OVERVIEW:
// This module manages high-throughput storage of time-series data (prices, 
// sentiment, volumes) for backtesting, pattern recognition, and correlation
// analysis. Optimized for write-heavy workloads with efficient time-range queries.
//
// Data Flow:
// Scraper produces data point (timestamp, source, value)
//   → Buffered in memory (batching)
//   → Flushed to SQLite every 5 seconds or 1000 rows
//   → Indexed for fast retrieval
//   → Queryable for analysis and charting
//
// Use Cases:
// - Price history charts (candlestick, line graphs)
// - Correlation analysis (BTC price vs prediction market)
// - Backtesting strategy simulation on historical data
// - Anomaly detection (sudden sentiment spikes)
//
// COMMANDS (Tauri-callable functions):
//
// 1. store_timeseries(data_points) -> Result<usize, String>
//    - Batch insert time-series data from scrapers
//    - Accepts array of DataPoint structs for efficient batching
//    - Validates schema: timestamp, source_id, metric, value
//    - Handles duplicates via UPSERT (update on conflict)
//    - Returns: Number of rows successfully inserted
//    - Performance: Handles 10k+ points/second via batching
//
// 2. query_timeseries(source_id, metric, start_time, end_time, granularity) 
//    -> Result<Vec<DataPoint>, String>
//    - Retrieves historical data for specified time range
//    - Granularity options: "raw", "1min", "5min", "1hour", "1day"
//    - Automatic downsampling using SQL aggregation (AVG, OHLC)
//    - Returns: Array of {timestamp, value} points
//    - Index-optimized: O(log n) lookup via (source_id, timestamp) index
//
// 3. get_correlation_data(source_a, source_b, time_range) -> Result<f64, String>
//    - Calculates Pearson correlation coefficient between two time-series
//    - Automatically aligns timestamps (interpolates missing values)
//    - Used for connection strength visualization in node graph
//    - Returns: Correlation value (-1.0 to 1.0)
//    - Caching: Results cached for 60 seconds (time-series changes slowly)
//
// 4. get_available_metrics(source_id) -> Result<Vec<String>, String>
//    - Lists all metric types stored for a source
//    - Example: ["price", "volume", "sentiment", "bid_ask_spread"]
//    - Useful for UI dropdowns in chart configuration
//
// 5. delete_timeseries(source_id, before_timestamp) -> Result<usize, String>
//    - Archival cleanup (soft delete or hard delete)
//    - Removes data older than specified timestamp
//    - Returns: Number of rows deleted
//    - Warning: Irreversible (used for GDPR compliance or storage limits)
//
// 6. get_storage_stats() -> Result<JsonValue, String>
//    - Returns database statistics
//    - Fields: total_rows, db_size_bytes, oldest_record, newest_record,
//              rows_per_source (breakdown), index_size
//    - Used by UI to show storage usage indicators
//
// STATE MANAGEMENT:
// - DB_POOL: r2d2::Pool<SqliteConnectionManager>
//   - Connection pooling for concurrent read/write access
//   - Max 10 connections (SQLite handles concurrency via WAL mode)
//   - Managed by Tauri (State<'_, DbPool>)
//
// - WRITE_BUFFER: Arc<Mutex<Vec<DataPoint>>>
//   - In-memory buffer for batching writes
//   - Flushed when: size >= 1000 OR 5 seconds elapsed OR app shutdown
//   - Reduces disk I/O by 100x compared to individual inserts
//   - Background flush task (tokio::time::interval)
//
// - BUFFER_FLUSH_HANDLE: Arc<tokio::task::JoinHandle<()>>
//   - Handle to background flush task for graceful shutdown
//   - Ensures no data loss on app exit (drain buffer before close)
//
// - QUERY_CACHE: Arc<Mutex<LruCache<(String, i64, i64), Vec<DataPoint>>>>
//   - LRU cache for frequent queries (e.g., last 24h BTC price)
//   - Key: (source_id, start_time, end_time)
//   - TTL: 30 seconds for recent data, 5 minutes for historical
//   - Significantly reduces DB load for dashboard refresh
//
// EXTERNAL METHODS CALLED:
//
// Database layer (db/sqlite.rs):
// - batch_insert_timeseries(points) -> Result<usize, Error>
//   - INSERT INTO timeseries VALUES (?, ?, ?, ?) with prepared statements
//   - Uses transaction for atomic batch insert
//   - Conflict resolution: REPLACE (upsert)
//
// - query_timeseries_range(source, metric, start, end) -> Result<Vec<DataPoint>, Error>
//   - SELECT timestamp, value FROM timeseries 
//     WHERE source_id = ? AND metric = ? AND timestamp BETWEEN ? AND ?
//     ORDER BY timestamp ASC
//   - Uses covering index idx_source_time for index-only scans
//
// - calculate_correlation_sql(source_a, source_b, start, end) -> Result<f64, Error>
//   - Pearson correlation calculated in SQL for performance
//   - SELECT CORR(value_a, value_b) FROM joined_series
//   - Falls back to Rust calculation if series misaligned
//
// - get_metrics_for_source(source_id) -> Result<Vec<String>, Error>
//   - SELECT DISTINCT metric_type FROM timeseries WHERE source_id = ?
//
// - vacuum_database() -> Result<(), Error>
//   - Maintenance: reclaim space after deletions
//   - Runs automatically weekly or on demand
//
// Analysis utilities (utils/statistics.rs):
// - downsample_ohlc(points, granularity) -> Vec<Candle>
//   - Converts raw tick data to OHLC candles
//   - Aggregation: Open (first), High (max), Low (min), Close (last)
//
// - interpolate_missing_values(series_a, series_b) -> (Vec<f64>, Vec<f64>)
//   - Linear interpolation for correlation calculation
//   - Aligns timestamps from different sources
//
// - calculate_pearson_correlation(x, y) -> f64
//   - Rust-side calculation when SQL correlation insufficient
//   - Handles edge cases (zero variance, NaN)
//
// DEPENDENCIES:
// - crate::models::market::DataPoint
// - r2d2 (connection pooling)
// - rusqlite (SQLite driver with bundled SQLite)
// - chrono (timestamp conversion)
// - serde_json (metadata handling)
// - lru::LruCache (query caching)
// - tokio::sync::Mutex (async buffer protection)
// - tokio::time (flush interval)
//
// DATABASE SCHEMA:
// ```sql
// CREATE TABLE timeseries (
//     timestamp INTEGER NOT NULL,           -- Unix epoch seconds
//     source_id TEXT NOT NULL,              -- 'crypto:BTC-USD' or 'market:POLY-123'
//     metric_type TEXT NOT NULL,            -- 'price', 'volume', 'sentiment'
//     value REAL NOT NULL,                  -- Numeric value (can be JSON for complex metrics)
//     metadata JSON,                        -- Optional: exchange, confidence_score
//     PRIMARY KEY (timestamp, source_id, metric_type)
// ) WITHOUT ROWID;                          -- Optimization for time-series primary keys
//
// CREATE INDEX idx_source_time_metric ON timeseries(source_id, timestamp DESC, metric_type);
// CREATE INDEX idx_metric_time ON timeseries(metric_type, timestamp) WHERE metric_type = 'price';
// ```
//
// ERROR HANDLING:
// All commands return Result<T, String> for Tauri compatibility
// Error types:
// - DatabaseError: SQLite constraints, disk full, locked database
// - SerializationError: Invalid JSON in metadata
// - RangeError: Start time > End time, future timestamps
// - NotFoundError: Source ID or metric doesn't exist
// - ValidationError: Invalid granularity, NaN values
//
// Persistence Guarantees:
// - Write buffer flushed on graceful shutdown (SIGTERM handler)
// - SQLite WAL mode (Write-Ahead Logging) prevents corruption
// - Synchronous = NORMAL (balance between safety and speed)
// - Journal mode = WAL (allows readers during writes)
//
// PERFORMANCE NOTES:
// - Write throughput: 50,000+ rows/second (batched)
// - Query performance: <10ms for 24h of minute-level data
// - Storage efficiency: ~40 bytes per data point (compressed)
// - Automatic indexing ensures O(log n) lookups
// - WAL mode allows concurrent reads during heavy writes
//
// MEMORY MANAGEMENT:
// - Write buffer capped at 1000 points (prevents unbounded growth)
// - Query cache sized to 100 entries (~10MB depending on data density)
// - Streaming queries for large exports (cursor-based, not loading all to RAM)
//
// TESTING:
// - Unit tests with in-memory SQLite (:memory:)
// - Property-based testing for correlation calculation accuracy
// - Benchmarks for write throughput (criterion.rs)
// - Data integrity tests (verify no lost writes under load)
//
// USAGE EXAMPLE (from frontend):
// ```typescript
// import { invoke } from '@tauri-apps/api/tauri';
// 
// // Store scraped data
// await invoke('store_timeseries', {
//   dataPoints: [
//     { timestamp: 1706200000, sourceId: 'crypto:BTC', metric: 'price', value: 52000.00 },
//     { timestamp: 1706200001, sourceId: 'crypto:BTC', metric: 'price', value: 52100.00 }
//   ]
// });
// 
// // Query for charting
// const data = await invoke('query_timeseries', {
//   sourceId: 'crypto:BTC',
//   metric: 'price',
//   startTime: 1706100000,
//   endTime: 1706200000,
//   granularity: '1hour'
// });
// 
// // Check correlation between sources
// const correlation = await invoke('get_correlation_data', {
//   sourceA: 'crypto:BTC',
//   sourceB: 'market:BTC-100K-2026',
//   timeRange: '7d'
// });
// ```
//
// FUTURE ENHANCEMENTS:
// - Data compression for old data (zstd compression for >30 day old)
// - Automatic archival to Parquet files for cold storage
// - Downsampling job ( keep 1min for 7d, 1hour for 1y, 1day forever)
// - Multi-resolution queries (auto-select granularity based on range)
// - Time-series anomaly detection (statistical outliers)
// - Export to CSV/Parquet for external analysis
// - Data retention policies (auto-delete after X days per source)
// ============================================================================

// ============================================================================
// TIME-SERIES STORAGE COMMAND HANDLERS
// ============================================================================
//
// ... (comment header preserved as requested)
//
// ============================================================================

use chrono::{Duration as ChronoDuration, Utc};
use lru::LruCache;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::State;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::interval;

use anyhow::Result;

// ============================================================================
// CONSTANTS
// ============================================================================

const WRITE_BUFFER_SIZE: usize = 1000;
const FLUSH_INTERVAL_SECS: u64 = 5;
const QUERY_CACHE_SIZE: usize = 100;
const QUERY_CACHE_TTL_SECS: u64 = 60;
const CORRELATION_CACHE_TTL_SECS: u64 = 60;

// ============================================================================
// DATA STRUCTURES
// ============================================================================

/// Single time-series data point
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataPoint {
    pub timestamp: i64,
    pub source_id: String,
    pub metric: String,
    pub value: f64,
    pub metadata: Option<JsonValue>,
}

/// Candlestick/OHLC data structure for downsampled data
#[derive(Debug, Clone, Serialize)]
pub struct Candle {
    pub timestamp: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: Option<f64>,
}

/// Cached query result with timestamp
struct CachedQuery {
    data: Vec<DataPoint>,
    cached_at: Instant,
}

/// Application state for storage
pub struct StorageState {
    pub db_pool: Pool<SqliteConnectionManager>,
    pub write_buffer: Arc<Mutex<Vec<DataPoint>>>,
    pub query_cache: Arc<Mutex<LruCache<String, CachedQuery>>>,
    pub correlation_cache: Arc<Mutex<LruCache<String, (f64, Instant)>>>,
    _flush_handle: Arc<JoinHandle<()>>,
}

impl StorageState {
    pub fn new(db_path: &std::path::Path) -> Result<Self, Box<dyn std::error::Error>> {
        // Initialize connection pool with WAL mode for concurrent read/write
        let manager = SqliteConnectionManager::file(db_path)
            .with_flags(rusqlite::OpenFlags::default());
        
        let pool = Pool::builder()
            .max_size(10)
            .build(manager)?;
        
        // Initialize database schema
        init_database(&pool)?;
        
        let buffer: Arc<Mutex<Vec<DataPoint>>> = Arc::new(Mutex::new(Vec::with_capacity(WRITE_BUFFER_SIZE)));
        let query_cache = Arc::new(Mutex::new(LruCache::<String, CachedQuery>::new(NonZeroUsize::new(QUERY_CACHE_SIZE).unwrap())));
        let correlation_cache = Arc::new(Mutex::new(LruCache::<String, (f64, Instant)>::new(NonZeroUsize::new(100).unwrap())));
        
        // Spawn background flush task
        let buffer_clone = buffer.clone();
        let pool_clone = pool.clone();
        let flush_handle = tokio::spawn(async move {
            let mut ticker = interval(Duration::from_secs(FLUSH_INTERVAL_SECS));
            loop {
                ticker.tick().await;
                if let Err(e) = flush_buffer(&buffer_clone, &pool_clone).await {
                    eprintln!("Background flush error: {}", e);
                }
            }
        });
        
        Ok(Self {
            db_pool: pool,
            write_buffer: buffer,
            query_cache,
            correlation_cache,
            _flush_handle: Arc::new(flush_handle),
        })
    }
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Store time-series data points (batched)
#[tauri::command]
pub async fn store_timeseries(
    data_points: Vec<DataPoint>,
    state: State<'_, StorageState>,
) -> Result<usize, String> {
    if data_points.is_empty() {
        return Ok(0);
    }
    
    // Validate data
    for point in &data_points {
        if point.value.is_nan() || point.value.is_infinite() {
            return Err(format!("Invalid value at timestamp {}: {}", point.timestamp, point.value));
        }
        if point.timestamp > Utc::now().timestamp() + 86400 {
            return Err(format!("Future timestamp not allowed: {}", point.timestamp));
        }
    }
    
    let mut buffer = state.write_buffer.lock().await;
    buffer.extend(data_points);
    
    let current_size = buffer.len();
    
    // Flush if buffer is full
    if current_size >= WRITE_BUFFER_SIZE {
        drop(buffer); // Release lock before async flush
        flush_buffer(&state.write_buffer, &state.db_pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(current_size)
    } else {
        Ok(current_size)
    }
}

/// Query time-series data with optional downsampling
#[tauri::command]
pub async fn query_timeseries(
    source_id: String,
    metric: String,
    start_time: i64,
    end_time: i64,
    granularity: Option<String>,
    state: State<'_, StorageState>,
) -> Result<Vec<DataPoint>, String> {
    // Validate range
    if start_time > end_time {
        return Err("Start time must be before end time".to_string());
    }
    
    // Check cache first
    let cache_key = format!("{}:{}:{}:{}:{:?}", source_id, metric, start_time, end_time, granularity);
    {
        let mut cache = state.query_cache.lock().await;
        if let Some(cached) = cache.get(&cache_key) {
            if cached.cached_at.elapsed() < Duration::from_secs(QUERY_CACHE_TTL_SECS) {
                return Ok(cached.data.clone());
            }
        }
    }
    
    // Query from DB
    let granularity = granularity.unwrap_or_else(|| "raw".to_string());
    let result = match granularity.as_str() {
        "raw" => query_raw_timeseries(&state.db_pool, &source_id, &metric, start_time, end_time).await,
        "1min" | "5min" | "1hour" | "1day" => {
            query_downsampled(&state.db_pool, &source_id, &metric, start_time, end_time, &granularity).await
        }
        _ => Err("Invalid granularity. Use: raw, 1min, 5min, 1hour, 1day".into()),
    }.map_err(|e| e.to_string())?;
    
    // Cache result
    {
        let mut cache = state.query_cache.lock().await;
        cache.put(cache_key, CachedQuery {
            data: result.clone(),
            cached_at: Instant::now(),
        });
    }
    
    Ok(result)
}

/// Calculate correlation between two time-series
#[tauri::command]
pub async fn get_correlation_data(
    source_a: String,
    source_b: String,
    time_range: String,
    state: State<'_, StorageState>,
) -> Result<f64, String> {
    // Parse time range (e.g., "7d", "24h", "30d")
    let (start_time, end_time) = parse_time_range(&time_range)
        .map_err(|e| e.to_string())?;
    
    // Check correlation cache
    let cache_key = format!("{}:{}:{}:{}:{}", source_a, source_b, start_time, end_time, time_range);
    {
        let mut cache = state.correlation_cache.lock().await;
        if let Some((value, cached_at)) = cache.get(&cache_key) {
            if cached_at.elapsed() < Duration::from_secs(CORRELATION_CACHE_TTL_SECS) {
                return Ok(*value);
            }
        }
    }
    
    // Fetch both series
    let series_a = query_raw_timeseries(&state.db_pool, &source_a, "price", start_time, end_time).await
        .map_err(|e| format!("Failed to fetch {}: {}", source_a, e))?;
    let series_b = query_raw_timeseries(&state.db_pool, &source_b, "price", start_time, end_time).await
        .map_err(|e| format!("Failed to fetch {}: {}", source_b, e))?;
    
    if series_a.is_empty() || series_b.is_empty() {
        return Err("Empty time series".to_string());
    }
    
    // Calculate correlation
    let correlation = calculate_pearson_correlation(&series_a, &series_b);
    
    // Cache result
    {
        let mut cache = state.correlation_cache.lock().await;
        cache.put(cache_key, (correlation, Instant::now()));
    }
    
    Ok(correlation)
}

/// Get available metrics for a source
#[tauri::command]
pub async fn get_available_metrics(
    source_id: String,
    state: State<'_, StorageState>,
) -> Result<Vec<String>, String> {
    let conn = state.db_pool.get().map_err(|e: r2d2::Error| e.to_string())?;
    
    let mut stmt = conn.prepare(
        "SELECT DISTINCT metric_type FROM timeseries WHERE source_id = ? ORDER BY metric_type"
    ).map_err(|e: rusqlite::Error| e.to_string())?;
    
    let metrics: Result<Vec<String>, rusqlite::Error> = stmt.query_map(params![source_id], |row: &rusqlite::Row| {
        row.get::<_, String>(0)
    }).map_err(|e: rusqlite::Error| e.to_string())?
    .collect();
    
    metrics.map_err(|e: rusqlite::Error| e.to_string())
}

/// Delete time-series data older than timestamp
#[tauri::command]
pub async fn delete_timeseries(
    source_id: Option<String>,
    before_timestamp: i64,
    state: State<'_, StorageState>,
) -> Result<usize, String> {
    let conn = state.db_pool.get().map_err(|e: r2d2::Error| e.to_string())?;
    
    let rows_affected = if let Some(source) = source_id {
        conn.execute(
            "DELETE FROM timeseries WHERE source_id = ? AND timestamp < ?",
            params![source, before_timestamp],
        ).map_err(|e: rusqlite::Error| e.to_string())?
    } else {
        conn.execute(
            "DELETE FROM timeseries WHERE timestamp < ?",
            [before_timestamp],
        ).map_err(|e: rusqlite::Error| e.to_string())?
    };
    
    // Vacuum to reclaim space (optional, could be scheduled)
    if rows_affected > 10000 {
        let _ = conn.execute("VACUUM", []);
    }
    
    Ok(rows_affected)
}

/// Get storage statistics
#[tauri::command]
pub async fn get_storage_stats(
    state: State<'_, StorageState>,
) -> Result<JsonValue, String> {
    let conn = state.db_pool.get().map_err(|e: r2d2::Error| e.to_string())?;
    
    // Total rows
    let total_rows: i64 = conn.query_row(
        "SELECT COUNT(*) FROM timeseries",
        [],
        |row: &rusqlite::Row| row.get(0)
    ).map_err(|e: rusqlite::Error| e.to_string())?;
    
    // Database size
    let page_count: i64 = conn.query_row("PRAGMA page_count", [], |r: &rusqlite::Row| r.get(0)).unwrap_or(0);
    let page_size: i64 = conn.query_row("PRAGMA page_size", [], |r: &rusqlite::Row| r.get(0)).unwrap_or(0);
    let db_size = page_count * page_size;
    
    // Time range
    let (oldest, newest): (Option<i64>, Option<i64>) = conn.query_row(
        "SELECT MIN(timestamp), MAX(timestamp) FROM timeseries",
        [],
        |row: &rusqlite::Row| Ok((row.get(0).unwrap_or(None), row.get(1).unwrap_or(None)))
    ).map_err(|e: rusqlite::Error| e.to_string())?;
    
    // Rows per source (top 10)
    let mut stmt = conn.prepare(
        "SELECT source_id, COUNT(*) as count FROM timeseries GROUP BY source_id ORDER BY count DESC LIMIT 10"
    ).map_err(|e: rusqlite::Error| e.to_string())?;
    
    let source_counts: Result<HashMap<String, i64>, rusqlite::Error> = stmt.query_map([], |row: &rusqlite::Row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    }).map_err(|e: rusqlite::Error| e.to_string())?
    .collect();
    
    let write_buffer_size = {
        let buf = state.write_buffer.lock().await;
        buf.len()
    };
    
    let rows_per_source = source_counts.map_err(|e: rusqlite::Error| e.to_string())?;
    
    Ok(serde_json::json!({
        "total_rows": total_rows,
        "db_size_bytes": db_size,
        "oldest_record": oldest,
        "newest_record": newest,
        "rows_per_source": rows_per_source,
        "write_buffer_size": write_buffer_size
    }))
}

// ============================================================================
// DATABASE OPERATIONS
// ============================================================================

fn init_database(pool: &Pool<SqliteConnectionManager>) -> Result<(), Box<dyn std::error::Error>> {
    let conn = pool.get()?;
    
    // Apply WAL mode first (must be done before any transactions)
    // Note: PRAGMA returns a result, so we use query_row to capture it
    let _ : String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    
    // Apply other PRAGMAs
    conn.execute("PRAGMA synchronous = NORMAL", [])?;
    
    // Create table with optimized schema for time-series
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS timeseries (
            timestamp INTEGER NOT NULL,
            source_id TEXT NOT NULL,
            metric_type TEXT NOT NULL,
            value REAL NOT NULL,
            metadata TEXT,
            PRIMARY KEY (timestamp, source_id, metric_type)
        ) WITHOUT ROWID;
        
        CREATE INDEX IF NOT EXISTS idx_source_time_metric 
        ON timeseries(source_id, timestamp DESC, metric_type);
        
        CREATE INDEX IF NOT EXISTS idx_metric_time 
        ON timeseries(metric_type, timestamp) 
        WHERE metric_type = 'price';
        "
    )?;
    
    Ok(())
}

async fn flush_buffer(
    buffer: &Arc<Mutex<Vec<DataPoint>>>,
    pool: &Pool<SqliteConnectionManager>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let points: Vec<DataPoint> = {
        let mut buf = buffer.lock().await;
        if buf.is_empty() {
            return Ok(());
        }
        std::mem::replace(&mut *buf, Vec::with_capacity(WRITE_BUFFER_SIZE))
    };
    
    let num_points = points.len();
    let pool = pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get()?;
        let tx = conn.transaction()?;
        
        {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO timeseries (timestamp, source_id, metric_type, value, metadata)
                 VALUES (?, ?, ?, ?, ?)"
            )?;
            
            for point in &points {
                let metadata_str = point.metadata.as_ref().map(|m| m.to_string());
                stmt.execute(params![
                    point.timestamp,
                    point.source_id,
                    point.metric,
                    point.value,
                    metadata_str
                ])?;
            }
        }
        
        tx.commit()?;
        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    }).await.map_err(|e| format!("Flush task failed: {}", e))??;
    
    println!("Flushed {} data points to database", num_points);
    Ok(())
}

async fn query_raw_timeseries(
    pool: &Pool<SqliteConnectionManager>,
    source_id: &str,
    metric: &str,
    start_time: i64,
    end_time: i64,
) -> Result<Vec<DataPoint>, Box<dyn std::error::Error + Send + Sync>> {
    let source_id = source_id.to_string();
    let metric = metric.to_string();
    let pool = pool.clone();
    
    tokio::task::spawn_blocking(move || {
        let conn = pool.get()?;
        let mut stmt = conn.prepare(
            "SELECT timestamp, value, metadata FROM timeseries
             WHERE source_id = ? AND metric_type = ? AND timestamp BETWEEN ? AND ?
             ORDER BY timestamp ASC"
        )?;
        
        let points: Result<Vec<DataPoint>, rusqlite::Error> = stmt.query_map(
            params![source_id, metric, start_time, end_time],
            |row: &rusqlite::Row| {
                let metadata_str: Option<String> = row.get(2)?;
                let metadata: Option<JsonValue> = metadata_str.and_then(|s| serde_json::from_str(&s).ok());
                
                Ok(DataPoint {
                    timestamp: row.get(0)?,
                    source_id: source_id.clone(),
                    metric: metric.clone(),
                    value: row.get(1)?,
                    metadata,
                })
            }
        )?
        .collect();
        
        Ok::<Vec<DataPoint>, Box<dyn std::error::Error + Send + Sync>>(points?)
    }).await?
}

async fn query_downsampled(
    pool: &Pool<SqliteConnectionManager>,
    source_id: &str,
    metric: &str,
    start_time: i64,
    end_time: i64,
    granularity: &str,
) -> Result<Vec<DataPoint>, Box<dyn std::error::Error + Send + Sync>> {
    let interval_seconds = match granularity {
        "1min" => 60,
        "5min" => 300,
        "1hour" => 3600,
        "1day" => 86400,
        _ => 60,
    };
    
    let source_id = source_id.to_string();
    let metric = metric.to_string();
    let pool = pool.clone();
    
    tokio::task::spawn_blocking(move || {
        let conn = pool.get()?;
        
        // SQLite window function for time bucketing
        // Note: ? are SQL parameter placeholders, not format placeholders
        let sql = "SELECT
                (timestamp / ?) * ? as bucket,
                FIRST_VALUE(value) OVER (PARTITION BY bucket ORDER BY timestamp) as open,
                MAX(value) as high,
                MIN(value) as low,
                LAST_VALUE(value) OVER (PARTITION BY bucket ORDER BY timestamp ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as close,
                AVG(value) as avg
             FROM timeseries
             WHERE source_id = ? AND metric_type = ? AND timestamp BETWEEN ? AND ?
             GROUP BY bucket
             ORDER BY bucket";
        
        let mut stmt = conn.prepare_cached(sql)?;
        
        let points: Result<Vec<DataPoint>, rusqlite::Error> = stmt.query_map(
            params![interval_seconds, interval_seconds, source_id, metric, start_time, end_time],
            |row: &rusqlite::Row| {
                Ok(DataPoint {
                    timestamp: row.get::<_, i64>(0)? * interval_seconds,
                    source_id: source_id.clone(),
                    metric: metric.clone(),
                    value: row.get::<_, f64>(5)?, // Return average as the value
                    metadata: Some(serde_json::json!({
                        "ohlc": {
                            "open": row.get::<_, f64>(1)?,
                            "high": row.get::<_, f64>(2)?,
                            "low": row.get::<_, f64>(3)?,
                            "close": row.get::<_, f64>(4)?
                        }
                    })),
                })
            }
        )?.collect();
        
        Ok::<Vec<DataPoint>, Box<dyn std::error::Error + Send + Sync>>(points?)
    }).await?
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

fn parse_time_range(range: &str) -> Result<(i64, i64), Box<dyn std::error::Error>> {
    let end = Utc::now().timestamp();
    
    let duration = if range.ends_with('d') {
        let days: i64 = range[..range.len()-1].parse()?;
        ChronoDuration::days(days)
    } else if range.ends_with('h') {
        let hours: i64 = range[..range.len()-1].parse()?;
        ChronoDuration::hours(hours)
    } else if range.ends_with('m') {
        let minutes: i64 = range[..range.len()-1].parse()?;
        ChronoDuration::minutes(minutes)
    } else {
        return Err("Invalid time range format. Use: 7d, 24h, 60m".into());
    };
    
    let start = end - duration.num_seconds();
    Ok((start, end))
}

fn calculate_pearson_correlation(a: &[DataPoint], b: &[DataPoint]) -> f64 {
    // Create hash maps for O(1) lookup by timestamp
    let map_a: HashMap<i64, f64> = a.iter().map(|p| (p.timestamp, p.value)).collect();
    let map_b: HashMap<i64, f64> = b.iter().map(|p| (p.timestamp, p.value)).collect();
    
    // Find common timestamps
    let common_timestamps: Vec<i64> = map_a.keys()
        .filter(|k| map_b.contains_key(*k))
        .copied()
        .collect();
    
    if common_timestamps.len() < 2 {
        return 0.0;
    }
    
    let n = common_timestamps.len() as f64;
    let values_a: Vec<f64> = common_timestamps.iter().map(|t| map_a[t]).collect();
    let values_b: Vec<f64> = common_timestamps.iter().map(|t| map_b[t]).collect();
    
    let mean_a = values_a.iter().sum::<f64>() / n;
    let mean_b = values_b.iter().sum::<f64>() / n;
    
    let mut numerator = 0.0;
    let mut denom_a = 0.0;
    let mut denom_b = 0.0;
    
    for i in 0..common_timestamps.len() {
        let diff_a = values_a[i] - mean_a;
        let diff_b = values_b[i] - mean_b;
        
        numerator += diff_a * diff_b;
        denom_a += diff_a * diff_a;
        denom_b += diff_b * diff_b;
    }
    
    if denom_a == 0.0 || denom_b == 0.0 {
        return 0.0;
    }
    
    numerator / (denom_a.sqrt() * denom_b.sqrt())
}

/// Graceful shutdown helper - call this before app exit
pub async fn shutdown_storage(state: &StorageState) -> Result<(), String> {
    println!("Shutting down storage, flushing remaining buffer...");
    flush_buffer(&state.write_buffer, &state.db_pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================================
// NODE DATA COMMANDS
// ============================================================================

/// Stored data for a node (from timeseries or websocket_messages)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeStoredData {
    /// Data points from timeseries table
    pub timeseries: Vec<DataPoint>,
    /// Recent websocket messages
    pub websocket_messages: Vec<WebsocketMessage>,
    /// Available metrics for this node
    pub available_metrics: Vec<String>,
    /// Total count of stored data points
    pub total_points: i64,
    /// Oldest timestamp
    pub oldest_timestamp: Option<i64>,
    /// Newest timestamp
    pub newest_timestamp: Option<i64>,
}

/// Websocket message from database
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebsocketMessage {
    pub id: i64,
    pub timestamp: i64,
    pub node_id: String,
    pub message_type: String,
    pub payload: JsonValue,
    pub processed: bool,
}

/// Get all stored data for a specific node
#[tauri::command]
pub async fn get_node_stored_data(
    node_id: String,
    limit: Option<i32>,
    state: State<'_, StorageState>,
) -> Result<NodeStoredData, String> {
    let limit = limit.unwrap_or(100);
    
    // Get timeseries data
    let timeseries = get_node_timeseries(&state.db_pool, &node_id, limit)
        .await
        .map_err(|e| e.to_string())?;
    
    // Get websocket messages
    let websocket_messages = get_node_websocket_messages(&state.db_pool, &node_id, limit)
        .await
        .map_err(|e| e.to_string())?;
    
    // Get available metrics
    let available_metrics = get_node_metrics(&state.db_pool, &node_id)
        .await
        .map_err(|e| e.to_string())?;
    
    // Get statistics
    let (total_points, oldest_timestamp, newest_timestamp) = get_node_stats(&state.db_pool, &node_id)
        .await
        .map_err(|e| e.to_string())?;
    
    Ok(NodeStoredData {
        timeseries,
        websocket_messages,
        available_metrics,
        total_points,
        oldest_timestamp,
        newest_timestamp,
    })
}

/// Get timeseries data for a node
async fn get_node_timeseries(
    pool: &Pool<SqliteConnectionManager>,
    node_id: &str,
    limit: i32,
) -> Result<Vec<DataPoint>, Box<dyn std::error::Error + Send + Sync>> {
    let pool = pool.clone();
    let node_id = node_id.to_string();
    
    tokio::task::spawn_blocking(move || {
        let conn = pool.get()?;
        
        let mut stmt = conn.prepare_cached(
            "SELECT timestamp, source_id, metric_type, value, metadata 
             FROM timeseries 
             WHERE source_id = ? 
             ORDER BY timestamp DESC 
             LIMIT ?"
        )?;
        
        let points: Result<Vec<DataPoint>, rusqlite::Error> = stmt.query_map(
            params![node_id, limit],
            |row| {
                let metadata_str: Option<String> = row.get(4)?;
                let metadata = metadata_str.and_then(|s| serde_json::from_str(&s).ok());
                
                Ok(DataPoint {
                    timestamp: row.get(0)?,
                    source_id: row.get(1)?,
                    metric: row.get(2)?,
                    value: row.get(3)?,
                    metadata,
                })
            }
        )?.collect();
        
        Ok(points?)
    }).await?
}

/// Get websocket messages for a node
async fn get_node_websocket_messages(
    pool: &Pool<SqliteConnectionManager>,
    node_id: &str,
    limit: i32,
) -> Result<Vec<WebsocketMessage>, Box<dyn std::error::Error + Send + Sync>> {
    let pool = pool.clone();
    let node_id = node_id.to_string();
    
    tokio::task::spawn_blocking(move || {
        let conn = pool.get()?;
        
        let mut stmt = conn.prepare_cached(
            "SELECT id, timestamp, node_id, message_type, payload, processed 
             FROM websocket_messages 
             WHERE node_id = ? 
             ORDER BY timestamp DESC 
             LIMIT ?"
        )?;
        
        let messages: Result<Vec<WebsocketMessage>, rusqlite::Error> = stmt.query_map(
            params![node_id, limit],
            |row| {
                let payload_str: String = row.get(4)?;
                let payload = serde_json::from_str(&payload_str).unwrap_or(serde_json::json!(null));
                
                Ok(WebsocketMessage {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    node_id: row.get(2)?,
                    message_type: row.get(3)?,
                    payload,
                    processed: row.get::<_, i32>(5)? != 0,
                })
            }
        )?.collect();
        
        Ok(messages?)
    }).await?
}

/// Get available metrics for a node
async fn get_node_metrics(
    pool: &Pool<SqliteConnectionManager>,
    node_id: &str,
) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
    let pool = pool.clone();
    let node_id = node_id.to_string();
    
    tokio::task::spawn_blocking(move || {
        let conn = pool.get()?;
        
        let mut stmt = conn.prepare_cached(
            "SELECT DISTINCT metric_type FROM timeseries WHERE source_id = ?"
        )?;
        
        let metrics: Result<Vec<String>, rusqlite::Error> = stmt.query_map(
            params![node_id],
            |row| row.get(0)
        )?.collect();
        
        Ok(metrics?)
    }).await?
}

/// Get statistics for a node's stored data
async fn get_node_stats(
    pool: &Pool<SqliteConnectionManager>,
    node_id: &str,
) -> Result<(i64, Option<i64>, Option<i64>), Box<dyn std::error::Error + Send + Sync>> {
    let pool = pool.clone();
    let node_id = node_id.to_string();
    
    tokio::task::spawn_blocking(move || {
        let conn = pool.get()?;
        
        let mut stmt = conn.prepare_cached(
            "SELECT COUNT(*), MIN(timestamp), MAX(timestamp) FROM timeseries WHERE source_id = ?"
        )?;
        
        let result = stmt.query_row(params![node_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
            ))
        })?;
        
        Ok(result)
    }).await?
}

/// Delete stored data for a node
#[tauri::command]
pub async fn delete_node_stored_data(
    node_id: String,
    state: State<'_, StorageState>,
) -> Result<usize, String> {
    let pool = state.db_pool.clone();
    let node_id = node_id.to_string();
    
    let result = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|e| e.to_string())?;
        
        // Delete timeseries data
        let ts_count = conn.execute(
            "DELETE FROM timeseries WHERE source_id = ?",
            params![node_id]
        ).map_err(|e| e.to_string())?;
        
        // Delete websocket messages
        let ws_count = conn.execute(
            "DELETE FROM websocket_messages WHERE node_id = ?",
            params![node_id]
        ).map_err(|e| e.to_string())?;
        
        Ok::<usize, String>(ts_count + ws_count)
    }).await;
    
    result.map_err(|e| e.to_string())?
}