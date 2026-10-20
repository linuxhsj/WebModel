import { createApp } from '../../src/server.js';
import { ProviderRegistry } from '../../src/core/registry.js';
import { AuthStore } from '../../src/auth/store.js';
import { MockProvider } from './mock-provider.js';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface TestContext {
  app: ReturnType<typeof createApp>;
  registry: ProviderRegistry;
  authStore: AuthStore;
  stateDir: string;
  cleanup: () => void;
}

export function createTestContext(opts?: {
  authToken?: string;
  providers?: MockProvider[];
  fallbackModel?: string;
}): TestContext {
  const stateDir = join(tmpdir(), `wmb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(stateDir, { recursive: true });

  const registry = new ProviderRegistry(opts?.fallbackModel);
  const authStore = new AuthStore(stateDir);

  const providers = opts?.providers ?? [
    new MockProvider('claude-web', {
      authenticated: true,
      models: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000, maxOutput: 8192 }],
    }),
  ];

  for (const p of providers) {
    registry.register(p);
  }

  const app = createApp({ registry, authStore, authToken: opts?.authToken ?? null });

  return {
    app,
    registry,
    authStore,
    stateDir,
    cleanup: () => rmSync(stateDir, { recursive: true, force: true }),
  };
}
