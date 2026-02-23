use crate::parser::split_for_discord;
use anyhow::{Context, anyhow};
use reqwest::multipart::{Form, Part};
use serde_json::json;
use std::path::Path;
use std::time::Duration;

#[derive(Clone)]
pub struct DiscordClient {
    http: reqwest::Client,
    bot_token: String,
}

impl DiscordClient {
    pub fn new(bot_token: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            bot_token,
        }
    }

    fn auth_header(&self) -> String {
        format!("Bot {}", self.bot_token)
    }

    pub async fn send_message(&self, channel_id: &str, content: &str) -> anyhow::Result<()> {
        let chunks = split_for_discord(content);

        for (idx, chunk) in chunks.iter().enumerate() {
            self.send_message_chunk(channel_id, chunk).await?;
            if idx < chunks.len() - 1 {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }

        Ok(())
    }

    async fn send_message_chunk(&self, channel_id: &str, content: &str) -> anyhow::Result<()> {
        let url = format!("https://discord.com/api/v10/channels/{channel_id}/messages");
        let body = json!({ "content": content });

        let response = self
            .http
            .post(url)
            .header("Authorization", self.auth_header())
            .json(&body)
            .send()
            .await
            .context("failed to send Discord message request")?;

        if response.status().is_success() {
            return Ok(());
        }

        let status = response.status();
        let text = response
            .text()
            .await
            .unwrap_or_else(|e| format!("<failed to read response body: {e}>"));

        Err(anyhow!("Discord send message failed ({status}): {text}"))
    }

    pub async fn send_files(
        &self,
        channel_id: &str,
        content: &str,
        file_paths: &[String],
    ) -> anyhow::Result<()> {
        if file_paths.is_empty() {
            return Ok(());
        }

        let payload = if content.trim().is_empty() {
            json!({})
        } else {
            json!({ "content": content })
        };

        let mut form = Form::new().text("payload_json", payload.to_string());

        for (idx, path) in file_paths.iter().enumerate() {
            let bytes = tokio::fs::read(path)
                .await
                .with_context(|| format!("failed to read attachment file: {path}"))?;

            let filename = Path::new(path)
                .file_name()
                .and_then(|v| v.to_str())
                .filter(|v| !v.trim().is_empty())
                .unwrap_or("attachment.bin")
                .to_string();

            let part = Part::bytes(bytes).file_name(filename);
            form = form.part(format!("files[{idx}]"), part);
        }

        let url = format!("https://discord.com/api/v10/channels/{channel_id}/messages");
        let response = self
            .http
            .post(url)
            .header("Authorization", self.auth_header())
            .multipart(form)
            .send()
            .await
            .context("failed to send Discord file upload request")?;

        if response.status().is_success() {
            return Ok(());
        }

        let status = response.status();
        let text = response
            .text()
            .await
            .unwrap_or_else(|e| format!("<failed to read response body: {e}>"));
        Err(anyhow!("Discord send files failed ({status}): {text}"))
    }
}
