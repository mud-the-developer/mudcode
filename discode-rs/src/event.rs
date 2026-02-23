use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct OpencodeEvent {
    #[serde(rename = "projectName")]
    pub project_name: Option<String>,
    #[serde(rename = "agentType")]
    pub agent_type: Option<String>,
    #[serde(rename = "instanceId")]
    pub instance_id: Option<String>,
    #[serde(rename = "type")]
    pub event_type: Option<String>,
    pub text: Option<String>,
    pub message: Option<String>,
    #[serde(rename = "turnText")]
    pub turn_text: Option<String>,
}

impl OpencodeEvent {
    pub fn project_name(&self) -> Option<&str> {
        self.project_name
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
    }

    pub fn agent_type(&self) -> &str {
        self.agent_type
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or("opencode")
    }

    pub fn instance_id(&self) -> Option<&str> {
        self.instance_id
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
    }

    pub fn event_type(&self) -> Option<&str> {
        self.event_type
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
    }

    pub fn event_text(&self) -> Option<String> {
        if let Some(text) = self
            .text
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            return Some(text.to_string());
        }

        self.message
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    }

    pub fn turn_text(&self) -> Option<&str> {
        self.turn_text
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
    }
}

#[derive(Debug, Deserialize)]
pub struct SendFilesEvent {
    #[serde(rename = "projectName")]
    pub project_name: Option<String>,
    #[serde(rename = "agentType")]
    pub agent_type: Option<String>,
    #[serde(rename = "instanceId")]
    pub instance_id: Option<String>,
    #[serde(default)]
    pub files: Vec<String>,
}

impl SendFilesEvent {
    pub fn project_name(&self) -> Option<&str> {
        self.project_name
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
    }

    pub fn agent_type(&self) -> &str {
        self.agent_type
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or("opencode")
    }

    pub fn instance_id(&self) -> Option<&str> {
        self.instance_id
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::OpencodeEvent;

    #[test]
    fn event_text_prefers_text_over_message() {
        let event = OpencodeEvent {
            project_name: Some("proj".to_string()),
            agent_type: None,
            instance_id: None,
            event_type: Some("session.idle".to_string()),
            text: Some("text value".to_string()),
            message: Some("message value".to_string()),
            turn_text: None,
        };

        assert_eq!(event.event_text().as_deref(), Some("text value"));
    }

    #[test]
    fn event_type_defaults_are_applied() {
        let event = OpencodeEvent {
            project_name: Some("proj".to_string()),
            agent_type: None,
            instance_id: None,
            event_type: None,
            text: None,
            message: None,
            turn_text: None,
        };

        assert_eq!(event.agent_type(), "opencode");
        assert_eq!(event.event_type(), None);
    }
}
