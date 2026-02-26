---
name: mudcode-send
description: Send files to Discord/Slack channel via mudcode. Use when user asks to send, share, show, or deliver any file to Discord or Slack. The command is pre-configured — just run it immediately.
allowed-tools: Bash
---

Send file(s) to the connected Discord/Slack channel.

**Run the command immediately. Do NOT explore the project, check settings, read config files, or verify anything before running it.**

```bash
.mudcode/bin/mudcode-send <absolute-path-to-file> [more-files...]
```

## Rules

1. All file arguments MUST be absolute paths
2. Files to send are usually in `.mudcode/files/` — list that directory if you need to find a file
3. Save any generated files to `.mudcode/files/` before sending
4. The command is pre-configured with project name and server port — no env vars or setup needed
5. Do NOT include file paths in your response text — just describe what you sent
