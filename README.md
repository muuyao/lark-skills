# lark-skills

Universal Lark/Feishu MCP server + skills — works across Claude Code, Codex, Cursor and more.

Based on [larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark), refactored from OpenClaw-specific plugin to a universal MCP server that any AI agent can use.

## Features

| Category | Capabilities |
|----------|-------------|
| 💬 Messenger | Read messages, send messages, reply, search, download files |
| 📄 Docs | Create, update, and read documents |
| 📊 Bitable | Create/manage bases, tables, fields, records, views |
| 📈 Sheets | Create, edit, and view spreadsheets |
| 📅 Calendar | Manage calendars and events, check free/busy |
| ✅ Tasks | Create, query, update, complete tasks |
| 🔍 Search | Search documents across workspace |
| 📁 Drive | Manage files and folders |
| 📚 Wiki | Manage wiki spaces and nodes |

## Quick Start

### 1. Create a Lark/Feishu App

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) or [Lark Developer](https://open.larksuite.com/app)
2. Create an app and get your App ID and App Secret
3. Enable required permissions for the APIs you need

### 2. Set Environment Variables

```bash
export LARK_APP_ID="your-app-id"
export LARK_APP_SECRET="your-app-secret"
export LARK_DOMAIN="feishu"  # or "lark" for international
```

### 3. Use with Claude Code

Add to your MCP config (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "lark": {
      "command": "node",
      "args": ["/path/to/lark-skills/dist/index.js"],
      "env": {
        "LARK_APP_ID": "your-app-id",
        "LARK_APP_SECRET": "your-app-secret"
      }
    }
  }
}
```

### 4. Use with Cursor / Windsurf / Other MCP Clients

Same MCP config format — just add the server to your client's MCP configuration.

### 5. Use with Codex

```bash
codex --mcp-config mcp.json
```

`mcp.json`:
```json
{
  "mcpServers": {
    "lark": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "LARK_APP_ID": "your-app-id",
        "LARK_APP_SECRET": "your-app-secret"
      }
    }
  }
}
```

## Development

```bash
npm install
npm run build
npm start
```

## Skills

The `skills/` directory contains SKILL.md files with AI agent instructions for each tool category. These provide context and best practices for using the Feishu tools effectively.

## License

MIT — based on [openclaw-lark](https://github.com/larksuite/openclaw-lark) by ByteDance.
