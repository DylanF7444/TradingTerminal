use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State}; // Add Manager trait
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use futures_util::{StreamExt, SinkExt};
use serde_json::json;

const URL: &str = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const BTC_UP_DOWN: &str = "52607315900507156846622820770453728082833251091510131025984187712529448877245";
const BTC_DOWN_TOKEN: &str = "108988271800978168213949343685406694292284061166193819357568013088568150075789";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MarketUpdate {
    timestamp: String,
    action: String,
    data: serde_json::Value,
}

struct AppState {
    market_updates: Mutex<Vec<MarketUpdate>>,
}

#[tauri::command]
fn get_activity_log(state: State<AppState>) -> Vec<MarketUpdate> {
    let updates = state.market_updates.lock().unwrap();
    updates.clone()
}

#[tauri::command]
async fn start_websocket(app: tauri::AppHandle) -> Result<(), String> {
    tokio::spawn(async move {
        if let Err(e) = run_websocket(app).await {
            eprintln!("WebSocket error: {}", e);
        }
    });
    Ok(())
}

async fn run_websocket(app: tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let (ws_stream, _) = connect_async(URL).await?;
    let (mut write, mut read) = ws_stream.split();

    let subscribe_msg = json!({
        "assets_ids": [BTC_UP_DOWN, BTC_DOWN_TOKEN],
        "type": "market"
    });

    write.send(Message::Text(subscribe_msg.to_string())).await?;

    while let Some(msg) = read.next().await {
        let msg = msg?;

        if let Message::Text(text) = msg {
            if text != "PONG" {
                if let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) {
                    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
                    
                    let update = MarketUpdate {
                        timestamp: timestamp.clone(),
                        action: format!("Market Update: {}", 
                            data.get("event").and_then(|v| v.as_str()).unwrap_or("unknown")),
                        data: data.clone(),
                    };

                    // Store in state - access state through app handle
                    if let Some(state) = app.try_state::<AppState>() {
                        let mut updates = state.market_updates.lock().unwrap();
                        updates.push(update.clone());
                        
                        // Keep only last 100 updates
                        if updates.len() > 100 {
                            updates.remove(0);
                        }
                    }

                    // Emit event to frontend
                    app.emit("market-update", &update).ok();
                }
            } else {
                write.send(Message::Text("PING".to_string())).await?;
            }
        }
    }

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            market_updates: Mutex::new(Vec::new()),
        })
        .invoke_handler(tauri::generate_handler![
            get_activity_log,
            start_websocket
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}