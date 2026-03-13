/**
 * MCP JSON-RPC gateway client for calling mcp.feishu.cn/mcp.
 * Used by doc tools (create-doc, fetch-doc, update-doc).
 *
 * Auth priority:
 *   1. FEISHU_MCP_TOKEN env var (explicit MCP token)
 *   2. LARK_USER_ACCESS_TOKEN env var (user access token)
 *   3. Auto-fetched tenant_access_token (from LARK_APP_ID + LARK_APP_SECRET)
 */

import { getTenantAccessToken } from './client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpRpcSuccess {
  jsonrpc: '2.0';
  id: number | string;
  result: unknown;
}

interface McpRpcError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

type McpRpcResponse = McpRpcSuccess | McpRpcError;

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function getMcpEndpoint(): string {
  if (process.env.FEISHU_MCP_ENDPOINT?.trim()) {
    return process.env.FEISHU_MCP_ENDPOINT.trim();
  }
  const domain = process.env.LARK_DOMAIN || 'feishu';
  return domain === 'lark'
    ? 'https://mcp.larksuite.com/mcp'
    : 'https://mcp.feishu.cn/mcp';
}

function buildAuthHeader(): string | undefined {
  const token =
    process.env.FEISHU_MCP_BEARER_TOKEN?.trim() ||
    process.env.FEISHU_MCP_TOKEN?.trim();
  if (!token) return undefined;
  return token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`;
}

async function getToken(): Promise<string> {
  // 1. Explicit MCP token
  const mcpToken = process.env.FEISHU_MCP_TOKEN?.trim();
  if (mcpToken) return mcpToken;

  // 2. User access token
  const uat = process.env.LARK_USER_ACCESS_TOKEN?.trim();
  if (uat) return uat;

  // 3. Auto-fetch tenant_access_token
  return getTenantAccessToken();
}

// ---------------------------------------------------------------------------
// JSON-RPC response handling
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Unwrap nested JSON-RPC envelopes. Some MCP gateways wrap result inside
 * another JSON-RPC envelope; this recursively strips them.
 */
function unwrapJsonRpcResult(v: unknown): unknown {
  if (!isRecord(v)) return v;

  const hasJsonRpc = typeof v.jsonrpc === 'string';
  const hasId = 'id' in v;
  const hasResult = 'result' in v;
  const hasError = 'error' in v;

  if (hasJsonRpc && (hasResult || hasError)) {
    if (hasError) {
      const err = v.error;
      if (isRecord(err) && typeof err.message === 'string') {
        throw new Error(err.message);
      }
      throw new Error('MCP returned error without message');
    }
    return unwrapJsonRpcResult(v.result);
  }

  // Some implementations wrap with just { result: ... } without jsonrpc
  if (!hasJsonRpc && !hasId && hasResult && !hasError) {
    return unwrapJsonRpcResult(v.result);
  }

  return v;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Call an MCP tool via the Feishu MCP gateway.
 */
export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const endpoint = getMcpEndpoint();
  const token = await getToken();

  const body = {
    jsonrpc: '2.0',
    id: `${name}-${Date.now()}`,
    method: 'tools/call',
    params: { name, arguments: args },
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Lark-MCP-UAT': token,
    'X-Lark-MCP-Allowed-Tools': name,
  };

  const auth = buildAuthHeader();
  if (auth) headers.authorization = auth;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status} ${res.statusText}: ${text.slice(0, 4000)}`);
  }

  let data: McpRpcResponse;
  try {
    data = JSON.parse(text) as McpRpcResponse;
  } catch {
    throw new Error(`MCP returned non-JSON: ${text.slice(0, 4000)}`);
  }

  if ('error' in data) {
    throw new Error(`MCP error ${data.error.code}: ${data.error.message}`);
  }

  return unwrapJsonRpcResult(data.result);
}
