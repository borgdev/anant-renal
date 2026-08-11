// OpenAI chat-completions adapter. No SDK dependency — talks to the REST API
// with fetch(). Reads OPENAI_API_KEY from env by default; callers can override
// via the constructor to inject credentials from a secret manager.
//
// The adapter is intentionally minimal: it invokes the model once, extracts
// the first message.content, and returns latency + token counts.

import type { ModelAdapter, ModelRequest, ModelResponse, ReasoningTask } from '../model-router.js';

export interface OpenAIAdapterOptions {
  /** Model id (e.g. `gpt-4o-mini`, `gpt-4o`). Defaults to `gpt-4o-mini`. */
  model?: string;
  /** API key. Defaults to `process.env.OPENAI_API_KEY`. */
  apiKey?: string;
  /** Base URL (defaults to https://api.openai.com/v1). Override for Azure / proxies. */
  baseUrl?: string;
  /** Timeout in ms. Defaults to 60_000. */
  timeoutMs?: number;
  /** System prompt prefix applied to every request. */
  systemPrompt?: string;
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Task allow-list. If provided, adapter only supports these tasks. */
  supportedTasks?: readonly ReasoningTask[];
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAIAdapter implements ModelAdapter {
  readonly id: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly systemPrompt: string;
  private readonly fetchImpl: typeof fetch;
  private readonly supportedTasks: ReadonlySet<ReasoningTask> | null;

  constructor(options: OpenAIAdapterOptions = {}) {
    this.model = options.model ?? 'gpt-4o-mini';
    this.apiKey = options.apiKey ?? (typeof process !== 'undefined' ? process.env['OPENAI_API_KEY'] : undefined);
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.systemPrompt = options.systemPrompt ?? 'You are the reasoning core of a governed healthcare harness. Be precise and cite structured evidence when possible.';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.supportedTasks = options.supportedTasks ? new Set(options.supportedTasks) : null;
    this.id = `openai:${this.model}`;
  }

  supports(task: ReasoningTask): boolean {
    return this.supportedTasks ? this.supportedTasks.has(task) : true;
  }

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    if (!this.apiKey) throw new Error('OpenAIAdapter: missing API key (set OPENAI_API_KEY or pass apiKey)');
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: buildUserMessage(request) },
          ],
          max_tokens: request.budgetTokens ?? 1024,
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`OpenAIAdapter: ${res.status} ${res.statusText} ${text}`);
      }
      const json = (await res.json()) as OpenAIChatResponse;
      const output = json.choices?.[0]?.message?.content ?? '';
      const response: ModelResponse = {
        output,
        modelId: this.id,
        latencyMs: Date.now() - start,
      };
      if (json.usage?.prompt_tokens !== undefined) response.tokensIn = json.usage.prompt_tokens;
      if (json.usage?.completion_tokens !== undefined) response.tokensOut = json.usage.completion_tokens;
      return response;
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildUserMessage(request: ModelRequest): string {
  const ctxKeys = Object.keys(request.context);
  const ctxBlock = ctxKeys.length === 0 ? '' : `\n\n<context>\n${JSON.stringify(request.context, null, 2)}\n</context>`;
  return `Task: ${request.task}\n\n${request.prompt}${ctxBlock}`;
}
