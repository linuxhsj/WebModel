import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest, buildWebPrompt } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { GLM_WEB_BASE_URL } from './client.js';
import { AuthStore } from '../../auth/store.js';
import type { Page } from 'playwright-core';
import { createHash } from 'node:crypto';

const ASSISTANT_MAP: Record<string, string> = {
  'glm-5': '65940acff94777010aa6b796',
  'glm-4-plus': '65940acff94777010aa6b796',
};

const SIGN_SALT = '8a1317a7468aa3ad86e997d08f3f31cb';

function generateSign(timestamp: string, nonce: string): string {
  return createHash('md5').update(`${timestamp}-${nonce}-${SIGN_SALT}`).digest('hex');
}

export class GLMProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'glm-web',
    name: 'GLM Web',
    website: 'https://chatglm.cn',
    loginUrl: 'https://chatglm.cn',
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
      { id: 'glm-5', name: 'GLM-5', contextWindow: 128000, maxOutput: 4096 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.getPage && !this.browserFetch) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    try {
      const page = this.getPage
        ? await this.getPage(GLM_WEB_BASE_URL)
        : null;

      if (!page) {
        yield { type: 'error', message: 'GLM requires getPage for API calls' };
        return;
      }

      const prompt = buildWebPrompt(req.messages, req.tools);

      const assistantId = ASSISTANT_MAP[req.model] || ASSISTANT_MAP['glm-5'];
      const timestamp = String(Date.now());
      const nonce = crypto.randomUUID();
      const sign = generateSign(timestamp, nonce);

      const sseResult = await page.evaluate(async (args: {
        assistantId: string; prompt: string;
        timestamp: string; nonce: string; sign: string;
      }) => {
        try {
          const tokenCookie = document.cookie.split(';')
            .find(c => c.trim().startsWith('chatglm_token='));
          const token = tokenCookie ? tokenCookie.split('=').slice(1).join('=').trim() : '';

          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'App-Name': 'chatglm',
            'X-App-Platform': 'pc',
            'X-App-Version': '0.0.1',
            'X-Device-Id': crypto.randomUUID(),
            'X-Lang': 'zh',
            'X-Nonce': args.nonce,
            'X-Request-Id': crypto.randomUUID(),
            'X-Sign': args.sign,
            'X-Timestamp': args.timestamp,
          };
          if (token) headers['Authorization'] = `Bearer ${token}`;

          const res = await fetch('/chatglm/backend-api/assistant/stream', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              assistant_id: args.assistantId,
              conversation_id: '',
              project_id: '',
              chat_type: 'user_chat',
              meta_data: {
                cogview: { rm_label_watermark: false },
                is_test: false,
                input_question_type: 'xxxx',
                channel: '',
                draft_id: '',
                chat_mode: 'zero',
                is_networking: false,
                quote_log_id: '',
                platform: 'pc',
              },
              messages: [{
                role: 'user',
                content: [{ type: 'text', text: args.prompt }],
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
      }, { assistantId, prompt, timestamp, nonce, sign });

      if (sseResult.error) {
        yield { type: 'error', message: `GLM API error: ${sseResult.error}` };
        return;
      }

      // Parse GLM SSE
      const lines = (sseResult.data ?? '').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const content = parsed?.choices?.[0]?.delta?.content
            || parsed?.parts?.[0]?.content
            || null;
          if (content) {
            yield { type: 'text_delta', delta: content };
          }
          if (parsed?.choices?.[0]?.finish_reason || parsed?.status === 'finish') {
            yield { type: 'done', reason: 'stop' };
          }
        } catch {
          // skip non-JSON
        }
      }
    } catch (err) {
      yield { type: 'error', message: `GLM provider error: ${(err as Error).message}` };
    }
  }
}
