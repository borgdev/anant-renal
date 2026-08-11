// Anthropic Messages API adapter. Same shape as OpenAIAdapter — fetch-based,
// no SDK dependency. Uses the x-api-key + anthropic-version headers.

import type { ModelAdapter, ModelRequest, ModelResponse, ReasoningTask } from '../model-router.js';

export interface AnthropicAdapterOptions {
  /** Model id (e.g. `claude-3-5-sonnet-latest`, `claude-3-haiku-20240307`). */
  model?: string;
  /** API key. Defaults to `process.env.ANTHROPIC_API_KEY`. */
  apiKey?: string;
  /** Base URL (defaults to https://api.anthropic.com). */
  baseUrl?: string;
  /** anthropic-version header. Defaults to `2023-06-01`. */
  apiVersion?: string;
  timeoutMs?: number;
  systemPrompt?: string;
  fetchImpl?: typeof fetch;
  supportedTasks?: readonly ReasoningTask[];
}

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicAdapter implements ModelAdapter {
  readonly id: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;
  private readonly systemPrompt: string;
  private readonly fetchImpl: typeof fetch;
  private readonly supportedTasks: ReadonlySet<ReasoningTask> | null;

  constructor(options: AnthropicAdapterOptions = {}) {
    this.model = options.model ?? 'claude-3-5-sonnet-latest';
    this.apiKey = options.apiKey ?? (typeof process !== 'undefined' ? process.env['ANTHROPIC_API_KEY'] : undefined);
    this.baseUrl = options.baseUrl ?? 'https://api.anthropic.com';
    this.apiVersion = options.apiVersion ?? '2023-06-01';
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.systemPrompt = options.systemPrompt ?? 'You are the reasoning core of a governed healthcare harness. Be precise and cite structured evidence when possible.';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.supportedTasks = options.supportedTasks ? new Set(options.supportedTasks) : null;
    this.id = `anthropic:${this.model}`;
  }

  supports(task: ReasoningTask): boolean {
    return this.supportedTasks ? this.supportedTasks.has(task) : true;
  }

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    if (!this.apiKey) throw new Error('AnthropicAdapter: missing API key (set ANTHROPIC_API_KEY or pass apiKey)');
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': this.apiVersion,
        },
        body: JSON.stringify({
          model: this.model,
          system: this.systemPrompt,
          messages: [{ role: 'user', content: buildUserMessage(request) }],
          max_tokens: request.budgetTokens ?? 1024,
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`AnthropicAdapter: ${res.status} ${res.statusText} ${text}`);
      }
      const json = (await res.json()) as AnthropicMessagesResponse;
      const output = (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      const response: ModelResponse = {
        output,
        modelId: this.id,
        latencyMs: Date.now() - start,
      };
      if (json.usage?.input_tokens !== undefined) response.tokensIn = json.usage.input_tokens;
      if (json.usage?.output_tokens !== undefined) response.tokensOut = json.usage.output_tokens;
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
