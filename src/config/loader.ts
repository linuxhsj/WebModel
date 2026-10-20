import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

export interface BridgeConfig {
  server: {
    port: number;
    host: string;
    authToken: string | null;
    openDashboard: boolean;
  };
  browser: {
    profileDir: string;
    startupTimeout: number;
    idleShutdown: number;
    loginTimeout: number;
    mode: 'attach' | 'launch';
    cdpUrl: string;
  };
  providers: {
    enabled: string[];
    /** Serves requests for a model no provider has; null answers them 400 invalid_model. */
    fallbackModel: string | null;
  };
  toolCalling: {
    enabled: boolean;
    language: 'auto' | 'zh' | 'en';
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    file: string;
  };
}

export function defaultConfig(stateDir: string): BridgeConfig {
  return {
    server: {
      port: 3456,
      host: '127.0.0.1',
      authToken: null,
      openDashboard: true,
    },
    browser: {
      profileDir: join(stateDir, 'chrome-profile'),
      startupTimeout: 30000,
      idleShutdown: 300,
      loginTimeout: 120,
      mode: 'attach',
      cdpUrl: 'http://127.0.0.1:9222',
    },
    providers: {
      enabled: [
        'claude-web', 'chatgpt-web', 'deepseek-web',
        'kimi-web', 'qwen-web', 'glm-web', 'grok-web',
        'gemini-web', 'perplexity-web', 'doubao-web', 'xiaomimo-web',
      ],
      fallbackModel: null,
    },
    toolCalling: {
      enabled: true,
      language: 'auto',
    },
    logging: {
      level: 'info',
      file: join(stateDir, 'logs', 'bridge.log'),
    },
  };
}

interface LoadOptions {
  stateDir: string;
  configFile?: string;
  port?: number;
  host?: string;
  authToken?: string;
  verbose?: boolean;
}

export function loadConfig(opts: LoadOptions): BridgeConfig {
  const config = defaultConfig(opts.stateDir);

  const configPath = opts.configFile ?? join(opts.stateDir, 'config.yml');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = yaml.load(raw);
    if (parsed && typeof parsed === 'object') {
      mergeDeep(config as unknown as Record<string, unknown>, parsed as Record<string, unknown>);
    }
  } catch {
    // No config file or invalid YAML — use defaults
  }

  // Re-resolve paths relative to stateDir after YAML merge
  if (config.browser.profileDir === defaultConfig('__placeholder__').browser.profileDir) {
    config.browser.profileDir = join(opts.stateDir, 'chrome-profile');
  }
  if (config.logging.file === defaultConfig('__placeholder__').logging.file) {
    config.logging.file = join(opts.stateDir, 'logs', 'bridge.log');
  }

  // CLI overrides
  if (opts.port !== undefined) config.server.port = opts.port;
  if (opts.host !== undefined) config.server.host = opts.host;
  if (opts.authToken !== undefined) config.server.authToken = opts.authToken;
  if (opts.verbose) config.logging.level = 'debug';

  // Environment variable overrides (Docker-friendly)
  if (process.env.WMB_PORT) config.server.port = parseInt(process.env.WMB_PORT, 10);
  if (process.env.WMB_HOST) config.server.host = process.env.WMB_HOST;
  if (process.env.WMB_AUTH_TOKEN) config.server.authToken = process.env.WMB_AUTH_TOKEN;
  if (process.env.WMB_LOG_LEVEL) config.logging.level = process.env.WMB_LOG_LEVEL as any;
  if (process.env.WMB_FALLBACK_MODEL) config.providers.fallbackModel = process.env.WMB_FALLBACK_MODEL;
  if (process.env.WMB_STATE_DIR) {
    config.browser.profileDir = join(process.env.WMB_STATE_DIR, 'chrome-profile');
    config.logging.file = join(process.env.WMB_STATE_DIR, 'logs', 'bridge.log');
  }

  return config;
}

function mergeDeep(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal) &&
      tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal)
    ) {
      mergeDeep(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else if (srcVal !== undefined) {
      target[key] = srcVal;
    }
  }
}
