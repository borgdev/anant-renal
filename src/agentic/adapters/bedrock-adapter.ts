/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

// AWS Bedrock Runtime adapter. Uses the Bedrock Anthropic-on-Bedrock
// invoke-model endpoint by default. Two auth modes are supported:
//
//   1. Explicit signer function passed at construction. This lets the caller
//      plug in AWS SigV4 via aws4-fetch, @aws-sdk/signature-v4, or any custom
//      credential provider without pulling those into the core repo.
//   2. Bearer credential (for internal proxies that already handle SigV4).
//
// The adapter shape mirrors the OpenAI/Anthropic ones so ModelRouter treats
// them uniformly.

import type { ModelAdapter, ModelRequest, ModelResponse, ReasoningTask } from '../model-router.js';

export type BedrockSigner = (init: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ headers: Record<string, string> }>;

export interface BedrockAdapterOptions {
  /** Bedrock foundation-model id (e.g. `anthropic.claude-3-5-sonnet-20241022-v2:0`). */
  modelId: string;
  region?: string;
  /** Bearer token if a proxy fronts SigV4. */
  bearerToken?: string;
  /** SigV4 signer if calling Bedrock directly. */
  signer?: BedrockSigner;
  /** Response body shape — defaults to `anthropic-messages` (Claude on Bedrock). */
  payloadShape?: 'anthropic-messages' | 'raw-text';
  systemPrompt?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  supportedTasks?: readonly ReasoningTask[];
}

interface AnthropicOnBedrockResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class BedrockAdapter implements ModelAdapter {
  readonly id: string;
  private readonly modelId: string;
  private readonly region: string;
  private readonly bearerToken: string | undefined;
  private readonly signer: BedrockSigner | undefined;
  private readonly payloadShape: NonNullable<BedrockAdapterOptions['payloadShape']>;
  private readonly systemPrompt: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly supportedTasks: ReadonlySet<ReasoningTask> | null;

  constructor(options: BedrockAdapterOptions) {
    this.modelId = options.modelId;
    this.region = options.region ?? (typeof process !== 'undefined' ? (process.env['AWS_REGION'] ?? 'us-east-1') : 'us-east-1');
    this.bearerToken = options.bearerToken;
    this.signer = options.signer;
    this.payloadShape = options.payloadShape ?? 'anthropic-messages';
    this.systemPrompt = options.systemPrompt ?? 'You are the reasoning core of a governed healthcare harness. Be precise.';
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.supportedTasks = options.supportedTasks ? new Set(options.supportedTasks) : null;
    this.id = `bedrock:${this.modelId}`;
  }

  supports(task: ReasoningTask): boolean {
    return this.supportedTasks ? this.supportedTasks.has(task) : true;
  }

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    if (!this.bearerToken && !this.signer) {
      throw new Error('BedrockAdapter: provide either bearerToken (proxy mode) or signer (SigV4 mode)');
    }
    const start = Date.now();
    const url = `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(this.modelId)}/invoke`;
    const body = JSON.stringify(this.buildBody(request));
    const baseHeaders: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    const headers = this.bearerToken
      ? { ...baseHeaders, authorization: `Bearer ${this.bearerToken}` }
      : (await this.signer!({ method: 'POST', url, headers: baseHeaders, body })).headers;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`BedrockAdapter: ${res.status} ${res.statusText} ${text}`);
      }
      const json = (await res.json()) as AnthropicOnBedrockResponse;
      const output = (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      const response: ModelResponse = { output, modelId: this.id, latencyMs: Date.now() - start };
      if (json.usage?.input_tokens !== undefined) response.tokensIn = json.usage.input_tokens;
      if (json.usage?.output_tokens !== undefined) response.tokensOut = json.usage.output_tokens;
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  private buildBody(request: ModelRequest): Record<string, unknown> {
    if (this.payloadShape === 'anthropic-messages') {
      return {
        anthropic_version: 'bedrock-2023-05-31',
        system: this.systemPrompt,
        messages: [{ role: 'user', content: buildUserMessage(request) }],
        max_tokens: request.budgetTokens ?? 1024,
        temperature: 0.2,
      };
    }
    return { inputText: buildUserMessage(request), textGenerationConfig: { maxTokenCount: request.budgetTokens ?? 1024 } };
  }
}

function buildUserMessage(request: ModelRequest): string {
  const ctxKeys = Object.keys(request.context);
  const ctxBlock = ctxKeys.length === 0 ? '' : `\n\n<context>\n${JSON.stringify(request.context, null, 2)}\n</context>`;
  return `Task: ${request.task}\n\n${request.prompt}${ctxBlock}`;
}
