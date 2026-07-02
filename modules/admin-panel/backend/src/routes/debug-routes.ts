import express from 'express';
import { DatabaseManager } from '../services/database';
import winston from 'winston';
import { renderPromptTemplate } from '../utils/prompt-template';

// Provider Service服务地址配置 (支持容器间通信)
const PROVIDER_SERVICE_URL = process.env.PROVIDER_SERVICE_URL || 'http://qqbot-provider-service:8090';

function parseJsonField<T>(value: any, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }
  if (typeof value === 'object') {
    return value as T;
  }
  return fallback;
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

function buildMessageInput(conversation: any) {
  const rawRequest = parseJsonField<any>(conversation.raw_request, {});
  const firstBatchMessage = Array.isArray(rawRequest?.batch_messages) ? rawRequest.batch_messages[0] ?? null : null;
  const inboundContext = firstBatchMessage?.inboundContext && typeof firstBatchMessage.inboundContext === 'object'
    ? firstBatchMessage.inboundContext
    : null;
  const timestampFromConversation = conversation.timestamp ? new Date(conversation.timestamp).toISOString() : undefined;
  const timestampFromRequest = rawRequest?.time ? new Date(rawRequest.time * 1000).toISOString() : undefined;
  const queuedAt = timestampFromRequest || timestampFromConversation || new Date().toISOString();
  const processedAt = timestampFromConversation || timestampFromRequest || queuedAt;
  const inboundTo = typeof inboundContext?.To === 'string' ? inboundContext.To.trim() : '';
  const inboundGroupId = inboundTo.startsWith('group:') ? inboundTo.slice('group:'.length) : null;
  const groupId = conversation.group_id
    ?? rawRequest.group_id
    ?? firstBatchMessage?.groupId
    ?? firstBatchMessage?.rawPayload?.payload?.group_id
    ?? firstBatchMessage?.rawPayload?.group_id
    ?? inboundContext?.NativeChannelId
    ?? inboundGroupId;
  const normalizedGroupId = groupId !== null && groupId !== undefined && String(groupId).trim().length > 0
    ? String(groupId)
    : null;
  const inferredMessageType = rawRequest.message_type
    ?? firstBatchMessage?.messageType
    ?? firstBatchMessage?.chatType
    ?? inboundContext?.ChatType
    ?? (normalizedGroupId ? 'group' : 'private');
  const sessionKey = firstBatchMessage?.sessionKey
    ?? inboundContext?.SessionKey
    ?? rawRequest?.session_key
    ?? (normalizedGroupId
      ? `qq:group:${normalizedGroupId}`
      : `qq:private:${String(conversation.user_id ?? rawRequest.user_id ?? firstBatchMessage?.senderId ?? 0)}`);
  const source = rawRequest?.source
    ?? firstBatchMessage?.source
    ?? (firstBatchMessage?.rawPayload?.simulated ? 'api_simulation' : 'conversation_record');

  return {
    user_id: conversation.user_id ?? rawRequest.user_id ?? firstBatchMessage?.senderId ?? 0,
    message: conversation.user_message ?? rawRequest.message ?? rawRequest.raw_message ?? '',
    message_type: inferredMessageType,
    group_id: normalizedGroupId,
    message_id: rawRequest.message_id ?? firstBatchMessage?.messageId,
    source,
    queued_at: queuedAt,
    processed_at: processedAt,
    partition_key: sessionKey,
    priority: 'MEDIUM' as const
  };
}

function buildMessageOutput(conversation: any) {
  const responseText = conversation.ai_response ?? '';
  const timestampIso = conversation.timestamp ? new Date(conversation.timestamp).toISOString() : new Date().toISOString();
  const responseTime = Number.isFinite(Number(conversation.response_time)) ? Number(conversation.response_time) : 0;
  const normalizedStatus = (conversation.status ?? '').toString().toLowerCase();
  const deliveryStatus = normalizedStatus === 'completed'
    ? 'sent'
    : normalizedStatus === 'failed'
      ? 'failed'
      : 'pending';

  return {
    content: responseText,
    response_time_ms: responseTime,
    model_used: typeof conversation.model_name === 'string' && conversation.model_name.trim().length > 0
      ? conversation.model_name.trim()
      : null,
    delivery_method: 'http_api' as const,
    delivery_status: deliveryStatus as 'sent' | 'failed' | 'pending',
    timestamp: timestampIso,
    character_count: responseText.length
  };
}

type DisplayModelContextPolicy = {
  model: string;
  source: string;
  context_window_tokens: number;
  max_output_tokens: number;
  default_reply_budget_tokens: number;
  soft_trigger_ratio: number;
  hard_buffer_ratio: number;
  soft_trigger_tokens: number;
  hard_ceiling_tokens: number;
  reply_budget_tokens: number;
};

type DisplayModelContextPolicyDefinition = {
  contextWindowTokens: number;
  maxOutputTokens: number;
  defaultReplyBudgetTokens?: number;
  softTriggerRatio?: number;
  softTriggerTokens?: number;
  hardBufferRatio?: number;
};

const DISPLAY_MODEL_CONTEXT_DEFAULTS: Record<string, DisplayModelContextPolicyDefinition> = {
  'gpt-5-mini': { contextWindowTokens: 400000, maxOutputTokens: 128000 },
  'gpt-5.4': { contextWindowTokens: 1050000, maxOutputTokens: 128000 },
  'gpt-5-codex': { contextWindowTokens: 400000, maxOutputTokens: 128000 },
  'gpt-5.2-codex': { contextWindowTokens: 400000, maxOutputTokens: 128000 },
  'gpt-5.3-codex': { contextWindowTokens: 400000, maxOutputTokens: 128000, softTriggerTokens: 200000 },
  'codex-mini-latest': { contextWindowTokens: 200000, maxOutputTokens: 100000 },
};

const DISPLAY_MODEL_CONTEXT_ALIASES: Record<string, string> = {
  gmini: 'gpt-5-mini'
};

let cachedDisplayPolicyOverrides: Record<string, Partial<DisplayModelContextPolicyDefinition>> | null | undefined;

function loadDisplayModelContextOverrides(): Record<string, Partial<DisplayModelContextPolicyDefinition>> {
  if (cachedDisplayPolicyOverrides !== undefined) {
    return cachedDisplayPolicyOverrides || {};
  }

  const raw = process.env.MODEL_CONTEXT_POLICIES_JSON;
  if (!raw) {
    cachedDisplayPolicyOverrides = {};
    return cachedDisplayPolicyOverrides;
  }

  try {
    const parsed = JSON.parse(raw);
    cachedDisplayPolicyOverrides = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    cachedDisplayPolicyOverrides = {};
  }

  return cachedDisplayPolicyOverrides || {};
}

function resolveDisplayModelContextPolicy(modelName: any): DisplayModelContextPolicy | null {
  const rawName = typeof modelName === 'string' ? modelName.trim() : '';
  if (!rawName) {
    return null;
  }

  const normalizedName = rawName.toLowerCase();
  const canonicalName = DISPLAY_MODEL_CONTEXT_ALIASES[normalizedName] || normalizedName;
  const overrides = loadDisplayModelContextOverrides();
  const basePolicy = DISPLAY_MODEL_CONTEXT_DEFAULTS[canonicalName];
  const overridePolicy = overrides[canonicalName];

  if (!basePolicy && !overridePolicy) {
    return null;
  }

  const contextWindowTokens = Number(
    overridePolicy?.contextWindowTokens ?? basePolicy?.contextWindowTokens ?? 0
  );
  const maxOutputTokens = Number(
    overridePolicy?.maxOutputTokens ?? basePolicy?.maxOutputTokens ?? 0
  );
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0 || !Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
    return null;
  }

  const defaultReplyBudgetTokens = Number(
    overridePolicy?.defaultReplyBudgetTokens ?? basePolicy?.defaultReplyBudgetTokens ?? 8192
  );
  const softTriggerRatio = Number(
    overridePolicy?.softTriggerRatio ?? basePolicy?.softTriggerRatio ?? 0.5
  );
  const hardBufferRatio = Number(
    overridePolicy?.hardBufferRatio ?? basePolicy?.hardBufferRatio ?? 0.1
  );
  const replyBudgetTokens = Math.min(defaultReplyBudgetTokens, maxOutputTokens);
  const softTriggerTokens = Number(
    overridePolicy?.softTriggerTokens ?? basePolicy?.softTriggerTokens ?? Math.floor(contextWindowTokens * softTriggerRatio)
  );
  const hardCeilingTokens = Math.floor((contextWindowTokens - replyBudgetTokens) * (1 - hardBufferRatio));

  return {
    model: rawName,
    source: overridePolicy ? 'env_override' : 'built_in',
    context_window_tokens: contextWindowTokens,
    max_output_tokens: maxOutputTokens,
    default_reply_budget_tokens: defaultReplyBudgetTokens,
    soft_trigger_ratio: softTriggerRatio,
    hard_buffer_ratio: hardBufferRatio,
    soft_trigger_tokens: softTriggerTokens,
    hard_ceiling_tokens: hardCeilingTokens,
    reply_budget_tokens: replyBudgetTokens
  };
}

function extractUsageDetails(tokenUsage: any) {
  const usage = tokenUsage && typeof tokenUsage === 'object' ? tokenUsage : {};
  return {
    cached_input_tokens: toNumber(
      usage.cached_input_tokens
      ?? usage.input_tokens_details?.cached_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
    ) ?? 0,
    reasoning_tokens: toNumber(
      usage.reasoning_tokens
      ?? usage.output_tokens_details?.reasoning_tokens
      ?? usage.completion_tokens_details?.reasoning_tokens
    ) ?? 0,
    raw_usage: usage
  };
}

function normalizeProcessingEvents(events: any[]) {
  return events.map((event) => ({
    event_id: String(event.id),
    event_type: event.event_type,
    event_name: event.event_name,
    event_phase: event.event_phase,
    event_time: event.event_time,
    duration_ms: event.duration_ms ?? undefined,
    metadata: {
      component: event.component || event.event_type,
      details: parseJsonField<any>(event.metadata, {}),
      performance_metrics: parseJsonField<any>(event.performance_metrics, undefined)
    }
  }));
}

type TraceConfidence = 'observed' | 'derived' | 'missing';

function toNumber(value: any): number | null {
  const numericValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function toIsoString(value: any): string | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toMillis(value: any): number | null {
  const iso = toIsoString(value);
  return iso ? new Date(iso).getTime() : null;
}

function getSpanDurationMs(startAt?: any, endAt?: any, fallback?: any): number | null {
  const start = toMillis(startAt);
  const end = toMillis(endAt);
  if (start !== null && end !== null) {
    return Math.max(0, end - start);
  }
  const fallbackValue = toNumber(fallback);
  return fallbackValue !== null ? Math.max(0, fallbackValue) : null;
}

function compareTraceTimes(left: any, right: any, leftFallback: number = 0, rightFallback: number = 0): number {
  const leftTime = toMillis(left) ?? leftFallback;
  const rightTime = toMillis(right) ?? rightFallback;

  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return 0;
}

function normalizeStatus(value: any, successValues: string[] = ['success', 'completed', 'sent', 'ok']): string {
  const normalized = (value ?? '').toString().trim().toLowerCase();
  if (!normalized) {
    return 'unknown';
  }
  if (successValues.includes(normalized)) {
    return 'success';
  }
  if (['failed', 'error', 'timeout', 'cancelled'].includes(normalized)) {
    return 'error';
  }
  if (['pending', 'processing', 'calling', 'awaiting_tool', 'queued', 'started'].includes(normalized)) {
    return 'pending';
  }
  return normalized;
}

function buildLifecycleType(eventType: string, eventName: string): string {
  const combined = `${eventType}.${eventName}`.toLowerCase();
  if (combined.includes('queue')) return 'queue';
  if (combined.includes('context')) return 'context';
  if (combined.includes('decision')) return 'decision';
  if (combined.includes('delivery')) return 'delivery';
  if (combined.includes('trace')) return 'terminal_outcome';
  if (combined.includes('websocket')) return 'ingress';
  if (combined.includes('llm')) return 'llm_call';
  if (combined.includes('tool')) return 'tool_call';
  return eventType || 'trace';
}

function summarizeEvent(event: any): string {
  const pieces = [event.event_type, event.event_name, event.event_phase].filter(Boolean);
  return pieces.join(' / ');
}

function pairTimelineEvents(events: any[]) {
  const startMap = new Map<string, any[]>();
  const spans: any[] = [];

  for (const event of events) {
    const key = `${event.event_type}:${event.event_name}`;
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
        parent_id: null,
        trace_id: event.trace_id,
        conversation_id: event.conversation_id,
        started_at: toIsoString(startEvent?.event_time) || toIsoString(event.event_time),
        ended_at: toIsoString(event.event_time),
        duration_ms: getSpanDurationMs(startEvent?.event_time, event.event_time, event.duration_ms),
        status: 'success',
        title: `${event.event_type}.${event.event_name}`,
        summary: summarizeEvent(event),
        evidence: {
          start: startEvent || null,
          end: event
        },
        confidence: startEvent ? 'observed' : 'derived'
      });
      continue;
    }

    spans.push({
      id: `timeline-${event.id}`,
      type: buildLifecycleType(event.event_type, event.event_name),
      parent_id: null,
      trace_id: event.trace_id,
      conversation_id: event.conversation_id,
      started_at: toIsoString(event.event_time),
      ended_at: toIsoString(event.event_time),
      duration_ms: event.duration_ms ?? null,
      status: normalizeStatus(event.event_name),
      title: `${event.event_type}.${event.event_name}`,
      summary: summarizeEvent(event),
      evidence: event,
      confidence: 'observed' as TraceConfidence
    });
  }

  return spans.filter((span) => ['queue', 'context', 'decision', 'delivery', 'terminal_outcome'].includes(span.type));
}

function normalizeLlmCall(call: any) {
  const tokenUsage = parseJsonField<any>(call.token_usage, {});
  const canonicalRequest = enrichCanonicalRequest(parseJsonField<any>(call.canonical_request, null));
  return {
    id: call.id,
    llm_call_id: call.llm_call_id || null,
    trace_id: call.trace_id,
    conversation_id: call.conversation_id || null,
    agent_turn: toNumber(call.agent_turn),
    call_sequence: toNumber(call.call_sequence) || 0,
    started_at: toIsoString(call.started_at || (call.timestamp && call.api_call_time_ms ? new Date(new Date(call.timestamp).getTime() - Number(call.api_call_time_ms)) : null) || call.timestamp),
    completed_at: toIsoString(call.completed_at || call.timestamp),
    duration_ms: getSpanDurationMs(call.started_at, call.completed_at || call.timestamp, call.api_call_time_ms || call.processing_time_ms),
    status: normalizeStatus(call.status, ['success']),
    model_name: call.model_name,
    model_provider: call.model_provider,
    agent_type: call.agent_type,
    prompt_template: call.prompt_template,
    canonical_request: canonicalRequest,
    wire_request: parseJsonField<any>(call.wire_request, null),
    canonical_response: parseJsonField<any>(call.canonical_response, null),
    wire_response: parseJsonField<any>(call.wire_response, null),
    processed_response: call.processed_response || null,
    input_tokens: toNumber(call.input_tokens),
    output_tokens: toNumber(call.output_tokens),
    token_usage: tokenUsage,
    api_call_time_ms: toNumber(call.api_call_time_ms),
    processing_time_ms: toNumber(call.processing_time_ms),
    error_message: call.error_message || null,
    error_code: call.error_code || null,
    request_format_version: call.request_format_version || null,
    wire_provider_format: call.wire_provider_format || null
  };
}

function normalizeToolCall(call: any) {
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
    result: parseJsonField<any>(call.result, null),
    status: normalizeStatus(call.status, ['success']),
    error_message: call.error_message || null,
    execution_mode: call.execution_mode || null,
    side_effect: Boolean(call.side_effect),
    started_at: toIsoString(call.started_at),
    completed_at: toIsoString(call.completed_at || call.started_at),
    duration_ms: getSpanDurationMs(call.started_at, call.completed_at, call.duration_ms),
    http_requests: [] as any[]
  };
}

function normalizeHttpLog(log: any) {
  return {
    id: log.id,
    trace_id: log.trace_id || null,
    conversation_id: log.conversation_id || null,
    user_id: log.user_id || null,
    session_id: log.session_id || null,
    agent_turn: toNumber(log.agent_turn),
    llm_call_id: log.llm_call_id || null,
    tool_call_id: log.tool_call_id || null,
    request_id: log.request_id,
    method: log.method,
    url: log.url,
    host: log.host,
    path: log.path,
    status: normalizeStatus(log.response_status && Number(log.response_status) < 400 ? 'success' : (log.error_message ? 'error' : 'pending')),
    response_status: toNumber(log.response_status),
    request_timestamp: toIsoString(log.request_timestamp),
    response_timestamp: toIsoString(log.response_timestamp || log.request_timestamp),
    duration_ms: getSpanDurationMs(log.request_timestamp, log.response_timestamp, log.duration_ms),
    request_headers: parseJsonField<any>(log.request_headers, {}),
    response_headers: parseJsonField<any>(log.response_headers, {}),
    request_body: log.request_body || null,
    response_body: log.response_body || null,
    error_message: log.error_message || null,
    attribution: 'unattributed' as 'tool_call_id' | 'llm_call_id' | 'time_window' | 'unattributed'
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
      llmCall.http_requests = llmCall.http_requests || [];
      llmCall.http_requests.push(httpLog);
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

// 创建调试相关路由
export function createDebugRoutes(database: DatabaseManager, logger: winston.Logger) {
  const router = express.Router();

  // 🔥 增强的Debug prompt endpoint - 支持完整prompt配置和连续对话
  router.post('/debug/prompt-v2', async (req, res) => {
    try {
      const {
        prompt_id,            // 🔥 新增: Prompt ID用于加载完整配置
        messages = [],        // 🔥 新增: 连续对话历史
        systemPrompt,         // 向后兼容
        userInput,           // 向后兼容
        parameters = {},
        model,
        conversation_id
      } = req.body;

      // 参数验证
      if (!prompt_id && !userInput) {
        return res.status(400).json({
          success: false,
          error: 'Either prompt_id with messages or userInput is required',
          timestamp: new Date().toISOString()
        });
      }

      let promptConfig: any = null;
      let finalSystemPrompt = systemPrompt || '';
      let finalMessages = messages;
      let finalModel = typeof model === 'string' && model.trim().length > 0 ? model.trim() : null;
      let finalParameters = parameters;

      // 🔥 如果提供了prompt_id，从数据库加载完整配置
      if (prompt_id) {
        try {
          const promptQuery = `
            SELECT id, agent_type, prompt_name, system_instructions,
                   user_prompt_template, context_variables, model_config,
                   advanced_config, model_name, is_active
            FROM agent_prompts
            WHERE id = ? AND is_active = 1
          `;
          const promptResults = await database.executeQuery(promptQuery, [prompt_id]);

          if (!promptResults || promptResults.length === 0) {
            return res.status(404).json({
              success: false,
              error: `Prompt not found or inactive: ${prompt_id}`,
              timestamp: new Date().toISOString()
            });
          }

          promptConfig = promptResults[0];

          const parsedContextVariables = parseJsonField<Record<string, unknown>>(promptConfig.context_variables, {});
          const parsedModelConfig = parseJsonField<Record<string, unknown>>(promptConfig.model_config, {});
          const parsedAdvancedConfig = parseJsonField<Record<string, unknown>>(promptConfig.advanced_config, {});

          promptConfig = {
            ...promptConfig,
            context_variables: parsedContextVariables,
            model_config: parsedModelConfig,
            advanced_config: parsedAdvancedConfig
          };

          // 🔥 加载完整的系统指令
          let rawSystemPrompt = Array.isArray(promptConfig.system_instructions)
            ? promptConfig.system_instructions.join('\n')
            : promptConfig.system_instructions || '';

          // 🔥 处理上下文变量和模板替换
          finalSystemPrompt = renderPromptTemplate(rawSystemPrompt, promptConfig.context_variables, {
            conversation_id: conversation_id || prompt_id,
            timestamp: new Date().toISOString(),
            ...(promptConfig.model_name ? { model: promptConfig.model_name } : finalModel ? { model: finalModel } : {})
          });

          // 🔥 使用prompt配置的模型
          finalModel = typeof promptConfig.model_name === 'string' && promptConfig.model_name.trim().length > 0
            ? promptConfig.model_name.trim()
            : finalModel;

          // 🔥 合并配置参数
          finalParameters = {
            ...parameters,
            model_config: promptConfig.model_config,
            advanced_config: promptConfig.advanced_config,
            context_variables: promptConfig.context_variables
          };

          logger.info('Loaded prompt configuration', {
            prompt_id,
            prompt_name: promptConfig.prompt_name,
            model: finalModel,
            hasAdvancedConfig: !!promptConfig.advanced_config,
            hasContextVariables: !!promptConfig.context_variables
          });

        } catch (dbError) {
          logger.error('Failed to load prompt configuration', { error: dbError, prompt_id });
          return res.status(500).json({
            success: false,
            error: 'Failed to load prompt configuration',
            timestamp: new Date().toISOString()
          });
        }
      }

      // 🔥 向后兼容：如果没有messages但有userInput，构造简单消息
      if (!messages.length && userInput) {
        finalMessages = [{ role: 'user', content: userInput }];
      }

      if (!finalModel) {
        return res.status(400).json({
          success: false,
          error: 'Model is required for prompt debugging',
          timestamp: new Date().toISOString()
        });
      }

      // 🔥 处理用户消息模板替换（如果配置了user_prompt_template）
      if (promptConfig && promptConfig.user_prompt_template) {
        finalMessages = finalMessages.map((msg: any) => {
          if (msg.role === 'user') {
            const templateContext = {
              user_input: msg.content,
              conversation_id: conversation_id || prompt_id,
              timestamp: new Date().toISOString()
            };
            const processedContent = renderPromptTemplate(
              promptConfig.user_prompt_template,
              promptConfig.context_variables,
              templateContext
            );
            return { ...msg, content: processedContent };
          }
          return msg;
        });
      }

      logger.info('Debug Prompt V2 called with enhanced config', {
        prompt_id,
        hasSystemPrompt: !!finalSystemPrompt,
        messageCount: finalMessages.length,
        model: finalModel,
        conversation_id,
        hasAdvancedConfig: !!finalParameters.advanced_config
      });

      // 🔥 调用Bot Core的内部LLM调试接口，传递完整配置
      const internalApiPayload = {
        systemPrompt: finalSystemPrompt,
        messages: finalMessages,        // 🔥 传递连续对话
        parameters: finalParameters,    // 🔥 传递完整配置
        model: finalModel,
        conversation_id: conversation_id || prompt_id
      };

      const internalApiResponse = await fetch(`${PROVIDER_SERVICE_URL}/api/internal/llm/debug`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(internalApiPayload)
      });

      if (!internalApiResponse.ok) {
        const errorText = await internalApiResponse.text();
        logger.error('Bot Core internal API failed', {
          status: internalApiResponse.status,
          statusText: internalApiResponse.statusText,
          response: errorText,
          payload: internalApiPayload
        });

        return res.status(internalApiResponse.status).json({
          success: false,
          error: `Provider Service API failed: ${internalApiResponse.statusText}`,
          details: errorText,
          timestamp: new Date().toISOString()
        });
      }

      const apiResult = await internalApiResponse.json() as any;

      logger.info('Debug Prompt V2 succeeded via Provider Service', {
        hasResponse: !!apiResult.response,
        model: apiResult.model,
        conversation_id: conversation_id || prompt_id,
        prompt_id
      });

      res.json({
        success: true,
        response: apiResult.response,
        thinking: apiResult.thinking,           // 🔥 支持思考过程
        token_used: apiResult.token_used,
        model: apiResult.model,
        usage: apiResult.usage || null,
        usage_details: apiResult.usage_details || null,
        performance: apiResult.performance,
        context_policy: apiResult.context_policy || null,
        canonical_request: apiResult.canonical_request || null,
        wire_request: apiResult.wire_request || null,
        canonical_response: apiResult.canonical_response || null,
        wire_response: apiResult.wire_response || null,
        raw_response: apiResult.raw_response || null,
        prompt_config: promptConfig ? {         // 🔥 返回使用的配置信息
          prompt_name: promptConfig.prompt_name,
          agent_type: promptConfig.agent_type,
          model_name: promptConfig.model_name
        } : null,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Debug Prompt V2 failed', { error, prompt_id: req.body.prompt_id });
      res.status(500).json({
        success: false,
        error: 'Failed to execute debug prompt via Provider Service',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  return router;
}

export default createDebugRoutes;
