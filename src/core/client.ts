/**
 * Simplified Lark SDK client for MCP server.
 * Auth via environment variables: LARK_APP_ID + LARK_APP_SECRET.
 */

import * as lark from '@larksuiteoapi/node-sdk';

let cachedClient: lark.Client | null = null;

export interface LarkConfig {
  appId: string;
  appSecret: string;
  domain?: 'feishu' | 'lark';
}

function getConfigFromEnv(): LarkConfig {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error(
      'Missing LARK_APP_ID or LARK_APP_SECRET environment variables. ' +
        'Create a Lark/Feishu app at https://open.feishu.cn/app and set these env vars.',
    );
  }

  const domain = (process.env.LARK_DOMAIN as 'feishu' | 'lark') || 'feishu';

  return { appId, appSecret, domain };
}

export function getLarkClient(): lark.Client {
  if (cachedClient) return cachedClient;

  const config = getConfigFromEnv();

  cachedClient = new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.warn,
  });

  return cachedClient;
}

/**
 * Reset the cached client (useful for testing or config changes).
 */
export function resetClient(): void {
  cachedClient = null;
  tokenCache = null;
}

// ---------------------------------------------------------------------------
// Tenant access token (for MCP gateway and raw API calls)
// ---------------------------------------------------------------------------

let tokenCache: { token: string; expiresAt: number } | null = null;

/**
 * Get a tenant_access_token, auto-refreshing and caching.
 */
export async function getTenantAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const config = getConfigFromEnv();
  const baseUrl = getApiBaseUrl();

  const res = await fetch(
    `${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: config.appId,
        app_secret: config.appSecret,
      }),
    },
  );

  const data = (await res.json()) as {
    code: number;
    msg: string;
    tenant_access_token: string;
    expire: number;
  };
  if (data.code !== 0) {
    throw new Error(`Failed to get tenant_access_token: ${data.msg}`);
  }

  // Cache with 5-minute buffer before actual expiry
  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire - 300) * 1000,
  };

  return tokenCache.token;
}

// ---------------------------------------------------------------------------
// Raw API call helper (for endpoints not covered by the SDK)
// ---------------------------------------------------------------------------

export function getApiBaseUrl(): string {
  const domain = (process.env.LARK_DOMAIN as 'feishu' | 'lark') || 'feishu';
  return domain === 'lark'
    ? 'https://open.larksuite.com'
    : 'https://open.feishu.cn';
}

/**
 * Make a raw Lark API call using tenant_access_token.
 */
export async function larkApiCall(
  apiPath: string,
  method: 'GET' | 'POST',
  options?: {
    params?: Record<string, string>;
    body?: unknown;
  },
): Promise<unknown> {
  const token = await getTenantAccessToken();
  const baseUrl = getApiBaseUrl();

  let url = `${baseUrl}${apiPath}`;
  if (options?.params) {
    const qs = new URLSearchParams(options.params).toString();
    url += url.includes('?') ? `&${qs}` : `?${qs}`;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const res = await fetch(url, {
    method,
    headers,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });

  return res.json();
}
