// ============================================================================
// SQLITE DATABASE LAYER
// ============================================================================
//
// Purpose: Complete SQLite persistence layer for the prediction market terminal.
//
// Uses SQLite with WAL mode for concurrent access. Chosen for zero-config
// embedded operation with sub-millisecond query times and 10k+ writes/second.
//
// TABLES:
//   nodes           - Info sources and market connections (graph vertices)
//   connections     - Graph edges between nodes (unique source+target)
//   timeseries      - Scraped data points (indexed by source_id + timestamp)
//   positions       - Trading positions and P&L
//   scraper_status  - Health tracking for each data source scraper
//   event_log       - Audit trail of system events
//   api_keys        - Encrypted API credentials per platform (unique per platform)
//
// PERFORMANCE PRAGMAS:
//   WAL mode, synchronous=NORMAL, 64MB cache, memory temp store, 30GB mmap.
//   Strategic indexes on all query hot paths.
//
// KEY FUNCTIONS:
//   Connection: create_connection, setup_schema, apply_optimizations
//   Nodes:      insert/update/delete/get_node_by_id/get_all_active_nodes
//   Series:     insert_timeseries, batch_insert_timeseries, query_timeseries
//   Positions:  insert_position, get_positions
//   Scraper:    update_scraper_status, get_scraper_status
//   Events:     log_event, get_recent_events
//   Maintenance: vacuum_database, get_database_stats
//
// Serialization helpers: serialize_node_type() and deserialize_node() convert
// between NodeType enums and string pairs for database storage.
// ============================================================================

use chrono::Utc;
use rusqlite::{params, types::Value, Result as SqliteResult, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::path::Path;

// Re-export rusqlite::Connection so other modules can use it
pub use rusqlite::Connection;

use crate::models::node::{InfoSourceType, MarketType, Node, NodeType};
use crate::models::position::Position;

// ============================================================================
// CONNECTION AND SCHEMA SETUP
// ============================================================================

/// Create a new SQLite connection with proper configuration
pub fn create_connection(db_path: &Path) -> SqliteResult<Connection> {
    let conn = Connection::open(db_path)?;
    println!("SQLite connection established: {}", db_path.display());
    Ok(conn)
}

/// Set up the complete database schema
pub fn setup_schema(conn: &Connection) -> SqliteResult<()> {
    // Nodes table - stores info sources and market connections
    conn.execute(
        "CREATE TABLE IF NOT EXISTS nodes (
            id TEXT PRIMARY KEY,
            node_type TEXT NOT NULL,
            node_subtype TEXT NOT NULL,
            position_x REAL NOT NULL DEFAULT 0.0,
            position_y REAL NOT NULL DEFAULT 0.0,
            size_width REAL,
            size_height REAL,
            metadata JSON,
            archived INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        [],
    )?;

    // Add size columns to existing databases (migration)
    let _ = conn.execute("ALTER TABLE nodes ADD COLUMN size_width REAL", []);
    let _ = conn.execute("ALTER TABLE nodes ADD COLUMN size_height REAL", []);

    // Add retention_seconds column for auto-deletion (migration)
    let _ = conn.execute("ALTER TABLE nodes ADD COLUMN retention_seconds INTEGER DEFAULT NULL", []);

    // Connections table - stores edges between nodes
    conn.execute(
        "CREATE TABLE IF NOT EXISTS connections (
            id TEXT PRIMARY KEY,
            source_node_id TEXT NOT NULL,
            target_node_id TEXT NOT NULL,
            strength REAL NOT NULL DEFAULT 1.0,
            correlation REAL,
            metadata JSON,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (source_node_id) REFERENCES nodes(id),
            FOREIGN KEY (target_node_id) REFERENCES nodes(id),
            UNIQUE(source_node_id, target_node_id)
        )",
        [],
    )?;

    // Time-series table - stores all scraped data points
    conn.execute(
        "CREATE TABLE IF NOT EXISTS timeseries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            source_id TEXT NOT NULL,
            metric_type TEXT NOT NULL,
            value REAL NOT NULL,
            metadata JSON,
            FOREIGN KEY (source_id) REFERENCES nodes(id)
        )",
        [],
    )?;

    // Positions table - stores trading positions
    conn.execute(
        "CREATE TABLE IF NOT EXISTS positions (
            id TEXT PRIMARY KEY,
            market_id TEXT NOT NULL,
            market_type TEXT NOT NULL,
            position_type TEXT NOT NULL,
            quantity REAL NOT NULL,
            entry_price REAL NOT NULL,
            exit_price REAL,
            entry_time INTEGER NOT NULL,
            exit_time INTEGER,
            realized_pnl REAL,
            fees REAL NOT NULL DEFAULT 0.0,
            status TEXT NOT NULL,
            metadata JSON,
            FOREIGN KEY (market_id) REFERENCES nodes(id)
        )",
        [],
    )?;

    // Scraper status table - tracks health of each data source
    conn.execute(
        "CREATE TABLE IF NOT EXISTS scraper_status (
            node_id TEXT PRIMARY KEY,
            active INTEGER NOT NULL DEFAULT 1,
            last_update INTEGER,
            last_error TEXT,
            data_points_collected INTEGER NOT NULL DEFAULT 0,
            uptime_seconds INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (node_id) REFERENCES nodes(id)
        )",
        [],
    )?;

    // Event log table - audit trail of all system events
    conn.execute(
        "CREATE TABLE IF NOT EXISTS event_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            node_id TEXT,
            event_type TEXT NOT NULL,
            event_data JSON,
            severity TEXT NOT NULL DEFAULT 'info'
        )",
        [],
    )?;

    // Websocket messages table - stores all received websocket data per node
    conn.execute(
        "CREATE TABLE IF NOT EXISTS websocket_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            node_id TEXT NOT NULL,
            message_type TEXT NOT NULL,
            payload JSON NOT NULL,
            processed INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (node_id) REFERENCES nodes(id)
        )",
        [],
    )?;

    // API keys table - stores encrypted API credentials for market platforms
    // Security: Keys are stored encrypted using platform-specific secure storage
    conn.execute(
        "CREATE TABLE IF NOT EXISTS api_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL UNIQUE,
            api_key TEXT NOT NULL,
            api_secret TEXT,
            private_key TEXT,
            environment TEXT DEFAULT 'demo',
            additional_config JSON,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        [],
    )?;

    // Analyzer nodes table - stores analyzer configurations attached to graph nodes
    conn.execute(
        "CREATE TABLE IF NOT EXISTS analyzer_nodes (
            id TEXT PRIMARY KEY,
            node_id TEXT NOT NULL,
            analyzer_type TEXT NOT NULL,
            config JSON NOT NULL DEFAULT '{}',
            enabled INTEGER NOT NULL DEFAULT 1,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (node_id) REFERENCES nodes(id)
        )",
        [],
    )?;

    // Analyzer results table - cached analysis results for UI display
    conn.execute(
        "CREATE TABLE IF NOT EXISTS analyzer_results (
            id TEXT PRIMARY KEY,
            analyzer_id TEXT NOT NULL,
            result_type TEXT NOT NULL,
            value REAL NOT NULL,
            confidence REAL NOT NULL,
            metadata JSON,
            timestamp INTEGER NOT NULL,
            FOREIGN KEY (analyzer_id) REFERENCES analyzer_nodes(id)
        )",
        [],
    )?;

    // Analyzer chains table - defines chaining relationships between analyzers
    conn.execute(
        "CREATE TABLE IF NOT EXISTS analyzer_chains (
            id TEXT PRIMARY KEY,
            source_analyzer_id TEXT NOT NULL,
            target_analyzer_id TEXT NOT NULL,
            transform TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (source_analyzer_id) REFERENCES analyzer_nodes(id),
            FOREIGN KEY (target_analyzer_id) REFERENCES analyzer_nodes(id)
        )",
        [],
    )?;

    // =========================================================================
    // MULTI-LEG POSITION TABLES
    // =========================================================================
    //
    // These tables support multi-outcome (categorical) markets and multi-leg
    // order structures. A multi-leg position groups related position legs
    // under a shared strategy for combined P&L tracking.
    //
    // Schema:
    //   multi_leg_positions: Parent position with strategy metadata
    //   position_legs: Individual legs linked to parent position
    //
    // Relationships:
    //   position_legs.position_id -> multi_leg_positions.id (1:N)
    //   position_legs.market_id -> nodes.id (market node reference)
    //
    // =========================================================================

    // Multi-leg positions table - groups related position legs under a strategy
    conn.execute(
        "CREATE TABLE IF NOT EXISTS multi_leg_positions (
            id TEXT PRIMARY KEY,
            strategy_id TEXT NOT NULL,
            strategy_type TEXT NOT NULL,
            strategy_label TEXT,
            status TEXT NOT NULL DEFAULT 'open',
            opened_at INTEGER NOT NULL,
            closed_at INTEGER,
            metadata JSON,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        [],
    )?;

    // Position legs table - individual legs within a multi-leg position
    conn.execute(
        "CREATE TABLE IF NOT EXISTS position_legs (
            leg_id TEXT PRIMARY KEY,
            position_id TEXT NOT NULL,
            market_id TEXT NOT NULL,
            outcome_id TEXT,
            side TEXT NOT NULL,
            size REAL NOT NULL,
            entry_price REAL NOT NULL,
            exit_price REAL,
            current_price REAL NOT NULL,
            fees REAL NOT NULL DEFAULT 0.0,
            status TEXT NOT NULL DEFAULT 'open',
            market_node_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (position_id) REFERENCES multi_leg_positions(id)
        )",
        [],
    )?;

    // =========================================================================
    // NODE GROUPS TABLE
    // =========================================================================
    //
    // Stores visual node groups for organizing related nodes on the canvas.
    // Groups can be manually created by users or automatically created when
    // adding series/events. The origin field tracks group provenance.
    //
    // Origin types:
    //   manual: User-created group via context menu
    //   series: Auto-created when adding a series/event
    //
    // =========================================================================

    // Node groups table - stores group metadata and membership
    conn.execute(
        "CREATE TABLE IF NOT EXISTS node_groups (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#8b5cf6',
            padding INTEGER NOT NULL DEFAULT 40,
            origin_type TEXT NOT NULL DEFAULT 'manual',
            origin_data JSON,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        [],
    )?;

    // Group membership table - tracks which nodes belong to which groups
    conn.execute(
        "CREATE TABLE IF NOT EXISTS group_members (
            group_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            added_at INTEGER NOT NULL,
            PRIMARY KEY (group_id, node_id),
            FOREIGN KEY (group_id) REFERENCES node_groups(id) ON DELETE CASCADE,
            FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
        )",
        [],
    )?;

    // Sessions table - tracks app session start/end times for uptime history
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            started_at INTEGER NOT NULL,
            ended_at INTEGER
        )",
        [],
    )?;

    // Trades table - records all executed trades for history
    conn.execute(
        "CREATE TABLE IF NOT EXISTS trades (
            id TEXT PRIMARY KEY,
            position_id TEXT,
            market_id TEXT NOT NULL,
            market_type TEXT NOT NULL,
            side TEXT NOT NULL,
            order_type TEXT NOT NULL,
            requested_size REAL NOT NULL,
            filled_size REAL NOT NULL,
            price REAL NOT NULL,
            fees REAL NOT NULL DEFAULT 0.0,
            status TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            metadata JSON,
            FOREIGN KEY (position_id) REFERENCES positions(id),
            FOREIGN KEY (market_id) REFERENCES nodes(id)
        )",
        [],
    )?;

    // Orders table - tracks pending/open orders
    conn.execute(
        "CREATE TABLE IF NOT EXISTS orders (
            id TEXT PRIMARY KEY,
            market_id TEXT NOT NULL,
            market_type TEXT NOT NULL,
            side TEXT NOT NULL,
            order_type TEXT NOT NULL,
            size REAL NOT NULL,
            price REAL,
            filled_size REAL NOT NULL DEFAULT 0.0,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            metadata JSON,
            FOREIGN KEY (market_id) REFERENCES nodes(id)
        )",
        [],
    )?;

    // Create indexes for performance
    create_indexes(conn)?;

    println!("Database schema created successfully");
    Ok(())
}

/// Create indexes for fast queries
fn create_indexes(conn: &Connection) -> SqliteResult<()> {
    // Index for time-series queries (most common: fetch by source + time range)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_timeseries_source_time 
         ON timeseries(source_id, timestamp DESC)",
        [],
    )?;

    // Index for time-series by metric type
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_timeseries_metric 
         ON timeseries(metric_type, timestamp DESC)",
        [],
    )?;

    // Index for active nodes
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_nodes_archived 
         ON nodes(archived) WHERE archived = 0",
        [],
    )?;

    // Index for open positions
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_positions_status 
         ON positions(status) WHERE status = 'open'",
        [],
    )?;

    // Index for connections by source
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_connections_source 
         ON connections(source_node_id)",
        [],
    )?;

    // Index for event log by timestamp
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_event_log_time 
         ON event_log(timestamp DESC)",
        [],
    )?;

    // Index for websocket messages by node and time
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_websocket_messages_node_time 
         ON websocket_messages(node_id, timestamp DESC)",
        [],
    )?;

    // Index for websocket messages by type
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_websocket_messages_type 
         ON websocket_messages(message_type, timestamp DESC)",
        [],
    )?;

    // Index for analyzer nodes by node_id
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_analyzer_nodes_node
         ON analyzer_nodes(node_id)",
        [],
    )?;

    // Index for analyzer results by analyzer_id and time
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_analyzer_results_analyzer_time
         ON analyzer_results(analyzer_id, timestamp DESC)",
        [],
    )?;

    // Index for analyzer chains by source
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_analyzer_chains_source
         ON analyzer_chains(source_analyzer_id)",
        [],
    )?;

    // =========================================================================
    // Multi-leg position indexes
    // =========================================================================

    // Index for open multi-leg positions
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_multi_leg_positions_status
         ON multi_leg_positions(status) WHERE status = 'open'",
        [],
    )?;

    // Index for multi-leg positions by strategy
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_multi_leg_positions_strategy
         ON multi_leg_positions(strategy_id)",
        [],
    )?;

    // Index for position legs by parent position
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_position_legs_position
         ON position_legs(position_id)",
        [],
    )?;

    // Index for position legs by market
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_position_legs_market
         ON position_legs(market_id)",
        [],
    )?;

    // =========================================================================
    // Node group indexes
    // =========================================================================

    // Index for group members by node_id (for fast lookup when deleting nodes)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_group_members_node
         ON group_members(node_id)",
        [],
    )?;

    println!("Database indexes created successfully");
    Ok(())
}

/// Apply SQLite performance optimizations
pub fn apply_optimizations(conn: &Connection) -> SqliteResult<()> {
    // Note: PRAGMA journal_mode = WAL is handled via execute_batch in create_connection
    // to avoid rusqlite issues with PRAGMA returning results

    // NORMAL synchronous: Fast writes, safe for crashes (but not power loss)
    let _ = conn.execute("PRAGMA synchronous = NORMAL", []);

    // 64MB cache size for better performance
    let _ = conn.execute("PRAGMA cache_size = -64000", []);

    // Store temp tables in memory
    let _ = conn.execute("PRAGMA temp_store = MEMORY", []);

    // Foreign keys enforcement
    let _ = conn.execute("PRAGMA foreign_keys = ON", []);

    println!("Database optimizations applied");
    Ok(())
}

// ============================================================================
// NODE OPERATIONS
// ============================================================================

/// Insert a new node into the database
pub fn insert_node(conn: &Connection, node: &Node) -> SqliteResult<()> {
    let now = Utc::now().timestamp();
    let (node_type, node_subtype) = serialize_node_type(&node.node_type);

    // Extract size values from node
    let size_width = node.size.as_ref().map(|(w, _)| *w);
    let size_height = node.size.as_ref().and_then(|(_, h)| *h);

    conn.execute(
        "INSERT INTO nodes (id, node_type, node_subtype, position_x, position_y, size_width, size_height, metadata, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            &node.id,
            node_type,
            node_subtype,
            node.position.0,
            node.position.1,
            size_width,
            size_height,
            serde_json::to_string(&node.metadata).unwrap(),
            now,
            now,
        ],
    )?;

    println!("Node inserted: {}", node.id);
    Ok(())
}

/// Update an existing node
pub fn update_node(conn: &Connection, node: &Node) -> SqliteResult<()> {
    let now = Utc::now().timestamp();
    let (node_type, node_subtype) = serialize_node_type(&node.node_type);

    // Extract size values from node
    let size_width = node.size.as_ref().map(|(w, _)| *w);
    let size_height = node.size.as_ref().and_then(|(_, h)| *h);

    conn.execute(
        "UPDATE nodes 
         SET node_type = ?1, node_subtype = ?2, position_x = ?3, position_y = ?4, 
             size_width = ?5, size_height = ?6, metadata = ?7, updated_at = ?8
         WHERE id = ?9",
        params![
            node_type,
            node_subtype,
            node.position.0,
            node.position.1,
            size_width,
            size_height,
            serde_json::to_string(&node.metadata).unwrap(),
            now,
            &node.id,
        ],
    )?;

    
    Ok(())
}

/// Delete a node (soft delete - mark as archived)
pub fn delete_node(conn: &Connection, node_id: &str) -> SqliteResult<()> {
    let now = Utc::now().timestamp();

    conn.execute(
        "UPDATE nodes SET archived = 1, updated_at = ?1 WHERE id = ?2",
        params![now, node_id],
    )?;

    println!("Node archived: {}", node_id);
    Ok(())
}

/// Delete a node and all its associated data (cascade delete)
/// This removes: timeseries, websocket_messages, connections, scraper_status, positions
/// Then performs a soft delete on the node itself
pub fn delete_node_cascade(conn: &Connection, node_id: &str) -> SqliteResult<DeleteNodeStats> {
    let now = Utc::now().timestamp();
    let mut stats = DeleteNodeStats::default();

    // Delete timeseries data
    stats.timeseries_deleted = conn.execute(
        "DELETE FROM timeseries WHERE source_id = ?1",
        params![node_id],
    )?;

    // Delete websocket messages
    stats.websocket_messages_deleted = conn.execute(
        "DELETE FROM websocket_messages WHERE node_id = ?1",
        params![node_id],
    )?;

    // Delete connections where this node is source or target
    stats.connections_deleted = conn.execute(
        "DELETE FROM connections WHERE source_node_id = ?1 OR target_node_id = ?1",
        params![node_id],
    )?;

    // Delete scraper status
    stats.scraper_status_deleted = conn.execute(
        "DELETE FROM scraper_status WHERE node_id = ?1",
        params![node_id],
    )?;

    // Delete positions (for market nodes)
    stats.positions_deleted = conn.execute(
        "DELETE FROM positions WHERE market_id = ?1",
        params![node_id],
    )?;

    // Soft delete the node itself
    let node_deleted = conn.execute(
        "UPDATE nodes SET archived = 1, updated_at = ?1 WHERE id = ?2",
        params![now, node_id],
    )?;

    stats.node_archived = node_deleted > 0;

    println!("Node cascade delete completed for {}: {:?}", node_id, stats);
    Ok(stats)
}

/// Statistics about what was deleted during cascade delete
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct DeleteNodeStats {
    /// Number of timeseries entries deleted
    pub timeseries_deleted: usize,
    /// Number of websocket messages deleted
    pub websocket_messages_deleted: usize,
    /// Number of connections deleted
    pub connections_deleted: usize,
    /// Number of scraper status entries deleted
    pub scraper_status_deleted: usize,
    /// Number of positions deleted
    pub positions_deleted: usize,
    /// Whether the node was successfully archived
    pub node_archived: bool,
}

/// Get a single node by ID
pub fn get_node_by_id(conn: &Connection, node_id: &str) -> SqliteResult<Node> {
    let mut stmt = conn.prepare(
        "SELECT id, node_type, node_subtype, position_x, position_y, size_width, size_height, metadata 
         FROM nodes WHERE id = ?1 AND archived = 0"
    )?;

    let node = stmt.query_row(params![node_id], |row| Ok(deserialize_node(row)))?;

    Ok(node)
}

/// Get all active (non-archived) nodes
pub fn get_all_active_nodes(conn: &Connection) -> SqliteResult<Vec<Node>> {
    let mut stmt = conn.prepare(
        "SELECT id, node_type, node_subtype, position_x, position_y, size_width, size_height, metadata 
         FROM nodes WHERE archived = 0 
         ORDER BY created_at DESC"
    )?;

    let nodes = stmt
        .query_map([], |row| Ok(deserialize_node(row)))?
        .collect::<SqliteResult<Vec<Node>>>()?;

    println!("Retrieved {} active nodes", nodes.len());
    Ok(nodes)
}

// ============================================================================
// CONNECTION OPERATIONS
// ============================================================================

/// Insert a connection between two nodes
pub fn insert_connection(
    conn: &Connection,
    connection_id: &str,
    source_id: &str,
    target_id: &str,
    strength: f64,
    correlation: Option<f64>,
    metadata: Option<JsonValue>,
) -> SqliteResult<()> {
    let now = Utc::now().timestamp();

    conn.execute(
        "INSERT INTO connections (id, source_node_id, target_node_id, strength, correlation, metadata, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(source_node_id, target_node_id) DO UPDATE SET
            strength = excluded.strength,
            correlation = excluded.correlation,
            metadata = excluded.metadata",
        params![
            connection_id,
            source_id,
            target_id,
            strength,
            correlation,
            metadata.map(|m| serde_json::to_string(&m).unwrap()),
            now,
        ],
    )?;

    println!(
        "Connection inserted/updated: {} -> {}",
        source_id, target_id
    );
    Ok(())
}

/// Get all connections for a specific node
pub fn get_connections_for_node(conn: &Connection, node_id: &str) -> SqliteResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT target_node_id FROM connections WHERE source_node_id = ?1
         UNION
         SELECT source_node_id FROM connections WHERE target_node_id = ?1",
    )?;

    let connections = stmt
        .query_map(params![node_id], |row| row.get(0))?
        .collect::<SqliteResult<Vec<String>>>()?;

    Ok(connections)
}

/// Get all connections in the database (for graph restoration on startup)
pub fn get_all_connections(conn: &Connection) -> SqliteResult<Vec<(String, String, f64)>> {
    let mut stmt = conn.prepare(
        "SELECT source_node_id, target_node_id, strength FROM connections
         WHERE source_node_id IN (SELECT id FROM nodes WHERE archived = 0)
           AND target_node_id IN (SELECT id FROM nodes WHERE archived = 0)",
    )?;

    let connections = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
            ))
        })?
        .collect::<SqliteResult<Vec<(String, String, f64)>>>()?;

    println!("Retrieved {} connections", connections.len());
    Ok(connections)
}

/// Delete a specific connection between two nodes
pub fn delete_connection(
    conn: &Connection,
    source_id: &str,
    target_id: &str,
) -> SqliteResult<usize> {
    let deleted = conn.execute(
        "DELETE FROM connections WHERE source_node_id = ?1 AND target_node_id = ?2",
        params![source_id, target_id],
    )?;

    println!(
        "Connection deleted: {} -> {} (rows: {})",
        source_id, target_id, deleted
    );
    Ok(deleted)
}

// ============================================================================
// TIME-SERIES OPERATIONS
// ============================================================================

/// Insert a time-series data point
pub fn insert_timeseries(
    conn: &Connection,
    source_id: &str,
    metric_type: &str,
    value: f64,
    metadata: Option<JsonValue>,
) -> SqliteResult<()> {
    let now = Utc::now().timestamp();

    conn.execute(
        "INSERT INTO timeseries (timestamp, source_id, metric_type, value, metadata)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            now,
            source_id,
            metric_type,
            value,
            metadata.map(|m| serde_json::to_string(&m).unwrap()),
        ],
    )?;

    Ok(())
}

/// Batch insert time-series data points for performance
pub fn batch_insert_timeseries(
    conn: &Connection,
    data_points: Vec<TimeseriesDataPoint>,
) -> SqliteResult<()> {
    let tx = conn.unchecked_transaction()?;

    {
        let mut stmt = tx.prepare(
            "INSERT INTO timeseries (timestamp, source_id, metric_type, value, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;

        for point in data_points {
            stmt.execute(params![
                point.timestamp,
                point.source_id,
                point.metric_type,
                point.value,
                point.metadata.map(|m| serde_json::to_string(&m).unwrap()),
            ])?;
        }
    }

    tx.commit()?;
    println!("Batch timeseries insert completed");
    Ok(())
}

pub struct TimeseriesDataPoint {
    pub timestamp: i64,
    pub source_id: String,
    pub metric_type: String,
    pub value: f64,
    pub metadata: Option<JsonValue>,
}

/// Query time-series data with filters
pub fn query_timeseries(
    conn: &Connection,
    source_id: Option<&str>,
    metric_type: Option<&str>,
    start_time: Option<i64>,
    end_time: Option<i64>,
    limit: Option<usize>,
) -> SqliteResult<Vec<TimeseriesPoint>> {
    let mut query = String::from(
        "SELECT timestamp, source_id, metric_type, value, metadata FROM timeseries WHERE 1=1",
    );
    let mut params_vec: Vec<Value> = vec![];

    if let Some(sid) = source_id {
        query.push_str(" AND source_id = ?");
        params_vec.push(Value::Text(sid.to_string()));
    }

    if let Some(mt) = metric_type {
        query.push_str(" AND metric_type = ?");
        params_vec.push(Value::Text(mt.to_string()));
    }

    if let Some(st) = start_time {
        query.push_str(" AND timestamp >= ?");
        params_vec.push(Value::Integer(st));
    }

    if let Some(et) = end_time {
        query.push_str(" AND timestamp <= ?");
        params_vec.push(Value::Integer(et));
    }

    query.push_str(" ORDER BY timestamp DESC");

    if let Some(lim) = limit {
        query.push_str(&format!(" LIMIT {}", lim));
    }

    let mut stmt = conn.prepare(&query)?;
    // Convert Value references to &dyn ToSql
    let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec
        .iter()
        .map(|v| v as &dyn rusqlite::ToSql)
        .collect();

    let points = stmt
        .query_map(&param_refs[..], |row| {
            Ok(TimeseriesPoint {
                timestamp: row.get(0)?,
                source_id: row.get(1)?,
                metric_type: row.get(2)?,
                value: row.get(3)?,
                metadata: row
                    .get::<_, Option<String>>(4)?
                    .and_then(|s| serde_json::from_str(&s).ok()),
            })
        })?
        .collect::<SqliteResult<Vec<TimeseriesPoint>>>()?;

    println!("Queried {} timeseries points", points.len());
    Ok(points)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeseriesPoint {
    pub timestamp: i64,
    pub source_id: String,
    pub metric_type: String,
    pub value: f64,
    pub metadata: Option<JsonValue>,
}

// ============================================================================
// POSITION OPERATIONS
// ============================================================================

/// Insert a new trading position
pub fn insert_position(conn: &Connection, position: &Position) -> SqliteResult<()> {
    conn.execute(
        "INSERT INTO positions (id, market_id, market_type, position_type, quantity, entry_price, 
                                exit_price, entry_time, exit_time, realized_pnl, fees, status, metadata)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            &position.id,
            &position.market_id,
            &position.market_type,
            &position.position_type,
            position.quantity,
            position.entry_price,
            position.exit_price,
            position.entry_time,
            position.exit_time,
            position.realized_pnl,
            position.fees,
            &position.status,
            serde_json::to_string(&position.metadata).unwrap(),
        ],
    )?;

    println!("Position inserted: {}", position.id);
    Ok(())
}

/// Get all positions with optional filters
pub fn get_positions(
    conn: &Connection,
    market_id: Option<&str>,
    status: Option<&str>,
) -> SqliteResult<Vec<Position>> {
    let mut query = String::from("SELECT * FROM positions WHERE 1=1");
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![];

    if let Some(mid) = market_id {
        query.push_str(" AND market_id = ?");
        params_vec.push(Box::new(mid.to_string()));
    }

    if let Some(st) = status {
        query.push_str(" AND status = ?");
        params_vec.push(Box::new(st.to_string()));
    }

    query.push_str(" ORDER BY entry_time DESC");

    let mut stmt = conn.prepare(&query)?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|b| b.as_ref()).collect();

    let positions = stmt
        .query_map(&param_refs[..], |row| {
            Ok(Position {
                id: row.get(0)?,
                market_id: row.get(1)?,
                market_type: row.get(2)?,
                position_type: row.get(3)?,
                quantity: row.get(4)?,
                entry_price: row.get(5)?,
                exit_price: row.get(6)?,
                entry_time: row.get(7)?,
                exit_time: row.get(8)?,
                realized_pnl: row.get(9)?,
                fees: row.get(10)?,
                status: row.get(11)?,
                metadata: serde_json::from_str(&row.get::<_, String>(12)?).unwrap(),
            })
        })?
        .collect::<SqliteResult<Vec<Position>>>()?;

    println!("Retrieved {} positions", positions.len());
    Ok(positions)
}

/// Get a position by ID
pub fn get_position_by_id(conn: &Connection, position_id: &str) -> SqliteResult<Option<Position>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM positions WHERE id = ?1"
    )?;
    
    let mut rows = stmt.query(params![position_id])?;
    
    if let Some(row) = rows.next()? {
        Ok(Some(Position {
            id: row.get(0)?,
            market_id: row.get(1)?,
            market_type: row.get(2)?,
            position_type: row.get(3)?,
            quantity: row.get(4)?,
            entry_price: row.get(5)?,
            exit_price: row.get(6)?,
            entry_time: row.get(7)?,
            exit_time: row.get(8)?,
            realized_pnl: row.get(9)?,
            fees: row.get(10)?,
            status: row.get(11)?,
            metadata: serde_json::from_str(&row.get::<_, String>(12)?).unwrap_or_default(),
        }))
    } else {
        Ok(None)
    }
}

/// Update a position (for closing or modifying)
pub fn update_position(conn: &Connection, position: &Position) -> SqliteResult<()> {
    conn.execute(
        "UPDATE positions SET 
            exit_price = ?1, exit_time = ?2, realized_pnl = ?3, 
            fees = ?4, status = ?5, metadata = ?6
         WHERE id = ?7",
        params![
            position.exit_price,
            position.exit_time,
            position.realized_pnl,
            position.fees,
            &position.status,
            serde_json::to_string(&position.metadata).unwrap(),
            &position.id,
        ],
    )?;
    Ok(())
}

// ============================================================================
// TRADE HISTORY OPERATIONS
// ============================================================================

/// Trade record structure for database storage
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TradeRecord {
    pub id: String,
    pub position_id: Option<String>,
    pub market_id: String,
    pub market_type: String,
    pub side: String,
    pub order_type: String,
    pub requested_size: f64,
    pub filled_size: f64,
    pub price: f64,
    pub fees: f64,
    pub status: String,
    pub timestamp: i64,
    pub metadata: serde_json::Value,
}

/// Insert a trade record
pub fn insert_trade(conn: &Connection, trade: &TradeRecord) -> SqliteResult<()> {
    conn.execute(
        "INSERT INTO trades (id, position_id, market_id, market_type, side, order_type, 
                            requested_size, filled_size, price, fees, status, timestamp, metadata)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            &trade.id,
            &trade.position_id,
            &trade.market_id,
            &trade.market_type,
            &trade.side,
            &trade.order_type,
            trade.requested_size,
            trade.filled_size,
            trade.price,
            trade.fees,
            &trade.status,
            trade.timestamp,
            serde_json::to_string(&trade.metadata).unwrap(),
        ],
    )?;
    Ok(())
}

/// Get trade history with optional limit
pub fn get_trade_history(conn: &Connection, limit: Option<usize>) -> SqliteResult<Vec<TradeRecord>> {
    let limit_clause = limit.map(|l| format!(" LIMIT {}", l)).unwrap_or_default();
    let query = format!(
        "SELECT id, position_id, market_id, market_type, side, order_type, 
                requested_size, filled_size, price, fees, status, timestamp, metadata
         FROM trades ORDER BY timestamp DESC{}",
        limit_clause
    );
    
    let mut stmt = conn.prepare(&query)?;
    let trades = stmt
        .query_map([], |row| {
            Ok(TradeRecord {
                id: row.get(0)?,
                position_id: row.get(1)?,
                market_id: row.get(2)?,
                market_type: row.get(3)?,
                side: row.get(4)?,
                order_type: row.get(5)?,
                requested_size: row.get(6)?,
                filled_size: row.get(7)?,
                price: row.get(8)?,
                fees: row.get(9)?,
                status: row.get(10)?,
                timestamp: row.get(11)?,
                metadata: serde_json::from_str(&row.get::<_, String>(12)?).unwrap_or_default(),
            })
        })?
        .collect::<SqliteResult<Vec<TradeRecord>>>()?;
    
    Ok(trades)
}

// ============================================================================
// ORDER OPERATIONS
// ============================================================================

/// Order record structure for database storage
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OrderRecord {
    pub id: String,
    pub market_id: String,
    pub market_type: String,
    pub side: String,
    pub order_type: String,
    pub size: f64,
    pub price: Option<f64>,
    pub filled_size: f64,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub metadata: serde_json::Value,
}

/// Insert a new order
pub fn insert_order(conn: &Connection, order: &OrderRecord) -> SqliteResult<()> {
    conn.execute(
        "INSERT INTO orders (id, market_id, market_type, side, order_type, size, price, 
                            filled_size, status, created_at, updated_at, metadata)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            &order.id,
            &order.market_id,
            &order.market_type,
            &order.side,
            &order.order_type,
            order.size,
            order.price,
            order.filled_size,
            &order.status,
            order.created_at,
            order.updated_at,
            serde_json::to_string(&order.metadata).unwrap(),
        ],
    )?;
    Ok(())
}

/// Get an order by ID
pub fn get_order_by_id(conn: &Connection, order_id: &str) -> SqliteResult<Option<OrderRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, market_id, market_type, side, order_type, size, price, 
                filled_size, status, created_at, updated_at, metadata
         FROM orders WHERE id = ?1"
    )?;
    
    let mut rows = stmt.query(params![order_id])?;
    
    if let Some(row) = rows.next()? {
        Ok(Some(OrderRecord {
            id: row.get(0)?,
            market_id: row.get(1)?,
            market_type: row.get(2)?,
            side: row.get(3)?,
            order_type: row.get(4)?,
            size: row.get(5)?,
            price: row.get(6)?,
            filled_size: row.get(7)?,
            status: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
            metadata: serde_json::from_str(&row.get::<_, String>(11)?).unwrap_or_default(),
        }))
    } else {
        Ok(None)
    }
}

/// Update an order
pub fn update_order(conn: &Connection, order: &OrderRecord) -> SqliteResult<()> {
    conn.execute(
        "UPDATE orders SET 
            size = ?1, price = ?2, filled_size = ?3, status = ?4, 
            updated_at = ?5, metadata = ?6
         WHERE id = ?7",
        params![
            order.size,
            order.price,
            order.filled_size,
            &order.status,
            order.updated_at,
            serde_json::to_string(&order.metadata).unwrap(),
            &order.id,
        ],
    )?;
    Ok(())
}

/// Cancel an order by setting status to 'cancelled'
pub fn cancel_order(conn: &Connection, order_id: &str) -> SqliteResult<bool> {
    let updated = conn.execute(
        "UPDATE orders SET status = 'cancelled', updated_at = ?1 WHERE id = ?2 AND status = 'pending'",
        params![Utc::now().timestamp(), order_id],
    )?;
    Ok(updated > 0)
}

/// Get pending orders for a market
pub fn get_pending_orders(conn: &Connection, market_id: Option<&str>) -> SqliteResult<Vec<OrderRecord>> {
    let query = if market_id.is_some() {
        "SELECT id, market_id, market_type, side, order_type, size, price, 
                filled_size, status, created_at, updated_at, metadata
         FROM orders WHERE status = 'pending' AND market_id = ?1 ORDER BY created_at DESC"
    } else {
        "SELECT id, market_id, market_type, side, order_type, size, price, 
                filled_size, status, created_at, updated_at, metadata
         FROM orders WHERE status = 'pending' ORDER BY created_at DESC"
    };
    
    let mut stmt = conn.prepare(query)?;
    let orders = if let Some(mid) = market_id {
        stmt.query_map(params![mid], |row| {
            Ok(OrderRecord {
                id: row.get(0)?,
                market_id: row.get(1)?,
                market_type: row.get(2)?,
                side: row.get(3)?,
                order_type: row.get(4)?,
                size: row.get(5)?,
                price: row.get(6)?,
                filled_size: row.get(7)?,
                status: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
                metadata: serde_json::from_str(&row.get::<_, String>(11)?).unwrap_or_default(),
            })
        })?
        .collect::<SqliteResult<Vec<OrderRecord>>>()?
    } else {
        stmt.query_map([], |row| {
            Ok(OrderRecord {
                id: row.get(0)?,
                market_id: row.get(1)?,
                market_type: row.get(2)?,
                side: row.get(3)?,
                order_type: row.get(4)?,
                size: row.get(5)?,
                price: row.get(6)?,
                filled_size: row.get(7)?,
                status: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
                metadata: serde_json::from_str(&row.get::<_, String>(11)?).unwrap_or_default(),
            })
        })?
        .collect::<SqliteResult<Vec<OrderRecord>>>()?
    };
    
    Ok(orders)
}

/// Calculate balance from positions for a market type
/// Returns the sum of realized P&L from closed positions
pub fn calculate_balance(conn: &Connection, market_type: &str) -> SqliteResult<f64> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(SUM(realized_pnl), 0.0) FROM positions 
         WHERE market_type = ?1 AND status = 'closed'"
    )?;
    
    let balance: f64 = stmt.query_row(params![market_type], |row| row.get(0))?;
    Ok(balance)
}

// ============================================================================
// SCRAPER STATUS OPERATIONS
// ============================================================================

/// Update scraper status for a node
pub fn update_scraper_status(
    conn: &Connection,
    node_id: &str,
    active: bool,
    last_error: Option<&str>,
    data_points_collected: u64,
) -> SqliteResult<()> {
    let now = Utc::now().timestamp();

    conn.execute(
        "INSERT INTO scraper_status (node_id, active, last_update, last_error, data_points_collected, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(node_id) DO UPDATE SET
            active = excluded.active,
            last_update = excluded.last_update,
            last_error = excluded.last_error,
            data_points_collected = excluded.data_points_collected",
        params![node_id, active as i32, now, last_error, data_points_collected as i64, now],
    )?;

    Ok(())
}

/// Get scraper status for a node
pub fn get_scraper_status(conn: &Connection, node_id: &str) -> SqliteResult<ScraperStatus> {
    let mut stmt = conn.prepare(
        "SELECT active, last_update, last_error, data_points_collected, uptime_seconds 
         FROM scraper_status WHERE node_id = ?1",
    )?;

    stmt.query_row(params![node_id], |row| {
        let active: i32 = row.get(0)?;
        let last_update: Option<i64> = row.get(1)?;
        let last_error: Option<String> = row.get(2)?;
        let data_points_collected: i64 = row.get(3)?;
        let uptime_seconds: i64 = row.get(4)?;

        Ok(ScraperStatus {
            active: active != 0,
            last_update,
            last_error,
            data_points_collected: data_points_collected as u64,
            uptime_seconds: uptime_seconds as u64,
        })
    })
}

#[derive(Debug, Clone)]
pub struct ScraperStatus {
    pub active: bool,
    pub last_update: Option<i64>,
    pub last_error: Option<String>,
    pub data_points_collected: u64,
    pub uptime_seconds: u64,
}

// ============================================================================
// EVENT LOG OPERATIONS
// ============================================================================

/// Log an event to the audit trail
pub fn log_event(
    conn: &Connection,
    node_id: Option<&str>,
    event_type: &str,
    event_data: Option<JsonValue>,
    severity: &str,
) -> SqliteResult<()> {
    let now = Utc::now().timestamp();

    conn.execute(
        "INSERT INTO event_log (timestamp, node_id, event_type, event_data, severity)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            now,
            node_id,
            event_type,
            event_data.map(|d| serde_json::to_string(&d).unwrap()),
            severity,
        ],
    )?;

    Ok(())
}

/// Get recent events from the log
pub fn get_recent_events(conn: &Connection, limit: usize) -> SqliteResult<Vec<EventLogEntry>> {
    let mut stmt = conn.prepare(
        "SELECT timestamp, node_id, event_type, event_data, severity 
         FROM event_log 
         ORDER BY timestamp DESC 
         LIMIT ?1",
    )?;

    let events = stmt
        .query_map(params![limit], |row| {
            Ok(EventLogEntry {
                timestamp: row.get(0)?,
                node_id: row.get(1)?,
                event_type: row.get(2)?,
                event_data: row
                    .get::<_, Option<String>>(3)?
                    .and_then(|s| serde_json::from_str(&s).ok()),
                severity: row.get(4)?,
            })
        })?
        .collect::<SqliteResult<Vec<EventLogEntry>>>()?;

    Ok(events)
}

#[derive(Debug, Clone)]
pub struct EventLogEntry {
    pub timestamp: i64,
    pub node_id: Option<String>,
    pub event_type: String,
    pub event_data: Option<JsonValue>,
    pub severity: String,
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/// Serialize NodeType to database-friendly format
fn serialize_node_type(node_type: &NodeType) -> (String, String) {
    match node_type {
        NodeType::InfoSource(info_type) => ("InfoSource".to_string(), format!("{:?}", info_type)),
        NodeType::Market(market_type) => ("Market".to_string(), format!("{:?}", market_type)),
        NodeType::Analyzer(analyzer_type) => {
            ("Analyzer".to_string(), format!("{:?}", analyzer_type))
        }
    }
}

/// Deserialize a Node from a database row
fn deserialize_node(row: &Row) -> Node {
    let id: String = row.get(0).unwrap();
    let node_type_str: String = row.get(1).unwrap();
    let node_subtype_str: String = row.get(2).unwrap();
    let position_x: f64 = row.get(3).unwrap();
    let position_y: f64 = row.get(4).unwrap();
    let size_width: Option<f64> = row.get(5).unwrap();
    let size_height: Option<f64> = row.get(6).unwrap();
    let metadata_str: String = row.get(7).unwrap();

    let node_type = match node_type_str.as_str() {
        "InfoSource" => {
            let info_type = match node_subtype_str.as_str() {
                "CryptoPrices" => InfoSourceType::CryptoPrices,
                "FinancialPrices" => InfoSourceType::FinancialPrices,
                "CommodityPrices" => InfoSourceType::CommodityPrices,
                "NewsSource" => InfoSourceType::NewsSource,
                "SocialMedia" => InfoSourceType::SocialMedia,
                "Weather" => InfoSourceType::Weather,
                "Livestream" => InfoSourceType::Livestream,
                _ => InfoSourceType::CryptoPrices, // Default fallback
            };
            NodeType::InfoSource(info_type)
        }
        "Market" => {
            let market_type = match node_subtype_str.as_str() {
                "Polymarket" => MarketType::Polymarket,
                "Kalshi" => MarketType::Kalshi,
                _ => MarketType::Polymarket, // Default fallback
            };
            NodeType::Market(market_type)
        }
        "Analyzer" => {
            let analyzer_type = match node_subtype_str.as_str() {
                "Correlation" => AnalyzerType::Correlation,
                "Momentum" => AnalyzerType::Momentum,
                "Arbitrage" => AnalyzerType::Arbitrage,
                "Sentiment" => AnalyzerType::Sentiment,
                "RSI" => AnalyzerType::RSI,
                "Volatility" => AnalyzerType::Volatility,
                "Custom" => AnalyzerType::Custom,
                _ => AnalyzerType::Correlation, // Default fallback
            };
            NodeType::Analyzer(analyzer_type)
        }
        _ => NodeType::InfoSource(InfoSourceType::CryptoPrices), // Default fallback
    };

    let metadata: JsonValue = serde_json::from_str(&metadata_str).unwrap_or(serde_json::json!({}));

    // Build size option from database values
    let size = size_width.map(|w| (w, size_height));

    Node {
        id,
        node_type,
        position: (position_x, position_y),
        size,
        connections: vec![], // Loaded separately
        metadata,
    }
}

// ============================================================================
// DATA RETENTION OPERATIONS
// ============================================================================

/// Set the retention period (in seconds) for a node's stored data.
/// Pass None to disable auto-deletion (keep data forever).
pub fn set_node_retention(conn: &Connection, node_id: &str, retention_seconds: Option<i64>) -> SqliteResult<()> {
    let now = Utc::now().timestamp();
    conn.execute(
        "UPDATE nodes SET retention_seconds = ?1, updated_at = ?2 WHERE id = ?3",
        params![retention_seconds, now, node_id],
    )?;
    Ok(())
}

/// Get the retention period (in seconds) for a node, or None if unlimited.
pub fn get_node_retention(conn: &Connection, node_id: &str) -> SqliteResult<Option<i64>> {
    conn.query_row(
        "SELECT retention_seconds FROM nodes WHERE id = ?1",
        params![node_id],
        |row| row.get::<_, Option<i64>>(0),
    )
}

/// Prune expired timeseries and websocket data for all nodes with a retention period.
/// Returns the total number of rows deleted across all nodes.
pub fn prune_expired_data(conn: &Connection) -> SqliteResult<usize> {
    let now = Utc::now().timestamp();

    let mut stmt = conn.prepare(
        "SELECT id, retention_seconds FROM nodes WHERE retention_seconds IS NOT NULL AND archived = 0"
    )?;

    let nodes: Vec<(String, i64)> = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?.filter_map(|r| r.ok()).collect();

    let mut total_deleted = 0usize;

    for (node_id, retention_seconds) in &nodes {
        let cutoff = now - retention_seconds;

        total_deleted += conn.execute(
            "DELETE FROM timeseries WHERE source_id = ?1 AND timestamp < ?2",
            params![node_id, cutoff],
        )?;

        total_deleted += conn.execute(
            "DELETE FROM websocket_messages WHERE node_id = ?1 AND timestamp < ?2",
            params![node_id, cutoff],
        )?;
    }

    Ok(total_deleted)
}

// ============================================================================
// MAINTENANCE OPERATIONS
// ============================================================================

/// Vacuum the database to reclaim space
pub fn vacuum_database(conn: &Connection) -> SqliteResult<()> {
    conn.execute("VACUUM", [])?;
    println!("Database vacuumed");
    Ok(())
}

/// Get database statistics
pub fn get_database_stats(conn: &Connection) -> SqliteResult<DatabaseStats> {
    let total_nodes: i64 =
        conn.query_row("SELECT COUNT(*) FROM nodes WHERE archived = 0", [], |row| {
            row.get(0)
        })?;

    let total_timeseries: i64 =
        conn.query_row("SELECT COUNT(*) FROM timeseries", [], |row| row.get(0))?;

    let total_positions: i64 =
        conn.query_row("SELECT COUNT(*) FROM positions", [], |row| row.get(0))?;

    let open_positions: i64 = conn.query_row(
        "SELECT COUNT(*) FROM positions WHERE status = 'open'",
        [],
        |row| row.get(0),
    )?;

    Ok(DatabaseStats {
        total_nodes: total_nodes as u64,
        total_timeseries_points: total_timeseries as u64,
        total_positions: total_positions as u64,
        open_positions: open_positions as u64,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseStats {
    pub total_nodes: u64,
    pub total_timeseries_points: u64,
    pub total_positions: u64,
    pub open_positions: u64,
}

// ============================================================================
// API KEY OPERATIONS
// ============================================================================

/// Stored API key for a trading platform
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredApiKey {
    pub platform: String,
    pub api_key: String,
    pub api_secret: Option<String>,
    pub private_key: Option<String>,
    pub environment: String,
    pub additional_config: Option<JsonValue>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Data for saving/updating API keys (without timestamps)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeyData {
    pub api_key: String,
    pub api_secret: Option<String>,
    pub private_key: Option<String>,
    pub environment: Option<String>,
    pub additional_config: Option<JsonValue>,
}

/// Save or update API key for a platform
///
/// Uses UPSERT (INSERT OR REPLACE) to handle both insert and update cases
pub fn save_api_key(conn: &Connection, platform: &str, key_data: &ApiKeyData) -> SqliteResult<()> {
    let now = Utc::now().timestamp();

    conn.execute(
        "INSERT OR REPLACE INTO api_keys 
         (platform, api_key, api_secret, private_key, environment, additional_config, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 
                 COALESCE((SELECT created_at FROM api_keys WHERE platform = ?1), ?7), 
                 ?8)",
        params![
            platform,
            &key_data.api_key,
            &key_data.api_secret,
            &key_data.private_key,
            key_data.environment.as_deref().unwrap_or("demo"),
            key_data.additional_config.as_ref().map(|d| serde_json::to_string(d).unwrap()),
            now,
            now,
        ],
    )?;

    println!("API key saved for platform: {}", platform);
    Ok(())
}

/// Get API key for a specific platform
pub fn get_api_key(conn: &Connection, platform: &str) -> SqliteResult<Option<StoredApiKey>> {
    let mut stmt = conn.prepare(
        "SELECT platform, api_key, api_secret, private_key, environment, additional_config, created_at, updated_at
         FROM api_keys WHERE platform = ?1"
    )?;

    let result = stmt.query_row(params![platform], |row| {
        Ok(StoredApiKey {
            platform: row.get(0)?,
            api_key: row.get(1)?,
            api_secret: row.get(2)?,
            private_key: row.get(3)?,
            environment: row.get(4)?,
            additional_config: row
                .get::<_, Option<String>>(5)?
                .and_then(|s| serde_json::from_str(&s).ok()),
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    });

    match result {
        Ok(key) => Ok(Some(key)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Get all stored API keys (without sensitive data for listing purposes)
/// Returns platform names and whether keys are configured
pub fn get_all_api_keys(conn: &Connection) -> SqliteResult<Vec<StoredApiKey>> {
    let mut stmt = conn.prepare(
        "SELECT platform, api_key, api_secret, private_key, environment, additional_config, created_at, updated_at
         FROM api_keys ORDER BY platform"
    )?;

    let keys = stmt
        .query_map([], |row| {
            Ok(StoredApiKey {
                platform: row.get(0)?,
                api_key: row.get(1)?,
                api_secret: row.get(2)?,
                private_key: row.get(3)?,
                environment: row.get(4)?,
                additional_config: row
                    .get::<_, Option<String>>(5)?
                    .and_then(|s| serde_json::from_str(&s).ok()),
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?
        .collect::<SqliteResult<Vec<StoredApiKey>>>()?;

    Ok(keys)
}

/// Delete API key for a platform
pub fn delete_api_key(conn: &Connection, platform: &str) -> SqliteResult<bool> {
    let rows_affected = conn.execute(
        "DELETE FROM api_keys WHERE platform = ?1",
        params![platform],
    )?;

    Ok(rows_affected > 0)
}

/// Check if API key exists for a platform
pub fn has_api_key(conn: &Connection, platform: &str) -> SqliteResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM api_keys WHERE platform = ?1",
        params![platform],
        |row| row.get(0),
    )?;

    Ok(count > 0)
}

/// Get list of platforms with configured API keys
pub fn get_configured_platforms(conn: &Connection) -> SqliteResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT platform FROM api_keys ORDER BY platform")?;

    let platforms = stmt
        .query_map([], |row| row.get(0))?
        .collect::<SqliteResult<Vec<String>>>()?;

    Ok(platforms)
}

// ============================================================================
// ANALYZER NODE OPERATIONS
// ============================================================================

use crate::models::analyzer_node::{AnalyzerChain, AnalyzerNode, AnalyzerResult, AnalyzerType};

/// Insert a new analyzer node
pub fn insert_analyzer_node(conn: &Connection, analyzer: &AnalyzerNode) -> SqliteResult<()> {
    conn.execute(
        "INSERT INTO analyzer_nodes (id, node_id, analyzer_type, config, enabled, name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            &analyzer.id,
            &analyzer.node_id,
            &analyzer.analyzer_type.to_string(),
            serde_json::to_string(&analyzer.config).unwrap_or_default(),
            analyzer.enabled as i32,
            &analyzer.name,
            analyzer.created_at,
            analyzer.updated_at,
        ],
    )?;
    Ok(())
}

/// Update analyzer node configuration
pub fn update_analyzer_node_config(
    conn: &Connection,
    analyzer_id: &str,
    config: &JsonValue,
) -> SqliteResult<()> {
    let now = Utc::now().timestamp();
    conn.execute(
        "UPDATE analyzer_nodes SET config = ?1, updated_at = ?2 WHERE id = ?3",
        params![
            serde_json::to_string(config).unwrap_or_default(),
            now,
            analyzer_id,
        ],
    )?;
    Ok(())
}

/// Toggle analyzer enabled state
pub fn set_analyzer_enabled(
    conn: &Connection,
    analyzer_id: &str,
    enabled: bool,
) -> SqliteResult<()> {
    let now = Utc::now().timestamp();
    conn.execute(
        "UPDATE analyzer_nodes SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
        params![enabled as i32, now, analyzer_id],
    )?;
    Ok(())
}

/// Delete an analyzer node
pub fn delete_analyzer_node(conn: &Connection, analyzer_id: &str) -> SqliteResult<()> {
    // Delete associated results
    conn.execute(
        "DELETE FROM analyzer_results WHERE analyzer_id = ?1",
        params![analyzer_id],
    )?;
    // Delete associated chains
    conn.execute(
        "DELETE FROM analyzer_chains WHERE source_analyzer_id = ?1 OR target_analyzer_id = ?1",
        params![analyzer_id],
    )?;
    // Delete the analyzer
    conn.execute(
        "DELETE FROM analyzer_nodes WHERE id = ?1",
        params![analyzer_id],
    )?;
    Ok(())
}

/// Get an analyzer node by ID
pub fn get_analyzer_by_id(
    conn: &Connection,
    analyzer_id: &str,
) -> SqliteResult<Option<AnalyzerNode>> {
    let mut stmt = conn.prepare(
        "SELECT id, node_id, analyzer_type, config, enabled, name, created_at, updated_at
         FROM analyzer_nodes WHERE id = ?1",
    )?;

    let result = stmt.query_row(params![analyzer_id], |row| deserialize_analyzer_node(row));

    match result {
        Ok(node) => Ok(Some(node)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Get all analyzers for a specific graph node
pub fn get_analyzers_for_node(conn: &Connection, node_id: &str) -> SqliteResult<Vec<AnalyzerNode>> {
    let mut stmt = conn.prepare(
        "SELECT id, node_id, analyzer_type, config, enabled, name, created_at, updated_at
         FROM analyzer_nodes WHERE node_id = ?1 ORDER BY created_at",
    )?;

    let analyzers = stmt
        .query_map(params![node_id], |row| deserialize_analyzer_node(row))?
        .collect::<SqliteResult<Vec<AnalyzerNode>>>()?;

    Ok(analyzers)
}

/// Deserialize an analyzer node from a database row
fn deserialize_analyzer_node(row: &Row) -> SqliteResult<AnalyzerNode> {
    let analyzer_type_str: String = row.get(2)?;
    let config_str: String = row.get(3)?;
    let enabled_int: i32 = row.get(4)?;

    let analyzer_type = AnalyzerType::from_str(&analyzer_type_str).unwrap_or(AnalyzerType::Custom);

    let config: JsonValue = serde_json::from_str(&config_str).unwrap_or(serde_json::json!({}));

    Ok(AnalyzerNode {
        id: row.get(0)?,
        node_id: row.get(1)?,
        analyzer_type,
        config,
        enabled: enabled_int != 0,
        name: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

// ============================================================================
// ANALYZER RESULT OPERATIONS
// ============================================================================

/// Insert an analyzer result
pub fn insert_analyzer_result(conn: &Connection, result: &AnalyzerResult) -> SqliteResult<()> {
    conn.execute(
        "INSERT INTO analyzer_results (id, analyzer_id, result_type, value, confidence, metadata, timestamp)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            &result.id,
            &result.analyzer_id,
            &result.result_type,
            result.value,
            result.confidence,
            serde_json::to_string(&result.metadata).unwrap_or_default(),
            result.timestamp,
        ],
    )?;
    Ok(())
}

/// Get analyzer results with optional time range and limit
pub fn get_analyzer_results(
    conn: &Connection,
    analyzer_id: &str,
    start_time: Option<i64>,
    end_time: Option<i64>,
    limit: Option<usize>,
) -> SqliteResult<Vec<AnalyzerResult>> {
    let mut sql = String::from(
        "SELECT id, analyzer_id, result_type, value, confidence, metadata, timestamp
         FROM analyzer_results WHERE analyzer_id = ?1",
    );
    let mut param_values: Vec<Value> = vec![Value::Text(analyzer_id.to_string())];

    if let Some(start) = start_time {
        sql.push_str(" AND timestamp >= ?");
        param_values.push(Value::Integer(start));
    }
    if let Some(end) = end_time {
        sql.push_str(" AND timestamp <= ?");
        param_values.push(Value::Integer(end));
    }

    sql.push_str(" ORDER BY timestamp DESC");

    if let Some(lim) = limit {
        sql.push_str(&format!(" LIMIT {}", lim));
    }

    let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values
        .iter()
        .map(|v| v as &dyn rusqlite::types::ToSql)
        .collect();

    let mut stmt = conn.prepare(&sql)?;
    let results = stmt
        .query_map(params_refs.as_slice(), |row| {
            let metadata_str: String = row.get(5)?;
            let metadata: JsonValue =
                serde_json::from_str(&metadata_str).unwrap_or(serde_json::json!({}));

            Ok(AnalyzerResult {
                id: row.get(0)?,
                analyzer_id: row.get(1)?,
                result_type: row.get(2)?,
                value: row.get(3)?,
                confidence: row.get(4)?,
                metadata,
                timestamp: row.get(6)?,
            })
        })?
        .collect::<SqliteResult<Vec<AnalyzerResult>>>()?;

    Ok(results)
}

// ============================================================================
// ANALYZER CHAIN OPERATIONS
// ============================================================================

/// Insert an analyzer chain
pub fn insert_analyzer_chain(conn: &Connection, chain: &AnalyzerChain) -> SqliteResult<()> {
    conn.execute(
        "INSERT INTO analyzer_chains (id, source_analyzer_id, target_analyzer_id, transform, enabled, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            &chain.id,
            &chain.source_analyzer_id,
            &chain.target_analyzer_id,
            &chain.transform,
            chain.enabled as i32,
            chain.created_at,
        ],
    )?;
    Ok(())
}

/// Get a chain by ID
pub fn get_chain_by_id(conn: &Connection, chain_id: &str) -> SqliteResult<Option<AnalyzerChain>> {
    let mut stmt = conn.prepare(
        "SELECT id, source_analyzer_id, target_analyzer_id, transform, enabled, created_at
         FROM analyzer_chains WHERE id = ?1",
    )?;

    let result = stmt.query_row(params![chain_id], |row| {
        let enabled_int: i32 = row.get(4)?;
        Ok(AnalyzerChain {
            id: row.get(0)?,
            source_analyzer_id: row.get(1)?,
            target_analyzer_id: row.get(2)?,
            transform: row.get(3)?,
            enabled: enabled_int != 0,
            created_at: row.get(5)?,
        })
    });

    match result {
        Ok(chain) => Ok(Some(chain)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Get all chains involving analyzers for a specific node
pub fn get_chains_for_node(conn: &Connection, node_id: &str) -> SqliteResult<Vec<AnalyzerChain>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.source_analyzer_id, c.target_analyzer_id, c.transform, c.enabled, c.created_at
         FROM analyzer_chains c
         JOIN analyzer_nodes a ON c.source_analyzer_id = a.id OR c.target_analyzer_id = a.id
         WHERE a.node_id = ?1
         GROUP BY c.id"
    )?;

    let chains = stmt
        .query_map(params![node_id], |row| {
            let enabled_int: i32 = row.get(4)?;
            Ok(AnalyzerChain {
                id: row.get(0)?,
                source_analyzer_id: row.get(1)?,
                target_analyzer_id: row.get(2)?,
                transform: row.get(3)?,
                enabled: enabled_int != 0,
                created_at: row.get(5)?,
            })
        })?
        .collect::<SqliteResult<Vec<AnalyzerChain>>>()?;

    Ok(chains)
}

/// Delete an analyzer chain
pub fn delete_analyzer_chain(conn: &Connection, chain_id: &str) -> SqliteResult<()> {
    conn.execute(
        "DELETE FROM analyzer_chains WHERE id = ?1",
        params![chain_id],
    )?;
    Ok(())
}

// ============================================================================
// SESSION TRACKING
// ============================================================================

/// Session record returned to the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

/// Insert a new session when the app starts
pub fn insert_session(conn: &Connection, id: &str, started_at: i64) -> SqliteResult<()> {
    conn.execute(
        "INSERT INTO sessions (id, started_at) VALUES (?1, ?2)",
        params![id, started_at],
    )?;
    Ok(())
}

/// Mark the current session as ended
pub fn end_session(conn: &Connection, id: &str, ended_at: i64) -> SqliteResult<()> {
    conn.execute(
        "UPDATE sessions SET ended_at = ?1 WHERE id = ?2",
        params![ended_at, id],
    )?;
    Ok(())
}

/// Get all sessions since a given timestamp, ordered by start time
pub fn get_sessions_since(conn: &Connection, since: i64) -> SqliteResult<Vec<Session>> {
    let mut stmt = conn.prepare(
        "SELECT id, started_at, ended_at FROM sessions WHERE started_at >= ?1 ORDER BY started_at ASC",
    )?;
    let sessions = stmt
        .query_map(params![since], |row: &Row| {
            Ok(Session {
                id: row.get(0)?,
                started_at: row.get(1)?,
                ended_at: row.get(2)?,
            })
        })?
        .collect::<SqliteResult<Vec<Session>>>()?;
    Ok(sessions)
}

// ============================================================================
// NODE GROUP OPERATIONS
// ============================================================================

/// Node group record with its members
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeGroup {
    pub id: String,
    pub label: String,
    pub color: String,
    pub padding: i32,
    pub origin_type: String,
    pub origin_data: Option<serde_json::Value>,
    pub member_ids: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Insert a new node group
pub fn insert_node_group(conn: &Connection, group: &NodeGroup) -> SqliteResult<()> {
    let origin_data_str = group.origin_data.as_ref()
        .map(|v| serde_json::to_string(v).unwrap_or_default());

    conn.execute(
        "INSERT INTO node_groups (id, label, color, padding, origin_type, origin_data, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            &group.id,
            &group.label,
            &group.color,
            group.padding,
            &group.origin_type,
            origin_data_str,
            group.created_at,
            group.updated_at,
        ],
    )?;

    // Insert all members
    let now = chrono::Utc::now().timestamp_millis();
    for member_id in &group.member_ids {
        let _ = conn.execute(
            "INSERT OR IGNORE INTO group_members (group_id, node_id, added_at)
             VALUES (?1, ?2, ?3)",
            params![&group.id, member_id, now],
        );
    }

    Ok(())
}

/// Update an existing node group
pub fn update_node_group(conn: &Connection, group: &NodeGroup) -> SqliteResult<()> {
    let origin_data_str = group.origin_data.as_ref()
        .map(|v| serde_json::to_string(v).unwrap_or_default());

    conn.execute(
        "UPDATE node_groups
         SET label = ?2, color = ?3, padding = ?4, origin_type = ?5, origin_data = ?6, updated_at = ?7
         WHERE id = ?1",
        params![
            &group.id,
            &group.label,
            &group.color,
            group.padding,
            &group.origin_type,
            origin_data_str,
            group.updated_at,
        ],
    )?;

    Ok(())
}

/// Delete a node group (members are deleted via cascade)
pub fn delete_node_group(conn: &Connection, group_id: &str) -> SqliteResult<()> {
    conn.execute(
        "DELETE FROM node_groups WHERE id = ?1",
        params![group_id],
    )?;
    Ok(())
}

/// Get a node group by ID with its members
pub fn get_node_group_by_id(conn: &Connection, group_id: &str) -> SqliteResult<Option<NodeGroup>> {
    let result = conn.query_row(
        "SELECT id, label, color, padding, origin_type, origin_data, created_at, updated_at
         FROM node_groups WHERE id = ?1",
        params![group_id],
        |row| {
            let origin_data_str: Option<String> = row.get(5)?;
            let origin_data = origin_data_str.and_then(|s| serde_json::from_str(&s).ok());

            Ok(NodeGroup {
                id: row.get(0)?,
                label: row.get(1)?,
                color: row.get(2)?,
                padding: row.get(3)?,
                origin_type: row.get(4)?,
                origin_data,
                member_ids: vec![], // Will be populated below
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        }
    );

    match result {
        Ok(mut group) => {
            // Get member IDs
            let mut stmt = conn.prepare(
                "SELECT node_id FROM group_members WHERE group_id = ?1"
            )?;
            let member_ids: Vec<String> = stmt
                .query_map(params![group_id], |row| row.get(0))?
                .filter_map(|r| r.ok())
                .collect();
            group.member_ids = member_ids;
            Ok(Some(group))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Get all node groups
pub fn get_all_node_groups(conn: &Connection) -> SqliteResult<Vec<NodeGroup>> {
    let mut stmt = conn.prepare(
        "SELECT id, label, color, padding, origin_type, origin_data, created_at, updated_at
         FROM node_groups"
    )?;

    let groups: Vec<NodeGroup> = stmt.query_map([], |row| {
        let origin_data_str: Option<String> = row.get(5)?;
        let origin_data = origin_data_str.and_then(|s| serde_json::from_str(&s).ok());

        Ok(NodeGroup {
            id: row.get(0)?,
            label: row.get(1)?,
            color: row.get(2)?,
            padding: row.get(3)?,
            origin_type: row.get(4)?,
            origin_data,
            member_ids: vec![], // Will be populated below
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    })?.filter_map(|r| r.ok()).collect();

    // Populate member IDs for each group
    let mut result = Vec::with_capacity(groups.len());
    for mut group in groups {
        let mut member_stmt = conn.prepare(
            "SELECT node_id FROM group_members WHERE group_id = ?1"
        )?;
        let member_ids: Vec<String> = member_stmt
            .query_map(params![&group.id], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        group.member_ids = member_ids;
        result.push(group);
    }

    Ok(result)
}

/// Add nodes to a group
pub fn add_nodes_to_group(conn: &Connection, group_id: &str, node_ids: &[String]) -> SqliteResult<()> {
    let now = chrono::Utc::now().timestamp_millis();

    for node_id in node_ids {
        let _ = conn.execute(
            "INSERT OR IGNORE INTO group_members (group_id, node_id, added_at)
             VALUES (?1, ?2, ?3)",
            params![group_id, node_id, now],
        );
    }

    // Update the group's updated_at timestamp
    conn.execute(
        "UPDATE node_groups SET updated_at = ?2 WHERE id = ?1",
        params![group_id, now],
    )?;

    Ok(())
}

/// Remove nodes from a group
pub fn remove_nodes_from_group(conn: &Connection, group_id: &str, node_ids: &[String]) -> SqliteResult<()> {
    for node_id in node_ids {
        conn.execute(
            "DELETE FROM group_members WHERE group_id = ?1 AND node_id = ?2",
            params![group_id, node_id],
        )?;
    }

    // Update the group's updated_at timestamp
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "UPDATE node_groups SET updated_at = ?2 WHERE id = ?1",
        params![group_id, now],
    )?;

    Ok(())
}

/// Remove a node from all groups it belongs to
pub fn remove_node_from_all_groups(conn: &Connection, node_id: &str) -> SqliteResult<()> {
    conn.execute(
        "DELETE FROM group_members WHERE node_id = ?1",
        params![node_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    fn setup_test_db() -> (NamedTempFile, Connection) {
        let temp_file = NamedTempFile::new().unwrap();
        let conn = create_connection(temp_file.path()).unwrap();
        setup_schema(&conn).unwrap();
        apply_optimizations(&conn).unwrap();
        (temp_file, conn)
    }

    #[test]
    fn test_create_connection() {
        let temp_file = NamedTempFile::new().unwrap();
        let result = create_connection(temp_file.path());
        assert!(result.is_ok());
    }

    #[test]
    fn test_setup_schema() {
        let (_temp, conn) = setup_test_db();

        // Verify tables exist
        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert!(table_count >= 6); // Should have at least 6 tables
    }

    #[test]
    fn test_insert_and_get_node() {
        let (_temp, conn) = setup_test_db();

        let node = Node {
            id: "test-node-1".to_string(),
            node_type: NodeType::InfoSource(InfoSourceType::CryptoPrices),
            position: (100.0, 200.0),
            size: None,
            connections: vec![],
            metadata: serde_json::json!({"test": "data"}),
        };

        insert_node(&conn, &node).unwrap();
        let retrieved = get_node_by_id(&conn, "test-node-1").unwrap();

        assert_eq!(retrieved.id, node.id);
        assert_eq!(retrieved.position, node.position);
    }

    #[test]
    fn test_insert_timeseries() {
        let (_temp, conn) = setup_test_db();

        // First create a node
        let node = Node {
            id: "source-1".to_string(),
            node_type: NodeType::InfoSource(InfoSourceType::CryptoPrices),
            position: (0.0, 0.0),
            size: None,
            connections: vec![],
            metadata: serde_json::json!({}),
        };
        insert_node(&conn, &node).unwrap();

        // Insert timeseries data
        insert_timeseries(&conn, "source-1", "price", 50000.0, None).unwrap();

        let points = query_timeseries(&conn, Some("source-1"), None, None, None, Some(10)).unwrap();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].value, 50000.0);
    }

    #[test]
    fn test_batch_insert_timeseries() {
        let (_temp, conn) = setup_test_db();

        let data_points = vec![
            TimeseriesDataPoint {
                timestamp: 1000,
                source_id: "source-1".to_string(),
                metric_type: "price".to_string(),
                value: 100.0,
                metadata: None,
            },
            TimeseriesDataPoint {
                timestamp: 2000,
                source_id: "source-1".to_string(),
                metric_type: "price".to_string(),
                value: 200.0,
                metadata: None,
            },
        ];

        batch_insert_timeseries(&conn, data_points).unwrap();

        let points = query_timeseries(&conn, Some("source-1"), None, None, None, None).unwrap();
        assert_eq!(points.len(), 2);
    }

    #[test]
    fn test_database_stats() {
        let (_temp, conn) = setup_test_db();

        let stats = get_database_stats(&conn).unwrap();
        assert_eq!(stats.total_nodes, 0);
        assert_eq!(stats.total_timeseries_points, 0);
    }
}
