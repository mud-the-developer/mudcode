use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Deserialize)]
pub struct BridgeState {
    #[serde(default)]
    pub projects: HashMap<String, ProjectState>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ProjectState {
    #[serde(rename = "projectPath")]
    pub project_path: Option<String>,
    #[serde(default)]
    pub instances: HashMap<String, ProjectInstance>,
    #[serde(default, rename = "discordChannels")]
    pub discord_channels: HashMap<String, Option<String>>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ProjectInstance {
    #[serde(rename = "instanceId")]
    pub instance_id: Option<String>,
    #[serde(rename = "agentType")]
    pub agent_type: Option<String>,
    #[serde(rename = "channelId", alias = "discordChannelId")]
    pub channel_id: Option<String>,
}

impl BridgeState {
    pub fn load(path: &Path) -> Self {
        let Ok(data) = fs::read_to_string(path) else {
            return Self::default();
        };

        serde_json::from_str::<Self>(&data).unwrap_or_default()
    }

    pub fn find_channel_id(
        &self,
        project_name: &str,
        agent_type: &str,
        instance_id: Option<&str>,
    ) -> Option<String> {
        let project = self.projects.get(project_name)?;

        if let Some(requested) = instance_id {
            if let Some(instance) = project.instances.get(requested) {
                if let Some(channel) = instance.channel_id.as_deref() {
                    if !channel.trim().is_empty() {
                        return Some(channel.to_string());
                    }
                }
            }
        }

        let mut instances = project
            .instances
            .iter()
            .filter_map(|(key, value)| {
                let id = value
                    .instance_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .unwrap_or(key.as_str())
                    .to_string();

                let a_type = value
                    .agent_type
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_string)?;

                let channel = value
                    .channel_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_string)?;

                Some((id, a_type, channel))
            })
            .collect::<Vec<_>>();

        instances.sort_by(|a, b| a.0.cmp(&b.0));
        if let Some((_, _, channel)) = instances.into_iter().find(|(_, a, _)| a == agent_type) {
            return Some(channel);
        }

        project
            .discord_channels
            .get(agent_type)
            .and_then(|ch| ch.as_deref())
            .map(str::trim)
            .filter(|ch| !ch.is_empty())
            .map(str::to_string)
    }

    pub fn project_path(&self, project_name: &str) -> Option<PathBuf> {
        self.projects
            .get(project_name)
            .and_then(|p| p.project_path.as_deref())
            .map(PathBuf::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_channel_by_exact_instance_first() {
        let mut state = BridgeState::default();
        state.projects.insert(
            "proj".to_string(),
            ProjectState {
                instances: HashMap::from([
                    (
                        "claude".to_string(),
                        ProjectInstance {
                            instance_id: Some("claude".to_string()),
                            agent_type: Some("claude".to_string()),
                            channel_id: Some("ch-1".to_string()),
                        },
                    ),
                    (
                        "claude-2".to_string(),
                        ProjectInstance {
                            instance_id: Some("claude-2".to_string()),
                            agent_type: Some("claude".to_string()),
                            channel_id: Some("ch-2".to_string()),
                        },
                    ),
                ]),
                ..ProjectState::default()
            },
        );

        let found = state.find_channel_id("proj", "claude", Some("claude-2"));
        assert_eq!(found.as_deref(), Some("ch-2"));
    }

    #[test]
    fn falls_back_to_primary_instance_when_instance_not_given() {
        let mut state = BridgeState::default();
        state.projects.insert(
            "proj".to_string(),
            ProjectState {
                instances: HashMap::from([
                    (
                        "claude-2".to_string(),
                        ProjectInstance {
                            instance_id: Some("claude-2".to_string()),
                            agent_type: Some("claude".to_string()),
                            channel_id: Some("ch-2".to_string()),
                        },
                    ),
                    (
                        "claude".to_string(),
                        ProjectInstance {
                            instance_id: Some("claude".to_string()),
                            agent_type: Some("claude".to_string()),
                            channel_id: Some("ch-1".to_string()),
                        },
                    ),
                ]),
                ..ProjectState::default()
            },
        );

        let found = state.find_channel_id("proj", "claude", None);
        assert_eq!(found.as_deref(), Some("ch-1"));
    }

    #[test]
    fn falls_back_to_legacy_discord_channels() {
        let mut state = BridgeState::default();
        state.projects.insert(
            "proj".to_string(),
            ProjectState {
                discord_channels: HashMap::from([(
                    "claude".to_string(),
                    Some("legacy-1".to_string()),
                )]),
                ..ProjectState::default()
            },
        );

        let found = state.find_channel_id("proj", "claude", None);
        assert_eq!(found.as_deref(), Some("legacy-1"));
    }
}
