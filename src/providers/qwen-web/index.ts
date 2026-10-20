import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest, buildWebPrompt } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { QWEN_WEB_BASE_URL } from './client.js';
import { AuthStore } from '../../auth/store.js';
import type { Page } from 'playwright-core';

export class QwenProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'qwen-web',
    name: 'Qwen Web',
    website: 'https://chat.qwen.ai',
    loginUrl: 'https://chat.qwen.ai',
    needsBrowser: true,
  };

  constructor(
    private authStore: AuthStore,
    private browserFetch?: (url: string, init: RequestInit) => Promise<Response>,
    private getPage?: (origin: string) => Promise<Page>,
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
      { id: 'qwen-3.5-plus', name: 'Qwen 3.5 Plus', contextWindow: 262000, maxOutput: 8192 },
      { id: 'qwq', name: 'QwQ', contextWindow: 32000, maxOutput: 8192 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.getPage && !this.browserFetch) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    try {
      const page = this.getPage
        ? await this.getPage(QWEN_WEB_BASE_URL)
        : null;

      if (!page) {
        yield { type: 'error', message: 'Qwen requires getPage for multi-step API' };
        return;
      }

      // Step 1: Create a new chat
      const chatResult = await page.evaluate(async () => {
        try {
          const res = await fetch('/api/v2/chats/new', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
            credentials: 'include',
          });
          if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).substring(0, 200)}` };
          const data = await res.json();
          return { chatId: data?.data?.id || data?.id || data?.chat_id };
        } catch (e: any) {
          return { error: e.message };
        }
      });

      if (chatResult.error || !chatResult.chatId) {
        yield { type: 'error', message: `Qwen chat create failed: ${chatResult.error || 'no chat id'}` };
        return;
      }

      // Step 2: Build message
      const prompt = buildWebPrompt(req.messages, req.tools);

      const modelMap: Record<string, string> = {
        'qwen-3.5-plus': 'qwen3.5-plus',
        'qwq': 'qwq-plus',
      };
      const modelName = modelMap[req.model] || req.model;
      const fid = crypto.randomUUID();

      // Step 3: Send completion request
      const sseResult = await page.evaluate(async (args: {
        chatId: string; prompt: string; model: string; fid: string;
      }) => {
        try {
          const res = await fetch(`/api/v2/chat/completions?chat_id=${args.chatId}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
            },
            body: JSON.stringify({
              stream: true,
              version: '2.1',
              incremental_output: true,
              chat_id: args.chatId,
              chat_mode: 'normal',
              model: args.model,
              parent_id: null,
              messages: [{
                fid: args.fid,
                parentId: null,
                childrenIds: [],
                role: 'user',
                content: args.prompt,
                user_action: 'chat',
                files: [],
                timestamp: String(Math.floor(Date.now() / 1000)),
                models: [args.model],
                chat_type: 't2t',
                feature_config: {
                  thinking_enabled: false,
                  output_schema: 'phase',
                },
              }],
            }),
            credentials: 'include',
          });

          if (!res.ok) {
            const text = await res.text();
            return { error: `HTTP ${res.status}: ${text.substring(0, 200)}` };
          }

          const reader = res.body?.getReader();
          if (!reader) return { error: 'No response body' };
          const decoder = new TextDecoder();
          let fullText = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullText += decoder.decode(value, { stream: true });
          }
          return { data: fullText };
        } catch (e: any) {
          return { error: e.message };
        }
      }, {
        chatId: chatResult.chatId,
        prompt,
        model: modelName,
        fid,
      });

      if (sseResult.error) {
        yield { type: 'error', message: `Qwen API error: ${sseResult.error}` };
        return;
      }

      // Step 4: Parse SSE — Qwen uses standard format but may have custom fields
      const lines = (sseResult.data ?? '').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (choice?.finish_reason) {
            yield { type: 'done', reason: choice.finish_reason === 'length' ? 'length' : 'stop' };
          } else if (choice?.delta?.content) {
            yield { type: 'text_delta', delta: choice.delta.content };
          }
        } catch {
          // Non-JSON SSE line, skip
        }
      }
    } catch (err) {
      yield { type: 'error', message: `Qwen provider error: ${(err as Error).message}` };
    }
  }
}
