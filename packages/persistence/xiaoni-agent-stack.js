'use strict';

const { randomUUID } = require('crypto');
const {
  STORAGE_TIMEZONE,
  parseInstantValue,
} = require('./time');

const USAGE_BUCKETS = new Set(['call', 'hour', 'day', 'month']);
const DEFAULT_USAGE_MAX_POINTS = 1200;
const MIN_USAGE_MAX_POINTS = 100;
const MAX_USAGE_MAX_POINTS = 2000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const EAST8_OFFSET_MS = 8 * HOUR_MS;
const USAGE_SEARCH_MAX_WINDOW_MS = 30 * DAY_MS;
const USAGE_SEARCH_MAX_HITS = 120;
const USAGE_ROLLUP_BUCKETS = ['hour', 'day', 'month'];
const USAGE_ROLLUP_VERSION = 3;
const USAGE_ROLLUP_STATE_KEY = '*';
const USAGE_SOURCE_MAIN = 'main';
const USAGE_SOURCE_COMPRESSION_FORK = 'compression_fork';
const USAGE_SOURCE_SUBCONSCIOUS_FORK = 'subconscious_agent_fork';
const USAGE_SOURCE_CODEX_PROVIDER = 'codex_provider';
const USAGE_SOURCE_IMAGE_VISION_FORK = 'image_vision_fork';
const USAGE_SOURCE_IMAGE_GENERATION = 'image_generation';
const USAGE_SOURCE_IMAGE_EDIT = 'image_edit';
const USAGE_SOURCE_IMAGE_PROMPT_ASSISTANT = 'image_prompt_assistant';

function normalizeDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === 'string' ? value : String(value);
}

function normalizeDateFilter(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeValue(value) {
  if (value === null || typeof value === 'undefined') {
    return value;
  }
  if (typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) {
    return normalizeDate(value);
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry)])
    );
  }
  return value;
}

function normalizeJsonObject(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return normalizeValue(value);
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? normalizeValue(parsed)
        : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function normalizeJsonArray(value, fallback = []) {
  if (Array.isArray(value)) {
    return normalizeValue(value);
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? normalizeValue(parsed) : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function normalizeBigIntId(value) {
  if (value === null || typeof value === 'undefined' || value === '') {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true' || value === '1';
  }
  return Boolean(value);
}

function normalizeInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function usageTokenSql(alias = 'token_usage') {
  const field = `${alias}::jsonb`;
  return {
    input: `COALESCE(
      NULLIF(${field}->>'input_tokens', '')::numeric,
      NULLIF(${field}->>'inputTokens', '')::numeric,
      NULLIF(${field}->>'prompt_tokens', '')::numeric,
      NULLIF(${field}->>'promptTokens', '')::numeric,
      0
    )`,
    cached: `COALESCE(
      NULLIF(${field}->>'cached_input_tokens', '')::numeric,
      NULLIF(${field}->>'cachedInputTokens', '')::numeric,
      NULLIF(${field}#>>'{input_tokens_details,cached_tokens}', '')::numeric,
      NULLIF(${field}#>>'{inputTokensDetails,cachedTokens}', '')::numeric,
      NULLIF(${field}#>>'{prompt_tokens_details,cached_tokens}', '')::numeric,
      NULLIF(${field}#>>'{promptTokensDetails,cachedTokens}', '')::numeric,
      NULLIF(${field}#>>'{raw_usage,input_tokens_details,cached_tokens}', '')::numeric,
      NULLIF(${field}#>>'{rawUsage,inputTokensDetails,cachedTokens}', '')::numeric,
      0
    )`,
    output: `COALESCE(
      NULLIF(${field}->>'output_tokens', '')::numeric,
      NULLIF(${field}->>'outputTokens', '')::numeric,
      NULLIF(${field}->>'completion_tokens', '')::numeric,
      NULLIF(${field}->>'completionTokens', '')::numeric,
      0
    )`
  };
}

function parseUsageDate(value) {
  if (!value) {
    return null;
  }
  const parsed = value instanceof Date ? value : parseInstantValue(String(value));
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

function normalizeUsageWindow(input = {}, dataBounds = {}) {
  const warnings = [];
  let startTime = parseUsageDate(input.startTime ?? input.start_time);
  let endTime = parseUsageDate(input.endTime ?? input.end_time);
  const now = new Date();

  if ((input.startTime || input.start_time) && !startTime) {
    warnings.push('invalid_start_time_ignored');
  }
  if ((input.endTime || input.end_time) && !endTime) {
    warnings.push('invalid_end_time_ignored');
  }

  if (startTime && !endTime) {
    endTime = now;
    warnings.push('partial_custom_end_time_defaulted');
  }
  if (!startTime && endTime) {
    startTime = new Date(endTime.getTime() - DAY_MS);
    warnings.push('partial_custom_start_time_defaulted');
  }

  if (!startTime && dataBounds.firstAt) {
    startTime = parseUsageDate(dataBounds.firstAt);
  }
  if (!endTime && dataBounds.lastAt) {
    endTime = parseUsageDate(dataBounds.lastAt);
  }

  if (startTime && endTime && startTime.getTime() > endTime.getTime()) {
    const nextStart = endTime;
    endTime = startTime;
    startTime = nextStart;
    warnings.push('time_window_swapped');
  }

  return { startTime, endTime, warnings };
}

function startOfEast8DayMs(value) {
  const shifted = value.getTime() + EAST8_OFFSET_MS;
  const day = new Date(shifted);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - EAST8_OFFSET_MS;
}

function countUsageBuckets(startTime, endTime, bucket) {
  if (!startTime || !endTime) {
    return 0;
  }
  const startMs = startTime.getTime();
  const endMs = endTime.getTime();
  if (endMs < startMs) {
    return 0;
  }
  if (bucket === 'hour') {
    return Math.max(1, Math.ceil((endMs - startMs) / HOUR_MS) + 1);
  }
  if (bucket === 'day') {
    const startDay = startOfEast8DayMs(startTime);
    const endDay = startOfEast8DayMs(endTime);
    return Math.max(1, Math.floor((endDay - startDay) / DAY_MS) + 1);
  }
  if (bucket === 'month') {
    const startShifted = new Date(startTime.getTime() + EAST8_OFFSET_MS);
    const endShifted = new Date(endTime.getTime() + EAST8_OFFSET_MS);
    return Math.max(1, (endShifted.getUTCFullYear() - startShifted.getUTCFullYear()) * 12 + endShifted.getUTCMonth() - startShifted.getUTCMonth() + 1);
  }
  return 0;
}

function resolveUsageBucket({ requestedBucket, totalCount, startTime, endTime, maxPoints, warnings }) {
  if (requestedBucket === 'call' && totalCount <= maxPoints) {
    return 'call';
  }
  if (requestedBucket === 'call') {
    warnings.push('call_bucket_too_dense');
  }
  const ordered = requestedBucket === 'month'
    ? ['month']
    : requestedBucket === 'day'
      ? ['day', 'month']
      : requestedBucket === 'hour'
        ? ['hour', 'day', 'month']
        : ['hour', 'day', 'month'];
  for (const bucket of ordered) {
    if (countUsageBuckets(startTime, endTime, bucket) <= maxPoints) {
      return bucket;
    }
  }
  warnings.push('month_bucket_too_dense');
  return 'month';
}

function bucketSqlExpression(bucket) {
  if (bucket === 'hour') {
    return {
      start: "date_trunc('hour', created_at)",
      end: "date_trunc('hour', created_at) + INTERVAL '1 hour'"
    };
  }
  if (bucket === 'day') {
    return {
      start: "date_trunc('day', created_at)",
      end: "date_trunc('day', created_at) + INTERVAL '1 day'"
    };
  }
  return {
    start: "date_trunc('month', created_at)",
    end: "date_trunc('month', created_at) + INTERVAL '1 month'"
  };
}

function buildUsageTimeWhere(startTime, endTime) {
  const clauses = [];
  const params = [];
  if (startTime) {
    clauses.push('created_at >= ?::timestamptz');
    params.push(startTime);
  }
  if (endTime) {
    clauses.push('created_at <= ?::timestamptz');
    params.push(endTime);
  }
  return { clause: clauses.length ? `AND ${clauses.join(' AND ')}` : '', params };
}

function buildUsageRollupWhere(startTime, endTime) {
  const clauses = [];
  const params = [];
  if (startTime) {
    clauses.push('bucket_end >= ?::timestamptz');
    params.push(startTime);
  }
  if (endTime) {
    clauses.push('bucket_start <= ?::timestamptz');
    params.push(endTime);
  }
  return { clause: clauses.length ? `AND ${clauses.join(' AND ')}` : '', params };
}

function normalizeUsagePoint(row, bucket) {
  const inputTokens = normalizeNumber(row.input_tokens);
  const cachedTokens = normalizeNumber(row.cached_tokens);
  const outputTokens = normalizeNumber(row.output_tokens);
  const totalTokens = inputTokens + outputTokens;
  const callCount = normalizeNumber(row.call_count, bucket === 'call' ? 1 : 0);
  const bucketStart = normalizeDate(row.bucket_start || row.timestamp);
  const bucketEnd = normalizeDate(row.bucket_end || row.timestamp);
  const llmRequestSliceId = firstString(row.llm_request_slice_id, row.slice_id);
  const topSliceId = firstString(row.top_llm_request_slice_id, llmRequestSliceId);
  const sourceKind = firstString(row.source_kind, USAGE_SOURCE_MAIN);
  const forkRunId = firstString(row.fork_run_id);
  const topSourceKind = firstString(row.top_source_kind, sourceKind);
  const topForkRunId = firstString(row.top_fork_run_id, forkRunId);
  const anchorEventId = usageAnchorEventId(topSliceId, topSourceKind);
  const topInputTokens = normalizeNumber(row.top_input_tokens, inputTokens);
  const topCachedTokens = normalizeNumber(row.top_cached_tokens, cachedTokens);
  const topOutputTokens = normalizeNumber(row.top_output_tokens, outputTokens);
  const topTimestamp = normalizeDate(row.top_timestamp || row.timestamp || row.bucket_start);
  const timestamp = bucket === 'call'
    ? normalizeDate(row.timestamp || row.bucket_start)
    : bucketStart;
  return {
    key: firstString(row.key) || `${bucket}:${timestamp}`,
    timestamp,
    bucketStart,
    bucketEnd,
    callCount,
    inputTokens,
    cachedTokens,
    outputTokens,
    totalTokens,
    cacheRatio: inputTokens > 0 ? cachedTokens / inputTokens : null,
    sourceKind,
    forkRunId,
    anchorEventId,
    llmRequestSliceId: topSliceId,
    llmCallId: firstString(row.top_llm_call_id, row.llm_call_id),
    traceId: firstString(row.top_trace_id, row.trace_id),
    topEvent: topSliceId ? {
      eventId: anchorEventId,
      llmRequestSliceId: topSliceId,
      sourceKind: topSourceKind,
      forkRunId: topForkRunId,
      timestamp: topTimestamp,
      inputTokens: topInputTokens,
      cachedTokens: topCachedTokens,
      outputTokens: topOutputTokens
    } : null
  };
}

function summarizeUsagePoints(points) {
  const summary = points.reduce((acc, point) => {
    acc.callCount += point.callCount;
    acc.inputTokens += point.inputTokens;
    acc.cachedTokens += point.cachedTokens;
    acc.outputTokens += point.outputTokens;
    acc.totalTokens += point.totalTokens;
    acc.peakInputTokens = Math.max(acc.peakInputTokens, point.topEvent?.inputTokens ?? point.inputTokens);
    acc.peakOutputTokens = Math.max(acc.peakOutputTokens, point.topEvent?.outputTokens ?? point.outputTokens);
    return acc;
  }, {
    callCount: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheRatio: null,
    peakInputTokens: 0,
    peakOutputTokens: 0
  });
  summary.cacheRatio = summary.inputTokens > 0 ? summary.cachedTokens / summary.inputTokens : null;
  return summary;
}

function normalizeUsageSearchQuery(value) {
  const query = firstString(value);
  if (!query) {
    return null;
  }
  return query.slice(0, 120);
}

function normalizeUsageSearchHit(row, query) {
  const sliceId = firstString(row.llm_request_slice_id, row.slice_id);
  const sourceKind = firstString(row.source_kind, USAGE_SOURCE_MAIN);
  const forkRunId = firstString(row.fork_run_id);
  return {
    timestamp: normalizeDate(row.timestamp || row.created_at),
    label: firstString(row.label) || query,
    severity: 'info',
    anchorEventId: usageAnchorEventId(sliceId, sourceKind),
    llmRequestSliceId: sliceId,
    llmCallId: firstString(row.llm_call_id),
    traceId: firstString(row.trace_id),
    sourceKind,
    forkRunId,
    field: firstString(row.match_field),
    query,
    snippet: firstString(row.snippet),
    inputTokens: normalizeNumber(row.input_tokens),
    cachedTokens: normalizeNumber(row.cached_tokens),
    outputTokens: normalizeNumber(row.output_tokens)
  };
}

function usageAnchorEventId(sliceId, sourceKind) {
  if (!sliceId) {
    return null;
  }
  if (sliceId.startsWith('codex-provider:')) {
    return sliceId;
  }
  if (sourceKind === USAGE_SOURCE_COMPRESSION_FORK) {
    return `compression-fork-slice:${sliceId}`;
  }
  if (sourceKind === USAGE_SOURCE_SUBCONSCIOUS_FORK) {
    return `subconscious-fork-slice:${sliceId}`;
  }
  if (sourceKind === USAGE_SOURCE_IMAGE_VISION_FORK) {
    return `image-vision-fork-slice:${sliceId}`;
  }
  if (sourceKind && sourceKind !== USAGE_SOURCE_MAIN) {
    return `codex-provider:${sliceId}`;
  }
  return `llm-slice:${sliceId}`;
}

function usageRollupBucketColumn(bucket) {
  if (bucket === 'hour') {
    return 'hour_bucket_start';
  }
  if (bucket === 'day') {
    return 'day_bucket_start';
  }
  return 'month_bucket_start';
}

function usageRollupBucketIntervalSql(bucket) {
  if (bucket === 'hour') {
    return "INTERVAL '1 hour'";
  }
  if (bucket === 'day') {
    return "INTERVAL '1 day'";
  }
  return "INTERVAL '1 month'";
}

function usageRollupSourceFromSliceSelectSql(sourceKind = USAGE_SOURCE_MAIN) {
  const tokenSql = usageTokenSql('token_usage');
  const tableName = sourceKind === USAGE_SOURCE_COMPRESSION_FORK
    ? 'core_memory_compression_fork_slices'
    : sourceKind === USAGE_SOURCE_SUBCONSCIOUS_FORK
      ? 'subconscious_agent_fork_slices'
    : sourceKind === USAGE_SOURCE_IMAGE_VISION_FORK
      ? 'image_vision_fork_slices'
      : 'llm_request_slices';
  const forkRunIdSelect = sourceKind === USAGE_SOURCE_COMPRESSION_FORK || sourceKind === USAGE_SOURCE_SUBCONSCIOUS_FORK || sourceKind === USAGE_SOURCE_IMAGE_VISION_FORK
    ? 'fork_run_id'
    : 'NULL::varchar AS fork_run_id';
  return `
    SELECT
      slice_id,
      ?::varchar AS source_kind,
      ${forkRunIdSelect},
      identity_key,
      llm_call_id,
      trace_id,
      created_at,
      date_trunc('hour', created_at) AS hour_bucket_start,
      date_trunc('day', created_at) AS day_bucket_start,
      date_trunc('month', created_at) AS month_bucket_start,
      ${tokenSql.input} AS input_tokens,
      ${tokenSql.cached} AS cached_tokens,
      ${tokenSql.output} AS output_tokens
    FROM ${tableName}
  `;
}

function usageRollupSourceFromCodexProviderSelectSql() {
  const tokenSql = usageTokenSql('token_usage');
  return `
    SELECT
      event_id AS slice_id,
      source_kind,
      source_id AS fork_run_id,
      identity_key,
      llm_call_id,
      trace_id,
      created_at,
      date_trunc('hour', created_at) AS hour_bucket_start,
      date_trunc('day', created_at) AS day_bucket_start,
      date_trunc('month', created_at) AS month_bucket_start,
      ${tokenSql.input} AS input_tokens,
      ${tokenSql.cached} AS cached_tokens,
      ${tokenSql.output} AS output_tokens
    FROM codex_provider_usage_events
    WHERE NOT (
      source_kind = 'core_memory_compression_fork'
      AND llm_call_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM core_memory_compression_fork_slices
        WHERE core_memory_compression_fork_slices.llm_call_id = codex_provider_usage_events.llm_call_id
      )
    )
    AND NOT (
      source_kind = 'subconscious_agent_fork'
      AND llm_call_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM subconscious_agent_fork_slices
        WHERE subconscious_agent_fork_slices.llm_call_id = codex_provider_usage_events.llm_call_id
      )
    )
    AND NOT (
      source_kind = 'image_vision_fork'
      AND llm_call_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM image_vision_fork_slices
        WHERE image_vision_fork_slices.llm_call_id = codex_provider_usage_events.llm_call_id
      )
    )
  `;
}

function usageRollupSourceFromAllSlicesSelectSql() {
  return `
    ${usageRollupSourceFromSliceSelectSql(USAGE_SOURCE_MAIN)}
    UNION ALL
    ${usageRollupSourceFromSliceSelectSql(USAGE_SOURCE_COMPRESSION_FORK)}
    UNION ALL
    ${usageRollupSourceFromSliceSelectSql(USAGE_SOURCE_SUBCONSCIOUS_FORK)}
    UNION ALL
    ${usageRollupSourceFromSliceSelectSql(USAGE_SOURCE_IMAGE_VISION_FORK)}
    UNION ALL
    ${usageRollupSourceFromCodexProviderSelectSql()}
  `;
}

function normalizeStackRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id === null || typeof row.id === 'undefined' ? null : String(row.id),
    eventId: row.event_id,
    identityKey: row.identity_key,
    stackIndex: Number(row.stack_index || 0),
    itemKind: row.item_kind,
    role: row.role || null,
    phase: row.phase || null,
    providerItemId: row.provider_item_id || null,
    toolCallId: row.tool_call_id || null,
    llmRequestSliceId: row.llm_request_slice_id || null,
    content: normalizeJsonObject(row.content, {}),
    visibility: row.visibility || null,
    sourceType: row.source_type || null,
    sourceId: row.source_id || null,
    traceId: row.trace_id || null,
    runId: row.run_id || null,
    conversationId: row.conversation_id === null || typeof row.conversation_id === 'undefined'
      ? null
      : String(row.conversation_id),
    metadata: normalizeJsonObject(row.metadata, {}),
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at)
  };
}

function normalizeLlmSliceRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id === null || typeof row.id === 'undefined' ? null : String(row.id),
    sliceId: row.slice_id,
    llmCallId: row.llm_call_id || null,
    identityKey: row.identity_key,
    inputStartIndex: row.input_start_index === null || typeof row.input_start_index === 'undefined' ? null : Number(row.input_start_index),
    inputEndIndex: row.input_end_index === null || typeof row.input_end_index === 'undefined' ? null : Number(row.input_end_index),
    inputStackItemIds: normalizeJsonArray(row.input_stack_item_ids, []),
    outputStartIndex: row.output_start_index === null || typeof row.output_start_index === 'undefined' ? null : Number(row.output_start_index),
    outputEndIndex: row.output_end_index === null || typeof row.output_end_index === 'undefined' ? null : Number(row.output_end_index),
    canonicalRequest: normalizeJsonObject(row.canonical_request, {}),
    wireRequest: normalizeJsonObject(row.wire_request, null),
    canonicalResponse: normalizeJsonObject(row.canonical_response, null),
    wireResponse: normalizeJsonObject(row.wire_response, null),
    rawResponse: normalizeJsonObject(row.raw_response, null),
    providerRawTraceAvailable: row.provider_raw_trace_available === null || typeof row.provider_raw_trace_available === 'undefined'
      ? null
      : row.provider_raw_trace_available === true || row.provider_raw_trace_available === 'true',
    outputItems: normalizeJsonArray(row.output_items, []),
    status: row.status || null,
    tokenUsage: normalizeJsonObject(row.token_usage, {}),
    traceId: row.trace_id || null,
    runId: row.run_id || null,
    conversationId: row.conversation_id === null || typeof row.conversation_id === 'undefined'
      ? null
      : String(row.conversation_id),
    agentTurn: row.agent_turn === null || typeof row.agent_turn === 'undefined' ? null : Number(row.agent_turn),
    modelName: row.model_name || null,
    modelProvider: row.model_provider || null,
    requestFormatVersion: row.request_format_version || null,
    wireProviderFormat: row.wire_provider_format || null,
    processingTimeMs: row.processing_time_ms === null || typeof row.processing_time_ms === 'undefined' ? null : Number(row.processing_time_ms),
    sourceKind: row.source_kind || null,
    forkRunId: row.fork_run_id || null,
    metadata: normalizeJsonObject(row.metadata, {}),
    createdAt: normalizeDate(row.created_at),
    completedAt: normalizeDate(row.completed_at),
    updatedAt: normalizeDate(row.updated_at)
  };
}

function normalizeToolExecutionRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id === null || typeof row.id === 'undefined' ? null : String(row.id),
    executionId: row.execution_id,
    identityKey: row.identity_key,
    llmRequestSliceId: row.llm_request_slice_id || null,
    llmCallId: row.llm_call_id || null,
    toolCallId: row.tool_call_id || null,
    toolName: row.tool_name || null,
    arguments: normalizeJsonObject(row.arguments, {}),
    rawArguments: row.raw_arguments || null,
    result: normalizeJsonObject(row.result, {}),
    status: row.status || null,
    errorMessage: row.error_message || null,
    sideEffect: Boolean(row.side_effect),
    traceId: row.trace_id || null,
    runId: row.run_id || null,
    conversationId: row.conversation_id === null || typeof row.conversation_id === 'undefined'
      ? null
      : String(row.conversation_id),
    agentTurn: row.agent_turn === null || typeof row.agent_turn === 'undefined' ? null : Number(row.agent_turn),
    stackCallItemId: row.stack_call_item_id === null || typeof row.stack_call_item_id === 'undefined' ? null : String(row.stack_call_item_id),
    stackOutputItemId: row.stack_output_item_id === null || typeof row.stack_output_item_id === 'undefined' ? null : String(row.stack_output_item_id),
    metadata: normalizeJsonObject(row.metadata, {}),
    createdAt: normalizeDate(row.created_at),
    startedAt: normalizeDate(row.started_at),
    completedAt: normalizeDate(row.completed_at),
    updatedAt: normalizeDate(row.updated_at)
  };
}

function normalizeCompressionForkRunRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id === null || typeof row.id === 'undefined' ? null : String(row.id),
    forkRunId: row.fork_run_id,
    identityKey: row.identity_key,
    contextSessionKey: row.context_session_key || null,
    status: row.status || null,
    traceId: row.trace_id || null,
    runId: row.run_id || null,
    conversationId: row.conversation_id === null || typeof row.conversation_id === 'undefined'
      ? null
      : String(row.conversation_id),
    readCutoffAfterConversationId: row.read_cutoff_after_conversation_id === null || typeof row.read_cutoff_after_conversation_id === 'undefined'
      ? null
      : String(row.read_cutoff_after_conversation_id),
    previousReadCutoffAfterConversationId: row.previous_read_cutoff_after_conversation_id === null || typeof row.previous_read_cutoff_after_conversation_id === 'undefined'
      ? null
      : String(row.previous_read_cutoff_after_conversation_id),
    summaryText: row.summary_text || null,
    artifact: normalizeJsonObject(row.artifact, {}),
    errorMessage: row.error_message || null,
    metadata: normalizeJsonObject(row.metadata, {}),
    startedAt: normalizeDate(row.started_at),
    completedAt: normalizeDate(row.completed_at),
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at)
  };
}

function normalizeSubconsciousForkRunRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id === null || typeof row.id === 'undefined' ? null : String(row.id),
    forkRunId: row.fork_run_id,
    identityKey: row.identity_key,
    contextSessionKey: row.context_session_key || null,
    status: row.status || null,
    traceId: row.trace_id || null,
    runId: row.run_id || null,
    conversationId: row.conversation_id === null || typeof row.conversation_id === 'undefined'
      ? null
      : String(row.conversation_id),
    notifyQueueMessageId: row.notify_queue_message_id === null || typeof row.notify_queue_message_id === 'undefined'
      ? null
      : String(row.notify_queue_message_id),
    summaryText: row.summary_text || null,
    artifact: normalizeJsonObject(row.artifact, {}),
    errorMessage: row.error_message || null,
    metadata: normalizeJsonObject(row.metadata, {}),
    startedAt: normalizeDate(row.started_at),
    completedAt: normalizeDate(row.completed_at),
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at)
  };
}

function normalizeCompressionForkItemRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id === null || typeof row.id === 'undefined' ? null : String(row.id),
    eventId: row.event_id,
    forkRunId: row.fork_run_id,
    identityKey: row.identity_key,
    itemIndex: Number(row.item_index || 0),
    itemKind: row.item_kind,
    role: row.role || null,
    phase: row.phase || null,
    providerItemId: row.provider_item_id || null,
    toolCallId: row.tool_call_id || null,
    llmRequestSliceId: row.llm_request_slice_id || null,
    content: normalizeJsonObject(row.content, {}),
    visibility: row.visibility || null,
    sourceType: row.source_type || null,
    sourceId: row.source_id || null,
    traceId: row.trace_id || null,
    runId: row.run_id || null,
    conversationId: row.conversation_id === null || typeof row.conversation_id === 'undefined'
      ? null
      : String(row.conversation_id),
    metadata: normalizeJsonObject(row.metadata, {}),
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at)
  };
}

function normalizeCompressionForkSliceRow(row) {
  const normalized = normalizeLlmSliceRow(row);
  return normalized ? {
    ...normalized,
    forkRunId: row.fork_run_id
  } : null;
}

function normalizeCodexProviderUsageEventRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id === null || typeof row.id === 'undefined' ? null : String(row.id),
    eventId: row.event_id || row.slice_id,
    sourceKind: row.source_kind || USAGE_SOURCE_CODEX_PROVIDER,
    sourceId: row.source_id || row.fork_run_id || null,
    identityKey: row.identity_key,
    llmCallId: row.llm_call_id || null,
    traceId: row.trace_id || null,
    runId: row.run_id || null,
    conversationId: row.conversation_id === null || typeof row.conversation_id === 'undefined'
      ? null
      : String(row.conversation_id),
    canonicalRequest: normalizeJsonObject(row.canonical_request, {}),
    wireRequest: normalizeJsonObject(row.wire_request, null),
    canonicalResponse: normalizeJsonObject(row.canonical_response, null),
    wireResponse: normalizeJsonObject(row.wire_response, null),
    rawResponse: normalizeJsonObject(row.raw_response, null),
    outputItems: normalizeJsonArray(row.output_items, []),
    status: row.status || null,
    tokenUsage: normalizeJsonObject(row.token_usage, {}),
    modelName: row.model_name || null,
    modelProvider: row.model_provider || null,
    requestFormatVersion: row.request_format_version || null,
    wireProviderFormat: row.wire_provider_format || null,
    processingTimeMs: row.processing_time_ms === null || typeof row.processing_time_ms === 'undefined' ? null : Number(row.processing_time_ms),
    metadata: normalizeJsonObject(row.metadata, {}),
    createdAt: normalizeDate(row.created_at),
    completedAt: normalizeDate(row.completed_at),
    updatedAt: normalizeDate(row.updated_at)
  };
}

function normalizeCompressionForkToolExecutionRow(row) {
  const normalized = normalizeToolExecutionRow(row);
  return normalized ? {
    ...normalized,
    forkRunId: row.fork_run_id
  } : null;
}

function normalizeImageVisionForkRunRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id === null || typeof row.id === 'undefined' ? null : String(row.id),
    forkRunId: row.fork_run_id,
    identityKey: row.identity_key,
    status: row.status || null,
    traceId: row.trace_id || null,
    runId: row.run_id || null,
    conversationId: row.conversation_id === null || typeof row.conversation_id === 'undefined'
      ? null
      : String(row.conversation_id),
    assetId: row.asset_id || null,
    imageId: row.image_id || null,
    mediaTag: row.media_tag || null,
    observationId: row.observation_id || null,
    description: row.description || null,
    artifact: normalizeJsonObject(row.artifact, {}),
    errorMessage: row.error_message || null,
    metadata: normalizeJsonObject(row.metadata, {}),
    startedAt: normalizeDate(row.started_at),
    completedAt: normalizeDate(row.completed_at),
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at)
  };
}

function normalizeImageVisionForkItemRow(row) {
  return normalizeCompressionForkItemRow(row);
}

function normalizeImageVisionForkSliceRow(row) {
  const normalized = normalizeLlmSliceRow(row);
  return normalized ? {
    ...normalized,
    forkRunId: row.fork_run_id
  } : null;
}

function normalizeStackSourceKind(value) {
  const sourceKind = firstString(value);
  if (sourceKind === USAGE_SOURCE_COMPRESSION_FORK) {
    return USAGE_SOURCE_COMPRESSION_FORK;
  }
  if (sourceKind === USAGE_SOURCE_SUBCONSCIOUS_FORK) {
    return USAGE_SOURCE_SUBCONSCIOUS_FORK;
  }
  if (sourceKind === USAGE_SOURCE_IMAGE_VISION_FORK) {
    return USAGE_SOURCE_IMAGE_VISION_FORK;
  }
  return USAGE_SOURCE_MAIN;
}

function forkStackItemsTableForSource(sourceKind) {
  if (sourceKind === USAGE_SOURCE_COMPRESSION_FORK) {
    return 'core_memory_compression_fork_items';
  }
  if (sourceKind === USAGE_SOURCE_SUBCONSCIOUS_FORK) {
    return 'subconscious_agent_fork_items';
  }
  if (sourceKind === USAGE_SOURCE_IMAGE_VISION_FORK) {
    return 'image_vision_fork_items';
  }
  return 'agent_stack_items';
}

function forkToolExecutionsTableForSource(sourceKind) {
  if (sourceKind === USAGE_SOURCE_COMPRESSION_FORK) {
    return 'core_memory_compression_fork_tool_executions';
  }
  if (sourceKind === USAGE_SOURCE_SUBCONSCIOUS_FORK) {
    return 'subconscious_agent_fork_tool_executions';
  }
  return 'tool_executions';
}

function buildStackEventId(identityKey, item, indexHint) {
  return firstString(item.eventId, item.event_id)
    || `stack:${identityKey}:${Date.now()}:${indexHint}:${randomUUID().slice(0, 8)}`;
}

function buildCompressionForkItemEventId(forkRunId, item, indexHint) {
  return firstString(item.eventId, item.event_id)
    || `fork-stack:${forkRunId}:${indexHint}:${randomUUID().slice(0, 8)}`;
}

function buildImageVisionForkItemEventId(forkRunId, item, indexHint) {
  return firstString(item.eventId, item.event_id)
    || `image-fork-stack:${forkRunId}:${indexHint}:${randomUUID().slice(0, 8)}`;
}

function buildCompressionForkRunId(input) {
  return firstString(input.forkRunId, input.fork_run_id)
    || `core-memory-fork:${firstString(input.runId, input.run_id, 'run')}:${randomUUID().slice(0, 8)}`;
}

function buildImageVisionForkRunId(input) {
  return firstString(input.forkRunId, input.fork_run_id)
    || `image-vision-fork:${firstString(input.runId, input.run_id, 'run')}:${firstString(input.assetId, input.asset_id, input.imageId, input.image_id, randomUUID().slice(0, 8))}`;
}

function buildSubconsciousForkRunId(input) {
  return firstString(input.forkRunId, input.fork_run_id)
    || `subconscious-fork:${firstString(input.runId, input.run_id, 'run')}:${randomUUID().slice(0, 8)}`;
}

function buildSubconsciousForkItemEventId(forkRunId, item, indexHint) {
  return firstString(item.eventId, item.event_id)
    || `subconscious-fork-stack:${forkRunId}:${indexHint}:${randomUUID().slice(0, 8)}`;
}

function normalizeCodexProviderUsageSourceKind(value) {
  const raw = firstString(value, USAGE_SOURCE_CODEX_PROVIDER);
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (normalized || USAGE_SOURCE_CODEX_PROVIDER).slice(0, 32);
}

function buildCodexProviderUsageEventId(input = {}) {
  const explicit = firstString(input.eventId, input.event_id, input.sliceId, input.slice_id);
  if (explicit) {
    return explicit.slice(0, 191);
  }
  const sourceKind = normalizeCodexProviderUsageSourceKind(input.sourceKind ?? input.source_kind);
  const llmCallId = firstString(input.llmCallId, input.llm_call_id);
  if (llmCallId) {
    return `codex-provider:${llmCallId}`.slice(0, 191);
  }
  const sourceId = firstString(input.sourceId, input.source_id, input.runId, input.run_id, input.traceId, input.trace_id, 'event');
  return `codex-provider:${sourceKind}:${sourceId}:${randomUUID().slice(0, 8)}`.slice(0, 191);
}

function buildSliceId(input) {
  return firstString(input.sliceId, input.slice_id, input.llmCallId, input.llm_call_id)
    || `slice:${firstString(input.traceId, input.trace_id, 'trace')}:${input.agentTurn ?? input.agent_turn ?? 'turn'}:${randomUUID().slice(0, 8)}`;
}

function buildToolExecutionId(input) {
  return firstString(input.executionId, input.execution_id)
    || `tool:${firstString(input.runId, input.run_id, 'run')}:${firstString(input.toolCallId, input.tool_call_id, randomUUID().slice(0, 8))}`;
}

function createXiaoniAgentStackPersistence({ createSqlAdapter, sqlAdapter } = {}) {
  function createSql(input = {}, config = {}) {
    if (input?.sqlAdapter) {
      return { sql: input.sqlAdapter, shouldClose: false };
    }
    if (sqlAdapter) {
      return { sql: sqlAdapter, shouldClose: false };
    }
    if (typeof createSqlAdapter !== 'function') {
      throw new Error('xiaoni agent stack SQL operations require createSqlAdapter');
    }
    return { sql: createSqlAdapter(config), shouldClose: true };
  }

  async function withSql(input, config, callback) {
    const { sql, shouldClose } = createSql(input, config);
    try {
      return await callback(sql);
    } finally {
      if (shouldClose) {
        await sql.close();
      }
    }
  }

  async function executeDdls(sql, statements) {
    for (const statement of statements) {
      try {
        await sql.execute(statement);
      } catch (error) {
        if (error?.code === '42P07' || error?.code === '42710') {
          continue;
        }
        throw error;
      }
    }
  }

  async function rebuildLlmUsageRollupBucket(executor, bucket) {
    const bucketColumn = usageRollupBucketColumn(bucket);
    const bucketInterval = usageRollupBucketIntervalSql(bucket);
    await executor.query(
      `
        WITH ranked AS (
          SELECT
            identity_key,
            ${bucketColumn} AS bucket_start,
            slice_id,
            source_kind,
            fork_run_id,
            llm_call_id,
            trace_id,
            created_at,
            input_tokens,
            cached_tokens,
            output_tokens,
            ROW_NUMBER() OVER (
              PARTITION BY identity_key, ${bucketColumn}
              ORDER BY (input_tokens + output_tokens) DESC, created_at ASC, slice_id ASC
            ) AS bucket_rank
          FROM llm_usage_rollup_sources
        ),
        aggregated AS (
          SELECT
            identity_key,
            ?::varchar AS bucket,
            bucket_start,
            bucket_start + ${bucketInterval} AS bucket_end,
            COUNT(*) AS call_count,
            SUM(input_tokens) AS input_tokens,
            SUM(cached_tokens) AS cached_tokens,
            SUM(output_tokens) AS output_tokens,
            MAX(CASE WHEN bucket_rank = 1 THEN slice_id END) AS top_llm_request_slice_id,
            MAX(CASE WHEN bucket_rank = 1 THEN source_kind END) AS top_source_kind,
            MAX(CASE WHEN bucket_rank = 1 THEN fork_run_id END) AS top_fork_run_id,
            MAX(CASE WHEN bucket_rank = 1 THEN llm_call_id END) AS top_llm_call_id,
            MAX(CASE WHEN bucket_rank = 1 THEN trace_id END) AS top_trace_id,
            MAX(CASE WHEN bucket_rank = 1 THEN created_at END) AS top_timestamp,
            MAX(CASE WHEN bucket_rank = 1 THEN input_tokens END) AS top_input_tokens,
            MAX(CASE WHEN bucket_rank = 1 THEN cached_tokens END) AS top_cached_tokens,
            MAX(CASE WHEN bucket_rank = 1 THEN output_tokens END) AS top_output_tokens
          FROM ranked
          GROUP BY identity_key, bucket_start
        )
        INSERT INTO llm_usage_rollups (
          identity_key,
          bucket,
          bucket_start,
          bucket_end,
          call_count,
          input_tokens,
          cached_tokens,
          output_tokens,
          top_llm_request_slice_id,
          top_source_kind,
          top_fork_run_id,
          top_llm_call_id,
          top_trace_id,
          top_timestamp,
          top_input_tokens,
          top_cached_tokens,
          top_output_tokens
        )
        SELECT
          identity_key,
          bucket,
          bucket_start,
          bucket_end,
          call_count,
          input_tokens,
          cached_tokens,
          output_tokens,
          top_llm_request_slice_id,
          top_source_kind,
          top_fork_run_id,
          top_llm_call_id,
          top_trace_id,
          top_timestamp,
          COALESCE(top_input_tokens, 0),
          COALESCE(top_cached_tokens, 0),
          COALESCE(top_output_tokens, 0)
        FROM aggregated
        ON CONFLICT (identity_key, bucket, bucket_start) DO UPDATE SET
          bucket_end = EXCLUDED.bucket_end,
          call_count = EXCLUDED.call_count,
          input_tokens = EXCLUDED.input_tokens,
          cached_tokens = EXCLUDED.cached_tokens,
          output_tokens = EXCLUDED.output_tokens,
          top_llm_request_slice_id = EXCLUDED.top_llm_request_slice_id,
          top_source_kind = EXCLUDED.top_source_kind,
          top_fork_run_id = EXCLUDED.top_fork_run_id,
          top_llm_call_id = EXCLUDED.top_llm_call_id,
          top_trace_id = EXCLUDED.top_trace_id,
          top_timestamp = EXCLUDED.top_timestamp,
          top_input_tokens = EXCLUDED.top_input_tokens,
          top_cached_tokens = EXCLUDED.top_cached_tokens,
          top_output_tokens = EXCLUDED.top_output_tokens,
          updated_at = CURRENT_TIMESTAMP
      `,
      [bucket]
    );
  }

  async function initializeLlmUsageRollupsIfNeeded(sql) {
    const initializeWithExecutor = async (executor) => {
      if (typeof executor.query === 'function') {
        await executor.query('SELECT pg_advisory_xact_lock(hashtext(?))', ['llm_usage_rollups:init']).catch(() => []);
      }
      await executor.query(
        `
          INSERT INTO llm_usage_rollup_state (identity_key, version, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT (identity_key) DO NOTHING
        `,
        [USAGE_ROLLUP_STATE_KEY, USAGE_ROLLUP_VERSION]
      );
      const stateRows = await executor.query(
        'SELECT initialized_at, version FROM llm_usage_rollup_state WHERE identity_key = ? FOR UPDATE',
        [USAGE_ROLLUP_STATE_KEY]
      );
      if (stateRows[0]?.initialized_at && normalizeNumber(stateRows[0]?.version) >= USAGE_ROLLUP_VERSION) {
        return false;
      }

      await executor.execute('DELETE FROM llm_usage_rollups');
      await executor.execute('DELETE FROM llm_usage_rollup_sources');
      const sourceSelectSql = usageRollupSourceFromAllSlicesSelectSql();
      await executor.query(
        `
          INSERT INTO llm_usage_rollup_sources (
            slice_id,
            source_kind,
            fork_run_id,
            identity_key,
            llm_call_id,
            trace_id,
            created_at,
            hour_bucket_start,
            day_bucket_start,
            month_bucket_start,
            input_tokens,
            cached_tokens,
            output_tokens
          )
          ${sourceSelectSql}
          ON CONFLICT (slice_id) DO UPDATE SET
            source_kind = EXCLUDED.source_kind,
            fork_run_id = EXCLUDED.fork_run_id,
            identity_key = EXCLUDED.identity_key,
            llm_call_id = EXCLUDED.llm_call_id,
            trace_id = EXCLUDED.trace_id,
            created_at = EXCLUDED.created_at,
            hour_bucket_start = EXCLUDED.hour_bucket_start,
            day_bucket_start = EXCLUDED.day_bucket_start,
            month_bucket_start = EXCLUDED.month_bucket_start,
            input_tokens = EXCLUDED.input_tokens,
            cached_tokens = EXCLUDED.cached_tokens,
            output_tokens = EXCLUDED.output_tokens,
            updated_at = CURRENT_TIMESTAMP
        `,
        [USAGE_SOURCE_MAIN, USAGE_SOURCE_COMPRESSION_FORK, USAGE_SOURCE_SUBCONSCIOUS_FORK, USAGE_SOURCE_IMAGE_VISION_FORK]
      );
      for (const bucket of USAGE_ROLLUP_BUCKETS) {
        await rebuildLlmUsageRollupBucket(executor, bucket);
      }
      await executor.query(
        `
          UPDATE llm_usage_rollup_state
          SET
            version = ?,
            initialized_at = CURRENT_TIMESTAMP,
            source_max_id = GREATEST(
              COALESCE((SELECT MAX(id) FROM llm_request_slices), 0),
              COALESCE((SELECT MAX(id) FROM core_memory_compression_fork_slices), 0),
              COALESCE((SELECT MAX(id) FROM subconscious_agent_fork_slices), 0),
              COALESCE((SELECT MAX(id) FROM image_vision_fork_slices), 0),
              COALESCE((SELECT MAX(id) FROM codex_provider_usage_events), 0)
            ),
            source_count = COALESCE((SELECT COUNT(*) FROM llm_usage_rollup_sources), 0),
            updated_at = CURRENT_TIMESTAMP
          WHERE identity_key = ?
        `,
        [USAGE_ROLLUP_VERSION, USAGE_ROLLUP_STATE_KEY]
      );
      return true;
    };

    if (typeof sql.withTransaction === 'function') {
      return sql.withTransaction(initializeWithExecutor);
    }
    return initializeWithExecutor(sql);
  }

  async function refreshLlmUsageRollupTop(executor, source, bucket) {
    const bucketColumn = usageRollupBucketColumn(bucket);
    const bucketStart = source[bucketColumn];
    const identityKey = firstString(source.identity_key, source.identityKey);
    if (!bucketStart || !identityKey) {
      return;
    }
    const topRows = await executor.query(
      `
        SELECT
          slice_id,
          source_kind,
          fork_run_id,
          llm_call_id,
          trace_id,
          created_at,
          input_tokens,
          cached_tokens,
          output_tokens
        FROM llm_usage_rollup_sources
        WHERE identity_key = ?
          AND ${bucketColumn} = ?::timestamptz
        ORDER BY (input_tokens + output_tokens) DESC, created_at ASC, slice_id ASC
        LIMIT 1
      `,
      [identityKey, bucketStart]
    );
    const top = topRows[0];
    if (!top) {
      await executor.query(
        `
          UPDATE llm_usage_rollups
          SET
            top_llm_request_slice_id = NULL,
            top_source_kind = NULL,
            top_fork_run_id = NULL,
            top_llm_call_id = NULL,
            top_trace_id = NULL,
            top_timestamp = NULL,
            top_input_tokens = 0,
            top_cached_tokens = 0,
            top_output_tokens = 0,
            updated_at = CURRENT_TIMESTAMP
          WHERE identity_key = ?
            AND bucket = ?
            AND bucket_start = ?::timestamptz
        `,
        [identityKey, bucket, bucketStart]
      );
      return;
    }
    await executor.query(
      `
        UPDATE llm_usage_rollups
        SET
          top_llm_request_slice_id = ?,
          top_source_kind = ?,
          top_fork_run_id = ?,
          top_llm_call_id = ?,
          top_trace_id = ?,
          top_timestamp = ?::timestamptz,
          top_input_tokens = ?,
          top_cached_tokens = ?,
          top_output_tokens = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE identity_key = ?
          AND bucket = ?
          AND bucket_start = ?::timestamptz
      `,
      [
        top.slice_id,
        top.source_kind,
        top.fork_run_id,
        top.llm_call_id,
        top.trace_id,
        normalizeDate(top.created_at),
        normalizeNumber(top.input_tokens),
        normalizeNumber(top.cached_tokens),
        normalizeNumber(top.output_tokens),
        identityKey,
        bucket,
        bucketStart
      ]
    );
  }

  async function applyLlmUsageRollupContribution(executor, source, direction) {
    const sign = direction === 'subtract' ? -1 : 1;
    const identityKey = firstString(source.identity_key, source.identityKey);
    if (!identityKey) {
      return;
    }
    const inputTokens = normalizeNumber(source.input_tokens) * sign;
    const cachedTokens = normalizeNumber(source.cached_tokens) * sign;
    const outputTokens = normalizeNumber(source.output_tokens) * sign;
    for (const bucket of USAGE_ROLLUP_BUCKETS) {
      const bucketColumn = usageRollupBucketColumn(bucket);
      const bucketStart = source[bucketColumn];
      if (!bucketStart) {
        continue;
      }
      const bucketInterval = usageRollupBucketIntervalSql(bucket);
      await executor.query(
        `
          INSERT INTO llm_usage_rollups (
            identity_key,
            bucket,
            bucket_start,
            bucket_end,
            call_count,
            input_tokens,
            cached_tokens,
            output_tokens
          )
          VALUES (?, ?, ?::timestamptz, ?::timestamptz + ${bucketInterval}, ?, ?, ?, ?)
          ON CONFLICT (identity_key, bucket, bucket_start) DO UPDATE SET
            bucket_end = EXCLUDED.bucket_end,
            call_count = llm_usage_rollups.call_count + EXCLUDED.call_count,
            input_tokens = llm_usage_rollups.input_tokens + EXCLUDED.input_tokens,
            cached_tokens = llm_usage_rollups.cached_tokens + EXCLUDED.cached_tokens,
            output_tokens = llm_usage_rollups.output_tokens + EXCLUDED.output_tokens,
            updated_at = CURRENT_TIMESTAMP
        `,
        [identityKey, bucket, bucketStart, bucketStart, sign, inputTokens, cachedTokens, outputTokens]
      );
      await executor.execute(
        `
          DELETE FROM llm_usage_rollups
          WHERE identity_key = ?
            AND bucket = ?
            AND bucket_start = ?::timestamptz
            AND call_count <= 0
        `,
        [identityKey, bucket, bucketStart]
      );
      await refreshLlmUsageRollupTop(executor, source, bucket);
    }
  }

  async function syncLlmUsageRollupForSlice(executor, sliceId, sourceKind = USAGE_SOURCE_MAIN) {
    if (!sliceId) {
      return;
    }
    const previousRows = await executor.query(
      'SELECT * FROM llm_usage_rollup_sources WHERE slice_id = ? FOR UPDATE',
      [sliceId]
    );
    const previous = previousRows[0] || null;
    if (previous) {
      await applyLlmUsageRollupContribution(executor, previous, 'subtract');
    }

    const sourceSelectSql = usageRollupSourceFromSliceSelectSql(sourceKind);
    const currentRows = await executor.query(
      `
        ${sourceSelectSql}
        WHERE slice_id = ?
        LIMIT 1
      `,
      [sourceKind, sliceId]
    );
    const current = currentRows[0] || null;
    if (!current) {
      if (previous) {
        await executor.execute('DELETE FROM llm_usage_rollup_sources WHERE slice_id = ?', [sliceId]);
      }
      return;
    }

    await executor.query(
      `
        INSERT INTO llm_usage_rollup_sources (
          slice_id,
          source_kind,
          fork_run_id,
          identity_key,
          llm_call_id,
          trace_id,
          created_at,
          hour_bucket_start,
          day_bucket_start,
          month_bucket_start,
          input_tokens,
          cached_tokens,
          output_tokens
        )
        VALUES (?, ?, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz, ?::timestamptz, ?::timestamptz, ?, ?, ?)
        ON CONFLICT (slice_id) DO UPDATE SET
          source_kind = EXCLUDED.source_kind,
          fork_run_id = EXCLUDED.fork_run_id,
          identity_key = EXCLUDED.identity_key,
          llm_call_id = EXCLUDED.llm_call_id,
          trace_id = EXCLUDED.trace_id,
          created_at = EXCLUDED.created_at,
          hour_bucket_start = EXCLUDED.hour_bucket_start,
          day_bucket_start = EXCLUDED.day_bucket_start,
          month_bucket_start = EXCLUDED.month_bucket_start,
          input_tokens = EXCLUDED.input_tokens,
          cached_tokens = EXCLUDED.cached_tokens,
          output_tokens = EXCLUDED.output_tokens,
          updated_at = CURRENT_TIMESTAMP
      `,
      [
        current.slice_id,
        current.source_kind,
        current.fork_run_id,
        current.identity_key,
        current.llm_call_id,
        current.trace_id,
        normalizeDate(current.created_at),
        normalizeDate(current.hour_bucket_start),
        normalizeDate(current.day_bucket_start),
        normalizeDate(current.month_bucket_start),
        normalizeNumber(current.input_tokens),
        normalizeNumber(current.cached_tokens),
        normalizeNumber(current.output_tokens)
      ]
    );
    await applyLlmUsageRollupContribution(executor, current, 'add');
    const sourceTable = sourceKind === USAGE_SOURCE_COMPRESSION_FORK
      ? 'core_memory_compression_fork_slices'
      : sourceKind === USAGE_SOURCE_SUBCONSCIOUS_FORK
        ? 'subconscious_agent_fork_slices'
      : sourceKind === USAGE_SOURCE_IMAGE_VISION_FORK
        ? 'image_vision_fork_slices'
        : 'llm_request_slices';
    await executor.query(
      `
        UPDATE llm_usage_rollup_state
        SET
          source_max_id = GREATEST(source_max_id, COALESCE((SELECT id FROM ${sourceTable} WHERE slice_id = ?), 0)),
          source_count = COALESCE((SELECT COUNT(*) FROM llm_usage_rollup_sources), 0),
          updated_at = CURRENT_TIMESTAMP
        WHERE identity_key = ?
      `,
      [sliceId, USAGE_ROLLUP_STATE_KEY]
    );
  }

  async function syncLlmUsageRollupForCodexProviderEvent(executor, eventId) {
    if (!eventId) {
      return;
    }
    const previousRows = await executor.query(
      'SELECT * FROM llm_usage_rollup_sources WHERE slice_id = ? FOR UPDATE',
      [eventId]
    );
    const previous = previousRows[0] || null;
    if (previous) {
      await applyLlmUsageRollupContribution(executor, previous, 'subtract');
    }

    const currentRows = await executor.query(
      `
        SELECT *
        FROM (
          ${usageRollupSourceFromCodexProviderSelectSql()}
        ) codex_provider_usage_rollup_source
        WHERE slice_id = ?
        LIMIT 1
      `,
      [eventId]
    );
    const current = currentRows[0] || null;
    if (!current) {
      if (previous) {
        await executor.execute('DELETE FROM llm_usage_rollup_sources WHERE slice_id = ?', [eventId]);
      }
      return;
    }

    await executor.query(
      `
        INSERT INTO llm_usage_rollup_sources (
          slice_id,
          source_kind,
          fork_run_id,
          identity_key,
          llm_call_id,
          trace_id,
          created_at,
          hour_bucket_start,
          day_bucket_start,
          month_bucket_start,
          input_tokens,
          cached_tokens,
          output_tokens
        )
        VALUES (?, ?, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz, ?::timestamptz, ?::timestamptz, ?, ?, ?)
        ON CONFLICT (slice_id) DO UPDATE SET
          source_kind = EXCLUDED.source_kind,
          fork_run_id = EXCLUDED.fork_run_id,
          identity_key = EXCLUDED.identity_key,
          llm_call_id = EXCLUDED.llm_call_id,
          trace_id = EXCLUDED.trace_id,
          created_at = EXCLUDED.created_at,
          hour_bucket_start = EXCLUDED.hour_bucket_start,
          day_bucket_start = EXCLUDED.day_bucket_start,
          month_bucket_start = EXCLUDED.month_bucket_start,
          input_tokens = EXCLUDED.input_tokens,
          cached_tokens = EXCLUDED.cached_tokens,
          output_tokens = EXCLUDED.output_tokens,
          updated_at = CURRENT_TIMESTAMP
      `,
      [
        current.slice_id,
        current.source_kind,
        current.fork_run_id,
        current.identity_key,
        current.llm_call_id,
        current.trace_id,
        normalizeDate(current.created_at),
        normalizeDate(current.hour_bucket_start),
        normalizeDate(current.day_bucket_start),
        normalizeDate(current.month_bucket_start),
        normalizeNumber(current.input_tokens),
        normalizeNumber(current.cached_tokens),
        normalizeNumber(current.output_tokens)
      ]
    );
    await applyLlmUsageRollupContribution(executor, current, 'add');
    await executor.query(
      `
        UPDATE llm_usage_rollup_state
        SET
          source_max_id = GREATEST(source_max_id, COALESCE((SELECT id FROM codex_provider_usage_events WHERE event_id = ?), 0)),
          source_count = COALESCE((SELECT COUNT(*) FROM llm_usage_rollup_sources), 0),
          updated_at = CURRENT_TIMESTAMP
        WHERE identity_key = ?
      `,
      [eventId, USAGE_ROLLUP_STATE_KEY]
    );
  }

  async function ensureXiaoniAgentStackSchema(input = {}, config = {}) {
    await withSql(input, config, async (sql) => {
      await executeDdls(sql, [
        `
          CREATE TABLE IF NOT EXISTS agent_stack_items (
            id BIGSERIAL PRIMARY KEY,
            event_id VARCHAR(191) NOT NULL UNIQUE,
            identity_key VARCHAR(191) NOT NULL DEFAULT 'xiaoni',
            stack_index BIGINT NOT NULL,
            item_kind VARCHAR(64) NOT NULL,
            role VARCHAR(32),
            phase VARCHAR(32),
            provider_item_id VARCHAR(191),
            tool_call_id VARCHAR(191),
            llm_request_slice_id VARCHAR(191),
            content JSONB NOT NULL DEFAULT '{}'::jsonb,
            visibility VARCHAR(32) NOT NULL DEFAULT 'model_visible',
            source_type VARCHAR(64),
            source_id VARCHAR(191),
            trace_id VARCHAR(128),
            run_id VARCHAR(128),
            conversation_id BIGINT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(identity_key, stack_index)
          )
        `,
        `
          CREATE TABLE IF NOT EXISTS llm_request_slices (
            id BIGSERIAL PRIMARY KEY,
            slice_id VARCHAR(191) NOT NULL UNIQUE,
            llm_call_id VARCHAR(128),
            identity_key VARCHAR(191) NOT NULL DEFAULT 'xiaoni',
            input_start_index BIGINT,
            input_end_index BIGINT,
            input_stack_item_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            output_start_index BIGINT,
            output_end_index BIGINT,
            canonical_request JSONB NOT NULL DEFAULT '{}'::jsonb,
            wire_request JSONB,
            canonical_response JSONB,
            wire_response JSONB,
            raw_response JSONB,
            output_items JSONB NOT NULL DEFAULT '[]'::jsonb,
            status VARCHAR(32) NOT NULL DEFAULT 'completed',
            token_usage JSONB NOT NULL DEFAULT '{}'::jsonb,
            trace_id VARCHAR(128),
            run_id VARCHAR(128),
            conversation_id BIGINT,
            agent_turn INTEGER,
            model_name VARCHAR(191),
            model_provider VARCHAR(64),
            request_format_version VARCHAR(64),
            wire_provider_format VARCHAR(128),
            processing_time_ms INTEGER,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMPTZ(3),
            updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `,
        `
          CREATE TABLE IF NOT EXISTS llm_usage_rollup_sources (
            slice_id VARCHAR(191) PRIMARY KEY,
            source_kind VARCHAR(32) NOT NULL DEFAULT 'main',
            fork_run_id VARCHAR(191),
            identity_key VARCHAR(191) NOT NULL DEFAULT 'xiaoni',
            llm_call_id VARCHAR(128),
            trace_id VARCHAR(128),
            created_at TIMESTAMPTZ(3) NOT NULL,
            hour_bucket_start TIMESTAMPTZ(3) NOT NULL,
            day_bucket_start TIMESTAMPTZ(3) NOT NULL,
            month_bucket_start TIMESTAMPTZ(3) NOT NULL,
            input_tokens NUMERIC(20, 0) NOT NULL DEFAULT 0,
            cached_tokens NUMERIC(20, 0) NOT NULL DEFAULT 0,
            output_tokens NUMERIC(20, 0) NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `,
        `
          CREATE TABLE IF NOT EXISTS codex_provider_usage_events (
            id BIGSERIAL PRIMARY KEY,
            event_id VARCHAR(191) NOT NULL UNIQUE,
            source_kind VARCHAR(32) NOT NULL DEFAULT 'codex_provider',
            source_id VARCHAR(191),
            identity_key VARCHAR(191) NOT NULL DEFAULT 'xiaoni',
            llm_call_id VARCHAR(128),
            trace_id VARCHAR(128),
            run_id VARCHAR(128),
            conversation_id BIGINT,
            canonical_request JSONB NOT NULL DEFAULT '{}'::jsonb,
            wire_request JSONB,
            canonical_response JSONB,
            wire_response JSONB,
            raw_response JSONB,
            output_items JSONB NOT NULL DEFAULT '[]'::jsonb,
            status VARCHAR(32) NOT NULL DEFAULT 'completed',
            token_usage JSONB NOT NULL DEFAULT '{}'::jsonb,
            model_name VARCHAR(191),
            model_provider VARCHAR(64),
            request_format_version VARCHAR(64),
            wire_provider_format VARCHAR(128),
            processing_time_ms INTEGER,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMPTZ(3),
            updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `,
        "ALTER TABLE codex_provider_usage_events ADD COLUMN IF NOT EXISTS source_kind VARCHAR(32) NOT NULL DEFAULT 'codex_provider'",
        'ALTER TABLE codex_provider_usage_events ADD COLUMN IF NOT EXISTS source_id VARCHAR(191)',
        `
          CREATE TABLE IF NOT EXISTS llm_usage_rollups (
            id BIGSERIAL PRIMARY KEY,
            identity_key VARCHAR(191) NOT NULL DEFAULT 'xiaoni',
            bucket VARCHAR(16) NOT NULL,
            bucket_start TIMESTAMPTZ(3) NOT NULL,
            bucket_end TIMESTAMPTZ(3) NOT NULL,
            call_count BIGINT NOT NULL DEFAULT 0,
            input_tokens NUMERIC(20, 0) NOT NULL DEFAULT 0,
            cached_tokens NUMERIC(20, 0) NOT NULL DEFAULT 0,
            output_tokens NUMERIC(20, 0) NOT NULL DEFAULT 0,
            top_llm_request_slice_id VARCHAR(191),
            top_source_kind VARCHAR(32),
            top_fork_run_id VARCHAR(191),
            top_llm_call_id VARCHAR(128),
            top_trace_id VARCHAR(128),
            top_timestamp TIMESTAMPTZ(3),
            top_input_tokens NUMERIC(20, 0) NOT NULL DEFAULT 0,
            top_cached_tokens NUMERIC(20, 0) NOT NULL DEFAULT 0,
            top_output_tokens NUMERIC(20, 0) NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(identity_key, bucket, bucket_start)
          )
        `,
        "ALTER TABLE llm_usage_rollup_sources ADD COLUMN IF NOT EXISTS source_kind VARCHAR(32) NOT NULL DEFAULT 'main'",
        'ALTER TABLE llm_usage_rollup_sources ADD COLUMN IF NOT EXISTS fork_run_id VARCHAR(191)',
        'ALTER TABLE llm_usage_rollups ADD COLUMN IF NOT EXISTS top_source_kind VARCHAR(32)',
        'ALTER TABLE llm_usage_rollups ADD COLUMN IF NOT EXISTS top_fork_run_id VARCHAR(191)',
        `
          CREATE TABLE IF NOT EXISTS llm_usage_rollup_state (
            identity_key VARCHAR(191) PRIMARY KEY,
            version INTEGER NOT NULL DEFAULT 1,
            initialized_at TIMESTAMPTZ(3),
            source_max_id BIGINT NOT NULL DEFAULT 0,
            source_count BIGINT NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `,
        `
          CREATE TABLE IF NOT EXISTS tool_executions (
            id BIGSERIAL PRIMARY KEY,
            execution_id VARCHAR(191) NOT NULL UNIQUE,
            identity_key VARCHAR(191) NOT NULL DEFAULT 'xiaoni',
            llm_request_slice_id VARCHAR(191),
            llm_call_id VARCHAR(128),
            tool_call_id VARCHAR(191),
            tool_name VARCHAR(191) NOT NULL,
            arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
            raw_arguments TEXT,
            result JSONB NOT NULL DEFAULT '{}'::jsonb,
            status VARCHAR(32) NOT NULL DEFAULT 'running',
            error_message TEXT,
            side_effect BOOLEAN NOT NULL DEFAULT FALSE,
            trace_id VARCHAR(128),
            run_id VARCHAR(128),
            conversation_id BIGINT,
            agent_turn INTEGER,
            stack_call_item_id BIGINT,
            stack_output_item_id BIGINT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            started_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMPTZ(3),
            updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `,
        `
          CREATE TABLE IF NOT EXISTS stack_compactions (
            id BIGSERIAL PRIMARY KEY,
            identity_key VARCHAR(191) NOT NULL DEFAULT 'xiaoni',
            compacted_start_index BIGINT NOT NULL,
            compacted_end_index BIGINT NOT NULL,
            summary_stack_item_id BIGINT,
            method VARCHAR(64) NOT NULL,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `,
        `
          CREATE TABLE IF NOT EXISTS core_memory_compression_fork_runs (
            id BIGSERIAL PRIMARY KEY,
            fork_run_id VARCHAR(191) NOT NULL UNIQUE,
            identity_key VARCHAR(191) NOT NULL DEFAULT 'xiaoni',
            context_session_key VARCHAR(191),
            status VARCHAR(32) NOT NULL DEFAULT 'running',
            trace_id VARCHAR(128),
            run_id VARCHAR(128),
            conversation_id BIGINT,
            read_cutoff_after_conversation_id BIGINT,
            previous_read_cutoff_after_conversation_id BIGINT,
            summary_text TEXT,
            artifact JSONB NOT NULL DEFAULT '{}'::jsonb,
            error_message TEXT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            started_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMPTZ(3),
            created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `,
        `
          CREATE TABLE IF NOT EXISTS core_memory_compression_fork_items (
            id BIGSERIAL PRIMARY KEY,
            event_id VARCHAR(191) NOT NULL UNIQUE,
            fork_run_id VARCHAR(191) NOT NULL,
            identity_key VARCHAR(191) NOT NULL DEFAULT 'xiaoni',
            item_index BIGINT NOT NULL,
            item_kind VARCHAR(64) NOT NULL,
            role VARCHAR(32),
            phase VARCHAR(32),
            provider_item_id VARCHAR(191),
            tool_call_id VARCHAR(191),
            llm_request_slice_id VARCHAR(191),
            content JSONB NOT NULL DEFAULT '{}'::jsonb,
            visibility VARCHAR(32) NOT NULL DEFAULT 'model_visible',
            source_type VARCHAR(64),
            source_id VARCHAR(191),
            trace_id VARCHAR(128),
            run_id VARCHAR(128),
            conversation_id BIGINT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(fork_run_id, item_index)
          )
        `,
        `
          CREATE TABLE IF NOT EXISTS core_memory_compression_fork_slices (
            id BIGSERIAL PRIMARY KEY,
            slice_id VARCHAR(191) NOT NULL UNIQUE,
            fork_run_id VARCHAR(191) NOT NULL,
            llm_call_id VARCHAR(128),
            identity_key VARCHAR(191) NOT NULL DEFAULT 'xiaoni',
            input_start_index BIGINT,
            input_end_index BIGINT,
            input_stack_item_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            output_start_index BIGINT,
            output_end_index BIGINT,
            canonical_request JSONB NOT NULL DEFAULT '{}'::jsonb,
            wire_request JSONB,
            canonical_response JSONB,
            wire_response JSONB,
            raw_response JSONB,
            output_items JSONB NOT NULL DEFAULT '[]'::jsonb,
            status VARCHAR(32) NOT NULL DEFAULT 'completed',
            token_usage JSONB NOT NULL DEFAULT '{}'::jsonb,
            trace_id VARCHAR(128),
            run_id VARCHAR(128),
            conversation_id BIGINT,
            agent_turn INTEGER,
            model_name VARCHAR(191),
            model_provider VARCHAR(64),
            request_format_version VARCHAR(64),
            wire_provider_format VARCHAR(128),
            processing_time_ms INTEGER,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMPTZ(3),
            updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `,
        `
          CREATE TABLE IF NOT EXISTS core_memory_compression_fork_tool_executions (
            id BIGSERIAL PRIMARY KEY,
            execution_id VARCHAR(191) NOT NULL UNIQUE,
            fork_run_id VARCHAR(191) NOT NULL,
            identity_key VARCHAR(191) NOT NULL DEFAULT 'xiaoni',
            llm_request_slice_id VARCHAR(191),
            llm_call_id VARCHAR(128),
            tool_call_id VARCHAR(191),
            tool_name VARCHAR(191) NOT NULL,
            arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
            raw_arguments TEXT,
            result JSONB NOT NULL DEFAULT '{}'::jsonb,
            status VARCHAR(32) NOT NULL DEFAULT 'running',
            error_message TEXT,
            side_effect BOOLEAN NOT NULL DEFAULT FALSE,
            trace_id VARCHAR(128),
            run_id VARCHAR(128),
            conversation_id BIGINT,
            agent_turn INTEGER,
            stack_call_item_id BIGINT,
            stack_output_item_id BIGINT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            started_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMPTZ(3),
            updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `,
        `
          CREATE TABLE IF NOT EXISTS subconscious_agent_fork_runs (
            id BIGSERIAL PRIMARY KEY,
            fork_run_id VARCHAR(191) NOT NULL UNIQUE,
            identity_key VARCHAR(191) NOT NULL DEFAULT 'xiaoni',
            context_session_key VARCHAR(191),
            status VARCHAR(32) NOT NULL DEFAULT 'running',
            trace_id VARCHAR(128),
            run_id VARCHAR(128),
            conversation_id BIGINT,
            notify_queue_message_id BIGINT,
            summary_text TEXT,
            artifact JSONB NOT NULL DEFAULT '{}'::jsonb,
            error_message TEXT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            started_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMPTZ(3),
            created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `,
        `
          CREATE TABLE IF NOT EXISTS subconscious_agent_fork_items (
            id BIGSERIAL PRIMARY KEY,
            event_id VARCHAR(191) NOT NULL UNIQUE,
            fork_run_id VARCHAR(191) NOT NULL,
            identity_key VARCHAR(191) NOT NULL DEFAULT 'xiaoni',
            item_index BIGINT NOT NULL,
            item_kind VARCHAR(64) NOT NULL,
            role VARCHAR(32),
            phase VARCHAR(32),
            provider_item_id VARCHAR(191),
            tool_call_id VARCHAR(191),
            llm_request_slice_id VARCHAR(191),
            content JSONB NOT NULL DEFAULT '{}'::jsonb,
            visibility VARCHAR(32) NOT NULL DEFAULT 'model_visible',
            source_type VARCHAR(64),
            source_id VARCHAR(191),
            trace_id VARCHAR(128),
            run_id VARCHAR(128),
            conversation_id BIGINT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(fork_run_id, item_index)
          )
        `,
        `
          CREATE TABLE IF NOT EXISTS subconscious_agent_fork_slices (
            id BIGSERIAL PRIMARY KEY,
            slice_id VARCHAR(191) NOT NULL UNIQUE,
            fork_run_id VARCHAR(191) NOT NULL,
            llm_call_id VARCHAR(128),
            identity_key VARCHAR(191) NOT NULL DEFAULT 'xiaoni',
            input_start_index BIGINT,
            input_end_index BIGINT,
            input_stack_item_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            output_start_index BIGINT,
            output_end_index BIGINT,
            canonical_request JSONB NOT NULL DEFAULT '{}'::jsonb,
            wire_request JSONB,
            canonical_response JSONB,
            wire_response JSONB,
            raw_response JSONB,
            output_items JSONB NOT NULL DEFAULT '[]'::jsonb,
            status VARCHAR(32) NOT NULL DEFAULT 'completed',
            token_usage JSONB NOT NULL DEFAULT '{}'::jsonb,
            trace_id VARCHAR(128),
            run_id VARCHAR(128),
            conversation_id BIGINT,
            agent_turn INTEGER,
            model_name VARCHAR(191),
            model_provider VARCHAR(64),
            request_format_version VARCHAR(64),
            wire_provider_format VARCHAR(128),
            processing_time_ms INTEGER,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMPTZ(3),
            updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `,
        `
          CREATE TABLE IF NOT EXISTS subconscious_agent_fork_tool_executions (
            id BIGSERIAL PRIMARY KEY,
            execution_id VARCHAR(191) NOT NULL UNIQUE,
            fork_run_id VARCHAR(191) NOT NULL,
            identity_key VARCHAR(191) NOT NULL DEFAULT 'xiaoni',
            llm_request_slice_id VARCHAR(191),
            llm_call_id VARCHAR(128),
            tool_call_id VARCHAR(191),
            tool_name VARCHAR(191) NOT NULL,
            arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
            raw_arguments TEXT,
            result JSONB NOT NULL DEFAULT '{}'::jsonb,
            status VARCHAR(32) NOT NULL DEFAULT 'running',
            error_message TEXT,
            side_effect BOOLEAN NOT NULL DEFAULT false,
            trace_id VARCHAR(128),
            run_id VARCHAR(128),
            conversation_id BIGINT,
            agent_turn INTEGER,
            stack_call_item_id BIGINT,
            stack_output_item_id BIGINT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            started_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMPTZ(3),
            updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `,
        `
          CREATE TABLE IF NOT EXISTS image_vision_fork_runs (
            id BIGSERIAL PRIMARY KEY,
            fork_run_id VARCHAR(191) NOT NULL UNIQUE,
            identity_key VARCHAR(191) NOT NULL DEFAULT 'xiaoni',
            status VARCHAR(32) NOT NULL DEFAULT 'running',
            trace_id VARCHAR(128),
            run_id VARCHAR(128),
            conversation_id BIGINT,
            asset_id VARCHAR(64),
            image_id VARCHAR(64),
            media_tag VARCHAR(191),
            observation_id VARCHAR(64),
            description TEXT,
            artifact JSONB NOT NULL DEFAULT '{}'::jsonb,
            error_message TEXT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            started_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMPTZ(3),
            created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `,
        `
          CREATE TABLE IF NOT EXISTS image_vision_fork_items (
            id BIGSERIAL PRIMARY KEY,
            event_id VARCHAR(191) NOT NULL UNIQUE,
            fork_run_id VARCHAR(191) NOT NULL,
            identity_key VARCHAR(191) NOT NULL DEFAULT 'xiaoni',
            item_index BIGINT NOT NULL,
            item_kind VARCHAR(64) NOT NULL,
            role VARCHAR(32),
            phase VARCHAR(32),
            provider_item_id VARCHAR(191),
            tool_call_id VARCHAR(191),
            llm_request_slice_id VARCHAR(191),
            content JSONB NOT NULL DEFAULT '{}'::jsonb,
            visibility VARCHAR(32) NOT NULL DEFAULT 'model_visible',
            source_type VARCHAR(64),
            source_id VARCHAR(191),
            trace_id VARCHAR(128),
            run_id VARCHAR(128),
            conversation_id BIGINT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(fork_run_id, item_index)
          )
        `,
        `
          CREATE TABLE IF NOT EXISTS image_vision_fork_slices (
            id BIGSERIAL PRIMARY KEY,
            slice_id VARCHAR(191) NOT NULL UNIQUE,
            fork_run_id VARCHAR(191) NOT NULL,
            llm_call_id VARCHAR(128),
            identity_key VARCHAR(191) NOT NULL DEFAULT 'xiaoni',
            input_start_index BIGINT,
            input_end_index BIGINT,
            input_stack_item_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            output_start_index BIGINT,
            output_end_index BIGINT,
            canonical_request JSONB NOT NULL DEFAULT '{}'::jsonb,
            wire_request JSONB,
            canonical_response JSONB,
            wire_response JSONB,
            raw_response JSONB,
            output_items JSONB NOT NULL DEFAULT '[]'::jsonb,
            status VARCHAR(32) NOT NULL DEFAULT 'completed',
            token_usage JSONB NOT NULL DEFAULT '{}'::jsonb,
            trace_id VARCHAR(128),
            run_id VARCHAR(128),
            conversation_id BIGINT,
            agent_turn INTEGER,
            model_name VARCHAR(191),
            model_provider VARCHAR(64),
            request_format_version VARCHAR(64),
            wire_provider_format VARCHAR(128),
            processing_time_ms INTEGER,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMPTZ(3),
            updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `,
        'CREATE INDEX IF NOT EXISTS idx_agent_stack_items_identity_index ON agent_stack_items (identity_key, stack_index DESC)',
        'CREATE INDEX IF NOT EXISTS idx_agent_stack_items_trace ON agent_stack_items (trace_id, stack_index)',
        'CREATE INDEX IF NOT EXISTS idx_agent_stack_items_run ON agent_stack_items (run_id, stack_index)',
        'CREATE INDEX IF NOT EXISTS idx_agent_stack_items_tool_call ON agent_stack_items (tool_call_id)',
        'CREATE INDEX IF NOT EXISTS idx_agent_stack_items_slice ON agent_stack_items (llm_request_slice_id)',
        'CREATE INDEX IF NOT EXISTS idx_llm_request_slices_identity_time ON llm_request_slices (identity_key, created_at DESC, id DESC)',
        'CREATE INDEX IF NOT EXISTS idx_llm_request_slices_trace ON llm_request_slices (trace_id, agent_turn, id)',
        'CREATE INDEX IF NOT EXISTS idx_llm_request_slices_llm_call ON llm_request_slices (llm_call_id)',
        'CREATE INDEX IF NOT EXISTS idx_codex_provider_usage_identity_time ON codex_provider_usage_events (identity_key, created_at DESC, id DESC)',
        'CREATE INDEX IF NOT EXISTS idx_codex_provider_usage_source_time ON codex_provider_usage_events (source_kind, created_at DESC, id DESC)',
        'CREATE INDEX IF NOT EXISTS idx_codex_provider_usage_trace ON codex_provider_usage_events (trace_id, id)',
        'CREATE INDEX IF NOT EXISTS idx_codex_provider_usage_llm_call ON codex_provider_usage_events (llm_call_id)',
        'CREATE INDEX IF NOT EXISTS idx_llm_usage_rollup_sources_identity_time ON llm_usage_rollup_sources (identity_key, created_at, slice_id)',
        'CREATE INDEX IF NOT EXISTS idx_llm_usage_rollup_sources_hour ON llm_usage_rollup_sources (identity_key, hour_bucket_start)',
        'CREATE INDEX IF NOT EXISTS idx_llm_usage_rollup_sources_day ON llm_usage_rollup_sources (identity_key, day_bucket_start)',
        'CREATE INDEX IF NOT EXISTS idx_llm_usage_rollup_sources_month ON llm_usage_rollup_sources (identity_key, month_bucket_start)',
        'CREATE INDEX IF NOT EXISTS idx_llm_usage_rollups_identity_bucket_time ON llm_usage_rollups (identity_key, bucket, bucket_start)',
        'CREATE INDEX IF NOT EXISTS idx_tool_executions_trace ON tool_executions (trace_id, started_at DESC, id DESC)',
        'CREATE INDEX IF NOT EXISTS idx_tool_executions_tool_call ON tool_executions (tool_call_id)',
        'CREATE INDEX IF NOT EXISTS idx_tool_executions_slice ON tool_executions (llm_request_slice_id)',
        'CREATE INDEX IF NOT EXISTS idx_core_memory_fork_runs_trace ON core_memory_compression_fork_runs (trace_id, started_at DESC, id DESC)',
        'CREATE INDEX IF NOT EXISTS idx_core_memory_fork_runs_run ON core_memory_compression_fork_runs (run_id, started_at DESC, id DESC)',
        'CREATE INDEX IF NOT EXISTS idx_core_memory_fork_items_run_index ON core_memory_compression_fork_items (fork_run_id, item_index)',
        'CREATE INDEX IF NOT EXISTS idx_core_memory_fork_items_tool_call ON core_memory_compression_fork_items (tool_call_id)',
        'CREATE INDEX IF NOT EXISTS idx_core_memory_fork_items_slice ON core_memory_compression_fork_items (llm_request_slice_id)',
        'CREATE INDEX IF NOT EXISTS idx_core_memory_fork_slices_run_turn ON core_memory_compression_fork_slices (fork_run_id, agent_turn, id)',
        'CREATE INDEX IF NOT EXISTS idx_core_memory_fork_tool_run_time ON core_memory_compression_fork_tool_executions (fork_run_id, started_at DESC, id DESC)',
        'CREATE INDEX IF NOT EXISTS idx_core_memory_fork_tool_call ON core_memory_compression_fork_tool_executions (tool_call_id)',
        'CREATE INDEX IF NOT EXISTS idx_core_memory_fork_tool_slice ON core_memory_compression_fork_tool_executions (llm_request_slice_id)',
        'CREATE INDEX IF NOT EXISTS idx_subconscious_fork_runs_trace ON subconscious_agent_fork_runs (trace_id, started_at DESC, id DESC)',
        'CREATE INDEX IF NOT EXISTS idx_subconscious_fork_runs_run ON subconscious_agent_fork_runs (run_id, started_at DESC, id DESC)',
        'CREATE INDEX IF NOT EXISTS idx_subconscious_fork_items_run_index ON subconscious_agent_fork_items (fork_run_id, item_index)',
        'CREATE INDEX IF NOT EXISTS idx_subconscious_fork_items_tool_call ON subconscious_agent_fork_items (tool_call_id)',
        'CREATE INDEX IF NOT EXISTS idx_subconscious_fork_items_slice ON subconscious_agent_fork_items (llm_request_slice_id)',
        'CREATE INDEX IF NOT EXISTS idx_subconscious_fork_slices_run_turn ON subconscious_agent_fork_slices (fork_run_id, agent_turn, id)',
        'CREATE INDEX IF NOT EXISTS idx_subconscious_fork_tool_run_time ON subconscious_agent_fork_tool_executions (fork_run_id, started_at DESC, id DESC)',
        'CREATE INDEX IF NOT EXISTS idx_subconscious_fork_tool_call ON subconscious_agent_fork_tool_executions (tool_call_id)',
        'CREATE INDEX IF NOT EXISTS idx_subconscious_fork_tool_slice ON subconscious_agent_fork_tool_executions (llm_request_slice_id)',
        'CREATE INDEX IF NOT EXISTS idx_image_vision_fork_runs_trace ON image_vision_fork_runs (trace_id, started_at DESC, id DESC)',
        'CREATE INDEX IF NOT EXISTS idx_image_vision_fork_runs_run ON image_vision_fork_runs (run_id, started_at DESC, id DESC)',
        'CREATE INDEX IF NOT EXISTS idx_image_vision_fork_runs_asset ON image_vision_fork_runs (asset_id, started_at DESC, id DESC)',
        'CREATE INDEX IF NOT EXISTS idx_image_vision_fork_items_run_index ON image_vision_fork_items (fork_run_id, item_index)',
        'CREATE INDEX IF NOT EXISTS idx_image_vision_fork_items_slice ON image_vision_fork_items (llm_request_slice_id)',
        'CREATE INDEX IF NOT EXISTS idx_image_vision_fork_slices_run_turn ON image_vision_fork_slices (fork_run_id, agent_turn, id)'
      ]);
      await initializeLlmUsageRollupsIfNeeded(sql);
    });
  }

  async function getAgentStackHead(input = {}, config = {}) {
    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        'SELECT COALESCE(MAX(stack_index), 0) AS stack_index FROM agent_stack_items WHERE identity_key = ?',
        [firstString(input.identityKey, input.identity_key, 'xiaoni')]
      );
      return Number(rows[0]?.stack_index || 0);
    });
  }

  async function appendAgentStackItems(input = {}, config = {}) {
    const rawItems = Array.isArray(input.items)
      ? input.items
      : input.item
        ? [input.item]
        : [];
    if (rawItems.length === 0) {
      return [];
    }
    await ensureXiaoniAgentStackSchema(input, config);
    const identityKey = firstString(input.identityKey, input.identity_key, 'xiaoni');

    return withSql(input, config, async (sql) => {
      const appendWithExecutor = async (executor) => {
        if (typeof executor.query === 'function') {
          await executor.query('SELECT pg_advisory_xact_lock(hashtext(?))', [`agent_stack_items:${identityKey}`]).catch(() => []);
        }
        const headRows = await executor.query(
          'SELECT COALESCE(MAX(stack_index), 0) AS stack_index FROM agent_stack_items WHERE identity_key = ?',
          [identityKey]
        );
        let nextIndex = Number(headRows[0]?.stack_index || 0) + 1;
        const rows = [];
        for (const item of rawItems) {
          const row = await executor.query(
            `
              INSERT INTO agent_stack_items (
                event_id,
                identity_key,
                stack_index,
                item_kind,
                role,
                phase,
                provider_item_id,
                tool_call_id,
                llm_request_slice_id,
                content,
                visibility,
                source_type,
                source_id,
                trace_id,
                run_id,
                conversation_id,
                metadata
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?::jsonb)
              ON CONFLICT (event_id) DO UPDATE SET
                updated_at = agent_stack_items.updated_at
              RETURNING *
            `,
            [
              buildStackEventId(identityKey, item, nextIndex),
              identityKey,
              nextIndex,
              firstString(item.itemKind, item.item_kind, item.kind, 'state_event'),
              firstString(item.role),
              firstString(item.phase),
              firstString(item.providerItemId, item.provider_item_id, item.id),
              firstString(item.toolCallId, item.tool_call_id, item.call_id),
              firstString(item.llmRequestSliceId, item.llm_request_slice_id, input.llmRequestSliceId, input.llm_request_slice_id),
              JSON.stringify(normalizeValue(item.content ?? item.payload ?? {})),
              firstString(item.visibility, input.visibility, 'model_visible'),
              firstString(item.sourceType, item.source_type, input.sourceType, input.source_type),
              firstString(item.sourceId, item.source_id, input.sourceId, input.source_id),
              firstString(item.traceId, item.trace_id, input.traceId, input.trace_id),
              firstString(item.runId, item.run_id, input.runId, input.run_id),
              normalizeBigIntId(item.conversationId ?? item.conversation_id ?? input.conversationId ?? input.conversation_id),
              JSON.stringify(normalizeJsonObject(item.metadata, {}))
            ]
          );
          nextIndex += 1;
          if (row[0]) {
            rows.push(row[0]);
          }
        }
        return rows.map(normalizeStackRow).filter(Boolean);
      };

      if (typeof sql.withTransaction === 'function') {
        return sql.withTransaction(appendWithExecutor);
      }
      return appendWithExecutor(sql);
    });
  }

  async function appendAgentStackItem(input = {}, config = {}) {
    const rows = await appendAgentStackItems({
      ...input,
      items: [input]
    }, config);
    return rows[0] || null;
  }

  async function recordLlmRequestSlice(input = {}, config = {}) {
    await ensureXiaoniAgentStackSchema(input, config);
    const sliceId = buildSliceId(input);
    const completedAt = input.completedAt || input.completed_at || (firstString(input.status, 'completed') === 'running' ? null : new Date());
    return withSql(input, config, async (sql) => {
      const recordWithExecutor = async (executor) => {
        const rows = await executor.query(
          `
            INSERT INTO llm_request_slices (
              slice_id,
              llm_call_id,
              identity_key,
              input_start_index,
              input_end_index,
              input_stack_item_ids,
              output_start_index,
              output_end_index,
              canonical_request,
              wire_request,
              canonical_response,
              wire_response,
              raw_response,
              output_items,
              status,
              token_usage,
              trace_id,
              run_id,
              conversation_id,
              agent_turn,
              model_name,
              model_provider,
              request_format_version,
              wire_provider_format,
              processing_time_ms,
              metadata,
              completed_at
            )
            VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::timestamptz)
            ON CONFLICT (slice_id) DO UPDATE SET
              llm_call_id = EXCLUDED.llm_call_id,
              input_start_index = EXCLUDED.input_start_index,
              input_end_index = EXCLUDED.input_end_index,
              input_stack_item_ids = EXCLUDED.input_stack_item_ids,
              output_start_index = EXCLUDED.output_start_index,
              output_end_index = EXCLUDED.output_end_index,
              canonical_request = EXCLUDED.canonical_request,
              wire_request = EXCLUDED.wire_request,
              canonical_response = EXCLUDED.canonical_response,
              wire_response = EXCLUDED.wire_response,
              raw_response = EXCLUDED.raw_response,
              output_items = EXCLUDED.output_items,
              status = EXCLUDED.status,
              token_usage = EXCLUDED.token_usage,
              trace_id = EXCLUDED.trace_id,
              run_id = EXCLUDED.run_id,
              conversation_id = EXCLUDED.conversation_id,
              agent_turn = EXCLUDED.agent_turn,
              model_name = EXCLUDED.model_name,
              model_provider = EXCLUDED.model_provider,
              request_format_version = EXCLUDED.request_format_version,
              wire_provider_format = EXCLUDED.wire_provider_format,
              processing_time_ms = EXCLUDED.processing_time_ms,
              metadata = EXCLUDED.metadata,
              completed_at = COALESCE(EXCLUDED.completed_at, llm_request_slices.completed_at),
              updated_at = CURRENT_TIMESTAMP
            RETURNING *
          `,
          [
            sliceId,
            firstString(input.llmCallId, input.llm_call_id),
            firstString(input.identityKey, input.identity_key, 'xiaoni'),
            normalizeInteger(input.inputStartIndex ?? input.input_start_index),
            normalizeInteger(input.inputEndIndex ?? input.input_end_index),
            JSON.stringify(normalizeJsonArray(input.inputStackItemIds ?? input.input_stack_item_ids, [])),
            normalizeInteger(input.outputStartIndex ?? input.output_start_index),
            normalizeInteger(input.outputEndIndex ?? input.output_end_index),
            JSON.stringify(normalizeValue(input.canonicalRequest ?? input.canonical_request ?? {})),
            input.wireRequest || input.wire_request ? JSON.stringify(normalizeValue(input.wireRequest ?? input.wire_request)) : null,
            input.canonicalResponse || input.canonical_response ? JSON.stringify(normalizeValue(input.canonicalResponse ?? input.canonical_response)) : null,
            input.wireResponse || input.wire_response ? JSON.stringify(normalizeValue(input.wireResponse ?? input.wire_response)) : null,
            input.rawResponse || input.raw_response ? JSON.stringify(normalizeValue(input.rawResponse ?? input.raw_response)) : null,
            JSON.stringify(normalizeJsonArray(input.outputItems ?? input.output_items, [])),
            firstString(input.status, 'completed'),
            JSON.stringify(normalizeJsonObject(input.tokenUsage ?? input.token_usage ?? input.usage, {})),
            firstString(input.traceId, input.trace_id),
            firstString(input.runId, input.run_id),
            normalizeBigIntId(input.conversationId ?? input.conversation_id),
            normalizeInteger(input.agentTurn ?? input.agent_turn),
            firstString(input.modelName, input.model_name),
            firstString(input.modelProvider, input.model_provider),
            firstString(input.requestFormatVersion, input.request_format_version),
            firstString(input.wireProviderFormat, input.wire_provider_format),
            normalizeInteger(input.processingTimeMs ?? input.processing_time_ms),
            JSON.stringify(normalizeJsonObject(input.metadata, {})),
            normalizeDate(completedAt)
          ]
        );
        await syncLlmUsageRollupForSlice(executor, sliceId);
        return normalizeLlmSliceRow(rows[0]);
      };
      if (typeof sql.withTransaction === 'function') {
        return sql.withTransaction(recordWithExecutor);
      }
      return recordWithExecutor(sql);
    });
  }

  async function recordCodexProviderUsageEvent(input = {}, config = {}) {
    await ensureXiaoniAgentStackSchema(input, config);
    const eventId = buildCodexProviderUsageEventId(input);
    const completedAt = input.completedAt || input.completed_at || (firstString(input.status, 'completed') === 'running' ? null : new Date());
    const createdAt = input.createdAt || input.created_at || null;
    return withSql(input, config, async (sql) => {
      const recordWithExecutor = async (executor) => {
        const rows = await executor.query(
          `
            INSERT INTO codex_provider_usage_events (
              event_id,
              source_kind,
              source_id,
              identity_key,
              llm_call_id,
              trace_id,
              run_id,
              conversation_id,
              canonical_request,
              wire_request,
              canonical_response,
              wire_response,
              raw_response,
              output_items,
              status,
              token_usage,
              model_name,
              model_provider,
              request_format_version,
              wire_provider_format,
              processing_time_ms,
              metadata,
              created_at,
              completed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?::jsonb, ?, ?, ?, ?, ?, ?::jsonb, COALESCE(?::timestamptz, CURRENT_TIMESTAMP), ?::timestamptz)
            ON CONFLICT (event_id) DO UPDATE SET
              source_kind = EXCLUDED.source_kind,
              source_id = EXCLUDED.source_id,
              identity_key = EXCLUDED.identity_key,
              llm_call_id = EXCLUDED.llm_call_id,
              trace_id = EXCLUDED.trace_id,
              run_id = EXCLUDED.run_id,
              conversation_id = EXCLUDED.conversation_id,
              canonical_request = EXCLUDED.canonical_request,
              wire_request = EXCLUDED.wire_request,
              canonical_response = EXCLUDED.canonical_response,
              wire_response = EXCLUDED.wire_response,
              raw_response = EXCLUDED.raw_response,
              output_items = EXCLUDED.output_items,
              status = EXCLUDED.status,
              token_usage = EXCLUDED.token_usage,
              model_name = EXCLUDED.model_name,
              model_provider = EXCLUDED.model_provider,
              request_format_version = EXCLUDED.request_format_version,
              wire_provider_format = EXCLUDED.wire_provider_format,
              processing_time_ms = EXCLUDED.processing_time_ms,
              metadata = EXCLUDED.metadata,
              completed_at = COALESCE(EXCLUDED.completed_at, codex_provider_usage_events.completed_at),
              updated_at = CURRENT_TIMESTAMP
            RETURNING *
          `,
          [
            eventId,
            normalizeCodexProviderUsageSourceKind(input.sourceKind ?? input.source_kind),
            firstString(input.sourceId, input.source_id),
            firstString(input.identityKey, input.identity_key, 'xiaoni'),
            firstString(input.llmCallId, input.llm_call_id),
            firstString(input.traceId, input.trace_id),
            firstString(input.runId, input.run_id),
            normalizeBigIntId(input.conversationId ?? input.conversation_id),
            JSON.stringify(normalizeValue(input.canonicalRequest ?? input.canonical_request ?? {})),
            input.wireRequest || input.wire_request ? JSON.stringify(normalizeValue(input.wireRequest ?? input.wire_request)) : null,
            input.canonicalResponse || input.canonical_response ? JSON.stringify(normalizeValue(input.canonicalResponse ?? input.canonical_response)) : null,
            input.wireResponse || input.wire_response ? JSON.stringify(normalizeValue(input.wireResponse ?? input.wire_response)) : null,
            input.rawResponse || input.raw_response ? JSON.stringify(normalizeValue(input.rawResponse ?? input.raw_response)) : null,
            JSON.stringify(normalizeJsonArray(input.outputItems ?? input.output_items, [])),
            firstString(input.status, 'completed'),
            JSON.stringify(normalizeJsonObject(input.tokenUsage ?? input.token_usage ?? input.usage, {})),
            firstString(input.modelName, input.model_name),
            firstString(input.modelProvider, input.model_provider, 'codex'),
            firstString(input.requestFormatVersion, input.request_format_version),
            firstString(input.wireProviderFormat, input.wire_provider_format),
            normalizeInteger(input.processingTimeMs ?? input.processing_time_ms),
            JSON.stringify(normalizeJsonObject(input.metadata, {})),
            normalizeDate(createdAt),
            normalizeDate(completedAt)
          ]
        );
        await syncLlmUsageRollupForCodexProviderEvent(executor, eventId);
        return normalizeCodexProviderUsageEventRow(rows[0]);
      };
      if (typeof sql.withTransaction === 'function') {
        return sql.withTransaction(recordWithExecutor);
      }
      return recordWithExecutor(sql);
    });
  }

  async function updateLlmRequestSliceStackLinks(input = {}, config = {}) {
    await ensureXiaoniAgentStackSchema(input, config);
    const sliceId = firstString(input.sliceId, input.slice_id, input.llmCallId, input.llm_call_id);
    if (!sliceId) {
      return null;
    }
    const inputStackItemIdsValue = input.inputStackItemIds ?? input.input_stack_item_ids;
    const shouldUpdateInputStackItemIds = Array.isArray(inputStackItemIdsValue);
    const inputStackItemIds = shouldUpdateInputStackItemIds
      ? normalizeJsonArray(inputStackItemIdsValue, [])
      : [];
    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        `
          UPDATE llm_request_slices
          SET
            input_start_index = COALESCE(?, input_start_index),
            input_end_index = COALESCE(?, input_end_index),
            input_stack_item_ids = CASE WHEN ? THEN ?::jsonb ELSE input_stack_item_ids END,
            output_start_index = COALESCE(?, output_start_index),
            output_end_index = COALESCE(?, output_end_index),
            updated_at = CURRENT_TIMESTAMP
          WHERE slice_id = ?
          RETURNING *
        `,
        [
          normalizeInteger(input.inputStartIndex ?? input.input_start_index),
          normalizeInteger(input.inputEndIndex ?? input.input_end_index),
          shouldUpdateInputStackItemIds,
          JSON.stringify(inputStackItemIds),
          normalizeInteger(input.outputStartIndex ?? input.output_start_index),
          normalizeInteger(input.outputEndIndex ?? input.output_end_index),
          sliceId
        ]
      );
      return normalizeLlmSliceRow(rows[0]);
    });
  }

  async function recordToolExecution(input = {}, config = {}) {
    await ensureXiaoniAgentStackSchema(input, config);
    const executionId = buildToolExecutionId(input);
    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        `
          INSERT INTO tool_executions (
            execution_id,
            identity_key,
            llm_request_slice_id,
            llm_call_id,
            tool_call_id,
            tool_name,
            arguments,
            raw_arguments,
            result,
            status,
            error_message,
            side_effect,
            trace_id,
            run_id,
            conversation_id,
            agent_turn,
            stack_call_item_id,
            stack_output_item_id,
            metadata,
            started_at,
            completed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, COALESCE(?::timestamptz, CURRENT_TIMESTAMP), ?::timestamptz)
          ON CONFLICT (execution_id) DO UPDATE SET
            llm_request_slice_id = EXCLUDED.llm_request_slice_id,
            llm_call_id = EXCLUDED.llm_call_id,
            tool_call_id = EXCLUDED.tool_call_id,
            tool_name = EXCLUDED.tool_name,
            arguments = EXCLUDED.arguments,
            raw_arguments = EXCLUDED.raw_arguments,
            result = EXCLUDED.result,
            status = EXCLUDED.status,
            error_message = EXCLUDED.error_message,
            side_effect = EXCLUDED.side_effect,
            trace_id = EXCLUDED.trace_id,
            run_id = EXCLUDED.run_id,
            conversation_id = EXCLUDED.conversation_id,
            agent_turn = EXCLUDED.agent_turn,
            stack_call_item_id = COALESCE(EXCLUDED.stack_call_item_id, tool_executions.stack_call_item_id),
            stack_output_item_id = COALESCE(EXCLUDED.stack_output_item_id, tool_executions.stack_output_item_id),
            metadata = EXCLUDED.metadata,
            completed_at = COALESCE(EXCLUDED.completed_at, tool_executions.completed_at),
            updated_at = CURRENT_TIMESTAMP
          RETURNING *
        `,
        [
          executionId,
          firstString(input.identityKey, input.identity_key, 'xiaoni'),
          firstString(input.llmRequestSliceId, input.llm_request_slice_id),
          firstString(input.llmCallId, input.llm_call_id),
          firstString(input.toolCallId, input.tool_call_id),
          firstString(input.toolName, input.tool_name, 'unknown'),
          JSON.stringify(normalizeJsonObject(input.arguments, {})),
          firstString(input.rawArguments, input.raw_arguments),
          JSON.stringify(normalizeJsonObject(input.result, {})),
          firstString(input.status, 'running'),
          firstString(input.errorMessage, input.error_message),
          normalizeBoolean(input.sideEffect ?? input.side_effect),
          firstString(input.traceId, input.trace_id),
          firstString(input.runId, input.run_id),
          normalizeBigIntId(input.conversationId ?? input.conversation_id),
          normalizeInteger(input.agentTurn ?? input.agent_turn),
          normalizeBigIntId(input.stackCallItemId ?? input.stack_call_item_id),
          normalizeBigIntId(input.stackOutputItemId ?? input.stack_output_item_id),
          JSON.stringify(normalizeJsonObject(input.metadata, {})),
          normalizeDate(input.startedAt || input.started_at),
          normalizeDate(input.completedAt || input.completed_at || (firstString(input.status) === 'completed' || firstString(input.status) === 'failed' ? new Date() : null))
        ]
      );
      return normalizeToolExecutionRow(rows[0]);
    });
  }

  async function completeToolExecution(input = {}, config = {}) {
    const executionId = firstString(input.executionId, input.execution_id);
    if (!executionId) {
      return null;
    }
    await ensureXiaoniAgentStackSchema(input, config);
    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        `
          UPDATE tool_executions
          SET status = ?,
              result = ?::jsonb,
              error_message = ?,
              stack_output_item_id = COALESCE(?, stack_output_item_id),
              completed_at = COALESCE(?::timestamptz, CURRENT_TIMESTAMP),
              updated_at = CURRENT_TIMESTAMP
          WHERE execution_id = ?
          RETURNING *
        `,
        [
          firstString(input.status, 'completed'),
          JSON.stringify(normalizeJsonObject(input.result, {})),
          firstString(input.errorMessage, input.error_message),
          normalizeBigIntId(input.stackOutputItemId ?? input.stack_output_item_id),
          normalizeDate(input.completedAt || input.completed_at),
          executionId
        ]
      );
      return normalizeToolExecutionRow(rows[0]);
    });
  }

  async function recordCoreMemoryCompressionForkRun(input = {}, config = {}) {
    await ensureXiaoniAgentStackSchema(input, config);
    const forkRunId = buildCompressionForkRunId(input);
    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        `
          INSERT INTO core_memory_compression_fork_runs (
            fork_run_id,
            identity_key,
            context_session_key,
            status,
            trace_id,
            run_id,
            conversation_id,
            read_cutoff_after_conversation_id,
            previous_read_cutoff_after_conversation_id,
            summary_text,
            artifact,
            error_message,
            metadata,
            started_at,
            completed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::jsonb, COALESCE(?::timestamptz, CURRENT_TIMESTAMP), ?::timestamptz)
          ON CONFLICT (fork_run_id) DO UPDATE SET
            context_session_key = COALESCE(EXCLUDED.context_session_key, core_memory_compression_fork_runs.context_session_key),
            status = EXCLUDED.status,
            trace_id = COALESCE(EXCLUDED.trace_id, core_memory_compression_fork_runs.trace_id),
            run_id = COALESCE(EXCLUDED.run_id, core_memory_compression_fork_runs.run_id),
            conversation_id = COALESCE(EXCLUDED.conversation_id, core_memory_compression_fork_runs.conversation_id),
            read_cutoff_after_conversation_id = COALESCE(EXCLUDED.read_cutoff_after_conversation_id, core_memory_compression_fork_runs.read_cutoff_after_conversation_id),
            previous_read_cutoff_after_conversation_id = COALESCE(EXCLUDED.previous_read_cutoff_after_conversation_id, core_memory_compression_fork_runs.previous_read_cutoff_after_conversation_id),
            summary_text = COALESCE(EXCLUDED.summary_text, core_memory_compression_fork_runs.summary_text),
            artifact = EXCLUDED.artifact,
            error_message = EXCLUDED.error_message,
            metadata = EXCLUDED.metadata,
            completed_at = COALESCE(EXCLUDED.completed_at, core_memory_compression_fork_runs.completed_at),
            updated_at = CURRENT_TIMESTAMP
          RETURNING *
        `,
        [
          forkRunId,
          firstString(input.identityKey, input.identity_key, 'xiaoni'),
          firstString(input.contextSessionKey, input.context_session_key),
          firstString(input.status, 'running'),
          firstString(input.traceId, input.trace_id),
          firstString(input.runId, input.run_id),
          normalizeBigIntId(input.conversationId ?? input.conversation_id),
          normalizeBigIntId(input.readCutoffAfterConversationId ?? input.read_cutoff_after_conversation_id),
          normalizeBigIntId(input.previousReadCutoffAfterConversationId ?? input.previous_read_cutoff_after_conversation_id),
          firstString(input.summaryText, input.summary_text),
          JSON.stringify(normalizeJsonObject(input.artifact, {})),
          firstString(input.errorMessage, input.error_message),
          JSON.stringify(normalizeJsonObject(input.metadata, {})),
          normalizeDate(input.startedAt || input.started_at),
          normalizeDate(input.completedAt || input.completed_at || (firstString(input.status) === 'completed' || firstString(input.status) === 'failed' ? new Date() : null))
        ]
      );
      return normalizeCompressionForkRunRow(rows[0]);
    });
  }

  async function completeCoreMemoryCompressionForkRun(input = {}, config = {}) {
    const forkRunId = firstString(input.forkRunId, input.fork_run_id);
    if (!forkRunId) {
      return null;
    }
    await ensureXiaoniAgentStackSchema(input, config);
    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        `
          UPDATE core_memory_compression_fork_runs
          SET status = ?,
              summary_text = COALESCE(?, summary_text),
              artifact = ?::jsonb,
              error_message = ?,
              metadata = ?::jsonb,
              completed_at = COALESCE(?::timestamptz, CURRENT_TIMESTAMP),
              updated_at = CURRENT_TIMESTAMP
          WHERE fork_run_id = ?
          RETURNING *
        `,
        [
          firstString(input.status, 'completed'),
          firstString(input.summaryText, input.summary_text),
          JSON.stringify(normalizeJsonObject(input.artifact, {})),
          firstString(input.errorMessage, input.error_message),
          JSON.stringify(normalizeJsonObject(input.metadata, {})),
          normalizeDate(input.completedAt || input.completed_at),
          forkRunId
        ]
      );
      return normalizeCompressionForkRunRow(rows[0]);
    });
  }

  // All three fork-run families (core-memory compression, subconscious agent,
  // image vision) are in-memory fire-and-forget promises in agent-service. A
  // process restart kills them mid-run, leaving their durable row stuck at
  // status='running'. For core-memory compression that zombie blocks a fresh
  // manual 压缩记忆 for 30min (findActiveCoreMemoryCompressionForkRun treats a
  // recent running row as live). Since agent-service is single-instance, any
  // running row at our own startup is necessarily orphaned: reap it to failed.
  async function reapOrphanedForkRuns(input = {}, config = {}) {
    await ensureXiaoniAgentStackSchema(input, config);
    const identityKey = firstString(input.identityKey, input.identity_key, 'xiaoni');
    const reason = firstString(input.reason, 'orphaned_on_startup');
    const tables = [
      { table: 'core_memory_compression_fork_runs', key: 'coreMemoryCompression' },
      { table: 'subconscious_agent_fork_runs', key: 'subconscious' },
      { table: 'image_vision_fork_runs', key: 'imageVision' }
    ];
    return withSql(input, config, async (sql) => {
      const result = { coreMemoryCompression: [], subconscious: [], imageVision: [], total: 0 };
      for (const { table, key } of tables) {
        const rows = await sql.query(
          `
            UPDATE ${table}
            SET status = 'failed',
                completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
                error_message = COALESCE(error_message, ?),
                metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{abort_reason}', to_jsonb(?::text), true),
                updated_at = CURRENT_TIMESTAMP
            WHERE identity_key = ?
              AND status = 'running'
            RETURNING fork_run_id
          `,
          [reason, reason, identityKey]
        );
        const forkRunIds = (rows || [])
          .map((row) => firstString(row.fork_run_id, row.forkRunId))
          .filter(Boolean);
        result[key] = forkRunIds;
        result.total += forkRunIds.length;
      }
      return result;
    });
  }

  async function recordSubconsciousAgentForkRun(input = {}, config = {}) {
    await ensureXiaoniAgentStackSchema(input, config);
    const forkRunId = buildSubconsciousForkRunId(input);
    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        `
          INSERT INTO subconscious_agent_fork_runs (
            fork_run_id,
            identity_key,
            context_session_key,
            status,
            trace_id,
            run_id,
            conversation_id,
            notify_queue_message_id,
            summary_text,
            artifact,
            error_message,
            metadata,
            started_at,
            completed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::jsonb, COALESCE(?::timestamptz, CURRENT_TIMESTAMP), ?::timestamptz)
          ON CONFLICT (fork_run_id) DO UPDATE SET
            context_session_key = COALESCE(EXCLUDED.context_session_key, subconscious_agent_fork_runs.context_session_key),
            status = EXCLUDED.status,
            trace_id = COALESCE(EXCLUDED.trace_id, subconscious_agent_fork_runs.trace_id),
            run_id = COALESCE(EXCLUDED.run_id, subconscious_agent_fork_runs.run_id),
            conversation_id = COALESCE(EXCLUDED.conversation_id, subconscious_agent_fork_runs.conversation_id),
            notify_queue_message_id = COALESCE(EXCLUDED.notify_queue_message_id, subconscious_agent_fork_runs.notify_queue_message_id),
            summary_text = COALESCE(EXCLUDED.summary_text, subconscious_agent_fork_runs.summary_text),
            artifact = EXCLUDED.artifact,
            error_message = EXCLUDED.error_message,
            metadata = EXCLUDED.metadata,
            completed_at = COALESCE(EXCLUDED.completed_at, subconscious_agent_fork_runs.completed_at),
            updated_at = CURRENT_TIMESTAMP
          RETURNING *
        `,
        [
          forkRunId,
          firstString(input.identityKey, input.identity_key, 'xiaoni'),
          firstString(input.contextSessionKey, input.context_session_key),
          firstString(input.status, 'running'),
          firstString(input.traceId, input.trace_id),
          firstString(input.runId, input.run_id),
          normalizeBigIntId(input.conversationId ?? input.conversation_id),
          normalizeBigIntId(input.notifyQueueMessageId ?? input.notify_queue_message_id),
          firstString(input.summaryText, input.summary_text),
          JSON.stringify(normalizeJsonObject(input.artifact, {})),
          firstString(input.errorMessage, input.error_message),
          JSON.stringify(normalizeJsonObject(input.metadata, {})),
          normalizeDate(input.startedAt || input.started_at),
          normalizeDate(input.completedAt || input.completed_at || (firstString(input.status) === 'completed' || firstString(input.status) === 'failed' ? new Date() : null))
        ]
      );
      return normalizeSubconsciousForkRunRow(rows[0]);
    });
  }

  async function completeSubconsciousAgentForkRun(input = {}, config = {}) {
    const forkRunId = firstString(input.forkRunId, input.fork_run_id);
    if (!forkRunId) {
      return null;
    }
    await ensureXiaoniAgentStackSchema(input, config);
    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        `
          UPDATE subconscious_agent_fork_runs
          SET status = ?,
              notify_queue_message_id = COALESCE(?, notify_queue_message_id),
              summary_text = COALESCE(?, summary_text),
              artifact = ?::jsonb,
              error_message = ?,
              metadata = ?::jsonb,
              completed_at = COALESCE(?::timestamptz, CURRENT_TIMESTAMP),
              updated_at = CURRENT_TIMESTAMP
          WHERE fork_run_id = ?
          RETURNING *
        `,
        [
          firstString(input.status, 'completed'),
          normalizeBigIntId(input.notifyQueueMessageId ?? input.notify_queue_message_id),
          firstString(input.summaryText, input.summary_text),
          JSON.stringify(normalizeJsonObject(input.artifact, {})),
          firstString(input.errorMessage, input.error_message),
          JSON.stringify(normalizeJsonObject(input.metadata, {})),
          normalizeDate(input.completedAt || input.completed_at),
          forkRunId
        ]
      );
      return normalizeSubconsciousForkRunRow(rows[0]);
    });
  }

  async function findActiveCoreMemoryCompressionForkRun(input = {}, config = {}) {
    await ensureXiaoniAgentStackSchema(input, config);
    const contextSessionKey = firstString(input.contextSessionKey, input.context_session_key);
    const compressionCoveredEndConversationId = normalizeBigIntId(
      input.compressionCoveredEndConversationId ?? input.compression_covered_end_conversation_id
    );
    if (!contextSessionKey || compressionCoveredEndConversationId === null) {
      return null;
    }
    const staleAfterMinutes = Number.parseInt(String(input.staleAfterMinutes ?? input.stale_after_minutes ?? 30), 10);
    const effectiveStaleAfterMinutes = Number.isFinite(staleAfterMinutes) && staleAfterMinutes > 0
      ? staleAfterMinutes
      : 30;
    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        `
          SELECT *
          FROM core_memory_compression_fork_runs
          WHERE context_session_key = ?
            AND status = 'running'
            AND metadata->>'compression_covered_end_conversation_id' = ?
            AND started_at > NOW() - (?::text || ' minutes')::interval
          ORDER BY started_at DESC, id DESC
          LIMIT 1
        `,
        [
          contextSessionKey,
          String(compressionCoveredEndConversationId),
          String(effectiveStaleAfterMinutes)
        ]
      );
      return normalizeCompressionForkRunRow(rows[0]);
    });
  }

  async function appendCoreMemoryCompressionForkItems(input = {}, config = {}) {
    const rawItems = Array.isArray(input.items)
      ? input.items
      : input.item
        ? [input.item]
        : [];
    const forkRunId = firstString(input.forkRunId, input.fork_run_id);
    if (!forkRunId || rawItems.length === 0) {
      return [];
    }
    await ensureXiaoniAgentStackSchema(input, config);
    const identityKey = firstString(input.identityKey, input.identity_key, 'xiaoni');

    return withSql(input, config, async (sql) => {
      const appendWithExecutor = async (executor) => {
        if (typeof executor.query === 'function') {
          await executor.query('SELECT pg_advisory_xact_lock(hashtext(?))', [`core_memory_compression_fork_items:${forkRunId}`]).catch(() => []);
        }
        const headRows = await executor.query(
          'SELECT COALESCE(MAX(item_index), 0) AS item_index FROM core_memory_compression_fork_items WHERE fork_run_id = ?',
          [forkRunId]
        );
        let nextIndex = Number(headRows[0]?.item_index || 0) + 1;
        const rows = [];
        for (const item of rawItems) {
          const row = await executor.query(
            `
              INSERT INTO core_memory_compression_fork_items (
                event_id,
                fork_run_id,
                identity_key,
                item_index,
                item_kind,
                role,
                phase,
                provider_item_id,
                tool_call_id,
                llm_request_slice_id,
                content,
                visibility,
                source_type,
                source_id,
                trace_id,
                run_id,
                conversation_id,
                metadata
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?::jsonb)
              RETURNING *
            `,
            [
              buildCompressionForkItemEventId(forkRunId, item, nextIndex),
              forkRunId,
              identityKey,
              nextIndex,
              firstString(item.itemKind, item.item_kind, item.kind, 'state_event'),
              firstString(item.role),
              firstString(item.phase),
              firstString(item.providerItemId, item.provider_item_id, item.id),
              firstString(item.toolCallId, item.tool_call_id, item.call_id),
              firstString(item.llmRequestSliceId, item.llm_request_slice_id, input.llmRequestSliceId, input.llm_request_slice_id),
              JSON.stringify(normalizeValue(item.content ?? item.payload ?? {})),
              firstString(item.visibility, input.visibility, 'model_visible'),
              firstString(item.sourceType, item.source_type, input.sourceType, input.source_type),
              firstString(item.sourceId, item.source_id, input.sourceId, input.source_id),
              firstString(item.traceId, item.trace_id, input.traceId, input.trace_id),
              firstString(item.runId, item.run_id, input.runId, input.run_id),
              normalizeBigIntId(item.conversationId ?? item.conversation_id ?? input.conversationId ?? input.conversation_id),
              JSON.stringify(normalizeJsonObject(item.metadata, {}))
            ]
          );
          nextIndex += 1;
          if (row[0]) {
            rows.push(row[0]);
          }
        }
        return rows.map(normalizeCompressionForkItemRow).filter(Boolean);
      };

      if (typeof sql.withTransaction === 'function') {
        return sql.withTransaction(appendWithExecutor);
      }
      return appendWithExecutor(sql);
    });
  }

  async function appendSubconsciousAgentForkItems(input = {}, config = {}) {
    const rawItems = Array.isArray(input.items)
      ? input.items
      : input.item
        ? [input.item]
        : [];
    const forkRunId = firstString(input.forkRunId, input.fork_run_id);
    if (!forkRunId || rawItems.length === 0) {
      return [];
    }
    await ensureXiaoniAgentStackSchema(input, config);
    const identityKey = firstString(input.identityKey, input.identity_key, 'xiaoni');

    return withSql(input, config, async (sql) => {
      const appendWithExecutor = async (executor) => {
        if (typeof executor.query === 'function') {
          await executor.query('SELECT pg_advisory_xact_lock(hashtext(?))', [`subconscious_agent_fork_items:${forkRunId}`]).catch(() => []);
        }
        const headRows = await executor.query(
          'SELECT COALESCE(MAX(item_index), 0) AS item_index FROM subconscious_agent_fork_items WHERE fork_run_id = ?',
          [forkRunId]
        );
        let nextIndex = Number(headRows[0]?.item_index || 0) + 1;
        const rows = [];
        for (const item of rawItems) {
          const row = await executor.query(
            `
              INSERT INTO subconscious_agent_fork_items (
                event_id,
                fork_run_id,
                identity_key,
                item_index,
                item_kind,
                role,
                phase,
                provider_item_id,
                tool_call_id,
                llm_request_slice_id,
                content,
                visibility,
                source_type,
                source_id,
                trace_id,
                run_id,
                conversation_id,
                metadata
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?::jsonb)
              RETURNING *
            `,
            [
              buildSubconsciousForkItemEventId(forkRunId, item, nextIndex),
              forkRunId,
              identityKey,
              nextIndex,
              firstString(item.itemKind, item.item_kind, item.kind, 'state_event'),
              firstString(item.role),
              firstString(item.phase),
              firstString(item.providerItemId, item.provider_item_id, item.id),
              firstString(item.toolCallId, item.tool_call_id, item.call_id),
              firstString(item.llmRequestSliceId, item.llm_request_slice_id, input.llmRequestSliceId, input.llm_request_slice_id),
              JSON.stringify(normalizeValue(item.content ?? item.payload ?? {})),
              firstString(item.visibility, input.visibility, 'model_visible'),
              firstString(item.sourceType, item.source_type, input.sourceType, input.source_type),
              firstString(item.sourceId, item.source_id, input.sourceId, input.source_id),
              firstString(item.traceId, item.trace_id, input.traceId, input.trace_id),
              firstString(item.runId, item.run_id, input.runId, input.run_id),
              normalizeBigIntId(item.conversationId ?? item.conversation_id ?? input.conversationId ?? input.conversation_id),
              JSON.stringify(normalizeJsonObject(item.metadata, {}))
            ]
          );
          nextIndex += 1;
          if (row[0]) {
            rows.push(row[0]);
          }
        }
        return rows.map(normalizeCompressionForkItemRow).filter(Boolean);
      };

      if (typeof sql.withTransaction === 'function') {
        return sql.withTransaction(appendWithExecutor);
      }
      return appendWithExecutor(sql);
    });
  }

  async function recordCoreMemoryCompressionForkSlice(input = {}, config = {}) {
    const forkRunId = firstString(input.forkRunId, input.fork_run_id);
    if (!forkRunId) {
      return null;
    }
    await ensureXiaoniAgentStackSchema(input, config);
    const sliceId = buildSliceId(input);
    const completedAt = input.completedAt || input.completed_at || (firstString(input.status, 'completed') === 'running' ? null : new Date());
    return withSql(input, config, async (sql) => {
      const recordWithExecutor = async (executor) => {
        const rows = await executor.query(
          `
            INSERT INTO core_memory_compression_fork_slices (
              slice_id,
              fork_run_id,
              llm_call_id,
              identity_key,
              input_start_index,
              input_end_index,
              input_stack_item_ids,
              output_start_index,
              output_end_index,
              canonical_request,
              wire_request,
              canonical_response,
              wire_response,
              raw_response,
              output_items,
              status,
              token_usage,
              trace_id,
              run_id,
              conversation_id,
              agent_turn,
              model_name,
              model_provider,
              request_format_version,
              wire_provider_format,
              processing_time_ms,
              metadata,
              completed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::timestamptz)
            ON CONFLICT (slice_id) DO UPDATE SET
              fork_run_id = EXCLUDED.fork_run_id,
              llm_call_id = EXCLUDED.llm_call_id,
              input_start_index = EXCLUDED.input_start_index,
              input_end_index = EXCLUDED.input_end_index,
              input_stack_item_ids = EXCLUDED.input_stack_item_ids,
              output_start_index = EXCLUDED.output_start_index,
              output_end_index = EXCLUDED.output_end_index,
              canonical_request = EXCLUDED.canonical_request,
              wire_request = EXCLUDED.wire_request,
              canonical_response = EXCLUDED.canonical_response,
              wire_response = EXCLUDED.wire_response,
              raw_response = EXCLUDED.raw_response,
              output_items = EXCLUDED.output_items,
              status = EXCLUDED.status,
              token_usage = EXCLUDED.token_usage,
              trace_id = EXCLUDED.trace_id,
              run_id = EXCLUDED.run_id,
              conversation_id = EXCLUDED.conversation_id,
              agent_turn = EXCLUDED.agent_turn,
              model_name = EXCLUDED.model_name,
              model_provider = EXCLUDED.model_provider,
              request_format_version = EXCLUDED.request_format_version,
              wire_provider_format = EXCLUDED.wire_provider_format,
              processing_time_ms = EXCLUDED.processing_time_ms,
              metadata = EXCLUDED.metadata,
              completed_at = COALESCE(EXCLUDED.completed_at, core_memory_compression_fork_slices.completed_at),
              updated_at = CURRENT_TIMESTAMP
            RETURNING *
          `,
          [
            sliceId,
            forkRunId,
            firstString(input.llmCallId, input.llm_call_id),
            firstString(input.identityKey, input.identity_key, 'xiaoni'),
            normalizeInteger(input.inputStartIndex ?? input.input_start_index),
            normalizeInteger(input.inputEndIndex ?? input.input_end_index),
            JSON.stringify(normalizeJsonArray(input.inputStackItemIds ?? input.input_stack_item_ids, [])),
            normalizeInteger(input.outputStartIndex ?? input.output_start_index),
            normalizeInteger(input.outputEndIndex ?? input.output_end_index),
            JSON.stringify(normalizeValue(input.canonicalRequest ?? input.canonical_request ?? {})),
            input.wireRequest || input.wire_request ? JSON.stringify(normalizeValue(input.wireRequest ?? input.wire_request)) : null,
            input.canonicalResponse || input.canonical_response ? JSON.stringify(normalizeValue(input.canonicalResponse ?? input.canonical_response)) : null,
            input.wireResponse || input.wire_response ? JSON.stringify(normalizeValue(input.wireResponse ?? input.wire_response)) : null,
            input.rawResponse || input.raw_response ? JSON.stringify(normalizeValue(input.rawResponse ?? input.raw_response)) : null,
            JSON.stringify(normalizeJsonArray(input.outputItems ?? input.output_items, [])),
            firstString(input.status, 'completed'),
            JSON.stringify(normalizeJsonObject(input.tokenUsage ?? input.token_usage ?? input.usage, {})),
            firstString(input.traceId, input.trace_id),
            firstString(input.runId, input.run_id),
            normalizeBigIntId(input.conversationId ?? input.conversation_id),
            normalizeInteger(input.agentTurn ?? input.agent_turn),
            firstString(input.modelName, input.model_name),
            firstString(input.modelProvider, input.model_provider),
            firstString(input.requestFormatVersion, input.request_format_version),
            firstString(input.wireProviderFormat, input.wire_provider_format),
            normalizeInteger(input.processingTimeMs ?? input.processing_time_ms),
            JSON.stringify(normalizeJsonObject(input.metadata, {})),
            normalizeDate(completedAt)
          ]
        );
        await syncLlmUsageRollupForSlice(executor, sliceId, USAGE_SOURCE_COMPRESSION_FORK);
        return normalizeCompressionForkSliceRow(rows[0]);
      };
      if (typeof sql.withTransaction === 'function') {
        return sql.withTransaction(recordWithExecutor);
      }
      return recordWithExecutor(sql);
    });
  }

  async function recordSubconsciousAgentForkSlice(input = {}, config = {}) {
    const forkRunId = firstString(input.forkRunId, input.fork_run_id);
    if (!forkRunId) {
      return null;
    }
    await ensureXiaoniAgentStackSchema(input, config);
    const sliceId = buildSliceId(input);
    const completedAt = input.completedAt || input.completed_at || (firstString(input.status, 'completed') === 'running' ? null : new Date());
    return withSql(input, config, async (sql) => {
      const recordWithExecutor = async (executor) => {
        const rows = await executor.query(
          `
            INSERT INTO subconscious_agent_fork_slices (
              slice_id,
              fork_run_id,
              llm_call_id,
              identity_key,
              input_start_index,
              input_end_index,
              input_stack_item_ids,
              output_start_index,
              output_end_index,
              canonical_request,
              wire_request,
              canonical_response,
              wire_response,
              raw_response,
              output_items,
              status,
              token_usage,
              trace_id,
              run_id,
              conversation_id,
              agent_turn,
              model_name,
              model_provider,
              request_format_version,
              wire_provider_format,
              processing_time_ms,
              metadata,
              completed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::timestamptz)
            ON CONFLICT (slice_id) DO UPDATE SET
              fork_run_id = EXCLUDED.fork_run_id,
              llm_call_id = EXCLUDED.llm_call_id,
              input_start_index = EXCLUDED.input_start_index,
              input_end_index = EXCLUDED.input_end_index,
              input_stack_item_ids = EXCLUDED.input_stack_item_ids,
              output_start_index = EXCLUDED.output_start_index,
              output_end_index = EXCLUDED.output_end_index,
              canonical_request = EXCLUDED.canonical_request,
              wire_request = EXCLUDED.wire_request,
              canonical_response = EXCLUDED.canonical_response,
              wire_response = EXCLUDED.wire_response,
              raw_response = EXCLUDED.raw_response,
              output_items = EXCLUDED.output_items,
              status = EXCLUDED.status,
              token_usage = EXCLUDED.token_usage,
              trace_id = EXCLUDED.trace_id,
              run_id = EXCLUDED.run_id,
              conversation_id = EXCLUDED.conversation_id,
              agent_turn = EXCLUDED.agent_turn,
              model_name = EXCLUDED.model_name,
              model_provider = EXCLUDED.model_provider,
              request_format_version = EXCLUDED.request_format_version,
              wire_provider_format = EXCLUDED.wire_provider_format,
              processing_time_ms = EXCLUDED.processing_time_ms,
              metadata = EXCLUDED.metadata,
              completed_at = COALESCE(EXCLUDED.completed_at, subconscious_agent_fork_slices.completed_at),
              updated_at = CURRENT_TIMESTAMP
            RETURNING *
          `,
          [
            sliceId,
            forkRunId,
            firstString(input.llmCallId, input.llm_call_id),
            firstString(input.identityKey, input.identity_key, 'xiaoni'),
            normalizeInteger(input.inputStartIndex ?? input.input_start_index),
            normalizeInteger(input.inputEndIndex ?? input.input_end_index),
            JSON.stringify(normalizeJsonArray(input.inputStackItemIds ?? input.input_stack_item_ids, [])),
            normalizeInteger(input.outputStartIndex ?? input.output_start_index),
            normalizeInteger(input.outputEndIndex ?? input.output_end_index),
            JSON.stringify(normalizeValue(input.canonicalRequest ?? input.canonical_request ?? {})),
            input.wireRequest || input.wire_request ? JSON.stringify(normalizeValue(input.wireRequest ?? input.wire_request)) : null,
            input.canonicalResponse || input.canonical_response ? JSON.stringify(normalizeValue(input.canonicalResponse ?? input.canonical_response)) : null,
            input.wireResponse || input.wire_response ? JSON.stringify(normalizeValue(input.wireResponse ?? input.wire_response)) : null,
            input.rawResponse || input.raw_response ? JSON.stringify(normalizeValue(input.rawResponse ?? input.raw_response)) : null,
            JSON.stringify(normalizeJsonArray(input.outputItems ?? input.output_items, [])),
            firstString(input.status, 'completed'),
            JSON.stringify(normalizeJsonObject(input.tokenUsage ?? input.token_usage ?? input.usage, {})),
            firstString(input.traceId, input.trace_id),
            firstString(input.runId, input.run_id),
            normalizeBigIntId(input.conversationId ?? input.conversation_id),
            normalizeInteger(input.agentTurn ?? input.agent_turn),
            firstString(input.modelName, input.model_name),
            firstString(input.modelProvider, input.model_provider),
            firstString(input.requestFormatVersion, input.request_format_version),
            firstString(input.wireProviderFormat, input.wire_provider_format),
            normalizeInteger(input.processingTimeMs ?? input.processing_time_ms),
            JSON.stringify(normalizeJsonObject(input.metadata, {})),
            normalizeDate(completedAt)
          ]
        );
        await syncLlmUsageRollupForSlice(executor, sliceId, USAGE_SOURCE_SUBCONSCIOUS_FORK);
        return normalizeCompressionForkSliceRow(rows[0]);
      };
      if (typeof sql.withTransaction === 'function') {
        return sql.withTransaction(recordWithExecutor);
      }
      return recordWithExecutor(sql);
    });
  }

  async function recordImageVisionForkRun(input = {}, config = {}) {
    await ensureXiaoniAgentStackSchema(input, config);
    const forkRunId = buildImageVisionForkRunId(input);
    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        `
          INSERT INTO image_vision_fork_runs (
            fork_run_id,
            identity_key,
            status,
            trace_id,
            run_id,
            conversation_id,
            asset_id,
            image_id,
            media_tag,
            observation_id,
            description,
            artifact,
            error_message,
            metadata,
            started_at,
            completed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::jsonb, COALESCE(?::timestamptz, CURRENT_TIMESTAMP), ?::timestamptz)
          ON CONFLICT (fork_run_id) DO UPDATE SET
            status = EXCLUDED.status,
            trace_id = COALESCE(EXCLUDED.trace_id, image_vision_fork_runs.trace_id),
            run_id = COALESCE(EXCLUDED.run_id, image_vision_fork_runs.run_id),
            conversation_id = COALESCE(EXCLUDED.conversation_id, image_vision_fork_runs.conversation_id),
            asset_id = COALESCE(EXCLUDED.asset_id, image_vision_fork_runs.asset_id),
            image_id = COALESCE(EXCLUDED.image_id, image_vision_fork_runs.image_id),
            media_tag = COALESCE(EXCLUDED.media_tag, image_vision_fork_runs.media_tag),
            observation_id = COALESCE(EXCLUDED.observation_id, image_vision_fork_runs.observation_id),
            description = COALESCE(EXCLUDED.description, image_vision_fork_runs.description),
            artifact = EXCLUDED.artifact,
            error_message = EXCLUDED.error_message,
            metadata = EXCLUDED.metadata,
            completed_at = COALESCE(EXCLUDED.completed_at, image_vision_fork_runs.completed_at),
            updated_at = CURRENT_TIMESTAMP
          RETURNING *
        `,
        [
          forkRunId,
          firstString(input.identityKey, input.identity_key, 'xiaoni'),
          firstString(input.status, 'running'),
          firstString(input.traceId, input.trace_id),
          firstString(input.runId, input.run_id),
          normalizeBigIntId(input.conversationId ?? input.conversation_id),
          firstString(input.assetId, input.asset_id),
          firstString(input.imageId, input.image_id),
          firstString(input.mediaTag, input.media_tag),
          firstString(input.observationId, input.observation_id),
          firstString(input.description),
          JSON.stringify(normalizeJsonObject(input.artifact, {})),
          firstString(input.errorMessage, input.error_message),
          JSON.stringify(normalizeJsonObject(input.metadata, {})),
          normalizeDate(input.startedAt || input.started_at),
          normalizeDate(input.completedAt || input.completed_at || (firstString(input.status) === 'completed' || firstString(input.status) === 'failed' ? new Date() : null))
        ]
      );
      return normalizeImageVisionForkRunRow(rows[0]);
    });
  }

  async function completeImageVisionForkRun(input = {}, config = {}) {
    const forkRunId = firstString(input.forkRunId, input.fork_run_id);
    if (!forkRunId) {
      return null;
    }
    await ensureXiaoniAgentStackSchema(input, config);
    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        `
          UPDATE image_vision_fork_runs
          SET status = ?,
              observation_id = COALESCE(?, observation_id),
              description = COALESCE(?, description),
              artifact = ?::jsonb,
              error_message = ?,
              metadata = ?::jsonb,
              completed_at = COALESCE(?::timestamptz, CURRENT_TIMESTAMP),
              updated_at = CURRENT_TIMESTAMP
          WHERE fork_run_id = ?
          RETURNING *
        `,
        [
          firstString(input.status, 'completed'),
          firstString(input.observationId, input.observation_id),
          firstString(input.description),
          JSON.stringify(normalizeJsonObject(input.artifact, {})),
          firstString(input.errorMessage, input.error_message),
          JSON.stringify(normalizeJsonObject(input.metadata, {})),
          normalizeDate(input.completedAt || input.completed_at),
          forkRunId
        ]
      );
      return normalizeImageVisionForkRunRow(rows[0]);
    });
  }

  async function appendImageVisionForkItems(input = {}, config = {}) {
    const rawItems = Array.isArray(input.items)
      ? input.items
      : input.item
        ? [input.item]
        : [];
    const forkRunId = firstString(input.forkRunId, input.fork_run_id);
    if (!forkRunId || rawItems.length === 0) {
      return [];
    }
    await ensureXiaoniAgentStackSchema(input, config);
    const identityKey = firstString(input.identityKey, input.identity_key, 'xiaoni');

    return withSql(input, config, async (sql) => {
      const appendWithExecutor = async (executor) => {
        if (typeof executor.query === 'function') {
          await executor.query('SELECT pg_advisory_xact_lock(hashtext(?))', [`image_vision_fork_items:${forkRunId}`]).catch(() => []);
        }
        const headRows = await executor.query(
          'SELECT COALESCE(MAX(item_index), 0) AS item_index FROM image_vision_fork_items WHERE fork_run_id = ?',
          [forkRunId]
        );
        let nextIndex = Number(headRows[0]?.item_index || 0) + 1;
        const rows = [];
        for (const item of rawItems) {
          const row = await executor.query(
            `
              INSERT INTO image_vision_fork_items (
                event_id,
                fork_run_id,
                identity_key,
                item_index,
                item_kind,
                role,
                phase,
                provider_item_id,
                tool_call_id,
                llm_request_slice_id,
                content,
                visibility,
                source_type,
                source_id,
                trace_id,
                run_id,
                conversation_id,
                metadata
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?::jsonb)
              RETURNING *
            `,
            [
              buildImageVisionForkItemEventId(forkRunId, item, nextIndex),
              forkRunId,
              identityKey,
              nextIndex,
              firstString(item.itemKind, item.item_kind, item.kind, 'assistant_output'),
              firstString(item.role),
              firstString(item.phase),
              firstString(item.providerItemId, item.provider_item_id, item.id),
              firstString(item.toolCallId, item.tool_call_id, item.call_id),
              firstString(item.llmRequestSliceId, item.llm_request_slice_id, input.llmRequestSliceId, input.llm_request_slice_id),
              JSON.stringify(normalizeValue(item.content ?? item.payload ?? {})),
              firstString(item.visibility, input.visibility, 'model_visible'),
              firstString(item.sourceType, item.source_type, input.sourceType, input.source_type),
              firstString(item.sourceId, item.source_id, input.sourceId, input.source_id),
              firstString(item.traceId, item.trace_id, input.traceId, input.trace_id),
              firstString(item.runId, item.run_id, input.runId, input.run_id),
              normalizeBigIntId(item.conversationId ?? item.conversation_id ?? input.conversationId ?? input.conversation_id),
              JSON.stringify(normalizeJsonObject(item.metadata, {}))
            ]
          );
          nextIndex += 1;
          if (row[0]) {
            rows.push(row[0]);
          }
        }
        return rows.map(normalizeImageVisionForkItemRow).filter(Boolean);
      };

      if (typeof sql.withTransaction === 'function') {
        return sql.withTransaction(appendWithExecutor);
      }
      return appendWithExecutor(sql);
    });
  }

  async function recordImageVisionForkSlice(input = {}, config = {}) {
    const forkRunId = firstString(input.forkRunId, input.fork_run_id);
    if (!forkRunId) {
      return null;
    }
    await ensureXiaoniAgentStackSchema(input, config);
    const sliceId = buildSliceId(input);
    const completedAt = input.completedAt || input.completed_at || (firstString(input.status, 'completed') === 'running' ? null : new Date());
    return withSql(input, config, async (sql) => {
      const recordWithExecutor = async (executor) => {
        const rows = await executor.query(
          `
            INSERT INTO image_vision_fork_slices (
              slice_id,
              fork_run_id,
              llm_call_id,
              identity_key,
              input_start_index,
              input_end_index,
              input_stack_item_ids,
              output_start_index,
              output_end_index,
              canonical_request,
              wire_request,
              canonical_response,
              wire_response,
              raw_response,
              output_items,
              status,
              token_usage,
              trace_id,
              run_id,
              conversation_id,
              agent_turn,
              model_name,
              model_provider,
              request_format_version,
              wire_provider_format,
              processing_time_ms,
              metadata,
              completed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::timestamptz)
            ON CONFLICT (slice_id) DO UPDATE SET
              fork_run_id = EXCLUDED.fork_run_id,
              llm_call_id = EXCLUDED.llm_call_id,
              input_start_index = EXCLUDED.input_start_index,
              input_end_index = EXCLUDED.input_end_index,
              input_stack_item_ids = EXCLUDED.input_stack_item_ids,
              output_start_index = EXCLUDED.output_start_index,
              output_end_index = EXCLUDED.output_end_index,
              canonical_request = EXCLUDED.canonical_request,
              wire_request = EXCLUDED.wire_request,
              canonical_response = EXCLUDED.canonical_response,
              wire_response = EXCLUDED.wire_response,
              raw_response = EXCLUDED.raw_response,
              output_items = EXCLUDED.output_items,
              status = EXCLUDED.status,
              token_usage = EXCLUDED.token_usage,
              trace_id = EXCLUDED.trace_id,
              run_id = EXCLUDED.run_id,
              conversation_id = EXCLUDED.conversation_id,
              agent_turn = EXCLUDED.agent_turn,
              model_name = EXCLUDED.model_name,
              model_provider = EXCLUDED.model_provider,
              request_format_version = EXCLUDED.request_format_version,
              wire_provider_format = EXCLUDED.wire_provider_format,
              processing_time_ms = EXCLUDED.processing_time_ms,
              metadata = EXCLUDED.metadata,
              completed_at = COALESCE(EXCLUDED.completed_at, image_vision_fork_slices.completed_at),
              updated_at = CURRENT_TIMESTAMP
            RETURNING *
          `,
          [
            sliceId,
            forkRunId,
            firstString(input.llmCallId, input.llm_call_id),
            firstString(input.identityKey, input.identity_key, 'xiaoni'),
            normalizeInteger(input.inputStartIndex ?? input.input_start_index),
            normalizeInteger(input.inputEndIndex ?? input.input_end_index),
            JSON.stringify(normalizeJsonArray(input.inputStackItemIds ?? input.input_stack_item_ids, [])),
            normalizeInteger(input.outputStartIndex ?? input.output_start_index),
            normalizeInteger(input.outputEndIndex ?? input.output_end_index),
            JSON.stringify(normalizeValue(input.canonicalRequest ?? input.canonical_request ?? {})),
            input.wireRequest || input.wire_request ? JSON.stringify(normalizeValue(input.wireRequest ?? input.wire_request)) : null,
            input.canonicalResponse || input.canonical_response ? JSON.stringify(normalizeValue(input.canonicalResponse ?? input.canonical_response)) : null,
            input.wireResponse || input.wire_response ? JSON.stringify(normalizeValue(input.wireResponse ?? input.wire_response)) : null,
            input.rawResponse || input.raw_response ? JSON.stringify(normalizeValue(input.rawResponse ?? input.raw_response)) : null,
            JSON.stringify(normalizeJsonArray(input.outputItems ?? input.output_items, [])),
            firstString(input.status, 'completed'),
            JSON.stringify(normalizeJsonObject(input.tokenUsage ?? input.token_usage ?? input.usage, {})),
            firstString(input.traceId, input.trace_id),
            firstString(input.runId, input.run_id),
            normalizeBigIntId(input.conversationId ?? input.conversation_id),
            normalizeInteger(input.agentTurn ?? input.agent_turn),
            firstString(input.modelName, input.model_name),
            firstString(input.modelProvider, input.model_provider),
            firstString(input.requestFormatVersion, input.request_format_version),
            firstString(input.wireProviderFormat, input.wire_provider_format),
            normalizeInteger(input.processingTimeMs ?? input.processing_time_ms),
            JSON.stringify(normalizeJsonObject(input.metadata, {})),
            normalizeDate(completedAt)
          ]
        );
        await syncLlmUsageRollupForSlice(executor, sliceId, USAGE_SOURCE_IMAGE_VISION_FORK);
        return normalizeImageVisionForkSliceRow(rows[0]);
      };
      if (typeof sql.withTransaction === 'function') {
        return sql.withTransaction(recordWithExecutor);
      }
      return recordWithExecutor(sql);
    });
  }

  async function recordCoreMemoryCompressionForkToolExecution(input = {}, config = {}) {
    const forkRunId = firstString(input.forkRunId, input.fork_run_id);
    if (!forkRunId) {
      return null;
    }
    await ensureXiaoniAgentStackSchema(input, config);
    const executionId = buildToolExecutionId(input);
    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        `
          INSERT INTO core_memory_compression_fork_tool_executions (
            execution_id,
            fork_run_id,
            identity_key,
            llm_request_slice_id,
            llm_call_id,
            tool_call_id,
            tool_name,
            arguments,
            raw_arguments,
            result,
            status,
            error_message,
            side_effect,
            trace_id,
            run_id,
            conversation_id,
            agent_turn,
            stack_call_item_id,
            stack_output_item_id,
            metadata,
            started_at,
            completed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, COALESCE(?::timestamptz, CURRENT_TIMESTAMP), ?::timestamptz)
          ON CONFLICT (execution_id) DO UPDATE SET
            fork_run_id = EXCLUDED.fork_run_id,
            llm_request_slice_id = EXCLUDED.llm_request_slice_id,
            llm_call_id = EXCLUDED.llm_call_id,
            tool_call_id = EXCLUDED.tool_call_id,
            tool_name = EXCLUDED.tool_name,
            arguments = EXCLUDED.arguments,
            raw_arguments = EXCLUDED.raw_arguments,
            result = EXCLUDED.result,
            status = EXCLUDED.status,
            error_message = EXCLUDED.error_message,
            side_effect = EXCLUDED.side_effect,
            trace_id = EXCLUDED.trace_id,
            run_id = EXCLUDED.run_id,
            conversation_id = EXCLUDED.conversation_id,
            agent_turn = EXCLUDED.agent_turn,
            stack_call_item_id = COALESCE(EXCLUDED.stack_call_item_id, core_memory_compression_fork_tool_executions.stack_call_item_id),
            stack_output_item_id = COALESCE(EXCLUDED.stack_output_item_id, core_memory_compression_fork_tool_executions.stack_output_item_id),
            metadata = EXCLUDED.metadata,
            completed_at = COALESCE(EXCLUDED.completed_at, core_memory_compression_fork_tool_executions.completed_at),
            updated_at = CURRENT_TIMESTAMP
          RETURNING *
        `,
        [
          executionId,
          forkRunId,
          firstString(input.identityKey, input.identity_key, 'xiaoni'),
          firstString(input.llmRequestSliceId, input.llm_request_slice_id),
          firstString(input.llmCallId, input.llm_call_id),
          firstString(input.toolCallId, input.tool_call_id),
          firstString(input.toolName, input.tool_name, 'unknown'),
          JSON.stringify(normalizeJsonObject(input.arguments, {})),
          firstString(input.rawArguments, input.raw_arguments),
          JSON.stringify(normalizeJsonObject(input.result, {})),
          firstString(input.status, 'running'),
          firstString(input.errorMessage, input.error_message),
          normalizeBoolean(input.sideEffect ?? input.side_effect),
          firstString(input.traceId, input.trace_id),
          firstString(input.runId, input.run_id),
          normalizeBigIntId(input.conversationId ?? input.conversation_id),
          normalizeInteger(input.agentTurn ?? input.agent_turn),
          normalizeBigIntId(input.stackCallItemId ?? input.stack_call_item_id),
          normalizeBigIntId(input.stackOutputItemId ?? input.stack_output_item_id),
          JSON.stringify(normalizeJsonObject(input.metadata, {})),
          normalizeDate(input.startedAt || input.started_at),
          normalizeDate(input.completedAt || input.completed_at || (firstString(input.status) === 'completed' || firstString(input.status) === 'failed' ? new Date() : null))
        ]
      );
      return normalizeCompressionForkToolExecutionRow(rows[0]);
    });
  }

  async function recordSubconsciousAgentForkToolExecution(input = {}, config = {}) {
    const forkRunId = firstString(input.forkRunId, input.fork_run_id);
    if (!forkRunId) {
      return null;
    }
    await ensureXiaoniAgentStackSchema(input, config);
    const executionId = buildToolExecutionId(input);
    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        `
          INSERT INTO subconscious_agent_fork_tool_executions (
            execution_id,
            fork_run_id,
            identity_key,
            llm_request_slice_id,
            llm_call_id,
            tool_call_id,
            tool_name,
            arguments,
            raw_arguments,
            result,
            status,
            error_message,
            side_effect,
            trace_id,
            run_id,
            conversation_id,
            agent_turn,
            stack_call_item_id,
            stack_output_item_id,
            metadata,
            started_at,
            completed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, COALESCE(?::timestamptz, CURRENT_TIMESTAMP), ?::timestamptz)
          ON CONFLICT (execution_id) DO UPDATE SET
            fork_run_id = EXCLUDED.fork_run_id,
            llm_request_slice_id = EXCLUDED.llm_request_slice_id,
            llm_call_id = EXCLUDED.llm_call_id,
            tool_call_id = EXCLUDED.tool_call_id,
            tool_name = EXCLUDED.tool_name,
            arguments = EXCLUDED.arguments,
            raw_arguments = EXCLUDED.raw_arguments,
            result = EXCLUDED.result,
            status = EXCLUDED.status,
            error_message = EXCLUDED.error_message,
            side_effect = EXCLUDED.side_effect,
            trace_id = EXCLUDED.trace_id,
            run_id = EXCLUDED.run_id,
            conversation_id = EXCLUDED.conversation_id,
            agent_turn = EXCLUDED.agent_turn,
            stack_call_item_id = COALESCE(EXCLUDED.stack_call_item_id, subconscious_agent_fork_tool_executions.stack_call_item_id),
            stack_output_item_id = COALESCE(EXCLUDED.stack_output_item_id, subconscious_agent_fork_tool_executions.stack_output_item_id),
            metadata = EXCLUDED.metadata,
            completed_at = COALESCE(EXCLUDED.completed_at, subconscious_agent_fork_tool_executions.completed_at),
            updated_at = CURRENT_TIMESTAMP
          RETURNING *
        `,
        [
          executionId,
          forkRunId,
          firstString(input.identityKey, input.identity_key, 'xiaoni'),
          firstString(input.llmRequestSliceId, input.llm_request_slice_id),
          firstString(input.llmCallId, input.llm_call_id),
          firstString(input.toolCallId, input.tool_call_id),
          firstString(input.toolName, input.tool_name, 'unknown'),
          JSON.stringify(normalizeJsonObject(input.arguments, {})),
          firstString(input.rawArguments, input.raw_arguments),
          JSON.stringify(normalizeJsonObject(input.result, {})),
          firstString(input.status, 'running'),
          firstString(input.errorMessage, input.error_message),
          normalizeBoolean(input.sideEffect ?? input.side_effect),
          firstString(input.traceId, input.trace_id),
          firstString(input.runId, input.run_id),
          normalizeBigIntId(input.conversationId ?? input.conversation_id),
          normalizeInteger(input.agentTurn ?? input.agent_turn),
          normalizeBigIntId(input.stackCallItemId ?? input.stack_call_item_id),
          normalizeBigIntId(input.stackOutputItemId ?? input.stack_output_item_id),
          JSON.stringify(normalizeJsonObject(input.metadata, {})),
          normalizeDate(input.startedAt || input.started_at),
          normalizeDate(input.completedAt || input.completed_at || (firstString(input.status) === 'completed' || firstString(input.status) === 'failed' ? new Date() : null))
        ]
      );
      return normalizeCompressionForkToolExecutionRow(rows[0]);
    });
  }

  async function completeCoreMemoryCompressionForkToolExecution(input = {}, config = {}) {
    const executionId = firstString(input.executionId, input.execution_id);
    if (!executionId) {
      return null;
    }
    await ensureXiaoniAgentStackSchema(input, config);
    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        `
          UPDATE core_memory_compression_fork_tool_executions
          SET status = ?,
              result = ?::jsonb,
              error_message = ?,
              stack_output_item_id = COALESCE(?, stack_output_item_id),
              completed_at = COALESCE(?::timestamptz, CURRENT_TIMESTAMP),
              updated_at = CURRENT_TIMESTAMP
          WHERE execution_id = ?
          RETURNING *
        `,
        [
          firstString(input.status, 'completed'),
          JSON.stringify(normalizeJsonObject(input.result, {})),
          firstString(input.errorMessage, input.error_message),
          normalizeBigIntId(input.stackOutputItemId ?? input.stack_output_item_id),
          normalizeDate(input.completedAt || input.completed_at),
          executionId
        ]
      );
      return normalizeCompressionForkToolExecutionRow(rows[0]);
    });
  }

  async function completeSubconsciousAgentForkToolExecution(input = {}, config = {}) {
    const executionId = firstString(input.executionId, input.execution_id);
    if (!executionId) {
      return null;
    }
    await ensureXiaoniAgentStackSchema(input, config);
    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        `
          UPDATE subconscious_agent_fork_tool_executions
          SET status = ?,
              result = ?::jsonb,
              error_message = ?,
              stack_output_item_id = COALESCE(?, stack_output_item_id),
              completed_at = COALESCE(?::timestamptz, CURRENT_TIMESTAMP),
              updated_at = CURRENT_TIMESTAMP
          WHERE execution_id = ?
          RETURNING *
        `,
        [
          firstString(input.status, 'completed'),
          JSON.stringify(normalizeJsonObject(input.result, {})),
          firstString(input.errorMessage, input.error_message),
          normalizeBigIntId(input.stackOutputItemId ?? input.stack_output_item_id),
          normalizeDate(input.completedAt || input.completed_at),
          executionId
        ]
      );
      return normalizeCompressionForkToolExecutionRow(rows[0]);
    });
  }

  function appendTimeClauses(clauses, params, input, expression) {
    const startTime = normalizeDateFilter(input.startTime || input.start_time || input.since || input.from || input.occurredAfter || input.occurred_after);
    const endTime = normalizeDateFilter(input.endTime || input.end_time || input.until || input.to || input.occurredBefore || input.occurred_before);
    if (startTime) {
      clauses.push(`${expression} >= ?`);
      params.push(startTime);
    }
    if (endTime) {
      clauses.push(`${expression} <= ?`);
      params.push(endTime);
    }
  }

  async function listAgentStackItems(input = {}, config = {}) {
    await ensureXiaoniAgentStackSchema(input, config);
    const clauses = ['identity_key = ?'];
    const params = [firstString(input.identityKey, input.identity_key, 'xiaoni')];
    const limit = Math.max(1, Math.min(Number.parseInt(String(input.limit || 100), 10) || 100, 1000));
    const sourceKind = normalizeStackSourceKind(input.sourceKind ?? input.source_kind);
    const tableName = forkStackItemsTableForSource(sourceKind);
    const forkRunId = firstString(input.forkRunId, input.fork_run_id);
    const traceId = firstString(input.traceId, input.trace_id);
    const runId = firstString(input.runId, input.run_id);
    const itemKind = firstString(input.itemKind, input.item_kind);
    const toolCallId = firstString(input.toolCallId, input.tool_call_id);
    const llmRequestSliceId = firstString(input.llmRequestSliceId, input.llm_request_slice_id);
    const eventId = firstString(input.eventId, input.event_id);
    if (traceId) {
      clauses.push('trace_id = ?');
      params.push(traceId);
    }
    if (sourceKind !== USAGE_SOURCE_MAIN && forkRunId) {
      clauses.push('fork_run_id = ?');
      params.push(forkRunId);
    }
    if (runId) {
      clauses.push('run_id = ?');
      params.push(runId);
    }
    if (itemKind) {
      clauses.push('item_kind = ?');
      params.push(itemKind);
    }
    if (toolCallId) {
      clauses.push('tool_call_id = ?');
      params.push(toolCallId);
    }
    if (llmRequestSliceId) {
      clauses.push('llm_request_slice_id = ?');
      params.push(llmRequestSliceId);
    }
    if (eventId) {
      clauses.push('event_id = ?');
      params.push(eventId);
    }
    if (input.conversationId || input.conversation_id) {
      clauses.push('conversation_id = ?');
      params.push(normalizeBigIntId(input.conversationId ?? input.conversation_id));
    }
    appendTimeClauses(clauses, params, input, 'created_at');
    params.push(limit);

    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        `
          SELECT *
          FROM ${tableName}
          WHERE ${clauses.join(' AND ')}
          ORDER BY ${sourceKind === USAGE_SOURCE_MAIN ? 'stack_index' : 'item_index'} ${input.chronological ? 'ASC' : 'DESC'}, id ${input.chronological ? 'ASC' : 'DESC'}
          LIMIT ?
        `,
        params
      );
      return rows.map(sourceKind === USAGE_SOURCE_MAIN ? normalizeStackRow : normalizeCompressionForkItemRow).filter(Boolean);
    });
  }

  async function listAgentStackItemsForConversations(input = {}, config = {}) {
    await ensureXiaoniAgentStackSchema(input, config);
    const identityKey = firstString(input.identityKey, input.identity_key, 'xiaoni');
    const rawConversationIds = Array.isArray(input.conversationIds)
      ? input.conversationIds
      : Array.isArray(input.conversation_ids)
        ? input.conversation_ids
        : [];
    const conversationIds = Array.from(new Set(rawConversationIds
      .map((value) => normalizeBigIntId(value))
      .filter((value) => value !== null)));
    if (conversationIds.length === 0) {
      return [];
    }
    const limit = Math.max(1, Math.min(Number.parseInt(String(input.limit || 5000), 10) || 5000, 10000));
    const placeholders = conversationIds.map(() => '?').join(', ');
    const params = [
      identityKey,
      ...conversationIds,
      limit
    ];

    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        `
          SELECT *
          FROM agent_stack_items
          WHERE identity_key = ?
            AND conversation_id IN (${placeholders})
          ORDER BY conversation_id ASC, stack_index ASC, id ASC
          LIMIT ?
        `,
        params
      );
      return rows.map(normalizeStackRow).filter(Boolean);
    });
  }

  async function listLlmRequestSlices(input = {}, config = {}) {
    await ensureXiaoniAgentStackSchema(input, config);
    const clauses = ['identity_key = ?'];
    const params = [firstString(input.identityKey, input.identity_key, 'xiaoni')];
    const limit = Math.max(1, Math.min(Number.parseInt(String(input.limit || 100), 10) || 100, 1000));
    const summaryOnly = input.summaryOnly === true || input.summary_only === true;
    const rawTraceOnly = input.rawTraceOnly === true || input.raw_trace_only === true;
    const sourceKind = normalizeStackSourceKind(input.sourceKind ?? input.source_kind);
    const tableName = sourceKind === USAGE_SOURCE_COMPRESSION_FORK
      ? 'core_memory_compression_fork_slices'
      : sourceKind === USAGE_SOURCE_SUBCONSCIOUS_FORK
        ? 'subconscious_agent_fork_slices'
      : sourceKind === USAGE_SOURCE_IMAGE_VISION_FORK
        ? 'image_vision_fork_slices'
        : 'llm_request_slices';
    const sourceKindSelect = `'${sourceKind}'::varchar AS source_kind`;
    const forkRunIdSelect = sourceKind === USAGE_SOURCE_COMPRESSION_FORK || sourceKind === USAGE_SOURCE_SUBCONSCIOUS_FORK || sourceKind === USAGE_SOURCE_IMAGE_VISION_FORK
      ? 'fork_run_id'
      : 'NULL::varchar AS fork_run_id';
    const selectColumns = rawTraceOnly
      ? `
          id,
          slice_id,
          llm_call_id,
          ${sourceKindSelect},
          ${forkRunIdSelect},
          identity_key,
          NULL::bigint AS input_start_index,
          NULL::bigint AS input_end_index,
          '[]'::jsonb AS input_stack_item_ids,
          NULL::bigint AS output_start_index,
          NULL::bigint AS output_end_index,
          '{}'::jsonb AS canonical_request,
          wire_request,
          NULL::jsonb AS canonical_response,
          wire_response,
          raw_response,
          '[]'::jsonb AS output_items,
          status,
          token_usage,
          trace_id,
          run_id,
          conversation_id,
          agent_turn,
          model_name,
          model_provider,
          request_format_version,
          wire_provider_format,
          processing_time_ms,
          metadata,
          created_at,
          completed_at,
          updated_at
        `
      : summaryOnly
      ? `
          id,
          slice_id,
          llm_call_id,
          ${sourceKindSelect},
          ${forkRunIdSelect},
          identity_key,
          input_start_index,
          input_end_index,
          '[]'::jsonb AS input_stack_item_ids,
          output_start_index,
          output_end_index,
          '{}'::jsonb AS canonical_request,
          NULL::jsonb AS wire_request,
          wire_request IS NOT NULL AS provider_raw_trace_available,
          NULL::jsonb AS canonical_response,
          NULL::jsonb AS wire_response,
          NULL::jsonb AS raw_response,
          '[]'::jsonb AS output_items,
          status,
          token_usage,
          trace_id,
          run_id,
          conversation_id,
          agent_turn,
          model_name,
          model_provider,
          request_format_version,
          wire_provider_format,
          processing_time_ms,
          metadata,
          created_at,
          completed_at,
          updated_at
        `
      : sourceKind === USAGE_SOURCE_COMPRESSION_FORK || sourceKind === USAGE_SOURCE_SUBCONSCIOUS_FORK || sourceKind === USAGE_SOURCE_IMAGE_VISION_FORK
        ? `*, ${sourceKindSelect}`
        : `*, ${sourceKindSelect}, ${forkRunIdSelect}`;
    const traceId = firstString(input.traceId, input.trace_id);
    const runId = firstString(input.runId, input.run_id);
    const llmCallId = firstString(input.llmCallId, input.llm_call_id);
    const sliceId = firstString(input.sliceId, input.slice_id);
    const forkRunId = firstString(input.forkRunId, input.fork_run_id);
    if (traceId) {
      clauses.push('trace_id = ?');
      params.push(traceId);
    }
    if (runId) {
      clauses.push('run_id = ?');
      params.push(runId);
    }
    if (llmCallId) {
      clauses.push('llm_call_id = ?');
      params.push(llmCallId);
    }
    if (sliceId) {
      clauses.push('slice_id = ?');
      params.push(sliceId);
    }
    if ((sourceKind === USAGE_SOURCE_COMPRESSION_FORK || sourceKind === USAGE_SOURCE_SUBCONSCIOUS_FORK || sourceKind === USAGE_SOURCE_IMAGE_VISION_FORK) && forkRunId) {
      clauses.push('fork_run_id = ?');
      params.push(forkRunId);
    }
    if (input.conversationId || input.conversation_id) {
      clauses.push('conversation_id = ?');
      params.push(normalizeBigIntId(input.conversationId ?? input.conversation_id));
    }
    appendTimeClauses(clauses, params, input, 'created_at');
    params.push(limit);

    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        `
          SELECT ${selectColumns}
          FROM ${tableName}
          WHERE ${clauses.join(' AND ')}
          ORDER BY COALESCE(agent_turn, 0) ${input.chronological ? 'ASC' : 'DESC'}, created_at ${input.chronological ? 'ASC' : 'DESC'}, id ${input.chronological ? 'ASC' : 'DESC'}
          LIMIT ?
        `,
        params
      );
      return rows.map(normalizeLlmSliceRow).filter(Boolean);
    });
  }

  async function listCodexProviderUsageEvents(input = {}, config = {}) {
    await ensureXiaoniAgentStackSchema(input, config);
    const clauses = ['identity_key = ?'];
    const params = [firstString(input.identityKey, input.identity_key, 'xiaoni')];
    const limit = Math.max(1, Math.min(Number.parseInt(String(input.limit || 100), 10) || 100, 1000));
    const eventId = firstString(input.eventId, input.event_id, input.sliceId, input.slice_id);
    const sourceKind = firstString(input.sourceKind, input.source_kind);
    const sourceId = firstString(input.sourceId, input.source_id, input.forkRunId, input.fork_run_id);
    const traceId = firstString(input.traceId, input.trace_id);
    const runId = firstString(input.runId, input.run_id);
    const llmCallId = firstString(input.llmCallId, input.llm_call_id);

    if (eventId) {
      clauses.push('event_id = ?');
      params.push(eventId);
    }
    if (sourceKind) {
      clauses.push('source_kind = ?');
      params.push(normalizeCodexProviderUsageSourceKind(sourceKind));
    }
    if (sourceId) {
      clauses.push('source_id = ?');
      params.push(sourceId);
    }
    if (traceId) {
      clauses.push('trace_id = ?');
      params.push(traceId);
    }
    if (runId) {
      clauses.push('run_id = ?');
      params.push(runId);
    }
    if (llmCallId) {
      clauses.push('llm_call_id = ?');
      params.push(llmCallId);
    }
    if (input.conversationId || input.conversation_id) {
      clauses.push('conversation_id = ?');
      params.push(normalizeBigIntId(input.conversationId ?? input.conversation_id));
    }
    appendTimeClauses(clauses, params, input, 'created_at');
    params.push(limit);

    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        `
          SELECT *
          FROM codex_provider_usage_events
          WHERE ${clauses.join(' AND ')}
          ORDER BY created_at ${input.chronological ? 'ASC' : 'DESC'}, id ${input.chronological ? 'ASC' : 'DESC'}
          LIMIT ?
        `,
        params
      );
      return rows.map(normalizeCodexProviderUsageEventRow).filter(Boolean);
    });
  }

  async function getXiaoniLlmUsageTimeline(input = {}, config = {}) {
    await ensureXiaoniAgentStackSchema(input, config);
    const identityKey = firstString(input.identityKey, input.identity_key, 'xiaoni');
    const maxPoints = clampNumber(input.maxPoints ?? input.max_points, MIN_USAGE_MAX_POINTS, MAX_USAGE_MAX_POINTS, DEFAULT_USAGE_MAX_POINTS);
    const requestedBucketInput = firstString(input.bucket, input.usageBucket, input.usage_bucket, 'call');
    let requestedBucket = USAGE_BUCKETS.has(requestedBucketInput) ? requestedBucketInput : 'call';
    let bucketSeed = requestedBucket;
    const warnings = [];
    if (requestedBucket !== requestedBucketInput) {
      warnings.push('invalid_bucket_defaulted');
    }

    return withSql(input, config, async (sql) => {
      const boundsRows = await sql.query(
        `
          SELECT
            MIN(created_at) AS first_at,
            MAX(created_at) AS last_at,
            COUNT(*) AS total_count
          FROM llm_usage_rollup_sources
          WHERE identity_key = ?
        `,
        [identityKey]
      );
      const bounds = boundsRows[0] || {};
      const dataBounds = {
        firstAt: normalizeDate(bounds.first_at),
        lastAt: normalizeDate(bounds.last_at)
      };
      const { startTime, endTime, warnings: windowWarnings } = normalizeUsageWindow(input, dataBounds);
      warnings.push(...windowWarnings);

      if (!dataBounds.firstAt || !dataBounds.lastAt || !startTime || !endTime) {
        return {
          identityKey,
          generatedAt: new Date().toISOString(),
          timezone: STORAGE_TIMEZONE,
          requestedBucket,
          bucket: requestedBucket,
          maxPoints,
          downsampled: false,
          warnings,
          window: {
            startTime: normalizeDate(startTime),
            endTime: normalizeDate(endTime)
          },
          dataBounds,
          summary: summarizeUsagePoints([]),
          points: [],
          peaks: [],
          overlays: {
            eventDensity: [],
            toolDensity: [],
            runtimeBands: [],
            compressionForkBands: [],
            searchHits: []
          },
          miniMap: null
        };
      }

      if ((input.range || input.timeRange || input.time_range) === 'all' && requestedBucket === 'call') {
        bucketSeed = countUsageBuckets(startTime, endTime, 'day') <= maxPoints ? 'day' : 'month';
        warnings.push('all_range_bucket_escalated');
      }

      const timeWhere = buildUsageTimeWhere(startTime, endTime);
      const countRows = await sql.query(
        `
          SELECT COUNT(*) AS total_count
          FROM llm_usage_rollup_sources
          WHERE identity_key = ?
          ${timeWhere.clause}
        `,
        [identityKey, ...timeWhere.params]
      );
      const totalCount = normalizeNumber(countRows[0]?.total_count);
      const bucket = resolveUsageBucket({
        requestedBucket: bucketSeed,
        totalCount,
        startTime,
        endTime,
        maxPoints,
        warnings
      });
      const tokenSql = usageTokenSql('token_usage');
      const downsampled = bucket !== requestedBucket || totalCount > maxPoints && requestedBucket === 'call';
      let rawPoints = [];

      if (bucket === 'call') {
        rawPoints = await sql.query(
          `
            SELECT
              CONCAT(source_kind, ':', slice_id) AS key,
              created_at AS timestamp,
              created_at AS bucket_start,
              created_at AS bucket_end,
              1 AS call_count,
              input_tokens,
              cached_tokens,
              output_tokens,
              source_kind,
              fork_run_id,
              slice_id AS llm_request_slice_id,
              llm_call_id,
              trace_id,
              slice_id AS top_llm_request_slice_id,
              source_kind AS top_source_kind,
              fork_run_id AS top_fork_run_id,
              llm_call_id AS top_llm_call_id,
              trace_id AS top_trace_id,
              created_at AS top_timestamp,
              input_tokens AS top_input_tokens,
              cached_tokens AS top_cached_tokens,
              output_tokens AS top_output_tokens
            FROM llm_usage_rollup_sources
            WHERE identity_key = ?
            ${timeWhere.clause}
            ORDER BY created_at ASC, slice_id ASC
            LIMIT ?
          `,
          [identityKey, ...timeWhere.params, maxPoints]
        );
      } else {
        const rollupWhere = buildUsageRollupWhere(startTime, endTime);
        rawPoints = await sql.query(
          `
            SELECT
              CONCAT(?::text, ':', bucket_start::text) AS key,
              bucket_start AS timestamp,
              bucket_start,
              bucket_end,
              call_count,
              input_tokens,
              cached_tokens,
              output_tokens,
              top_llm_request_slice_id,
              top_source_kind,
              top_fork_run_id,
              top_llm_call_id,
              top_trace_id,
              top_timestamp,
              top_input_tokens,
              top_cached_tokens,
              top_output_tokens
            FROM llm_usage_rollups
            WHERE identity_key = ?
              AND bucket = ?
              ${rollupWhere.clause}
            ORDER BY bucket_start ASC
            LIMIT ?
          `,
          [bucket, identityKey, bucket, ...rollupWhere.params, maxPoints]
        );
      }

      const points = rawPoints.map((row) => normalizeUsagePoint(row, bucket));
      const summary = summarizeUsagePoints(points);
      const peaks = [];
      if (points.length > 0 && (input.includePeaks === true || input.include_peaks === true)) {
        const byInput = [...points].sort((left, right) => (right.topEvent?.inputTokens ?? right.inputTokens) - (left.topEvent?.inputTokens ?? left.inputTokens))[0];
        const byOutput = [...points].sort((left, right) => (right.topEvent?.outputTokens ?? right.outputTokens) - (left.topEvent?.outputTokens ?? left.outputTokens))[0];
        const seen = new Set();
        for (const [reason, point, labelValue] of [
          ['largest_input_tokens', byInput, byInput?.topEvent?.inputTokens ?? byInput?.inputTokens],
          ['largest_output_tokens', byOutput, byOutput?.topEvent?.outputTokens ?? byOutput?.outputTokens]
        ]) {
          const key = `${reason}:${point?.anchorEventId || point?.key}`;
          if (!point || seen.has(key)) {
            continue;
          }
          seen.add(key);
          peaks.push({
            timestamp: point.topEvent?.timestamp || point.timestamp,
            label: `${Math.round(labelValue || 0)} ${reason === 'largest_input_tokens' ? 'input' : 'output'}`,
            severity: labelValue > 100_000 ? 'warning' : 'info',
            anchorEventId: point.anchorEventId,
            llmRequestSliceId: point.llmRequestSliceId,
            reason
          });
        }
      }

      const includeOverlays = firstString(input.includeOverlays, input.include_overlays) || '';
      const searchQuery = normalizeUsageSearchQuery(input.searchQuery ?? input.search_q);
      let searchHits = [];
      if (searchQuery) {
        const searchWindowMs = endTime.getTime() - startTime.getTime();
        if (searchWindowMs > USAGE_SEARCH_MAX_WINDOW_MS) {
          warnings.push('search_overlay_window_too_wide');
        } else {
          const pattern = `%${searchQuery}%`;
          const searchLimit = Math.min(USAGE_SEARCH_MAX_HITS, Math.max(25, Math.floor(maxPoints / 2)));
          const searchRows = await sql.query(
            `
              WITH searchable AS (
                SELECT
                  slice_id,
                  ?::varchar AS source_kind,
                  NULL::varchar AS fork_run_id,
                  llm_call_id,
                  trace_id,
                  created_at,
                  token_usage,
                  canonical_request,
                  wire_request,
                  canonical_response,
                  wire_response,
                  raw_response,
                  output_items,
                  metadata
                FROM llm_request_slices
                WHERE identity_key = ?
                ${timeWhere.clause}
                UNION ALL
                SELECT
                  slice_id,
                  ?::varchar AS source_kind,
                  fork_run_id,
                  llm_call_id,
                  trace_id,
                  created_at,
                  token_usage,
                  canonical_request,
                  wire_request,
                  canonical_response,
                  wire_response,
                  raw_response,
                  output_items,
                  metadata
                FROM core_memory_compression_fork_slices
                WHERE identity_key = ?
                ${timeWhere.clause}
                UNION ALL
                SELECT
                  slice_id,
                  ?::varchar AS source_kind,
                  fork_run_id,
                  llm_call_id,
                  trace_id,
                  created_at,
                  token_usage,
                  canonical_request,
                  wire_request,
                  canonical_response,
                  wire_response,
                  raw_response,
                  output_items,
                  metadata
                FROM subconscious_agent_fork_slices
                WHERE identity_key = ?
                ${timeWhere.clause}
                UNION ALL
                SELECT
                  slice_id,
                  ?::varchar AS source_kind,
                  fork_run_id,
                  llm_call_id,
                  trace_id,
                  created_at,
                  token_usage,
                  canonical_request,
                  wire_request,
                  canonical_response,
                  wire_response,
                  raw_response,
                  output_items,
                  metadata
                FROM image_vision_fork_slices
                WHERE identity_key = ?
                ${timeWhere.clause}
                UNION ALL
                SELECT
                  event_id AS slice_id,
                  source_kind,
                  source_id AS fork_run_id,
                  llm_call_id,
                  trace_id,
                  created_at,
                  token_usage,
                  canonical_request,
                  wire_request,
                  canonical_response,
                  wire_response,
                  raw_response,
                  output_items,
                  metadata
                FROM codex_provider_usage_events
                WHERE identity_key = ?
                ${timeWhere.clause}
              )
              SELECT
                slice_id AS llm_request_slice_id,
                source_kind,
                fork_run_id,
                llm_call_id,
                trace_id,
                created_at AS timestamp,
                ${tokenSql.input} AS input_tokens,
                ${tokenSql.cached} AS cached_tokens,
                ${tokenSql.output} AS output_tokens,
                CASE
                  WHEN canonical_request::text ILIKE ? THEN 'canonical_request'
                  WHEN COALESCE(wire_request::text, '') ILIKE ? THEN 'wire_request'
                  WHEN COALESCE(canonical_response::text, '') ILIKE ? THEN 'canonical_response'
                  WHEN COALESCE(wire_response::text, '') ILIKE ? THEN 'wire_response'
                  WHEN COALESCE(raw_response::text, '') ILIKE ? THEN 'raw_response'
                  WHEN COALESCE(output_items::text, '') ILIKE ? THEN 'output_items'
                  WHEN COALESCE(metadata::text, '') ILIKE ? THEN 'metadata'
                  ELSE source_kind
                END AS match_field,
                LEFT(CONCAT_WS(
                  ' ',
                  canonical_request::text,
                  COALESCE(wire_request::text, ''),
                  COALESCE(canonical_response::text, ''),
                  COALESCE(wire_response::text, ''),
                  COALESCE(raw_response::text, ''),
                  COALESCE(output_items::text, ''),
                  COALESCE(metadata::text, '')
                ), 280) AS snippet
              FROM searchable
              WHERE
                canonical_request::text ILIKE ?
                OR COALESCE(wire_request::text, '') ILIKE ?
                OR COALESCE(canonical_response::text, '') ILIKE ?
                OR COALESCE(wire_response::text, '') ILIKE ?
                OR COALESCE(raw_response::text, '') ILIKE ?
                OR COALESCE(output_items::text, '') ILIKE ?
                OR COALESCE(metadata::text, '') ILIKE ?
              ORDER BY created_at ASC, source_kind ASC, slice_id ASC
              LIMIT ?
            `,
            [
              USAGE_SOURCE_MAIN,
              identityKey,
              ...timeWhere.params,
              USAGE_SOURCE_COMPRESSION_FORK,
              identityKey,
              ...timeWhere.params,
              USAGE_SOURCE_SUBCONSCIOUS_FORK,
              identityKey,
              ...timeWhere.params,
              USAGE_SOURCE_IMAGE_VISION_FORK,
              identityKey,
              ...timeWhere.params,
              identityKey,
              ...timeWhere.params,
              pattern,
              pattern,
              pattern,
              pattern,
              pattern,
              pattern,
              pattern,
              pattern,
              pattern,
              pattern,
              pattern,
              pattern,
              pattern,
              pattern,
              searchLimit
            ]
          );
          searchHits = searchRows.map((row) => normalizeUsageSearchHit(row, searchQuery));
          if (!includeOverlays.includes('search')) {
            warnings.push('search_overlay_included_without_flag');
          }
        }
      }
      if (includeOverlays.includes('compression_fork')) {
        warnings.push('compression_fork_overlay_not_enabled');
      }

      return {
        identityKey,
        generatedAt: new Date().toISOString(),
        timezone: STORAGE_TIMEZONE,
        requestedBucket,
        bucket,
        maxPoints,
        downsampled,
        warnings,
        window: {
          startTime: normalizeDate(startTime),
          endTime: normalizeDate(endTime)
        },
        dataBounds,
        summary,
        points,
        peaks,
        overlays: {
          eventDensity: [],
          toolDensity: [],
          runtimeBands: [],
          compressionForkBands: [],
          searchHits
        },
        miniMap: null
      };
    });
  }

  async function listToolExecutions(input = {}, config = {}) {
    await ensureXiaoniAgentStackSchema(input, config);
    const clauses = ['identity_key = ?'];
    const params = [firstString(input.identityKey, input.identity_key, 'xiaoni')];
    const limit = Math.max(1, Math.min(Number.parseInt(String(input.limit || 100), 10) || 100, 1000));
    const offset = Math.max(0, Number.parseInt(String(input.offset || 0), 10) || 0);
    const sourceKind = normalizeStackSourceKind(input.sourceKind ?? input.source_kind);
    const hasForkToolTable = sourceKind === USAGE_SOURCE_COMPRESSION_FORK || sourceKind === USAGE_SOURCE_SUBCONSCIOUS_FORK;
    if (sourceKind !== USAGE_SOURCE_MAIN && !hasForkToolTable) {
      return [];
    }
    const tableName = forkToolExecutionsTableForSource(sourceKind);
    const forkRunId = firstString(input.forkRunId, input.fork_run_id);
    const traceId = firstString(input.traceId, input.trace_id);
    const runId = firstString(input.runId, input.run_id);
    const toolCallId = firstString(input.toolCallId, input.tool_call_id);
    const toolName = firstString(input.toolName, input.tool_name);
    const executionId = firstString(input.executionId, input.execution_id);
    const llmRequestSliceId = firstString(input.llmRequestSliceId, input.llm_request_slice_id);
    if (traceId) {
      clauses.push('trace_id = ?');
      params.push(traceId);
    }
    if (sourceKind !== USAGE_SOURCE_MAIN && forkRunId) {
      clauses.push('fork_run_id = ?');
      params.push(forkRunId);
    }
    if (runId) {
      clauses.push('run_id = ?');
      params.push(runId);
    }
    if (toolCallId) {
      clauses.push('tool_call_id = ?');
      params.push(toolCallId);
    }
    if (toolName) {
      clauses.push('tool_name = ?');
      params.push(toolName);
    }
    if (executionId) {
      clauses.push('execution_id = ?');
      params.push(executionId);
    }
    if (llmRequestSliceId) {
      clauses.push('llm_request_slice_id = ?');
      params.push(llmRequestSliceId);
    }
    if (input.conversationId || input.conversation_id) {
      clauses.push('conversation_id = ?');
      params.push(normalizeBigIntId(input.conversationId ?? input.conversation_id));
    }
    appendTimeClauses(clauses, params, input, 'COALESCE(started_at, created_at)');
    params.push(limit, offset);

    return withSql(input, config, async (sql) => {
      const rows = await sql.query(
        `
          SELECT *
          FROM ${tableName}
          WHERE ${clauses.join(' AND ')}
          ORDER BY COALESCE(started_at, created_at) ${input.chronological ? 'ASC' : 'DESC'}, id ${input.chronological ? 'ASC' : 'DESC'}
          LIMIT ? OFFSET ?
        `,
        params
      );
      return rows.map(sourceKind === USAGE_SOURCE_MAIN ? normalizeToolExecutionRow : normalizeCompressionForkToolExecutionRow).filter(Boolean);
    });
  }

  async function findAgentStackItemByEventId(eventId, config = {}) {
    if (typeof eventId !== 'string' || !eventId.trim()) {
      return null;
    }
    const rows = await listAgentStackItems({
      eventId: eventId.trim(),
      limit: 1
    }, config);
    return rows[0] || null;
  }

  async function attachConversationIdToAgentStackByTrace(input = {}, config = {}) {
    const traceId = firstString(input.traceId, input.trace_id);
    const conversationId = normalizeBigIntId(input.conversationId ?? input.conversation_id);
    if (!traceId || conversationId === null) {
      return 0;
    }
    await ensureXiaoniAgentStackSchema(input, config);
    return withSql(input, config, async (sql) => {
      const updatedStack = await sql.execute(
        'UPDATE agent_stack_items SET conversation_id = COALESCE(conversation_id, ?), updated_at = CURRENT_TIMESTAMP WHERE trace_id = ?',
        [conversationId, traceId]
      );
      const updatedSlices = await sql.execute(
        'UPDATE llm_request_slices SET conversation_id = COALESCE(conversation_id, ?), updated_at = CURRENT_TIMESTAMP WHERE trace_id = ?',
        [conversationId, traceId]
      );
      const updatedTools = await sql.execute(
        'UPDATE tool_executions SET conversation_id = COALESCE(conversation_id, ?), updated_at = CURRENT_TIMESTAMP WHERE trace_id = ?',
        [conversationId, traceId]
      );
      const updatedCompressionForkRuns = await sql.execute(
        'UPDATE core_memory_compression_fork_runs SET conversation_id = COALESCE(conversation_id, ?), updated_at = CURRENT_TIMESTAMP WHERE trace_id = ?',
        [conversationId, traceId]
      );
      const updatedCompressionForkItems = await sql.execute(
        'UPDATE core_memory_compression_fork_items SET conversation_id = COALESCE(conversation_id, ?), updated_at = CURRENT_TIMESTAMP WHERE trace_id = ?',
        [conversationId, traceId]
      );
      const updatedCompressionForkSlices = await sql.execute(
        'UPDATE core_memory_compression_fork_slices SET conversation_id = COALESCE(conversation_id, ?), updated_at = CURRENT_TIMESTAMP WHERE trace_id = ?',
        [conversationId, traceId]
      );
      const updatedCompressionForkTools = await sql.execute(
        'UPDATE core_memory_compression_fork_tool_executions SET conversation_id = COALESCE(conversation_id, ?), updated_at = CURRENT_TIMESTAMP WHERE trace_id = ?',
        [conversationId, traceId]
      );
      const updatedSubconsciousForkRuns = await sql.execute(
        'UPDATE subconscious_agent_fork_runs SET conversation_id = COALESCE(conversation_id, ?), updated_at = CURRENT_TIMESTAMP WHERE trace_id = ?',
        [conversationId, traceId]
      );
      const updatedSubconsciousForkItems = await sql.execute(
        'UPDATE subconscious_agent_fork_items SET conversation_id = COALESCE(conversation_id, ?), updated_at = CURRENT_TIMESTAMP WHERE trace_id = ?',
        [conversationId, traceId]
      );
      const updatedSubconsciousForkSlices = await sql.execute(
        'UPDATE subconscious_agent_fork_slices SET conversation_id = COALESCE(conversation_id, ?), updated_at = CURRENT_TIMESTAMP WHERE trace_id = ?',
        [conversationId, traceId]
      );
      const updatedSubconsciousForkTools = await sql.execute(
        'UPDATE subconscious_agent_fork_tool_executions SET conversation_id = COALESCE(conversation_id, ?), updated_at = CURRENT_TIMESTAMP WHERE trace_id = ?',
        [conversationId, traceId]
      );
      const updatedImageForkRuns = await sql.execute(
        'UPDATE image_vision_fork_runs SET conversation_id = COALESCE(conversation_id, ?), updated_at = CURRENT_TIMESTAMP WHERE trace_id = ?',
        [conversationId, traceId]
      );
      const updatedImageForkItems = await sql.execute(
        'UPDATE image_vision_fork_items SET conversation_id = COALESCE(conversation_id, ?), updated_at = CURRENT_TIMESTAMP WHERE trace_id = ?',
        [conversationId, traceId]
      );
      const updatedImageForkSlices = await sql.execute(
        'UPDATE image_vision_fork_slices SET conversation_id = COALESCE(conversation_id, ?), updated_at = CURRENT_TIMESTAMP WHERE trace_id = ?',
        [conversationId, traceId]
      );
      const updatedProviderEvents = await sql.execute(
        'UPDATE codex_provider_usage_events SET conversation_id = COALESCE(conversation_id, ?), updated_at = CURRENT_TIMESTAMP WHERE trace_id = ?',
        [conversationId, traceId]
      );
      return updatedStack
        + updatedSlices
        + updatedTools
        + updatedCompressionForkRuns
        + updatedCompressionForkItems
        + updatedCompressionForkSlices
        + updatedCompressionForkTools
        + updatedSubconsciousForkRuns
        + updatedSubconsciousForkItems
        + updatedSubconsciousForkSlices
        + updatedSubconsciousForkTools
        + updatedImageForkRuns
        + updatedImageForkItems
        + updatedImageForkSlices
        + updatedProviderEvents;
    });
  }

  return {
    ensureXiaoniAgentStackSchema,
    getAgentStackHead,
    appendAgentStackItem,
    appendAgentStackItems,
    recordLlmRequestSlice,
    recordCodexProviderUsageEvent,
    updateLlmRequestSliceStackLinks,
    recordToolExecution,
    completeToolExecution,
    recordCoreMemoryCompressionForkRun,
    completeCoreMemoryCompressionForkRun,
    findActiveCoreMemoryCompressionForkRun,
    reapOrphanedForkRuns,
    appendCoreMemoryCompressionForkItems,
    recordCoreMemoryCompressionForkSlice,
    recordCoreMemoryCompressionForkToolExecution,
    completeCoreMemoryCompressionForkToolExecution,
    recordSubconsciousAgentForkRun,
    completeSubconsciousAgentForkRun,
    appendSubconsciousAgentForkItems,
    recordSubconsciousAgentForkSlice,
    recordSubconsciousAgentForkToolExecution,
    completeSubconsciousAgentForkToolExecution,
    recordImageVisionForkRun,
    completeImageVisionForkRun,
    appendImageVisionForkItems,
    recordImageVisionForkSlice,
    listAgentStackItems,
    listAgentStackItemsForConversations,
    listLlmRequestSlices,
    listCodexProviderUsageEvents,
    getXiaoniLlmUsageTimeline,
    listToolExecutions,
    findAgentStackItemByEventId,
    attachConversationIdToAgentStackByTrace
  };
}

module.exports = {
  createXiaoniAgentStackPersistence
};
