mod config;
mod discord;
mod event;
mod parser;
mod state;

use crate::config::load_runtime_config;
use crate::discord::DiscordClient;
use crate::event::{OpencodeEvent, SendFilesEvent};
use crate::parser::{extract_file_paths, split_for_discord, strip_file_paths};
use crate::state::BridgeState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde_json::Value;
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use tracing::{error, info};

#[derive(Clone)]
struct AppState {
    discord: DiscordClient,
    state_path: PathBuf,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cfg = load_runtime_config()?;
    info!("Loaded config from {}", cfg.config_path.display());

    let app_state = AppState {
        discord: DiscordClient::new(cfg.discord_token),
        state_path: cfg.state_path,
    };

    let app = Router::new()
        .route("/reload", post(handle_reload))
        .route("/send-files", post(handle_send_files))
        .route("/opencode-event", post(handle_opencode_event))
        .with_state(app_state);

    let addr = SocketAddr::from(([127, 0, 0, 1], cfg.hook_server_port));
    let listener = tokio::net::TcpListener::bind(addr).await?;

    info!("mudcode-rs bridge listening on http://{}", addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            error!("failed to install Ctrl+C handler: {error}");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{SignalKind, signal};

        match signal(SignalKind::terminate()) {
            Ok(mut stream) => {
                let _ = stream.recv().await;
            }
            Err(error) => {
                error!("failed to install SIGTERM handler: {error}");
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    info!("shutdown signal received");
}

async fn handle_reload() -> (StatusCode, String) {
    (StatusCode::OK, "OK".to_string())
}

async fn handle_send_files(
    State(app): State<AppState>,
    Json(payload): Json<Value>,
) -> (StatusCode, String) {
    let Ok(event) = serde_json::from_value::<SendFilesEvent>(payload) else {
        return (StatusCode::BAD_REQUEST, "Invalid payload".to_string());
    };

    let Some(project_name) = event.project_name() else {
        return (StatusCode::BAD_REQUEST, "Missing projectName".to_string());
    };

    if event.files.is_empty() {
        return (StatusCode::BAD_REQUEST, "No files provided".to_string());
    }

    let state = BridgeState::load(&app.state_path);
    if !state.projects.contains_key(project_name) {
        return (StatusCode::NOT_FOUND, "Project not found".to_string());
    }

    let Some(channel_id) =
        state.find_channel_id(project_name, event.agent_type(), event.instance_id())
    else {
        return (
            StatusCode::NOT_FOUND,
            "No channel found for project/agent".to_string(),
        );
    };

    let project_path = state.project_path(project_name);
    let valid_files = validate_file_paths(&event.files, project_path.as_deref());

    if valid_files.is_empty() {
        return (StatusCode::BAD_REQUEST, "No valid files".to_string());
    }

    match app.discord.send_files(&channel_id, "", &valid_files).await {
        Ok(_) => (StatusCode::OK, "OK".to_string()),
        Err(error) => {
            error!(
                "send-files failed project={} channel={} err={}",
                project_name, channel_id, error
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Internal error".to_string(),
            )
        }
    }
}

async fn handle_opencode_event(
    State(app): State<AppState>,
    Json(payload): Json<Value>,
) -> (StatusCode, String) {
    let Ok(event) = serde_json::from_value::<OpencodeEvent>(payload) else {
        return (StatusCode::BAD_REQUEST, "Invalid event payload".to_string());
    };

    let Some(project_name) = event.project_name() else {
        return (StatusCode::BAD_REQUEST, "Invalid event payload".to_string());
    };

    let state = BridgeState::load(&app.state_path);
    let Some(channel_id) =
        state.find_channel_id(project_name, event.agent_type(), event.instance_id())
    else {
        return (StatusCode::BAD_REQUEST, "Invalid event payload".to_string());
    };

    match event.event_type() {
        Some("session.error") => {
            let msg = event
                .event_text()
                .unwrap_or_else(|| "unknown error".to_string());
            let content = format!("⚠️ OpenCode session error: {msg}");
            if let Err(error) = app.discord.send_message(&channel_id, &content).await {
                error!(
                    "failed to deliver session.error project={} channel={} err={}",
                    project_name, channel_id, error
                );
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal error".to_string(),
                );
            }
        }
        Some("session.idle") => {
            if let Some(text) = event.event_text() {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    let file_search_text = event.turn_text().unwrap_or(trimmed);
                    let project_path = state.project_path(project_name);

                    let extracted = extract_file_paths(file_search_text);
                    let valid_files = validate_file_paths(&extracted, project_path.as_deref());
                    let display_text = if valid_files.is_empty() {
                        trimmed.to_string()
                    } else {
                        strip_file_paths(trimmed, &valid_files)
                    };

                    for chunk in split_for_discord(&display_text) {
                        if chunk.trim().is_empty() {
                            continue;
                        }

                        if let Err(error) = app.discord.send_message(&channel_id, &chunk).await {
                            error!(
                                "failed to deliver chunk project={} channel={} err={}",
                                project_name, channel_id, error
                            );
                            return (
                                StatusCode::INTERNAL_SERVER_ERROR,
                                "Internal error".to_string(),
                            );
                        }
                    }

                    if !valid_files.is_empty()
                        && let Err(error) =
                            app.discord.send_files(&channel_id, "", &valid_files).await
                    {
                        error!(
                            "failed to deliver files project={} channel={} err={}",
                            project_name, channel_id, error
                        );
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "Internal error".to_string(),
                        );
                    }
                }
            }
        }
        _ => {}
    }

    (StatusCode::OK, "OK".to_string())
}

fn validate_file_paths(paths: &[String], project_path: Option<&Path>) -> Vec<String> {
    let Some(project_path) = project_path else {
        return Vec::new();
    };

    let project_real =
        fs::canonicalize(project_path).unwrap_or_else(|_| project_path.to_path_buf());

    paths
        .iter()
        .filter_map(|raw| {
            let path = Path::new(raw);
            if !path.exists() {
                return None;
            }

            let real = fs::canonicalize(path).ok()?;
            if real == project_real || real.starts_with(&project_real) {
                return Some(raw.to_string());
            }

            None
        })
        .collect()
}
