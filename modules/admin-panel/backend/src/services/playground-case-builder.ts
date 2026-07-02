import crypto from 'crypto';
import winston from 'winston';
import { getTrafficLogById, listAiTrafficSamples } from '@qq-bot/persistence';
import { DatabaseManager } from './database';
import {
  PlaygroundBaselineOutput,
  PlaygroundBaselineSnapshot,
  PlaygroundCase,
  PlaygroundCaseMode,
  PlaygroundExecutionMode,
  PlaygroundImportFidelity,
  PlaygroundImportResolution,
  PlaygroundLibraryPayload,
  PlaygroundMessage,
  PlaygroundPromptInput,
  PlaygroundProviderConfig,
  PlaygroundPromptMode,
  PlaygroundRequestPatch,
  PlaygroundRun
} from '../types/playground';

type PromptRecord = {
  id: string;
  prompt_name: string;
  system_instructions: unknown;
  user_prompt_template?: string | null;
  context_variables?: unknown;
  model_config?: unknown;
  advanced_config?: unknown;
  model_name?: string | null;
};

type TrafficLogRow = {
  id: number;
  trace_id?: string | null;
  conversation_id?: string | null;
  llm_call_id?: string | null;
  tool_call_id?: string | null;
  agent_turn?: number | null;
  method: string;
  url: string;
  host: string;
  path: string;
  request_headers?: unknown;
  request_body?: string | null;
  response_body?: string | null;
  response_status?: number | null;
  request_timestamp?: string | null;
  duration_ms?: number | null;
  api_type?: string | null;
  service_name?: string | null;
};

type ConversationRow = {
  id: string;
  trace_id?: string | null;
  user_message?: string | null;
  ai_response?: string | null;
  raw_request?: unknown;
  timestamp?: string | null;
  response_time?: number | null;
  model_name?: string | null;
  status?: string | null;
};

type LLMCallRow = {
  id?: number;
  trace_id?: string | null;
  conversation_id?: string | null;
  llm_call_id?: string | null;
  agent_turn?: number | null;
  model_provider?: string | null;
  model_name?: string | null;
  prompt_template?: string | null;
  canonical_request?: unknown;
  canonical_response?: unknown;
  wire_request?: unknown;
  wire_response?: unknown;
  effective_unified_config?: unknown;
  request_format_version?: string | null;
  wire_provider_format?: string | null;
  processed_response?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  api_call_time_ms?: number | null;
  processing_time_ms?: number | null;
  started_at?: string | null;
  completed_at?: string | null;
  status?: string | null;
};

type PlaygroundCaseRow = {
  id: string;
  name: string;
  source: 'traffic' | 'conversation' | 'span';
  source_ref: string;
  case_mode: 'contextual' | 'wire';
  trace_context: unknown;
  prompt_id?: string | null;
  prompt_mode_default: PlaygroundPromptMode;
  prompt_input: unknown;
  provider_config: unknown;
  baseline_snapshot?: unknown;
  current_patch?: unknown;
  import_fidelity?: PlaygroundImportFidelity | null;
  baseline_output?: unknown;
  raw_evidence: unknown;
  tags?: unknown;
  notes?: string | null;
  is_favorite: number | boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type PlaygroundRunRow = {
  id: string;
  case_id: string;
  execution_mode?: PlaygroundExecutionMode;
  prompt_mode: PlaygroundPromptMode;
  prompt_id?: string | null;
  prompt_snapshot?: unknown;
  provider_config_snapshot: unknown;
  input_snapshot: unknown;
  baseline_snapshot?: unknown;
  request_patch?: unknown;
  effective_request?: unknown;
  effective_config?: unknown;
  output_snapshot?: unknown;
  comparison_snapshot?: unknown;
  diff_snapshot?: unknown;
  model_name?: string | null;
  provider?: string | null;
  status: 'completed' | 'failed';
  executed_by: string;
  created_at: string;
};

type PlaygroundLibraryTrafficRow = {
  id: number;
  trace_id?: string | null;
  conversation_id?: string | null;
  method: string;
  host: string;
  path: string;
  url: string;
  api_type?: string | null;
  service_name?: string | null;
  response_status?: number | null;
  duration_ms?: number | null;
  request_timestamp?: string | null;
};

export class PlaygroundCompatibilityError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'PlaygroundCompatibilityError';
    this.statusCode = statusCode;
  }
}

type NormalizedToolCallSummary = {
  name: string;
  arguments: string;
};

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  if (typeof value === 'object') {
    return value as T;
  }

  return fallback;
}

function stringify(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function normalizeProvider(value?: string | null): PlaygroundProviderConfig['model']['provider'] {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'openai') return 'openai';
  if (normalized === 'anthropic' || normalized === 'claude' || normalized === 'claude-code') return 'anthropic';
  if (normalized === 'codex' || normalized === 'openai-codex') return 'codex';
  if (
    normalized === 'codex-local' ||
    normalized === 'openai-codex-local' ||
    normalized === 'local-codex' ||
    normalized === 'codex-openai'
  ) return 'codex-local';
  if (normalized === 'google' || normalized === 'google-legacy' || normalized === 'gemini-api') return 'google-legacy';
  return 'google-gemini-cli';
}

function defaultModelForProvider(provider: PlaygroundProviderConfig['model']['provider']): string {
  switch (provider) {
    case 'openai':
      return 'gpt-5-mini';
    case 'codex-local':
      return 'gpt-5.5';
    case 'codex':
      return 'gpt-5-mini';
    case 'anthropic':
      return 'claude-opus-4-6';
    case 'google-legacy':
      return 'gemini-2.5-flash';
    case 'google-gemini-cli':
    default:
      return 'gemini-2.5-flash';
  }
}

function createDefaultProviderConfig(
  provider: PlaygroundProviderConfig['model']['provider'] = 'google-gemini-cli'
): PlaygroundProviderConfig {
  return {
    id: 'playground-provider',
    name: 'Playground Provider Config',
    category: 'playground',
    model: {
      name: null,
      provider,
      providerSpecific: {}
    },
    generation: {
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 2048
    },
    thinking: {},
    safety: [],
    tools: {},
    context: {},
    performance: {},
    version: {}
  };
}

function normalizeStopSequences(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return [value.trim()];
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizePlaygroundProviderConfig(
  value: unknown,
  fallbackProvider?: string | null
): PlaygroundProviderConfig {
  const record = parseJsonField<Record<string, unknown> | null>(value, null);
  if (!record) {
    return createDefaultProviderConfig(normalizeProvider(fallbackProvider));
  }

  const model = asRecord(record.model);
  if (model && typeof model.name === 'string' && typeof model.provider === 'string') {
    const provider = normalizeProvider(model.provider);
    const next = createDefaultProviderConfig(provider);
    return {
      ...next,
      ...record,
      model: {
        ...next.model,
        ...model,
        name: model.name.trim() || null,
        provider,
        providerSpecific: parseJsonField<Record<string, unknown>>(model.providerSpecific, {})
      },
      generation: parseJsonField<Record<string, unknown>>(record.generation, next.generation),
      thinking: parseJsonField<Record<string, unknown>>(record.thinking, {}),
      safety: parseJsonField<Array<Record<string, unknown>>>(record.safety, []),
      tools: parseJsonField<Record<string, unknown>>(record.tools, {}),
      context: parseJsonField<Record<string, unknown>>(record.context, {}),
      performance: parseJsonField<Record<string, unknown>>(record.performance, {}),
      version: parseJsonField<Record<string, unknown>>(record.version, {})
    };
  }

  const provider = normalizeProvider(
    typeof record.provider === 'string' ? record.provider : fallbackProvider || null
  );
  const next = createDefaultProviderConfig(provider);
  const generation = parseJsonField<Record<string, unknown>>(record.generation, {});
  const context = parseJsonField<Record<string, unknown>>(record.context, {});

  return {
    ...next,
    model: {
      ...next.model,
      name: typeof context.modelName === 'string' && context.modelName.trim().length > 0
        ? context.modelName
        : null,
      provider,
      providerSpecific: parseJsonField<Record<string, unknown>>(record.providerSpecific, {})
    },
    generation: {
      ...next.generation,
      ...generation,
      ...(normalizeStopSequences(generation.stopSequences ?? generation.stop)
        ? { stopSequences: normalizeStopSequences(generation.stopSequences ?? generation.stop) }
        : {})
    },
    thinking: parseJsonField<Record<string, unknown>>(record.thinking, {}),
    safety: parseJsonField<Array<Record<string, unknown>>>(record.safety, []),
    tools: parseJsonField<Record<string, unknown>>(record.tools, {}),
    context,
    performance: parseJsonField<Record<string, unknown>>(record.performance, {})
  };
}

function getProviderFromConfig(providerConfig: PlaygroundProviderConfig): PlaygroundProviderConfig['model']['provider'] {
  return normalizeProvider(providerConfig.model?.provider);
}

function getModelNameFromConfig(providerConfig: PlaygroundProviderConfig): string | null {
  return typeof providerConfig.model?.name === 'string' && providerConfig.model.name.trim().length > 0
    ? providerConfig.model.name.trim()
    : null;
}

function getProviderSpecificFromConfig(providerConfig: PlaygroundProviderConfig): Record<string, unknown> {
  const providerSpecific = providerConfig.model?.providerSpecific;
  return providerSpecific && typeof providerSpecific === 'object' && !Array.isArray(providerSpecific)
    ? providerSpecific
    : {};
}

function normalizePromptMessages(messages: PlaygroundMessage[]): PlaygroundMessage[] {
  return messages
    .map((message): PlaygroundMessage => ({
      role: message.role === 'assistant'
        ? 'assistant'
        : message.role === 'system'
          ? 'system'
          : 'user',
      content: typeof message.content === 'string' ? message.content : ''
    }))
    .filter((message) => message.content.trim().length > 0);
}

export function parseSystemInstructions(value: unknown): string {
  const parsed = parseJsonField<unknown>(value, value);
  if (Array.isArray(parsed)) {
    return parsed
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean)
      .join('\n');
  }
  return typeof parsed === 'string' ? parsed : '';
}

function applyContextVariables(
  template: string,
  contextVariables: Record<string, unknown> = {},
  runtimeVariables: Record<string, unknown> = {}
): string {
  if (!template) {
    return '';
  }

  const variables = {
    ...contextVariables,
    ...runtimeVariables
  };

  return template
    .replace(/\{\{(\w+)\}\}/g, (match, key) => {
      if (!(key in variables)) {
        return match;
      }
      const value = variables[key];
      return typeof value === 'string' ? value : stringify(value);
    })
    .replace(/\$\{(\w+)\}/g, (match, key) => {
      if (!(key in variables)) {
        return match;
      }
      const value = variables[key];
      return typeof value === 'string' ? value : stringify(value);
    });
}

function normalizeOpenResponseMessageRole(role?: string): PlaygroundMessage['role'] | null {
  if (role === 'assistant') return 'assistant';
  if (role === 'system' || role === 'developer') return 'system';
  if (role === 'user') return 'user';
  return null;
}

function extractTextFromOpenResponseMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    throw new PlaygroundCompatibilityError('Unsupported OpenResponse message content shape for Playground import');
  }

  const textParts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') {
      throw new PlaygroundCompatibilityError('Unsupported OpenResponse message content item for Playground import');
    }

    if ((part as { type?: string }).type !== 'input_text') {
      throw new PlaygroundCompatibilityError('Only text OpenResponse message parts can be imported into Playground');
    }

    textParts.push(String((part as { text?: unknown }).text || ''));
  }

  return textParts.join('\n');
}

function extractMessagesFromOpenResponseInput(input: unknown): PlaygroundMessage[] {
  const items = Array.isArray(input) ? input : [];
  const messages: PlaygroundMessage[] = [];

  for (const item of items) {
    if (!item || typeof item !== 'object' || (item as { type?: string }).type !== 'message') {
      throw new PlaygroundCompatibilityError(`Unsupported OpenResponse input item for Playground import: ${(item as { type?: string }).type || 'unknown'}`);
    }

    const role = normalizeOpenResponseMessageRole((item as { role?: string }).role);
    if (!role) {
      throw new PlaygroundCompatibilityError(`Unsupported OpenResponse message role for Playground import: ${String((item as { role?: unknown }).role || 'unknown')}`);
    }

    const text = extractTextFromOpenResponseMessageContent((item as { content?: unknown }).content);
    if (text.trim()) {
      messages.push({ role, content: text });
    }
  }

  return normalizePromptMessages(messages);
}

function extractMessagesFromGeminiContents(contents: unknown): PlaygroundMessage[] {
  if (!Array.isArray(contents)) {
    return [];
  }

  return normalizePromptMessages(
    contents.map((content) => {
      const rawRole = (content as { role?: string }).role;
      const role = rawRole === 'model'
        ? 'assistant'
        : rawRole === 'system' || rawRole === 'developer'
          ? 'system'
          : 'user';
      const parts = Array.isArray((content as { parts?: unknown[] }).parts)
        ? ((content as { parts?: Array<{ text?: unknown }> }).parts || [])
        : [];
      const text = parts
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n');
      return { role, content: text };
    })
  );
}

function extractTextResponse(value: unknown): string {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return extractTextResponse(parsed);
    } catch {
      return value;
    }
  }

  if (typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string' && record.text.trim()) {
    return record.text;
  }
  if (typeof record.output_text === 'string' && record.output_text.trim()) {
    return record.output_text;
  }
  if (typeof record.processed_response === 'string' && record.processed_response.trim()) {
    return record.processed_response;
  }

  const parts = (((record.candidates as Array<Record<string, unknown>> | undefined)?.[0]?.content as Record<string, unknown> | undefined)?.parts as Array<Record<string, unknown>> | undefined) || [];
  const text = parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');

  return text;
}

function normalizeToolCallArguments(argumentsValue: unknown): string {
  if (typeof argumentsValue === 'string') {
    const trimmed = argumentsValue.trim();
    if (!trimmed) {
      return '{}';
    }

    try {
      return JSON.stringify(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }

  if (argumentsValue === null || argumentsValue === undefined) {
    return '{}';
  }

  try {
    return JSON.stringify(argumentsValue);
  } catch {
    return String(argumentsValue);
  }
}

function extractToolCallSummaries(value: unknown): NormalizedToolCallSummary[] {
  if (!value) {
    return [];
  }

  if (typeof value === 'string') {
    try {
      return extractToolCallSummaries(JSON.parse(value));
    } catch {
      return [];
    }
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractToolCallSummaries(item));
  }

  if (typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  const directName = typeof record.name === 'string' ? record.name.trim() : '';
  const directType = typeof record.type === 'string' ? record.type : '';
  if (directType === 'function_call' && directName) {
    return [{
      name: directName,
      arguments: normalizeToolCallArguments(record.arguments)
    }];
  }

  const outputItems = Array.isArray(record.output) ? record.output : [];
  if (outputItems.length > 0) {
    return outputItems.flatMap((item) => extractToolCallSummaries(item));
  }

  return [];
}

export function summarizeToolCallsFromResponse(value: unknown): string {
  const summaries = extractToolCallSummaries(value);
  if (summaries.length === 0) {
    return '';
  }

  return summaries
    .map((summary) => `${summary.name}(${summary.arguments})`)
    .join('\n');
}

export function buildPlaygroundResponseTextFallback(
  params: {
    processedResponse?: unknown;
    canonicalResponse?: unknown;
    wireResponse?: unknown;
  }
): string {
  const processedText = typeof params.processedResponse === 'string' ? params.processedResponse.trim() : '';
  if (processedText) {
    return processedText;
  }

  const canonicalText = extractTextResponse(params.canonicalResponse).trim();
  if (canonicalText) {
    return canonicalText;
  }

  const wireText = extractTextResponse(params.wireResponse).trim();
  if (wireText) {
    return wireText;
  }

  return summarizeToolCallsFromResponse(params.canonicalResponse)
    || summarizeToolCallsFromResponse(params.wireResponse);
}

function hasSystemPromptMessage(messages: PlaygroundPromptInput['messages']): boolean {
  return messages.some((message) => message.role === 'system');
}

function normalizePlaygroundToolsForValidation(value: unknown): {
  definitions: unknown[];
  toolChoice: unknown | null;
  extras: string[];
} {
  const record = asRecord(value) || {};
  const definitions = Array.isArray(record.definitions) ? record.definitions : [];
  const toolChoice = Object.prototype.hasOwnProperty.call(record, 'toolChoice') ? record.toolChoice ?? null : null;
  const extras = Object.keys(record).filter((key) => key !== 'definitions' && key !== 'toolChoice');

  return {
    definitions,
    toolChoice,
    extras
  };
}

function normalizePlaygroundToolsForPatch(value: unknown): {
  definitions: unknown[];
  toolChoice: unknown | null;
} {
  const normalized = normalizePlaygroundToolsForValidation(value);
  return {
    definitions: normalized.definitions,
    toolChoice: normalized.toolChoice
  };
}

function normalizeSupportedPlaygroundTools(value: unknown): Record<string, unknown> {
  const record = asRecord(value) || {};
  const definitions = Array.isArray(record.definitions) ? record.definitions : [];
  const toolChoice = Object.prototype.hasOwnProperty.call(record, 'toolChoice')
    ? record.toolChoice ?? null
    : null;

  const next: Record<string, unknown> = {};
  if (definitions.length > 0) {
    next.definitions = definitions;
  }
  if (toolChoice !== null) {
    next.toolChoice = toolChoice;
  }
  return next;
}

export function validatePlaygroundPromptInput(promptInput: PlaygroundPromptInput): void {
  if (hasSystemPromptMessage(promptInput.messages)) {
    throw new PlaygroundCompatibilityError(
      'Prompt input messages must not contain system role entries. Use systemInstruction instead.',
      400
    );
  }
}

export function validatePlaygroundProviderConfig(providerConfig: PlaygroundProviderConfig): void {
  const normalizedTools = normalizePlaygroundToolsForValidation(providerConfig.tools);
  if (normalizedTools.extras.length > 0) {
    throw new PlaygroundCompatibilityError(
      `Playground tools only support definitions and toolChoice. Unsupported keys: ${normalizedTools.extras.join(', ')}`,
      400
    );
  }
}

function providerFromApiType(apiType?: string | null): PlaygroundProviderConfig['model']['provider'] {
  const normalized = (apiType || '').trim().toLowerCase();
  if (normalized === 'openai') return 'openai';
  if (normalized === 'codex') return 'codex';
  if (
    normalized === 'codex-local' ||
    normalized === 'openai-codex-local' ||
    normalized === 'local-codex' ||
    normalized === 'codex-openai'
  ) return 'codex-local';
  if (normalized === 'google-legacy') return 'google-legacy';
  return 'google-gemini-cli';
}

function inferProviderFromModelName(modelName?: string | null): PlaygroundProviderConfig['model']['provider'] {
  const normalized = (modelName || '').trim().toLowerCase();
  if (
    normalized.includes('codex') ||
    normalized === 'gpt-5-mini' ||
    normalized === 'gpt-5.5' ||
    normalized === 'gpt-5.5-mini' ||
    normalized === 'gpt-5.3-codex' ||
    normalized === 'gpt-5.3-codex-spark' ||
    normalized === 'gpt-5.2-codex'
  ) {
    return 'codex-local';
  }

  if (
    normalized.startsWith('gpt-') ||
    normalized.startsWith('o1') ||
    normalized.startsWith('o3') ||
    normalized.startsWith('o4')
  ) {
    return 'openai';
  }

  return 'google-gemini-cli';
}

export function buildProviderConfigFromPrompt(prompt?: PromptRecord | null): PlaygroundProviderConfig {
  const modelConfig = parseJsonField<Record<string, unknown>>(prompt?.model_config, {});
  const advancedConfig = parseJsonField<Record<string, unknown>>(prompt?.advanced_config, {});
  const provider = normalizeProvider(
    typeof modelConfig.provider === 'string'
      ? modelConfig.provider
      : typeof (advancedConfig.provider) === 'string'
        ? (advancedConfig.provider as string)
        : typeof (advancedConfig.model as Record<string, unknown> | undefined)?.provider === 'string'
          ? ((advancedConfig.model as Record<string, unknown>).provider as string)
          : inferProviderFromModelName(prompt?.model_name)
  );

  const providerSpecific = {
    ...(parseJsonField<Record<string, unknown>>(modelConfig.providerSpecific, {})),
    ...(parseJsonField<Record<string, unknown>>((advancedConfig.model as Record<string, unknown> | undefined)?.providerSpecific, {}))
  };

  const next = createDefaultProviderConfig(provider);
  return {
    ...next,
    model: {
      ...next.model,
      name: prompt?.model_name || null,
      provider,
      providerSpecific: Object.keys(providerSpecific).length > 0 ? providerSpecific : {}
    },
    generation: parseJsonField<Record<string, unknown>>(advancedConfig.generationConfig, {
      temperature: modelConfig.temperature ?? 0.7,
      topP: modelConfig.topP ?? 0.95,
      topK: modelConfig.topK ?? 40,
      maxOutputTokens: modelConfig.maxOutputTokens ?? 2048
    }),
    thinking: parseJsonField<Record<string, unknown>>(advancedConfig.thinkingConfig, {}),
    safety: parseJsonField<Array<Record<string, unknown>>>(advancedConfig.safetySettings, []),
    tools: normalizeSupportedPlaygroundTools(parseJsonField<Record<string, unknown>>(advancedConfig.toolsConfig, {})),
    context: {
      promptId: prompt?.id || null,
      promptName: prompt?.prompt_name || null
    },
    performance: {}
  };
}

function buildProviderConfigFromTraffic(log: TrafficLogRow, llmCall?: LLMCallRow | null): PlaygroundProviderConfig {
  const requestBody = parseJsonField<Record<string, unknown>>(log.request_body, {});
  const canonicalRequest = parseJsonField<Record<string, unknown>>(llmCall?.canonical_request, {});
  const generation = parseJsonField<Record<string, unknown>>(
    (canonicalRequest.generationConfig as Record<string, unknown> | undefined) || requestBody.generationConfig,
    {}
  );
  const thinking = parseJsonField<Record<string, unknown>>(
    ((generation as Record<string, unknown>).thinkingConfig as Record<string, unknown> | undefined),
    {}
  );

  const provider = llmCall?.model_provider
    ? normalizeProvider(llmCall.model_provider)
    : providerFromApiType(log.api_type);

  const next = createDefaultProviderConfig(provider);
  return {
    ...next,
    model: {
      ...next.model,
      name: llmCall?.model_name || null,
      provider,
      providerSpecific: {}
    },
    generation,
    thinking,
    safety: parseJsonField<Array<Record<string, unknown>>>(
      requestBody.safetySettings || canonicalRequest.safetySettings,
      []
    ),
    tools: normalizeSupportedPlaygroundTools(parseJsonField<Record<string, unknown>>(
      requestBody.toolConfig || canonicalRequest.toolConfig || {},
      {}
    )),
    context: {
      promptTemplate: llmCall?.prompt_template || null
    }
  };
}

export function buildPromptInputFromCanonicalRequest(canonicalRequest: Record<string, unknown>): PlaygroundPromptInput {
  const systemInstruction = parseSystemInstructions(canonicalRequest.instructions);
  const normalizedSystemInstruction = systemInstruction.trim();
  const messages = extractMessagesFromOpenResponseInput(canonicalRequest.input).filter((message) => {
    if (message.role !== 'system' || !normalizedSystemInstruction) {
      return true;
    }

    return message.content.trim() !== normalizedSystemInstruction;
  });

  return {
    systemInstruction,
    messages,
    contextVariables: {}
  };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (left === null || right === null || left === undefined || right === undefined) {
    return left === right;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((item, index) => deepEqual(item, right[index]));
  }

  if (typeof left === 'object' && typeof right === 'object') {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();

    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    return leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(leftRecord[key], rightRecord[key]));
  }

  return false;
}

function mapUnifiedProvider(value?: string | null): PlaygroundProviderConfig['model']['provider'] {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'openai') return 'openai';
  if (normalized === 'codex' || normalized === 'openai-codex') return 'codex';
  if (
    normalized === 'codex-local' ||
    normalized === 'openai-codex-local' ||
    normalized === 'local-codex' ||
    normalized === 'codex-openai'
  ) return 'codex-local';
  if (normalized === 'google-legacy' || normalized === 'google') return 'google-legacy';
  return 'google-gemini-cli';
}

function buildOpenResponseInput(messages: PlaygroundMessage[]): Array<Record<string, unknown>> {
  return normalizePromptMessages(messages).map((message) => ({
    type: 'message',
    role: message.role === 'system' ? 'developer' : message.role,
    content: [
      {
        type: 'input_text',
        text: message.content
      }
    ]
  }));
}

function buildBaselineSnapshot(
  llmCall: LLMCallRow,
  traceId?: string | null,
  spanId?: string | null
): PlaygroundBaselineSnapshot {
  return {
    traceId: llmCall.trace_id || traceId || null,
    conversationId: llmCall.conversation_id || null,
    llmCallId: llmCall.llm_call_id || null,
    spanId: spanId || null,
    agentTurn: llmCall.agent_turn ?? null,
    provider: llmCall.model_provider || null,
    modelName: llmCall.model_name || null,
    canonicalRequest: parseJsonField<Record<string, unknown> | null>(llmCall.canonical_request, null),
    canonicalResponse: parseJsonField(llmCall.canonical_response, null),
    wireRequest: parseJsonField(llmCall.wire_request, null),
    wireResponse: parseJsonField(llmCall.wire_response, null),
    requestFormatVersion: typeof llmCall.request_format_version === 'string' ? llmCall.request_format_version : null,
    wireProviderFormat: typeof llmCall.wire_provider_format === 'string' ? llmCall.wire_provider_format : null,
    effectiveUnifiedConfig: parseJsonField<Record<string, unknown> | null>(llmCall.effective_unified_config, null)
  };
}

export function buildProviderConfigFromBaselineSnapshot(
  snapshot: PlaygroundBaselineSnapshot,
  fallbackProvider?: string | null
): PlaygroundProviderConfig {
  const canonicalRequest = snapshot.canonicalRequest || {};
  const unifiedConfig = normalizePlaygroundProviderConfig(snapshot.effectiveUnifiedConfig, fallbackProvider);
  const provider = mapUnifiedProvider(unifiedConfig.model.provider || snapshot.provider || fallbackProvider || null);
  const canonicalGeneration = {
    temperature: canonicalRequest.temperature,
    topP: canonicalRequest.top_p,
    maxOutputTokens: canonicalRequest.max_output_tokens,
    ...(canonicalRequest.stop !== undefined ? { stopSequences: normalizeStopSequences(canonicalRequest.stop) } : {})
  };

  return {
    ...unifiedConfig,
    model: {
      ...unifiedConfig.model,
      name: snapshot.modelName || unifiedConfig.model.name || null,
      provider,
    },
    generation: {
      ...unifiedConfig.generation,
      ...Object.fromEntries(Object.entries(canonicalGeneration).filter(([, value]) => value !== undefined))
    },
    tools: {
      definitions: Array.isArray(canonicalRequest.tools) ? canonicalRequest.tools : [],
      toolChoice: canonicalRequest.tool_choice ?? null
    },
    context: {
      ...unifiedConfig.context,
      promptTemplate: null
    },
  };
}

function buildRequestPatch(
  baselineSnapshot: PlaygroundBaselineSnapshot | null | undefined,
  promptInput: PlaygroundPromptInput,
  providerConfig: PlaygroundProviderConfig
): PlaygroundRequestPatch {
  if (!baselineSnapshot?.canonicalRequest) {
    return {};
  }

  const baselineRequest = baselineSnapshot.canonicalRequest;
  const baselinePromptInput = buildPromptInputFromCanonicalRequest(baselineRequest);
  const patch: PlaygroundRequestPatch = {};

  if (promptInput.systemInstruction !== baselinePromptInput.systemInstruction) {
    patch.instructions = promptInput.systemInstruction;
  }

  if (!deepEqual(promptInput.messages, baselinePromptInput.messages)) {
    patch.input = buildOpenResponseInput(promptInput.messages);
  }

  const nextTools = normalizePlaygroundToolsForPatch(providerConfig.tools);
  const baselineTools = {
    definitions: Array.isArray(baselineRequest.tools) ? baselineRequest.tools : [],
    toolChoice: baselineRequest.tool_choice ?? null
  };
  if (!deepEqual(nextTools, baselineTools)) {
    patch.tools = nextTools.definitions;
    patch.tool_choice = nextTools.toolChoice;
  }

  const numericFields: Array<[keyof PlaygroundRequestPatch, unknown, unknown]> = [
    ['temperature', providerConfig.generation.temperature, baselineRequest.temperature],
    ['top_p', providerConfig.generation.topP, baselineRequest.top_p],
    ['max_output_tokens', providerConfig.generation.maxOutputTokens, baselineRequest.max_output_tokens],
    ['stop', providerConfig.generation.stopSequences, baselineRequest.stop]
  ];

  numericFields.forEach(([key, nextValue, baselineValue]) => {
    if (!deepEqual(nextValue, baselineValue) && nextValue !== undefined) {
      (patch as any)[key] = nextValue as any;
    }
  });

  const nextProvider = getProviderFromConfig(providerConfig);
  const baselineProvider = mapUnifiedProvider(
    typeof (baselineSnapshot.effectiveUnifiedConfig as any)?.model?.provider === 'string'
      ? (baselineSnapshot.effectiveUnifiedConfig as any).model.provider
      : baselineSnapshot.provider || null
  );
  if (nextProvider && nextProvider !== baselineProvider) {
    patch.provider = nextProvider;
  }

  const nextModelName = getModelNameFromConfig(providerConfig);
  const baselineModelName = baselineSnapshot.modelName || (typeof baselineRequest.model === 'string' ? baselineRequest.model : null);
  if (nextModelName && nextModelName !== baselineModelName) {
    patch.modelName = nextModelName;
  }

  if (!deepEqual(getProviderSpecificFromConfig(providerConfig), (baselineSnapshot.effectiveUnifiedConfig as any)?.model?.providerSpecific || {})) {
    patch.providerSpecific = getProviderSpecificFromConfig(providerConfig);
  }

  return patch;
}

export class PlaygroundCaseBuilder {
  private llmCallTableName: 'llm_request_slices' | null | undefined;
  private static readonly LIBRARY_TRAFFIC_LIMIT = 24;
  private static readonly LIBRARY_CASE_LIMIT = 24;
  private static readonly LIBRARY_RUN_LIMIT = 12;
  private static readonly TRAFFIC_SEARCH_BATCH_SIZE = 200;

  constructor(
    private readonly db: DatabaseManager,
    private readonly logger: winston.Logger
  ) {}

  async ensureTables(): Promise<void> {
    await this.db.executeUpdate(`
      CREATE TABLE IF NOT EXISTS playground_cases (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        source VARCHAR(32) NOT NULL,
        source_ref VARCHAR(255) NOT NULL,
        case_mode VARCHAR(32) NOT NULL,
        trace_context JSONB NOT NULL,
        prompt_id VARCHAR(36) NULL,
        prompt_mode_default VARCHAR(32) NOT NULL DEFAULT 'draft',
        prompt_input JSONB NOT NULL,
        provider_config JSONB NOT NULL,
        baseline_snapshot JSONB NULL,
        current_patch JSONB NULL,
        import_fidelity VARCHAR(32) NOT NULL DEFAULT 'exact',
        baseline_output JSONB NULL,
        raw_evidence JSONB NOT NULL,
        tags JSONB NULL,
        notes TEXT NULL,
        is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
        created_by VARCHAR(100) NOT NULL DEFAULT 'admin',
        created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await this.db.executeUpdate(`
      CREATE TABLE IF NOT EXISTS playground_runs (
        id VARCHAR(36) PRIMARY KEY,
        case_id VARCHAR(36) NOT NULL,
        execution_mode VARCHAR(32) NOT NULL DEFAULT 'exact_replay',
        prompt_mode VARCHAR(32) NOT NULL,
        prompt_id VARCHAR(36) NULL,
        prompt_snapshot JSONB NULL,
        provider_config_snapshot JSONB NOT NULL,
        input_snapshot JSONB NOT NULL,
        baseline_snapshot JSONB NULL,
        request_patch JSONB NULL,
        effective_request JSONB NULL,
        effective_config JSONB NULL,
        output_snapshot JSONB NULL,
        comparison_snapshot JSONB NULL,
        diff_snapshot JSONB NULL,
        model_name VARCHAR(120) NULL,
        provider VARCHAR(50) NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'completed',
        executed_by VARCHAR(100) NOT NULL DEFAULT 'admin',
        created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_playground_runs_case FOREIGN KEY (case_id) REFERENCES playground_cases(id) ON DELETE CASCADE
      )
    `);

    await this.ensureIndex(
      'http_traffic_logs',
      'idx_ai_request_time_id',
      'CREATE INDEX IF NOT EXISTS idx_ai_request_time_id ON http_traffic_logs (is_ai_request, request_timestamp, id)'
    );
    await this.ensureIndex(
      'playground_cases',
      'idx_library_sort',
      'CREATE INDEX IF NOT EXISTS idx_library_sort ON playground_cases (is_favorite, updated_at, id)'
    );
    await this.ensureIndex(
      'playground_cases',
      'idx_prompt_library_sort',
      'CREATE INDEX IF NOT EXISTS idx_prompt_library_sort ON playground_cases (prompt_id, is_favorite, updated_at, id)'
    );
    await this.ensureIndex(
      'playground_cases',
      'idx_source_ref_updated_at_id',
      'CREATE INDEX IF NOT EXISTS idx_source_ref_updated_at_id ON playground_cases (source, source_ref, updated_at, id)'
    );
    await this.ensureIndex(
      'playground_runs',
      'idx_created_at_id',
      'CREATE INDEX IF NOT EXISTS idx_created_at_id ON playground_runs (created_at, id)'
    );
  }

  async listLibrary(params: { search?: string; promptId?: string | null } = {}): Promise<PlaygroundLibraryPayload> {
    const searchLike = params.search ? `%${params.search}%` : null;
    const trafficSamples = await this.listTrafficSamples(params.search);

    const caseFilters: string[] = [];
    const caseParams: unknown[] = [];
    if (params.promptId) {
      caseFilters.push('prompt_id = ?');
      caseParams.push(params.promptId);
    }
    if (searchLike) {
      caseFilters.push('(name LIKE ? OR notes LIKE ?)');
      caseParams.push(searchLike, searchLike);
    }
    const caseWhere = caseFilters.length > 0 ? `WHERE ${caseFilters.join(' AND ')}` : '';

    const cases = await this.db.executeQuery<PlaygroundCaseRow>(
      `
        SELECT *
        FROM playground_cases
        ${caseWhere}
        ORDER BY is_favorite DESC, updated_at DESC, id DESC
        LIMIT ${PlaygroundCaseBuilder.LIBRARY_CASE_LIMIT}
      `,
      caseParams
    );

    const runs = await this.db.executeQuery<PlaygroundRunRow>(
      `
        SELECT *
        FROM playground_runs
        ORDER BY created_at DESC, id DESC
        LIMIT ${PlaygroundCaseBuilder.LIBRARY_RUN_LIMIT}
      `
    );

    return {
      trafficSamples,
      savedCases: cases.map((row) => this.mapCaseRow(row)),
      recentRuns: runs.map((row) => this.mapRunRow(row))
    };
  }

  private async ensureIndex(tableName: string, indexName: string, ddl: string): Promise<void> {
    const rows = await this.db.executeQuery<{ total: number }>(
      `
        SELECT COUNT(*) AS total
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = ?
          AND indexname = ?
      `,
      [tableName, indexName]
    );

    if ((rows[0]?.total || 0) === 0) {
      await this.db.executeUpdate(ddl);
    }
  }

  private async ensureColumn(tableName: string, columnName: string, ddl: string): Promise<void> {
    const rows = await this.db.executeQuery<{ total: number }>(
      `
        SELECT COUNT(*) AS total
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ?
          AND column_name = ?
      `,
      [tableName, columnName]
    );

    if ((rows[0]?.total || 0) === 0) {
      await this.db.executeUpdate(ddl);
    }
  }

  private async listTrafficSamples(search?: string): Promise<PlaygroundLibraryTrafficRow[]> {
    const rows = await listAiTrafficSamples({
      search,
      limit: PlaygroundCaseBuilder.LIBRARY_TRAFFIC_LIMIT
    });
    return rows as PlaygroundLibraryTrafficRow[];
  }

  async getCaseById(caseId: string): Promise<PlaygroundCase | null> {
    const rows = await this.db.executeQuery<PlaygroundCaseRow>(
      'SELECT * FROM playground_cases WHERE id = ?',
      [caseId]
    );
    return rows[0] ? this.mapCaseRow(rows[0]) : null;
  }

  async listRunsByCase(caseId: string): Promise<ReturnType<PlaygroundCaseBuilder['mapRunRow']>[]> {
    const rows = await this.db.executeQuery<PlaygroundRunRow>(
      'SELECT * FROM playground_runs WHERE case_id = ? ORDER BY created_at DESC',
      [caseId]
    );
    return rows.map((row) => this.mapRunRow(row));
  }

  async getRunById(runId: string): Promise<ReturnType<PlaygroundCaseBuilder['mapRunRow']> | null> {
    const rows = await this.db.executeQuery<PlaygroundRunRow>(
      'SELECT * FROM playground_runs WHERE id = ?',
      [runId]
    );
    return rows[0] ? this.mapRunRow(rows[0]) : null;
  }

  async updateCase(caseId: string, payload: Partial<PlaygroundCase>): Promise<PlaygroundCase | null> {
    const existing = await this.getCaseById(caseId);
    if (!existing) {
      return null;
    }

    const next = {
      ...existing,
      ...payload,
      traceContext: payload.traceContext || existing.traceContext,
      promptInput: payload.promptInput || existing.promptInput,
      providerConfig: payload.providerConfig || existing.providerConfig,
      baselineSnapshot: payload.baselineSnapshot ?? existing.baselineSnapshot,
      currentPatch: payload.currentPatch ?? existing.currentPatch,
      importFidelity: payload.importFidelity || existing.importFidelity || 'exact',
      baselineOutput: payload.baselineOutput ?? existing.baselineOutput,
      rawEvidence: payload.rawEvidence || existing.rawEvidence,
      tags: payload.tags || existing.tags,
      updatedAt: new Date().toISOString()
    };

    validatePlaygroundPromptInput(next.promptInput);
    validatePlaygroundProviderConfig(next.providerConfig);

    await this.db.executeUpdate(
      `
        UPDATE playground_cases
        SET name = ?, prompt_id = ?, prompt_mode_default = ?, trace_context = ?,
            prompt_input = ?, provider_config = ?, baseline_snapshot = ?, current_patch = ?, import_fidelity = ?,
            baseline_output = ?, raw_evidence = ?,
            tags = ?, notes = ?, is_favorite = ?, updated_at = ?
        WHERE id = ?
      `,
      [
        next.name,
        next.promptId || null,
        next.promptModeDefault,
        stringify(next.traceContext),
        stringify(next.promptInput),
        stringify(next.providerConfig),
        stringify(next.baselineSnapshot || null),
        stringify(next.currentPatch || null),
        next.importFidelity || 'exact',
        stringify(next.baselineOutput || null),
        stringify(next.rawEvidence),
        stringify(next.tags),
        next.notes || null,
        next.isFavorite ? 1 : 0,
        next.updatedAt,
        caseId
      ]
    );

    return this.getCaseById(caseId);
  }

  async createCaseFromTraffic(trafficId: number, promptId?: string | null): Promise<PlaygroundCase> {
    const traffic = await getTrafficLogById(trafficId) as TrafficLogRow | null;
    if (!traffic) {
      throw new Error(`Traffic sample not found: ${trafficId}`);
    }

    const prompt = promptId ? await this.loadPrompt(promptId) : null;
    const llmCall = await this.loadLLMCallForTraffic(traffic);
    const conversation = null as ConversationRow | null;

    const caseMode: PlaygroundCaseMode = llmCall || conversation ? 'contextual' : 'wire';
    const baselineSnapshot = llmCall ? buildBaselineSnapshot(llmCall, traffic.trace_id || null, null) : null;
    const providerConfig = prompt
      ? buildProviderConfigFromPrompt(prompt)
      : baselineSnapshot
        ? buildProviderConfigFromBaselineSnapshot(baselineSnapshot, llmCall?.model_provider || traffic.api_type || null)
        : buildProviderConfigFromTraffic(traffic, llmCall);
    const promptInput = this.buildPromptInput({
      prompt,
      llmCall,
      conversation,
      traffic
    });
    const baselineOutput = this.buildBaselineOutput(traffic, llmCall, conversation);

    const caseRecord: PlaygroundCase = {
      id: crypto.randomUUID(),
      name: `${traffic.api_type || 'AI'} · ${traffic.host}${traffic.path ? ` ${traffic.path}` : ''}`.slice(0, 255),
      source: 'traffic',
      sourceRef: String(traffic.id),
      caseMode,
      traceContext: {
        traceId: traffic.trace_id || llmCall?.trace_id || conversation?.trace_id || null,
        conversationId: traffic.conversation_id || llmCall?.conversation_id || conversation?.id || null,
        llmCallId: traffic.llm_call_id || llmCall?.llm_call_id || null,
        toolCallId: traffic.tool_call_id || null,
        agentTurn: traffic.agent_turn ?? llmCall?.agent_turn ?? null,
        trafficLogId: traffic.id,
        spanId: null
      },
      promptId: prompt?.id || null,
      promptModeDefault: prompt ? 'saved' : 'draft',
      promptInput,
      providerConfig,
      baselineSnapshot,
      currentPatch: null,
      importFidelity: baselineSnapshot?.effectiveUnifiedConfig ? 'exact' : 'partial',
      baselineOutput,
      rawEvidence: {
        traffic,
        llmCall,
        conversation
      },
      tags: [traffic.api_type || 'ai-traffic', caseMode],
      notes: null,
      isFavorite: false,
      createdBy: 'admin',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await this.persistCase(caseRecord);
    const saved = await this.getCaseById(caseRecord.id);
    if (!saved) {
      throw new Error('Failed to persist playground case');
    }
    return saved;
  }

  async createCaseFromSpan(traceId: string, spanId: string, promptId?: string | null): Promise<PlaygroundCase> {
    const existing = await this.findExistingSpanCase(traceId, spanId);
    const llmCall = await this.loadLLMCallForSpan(traceId, spanId);
    if (!llmCall) {
      throw new PlaygroundCompatibilityError(`Span ${spanId} is not a compatible LLM span`);
    }
    if (!llmCall.canonical_request) {
      throw new PlaygroundCompatibilityError(`Span ${spanId} has no canonical LLM request to import into Playground`);
    }
    const baselineSnapshot = buildBaselineSnapshot(llmCall, traceId, spanId);
    if (!baselineSnapshot.effectiveUnifiedConfig) {
      throw new PlaygroundCompatibilityError(`Span ${spanId} is missing effective unified config and cannot be replayed exactly`);
    }

    const conversation = null as ConversationRow | null;
    const providerConfig = buildProviderConfigFromBaselineSnapshot(baselineSnapshot, llmCall.model_provider || null);
    const promptInput = buildPromptInputFromCanonicalRequest(baselineSnapshot.canonicalRequest || {});

    const caseRecord: PlaygroundCase = {
      id: existing?.id || crypto.randomUUID(),
      name: `Span · ${spanId}`.slice(0, 255),
      source: 'span',
      sourceRef: `${traceId}:${spanId}`,
      caseMode: 'contextual',
      traceContext: {
        traceId: llmCall.trace_id || traceId || conversation?.trace_id || null,
        conversationId: conversation?.id || llmCall.conversation_id || null,
        llmCallId: llmCall.llm_call_id || null,
        agentTurn: llmCall.agent_turn ?? null,
        trafficLogId: null,
        spanId
      },
      promptId: null,
      promptModeDefault: 'draft',
      promptInput,
      providerConfig,
      baselineSnapshot,
      currentPatch: null,
      importFidelity: 'exact',
      baselineOutput: this.buildBaselineOutput(null, llmCall, conversation),
      rawEvidence: {
        spanId,
        baselineSnapshot,
        llmCall,
        conversation
      },
      tags: ['span', 'generation'],
      notes: null,
      isFavorite: false,
      createdBy: 'admin',
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (existing) {
      await this.refreshSpanCase(existing.id, caseRecord);
    } else {
      await this.persistCase(caseRecord);
    }
    const saved = await this.getCaseById(caseRecord.id);
    if (!saved) {
      throw new Error('Failed to persist playground case');
    }
    return saved;
  }

  async resolveImportTarget(params: {
    conversationId?: string | null;
    traceId?: string | null;
  }): Promise<PlaygroundImportResolution> {
    const conversationId = params.conversationId || null;
    const traceId = params.traceId || null;
    const exactSpan = await this.findExactImportableSpan(traceId, conversationId);
    if (exactSpan) {
      return {
        importable: true,
        sourceType: 'span',
        reasonCode: 'exact_span_available',
        reasonMessage: 'Found exact replay span for Playground import',
        traceId: exactSpan.trace_id || traceId,
        conversationId: exactSpan.conversation_id || conversationId,
        spanId: this.buildSpanIdForLlmCall(exactSpan),
        trafficId: null
      };
    }

    const traffic = await this.findTrafficFallback(traceId, conversationId);
    if (traffic) {
      return {
        importable: true,
        sourceType: 'traffic',
        reasonCode: 'traffic_fallback_available',
        reasonMessage: 'Falling back to AI traffic sample for Playground import',
        traceId: traffic.trace_id || traceId,
        conversationId: traffic.conversation_id || conversationId,
        spanId: null,
        trafficId: traffic.id
      };
    }

    return {
      importable: false,
      sourceType: 'none',
      reasonCode: 'no_viable_source',
      reasonMessage: 'No viable Playground import source found',
      traceId,
      conversationId,
      spanId: null,
      trafficId: null
    };
  }

  private async findExistingSpanCase(traceId: string, spanId: string): Promise<PlaygroundCase | null> {
    const caseIds = await this.db.executeQuery<{ id: string }>(
      `
        SELECT id
        FROM playground_cases
        WHERE source = 'span'
          AND source_ref = ?
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `,
      [`${traceId}:${spanId}`]
    );

    return caseIds[0] ? this.getCaseById(caseIds[0].id) : null;
  }

  private buildSpanIdForLlmCall(call: LLMCallRow): string | null {
    if (call.llm_call_id) {
      return `llm-call:${call.llm_call_id}`;
    }
    if (call.id != null) {
      return `llm:${call.id}`;
    }
    return null;
  }

  private async findExactImportableSpan(
    traceId?: string | null,
    conversationId?: string | null
  ): Promise<LLMCallRow | null> {
    const tableName = await this.resolveLlmCallTableName();
    if (!tableName) {
      return null;
    }

    const clauses: string[] = [];
    const params: Array<string> = [];

    if (traceId) {
      clauses.push('trace_id = ?');
      params.push(traceId);
    }

    if (conversationId) {
      clauses.push('conversation_id = ?');
      params.push(conversationId);
    }

    if (clauses.length === 0) {
      return null;
    }

    const rows = await this.db.executeQuery<LLMCallRow>(
      `
        SELECT ${this.llmRequestSliceSelectColumns()}
        FROM ${tableName}
        WHERE canonical_request IS NOT NULL
          AND (${clauses.join(' OR ')})
        ORDER BY started_at ASC, id ASC
        LIMIT 1
      `,
      params
    );

    return rows[0] || null;
  }

  private async findTrafficFallback(
    traceId?: string | null,
    conversationId?: string | null
  ): Promise<TrafficLogRow | null> {
    const clauses: string[] = [];
    const params: Array<string> = [];

    if (traceId) {
      clauses.push('trace_id = ?');
      params.push(traceId);
    }

    if (conversationId) {
      clauses.push('conversation_id = ?');
      params.push(conversationId);
    }

    if (clauses.length === 0) {
      return null;
    }

    const rows = await this.db.executeQuery<TrafficLogRow>(
      `
        SELECT id, trace_id, llm_call_id, tool_call_id, agent_turn, method, url, host, path,
               request_headers, request_body, response_body, response_status, request_timestamp, duration_ms,
               api_type, service_name
        FROM http_traffic_logs
        WHERE is_ai_request = TRUE
          AND (${clauses.join(' OR ')})
        ORDER BY request_timestamp ASC, id ASC
        LIMIT 1
      `,
      params
    );

    return rows[0] || null;
  }

  private async persistCase(caseRecord: PlaygroundCase): Promise<void> {
    await this.db.executeInsert(
      `
        INSERT INTO playground_cases (
          id, name, source, source_ref, case_mode, trace_context, prompt_id, prompt_mode_default,
          prompt_input, provider_config, baseline_snapshot, current_patch, import_fidelity,
          baseline_output, raw_evidence, tags, notes,
          is_favorite, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        caseRecord.id,
        caseRecord.name,
        caseRecord.source,
        caseRecord.sourceRef,
        caseRecord.caseMode,
        stringify(caseRecord.traceContext),
        caseRecord.promptId || null,
        caseRecord.promptModeDefault,
        stringify(caseRecord.promptInput),
        stringify(caseRecord.providerConfig),
        stringify(caseRecord.baselineSnapshot || null),
        stringify(caseRecord.currentPatch || null),
        caseRecord.importFidelity || 'exact',
        stringify(caseRecord.baselineOutput || null),
        stringify(caseRecord.rawEvidence),
        stringify(caseRecord.tags),
        caseRecord.notes || null,
        caseRecord.isFavorite ? 1 : 0,
        caseRecord.createdBy
      ]
    );
  }

  private async refreshSpanCase(caseId: string, caseRecord: PlaygroundCase): Promise<void> {
    await this.db.executeUpdate(
      `
        UPDATE playground_cases
        SET name = ?, source = ?, source_ref = ?, case_mode = ?, trace_context = ?, prompt_id = ?, prompt_mode_default = ?,
            prompt_input = ?, provider_config = ?, baseline_snapshot = ?, current_patch = ?, import_fidelity = ?,
            baseline_output = ?, raw_evidence = ?, tags = ?, notes = ?, is_favorite = ?, created_by = ?, updated_at = ?
        WHERE id = ?
      `,
      [
        caseRecord.name,
        caseRecord.source,
        caseRecord.sourceRef,
        caseRecord.caseMode,
        stringify(caseRecord.traceContext),
        caseRecord.promptId || null,
        caseRecord.promptModeDefault,
        stringify(caseRecord.promptInput),
        stringify(caseRecord.providerConfig),
        stringify(caseRecord.baselineSnapshot || null),
        stringify(caseRecord.currentPatch || null),
        caseRecord.importFidelity || 'exact',
        stringify(caseRecord.baselineOutput || null),
        stringify(caseRecord.rawEvidence),
        stringify(caseRecord.tags),
        caseRecord.notes || null,
        caseRecord.isFavorite ? 1 : 0,
        caseRecord.createdBy,
        caseRecord.updatedAt,
        caseId
      ]
    );
  }

  private buildPromptInput(params: {
    prompt: PromptRecord | null;
    llmCall: LLMCallRow | null;
    conversation: ConversationRow | null;
    traffic: TrafficLogRow | null;
  }): PlaygroundPromptInput {
    const promptContextVariables = parseJsonField<Record<string, unknown>>(params.prompt?.context_variables, {});

    if (params.prompt) {
      const systemInstruction = applyContextVariables(
        parseSystemInstructions(params.prompt.system_instructions),
        promptContextVariables,
        {
          conversation_id: params.conversation?.id || params.traffic?.conversation_id || null,
          trace_id: params.conversation?.trace_id || params.traffic?.trace_id || null
        }
      );

      const baseMessages: PlaygroundMessage[] = params.llmCall
        ? buildPromptInputFromCanonicalRequest(
            parseJsonField<Record<string, unknown>>(params.llmCall.canonical_request, {})
          ).messages.filter((message) => message.role !== 'system')
        : params.conversation?.user_message
          ? [{ role: 'user', content: params.conversation.user_message }]
          : params.traffic
            ? extractMessagesFromGeminiContents(
                parseJsonField<Record<string, unknown>>(params.traffic.request_body, {}).contents
              ).filter((message) => message.role !== 'system')
            : [];

      return {
        systemInstruction,
        messages: normalizePromptMessages(baseMessages),
        contextVariables: promptContextVariables
      };
    }

    if (params.llmCall) {
      return buildPromptInputFromCanonicalRequest(
        parseJsonField<Record<string, unknown>>(params.llmCall.canonical_request, {})
      );
    }

    if (params.traffic) {
      const requestBody = parseJsonField<Record<string, unknown>>(params.traffic.request_body, {});
      return {
        systemInstruction: typeof requestBody.system_instruction === 'object'
          ? extractTextResponse(requestBody.system_instruction)
          : '',
        messages: extractMessagesFromGeminiContents(requestBody.contents),
        contextVariables: {}
      };
    }

    return {
      systemInstruction: '',
      messages: params.conversation?.user_message
        ? [{ role: 'user', content: params.conversation.user_message }]
        : [],
      contextVariables: {}
    };
  }

  private buildBaselineOutput(
    traffic: TrafficLogRow | null,
    llmCall: LLMCallRow | null,
    conversation: ConversationRow | null
  ): PlaygroundBaselineOutput | null {
    if (llmCall) {
      return {
        sourceKind: 'llm_call',
        responseText: buildPlaygroundResponseTextFallback({
          processedResponse: llmCall.processed_response,
          canonicalResponse: llmCall.canonical_response,
          wireResponse: llmCall.wire_response
        }),
        provider: llmCall.model_provider || undefined,
        modelName: llmCall.model_name || undefined,
        usage: {
          inputTokens: llmCall.input_tokens || 0,
          outputTokens: llmCall.output_tokens || 0
        },
        canonicalRequest: parseJsonField(llmCall.canonical_request, null),
        canonicalResponse: parseJsonField(llmCall.canonical_response, null),
        wireRequest: parseJsonField(llmCall.wire_request, null),
        wireResponse: parseJsonField(llmCall.wire_response, null),
        metadata: {
          status: llmCall.status || null,
          processingTimeMs: llmCall.processing_time_ms || null,
          apiCallTimeMs: llmCall.api_call_time_ms || null
        }
      };
    }

    if (conversation?.ai_response) {
      return {
        sourceKind: 'conversation',
        responseText: conversation.ai_response,
        modelName: conversation.model_name || undefined,
        metadata: {
          status: conversation.status || null,
          responseTime: conversation.response_time || null
        }
      };
    }

    if (traffic?.response_body) {
      return {
        sourceKind: 'traffic',
        responseText: extractTextResponse(traffic.response_body),
        provider: traffic.api_type || undefined,
        metadata: {
          statusCode: traffic.response_status || null,
          durationMs: traffic.duration_ms || null
        },
        rawResponse: parseJsonField(traffic.response_body, traffic.response_body)
      };
    }

    return null;
  }

  private async loadPrompt(promptId: string): Promise<PromptRecord | null> {
    const rows = await this.db.executeQuery<PromptRecord>(
      `
        SELECT id, prompt_name, system_instructions, user_prompt_template,
               context_variables, model_config, advanced_config, model_name
        FROM agent_prompts
        WHERE id = ?
      `,
      [promptId]
    );

    return rows[0] || null;
  }

  private llmCallStartedAtValue(row: LLMCallRow | null): number {
    if (!row) {
      return Number.POSITIVE_INFINITY;
    }

    const startedAt = row.started_at || row.completed_at || null;
    if (!startedAt) {
      return Number.POSITIVE_INFINITY;
    }

    const value = new Date(startedAt).getTime();
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  }

  private pickEarliestLlmCall(candidates: Array<LLMCallRow | null>): LLMCallRow | null {
    const rows = candidates
      .filter((candidate): candidate is LLMCallRow => Boolean(candidate))
      .filter((candidate, index, list) => {
        const key = candidate.id != null ? `id:${candidate.id}` : `llm:${candidate.llm_call_id || ''}`;
        return list.findIndex((row) => (row.id != null ? `id:${row.id}` : `llm:${row.llm_call_id || ''}`) === key) === index;
      });

    if (rows.length === 0) {
      return null;
    }

    rows.sort((left, right) => {
      const startedDiff = this.llmCallStartedAtValue(left) - this.llmCallStartedAtValue(right);
      if (startedDiff !== 0) {
        return startedDiff;
      }
      return (left.id || 0) - (right.id || 0);
    });

    return rows[0] || null;
  }

  private async loadLLMCallForTraffic(traffic: TrafficLogRow): Promise<LLMCallRow | null> {
    const tableName = await this.resolveLlmCallTableName();
    if (!tableName) {
      return null;
    }

    const [byCallId, byTraceId, byConversationId] = await Promise.all([
      traffic.llm_call_id
        ? this.db.executeQuery<LLMCallRow>(
            `
              SELECT ${this.llmRequestSliceSelectColumns()}
              FROM ${tableName}
              WHERE llm_call_id = ?
              ORDER BY started_at ASC, id ASC
              LIMIT 1
            `,
            [traffic.llm_call_id]
          )
        : Promise.resolve([]),
      traffic.trace_id
        ? this.db.executeQuery<LLMCallRow>(
            `
              SELECT ${this.llmRequestSliceSelectColumns()}
              FROM ${tableName}
              WHERE trace_id = ?
              ORDER BY started_at ASC, id ASC
              LIMIT 1
            `,
            [traffic.trace_id]
          )
        : Promise.resolve([]),
      traffic.conversation_id
        ? this.db.executeQuery<LLMCallRow>(
            `
              SELECT ${this.llmRequestSliceSelectColumns()}
              FROM ${tableName}
              WHERE conversation_id = ?
              ORDER BY started_at ASC, id ASC
              LIMIT 1
            `,
            [traffic.conversation_id]
          )
        : Promise.resolve([])
    ]);

    return this.pickEarliestLlmCall([byCallId[0] || null, byTraceId[0] || null, byConversationId[0] || null]);
  }

  private async loadLLMCallForSpan(traceId: string, spanId: string): Promise<LLMCallRow | null> {
    const tableName = await this.resolveLlmCallTableName();
    if (!tableName) {
      return null;
    }

    if (spanId.startsWith('llm-call:')) {
      const llmCallId = spanId.slice('llm-call:'.length).trim();
      if (!llmCallId) {
        return null;
      }

      const rows = await this.db.executeQuery<LLMCallRow>(
        `
          SELECT ${this.llmRequestSliceSelectColumns()}
          FROM ${tableName}
          WHERE llm_call_id = ?
          ORDER BY started_at ASC, id ASC
          LIMIT 1
        `,
        [llmCallId]
      );

      return rows[0] || null;
    }

    if (spanId.startsWith('llm:')) {
      const legacyId = Number(spanId.slice('llm:'.length).trim());
      if (!Number.isFinite(legacyId)) {
        return null;
      }

      const rows = await this.db.executeQuery<LLMCallRow>(
        `
          SELECT ${this.llmRequestSliceSelectColumns()}
          FROM ${tableName}
          WHERE id = ?
          LIMIT 1
        `,
        [legacyId]
      );

      return rows[0] || null;
    }

    return null;
  }

  private llmRequestSliceSelectColumns(): string {
    return `
      id,
      trace_id,
      conversation_id,
      llm_call_id,
      agent_turn,
      model_provider,
      model_name,
      NULL::text AS prompt_template,
      canonical_request,
      canonical_response,
      wire_request,
      wire_response,
      NULL::jsonb AS effective_unified_config,
      request_format_version,
      wire_provider_format,
      COALESCE(CAST(canonical_response AS text), CAST(raw_response AS text), CAST(output_items AS text), '') AS processed_response,
      COALESCE((token_usage::jsonb->>'input_tokens')::int, (token_usage::jsonb->>'prompt_tokens')::int, 0) AS input_tokens,
      COALESCE((token_usage::jsonb->>'output_tokens')::int, (token_usage::jsonb->>'completion_tokens')::int, 0) AS output_tokens,
      NULL::numeric AS api_call_time_ms,
      processing_time_ms,
      created_at AS started_at,
      completed_at,
      status
    `;
  }

  private async resolveLlmCallTableName(): Promise<'llm_request_slices' | null> {
    if (this.llmCallTableName !== undefined) {
      return this.llmCallTableName;
    }

    const rows = await this.db.executeQuery<{ table_name: 'llm_request_slices' }>(
      `
        SELECT TABLE_NAME
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = current_schema()
          AND TABLE_NAME = 'llm_request_slices'
        LIMIT 1
      `
    );

    this.llmCallTableName = rows[0]?.table_name || null;
    if (!this.llmCallTableName) {
      this.logger.warn('No LLM call table found for playground case builder', {
        checkedTables: ['llm_request_slices']
      });
    }

    return this.llmCallTableName;
  }

  private mapCaseRow(row: PlaygroundCaseRow): PlaygroundCase {
    return {
      id: row.id,
      name: row.name,
      source: row.source,
      sourceRef: row.source_ref,
      caseMode: row.case_mode,
      traceContext: parseJsonField(row.trace_context, {}),
      promptId: row.prompt_id || null,
      promptModeDefault: row.prompt_mode_default,
      promptInput: parseJsonField<PlaygroundPromptInput>(row.prompt_input, {
        systemInstruction: '',
        messages: [],
        contextVariables: {}
      }),
      providerConfig: normalizePlaygroundProviderConfig(row.provider_config),
      baselineSnapshot: parseJsonField<PlaygroundBaselineSnapshot | null>(row.baseline_snapshot, null),
      currentPatch: parseJsonField<PlaygroundRequestPatch | null>(row.current_patch, null),
      importFidelity: row.import_fidelity || 'exact',
      baselineOutput: parseJsonField<PlaygroundBaselineOutput | null>(row.baseline_output, null),
      rawEvidence: parseJsonField<Record<string, unknown>>(row.raw_evidence, {}),
      tags: parseJsonField<string[]>(row.tags, []),
      notes: row.notes || null,
      isFavorite: Boolean(row.is_favorite),
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapRunRow(row: PlaygroundRunRow): PlaygroundRun {
    return {
      id: row.id,
      caseId: row.case_id,
      executionMode: row.execution_mode || 'exact_replay',
      promptMode: row.prompt_mode,
      promptId: row.prompt_id || null,
      promptSnapshot: parseJsonField<Record<string, unknown> | null>(row.prompt_snapshot, null),
      providerConfigSnapshot: normalizePlaygroundProviderConfig(row.provider_config_snapshot),
      inputSnapshot: parseJsonField<PlaygroundPromptInput>(row.input_snapshot, {
        systemInstruction: '',
        messages: [],
        contextVariables: {}
      }),
      baselineSnapshot: parseJsonField<PlaygroundBaselineSnapshot | null>(row.baseline_snapshot, null),
      requestPatch: parseJsonField<PlaygroundRequestPatch | null>(row.request_patch, null),
      effectiveRequest: parseJsonField<Record<string, unknown> | null>(row.effective_request, null),
      effectiveConfig: parseJsonField<Record<string, unknown> | null>(row.effective_config, null),
      outputSnapshot: parseJsonField<Record<string, unknown> | null>(row.output_snapshot, null),
      comparisonSnapshot: parseJsonField<Record<string, unknown> | null>(row.comparison_snapshot, null),
      diffSnapshot: parseJsonField<Record<string, unknown> | null>(row.diff_snapshot, null),
      modelName: row.model_name || null,
      provider: row.provider || null,
      status: row.status,
      executedBy: row.executed_by,
      createdAt: row.created_at
    };
  }
}
