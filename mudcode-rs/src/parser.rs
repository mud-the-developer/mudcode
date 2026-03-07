use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

pub const DISCORD_MAX_MESSAGE_LENGTH: usize = 2000;

static FILE_PATH_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)(?:^|[\s`"'(\[])(/[^\s`"')\]]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp|pdf|docx|pptx|xlsx|csv|json|txt))(?:$|[\s`"')\].,;:!?])"#,
    )
    .expect("valid file path regex")
});
static COLLAPSE_BLANK_LINES_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\n{3,}"#).expect("valid newline regex"));
static BLANK_WS_LINE_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?m)^[ \t]+$"#).expect("valid blank ws regex"));

/// Split a message into chunks that respect Discord's 2000-character limit.
/// Tries to split at newline/space boundaries before hard splits.
pub fn split_message_for_discord(message: &str) -> Vec<String> {
    if message.is_ascii() {
        return split_ascii_message_for_discord(message);
    }

    if message.chars().count() <= DISCORD_MAX_MESSAGE_LENGTH {
        return vec![message.to_string()];
    }

    let mut chunks = Vec::new();
    let mut remaining = message;

    while !remaining.is_empty() {
        let hard_split = remaining
            .char_indices()
            .nth(DISCORD_MAX_MESSAGE_LENGTH)
            .map_or(remaining.len(), |(idx, _)| idx);

        let chunk_end = if hard_split == remaining.len() {
            hard_split
        } else {
            let search_area = &remaining[..hard_split];

            if let Some(pos) = search_area.rfind('\n') {
                if search_area[..pos].chars().count() >= DISCORD_MAX_MESSAGE_LENGTH / 2 {
                    pos + 1
                } else {
                    search_area.rfind(' ').map_or(hard_split, |space| space + 1)
                }
            } else if let Some(pos) = search_area.rfind(' ') {
                pos + 1
            } else {
                hard_split
            }
        };

        chunks.push(remaining[..chunk_end].to_string());
        remaining = &remaining[chunk_end..];
    }

    chunks
}

fn split_ascii_message_for_discord(message: &str) -> Vec<String> {
    if message.len() <= DISCORD_MAX_MESSAGE_LENGTH {
        return vec![message.to_string()];
    }

    let mut chunks = Vec::new();
    let mut cursor = 0;

    while cursor < message.len() {
        let hard_split = usize::min(cursor + DISCORD_MAX_MESSAGE_LENGTH, message.len());
        let chunk_end = if hard_split == message.len() {
            hard_split
        } else {
            let search_area = &message[cursor..hard_split];
            if let Some(pos) = search_area.rfind('\n') {
                if pos >= DISCORD_MAX_MESSAGE_LENGTH / 2 {
                    cursor + pos + 1
                } else {
                    search_area
                        .rfind(' ')
                        .map_or(hard_split, |space| cursor + space + 1)
                }
            } else if let Some(pos) = search_area.rfind(' ') {
                cursor + pos + 1
            } else {
                hard_split
            }
        };

        chunks.push(message[cursor..chunk_end].to_string());
        cursor = chunk_end;
    }

    chunks
}

pub fn split_for_discord(message: &str) -> Vec<String> {
    split_message_for_discord(message)
}

/// Extract absolute file paths with supported extensions.
pub fn extract_file_paths(text: &str) -> Vec<String> {
    if !text.contains('/') {
        return Vec::new();
    }

    let mut seen = HashSet::new();
    let mut paths = Vec::new();

    for caps in FILE_PATH_REGEX.captures_iter(text) {
        let Some(path) = caps.get(1) else {
            continue;
        };

        let path = path.as_str().to_string();
        if seen.insert(path.clone()) {
            paths.push(path);
        }
    }

    paths
}

/// Remove absolute file paths from user-visible text.
pub fn strip_file_paths(text: &str, file_paths: &[String]) -> String {
    let mut result = text.to_string();

    let mut escaped_paths: Vec<String> = file_paths
        .iter()
        .map(|path| path.trim())
        .filter(|path| !path.is_empty())
        .collect::<HashSet<_>>()
        .into_iter()
        .map(regex::escape)
        .collect();

    escaped_paths.sort_by(|a, b| b.len().cmp(&a.len()));

    if !escaped_paths.is_empty() {
        let alternation = escaped_paths.join("|");
        let image_re =
            Regex::new(&format!(r#"!\[[^\]]*\]\((?:{alternation})\)"#)).expect("valid image regex");
        let tick_re = Regex::new(&format!(r#"`(?:{alternation})`"#)).expect("valid backtick regex");
        let path_re = Regex::new(&format!(r#"(?:{alternation})"#)).expect("valid path regex");

        result = image_re.replace_all(&result, "").to_string();
        result = tick_re.replace_all(&result, "").to_string();
        result = path_re.replace_all(&result, "").to_string();
    }

    result = COLLAPSE_BLANK_LINES_REGEX
        .replace_all(&result, "\n\n")
        .to_string();
    BLANK_WS_LINE_REGEX.replace_all(&result, "").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_short_message_under_limit() {
        let msg = "Hello, world!";
        let chunks = split_message_for_discord(msg);
        assert_eq!(chunks, vec![msg]);
    }

    #[test]
    fn split_message_exactly_2000_chars() {
        let msg = "a".repeat(DISCORD_MAX_MESSAGE_LENGTH);
        let chunks = split_message_for_discord(&msg);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].chars().count(), DISCORD_MAX_MESSAGE_LENGTH);
    }

    #[test]
    fn split_message_just_over_limit() {
        let msg = "a".repeat(DISCORD_MAX_MESSAGE_LENGTH + 1);
        let chunks = split_message_for_discord(&msg);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].chars().count(), DISCORD_MAX_MESSAGE_LENGTH);
        assert_eq!(chunks[1].chars().count(), 1);
    }

    #[test]
    fn split_multibyte_only_content_without_panics() {
        let msg = "🦀".repeat(2500);
        let chunks = split_message_for_discord(&msg);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].chars().count(), DISCORD_MAX_MESSAGE_LENGTH);
        assert_eq!(chunks[1].chars().count(), 500);
        assert_eq!(chunks.concat(), msg);
    }

    #[test]
    fn split_prefer_newline_break() {
        let msg = format!("{}\n{}", "a".repeat(1500), "b".repeat(500));
        let chunks = split_message_for_discord(&msg);
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].ends_with('\n'));
        assert!(chunks[1].starts_with('b'));
    }

    #[test]
    fn extract_file_paths_deduplicates() {
        let text = "See `/tmp/a.png` and again /tmp/a.png and /tmp/b.pdf";
        let paths = extract_file_paths(text);
        assert_eq!(
            paths,
            vec!["/tmp/a.png".to_string(), "/tmp/b.pdf".to_string()]
        );
    }

    #[test]
    fn strip_file_paths_removes_backticks_and_plain_paths() {
        let path = "/tmp/project/.mudcode/files/out.png".to_string();
        let text = format!("Result: `{}` then {}", path, path);
        let stripped = strip_file_paths(&text, std::slice::from_ref(&path));
        assert!(!stripped.contains(&path));
        assert!(stripped.contains("Result:"));
    }
}
