// Database module for the prediction market trading terminal
// Provides SQLite-based persistence for nodes, connections, time-series data, and positions

pub mod sqlite;

use rusqlite::Connection;
use std::path::Path;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;

// Global database connection pool
// In a real implementation, consider using r2d2 for connection pooling
static DB_CONNECTION: LazyLock<Arc<Mutex<Option<Connection>>>> = 
    LazyLock::new(|| Arc::new(Mutex::new(None)));

/// Initialize the database with schema and optimizations
/// Called once during application startup from main.rs
pub fn init_db(db_path: &Path) -> Result<(), String> {
    let conn = sqlite::create_connection(db_path)
        .map_err(|e| format!("Failed to create database connection: {}", e))?;
    
    sqlite::setup_schema(&conn)
        .map_err(|e| format!("Failed to setup database schema: {}", e))?;
    
    sqlite::apply_optimizations(&conn)
        .map_err(|e| format!("Failed to apply database optimizations: {}", e))?;
    
    // Store connection globally
    let mut db = DB_CONNECTION.lock().unwrap();
    *db = Some(conn);
    
    println!("Database initialized successfully at: {}", db_path.display());
    
    Ok(())
}

/// Get a reference to the database connection
/// In production, this would use a connection pool
pub async fn get_connection() -> Result<Arc<Mutex<Option<Connection>>>, String> {
    Ok(Arc::clone(&DB_CONNECTION))
}

/// Close database connection gracefully
pub async fn close_db() -> Result<(), String> {
    let mut db = DB_CONNECTION.lock().unwrap();
    if let Some(conn) = db.take() {
        // Connection will be closed when dropped
        drop(conn);
        println!("Database connection closed");
    }
    Ok(())
}

/// Set the global database connection (called from main.rs after initialization)
/// This allows commands using get_connection() to access the initialized database
pub fn set_connection(conn: Connection) {
    let mut db = DB_CONNECTION.lock().unwrap();
    *db = Some(conn);
}

/// Database health check
pub async fn health_check() -> Result<DatabaseHealth, String> {
    let db = DB_CONNECTION.lock().unwrap();
    
    if db.is_none() {
        return Err("Database not initialized".to_string());
    }
    
    // In real implementation, check:
    // - Connection is alive
    // - Database file size
    // - Last write time
    // - WAL file size (for cleanup)
    
    Ok(DatabaseHealth {
        connected: true,
        database_size_mb: 0.0, // Would query actual size
        wal_size_mb: 0.0,
        total_nodes: 0,
        total_timeseries_points: 0,
        total_positions: 0,
    })
}

#[derive(Debug, Clone)]
pub struct DatabaseHealth {
    pub connected: bool,
    pub database_size_mb: f64,
    pub wal_size_mb: f64,
    pub total_nodes: u64,
    pub total_timeseries_points: u64,
    pub total_positions: u64,
}

// Re-export common types for convenience
pub use sqlite::{
    insert_node,
    update_node,
    delete_node,
    get_node_by_id,
    get_all_active_nodes,
    insert_timeseries,
    query_timeseries,
    insert_position,
    get_positions,
    insert_connection,
    get_connections_for_node,
    // API key operations (stored credentials for trading platforms)
    save_api_key,
    get_api_key,
    get_all_api_keys,
    delete_api_key,
    has_api_key,
    get_configured_platforms,
    StoredApiKey,
    ApiKeyData,
};

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_init_db() {
        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path().join("test.db");
        
        let result = init_db(&db_path);
        assert!(result.is_ok());
        assert!(db_path.exists());
    }

    #[tokio::test]
    async fn test_health_check() {
        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path().join("test.db");
        init_db(&db_path).unwrap();
        
        let health = health_check().await.unwrap();
        assert!(health.connected);
    }
}