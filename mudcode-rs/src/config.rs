use anyhow::{Context, anyhow};
use serde::Deserialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub discord_token: String,
    pub hook_server_port: u16,
    pub config_path: PathBuf,
    pub state_path: PathBuf,
}

#[derive(Debug, Default, Deserialize)]
struct StoredConfig {
    token: Option<String>,
    #[serde(rename = "hookServerPort")]
    hook_server_port: Option<u16>,
}

fn default_mudcode_dir() -> anyhow::Result<PathBuf> {
    let home = env::var("HOME").context("HOME is not set")?;
    Ok(Path::new(&home).join(".mudcode"))
}

fn resolve_config_path() -> anyhow::Result<PathBuf> {
    if let Ok(path) = env::var("MUDCODE_CONFIG_PATH") {
        if !path.trim().is_empty() {
            return Ok(PathBuf::from(path));
        }
    }

    Ok(default_mudcode_dir()?.join("config.json"))
}

fn resolve_state_path() -> anyhow::Result<PathBuf> {
    if let Ok(path) = env::var("MUDCODE_STATE_PATH") {
        if !path.trim().is_empty() {
            return Ok(PathBuf::from(path));
        }
    }

    Ok(default_mudcode_dir()?.join("state.json"))
}

fn read_stored_config(path: &Path) -> StoredConfig {
    let Ok(data) = fs::read_to_string(path) else {
        return StoredConfig::default();
    };

    serde_json::from_str::<StoredConfig>(&data).unwrap_or_default()
}

pub fn normalize_discord_token(input: &str) -> String {
    let mut token = input.trim().to_string();
    if token.is_empty() {
        return String::new();
    }

    if (token.starts_with('"') && token.ends_with('"'))
        || (token.starts_with('\'') && token.ends_with('\''))
    {
        token = token[1..token.len() - 1].trim().to_string();
    }

    let lowered = token.to_ascii_lowercase();
    if lowered.starts_with("bot ") || lowered.starts_with("bearer ") {
        token = token
            .split_once(char::is_whitespace)
            .map_or_else(String::new, |(_, rest)| rest.trim().to_string());
    }

    token.retain(|c| !c.is_whitespace());
    token
}

pub fn load_runtime_config() -> anyhow::Result<RuntimeConfig> {
    let config_path = resolve_config_path()?;
    let state_path = resolve_state_path()?;

    let stored = read_stored_config(&config_path);
    let stored_token = stored
        .token
        .as_deref()
        .map(normalize_discord_token)
        .unwrap_or_default();

    let env_token = env::var("DISCORD_BOT_TOKEN")
        .ok()
        .map(|v| normalize_discord_token(&v))
        .unwrap_or_default();

    let discord_token = if !stored_token.is_empty() {
        stored_token
    } else {
        env_token
    };

    if discord_token.is_empty() {
        return Err(anyhow!(
            "Discord bot token not configured. Set DISCORD_BOT_TOKEN or ~/.mudcode/config.json token"
        ));
    }

    let env_port = env::var("HOOK_SERVER_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok());

    let hook_server_port = stored.hook_server_port.or(env_port).unwrap_or(18470);

    Ok(RuntimeConfig {
        discord_token,
        hook_server_port,
        config_path,
        state_path,
    })
}

#[cfg(test)]
mod tests {
    use super::normalize_discord_token;

    #[test]
    fn normalize_discord_token_handles_common_copy_paste_issues() {
        assert_eq!(normalize_discord_token(""), "");
        assert_eq!(normalize_discord_token("   "), "");
        assert_eq!(normalize_discord_token("Bot abc.def.ghi"), "abc.def.ghi");
        assert_eq!(
            normalize_discord_token(" bearer abc.def.ghi "),
            "abc.def.ghi"
        );
        assert_eq!(normalize_discord_token("'abc.def.ghi'"), "abc.def.ghi");
        assert_eq!(normalize_discord_token("\"abc .def .ghi\""), "abc.def.ghi");
    }
}
