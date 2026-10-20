import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest, buildWebPrompt } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { normalizeStandardSSE } from '../_shared/standard-stream.js';
import { readSSE } from '../_shared/sse-reader.js';
import { XIAOMIMO_WEB_BASE_URL } from './client.js';
import { AuthStore } from '../../auth/store.js';

export class XiaomimoProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'xiaomimo-web',
    name: 'Xiaomimo Web',
    website: 'https://aistudio.xiaomimimo.com',
    loginUrl: 'https://aistudio.xiaomimimo.com',
    needsBrowser: true,
  };

  constructor(
    private authStore: AuthStore,
    private browserFetch?: (url: string, init: RequestInit) => Promise<Response>,
  ) {
    super();
  }

  async login(context: { openUrl: (url: string) => Promise<void> }): Promise<void> {
    await context.openUrl(this.info.loginUrl);
  }

  async isAuthenticated(): Promise<boolean> {
    return this.authStore.getStatus(this.info.id).status === 'active';
  }

  async detectLoginComplete(): Promise<boolean> {
    return false;
  }

  async models(): Promise<ModelInfo[]> {
    return [
      { id: 'mimo-v2-pro', name: 'MiMo V2 Pro', contextWindow: 1000000, maxOutput: 8192 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.browserFetch) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    const response = await this.browserFetch(`${XIAOMIMO_WEB_BASE_URL}/api/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        messages: [{ role: 'user', content: buildWebPrompt(req.messages, req.tools) }],
        stream: true,
      }),
    });

    yield* readSSE(response, normalizeStandardSSE);
  }
}
