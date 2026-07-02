import fs from 'fs';
import path from 'path';
import winston from 'winston';
import {
  getTrafficLogById,
  listRuntimeIdentityActivationTraces,
  listIdentityEvidenceRefs,
  listTraceTrafficLogs,
  listAgentStackItems,
  listLlmRequestSlices,
  listCodexProviderUsageEvents,
  listToolExecutions,
  getAgentTaskById,
  parseInstantValue,
  serializeTimestampForApi
} from '@qq-bot/persistence';
import { DatabaseManager } from './database';

type TraceConfidence = 'observed' | 'derived' | 'missing';

interface TraceSpanEventDto {
  id: string;
  name: string;
  timestamp: string | null;
  attributes: Record<string, unknown>;
}

interface TraceSpanLinkDto {
  id: string;
  linked_trace_id: string | null;
  linked_span_id: string | null;
  attributes: Record<string, unknown>;
}

interface TraceSpanDto {
  span_id: string;
  parent_span_id: string | null;
  trace_id: string;
  conversation_id: string | null;
  name: string;
  kind: 'internal' | 'client' | 'server' | 'producer' | 'consumer';
  status_code: 'unset' | 'ok' | 'error';
  status_message: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  depth: number;
  sort_key: string;
  summary: string;
  attributes: Record<string, unknown>;
  input: unknown;
  output: unknown;
  evidence: unknown;
  events: TraceSpanEventDto[];
  links: TraceSpanLinkDto[];
  confidence: TraceConfidence;
  source_ref: string | number | null;
}

interface TracePayloadTrimOptions {
  truncateLargeFields?: boolean;
  includeRawWireText?: boolean;
}

interface TraceSpanDetailDto {
  input: unknown;
  output: unknown;
  evidence: unknown;
}

interface RawTraceExchangeSideDto {
  headers: Record<string, unknown> | null;
  body: string | null;
  bytes: number;
  body_format: string;
  body_source: string;
}

interface RawTraceRequestDto extends RawTraceExchangeSideDto {
  method: string;
  upstream_url: string | null;
}

interface RawTraceResponseDto extends RawTraceExchangeSideDto {
  status_code: number | null;
  status_text: string | null;
  error_message: string | null;
}

interface RawProviderTraceDto {
  span_id: string | null;
  trace_id: string | null;
  conversation_id: string | null;
  slice_id: string | null;
  llm_call_id: string | null;
  source: string;
  model_name: string | null;
  model_provider: string | null;
  request_format_version: string | null;
  wire_provider_format: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  request: RawTraceRequestDto;
  response: RawTraceResponseDto;
}

interface StackTraceTarget {
  conversationId?: string | null;
  traceId?: string | null;
  internalExecutionLeaseId?: string | null;
  spanId?: string | null;
  llmRequestSliceId?: string | null;
  toolCallId?: string | null;
  stackItemId?: string | null;
  sourceKind?: string | null;
  forkRunId?: string | null;
}

const TRACE_PAYLOAD_MAX_INLINE_BYTES = 16 * 1024;

function estimateJsonBytes(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8');
  }
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch (_error) {
    return Buffer.byteLength(String(value), 'utf8');
  }
}

function buildDeferredPayload(value: unknown, label: string) {
  return {
    __trace_payload_truncated: true,
    label,
    bytes: estimateJsonBytes(value),
    preview: safePreview(value, 640)
  };
}

function maybeTrimLargeField(value: unknown, label: string, options?: TracePayloadTrimOptions) {
  if (!options?.truncateLargeFields) {
    return value;
  }
  return estimateJsonBytes(value) > TRACE_PAYLOAD_MAX_INLINE_BYTES
    ? buildDeferredPayload(value, label)
    : value;
}

function parseJsonField<T>(value: any, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (_error) {
      return fallback;
    }
  }
  if (typeof value === 'object') {
    return value as T;
  }
  return fallback;
}

function rawJsonText(value: any, fallback: string | null = null): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return fallback;
  }
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function inferRawTextFormat(value: string | null): string {
  if (!value) {
    return 'empty';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return 'empty';
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return 'json';
  }
  if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    return 'sse';
  }
  return 'text';
}

function normalizeIdentityEvidenceRef(row: any) {
  return {
    ...row,
    id: toNumber(row?.id) ?? row?.id,
    identity_event_id: toNumber(row?.identity_event_id) ?? row?.identity_event_id ?? null,
    change_candidate_id: toNumber(row?.change_candidate_id) ?? row?.change_candidate_id ?? null,
    accepted_fact_id: toNumber(row?.accepted_fact_id) ?? row?.accepted_fact_id ?? null,
    conversation_id: toNumber(row?.conversation_id) ?? row?.conversation_id ?? null,
    metadata: parseJsonField<Record<string, unknown> | null>(row?.metadata, null),
    created_at: toIsoString(row?.created_at)
  };
}

function normalizeRuntimeIdentityActivationTrace(row: any) {
  return {
    ...row,
    id: toNumber(row?.id) ?? row?.id,
    conversation_id: toNumber(row?.conversation_id) ?? row?.conversation_id ?? null,
    activated_refs: parseJsonField<unknown[]>(row?.activated_refs, []),
    suppressed_refs: parseJsonField<unknown[]>(row?.suppressed_refs, []),
    metadata: parseJsonField<Record<string, unknown> | null>(row?.metadata, null),
    created_at: toIsoString(row?.created_at)
  };
}

function toNumber(value: any): number | null {
  const numericValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function toIsoString(value: any): string | null {
  return serializeTimestampForApi(value) as string | null;
}

function extractCachedInputTokens(tokenUsage: any): number {
  const usage = tokenUsage && typeof tokenUsage === 'object' ? tokenUsage : {};
  return toNumber(
    usage.cached_input_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? usage.raw_usage?.input_tokens_details?.cached_tokens
    ?? usage.raw_usage?.prompt_tokens_details?.cached_tokens
  ) ?? 0;
}

function toMillis(value: any): number | null {
  const parsed = parseInstantValue(value);
  return parsed ? parsed.getTime() : null;
}

function getDurationMs(startAt?: any, endAt?: any, fallback?: any): number | null {
  const start = toMillis(startAt);
  const end = toMillis(endAt);
  if (start !== null && end !== null) {
    return Math.max(0, end - start);
  }
  const fallbackValue = toNumber(fallback);
  return fallbackValue !== null ? Math.max(0, fallbackValue) : null;
}

function compareTimes(left: any, right: any, leftFallback = 0, rightFallback = 0): number {
  const leftTime = toMillis(left) ?? leftFallback;
  const rightTime = toMillis(right) ?? rightFallback;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return 0;
}

function safePreview(value: unknown, maxLength = 140): string {
  if (value === null || value === undefined || value === '') {
    return 'No summary available';
  }

  const raw =
    typeof value === 'string'
      ? value
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);

  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return 'No summary available';
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function extractRuntimeGuidanceFromCanonicalRequest(request: any): string | null {
  const inputItems = Array.isArray(request?.input) ? request.input : [];
  for (const item of inputItems) {
    if (item?.type !== 'message' || typeof item.content !== 'string') {
      continue;
    }
    const content = item.content.trim();
    if (content.startsWith('Runtime guidance:')) {
      return content;
    }
  }
  return null;
}

function enrichCanonicalRequest(request: any) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return request;
  }

  const runtimeGuidance = extractRuntimeGuidanceFromCanonicalRequest(request);
  const instructions = typeof request.instructions === 'string' ? request.instructions.trim() : '';
  const effectiveInstructions = runtimeGuidance
    ? [instructions, runtimeGuidance].filter(Boolean).join('\n\n')
    : instructions || null;

  return {
    ...request,
    runtime_guidance: runtimeGuidance,
    effective_instructions: effectiveInstructions
  };
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function extractSseFinalResponse(responseBody: string | null): {
  body: unknown;
  raw_body: string | null;
  body_format: 'json' | 'text';
  body_source: 'sse_complete' | 'raw';
} {
  if (!responseBody || typeof responseBody !== 'string') {
    return {
      body: responseBody,
      raw_body: responseBody,
      body_format: 'text',
      body_source: 'raw',
    };
  }

  const rawBody = responseBody;
  const trimmedBody = responseBody.trim();
  const parsedJsonBody = tryParseJson(trimmedBody);
  if (parsedJsonBody !== null) {
    return {
      body: parsedJsonBody,
      raw_body: rawBody,
      body_format: 'json',
      body_source: 'raw',
    };
  }

  if (!/^event:\s/m.test(responseBody) && !/^data:\s/m.test(responseBody)) {
    return {
      body: responseBody,
      raw_body: rawBody,
      body_format: 'text',
      body_source: 'raw',
    };
  }

  let completedResponse: unknown = null;
  const blocks = responseBody.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line.length > 0 && line !== '[DONE]');
    for (const line of dataLines) {
      const parsed = tryParseJson(line);
      if (!parsed || typeof parsed !== 'object') {
        continue;
      }
      const event = parsed as Record<string, unknown>;
      const type = typeof event.type === 'string' ? event.type : '';
      if (
        (type === 'response.done' || type === 'response.completed' || type === 'response.incomplete')
        && event.response
      ) {
        completedResponse = event.response;
      }
    }
  }

  if (completedResponse !== null) {
    return {
      body: completedResponse,
      raw_body: rawBody,
      body_format: 'json',
      body_source: 'sse_complete',
    };
  }

  return {
    body: responseBody,
    raw_body: rawBody,
    body_format: 'text',
    body_source: 'raw',
  };
}

function normalizeStatusCode(value: any): 'unset' | 'ok' | 'error' {
  const normalized = (value ?? '').toString().trim().toLowerCase();
  if (!normalized) {
    return 'unset';
  }
  if (['success', 'completed', 'sent', 'ok'].includes(normalized)) {
    return 'ok';
  }
  if (['failed', 'error', 'timeout', 'cancelled'].includes(normalized)) {
    return 'error';
  }
  return 'unset';
}

function normalizeLlmCall(call: any, options?: TracePayloadTrimOptions) {
  const tokenUsage = parseJsonField<any>(call.token_usage, {});
  const effectiveUnifiedConfig = parseJsonField<any>(call.effective_unified_config, null);
  const canonicalRequest = enrichCanonicalRequest(parseJsonField<any>(call.canonical_request, null));
  const wireRequest = parseJsonField<any>(call.wire_request, null);
  const canonicalResponse = parseJsonField<any>(call.canonical_response, null);
  const wireResponse = parseJsonField<any>(call.wire_response, null);
  const rawResponse = parseJsonField<any>(call.raw_response, null);
  const normalized: any = {
    id: call.id,
    llm_call_id: call.llm_call_id || null,
    trace_id: call.trace_id,
    conversation_id: call.conversation_id || null,
    agent_turn: toNumber(call.agent_turn),
    call_sequence: toNumber(call.call_sequence) || 0,
    started_at: toIsoString(call.started_at || (call.timestamp && call.api_call_time_ms
      ? new Date(new Date(call.timestamp).getTime() - Number(call.api_call_time_ms))
      : null) || call.timestamp),
    completed_at: toIsoString(call.completed_at || call.timestamp),
    duration_ms: getDurationMs(call.started_at, call.completed_at || call.timestamp, call.api_call_time_ms || call.processing_time_ms),
    status: normalizeStatusCode(call.status),
    model_name: call.model_name,
    model_provider: call.model_provider,
    agent_type: call.agent_type,
    prompt_template: call.prompt_template,
    canonical_request: maybeTrimLargeField(canonicalRequest, 'canonical_request', options),
    wire_request: maybeTrimLargeField(wireRequest, 'wire_request', options),
    canonical_response: maybeTrimLargeField(canonicalResponse, 'canonical_response', options),
    wire_response: maybeTrimLargeField(wireResponse, 'wire_response', options),
    raw_response: maybeTrimLargeField(rawResponse, 'raw_response', options),
    effective_unified_config: maybeTrimLargeField(effectiveUnifiedConfig, 'effective_unified_config', options),
    processed_response: maybeTrimLargeField(call.processed_response || null, 'processed_response', options),
    input_tokens: toNumber(call.input_tokens),
    output_tokens: toNumber(call.output_tokens),
    token_usage: tokenUsage,
    api_call_time_ms: toNumber(call.api_call_time_ms),
    processing_time_ms: toNumber(call.processing_time_ms),
    error_message: call.error_message || null,
    error_code: call.error_code || null,
    request_format_version: call.request_format_version || null,
    wire_provider_format: call.wire_provider_format || null,
    http_requests: [] as any[],
    provider_requests: [] as any[]
  };
  if (options?.includeRawWireText) {
    normalized.wire_request_raw_text = rawJsonText(call.wire_request_raw_text, rawJsonText(call.wire_request));
    normalized.wire_response_raw_text = rawJsonText(
      call.wire_response_raw_text,
      rawJsonText(rawResponse, rawJsonText(call.wire_response))
    );
  }
  return normalized;
}

function normalizeStackLlmSlice(slice: any, options?: TracePayloadTrimOptions) {
  const canonicalRequest = enrichCanonicalRequest(parseJsonField<any>(slice.canonicalRequest ?? slice.canonical_request, null));
  const wireRequest = parseJsonField<any>(slice.wireRequest ?? slice.wire_request, null);
  const canonicalResponse = parseJsonField<any>(slice.canonicalResponse ?? slice.canonical_response, null);
  const wireResponse = parseJsonField<any>(slice.wireResponse ?? slice.wire_response, null);
  const rawResponse = parseJsonField<any>(slice.rawResponse ?? slice.raw_response, null);
  const tokenUsage = parseJsonField<any>(slice.tokenUsage ?? slice.token_usage, {});
  const outputItems = parseJsonField<any[]>(slice.outputItems ?? slice.output_items, []);
  const startedAt = toIsoString(slice.createdAt ?? slice.created_at);
  const completedAt = toIsoString(slice.completedAt ?? slice.completed_at ?? slice.updatedAt ?? slice.updated_at);
  return {
    id: slice.id ?? null,
    slice_id: slice.sliceId ?? slice.slice_id,
    llm_call_id: slice.llmCallId ?? slice.llm_call_id ?? null,
    trace_id: slice.traceId ?? slice.trace_id ?? null,
    run_id: slice.runId ?? slice.run_id ?? null,
    conversation_id: slice.conversationId ?? slice.conversation_id ?? null,
    agent_turn: toNumber(slice.agentTurn ?? slice.agent_turn),
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: getDurationMs(startedAt, completedAt, slice.processingTimeMs ?? slice.processing_time_ms),
    status: normalizeStatusCode(slice.status),
    model_name: slice.modelName ?? slice.model_name ?? null,
    model_provider: slice.modelProvider ?? slice.model_provider ?? null,
    canonical_request: maybeTrimLargeField(canonicalRequest, 'canonical_request', options),
    wire_request: maybeTrimLargeField(wireRequest, 'wire_request', options),
    canonical_response: maybeTrimLargeField(canonicalResponse, 'canonical_response', options),
    wire_response: maybeTrimLargeField(wireResponse, 'wire_response', options),
    raw_response: maybeTrimLargeField(rawResponse, 'raw_response', options),
    output_items: maybeTrimLargeField(outputItems, 'output_items', options),
    token_usage: tokenUsage,
    input_start_index: toNumber(slice.inputStartIndex ?? slice.input_start_index),
    input_end_index: toNumber(slice.inputEndIndex ?? slice.input_end_index),
    output_start_index: toNumber(slice.outputStartIndex ?? slice.output_start_index),
    output_end_index: toNumber(slice.outputEndIndex ?? slice.output_end_index),
    input_tokens: toNumber(tokenUsage.input_tokens),
    output_tokens: toNumber(tokenUsage.output_tokens),
    request_format_version: slice.requestFormatVersion ?? slice.request_format_version ?? null,
    wire_provider_format: slice.wireProviderFormat ?? slice.wire_provider_format ?? null,
    metadata: parseJsonField<any>(slice.metadata, {}),
    ...(options?.includeRawWireText
      ? {
          wire_request_raw_text: rawJsonText(slice.wireRequest ?? slice.wire_request),
          wire_response_raw_text: rawJsonText(rawResponse, rawJsonText(slice.wireResponse ?? slice.wire_response))
        }
      : {})
  };
}

function normalizeStackToolExecution(row: any) {
  const startedAt = toIsoString(row.startedAt ?? row.started_at ?? row.createdAt ?? row.created_at);
  const completedAt = toIsoString(row.completedAt ?? row.completed_at ?? row.updatedAt ?? row.updated_at);
  return {
    id: row.id ?? null,
    execution_id: row.executionId ?? row.execution_id ?? null,
    llm_request_slice_id: row.llmRequestSliceId ?? row.llm_request_slice_id ?? null,
    llm_call_id: row.llmCallId ?? row.llm_call_id ?? null,
    tool_call_id: row.toolCallId ?? row.tool_call_id ?? null,
    tool_name: row.toolName ?? row.tool_name ?? null,
    arguments: parseJsonField<any>(row.arguments, {}),
    raw_arguments: row.rawArguments ?? row.raw_arguments ?? null,
    result: parseJsonField<any>(row.result, {}),
    status: normalizeStatusCode(row.status),
    error_message: row.errorMessage ?? row.error_message ?? null,
    side_effect: Boolean(row.sideEffect ?? row.side_effect),
    trace_id: row.traceId ?? row.trace_id ?? null,
    run_id: row.runId ?? row.run_id ?? null,
    conversation_id: row.conversationId ?? row.conversation_id ?? null,
    agent_turn: toNumber(row.agentTurn ?? row.agent_turn),
    stack_call_item_id: row.stackCallItemId ?? row.stack_call_item_id ?? null,
    stack_output_item_id: row.stackOutputItemId ?? row.stack_output_item_id ?? null,
    metadata: parseJsonField<any>(row.metadata, {}),
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: getDurationMs(startedAt, completedAt)
  };
}

function buildPlaygroundCapability(call: any): 'exact' | 'unsupported' {
  return call.canonical_request && call.effective_unified_config ? 'exact' : 'unsupported';
}

function buildPlaygroundSnapshot(call: any, spanId: string) {
  return {
    traceId: call.trace_id || null,
    conversationId: call.conversation_id || null,
    llmCallId: call.llm_call_id || null,
    spanId,
    agentTurn: call.agent_turn ?? null,
    provider: call.model_provider || null,
    modelName: call.model_name || null,
    canonicalRequest: call.canonical_request,
    canonicalResponse: call.canonical_response,
    wireRequest: call.wire_request,
    wireResponse: call.wire_response,
    requestFormatVersion: call.request_format_version || null,
    wireProviderFormat: call.wire_provider_format || null,
    effectiveUnifiedConfig: call.effective_unified_config || null
  };
}

function buildSyntheticProviderRequestSpanId(call: any): string {
  if (call.llm_call_id) {
    return `provider-request:wire:${call.llm_call_id}`;
  }
  const sliceId = typeof call.slice_id === 'string' && call.slice_id.trim()
    ? call.slice_id.trim()
    : String(call.id || 'unknown');
  return `provider-request:slice:${encodeURIComponent(sliceId)}`;
}

function parseSyntheticProviderRequestSpanId(spanId: string): { llmCallId: string | null; sliceId: string | null } | null {
  if (spanId.startsWith('provider-request:wire:')) {
    const rawId = spanId.slice('provider-request:wire:'.length);
    return rawId ? { llmCallId: rawId, sliceId: null } : null;
  }

  if (spanId.startsWith('provider-request:slice:')) {
    const rawId = spanId.slice('provider-request:slice:'.length);
    if (!rawId) {
      return null;
    }
    try {
      return { llmCallId: null, sliceId: decodeURIComponent(rawId) };
    } catch {
      return { llmCallId: null, sliceId: rawId };
    }
  }

  return null;
}

function syntheticProviderHost(call: any): string {
  if (call.model_provider === 'codex') {
    return 'CLIProxyAPI';
  }
  return call.model_provider || 'provider';
}

function syntheticProviderPath(call: any): string {
  const format = typeof call.wire_provider_format === 'string' ? call.wire_provider_format : '';
  if (format.includes('/responses')) {
    return '/responses';
  }
  return format || 'wire_payload';
}

type CliProxyApiLogSection = {
  title: string;
  body: string;
};

type ParsedCliProxyApiLogPart = {
  metadata: Record<string, string>;
  headers: Record<string, string | string[]>;
  rawBody: string;
  body: unknown;
};

type ParsedCliProxyApiLogDetail = {
  logFile: string;
  request: ParsedCliProxyApiLogPart | null;
  response: ParsedCliProxyApiLogPart | null;
};

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'openai-api-key',
  'proxy-authorization'
]);

function redactSensitiveHeaders(headers: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!headers) {
    return null;
  }
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
    key,
    SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ? '[redacted]' : value
  ]));
}

function isSafeCliProxyCorrelationId(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
}

function cliProxyRequestLogDir(): string | null {
  if (process.env.CLIPROXY_REQUEST_LOG_DETAIL_ENABLED !== 'true') {
    return null;
  }
  const configured = (process.env.CLIPROXY_REQUEST_LOG_DIR || '').trim();
  if (!configured) {
    return null;
  }
  const resolved = path.resolve(configured);
  try {
    const stat = fs.statSync(resolved);
    return stat.isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function cliProxyLogScanLimit(): number {
  const parsed = Number.parseInt(process.env.CLIPROXY_REQUEST_LOG_SCAN_LIMIT || '500', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
}

function splitCliProxyApiLogSections(content: string): CliProxyApiLogSection[] {
  const normalized = content.replace(/\r\n/g, '\n');
  const matches = Array.from(normalized.matchAll(/^=== ([^=\n]+?) ===\n/gm));
  if (matches.length === 0) {
    return [];
  }

  return matches.map((match, index) => {
    const start = (match.index || 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index || normalized.length : normalized.length;
    return {
      title: match[1].trim(),
      body: normalized.slice(start, end)
    };
  });
}

function parseCliProxyMetadata(block: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  block.split('\n').forEach((line) => {
    const match = line.match(/^([^:\n]+):\s*(.*)$/);
    if (!match) {
      return;
    }
    const key = match[1].trim();
    if (!key) {
      return;
    }
    metadata[key] = match[2].trim();
  });
  return metadata;
}

function parseCliProxyHeaders(block: string): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  block.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '<none>') {
      return;
    }
    const match = line.match(/^([^:\n]+):\s*(.*)$/);
    if (!match) {
      return;
    }
    const key = match[1].trim();
    const value = match[2].trim();
    if (!key) {
      return;
    }
    const existing = headers[key];
    if (existing === undefined) {
      headers[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      headers[key] = [existing, value];
    }
  });
  return headers;
}

function cliProxyHeadersContainLlmCallId(headers: Record<string, string | string[]>, llmCallId: string): boolean {
  const expected = llmCallId.trim();
  return Object.entries(headers).some(([key, value]) => {
    if (key.toLowerCase() !== 'x-llm-call-id') {
      return false;
    }
    const values = Array.isArray(value) ? value : [value];
    return values.some((headerValue) => headerValue.trim() === expected);
  });
}

function cliProxyLogHasLlmCallHeader(content: string, llmCallId: string): boolean {
  const sections = splitCliProxyApiLogSections(content);
  for (const section of sections) {
    if (section.title === 'HEADERS' && cliProxyHeadersContainLlmCallId(parseCliProxyHeaders(section.body), llmCallId)) {
      return true;
    }
    if (/^API REQUEST(?:\s+\d+)?$/.test(section.title)) {
      const requestPart = parseCliProxyApiLogPart(section.body);
      if (cliProxyHeadersContainLlmCallId(requestPart.headers, llmCallId)) {
        return true;
      }
    }
  }
  return false;
}

function parseCliProxyBody(rawBody: string): unknown {
  const body = rawBody.trim();
  if (!body || body === '<empty>') {
    return null;
  }
  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      return JSON.parse(body);
    } catch {
      return rawBody.trimEnd();
    }
  }
  return rawBody.trimEnd();
}

function parseCliProxyApiLogPart(sectionBody: string): ParsedCliProxyApiLogPart {
  const normalized = sectionBody.replace(/\r\n/g, '\n');
  const headersMarker = '\nHeaders:\n';
  const bodyMarker = '\nBody:\n';
  const headersIndex = normalized.indexOf(headersMarker);

  if (headersIndex === -1) {
    return {
      metadata: parseCliProxyMetadata(normalized),
      headers: {},
      rawBody: '',
      body: null
    };
  }

  const metadataText = normalized.slice(0, headersIndex);
  const afterHeaders = normalized.slice(headersIndex + headersMarker.length);
  const bodyIndex = afterHeaders.indexOf(bodyMarker);
  const headersText = bodyIndex === -1 ? afterHeaders : afterHeaders.slice(0, bodyIndex);
  const rawBody = bodyIndex === -1 ? '' : afterHeaders.slice(bodyIndex + bodyMarker.length).trimEnd();

  return {
    metadata: parseCliProxyMetadata(metadataText),
    headers: parseCliProxyHeaders(headersText),
    rawBody,
    body: parseCliProxyBody(rawBody)
  };
}

function inferCliProxyBodyFormat(body: unknown): string {
  if (body === null || body === undefined) {
    return 'empty';
  }
  if (typeof body !== 'string') {
    return 'json';
  }
  const trimmed = body.trimStart();
  if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    return 'sse';
  }
  return 'text';
}

function parseCliProxyApiRequestLog(content: string, logFile: string): ParsedCliProxyApiLogDetail | null {
  const sections = splitCliProxyApiLogSections(content);
  const requestSections = sections.filter((section) => /^API REQUEST(?:\s+\d+)?$/.test(section.title));
  const responseSections = sections.filter((section) => /^API RESPONSE(?:\s+\d+)?$/.test(section.title));
  const requestSection = requestSections.length > 0 ? requestSections[requestSections.length - 1] : null;
  const responseSection = responseSections.length > 0 ? responseSections[responseSections.length - 1] : null;

  if (!requestSection && !responseSection) {
    return null;
  }

  return {
    logFile,
    request: requestSection ? parseCliProxyApiLogPart(requestSection.body) : null,
    response: responseSection ? parseCliProxyApiLogPart(responseSection.body) : null
  };
}

function findCliProxyApiRequestLog(llmCallId: string | null | undefined, logger: winston.Logger): ParsedCliProxyApiLogDetail | null {
  const trimmed = typeof llmCallId === 'string' ? llmCallId.trim() : '';
  if (!trimmed || !isSafeCliProxyCorrelationId(trimmed)) {
    return null;
  }
  const logDir = cliProxyRequestLogDir();
  if (!logDir) {
    return null;
  }

  try {
    const files = fs.readdirSync(logDir)
      .filter((name) => name.endsWith('.log'))
      .map((name) => {
        const fullPath = path.join(logDir, name);
        const stat = fs.statSync(fullPath);
        return { name, fullPath, mtimeMs: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, cliProxyLogScanLimit());

    for (const file of files) {
      if (file.size <= 0) {
        continue;
      }
      const content = fs.readFileSync(file.fullPath, 'utf8');
      if (!cliProxyLogHasLlmCallHeader(content, trimmed)) {
        continue;
      }
      const parsed = parseCliProxyApiRequestLog(content, file.name);
      if (parsed) {
        return parsed;
      }
    }
  } catch (error) {
    logger.warn('Failed to read CLIProxyAPI request logs for trace detail', {
      error: error instanceof Error ? error.message : String(error),
      llmCallId: trimmed,
      logDir
    });
  }

  return null;
}

function buildCliProxyApiSpanDetail(call: any, logger: winston.Logger): TraceSpanDetailDto | null {
  const log = findCliProxyApiRequestLog(call.llm_call_id, logger);
  if (!log) {
    return null;
  }

  const request = log.request;
  const response = log.response;
  const statusCode = response?.metadata?.Status ? Number.parseInt(response.metadata.Status, 10) : (call.error_message ? null : 200);

  return {
    input: {
      headers: redactSensitiveHeaders(request?.headers),
      body: request?.body ?? null,
      raw_body: request?.rawBody || null,
      method: request?.metadata?.['HTTP Method'] || 'POST',
      upstream_url: request?.metadata?.['Upstream URL'] || null,
      body_source: 'cliproxyapi.request_log.api_request'
    },
    output: {
      status_code: Number.isFinite(statusCode) ? statusCode : (call.error_message ? null : 200),
      headers: redactSensitiveHeaders(response?.headers),
      body: response?.body ?? null,
      raw_body: response?.rawBody || null,
      body_format: inferCliProxyBodyFormat(response?.body),
      body_source: 'cliproxyapi.request_log.api_response',
      error_message: call.error_message
    },
    evidence: {
      synthetic: true,
      source: 'cliproxyapi.request_log',
      fallback_source: 'llm_request_slices.wire_request/wire_response',
      log_file: log.logFile,
      llm_call_id: call.llm_call_id || null,
      model_provider: call.model_provider || null,
      wire_provider_format: call.wire_provider_format || null,
      request_format_version: call.request_format_version || null,
      request_timestamp: call.started_at,
      response_timestamp: call.completed_at
    }
  };
}

function normalizeStackSliceProviderCall(slice: any) {
  const metadata = slice.metadata && typeof slice.metadata === 'object' ? slice.metadata : {};
  const providerResponseStatus = toNumber(metadata.provider_response_status ?? metadata.wire_response_status);
  return {
    id: slice.slice_id || slice.id,
    slice_id: slice.slice_id || null,
    llm_call_id: slice.llm_call_id || null,
    trace_id: slice.trace_id || null,
    conversation_id: slice.conversation_id || null,
    agent_turn: slice.agent_turn ?? null,
    started_at: slice.started_at,
    completed_at: slice.completed_at,
    duration_ms: slice.duration_ms,
    status: slice.status,
    model_name: slice.model_name || null,
    model_provider: slice.model_provider || null,
    canonical_request: slice.canonical_request,
    wire_request: slice.wire_request,
    canonical_response: slice.canonical_response,
    wire_response: slice.wire_response,
    raw_response: slice.raw_response,
    request_headers: parseJsonField<any>(metadata.provider_request_headers ?? metadata.wire_request_headers, null),
    request_url: typeof metadata.provider_request_url === 'string'
      ? metadata.provider_request_url
      : typeof metadata.wire_request_url === 'string'
        ? metadata.wire_request_url
        : null,
    response_headers: parseJsonField<any>(metadata.provider_response_headers ?? metadata.wire_response_headers, null),
    response_status: providerResponseStatus,
    response_status_text: typeof metadata.provider_response_status_text === 'string'
      ? metadata.provider_response_status_text
      : typeof metadata.wire_response_status_text === 'string'
        ? metadata.wire_response_status_text
        : null,
    input_tokens: slice.input_tokens,
    output_tokens: slice.output_tokens,
    token_usage: slice.token_usage,
    error_message: typeof metadata.errorMessage === 'string'
      ? metadata.errorMessage
      : typeof metadata.error_message === 'string'
        ? metadata.error_message
        : null,
    error_code: null,
    request_format_version: slice.request_format_version,
    wire_provider_format: slice.wire_provider_format,
    wire_request_raw_text: slice.wire_request_raw_text,
    wire_response_raw_text: slice.wire_response_raw_text
  };
}

function hasProviderWirePayload(providerCall: any): boolean {
  return providerCall?.wire_request !== null && providerCall?.wire_request !== undefined;
}

function buildRawProviderTraceFromProviderCall(
  providerCall: any,
  spanId: string | null,
  source: string
): RawProviderTraceDto {
  const requestBody = providerCall.wire_request_raw_text || rawJsonText(providerCall.wire_request);
  const responseBody = providerCall.wire_response_raw_text || rawJsonText(
    providerCall.raw_response,
    rawJsonText(providerCall.wire_response)
  );

  return {
    span_id: spanId,
    trace_id: providerCall.trace_id || null,
    conversation_id: providerCall.conversation_id || null,
    slice_id: providerCall.slice_id || null,
    llm_call_id: providerCall.llm_call_id || null,
    source,
    model_name: providerCall.model_name || null,
    model_provider: providerCall.model_provider || null,
    request_format_version: providerCall.request_format_version || null,
    wire_provider_format: providerCall.wire_provider_format || null,
    started_at: providerCall.started_at || null,
    completed_at: providerCall.completed_at || null,
    duration_ms: providerCall.duration_ms ?? null,
    request: {
      method: 'POST',
      upstream_url: providerCall.request_url || null,
      headers: redactSensitiveHeaders(providerCall.request_headers),
      body: requestBody,
      bytes: estimateJsonBytes(requestBody),
      body_format: inferRawTextFormat(requestBody),
      body_source: 'llm_request_slices.wire_request'
    },
    response: {
      status_code: providerCall.response_status ?? (providerCall.error_message ? null : 200),
      status_text: providerCall.response_status_text || null,
      headers: redactSensitiveHeaders(providerCall.response_headers),
      body: responseBody,
      bytes: estimateJsonBytes(responseBody),
      body_format: inferRawTextFormat(responseBody),
      body_source: providerCall.raw_response !== null && providerCall.raw_response !== undefined
        ? 'llm_request_slices.raw_response'
        : 'llm_request_slices.wire_response',
      error_message: providerCall.error_message || null
    }
  };
}

function buildRawProviderTraceFromImageProviderExchange(
  exchange: any,
  task: any,
  spanId: string | null
): RawProviderTraceDto | null {
  if (!exchange || typeof exchange !== 'object') {
    return null;
  }
  const request = exchange.request && typeof exchange.request === 'object' ? exchange.request : {};
  const response = exchange.response && typeof exchange.response === 'object' ? exchange.response : {};
  if (!request.body && !request.raw_body && !response.body && !response.raw_body) {
    return null;
  }
  const requestBody = typeof request.raw_body === 'string'
    ? request.raw_body
    : rawJsonText(request.body);
  const responseBody = typeof response.raw_body === 'string'
    ? response.raw_body
    : rawJsonText(response.body);

  return {
    span_id: spanId,
    trace_id: task?.source_trace_id || task?.sourceTraceId || null,
    conversation_id: null,
    slice_id: task?.id || null,
    llm_call_id: null,
    source: 'agent_tasks.result_json.provider_exchange',
    model_name: exchange.model || task?.result_json?.model || task?.resultJson?.model || null,
    model_provider: exchange.provider || null,
    request_format_version: exchange.request_format_version || null,
    wire_provider_format: exchange.wire_provider_format || null,
    started_at: exchange.started_at || null,
    completed_at: exchange.completed_at || null,
    duration_ms: exchange.duration_ms ?? null,
    request: {
      method: typeof request.method === 'string' ? request.method : 'POST',
      upstream_url: typeof request.upstream_url === 'string' ? request.upstream_url : null,
      headers: redactSensitiveHeaders(request.headers),
      body: requestBody,
      bytes: estimateJsonBytes(requestBody),
      body_format: typeof request.body_format === 'string' ? request.body_format : inferRawTextFormat(requestBody),
      body_source: typeof request.body_source === 'string' ? request.body_source : 'agent_tasks.result_json.provider_exchange.request'
    },
    response: {
      status_code: toNumber(response.status_code),
      status_text: typeof response.status_text === 'string' ? response.status_text : null,
      headers: redactSensitiveHeaders(response.headers),
      body: responseBody,
      bytes: estimateJsonBytes(responseBody),
      body_format: typeof response.body_format === 'string' ? response.body_format : inferRawTextFormat(responseBody),
      body_source: typeof response.body_source === 'string' ? response.body_source : 'agent_tasks.result_json.provider_exchange.response',
      error_message: typeof response.error_message === 'string' ? response.error_message : null
    }
  };
}

async function buildImageTaskRawProviderTrace(
  logger: winston.Logger,
  target: StackTraceTarget,
  spanId: string
): Promise<RawProviderTraceDto | null> {
  const spanTaskId = spanId.startsWith('provider-request:image-task:')
    ? decodeURIComponent(spanId.slice('provider-request:image-task:'.length))
    : null;
  const taskId = firstNonEmptyString(target.forkRunId, spanTaskId);
  if (!taskId) {
    return null;
  }

  try {
    const task = await getAgentTaskById(taskId) as any;
    const resultJson = task?.result_json && typeof task.result_json === 'object'
      ? task.result_json
      : task?.resultJson && typeof task.resultJson === 'object'
        ? task.resultJson
        : {};
    const exchange = resultJson.provider_exchange || resultJson.providerExchange || null;
    return buildRawProviderTraceFromImageProviderExchange(exchange, task, spanId || `provider-request:image-task:${taskId}`);
  } catch (error) {
    logger.warn('Image task raw provider trace query failed', {
      error: error instanceof Error ? error.message : String(error),
      taskId,
      spanId
    });
    return null;
  }
}

function canRepresentProviderRequest(providerCall: any): boolean {
  return hasProviderWirePayload(providerCall)
    || Boolean(providerCall?.llm_call_id || providerCall?.slice_id || providerCall?.id);
}

function buildStackProviderRequestSpan(params: {
  providerCall: any;
  parentSpanId: string;
  traceId: string;
  conversationId: string | null;
  agentTurn?: number | null;
}): TraceSpanDto {
  const { providerCall } = params;
  return createSpan({
    span_id: buildSyntheticProviderRequestSpanId(providerCall),
    parent_span_id: params.parentSpanId,
    trace_id: params.traceId,
    conversation_id: providerCall.conversation_id || params.conversationId,
    name: 'provider.request',
    kind: 'client',
    status_code: providerCall.status,
    status_message: providerCall.error_message || null,
    started_at: providerCall.started_at,
    ended_at: providerCall.completed_at,
    duration_ms: providerCall.duration_ms,
    summary: `POST ${syntheticProviderHost(providerCall)}${syntheticProviderPath(providerCall)} -> ${providerCall.status}`,
    attributes: {
      'semantic.role': 'provider_request',
      'semantic.display_name': `POST ${syntheticProviderHost(providerCall)}`,
      'http.method': 'POST',
      'http.url': providerCall.request_url || null,
      'http.host': syntheticProviderHost(providerCall),
      'http.path': syntheticProviderPath(providerCall),
      'http.status_code': providerCall.response_status ?? (providerCall.error_message ? null : 200),
      'trace.llm_call_id': providerCall.llm_call_id || null,
      'trace.agent_turn': providerCall.agent_turn ?? params.agentTurn ?? null,
      'provider.api_type': providerCall.wire_provider_format || providerCall.model_provider || null,
      'provider.traffic_log_id': null,
      'provider.synthetic_source': 'llm_request_slices.wire_payload',
      'stack.slice_id': providerCall.slice_id || null
    },
    input: {
      headers: redactSensitiveHeaders(providerCall.request_headers),
      body: providerCall.wire_request,
      raw_body: providerCall.wire_request_raw_text || null,
      method: 'POST',
      upstream_url: providerCall.request_url || null,
      body_source: 'llm_request_slices.wire_request'
    },
    output: {
      status_code: providerCall.response_status ?? (providerCall.error_message ? null : 200),
      headers: redactSensitiveHeaders(providerCall.response_headers),
      body: providerCall.wire_response,
      raw_body: providerCall.wire_response_raw_text || null,
      body_format: 'json',
      body_source: 'llm_request_slices.wire_response',
      error_message: providerCall.error_message
    },
    evidence: {
      synthetic: true,
      source: 'llm_request_slices.wire_request/wire_response',
      slice_id: providerCall.slice_id || null,
      llm_call_id: providerCall.llm_call_id || null,
      model_provider: providerCall.model_provider || null,
      wire_provider_format: providerCall.wire_provider_format || null,
      request_format_version: providerCall.request_format_version || null,
      request_body: providerCall.wire_request,
      request_headers: redactSensitiveHeaders(providerCall.request_headers),
      request_url: providerCall.request_url || null,
      response_body: providerCall.wire_response,
      response_headers: redactSensitiveHeaders(providerCall.response_headers),
      response_status: providerCall.response_status ?? (providerCall.error_message ? null : 200),
      response_status_text: providerCall.response_status_text || null,
      duration_ms: providerCall.duration_ms,
      request_timestamp: providerCall.started_at,
      response_timestamp: providerCall.completed_at
    },
    events: [],
    links: [],
    confidence: 'observed',
    source_ref: providerCall.slice_id || providerCall.llm_call_id || providerCall.id
  });
}

function normalizeToolCall(call: any) {
  const result = parseJsonField<any>(call.result, null);
  return {
    id: call.id,
    tool_call_id: call.tool_call_id || null,
    trace_id: call.trace_id,
    conversation_id: call.conversation_id || null,
    job_id: call.job_id || null,
    agent_turn: toNumber(call.agent_turn),
    llm_call_id: call.llm_call_id || null,
    tool_type: call.tool_type,
    tool_name: call.tool_name,
    method_id: call.method_id || null,
    arguments: parseJsonField<any>(call.arguments, null),
    result,
    outcome: typeof result?.outcome === 'string' ? result.outcome : null,
    blocked_reason: typeof result?.blocked_reason === 'string' ? result.blocked_reason : null,
    duplicate_suppressed: Boolean(result?.duplicate_suppressed),
    status: normalizeStatusCode(call.status),
    error_message: call.error_message || null,
    execution_mode: call.execution_mode || null,
    side_effect: Boolean(call.side_effect),
    started_at: toIsoString(call.started_at),
    completed_at: toIsoString(call.completed_at || call.started_at),
    duration_ms: getDurationMs(call.started_at, call.completed_at, call.duration_ms),
    http_requests: [] as any[]
  };
}

function normalizeHttpLog(log: any, options?: TracePayloadTrimOptions) {
  const statusCode = toNumber(log.response_status);
  const normalizedResponse = extractSseFinalResponse(log.response_body || null);
  return {
    id: log.id,
    trace_id: log.trace_id || null,
    conversation_id: log.conversation_id || null,
    user_id: log.user_id || null,
    session_id: log.session_id || null,
    agent_turn: toNumber(log.agent_turn),
    llm_call_id: log.llm_call_id || null,
    tool_call_id: log.tool_call_id || null,
    request_id: log.request_id || null,
    method: log.method,
    url: log.url,
    host: log.host,
    path: log.path,
    status: statusCode !== null && statusCode < 400 ? 'ok' : (log.error_message ? 'error' : 'unset'),
    response_status: statusCode,
    request_timestamp: toIsoString(log.request_timestamp),
    response_timestamp: toIsoString(log.response_timestamp || log.request_timestamp),
    duration_ms: getDurationMs(log.request_timestamp, log.response_timestamp, log.duration_ms),
    request_headers: maybeTrimLargeField(parseJsonField<any>(log.request_headers, {}), 'request_headers', options),
    response_headers: maybeTrimLargeField(parseJsonField<any>(log.response_headers, {}), 'response_headers', options),
    request_body: maybeTrimLargeField(log.request_body || null, 'request_body', options),
    response_body: maybeTrimLargeField(log.response_body || null, 'response_body', options),
    normalized_response_body: maybeTrimLargeField(normalizedResponse.body, 'normalized_response_body', options),
    normalized_response_raw_body: maybeTrimLargeField(normalizedResponse.raw_body, 'normalized_response_raw_body', options),
    normalized_response_body_format: normalizedResponse.body_format,
    normalized_response_body_source: normalizedResponse.body_source,
    is_ai_request: Boolean(log.is_ai_request),
    api_type: log.api_type || null,
    api_version: log.api_version || null,
    error_message: log.error_message || null,
    attribution: 'unattributed' as 'tool_call_id' | 'llm_call_id' | 'time_window' | 'unattributed'
  };
}

function summarizeProviderStatuses(logs: any[]): number[] {
  return Array.from(
    new Set(
      logs
        .map((log) => toNumber(log.response_status))
        .filter((value): value is number => value !== null)
    )
  ).sort((left, right) => left - right);
}

function summarizeProviderHosts(logs: any[]): string[] {
  return Array.from(
    new Set(
      logs
        .map((log) => (typeof log.host === 'string' ? log.host.trim() : ''))
        .filter(Boolean)
    )
  ).sort((left, right) => left.localeCompare(right));
}

function normalizeQueueMessage(row: any) {
  return {
    id: row.id,
    trace_id: row.trace_id,
    source: row.source || null,
    message_sid: row.message_sid || null,
    chat_type: row.chat_type || null,
    session_key: row.session_key || null,
    status: row.status || null,
    sender_id: row.sender_id || null,
    sender_name: row.sender_name || null,
    peer_id: row.peer_id || null,
    peer_name: row.peer_name || null,
    body_for_agent: row.body_for_agent || null,
    raw_payload: parseJsonField<any>(row.raw_payload, {}),
    inbound_context: parseJsonField<any>(row.inbound_context, {}),
    payload: parseJsonField<any>(row.payload, {}),
    created_at: toIsoString(row.created_at),
    processing_started_at: toIsoString(row.processing_started_at),
    completed_at: toIsoString(row.completed_at),
    conversation_id: row.conversation_id || null,
    error_message: row.error_message || null,
    result: parseJsonField<any>(row.result, {})
  };
}

function attachHttpLogs(toolCalls: any[], llmCalls: any[], httpLogs: any[]) {
  const toolById = new Map(toolCalls.filter((item) => item.tool_call_id).map((item) => [item.tool_call_id, item]));
  const llmById = new Map(llmCalls.filter((item) => item.llm_call_id).map((item) => [item.llm_call_id, item]));
  const unattributed: any[] = [];

  for (const httpLog of httpLogs) {
    if (httpLog.tool_call_id && toolById.has(httpLog.tool_call_id)) {
      httpLog.attribution = 'tool_call_id';
      toolById.get(httpLog.tool_call_id)!.http_requests.push(httpLog);
      continue;
    }

    if (httpLog.llm_call_id && llmById.has(httpLog.llm_call_id)) {
      httpLog.attribution = 'llm_call_id';
      const llmCall = llmById.get(httpLog.llm_call_id)!;
      if (httpLog.is_ai_request) {
        llmCall.provider_requests.push(httpLog);
      } else {
        llmCall.http_requests.push(httpLog);
      }
      continue;
    }

    const requestTime = toMillis(httpLog.request_timestamp);
    const matchingTool = toolCalls.find((toolCall) => {
      const start = toMillis(toolCall.started_at);
      const end = toMillis(toolCall.completed_at || toolCall.started_at);
      return requestTime !== null && start !== null && end !== null && requestTime >= start && requestTime <= end;
    });

    if (matchingTool) {
      httpLog.attribution = 'time_window';
      matchingTool.http_requests.push(httpLog);
      continue;
    }

    unattributed.push(httpLog);
  }

  return unattributed;
}

function pairTimelineEvents(events: any[]) {
  const startMap = new Map<string, any[]>();
  const spans: Array<{
    id: string;
    type: string;
    started_at: string | null;
    ended_at: string | null;
    duration_ms: number | null;
    status: 'unset' | 'ok' | 'error';
    title: string;
    summary: string;
    evidence: any;
    events: TraceSpanEventDto[];
    confidence: TraceConfidence;
  }> = [];

  const buildLifecycleType = (eventType: string, eventName: string) => {
    const combined = `${eventType}.${eventName}`.toLowerCase();
    if (combined.includes('queue')) return 'queue';
    if (combined.includes('context')) return 'context';
    if (combined.includes('decision')) return 'decision';
    if (combined.includes('delivery')) return 'delivery';
    if (combined.includes('trace')) return 'terminal';
    return eventType || 'trace';
  };

  const summarizeLifecycleEvent = (event: any) => {
    const metadata = parseJsonField<any>(event.metadata, {});
    if (event.event_type === 'participation' && event.event_name === 'decision') {
      const decision = typeof metadata.decision === 'string' ? metadata.decision : 'unknown';
      const reason = typeof metadata.reason === 'string' ? metadata.reason : 'unknown_reason';
      const confidence = typeof metadata.confidence === 'string' ? metadata.confidence : 'unknown_confidence';
      return `participation / ${decision} / ${reason} / ${confidence}`;
    }
    return `${event.event_type} / ${event.event_name} / ${event.event_phase || 'instant'}`;
  };

  const buildLifecycleAttributes = (event: any) => {
    const metadata = parseJsonField<any>(event.metadata, {});
    const attributes: Record<string, unknown> = {
      metadata
    };
    if (event.event_type === 'participation' && event.event_name === 'decision') {
      attributes['participation.decision'] = metadata.decision || null;
      attributes['participation.reason'] = metadata.reason || null;
      attributes['participation.confidence'] = metadata.confidence || null;
      attributes['participation.used_embeddings'] = metadata.used_embeddings ?? null;
      attributes['participation.used_llm_judge'] = metadata.used_llm_judge ?? metadata.usedLlmJudge ?? null;
      attributes['participation.llm_judge_model'] = metadata.llmJudgeModel || null;
      attributes['participation.llm_judge_decision'] = metadata.llmJudgeDecision || null;
      attributes['participation.llm_judge_confidence'] = metadata.llmJudgeConfidence || null;
      attributes['participation.llm_judge_error'] = metadata.llmJudgeError || null;
      attributes['participation.conservative_fallback'] = metadata.conservative_fallback ?? null;
    }
    return attributes;
  };

  for (const event of events) {
    const key = `${event.event_type}:${event.event_name}`;
    const eventDto: TraceSpanEventDto = {
      id: `timeline-event-${event.id}`,
      name: `${event.event_type}.${event.event_name}.${event.event_phase || 'instant'}`,
      timestamp: toIsoString(event.event_time),
      attributes: {
        event_type: event.event_type,
        event_name: event.event_name,
        event_phase: event.event_phase,
        ...buildLifecycleAttributes(event)
      }
    };

    if (event.event_phase === 'start') {
      const bucket = startMap.get(key) || [];
      bucket.push(event);
      startMap.set(key, bucket);
      continue;
    }

    if (event.event_phase === 'end') {
      const bucket = startMap.get(key) || [];
      const startEvent = bucket.shift();
      if (bucket.length === 0) {
        startMap.delete(key);
      } else {
        startMap.set(key, bucket);
      }

      spans.push({
        id: `timeline-${event.id}`,
        type: buildLifecycleType(event.event_type, event.event_name),
        started_at: toIsoString(startEvent?.event_time) || toIsoString(event.event_time),
        ended_at: toIsoString(event.event_time),
        duration_ms: getDurationMs(startEvent?.event_time, event.event_time, event.duration_ms),
        status: 'ok',
        title: `${event.event_type}.${event.event_name}`,
        summary: summarizeLifecycleEvent(event),
        evidence: {
          start: startEvent || null,
          end: event
        },
        events: startEvent ? [
          {
            id: `timeline-event-${startEvent.id}`,
            name: `${startEvent.event_type}.${startEvent.event_name}.start`,
            timestamp: toIsoString(startEvent.event_time),
            attributes: buildLifecycleAttributes(startEvent)
          },
          eventDto
        ] : [eventDto],
        confidence: startEvent ? 'observed' : 'derived'
      });
      continue;
    }

    spans.push({
      id: `timeline-${event.id}`,
      type: buildLifecycleType(event.event_type, event.event_name),
      started_at: toIsoString(event.event_time),
      ended_at: toIsoString(event.event_time),
      duration_ms: event.duration_ms ?? null,
      status: normalizeStatusCode(event.event_name),
      title: `${event.event_type}.${event.event_name}`,
      summary: summarizeLifecycleEvent(event),
      evidence: event,
      events: [eventDto],
      confidence: 'observed'
    });
  }

  return spans.filter((span) => (
    span.type === 'queue'
    || span.type === 'context'
    || (span.type === 'decision' && span.title === 'participation.decision')
  ));
}

function buildSyntheticTurns(llmCalls: any[], toolCalls: any[], unattributedHttp: any[], conversation: any, latestJob: any) {
  const explicitTurns = new Set<number>();
  llmCalls.forEach((call) => {
    if (call.agent_turn !== null) explicitTurns.add(call.agent_turn);
  });
  toolCalls.forEach((call) => {
    if (call.agent_turn !== null) explicitTurns.add(call.agent_turn);
  });
  unattributedHttp.forEach((call) => {
    if (call.agent_turn !== null) explicitTurns.add(call.agent_turn);
  });

  const turnValues = explicitTurns.size > 0 ? Array.from(explicitTurns).sort((a, b) => a - b) : [1];
  return turnValues.map((turn) => {
    const turnLlmCalls = llmCalls.filter((call) => (call.agent_turn ?? 1) === turn);
    const turnToolCalls = toolCalls.filter((call) => (call.agent_turn ?? 1) === turn);
    const turnHttp = unattributedHttp.filter((log) => (log.agent_turn ?? turn) === turn);
    const turnStartCandidates = [
      ...turnLlmCalls.map((call) => call.started_at),
      ...turnToolCalls.map((call) => call.started_at),
      ...turnHttp.map((call) => call.request_timestamp)
    ].filter(Boolean);
    const turnEndCandidates = [
      ...turnLlmCalls.map((call) => call.completed_at),
      ...turnToolCalls.map((call) => call.completed_at),
      ...turnHttp.map((call) => call.response_timestamp)
    ].filter(Boolean);

    return {
      turn,
      started_at: turnStartCandidates.sort()[0] || null,
      ended_at: turnEndCandidates.sort().slice(-1)[0] || turnStartCandidates.sort().slice(-1)[0] || null,
      duration_ms: getDurationMs(turnStartCandidates.sort()[0], turnEndCandidates.sort().slice(-1)[0]),
      llm_calls: turnLlmCalls,
      tool_calls: turnToolCalls,
      unattributed_http: turnHttp,
      outcome: turn === turnValues[turnValues.length - 1]
        ? {
            conversation_status: conversation.status,
            job_status: latestJob?.status || null,
            final_response: conversation.ai_response || latestJob?.final_response || null,
            error_message: conversation.error_reason || latestJob?.error_message || null
          }
        : null
    };
  });
}

function createSpan(params: Omit<TraceSpanDto, 'depth' | 'sort_key'>): TraceSpanDto {
  return {
    ...params,
    depth: 0,
    sort_key: ''
  };
}

function assignTreeMetadata(spans: TraceSpanDto[], rootSpanId: string) {
  const byId = new Map(spans.map((span) => [span.span_id, span]));
  const children = new Map<string, TraceSpanDto[]>();

  spans.forEach((span) => {
    if (span.span_id === rootSpanId) {
      return;
    }
    const parentId = span.parent_span_id && byId.has(span.parent_span_id) ? span.parent_span_id : rootSpanId;
    span.parent_span_id = parentId;
    const bucket = children.get(parentId) || [];
    bucket.push(span);
    children.set(parentId, bucket);
  });

  children.forEach((bucket) => {
    bucket.sort((left, right) => {
      const timeOrder = compareTimes(left.started_at, right.started_at);
      if (timeOrder !== 0) {
        return timeOrder;
      }
      return left.span_id.localeCompare(right.span_id);
    });
  });

  const visit = (spanId: string, depth: number, prefix: string) => {
    const bucket = children.get(spanId) || [];
    bucket.forEach((child, index) => {
      child.depth = depth;
      child.sort_key = `${prefix}.${String(index + 1).padStart(3, '0')}`;
      visit(child.span_id, depth + 1, child.sort_key);
    });
  };

  const root = byId.get(rootSpanId);
  if (root) {
    root.depth = 0;
    root.sort_key = '000';
    visit(rootSpanId, 1, '000');
  }
}

function firstNonEmptyString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function dedupeBy<T>(rows: T[], getKey: (row: T) => unknown): T[] {
  const byKey = new Map<string, T>();
  rows.forEach((row, index) => {
    const key = getKey(row) ?? `row:${index}`;
    byKey.set(String(key), row);
  });
  return Array.from(byKey.values());
}

function trimTraceEvidence<T extends Record<string, unknown>>(value: T, fieldLabels: Record<string, string>): T {
  const trimmed = { ...value };
  Object.entries(fieldLabels).forEach(([field, label]) => {
    if (Object.prototype.hasOwnProperty.call(trimmed, field)) {
      trimmed[field as keyof T] = maybeTrimLargeField(trimmed[field], label, { truncateLargeFields: true }) as T[keyof T];
    }
  });
  return trimmed;
}

async function listStackTraceRows<T>(
  label: string,
  target: StackTraceTarget,
  logger: winston.Logger,
  listFn: (input: Record<string, unknown>) => Promise<T[]>,
  keyFn: (row: T) => unknown,
  limit = 500
): Promise<T[]> {
  const traceId = firstNonEmptyString(target.traceId);
  const runId = firstNonEmptyString(target.internalExecutionLeaseId);
  const sourceKind = firstNonEmptyString(target.sourceKind);
  const forkRunId = firstNonEmptyString(target.forkRunId);
  const sourceLookup = {
    ...(sourceKind ? { sourceKind } : {}),
    ...(forkRunId ? { forkRunId } : {})
  };
  const queries: Promise<T[]>[] = [];

  if (traceId) {
    queries.push(listFn({
      identityKey: 'xiaoni',
      ...sourceLookup,
      traceId,
      chronological: true,
      limit
    }));
  } else if (runId) {
    queries.push(listFn({
      identityKey: 'xiaoni',
      ...sourceLookup,
      runId,
      chronological: true,
      limit
    }));
  }

  if (queries.length === 0) {
    return [];
  }

  try {
    const rows = (await Promise.all(queries)).flat();
    return dedupeBy(rows, keyFn);
  } catch (error) {
    logger.warn(`Trace query failed: ${label}`, {
      error: error instanceof Error ? error.message : String(error),
      traceId,
      runId
    });
    return [];
  }
}

export async function buildStackTracePayload(
  logger: winston.Logger,
  target: StackTraceTarget
) {
  const traceId = firstNonEmptyString(target.traceId, target.internalExecutionLeaseId);
  const runId = firstNonEmptyString(target.internalExecutionLeaseId);
  const sourceKind = firstNonEmptyString(target.sourceKind);
  const forkRunId = firstNonEmptyString(target.forkRunId);
  const sourceLookup = {
    ...(sourceKind ? { sourceKind } : {}),
    ...(forkRunId ? { forkRunId } : {})
  };
  const spanId = firstNonEmptyString(target.spanId);
  let focusedSliceId = firstNonEmptyString(target.llmRequestSliceId);
  let focusedToolCallId = firstNonEmptyString(target.toolCallId);
  if (!focusedToolCallId && (spanId?.startsWith('tool-call:') || spanId?.startsWith('tool-output:'))) {
    focusedToolCallId = spanId.split(':').slice(1).join(':');
  }
  if (!focusedSliceId && spanId?.startsWith('stack-slice:')) {
    focusedSliceId = spanId.slice('stack-slice:'.length);
  }
  if (!focusedSliceId && spanId) {
    const syntheticProviderRequest = parseSyntheticProviderRequestSpanId(spanId);
    focusedSliceId = syntheticProviderRequest?.sliceId || focusedSliceId;
  }
  if (!traceId && !runId && !focusedSliceId && !focusedToolCallId) {
    return null;
  }

  let stackSliceRows: any[] = [];
  let stackToolExecutionRows: any[] = [];
  let stackItemRows: any[] = [];

  if (focusedSliceId || focusedToolCallId) {
    try {
      const focusedTools = focusedToolCallId
        ? await listToolExecutions({
          identityKey: 'xiaoni',
          ...sourceLookup,
          toolCallId: focusedToolCallId,
          chronological: true,
          limit: 10
        }) as any[]
        : [];
      const sliceIds = new Set<string>();
      if (focusedSliceId) {
        sliceIds.add(focusedSliceId);
      }
      focusedTools.forEach((tool) => {
        const sliceId = firstNonEmptyString(tool?.llmRequestSliceId, tool?.llm_request_slice_id);
        if (sliceId) {
          sliceIds.add(sliceId);
        }
      });

      const [focusedSlices, sliceTools, toolItems, sliceItems] = await Promise.all([
        Promise.all(Array.from(sliceIds).map((sliceId) => listLlmRequestSlices({
          identityKey: 'xiaoni',
          ...sourceLookup,
          sliceId,
          summaryOnly: true,
          limit: 1
        }) as Promise<any[]>)).then((rows) => rows.flat()),
        Promise.all(Array.from(sliceIds).map((sliceId) => listToolExecutions({
          identityKey: 'xiaoni',
          ...sourceLookup,
          llmRequestSliceId: sliceId,
          chronological: true,
          limit: 20
        }) as Promise<any[]>)).then((rows) => rows.flat()),
        focusedToolCallId
          ? listAgentStackItems({
            identityKey: 'xiaoni',
            ...sourceLookup,
            toolCallId: focusedToolCallId,
            chronological: true,
            limit: 20
          }) as Promise<any[]>
          : Promise.resolve([]),
        Promise.all(Array.from(sliceIds).map((sliceId) => listAgentStackItems({
          identityKey: 'xiaoni',
          ...sourceLookup,
          llmRequestSliceId: sliceId,
          chronological: true,
          limit: 50
        }) as Promise<any[]>)).then((rows) => rows.flat())
      ]);
      stackSliceRows = dedupeBy(focusedSlices, (row) => row?.sliceId || row?.slice_id || row?.id);
      stackToolExecutionRows = dedupeBy([...focusedTools, ...sliceTools], (row) => row?.executionId || row?.execution_id || row?.id);
      stackItemRows = dedupeBy([...toolItems, ...sliceItems], (row) => row?.id || row?.eventId || row?.event_id);
    } catch (error) {
      logger.warn('Trace query failed: focused Xiaoni stack trace', {
        error: error instanceof Error ? error.message : String(error),
        focusedSliceId,
        focusedToolCallId,
        traceId,
        runId
      });
      return null;
    }
  } else {
    [
      stackSliceRows,
      stackToolExecutionRows,
      stackItemRows
    ] = await Promise.all([
      listStackTraceRows(
        'Xiaoni stack trace LLM slices',
        target,
        logger,
        (input) => listLlmRequestSlices({ ...input, summaryOnly: true }) as Promise<any[]>,
        (row: any) => row?.sliceId || row?.slice_id || row?.id
      ),
      listStackTraceRows(
        'Xiaoni stack trace tool executions',
        target,
        logger,
        (input) => listToolExecutions(input) as Promise<any[]>,
        (row: any) => row?.executionId || row?.execution_id || row?.id
      ),
      listStackTraceRows(
        'Xiaoni stack trace items',
        target,
        logger,
        async (input) => (await Promise.all(
          ['runtime_input', 'function_call', 'function_call_output'].map((itemKind) => listAgentStackItems({
            ...input,
            itemKind,
            limit: 1000
          }) as Promise<any[]>)
        )).flat(),
        (row: any) => row?.id || row?.eventId || row?.event_id,
        1000
      )
    ]);
  }

  if (stackSliceRows.length === 0 && stackToolExecutionRows.length === 0 && stackItemRows.length === 0) {
    return null;
  }

  const stackSlices = (stackSliceRows as any[])
    .map((row) => normalizeStackLlmSlice(row, { truncateLargeFields: true }))
    .sort((left, right) => compareTimes(left.started_at, right.started_at)
      || ((left.agent_turn || 0) - (right.agent_turn || 0)));
  const stackToolExecutions = (stackToolExecutionRows as any[])
    .map(normalizeStackToolExecution)
    .map((tool) => trimTraceEvidence(tool, {
      arguments: 'tool.arguments',
      raw_arguments: 'tool.raw_arguments',
      result: 'tool.result',
      metadata: 'tool.metadata'
    }));
  const stackItems = (Array.isArray(stackItemRows) ? stackItemRows as any[] : [])
    .map((item) => trimTraceEvidence(item, {
      content: 'stack_item.content',
      metadata: 'stack_item.metadata'
    }));
  const spanRecords: TraceSpanDto[] = [];
  const rootSpanId = `trace-root:${traceId || runId}`;

  const rootStartedAt = [
    ...stackSlices.map((slice) => slice.started_at),
    ...stackToolExecutions.map((tool) => tool.started_at),
    ...stackItems.map((item) => toIsoString(item.createdAt ?? item.created_at))
  ].filter(Boolean).sort()[0] || null;
  const rootEndedAt = [
    ...stackSlices.map((slice) => slice.completed_at),
    ...stackToolExecutions.map((tool) => tool.completed_at),
    ...stackItems.map((item) => toIsoString(item.updatedAt ?? item.updated_at ?? item.createdAt ?? item.created_at))
  ].filter(Boolean).sort().slice(-1)[0] || rootStartedAt;
  const rootStatus = [...stackSlices, ...stackToolExecutions].some((row) => row.status === 'error') ? 'error' : 'ok';

  spanRecords.push(createSpan({
    span_id: rootSpanId,
    parent_span_id: null,
    trace_id: traceId || runId || 'xiaoni-stack-trace',
    conversation_id: null,
    name: 'xiaoni.stack_trace',
    kind: 'internal',
    status_code: rootStatus,
    status_message: null,
    started_at: rootStartedAt,
    ended_at: rootEndedAt,
    duration_ms: getDurationMs(rootStartedAt, rootEndedAt),
    summary: safePreview(`Xiaoni stack trace ${traceId || runId}`),
    attributes: {
      'semantic.role': 'trace_root',
      'semantic.display_name': 'Xiaoni Stack Trace',
      'trace.id': traceId || null,
      'trace.run_id': runId || null
    },
    input: null,
    output: {
      stack_slice_count: stackSlices.length,
      tool_execution_count: stackToolExecutions.length,
      stack_item_count: stackItems.length
    },
    evidence: {
      trace_id: traceId || null,
      run_id: runId || null
    },
    events: [],
    links: [],
    confidence: 'observed',
    source_ref: traceId || runId
  }));

  const stackSliceSpanIdBySliceId = new Map<string, string>();
  stackSlices.forEach((slice) => {
    const spanId = `stack-slice:${slice.slice_id}`;
    if (slice.slice_id) {
      stackSliceSpanIdBySliceId.set(slice.slice_id, spanId);
    }
    const providerCall = normalizeStackSliceProviderCall(slice);
    const hasProviderRequest = canRepresentProviderRequest(providerCall);
    spanRecords.push(createSpan({
      span_id: spanId,
      parent_span_id: rootSpanId,
      trace_id: traceId || runId || 'xiaoni-stack-trace',
      conversation_id: null,
      name: 'llm.request_slice',
      kind: 'client',
      status_code: slice.status,
      status_message: null,
      started_at: slice.started_at,
      ended_at: slice.completed_at,
      duration_ms: slice.duration_ms,
      summary: safePreview(slice.canonical_response || slice.raw_response || slice.output_items),
      attributes: {
        'semantic.role': 'generation',
        'semantic.actor': 'xiaoni',
        'semantic.display_name': `${slice.model_provider || 'model'} / ${slice.model_name || 'unknown'}`,
        'stack.slice_id': slice.slice_id,
        'stack.input_start_index': slice.input_start_index,
        'stack.input_end_index': slice.input_end_index,
        'stack.output_start_index': slice.output_start_index,
        'stack.output_end_index': slice.output_end_index,
        'llm.model_name': slice.model_name,
        'llm.model_provider': slice.model_provider,
        'llm.llm_call_id': slice.llm_call_id,
        'usage.input_tokens': slice.input_tokens,
        'usage.output_tokens': slice.output_tokens,
        'trace.agent_turn': slice.agent_turn,
        'provider.request_count': hasProviderRequest ? 1 : 0,
        'provider.hosts': hasProviderRequest ? [syntheticProviderHost(providerCall)] : []
      },
      input: {
        canonical_request: slice.canonical_request,
        wire_request: slice.wire_request,
        input_range: {
          start: slice.input_start_index,
          end: slice.input_end_index
        }
      },
      output: {
        canonical_response: slice.canonical_response,
        wire_response: slice.wire_response,
        raw_response: slice.raw_response,
        output_items: slice.output_items,
        token_usage: slice.token_usage
      },
      evidence: {
        ...slice,
        stack_items: stackItems.filter((item) => (item.llmRequestSliceId || item.llm_request_slice_id) === slice.slice_id),
        synthetic_provider_request: hasProviderRequest
          ? {
              span_id: buildSyntheticProviderRequestSpanId(providerCall),
              source: 'llm_request_slices.wire_request/wire_response',
              slice_id: providerCall.slice_id || null,
              llm_call_id: providerCall.llm_call_id || null,
              wire_provider_format: providerCall.wire_provider_format || null
            }
          : null
      },
      events: [],
      links: [],
      confidence: 'observed',
      source_ref: slice.slice_id
    }));

    if (hasProviderRequest) {
      spanRecords.push(buildStackProviderRequestSpan({
        providerCall,
        parentSpanId: spanId,
        traceId: traceId || runId || 'xiaoni-stack-trace',
        conversationId: null,
        agentTurn: slice.agent_turn
      }));
    }
  });

  stackToolExecutions.forEach((tool) => {
    const spanId = tool.tool_call_id ? `tool-call:${tool.tool_call_id}` : `tool-exec:${tool.execution_id || tool.id}`;
    spanRecords.push(createSpan({
      span_id: spanId,
      parent_span_id: (tool.llm_request_slice_id && stackSliceSpanIdBySliceId.get(tool.llm_request_slice_id))
        || rootSpanId,
      trace_id: traceId || runId || 'xiaoni-stack-trace',
      conversation_id: null,
      name: 'tool.execution',
      kind: 'internal',
      status_code: tool.status,
      status_message: tool.error_message || null,
      started_at: tool.started_at,
      ended_at: tool.completed_at,
      duration_ms: tool.duration_ms,
      summary: safePreview(tool.result || tool.error_message || tool.arguments),
      attributes: {
        'semantic.role': 'invocation',
        'semantic.capability': tool.tool_name,
        'semantic.display_name': tool.tool_name,
        'tool.name': tool.tool_name,
        'tool.side_effect': tool.side_effect,
        'tool.execution_id': tool.execution_id,
        'stack.slice_id': tool.llm_request_slice_id,
        'stack.call_item_id': tool.stack_call_item_id,
        'stack.output_item_id': tool.stack_output_item_id,
        'trace.agent_turn': tool.agent_turn
      },
      input: {
        arguments: tool.arguments,
        raw_arguments: tool.raw_arguments
      },
      output: {
        result: tool.result,
        error_message: tool.error_message
      },
      evidence: tool,
      events: [],
      links: [],
      confidence: 'observed',
      source_ref: tool.execution_id || tool.id
    }));
  });

  spanRecords.push(createSpan({
    span_id: `terminal:${traceId || runId}`,
    parent_span_id: rootSpanId,
    trace_id: traceId || runId || 'xiaoni-stack-trace',
    conversation_id: null,
    name: 'terminal.outcome',
    kind: 'consumer',
    status_code: rootStatus,
    status_message: null,
    started_at: rootEndedAt,
    ended_at: rootEndedAt,
    duration_ms: getDurationMs(rootStartedAt, rootEndedAt),
    summary: safePreview(rootStatus === 'error' ? 'Stack trace contains failed span' : 'Stack trace completed'),
    attributes: {
      'semantic.role': 'terminal'
    },
    input: {
      started_at: rootStartedAt,
      ended_at: rootEndedAt
    },
    output: {
      status: rootStatus
    },
    evidence: {
      trace_id: traceId || null,
      run_id: runId || null
    },
    events: [],
    links: [],
    confidence: 'derived',
    source_ref: traceId || runId
  }));

  assignTreeMetadata(spanRecords, rootSpanId);
  const orderedSpans = [...spanRecords].sort((left, right) => left.sort_key.localeCompare(right.sort_key));
  const firstErrorSpan = orderedSpans.find((span) => span.status_code === 'error') || null;
  const bottleneckSpan = [...orderedSpans]
    .filter((span) => typeof span.duration_ms === 'number')
    .sort((left, right) => (right.duration_ms || 0) - (left.duration_ms || 0))[0] || null;
  const dataQuality = {
    trace_headers_propagated: 'missing',
    llm_logs_complete: stackSlices.length === 0 ? 'missing' : (stackSlices.every((slice) => slice.started_at && slice.completed_at) ? 'complete' : 'partial'),
    tool_logs_complete: stackToolExecutions.length === 0 ? 'missing' : (stackToolExecutions.every((tool) => tool.started_at) ? 'complete' : 'partial'),
    http_logs_complete: 'missing',
    timeline_complete: 'partial',
    identity_trace_lite: 'missing',
    agent_stack_complete: stackSlices.length > 0 || stackItems.length > 0 ? 'complete' : 'missing'
  };
  const tokenSummary = stackSlices.reduce((summary, call) => {
    const inputTokens = toNumber(call.token_usage?.input_tokens ?? call.input_tokens) ?? 0;
    const outputTokens = toNumber(call.token_usage?.output_tokens ?? call.output_tokens) ?? 0;
    const cachedInputTokens = extractCachedInputTokens(call.token_usage);
    return {
      input_tokens: summary.input_tokens + inputTokens,
      output_tokens: summary.output_tokens + outputTokens,
      total_tokens: summary.total_tokens + inputTokens + outputTokens,
      cached_input_tokens: summary.cached_input_tokens + cachedInputTokens
    };
  }, {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cached_input_tokens: 0
  });

  return {
    conversation_id: null,
    batch_id: null,
    trace: {
      trace_id: traceId || runId || 'xiaoni-stack-trace',
      root_span_id: rootSpanId,
      status: rootStatus,
      started_at: rootStartedAt,
      ended_at: rootEndedAt,
      duration_ms: getDurationMs(rootStartedAt, rootEndedAt),
      span_count: orderedSpans.length,
      error_count: orderedSpans.filter((span) => span.status_code === 'error').length,
      summary: safePreview(`Xiaoni stack trace ${traceId || runId}`),
      first_error: firstErrorSpan ? {
        span_id: firstErrorSpan.span_id,
        title: firstErrorSpan.name,
        summary: firstErrorSpan.summary
      } : null,
      bottleneck: bottleneckSpan ? {
        span_id: bottleneckSpan.span_id,
        title: bottleneckSpan.name,
        duration_ms: bottleneckSpan.duration_ms
      } : null,
      token_summary: tokenSummary
    },
    spans: orderedSpans,
    raw_evidence: {
      conversation: null,
      websocket_logs: [],
      timeline_events: [],
      llm_calls: [],
      tool_calls: [],
      http_logs: [],
      agent_stack_items: stackItems,
      llm_request_slices: stackSlices,
      tool_executions: stackToolExecutions,
      llm_jobs: [],
      queue_messages: [],
      runtime_identity_activation_traces: [],
      identity_evidence_refs: []
    },
    data_quality: {
      ...dataQuality,
      overall: Object.values(dataQuality).every((value) => value === 'complete') ? 'complete' : 'partial'
    }
  };
}

function resolveStackRawTraceLookup(target: StackTraceTarget, spanId: string): { llmCallId?: string; sliceId?: string } | null {
  const syntheticProviderRequest = spanId ? parseSyntheticProviderRequestSpanId(spanId) : null;
  if (syntheticProviderRequest?.llmCallId) {
    return { llmCallId: syntheticProviderRequest.llmCallId };
  }
  if (syntheticProviderRequest?.sliceId) {
    return { sliceId: syntheticProviderRequest.sliceId };
  }
  if (spanId.startsWith('stack-slice:')) {
    return { sliceId: spanId.slice('stack-slice:'.length) };
  }
  if (spanId.startsWith('compression-fork-slice:')) {
    return { sliceId: spanId.slice('compression-fork-slice:'.length) };
  }
  if (spanId.startsWith('subconscious-fork-slice:')) {
    return { sliceId: spanId.slice('subconscious-fork-slice:'.length) };
  }
  if (spanId.startsWith('image-vision-fork-slice:')) {
    return { sliceId: spanId.slice('image-vision-fork-slice:'.length) };
  }
  if (spanId.startsWith('llm-call:')) {
    return { llmCallId: spanId.slice('llm-call:'.length) };
  }
  if (target.llmRequestSliceId) {
    return { sliceId: target.llmRequestSliceId };
  }
  const targetSpanId = target.spanId || '';
  if (targetSpanId && targetSpanId !== spanId) {
    return resolveStackRawTraceLookup({ ...target, spanId: null }, targetSpanId);
  }
  return null;
}

function normalizeCodexProviderUsageEventAsSlice(row: any) {
  const eventId = row.eventId ?? row.event_id ?? row.sliceId ?? row.slice_id ?? row.id;
  return {
    ...row,
    sliceId: eventId,
    slice_id: eventId,
    llmCallId: row.llmCallId ?? row.llm_call_id ?? null,
    llm_call_id: row.llmCallId ?? row.llm_call_id ?? null,
    traceId: row.traceId ?? row.trace_id ?? null,
    trace_id: row.traceId ?? row.trace_id ?? null,
    runId: row.runId ?? row.run_id ?? null,
    run_id: row.runId ?? row.run_id ?? null,
    conversationId: row.conversationId ?? row.conversation_id ?? null,
    conversation_id: row.conversationId ?? row.conversation_id ?? null,
    agentTurn: null,
    agent_turn: null,
    canonicalRequest: row.canonicalRequest ?? row.canonical_request ?? {},
    canonical_request: row.canonicalRequest ?? row.canonical_request ?? {},
    wireRequest: row.wireRequest ?? row.wire_request ?? null,
    wire_request: row.wireRequest ?? row.wire_request ?? null,
    canonicalResponse: row.canonicalResponse ?? row.canonical_response ?? null,
    canonical_response: row.canonicalResponse ?? row.canonical_response ?? null,
    wireResponse: row.wireResponse ?? row.wire_response ?? null,
    wire_response: row.wireResponse ?? row.wire_response ?? null,
    rawResponse: row.rawResponse ?? row.raw_response ?? null,
    raw_response: row.rawResponse ?? row.raw_response ?? null,
    outputItems: row.outputItems ?? row.output_items ?? [],
    output_items: row.outputItems ?? row.output_items ?? [],
    tokenUsage: row.tokenUsage ?? row.token_usage ?? {},
    token_usage: row.tokenUsage ?? row.token_usage ?? {},
    modelName: row.modelName ?? row.model_name ?? null,
    model_name: row.modelName ?? row.model_name ?? null,
    modelProvider: row.modelProvider ?? row.model_provider ?? null,
    model_provider: row.modelProvider ?? row.model_provider ?? null,
    requestFormatVersion: row.requestFormatVersion ?? row.request_format_version ?? null,
    request_format_version: row.requestFormatVersion ?? row.request_format_version ?? null,
    wireProviderFormat: row.wireProviderFormat ?? row.wire_provider_format ?? null,
    wire_provider_format: row.wireProviderFormat ?? row.wire_provider_format ?? null,
    processingTimeMs: row.processingTimeMs ?? row.processing_time_ms ?? null,
    processing_time_ms: row.processingTimeMs ?? row.processing_time_ms ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt ?? row.created_at ?? null,
    created_at: row.createdAt ?? row.created_at ?? null,
    completedAt: row.completedAt ?? row.completed_at ?? null,
    completed_at: row.completedAt ?? row.completed_at ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null,
    updated_at: row.updatedAt ?? row.updated_at ?? null,
    status: row.status ?? null
  };
}

async function buildCodexProviderUsageRawTrace(
  logger: winston.Logger,
  target: StackTraceTarget,
  spanId: string
): Promise<RawProviderTraceDto | null> {
  const lookup = resolveStackRawTraceLookup(target, spanId);
  const traceId = firstNonEmptyString(target.traceId);
  const runId = firstNonEmptyString(target.internalExecutionLeaseId);
  const sourceKind = firstNonEmptyString(target.sourceKind);
  const forkRunId = firstNonEmptyString(target.forkRunId);
  const targetEventId = firstNonEmptyString(target.llmRequestSliceId);
  const eventId = targetEventId?.startsWith('codex-provider:') ? targetEventId : lookup?.sliceId;
  const sourceId = sourceKind === 'cache_heartbeat' ? null : forkRunId;
  try {
    const rows = await listCodexProviderUsageEvents({
      identityKey: 'xiaoni',
      ...(sourceKind ? { sourceKind } : {}),
      ...(sourceId ? { sourceId } : {}),
      ...(traceId ? { traceId } : {}),
      ...(runId ? { runId } : {}),
      ...(eventId ? { eventId } : {}),
      ...(lookup?.llmCallId ? { llmCallId: lookup.llmCallId } : {}),
      rawTraceOnly: true,
      limit: 1
    }) as any[];
    const row = rows[0] as any;
    if (!row) {
      return null;
    }
    const slice = normalizeStackLlmSlice(normalizeCodexProviderUsageEventAsSlice(row), { includeRawWireText: true });
    const providerCall = normalizeStackSliceProviderCall(slice);
    if (!hasProviderWirePayload(providerCall)) {
      return null;
    }
    return buildRawProviderTraceFromProviderCall(
      providerCall,
      spanId || target.spanId || null,
      'codex_provider_usage_events.provider_exchange'
    );
  } catch (error) {
    logger.warn('Codex provider usage raw trace query failed', {
      error: error instanceof Error ? error.message : String(error),
      traceId,
      runId,
      spanId,
      lookup,
      sourceKind
    });
    return null;
  }
}

export async function buildStackRawProviderTrace(
  logger: winston.Logger,
  target: StackTraceTarget,
  spanId: string
): Promise<RawProviderTraceDto | null> {
  if (firstNonEmptyString(target.sourceKind) === 'image_task' || spanId.startsWith('provider-request:image-task:')) {
    return buildImageTaskRawProviderTrace(logger, target, spanId);
  }

  if (
    firstNonEmptyString(target.sourceKind) === 'cache_heartbeat'
    || (target.llmRequestSliceId || '').startsWith('codex-provider:')
  ) {
    return buildCodexProviderUsageRawTrace(logger, target, spanId);
  }

  const lookup = resolveStackRawTraceLookup(target, spanId);
  if (!lookup) {
    return null;
  }

  const traceId = firstNonEmptyString(target.traceId);
  const runId = firstNonEmptyString(target.internalExecutionLeaseId);
  const sourceKind = firstNonEmptyString(target.sourceKind);
  const forkRunId = firstNonEmptyString(target.forkRunId);
  const baseLookup = {
    identityKey: 'xiaoni',
    ...(traceId ? { traceId } : {}),
    ...(runId ? { runId } : {}),
    ...(sourceKind ? { sourceKind } : {}),
    ...(forkRunId ? { forkRunId } : {})
  };

  try {
    const rows = await listLlmRequestSlices({
      ...baseLookup,
      ...lookup,
      rawTraceOnly: true,
      limit: 1
    }) as any[];
    const row = rows[0] as any;
    if (!row) {
      return null;
    }

    const slice = normalizeStackLlmSlice(row, { includeRawWireText: true });
    const providerCall = normalizeStackSliceProviderCall(slice);
    if (!hasProviderWirePayload(providerCall)) {
      return null;
    }

    return buildRawProviderTraceFromProviderCall(
      providerCall,
      spanId || target.spanId || null,
      sourceKind === 'compression_fork'
        ? 'core_memory_compression_fork_slices.provider_exchange'
        : sourceKind === 'subconscious_agent_fork'
          ? 'subconscious_agent_fork_slices.provider_exchange'
        : sourceKind === 'image_vision_fork'
          ? 'image_vision_fork_slices.provider_exchange'
          : 'llm_request_slices.provider_exchange'
    );
  } catch (error) {
    logger.warn('Stack raw provider trace query failed', {
      error: error instanceof Error ? error.message : String(error),
      traceId,
      runId,
      spanId,
      lookup
    });
    return null;
  }
}

export async function buildStackTraceSpanDetail(
  logger: winston.Logger,
  target: StackTraceTarget,
  spanId: string
): Promise<TraceSpanDetailDto | null> {
  const traceId = firstNonEmptyString(target.traceId);
  const runId = firstNonEmptyString(target.internalExecutionLeaseId);
  const sourceKind = firstNonEmptyString(target.sourceKind);
  const forkRunId = firstNonEmptyString(target.forkRunId);
  const baseLookup = {
    identityKey: 'xiaoni',
    ...(traceId ? { traceId } : {}),
    ...(runId ? { runId } : {}),
    ...(sourceKind ? { sourceKind } : {}),
    ...(forkRunId ? { forkRunId } : {})
  };

  try {
    if (spanId.startsWith('stack-slice:')) {
      const sliceId = spanId.slice('stack-slice:'.length);
      const rows = await listLlmRequestSlices({
        ...baseLookup,
        sliceId,
        limit: 1
      }) as any[];
      const row = rows[0] as any;
      if (!row) {
        return null;
      }
      const slice = normalizeStackLlmSlice(row, { includeRawWireText: true });
      return {
        input: {
          canonical_request: slice.canonical_request,
          wire_request: slice.wire_request,
          input_range: {
            start: slice.input_start_index,
            end: slice.input_end_index
          }
        },
        output: {
          canonical_response: slice.canonical_response,
          wire_response: slice.wire_response,
          raw_response: slice.raw_response,
          output_items: slice.output_items,
          token_usage: slice.token_usage
        },
        evidence: slice
      };
    }

    if (spanId.startsWith('tool-call:')) {
      const toolCallId = spanId.slice('tool-call:'.length);
      const rows = await listToolExecutions({
        ...baseLookup,
        toolCallId,
        limit: 1
      }) as any[];
      const row = rows[0] as any;
      if (!row) {
        return null;
      }
      const tool = normalizeStackToolExecution(row);
      return {
        input: {
          arguments: tool.arguments,
          raw_arguments: tool.raw_arguments
        },
        output: {
          result: tool.result,
          error_message: tool.error_message
        },
        evidence: tool
      };
    }

    if (spanId.startsWith('llm-call:')) {
      const llmCallId = spanId.slice('llm-call:'.length);
      const rows = await listLlmRequestSlices({
        ...baseLookup,
        llmCallId,
        limit: 1
      }) as any[];
      const row = rows[0] as any;
      if (!row) {
        return null;
      }
      const slice = normalizeStackLlmSlice(row, { includeRawWireText: true });
      return {
        input: {
          canonical_request: slice.canonical_request,
          wire_request: slice.wire_request,
          input_range: {
            start: slice.input_start_index,
            end: slice.input_end_index
          }
        },
        output: {
          canonical_response: slice.canonical_response,
          wire_response: slice.wire_response,
          raw_response: slice.raw_response,
          output_items: slice.output_items,
          token_usage: slice.token_usage
        },
        evidence: slice
      };
    }

    const syntheticProviderRequest = parseSyntheticProviderRequestSpanId(spanId);
    if (syntheticProviderRequest) {
      const lookupId = syntheticProviderRequest.llmCallId || syntheticProviderRequest.sliceId;
      if (!lookupId) {
        return null;
      }
      const rows = await listLlmRequestSlices({
        ...baseLookup,
        ...(syntheticProviderRequest.llmCallId ? { llmCallId: lookupId } : { sliceId: lookupId }),
        limit: 1
      }) as any[];
      const row = rows[0] as any;
      if (!row) {
        return null;
      }
      const slice = normalizeStackLlmSlice(row, { includeRawWireText: true });
      const providerCall = normalizeStackSliceProviderCall(slice);
      if (!hasProviderWirePayload(providerCall)) {
        return null;
      }
      return {
        input: {
          headers: redactSensitiveHeaders(providerCall.request_headers),
          body: providerCall.wire_request,
          raw_body: providerCall.wire_request_raw_text || null,
          method: 'POST',
          upstream_url: providerCall.request_url || null,
          body_source: 'llm_request_slices.wire_request'
        },
        output: {
          status_code: providerCall.response_status ?? (providerCall.error_message ? null : 200),
          headers: redactSensitiveHeaders(providerCall.response_headers),
          body: providerCall.wire_response,
          raw_body: providerCall.wire_response_raw_text || null,
          body_format: 'json',
          body_source: 'llm_request_slices.wire_response',
          error_message: providerCall.error_message
        },
        evidence: {
          synthetic: true,
          source: 'llm_request_slices.wire_request/wire_response',
          slice_id: providerCall.slice_id || null,
          llm_call_id: providerCall.llm_call_id || null,
          model_provider: providerCall.model_provider || null,
          wire_provider_format: providerCall.wire_provider_format || null,
          request_format_version: providerCall.request_format_version || null,
          request_headers: redactSensitiveHeaders(providerCall.request_headers),
          request_url: providerCall.request_url || null,
          response_headers: redactSensitiveHeaders(providerCall.response_headers),
          response_status: providerCall.response_status ?? (providerCall.error_message ? null : 200),
          response_status_text: providerCall.response_status_text || null
        }
      };
    }
  } catch (error) {
    logger.warn('Stack trace span detail query failed', {
      error: error instanceof Error ? error.message : String(error),
      traceId,
      runId,
      spanId
    });
    return null;
  }

  logger.debug('Stack trace span detail not required for span', { traceId, runId, spanId });
  return null;
}
