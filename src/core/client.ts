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
}
