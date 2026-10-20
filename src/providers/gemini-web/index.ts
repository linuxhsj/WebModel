import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest, buildWebPrompt } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { normalizeStandardSSE } from '../_shared/standard-stream.js';
import { readSSE } from '../_shared/sse-reader.js';
import { GEMINI_WEB_BASE_URL } from './client.js';
import { AuthStore } from '../../auth/store.js';

export class GeminiProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'gemini-web',
    name: 'Gemini Web',
    website: 'https://gemini.google.com',
    loginUrl: 'https://gemini.google.com',
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
      { id: 'gemini-3-flash', name: 'Gemini 3 Flash', contextWindow: 1000000, maxOutput: 8192 },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1000000, maxOutput: 8192 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.browserFetch) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    const response = await this.browserFetch(`${GEMINI_WEB_BASE_URL}/api/chat/completions`, {
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
