import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest, buildWebPrompt } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { normalizeClaudeSSE } from './stream.js';
import { AuthStore } from '../../auth/store.js';
import type { Page } from 'playwright-core';

const BASE_URL = 'https://claude.ai';

export class ClaudeProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'claude-web',
    name: 'Claude Web',
    website: BASE_URL,
    loginUrl: `${BASE_URL}/login`,
    needsBrowser: true,
  };

  private organizationId: string | null = null;
  private deviceId: string | null = null;

  constructor(
    private authStore: AuthStore,
    browserFetch?: (url: string, init: RequestInit) => Promise<Response>,
    private getPage?: (origin: string) => Promise<Page>,
  ) {
    void browserFetch; // kept for interface compatibility with other providers
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
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 1000000, maxOutput: 8192 },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200000, maxOutput: 8192 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.getPage) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    try {
      const page = await this.getPage(BASE_URL);

      // Step 1: Get organizationId (cached)
      if (!this.organizationId) {
        const orgResult = await page.evaluate(async (deviceId: string) => {
          try {
            const res = await fetch('/api/organizations', {
              headers: {
                'Content-Type': 'application/json',
                'anthropic-client-platform': 'web_claude_ai',
                'anthropic-device-id': deviceId,
              },
              credentials: 'include',
            });
            if (!res.ok) return { error: `HTTP ${res.status}` };
            const data = await res.json();
            return { orgs: data };
          } catch (e: any) {
            return { error: e.message };
          }
        }, this.deviceId ?? crypto.randomUUID());

        if (orgResult.error) {
          yield { type: 'error', message: `Failed to get organizations: ${orgResult.error}` };
          return;
        }

        const orgs = orgResult.orgs;
        if (!Array.isArray(orgs) || orgs.length === 0) {
          yield { type: 'error', message: 'No organizations found. Please log in to claude.ai first.' };
          return;
        }
        this.organizationId = orgs[0].uuid;
        this.deviceId = this.deviceId ?? crypto.randomUUID();
      }

      // Step 2: Create conversation
      const convUuid = crypto.randomUUID();
      const convResult = await page.evaluate(async (args: { apiBase: string; orgId: string; deviceId: string; convUuid: string }) => {
        try {
          const res = await fetch(`${args.apiBase}/organizations/${args.orgId}/chat_conversations`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'anthropic-client-platform': 'web_claude_ai',
              'anthropic-device-id': args.deviceId,
            },
            body: JSON.stringify({
              name: '',
              uuid: args.convUuid,
            }),
            credentials: 'include',
          });
          if (!res.ok) return { error: `HTTP ${res.status}` };
          const data = await res.json();
          return { conv: data };
        } catch (e: any) {
          return { error: e.message };
        }
      }, { apiBase: '/api', orgId: this.organizationId!, deviceId: this.deviceId!, convUuid });

      if (convResult.error) {
        yield { type: 'error', message: `Failed to create conversation: ${convResult.error}` };
        return;
      }

      const conversationId = convResult.conv?.uuid ?? convUuid;

      // Step 3: Build prompt from messages
      const prompt = buildWebPrompt(req.messages, req.tools);

      // Step 4: Send message and read SSE response
      const sseResult = await page.evaluate(async (args: {
        apiBase: string; orgId: string; convId: string; deviceId: string;
        prompt: string; model: string;
      }) => {
        try {
          const res = await fetch(
            `${args.apiBase}/organizations/${args.orgId}/chat_conversations/${args.convId}/completion`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
                'anthropic-client-platform': 'web_claude_ai',
                'anthropic-device-id': args.deviceId,
              },
              body: JSON.stringify({
                prompt: args.prompt,
                parent_message_uuid: '00000000-0000-4000-8000-000000000000',
                model: args.model,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                rendering_mode: 'messages',
                attachments: [],
                files: [],
                locale: 'en-US',
                personalized_styles: [],
                sync_sources: [],
                tools: [],
              }),
              credentials: 'include',
            }
          );

          if (!res.ok) {
            const text = await res.text();
            return { error: `HTTP ${res.status}: ${text.substring(0, 200)}` };
          }

          // Read full SSE response (buffered — streaming requires CDP interception)
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
        apiBase: '/api',
        orgId: this.organizationId!,
        convId: conversationId,
        deviceId: this.deviceId!,
        prompt,
        model: req.model,
      });

      if (sseResult.error) {
        yield { type: 'error', message: `Claude API error: ${sseResult.error}` };
        return;
      }

      // Step 5: Parse SSE lines and emit StreamEvents
      const lines = (sseResult.data ?? '').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const events = normalizeClaudeSSE(trimmed);
        for (const event of events) {
          yield event;
        }
      }

    } catch (err) {
      yield { type: 'error', message: `Claude provider error: ${(err as Error).message}` };
    }
  }
}
