import winston from 'winston';
import {
  listRuntimeIdentityActivationTraces,
  listIdentityEvidenceRefs,
  listTraceTrafficLogs,
  listAgentStackItems,
  listLlmRequestSlices,
  listToolExecutions,
  getAgentTaskById
} from '@qq-bot/persistence';
import {
  buildStackTracePayload,
  buildStackTraceSpanDetail,
  buildStackRawProviderTrace
} from '../services/trace-span-builder';

jest.mock('@qq-bot/persistence', () => ({
  listRuntimeIdentityActivationTraces: jest.fn(),
  listIdentityEvidenceRefs: jest.fn(),
  listTraceTrafficLogs: jest.fn(),
  listAgentStackItems: jest.fn(),
  listLlmRequestSlices: jest.fn(),
  listToolExecutions: jest.fn(),
  getAgentTaskById: jest.fn(),
  parseInstantValue: jest.fn((value: unknown) => {
    if (!value) {
      return null;
    }
    const parsed = value instanceof Date ? value : new Date(value as string | number);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }),
  serializeTimestampForApi: jest.fn((value: unknown) => {
    if (!value) {
      return null;
    }
    const parsed = value instanceof Date ? value : new Date(value as string | number);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }),
}));

function createLogger(): winston.Logger {
  return winston.createLogger({ silent: true });
}

function createDatabase() {
  const conversation = {
    id: 'conversation-1',
    trace_id: 'trace-1',
    batch_id: 'batch-1',
    user_id: 'user-1',
    group_id: null,
    user_message: 'hello',
    ai_response: 'hi',
    status: 'completed',
    error_reason: null,
    response_time: 1200,
    model_name: 'gpt-5-mini',
    raw_request: JSON.stringify({ prompt: 'hello' }),
    timestamp: '2026-03-28T10:00:00.000Z',
  };

  return {
    executeQuery: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM conversations')) {
        return [conversation];
      }
      if (sql.includes('FROM llm_request_slices')) {
        return [{
          id: 11,
          slice_id: params[0] || 'slice-1',
          llm_call_id: 'llm-call-1',
          trace_id: 'trace-1',
          run_id: 'run-1',
          conversation_id: 'conversation-1',
          agent_turn: 1,
          created_at: '2026-03-28T10:00:01.000Z',
          completed_at: '2026-03-28T10:00:03.000Z',
          status: 'completed',
          model_name: 'gpt-5-mini',
          model_provider: 'codex',
          canonical_request: { model: 'gpt-5-mini', input: [{ role: 'user', content: 'hello' }] },
          wire_request: { model: 'gpt-5-mini', input: [{ role: 'user', content: 'hello' }] },
          canonical_response: { output_text: 'hi' },
          wire_response: { id: 'resp-1' },
          raw_response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] },
          output_items: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
          token_usage: { input_tokens: 10, output_tokens: 20 },
          input_start_index: 1,
          input_end_index: 2,
          output_start_index: 3,
          output_end_index: 3,
          request_format_version: 'openresponse/v1',
          wire_provider_format: 'codex/responses',
          processing_time_ms: 2000,
          metadata: {}
        }];
      }
      if (sql.includes('FROM tool_executions')) {
        return [{
          id: 21,
          execution_id: 'tool:run-1:call-1',
          llm_request_slice_id: 'slice-1',
          llm_call_id: 'llm-call-1',
          tool_call_id: 'call-1',
          tool_name: 'recover_energy',
          arguments: { reason: 'done' },
          raw_arguments: '{"reason":"done"}',
          result: { status_text: 'resting' },
          status: 'completed',
          side_effect: true,
          trace_id: 'trace-1',
          run_id: 'run-1',
          conversation_id: 'conversation-1',
          agent_turn: 1,
          started_at: '2026-03-28T10:00:03.000Z',
          completed_at: '2026-03-28T10:00:04.000Z',
          metadata: {}
        }];
      }
      if (sql.includes('FROM websocket_logs')
        || sql.includes('FROM timeline_events')
        || sql.includes('FROM llm_jobs')
        || sql.includes('FROM agent_queue_messages')) {
        return [];
      }
      return [];
    }),
  };
}

describe('buildStackTracePayload', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (listLlmRequestSlices as jest.Mock).mockResolvedValue([{
      id: '11',
      sliceId: 'slice-1',
      llmCallId: 'llm-call-1',
      traceId: 'trace-1',
      runId: 'run-1',
      conversationId: null,
      agentTurn: 1,
      createdAt: '2026-03-28T10:00:01.000Z',
      completedAt: '2026-03-28T10:00:03.000Z',
      status: 'completed',
      modelName: 'gpt-5-mini',
      modelProvider: 'codex',
      canonicalRequest: { model: 'gpt-5-mini' },
      wireRequest: { model: 'gpt-5-mini' },
      canonicalResponse: { output_text: 'hi' },
      wireResponse: { id: 'resp-1' },
      rawResponse: { output: [{ type: 'message' }] },
      outputItems: [{ type: 'message' }],
      tokenUsage: { input_tokens: 10, output_tokens: 20 },
      inputStartIndex: 1,
      inputEndIndex: 2,
      outputStartIndex: 3,
      outputEndIndex: 3,
      requestFormatVersion: 'openresponse/v1',
      wireProviderFormat: 'codex/responses',
      processingTimeMs: 2000,
      metadata: {}
    }]);
    (listToolExecutions as jest.Mock).mockResolvedValue([{
      id: '21',
      executionId: 'tool:run-1:call-1',
      llmRequestSliceId: 'slice-1',
      llmCallId: 'llm-call-1',
      toolCallId: 'call-1',
      toolName: 'recover_energy',
      arguments: { reason: 'done' },
      rawArguments: '{"reason":"done"}',
      result: { status_text: 'resting' },
      status: 'completed',
      sideEffect: true,
      traceId: 'trace-1',
      runId: 'run-1',
      conversationId: null,
      agentTurn: 1,
      startedAt: '2026-03-28T10:00:03.000Z',
      completedAt: '2026-03-28T10:00:04.000Z',
      metadata: {}
    }]);
    (listAgentStackItems as jest.Mock).mockResolvedValue([{
      id: '31',
      eventId: 'stack:item-1',
      llmRequestSliceId: 'slice-1',
      itemKind: 'function_call',
      content: { type: 'function_call', call_id: 'call-1', name: 'recover_energy' },
      traceId: 'trace-1',
      runId: 'run-1',
      conversationId: null,
      createdAt: '2026-03-28T10:00:02.000Z',
      metadata: {}
    }]);
  });

  it('builds stack-only trace spans when no conversation row exists', async () => {
    const payload = await buildStackTracePayload(createLogger(), {
      traceId: 'trace-1',
      internalExecutionLeaseId: 'run-1',
      llmRequestSliceId: 'slice-1',
      toolCallId: 'call-1'
    });

    expect(payload?.conversation_id).toBeNull();
    expect(payload?.trace.trace_id).toBe('trace-1');
    expect(payload?.spans.some((span) => span.span_id === 'stack-slice:slice-1')).toBe(true);
    expect(payload?.spans.some((span) => span.span_id === 'tool-call:call-1')).toBe(true);
    expect(payload?.raw_evidence.llm_request_slices).toHaveLength(1);
    expect(payload?.raw_evidence.tool_executions).toHaveLength(1);
    expect(listLlmRequestSlices).toHaveBeenCalledWith(expect.objectContaining({
      sliceId: 'slice-1',
      summaryOnly: true
    }));
    expect(listToolExecutions).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: 'call-1' }));
    expect(listAgentStackItems).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: 'call-1' }));
  });

  it('keeps fork source lookup when loading focused stack trace spans', async () => {
    const payload = await buildStackTracePayload(createLogger(), {
      traceId: 'trace-fork',
      internalExecutionLeaseId: 'run-fork',
      sourceKind: 'subconscious_agent_fork',
      forkRunId: 'subconscious-fork:run-fork:seed',
      llmRequestSliceId: 'sub-slice-1',
      toolCallId: 'call-subconscious'
    });

    expect(payload?.trace.trace_id).toBe('trace-fork');
    expect(listLlmRequestSlices).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: 'subconscious_agent_fork',
      forkRunId: 'subconscious-fork:run-fork:seed',
      sliceId: 'sub-slice-1'
    }));
    expect(listToolExecutions).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: 'subconscious_agent_fork',
      forkRunId: 'subconscious-fork:run-fork:seed',
      toolCallId: 'call-subconscious'
    }));
    expect(listAgentStackItems).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: 'subconscious_agent_fork',
      forkRunId: 'subconscious-fork:run-fork:seed',
      llmRequestSliceId: 'sub-slice-1'
    }));
  });

  it('loads stack-only tool span detail', async () => {
    const detail = await buildStackTraceSpanDetail(
      createLogger(),
      { traceId: 'trace-1', internalExecutionLeaseId: 'run-1' },
      'tool-call:call-1'
    );

    expect(detail?.input).toMatchObject({
      arguments: { reason: 'done' },
      raw_arguments: '{"reason":"done"}'
    });
    expect(detail?.output).toMatchObject({
      result: { status_text: 'resting' }
    });
    expect(listToolExecutions).toHaveBeenCalledWith(expect.objectContaining({
      traceId: 'trace-1',
      runId: 'run-1',
      toolCallId: 'call-1'
    }));
  });

  it('keeps fork source lookup when loading focused stack span detail', async () => {
    const detail = await buildStackTraceSpanDetail(
      createLogger(),
      {
        traceId: 'trace-fork',
        internalExecutionLeaseId: 'run-fork',
        sourceKind: 'subconscious_agent_fork',
        forkRunId: 'subconscious-fork:run-fork:seed'
      },
      'provider-request:wire:llm-call-1'
    );

    expect(detail?.input).toBeTruthy();
    expect(listLlmRequestSlices).toHaveBeenCalledWith(expect.objectContaining({
      traceId: 'trace-fork',
      runId: 'run-fork',
      sourceKind: 'subconscious_agent_fork',
      forkRunId: 'subconscious-fork:run-fork:seed',
      llmCallId: 'llm-call-1'
    }));
  });

  it('loads stack-only provider request detail with headers from slice metadata', async () => {
    (listLlmRequestSlices as jest.Mock).mockResolvedValueOnce([{
      id: '11',
      sliceId: 'slice-1',
      llmCallId: 'llm-call-1',
      traceId: 'trace-1',
      runId: 'run-1',
      conversationId: null,
      agentTurn: 1,
      createdAt: '2026-03-28T10:00:01.000Z',
      completedAt: '2026-03-28T10:00:03.000Z',
      status: 'completed',
      modelName: 'gpt-5-mini',
      modelProvider: 'codex',
      canonicalRequest: { model: 'gpt-5-mini' },
      wireRequest: { model: 'gpt-5-mini' },
      canonicalResponse: { output_text: 'hi' },
      wireResponse: { id: 'resp-1' },
      rawResponse: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] },
      tokenUsage: { input_tokens: 10, output_tokens: 20 },
      requestFormatVersion: 'openresponse/v1',
      wireProviderFormat: 'codex/responses',
      processingTimeMs: 2000,
      metadata: {
        provider_request_headers: {
          Authorization: 'Bearer secret',
          'x-trace-id': 'trace-1'
        },
        provider_request_url: 'http://provider.local/responses',
        provider_response_headers: {
          'content-type': 'application/json'
        },
        provider_response_status: 201,
        provider_response_status_text: 'Created'
      }
    }]);

    const detail = await buildStackTraceSpanDetail(
      createLogger(),
      { traceId: 'trace-1', internalExecutionLeaseId: 'run-1' },
      'provider-request:wire:slice-1'
    );

    expect(detail?.input).toMatchObject({
      headers: {
        Authorization: '[redacted]',
        'x-trace-id': 'trace-1'
      },
      upstream_url: 'http://provider.local/responses',
      body: { model: 'gpt-5-mini' }
    });
    expect(detail?.output).toMatchObject({
      status_code: 201,
      headers: {
        'content-type': 'application/json'
      },
      body: { id: 'resp-1' },
      raw_body: JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }]
      })
    });
  });

  it('loads raw provider exchange without fetching full span detail evidence', async () => {
    (listLlmRequestSlices as jest.Mock).mockResolvedValueOnce([{
      id: '11',
      sliceId: 'slice-1',
      llmCallId: 'llm-call-1',
      traceId: 'trace-1',
      runId: 'run-1',
      conversationId: null,
      agentTurn: 1,
      createdAt: '2026-03-28T10:00:01.000Z',
      completedAt: '2026-03-28T10:00:03.000Z',
      status: 'completed',
      modelName: 'gpt-5-mini',
      modelProvider: 'codex',
      wireRequest: { model: 'gpt-5-mini', input: ['hello'] },
      wireResponse: { id: 'resp-1' },
      rawResponse: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] },
      tokenUsage: { input_tokens: 10, output_tokens: 20 },
      requestFormatVersion: 'openresponse/v1',
      wireProviderFormat: 'codex/responses',
      processingTimeMs: 2000,
      metadata: {
        provider_request_headers: {
          Authorization: 'Bearer secret',
          'x-trace-id': 'trace-1'
        },
        provider_request_url: 'http://provider.local/responses',
        provider_response_headers: {
          'content-type': 'application/json'
        },
        provider_response_status: 201,
        provider_response_status_text: 'Created'
      }
    }]);

    const rawTrace = await buildStackRawProviderTrace(
      createLogger(),
      { traceId: 'trace-1', internalExecutionLeaseId: 'run-1', llmRequestSliceId: 'slice-1' },
      'provider-request:wire:llm-call-1'
    );

    expect(listLlmRequestSlices).toHaveBeenCalledWith(expect.objectContaining({
      traceId: 'trace-1',
      runId: 'run-1',
      llmCallId: 'llm-call-1',
      rawTraceOnly: true,
      limit: 1
    }));
    expect(rawTrace?.request.headers).toEqual({
      Authorization: '[redacted]',
      'x-trace-id': 'trace-1'
    });
    expect(rawTrace?.request.body).toBe(JSON.stringify({ model: 'gpt-5-mini', input: ['hello'] }));
    expect(rawTrace?.response.status_code).toBe(201);
    expect(rawTrace?.response.headers).toEqual({ 'content-type': 'application/json' });
    expect(rawTrace?.response.body).toBe(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }]
    }));
    expect(rawTrace?.source).toBe('llm_request_slices.provider_exchange');
  });

  it('loads raw provider exchange from compression fork slices', async () => {
    (listLlmRequestSlices as jest.Mock).mockResolvedValueOnce([{
      id: '21',
      sliceId: 'fork-slice-1',
      llmCallId: 'fork-llm-call-1',
      traceId: 'trace-1',
      runId: 'run-1',
      forkRunId: 'fork-run-1',
      sourceKind: 'compression_fork',
      conversationId: null,
      agentTurn: 1,
      createdAt: '2026-03-28T10:00:01.000Z',
      completedAt: '2026-03-28T10:00:03.000Z',
      status: 'completed',
      modelName: 'gpt-5-mini',
      modelProvider: 'codex',
      wireRequest: { model: 'gpt-5-mini', input: ['compress'] },
      wireResponse: { id: 'resp-fork-1' },
      rawResponse: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'compressed' }] }] },
      tokenUsage: { input_tokens: 100, output_tokens: 20 },
      requestFormatVersion: 'openresponse/v1',
      wireProviderFormat: 'codex/responses',
      processingTimeMs: 2000,
      metadata: {
        provider_request_headers: {
          Authorization: 'Bearer secret',
          'x-trace-id': 'trace-1'
        },
        provider_response_status: 200
      }
    }]);

    const rawTrace = await buildStackRawProviderTrace(
      createLogger(),
      {
        traceId: 'trace-1',
        internalExecutionLeaseId: 'run-1',
        llmRequestSliceId: 'fork-slice-1',
        sourceKind: 'compression_fork',
        forkRunId: 'fork-run-1'
      },
      'compression-fork-slice:fork-slice-1'
    );

    expect(listLlmRequestSlices).toHaveBeenCalledWith(expect.objectContaining({
      traceId: 'trace-1',
      runId: 'run-1',
      sourceKind: 'compression_fork',
      forkRunId: 'fork-run-1',
      sliceId: 'fork-slice-1',
      rawTraceOnly: true,
      limit: 1
    }));
    expect(rawTrace?.request.body).toBe(JSON.stringify({ model: 'gpt-5-mini', input: ['compress'] }));
    expect(rawTrace?.source).toBe('core_memory_compression_fork_slices.provider_exchange');
  });

  it('loads raw provider exchange from subconscious fork slice spans', async () => {
    (listLlmRequestSlices as jest.Mock).mockResolvedValueOnce([{
      id: '41',
      sliceId: 'sub-slice-1',
      llmCallId: 'sub-llm-call-1',
      traceId: 'trace-subconscious-1',
      runId: 'run-subconscious-1',
      forkRunId: 'subconscious-fork-run-1',
      sourceKind: 'subconscious_agent_fork',
      conversationId: null,
      agentTurn: 1,
      createdAt: '2026-03-28T10:00:01.000Z',
      completedAt: '2026-03-28T10:00:03.000Z',
      status: 'completed',
      modelName: 'gpt-5.5',
      modelProvider: 'codex-local',
      wireRequest: { model: 'gpt-5.5', input: ['self continuation'] },
      wireResponse: { id: 'resp-subconscious-1' },
      rawResponse: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'next intent' }] }] },
      tokenUsage: { input_tokens: 100, output_tokens: 20 },
      requestFormatVersion: 'openresponse/v1',
      wireProviderFormat: 'codex-local/responses',
      processingTimeMs: 2000,
      metadata: {
        provider_request_headers: {
          Authorization: 'Bearer secret',
          'x-trace-id': 'trace-subconscious-1'
        },
        provider_response_status: 200
      }
    }]);

    const rawTrace = await buildStackRawProviderTrace(
      createLogger(),
      {
        traceId: 'trace-subconscious-1',
        internalExecutionLeaseId: 'run-subconscious-1',
        sourceKind: 'subconscious_agent_fork',
        forkRunId: 'subconscious-fork-run-1'
      },
      'subconscious-fork-slice:sub-slice-1'
    );

    expect(listLlmRequestSlices).toHaveBeenCalledWith(expect.objectContaining({
      traceId: 'trace-subconscious-1',
      runId: 'run-subconscious-1',
      sourceKind: 'subconscious_agent_fork',
      forkRunId: 'subconscious-fork-run-1',
      sliceId: 'sub-slice-1',
      rawTraceOnly: true,
      limit: 1
    }));
    expect(rawTrace?.request.body).toBe(JSON.stringify({ model: 'gpt-5.5', input: ['self continuation'] }));
    expect(rawTrace?.source).toBe('subconscious_agent_fork_slices.provider_exchange');
  });

  it('loads raw provider exchange from image vision fork slices', async () => {
    (listLlmRequestSlices as jest.Mock).mockResolvedValueOnce([{
      id: '31',
      sliceId: 'vision-slice-1',
      llmCallId: 'vision-llm-call-1',
      traceId: 'trace-vision-1',
      runId: 'run-vision-1',
      forkRunId: 'vision-fork-run-1',
      sourceKind: 'image_vision_fork',
      conversationId: null,
      agentTurn: 1,
      createdAt: '2026-03-28T10:00:01.000Z',
      completedAt: '2026-03-28T10:00:03.000Z',
      status: 'completed',
      modelName: 'gpt-5-mini',
      modelProvider: 'codex',
      wireRequest: { model: 'gpt-5-mini', input: ['inspect image'] },
      wireResponse: { id: 'resp-vision-1' },
      rawResponse: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'observed' }] }] },
      tokenUsage: { input_tokens: 100, output_tokens: 20 },
      requestFormatVersion: 'openresponse/v1',
      wireProviderFormat: 'codex/responses',
      processingTimeMs: 2000,
      metadata: {
        provider_request_headers: {
          Authorization: 'Bearer secret',
          'x-trace-id': 'trace-vision-1'
        },
        provider_response_status: 200
      }
    }]);

    const rawTrace = await buildStackRawProviderTrace(
      createLogger(),
      {
        traceId: 'trace-vision-1',
        internalExecutionLeaseId: 'run-vision-1',
        llmRequestSliceId: 'vision-slice-1',
        sourceKind: 'image_vision_fork',
        forkRunId: 'vision-fork-run-1'
      },
      'image-vision-fork-slice:vision-slice-1'
    );

    expect(listLlmRequestSlices).toHaveBeenCalledWith(expect.objectContaining({
      traceId: 'trace-vision-1',
      runId: 'run-vision-1',
      sourceKind: 'image_vision_fork',
      forkRunId: 'vision-fork-run-1',
      sliceId: 'vision-slice-1',
      rawTraceOnly: true,
      limit: 1
    }));
    expect(rawTrace?.request.body).toBe(JSON.stringify({ model: 'gpt-5-mini', input: ['inspect image'] }));
    expect(rawTrace?.source).toBe('image_vision_fork_slices.provider_exchange');
  });

  it('loads raw provider exchange from image task results', async () => {
    (getAgentTaskById as jest.Mock).mockResolvedValueOnce({
      id: 'task-image-1',
      source_trace_id: 'trace-image',
      result_json: {
        model: 'gpt-image-2',
        provider_exchange: {
          operation: 'generation',
          provider: 'codex',
          model: 'gpt-image-2',
          started_at: '2026-03-28T10:00:01.000Z',
          completed_at: '2026-03-28T10:00:04.000Z',
          duration_ms: 3000,
          request_format_version: 'image-provider/v1',
          wire_provider_format: 'codex/responses',
          request: {
            method: 'POST',
            upstream_url: 'https://chatgpt.com/backend-api/codex/responses',
            headers: {
              Authorization: 'Bearer secret',
              accept: 'text/event-stream'
            },
            body: {
              model: 'gpt-5-mini',
              tools: [{ type: 'image_generation', model: 'gpt-image-2' }]
            },
            body_format: 'json',
            body_source: 'image_provider.codex_responses_request'
          },
          response: {
            status_code: 200,
            headers: {
              'content-type': 'text/event-stream'
            },
            body: 'data: {"type":"response.completed"}',
            body_format: 'sse',
            body_source: 'image_provider.codex_responses_sse'
          }
        }
      }
    });

    const rawTrace = await buildStackRawProviderTrace(
      createLogger(),
      { sourceKind: 'image_task', forkRunId: 'task-image-1' },
      'provider-request:image-task:task-image-1'
    );

    expect(getAgentTaskById).toHaveBeenCalledWith('task-image-1');
    expect(rawTrace?.source).toBe('agent_tasks.result_json.provider_exchange');
    expect(rawTrace?.request.headers).toEqual({
      Authorization: '[redacted]',
      accept: 'text/event-stream'
    });
    expect(rawTrace?.request.body).toBe(JSON.stringify({
      model: 'gpt-5-mini',
      tools: [{ type: 'image_generation', model: 'gpt-image-2' }]
    }));
    expect(rawTrace?.response.status_code).toBe(200);
    expect(rawTrace?.response.body).toBe('data: {"type":"response.completed"}');
  });
});
