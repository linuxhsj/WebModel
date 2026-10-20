import type { StreamEvent } from './stream.js';
import type { ModelInfo } from './provider.js';

interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }>;
}

export function formatStreamChunk(
  runId: string,
  modelId: string,
  event: StreamEvent,
  isFirst: boolean,
): ChatCompletionChunk {
  const base: ChatCompletionChunk = {
    id: runId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
  };

  if (event.type === 'text_delta') {
    base.choices[0].delta = isFirst
      ? { role: 'assistant', content: event.delta }
      : { content: event.delta };
  } else if (event.type === 'done') {
    const reason = event.reason === 'tool_use' ? 'tool_calls' : event.reason;
    base.choices[0].finish_reason = reason;
    base.choices[0].delta = {};
  } else if (event.type === 'thinking_delta') {
    base.choices[0].delta = isFirst
      ? { role: 'assistant', content: event.delta }
      : { content: event.delta };
  }

  return base;
}

export function formatDoneChunk(): string {
  return '[DONE]';
}

interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export function formatNonStreamResponse(
  runId: string,
  modelId: string,
  content: string,
): ChatCompletion {
  return {
    id: runId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

interface ModelsResponse {
  object: 'list';
  data: Array<{
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
    // Claude Code reads these to size its context bar and auto-compact
    // (same field names as the real Models API); without them it guesses.
    max_input_tokens: number;
    max_tokens: number;
  }>;
}

export function formatModelsResponse(
  models: (ModelInfo & { id: string })[],
): ModelsResponse {
  const now = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: models.map(m => ({
      id: m.id,
      object: 'model' as const,
      created: now,
      owned_by: 'web-model-bridge',
      max_input_tokens: m.contextWindow,
      max_tokens: m.maxOutput,
    })),
  };
}
