import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest, buildWebPrompt } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { AuthStore } from '../../auth/store.js';
import type { Page } from 'playwright-core';

export class KimiProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'kimi-web',
    name: 'Kimi Web',
    website: 'https://www.kimi.com',
    loginUrl: 'https://www.kimi.com',
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
      { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: 256000, maxOutput: 8192 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.getPage && !this.browserFetch) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    try {
      const page = this.getPage
        ? await this.getPage('https://www.kimi.com')
        : null;

      if (!page) {
        yield { type: 'error', message: 'Kimi requires getPage for Connect RPC calls' };
        return;
      }

      const prompt = buildWebPrompt(req.messages, req.tools);

      // Kimi uses Connect RPC protocol with binary framing
      const sseResult = await page.evaluate(async (args: { prompt: string }) => {
        try {
          // Get auth token from cookie or localStorage
          const authCookie = document.cookie.split(';')
            .find(c => c.trim().startsWith('kimi-auth='));
          const authToken = authCookie
            ? authCookie.split('=').slice(1).join('=').trim()
            : '';

          // Build Connect RPC request body
          const payload = JSON.stringify({
            scenario: 'SCENARIO_K2',
            message: {
              role: 'user',
              blocks: [{
                message_id: '',
                text: { content: args.prompt },
              }],
              scenario: 'SCENARIO_K2',
            },
            options: { thinking: false },
          });

          // Create binary framed payload (Connect RPC format)
          const encoder = new TextEncoder();
          const payloadBytes = encoder.encode(payload);
          const frame = new Uint8Array(5 + payloadBytes.length);
          frame[0] = 0x00; // frame type: data
          // 4-byte big-endian length
          const dv = new DataView(frame.buffer);
          dv.setUint32(1, payloadBytes.length);
          frame.set(payloadBytes, 5);

          const headers: Record<string, string> = {
            'Content-Type': 'application/connect+json',
            'Connect-Protocol-Version': '1',
            'Accept': '*/*',
            'X-Language': 'zh-CN',
            'X-Msh-Platform': 'web',
          };
          if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

          const res = await fetch('https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat', {
            method: 'POST',
            headers,
            body: frame,
            credentials: 'include',
          });

          if (!res.ok) {
            const text = await res.text();
            return { error: `HTTP ${res.status}: ${text.substring(0, 200)}` };
          }

          // Read binary response
          const reader = res.body?.getReader();
          if (!reader) return { error: 'No response body' };

          const chunks: Uint8Array[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
          }

          // Concatenate and decode frames
          const total = chunks.reduce((acc, c) => acc + c.length, 0);
          const allBytes = new Uint8Array(total);
          let offset = 0;
          for (const c of chunks) {
            allBytes.set(c, offset);
            offset += c.length;
          }

          // Parse Connect RPC frames
          const texts: string[] = [];
          let pos = 0;
          const dec = new TextDecoder();
          while (pos < allBytes.length) {
            if (pos + 5 > allBytes.length) break;
            const frameType = allBytes[pos];
            const view = new DataView(allBytes.buffer, allBytes.byteOffset + pos + 1, 4);
            const len = view.getUint32(0);
            pos += 5;
            if (pos + len > allBytes.length) break;
            const frameData = allBytes.slice(pos, pos + len);
            pos += len;

            if (frameType === 0x00) {
              texts.push(dec.decode(frameData));
            }
          }

          return { frames: texts };
        } catch (e: any) {
          return { error: e.message };
        }
      }, { prompt });

      if (sseResult.error) {
        yield { type: 'error', message: `Kimi API error: ${sseResult.error}` };
        return;
      }

      // Parse Kimi response frames
      for (const frame of sseResult.frames || []) {
        try {
          const parsed = JSON.parse(frame);
          // Kimi response has event field and data
          if (parsed?.event === 'resp' && parsed?.text) {
            yield { type: 'text_delta', delta: parsed.text };
          } else if (parsed?.event === 'all_done' || parsed?.event === 'cmpl') {
            yield { type: 'done', reason: 'stop' };
          } else if (parsed?.result?.text) {
            yield { type: 'text_delta', delta: parsed.result.text };
          }
        } catch {
          // If frame is plain text, emit as delta
          if (frame.length > 0 && !frame.startsWith('{')) {
            yield { type: 'text_delta', delta: frame };
          }
        }
      }
    } catch (err) {
      yield { type: 'error', message: `Kimi provider error: ${(err as Error).message}` };
    }
  }
}
