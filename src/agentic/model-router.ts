// Model-agnostic router. The harness knows about task kinds — intent parsing,
// workflow synthesis, code generation, explanation — and picks an adapter per
// task. No model provider is a hard dependency; adapters are pure interfaces.

export type ReasoningTask =
  | 'intent-parse'
  | 'workflow-synthesis'
  | 'code-generation'
  | 'evaluation'
  | 'explanation'
  | 'summarization';

export interface ModelRequest {
  task: ReasoningTask;
  prompt: string;
  context: Readonly<Record<string, unknown>>;
  budgetTokens?: number;
}

export interface ModelResponse {
  output: string;
  modelId: string;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface ModelAdapter {
  id: string;
  supports(task: ReasoningTask): boolean;
  invoke(request: ModelRequest): Promise<ModelResponse>;
}

export class ModelRouter {
  private readonly adapters: ModelAdapter[] = [];
  private readonly preferences = new Map<ReasoningTask, string>();

  register(adapter: ModelAdapter): void {
    this.adapters.push(adapter);
  }

  prefer(task: ReasoningTask, modelId: string): void {
    this.preferences.set(task, modelId);
  }

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    const preferred = this.preferences.get(request.task);
    if (preferred) {
      const adapter = this.adapters.find((a) => a.id === preferred && a.supports(request.task));
      if (adapter) return adapter.invoke(request);
    }
    const fallback = this.adapters.find((a) => a.supports(request.task));
    if (!fallback) throw new Error(`No model adapter supports task ${request.task}`);
    return fallback.invoke(request);
  }
}

/**
 * A deterministic in-process adapter used for tests, replay, and offline
 * demos. It never calls out to the network; it just concatenates a summary
 * of the input for verifiable behavior.
 */
export class DeterministicModelAdapter implements ModelAdapter {
  id = 'deterministic-local';
  supports(): boolean {
    return true;
  }
  async invoke(request: ModelRequest): Promise<ModelResponse> {
    const output = `[${request.task}] ${request.prompt.slice(0, 200)}`;
    return { output, modelId: this.id, latencyMs: 0 };
  }
}
