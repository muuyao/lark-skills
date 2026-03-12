#!/usr/bin/env node

/**
 * Lark/Feishu MCP Server
 *
 * Universal MCP server for Lark/Feishu integration.
 * Works across Claude Code, Codex, Cursor, and any MCP-compatible agent.
 *
 * Environment variables:
 *   LARK_APP_ID     - Lark/Feishu app ID (required)
 *   LARK_APP_SECRET - Lark/Feishu app secret (required)
 *   LARK_DOMAIN     - "feishu" (default) or "lark"
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getAllTools } from './tools/index.js';

async function main() {
  const tools = await getAllTools();

  const server = new Server(
    { name: 'lark-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // List all available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.schema as Record<string, unknown>,
    })),
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find((t) => t.name === name);

    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      return await tool.handler(args ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Failed to start lark-mcp server:', err);
  process.exit(1);
});
