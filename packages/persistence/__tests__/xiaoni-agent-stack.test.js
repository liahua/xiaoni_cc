'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createXiaoniAgentStackPersistence } = require('../xiaoni-agent-stack');

function createMockSql() {
  const calls = [];
  const rows = {
    stackHead: [{ stack_index: 7 }],
    forkHead: [{ item_index: 2 }],
    stackInsert: [],
    slice: [],
    tool: [],
    forkRun: [],
    forkItem: [],
    forkSlice: [],
    forkTool: [],
    imageForkRun: [],
    imageForkItem: [],
    imageForkSlice: [],
    subconsciousForkRun: [],
    subconsciousForkItem: [],
    subconsciousForkSlice: [],
    subconsciousForkTool: [],
    providerEvent: [],
    rollupSource: [],
    rollupState: [{ initialized_at: '2026-06-11T00:00:00.000Z', version: 3 }]
  };
  let stackId = 10;
  let forkItemId = 70;
  const executor = {
    calls,
    rows,
    execute: async (sql, params = []) => {
      calls.push({ kind: 'execute', sql, params });
      return 1;
    },
    query: async (sql, params = []) => {
      calls.push({ kind: 'query', sql, params });
      if (sql.includes('pg_advisory_xact_lock')) {
        return [];
      }
      if (sql.includes('INSERT INTO llm_usage_rollup_state')) {
        if (!rows.rollupState.length) {
          rows.rollupState.push({ initialized_at: null, version: params[1] || 1 });
        }
        return [];
      }
      if (sql.includes('SELECT initialized_at') && sql.includes('FROM llm_usage_rollup_state')) {
        return rows.rollupState;
      }
      if (sql.includes('UPDATE llm_usage_rollup_state')) {
        rows.rollupState = [{
          initialized_at: '2026-06-11T00:00:02.000Z',
          version: sql.includes('version = ?') ? (params[0] || 2) : (rows.rollupState[0]?.version || 2)
        }];
        return [];
      }
      if (sql.includes('MAX(stack_index)')) {
        return rows.stackHead;
      }
      if (sql.includes('MAX(item_index)')) {
        return rows.forkHead;
      }
      if (sql.includes('INSERT INTO core_memory_compression_fork_runs')) {
        const row = {
          id: 60,
          fork_run_id: params[0],
          identity_key: params[1],
          context_session_key: params[2],
          status: params[3],
          trace_id: params[4],
          run_id: params[5],
          conversation_id: params[6],
          read_cutoff_after_conversation_id: params[7],
          previous_read_cutoff_after_conversation_id: params[8],
          summary_text: params[9],
          artifact: JSON.parse(params[10]),
          error_message: params[11],
          metadata: JSON.parse(params[12]),
          started_at: params[13] || '2026-06-11T00:00:00.000Z',
          completed_at: params[14],
          created_at: '2026-06-11T00:00:00.000Z',
          updated_at: '2026-06-11T00:00:00.000Z'
        };
        rows.forkRun.push(row);
        return [row];
      }
      if (sql.includes('INSERT INTO subconscious_agent_fork_runs')) {
        const row = {
          id: 160,
          fork_run_id: params[0],
          identity_key: params[1],
          context_session_key: params[2],
          status: params[3],
          trace_id: params[4],
          run_id: params[5],
          conversation_id: params[6],
          notify_queue_message_id: params[7],
          summary_text: params[8],
          artifact: JSON.parse(params[9]),
          error_message: params[10],
          metadata: JSON.parse(params[11]),
          started_at: params[12] || '2026-06-11T00:00:00.000Z',
          completed_at: params[13],
          created_at: '2026-06-11T00:00:00.000Z',
          updated_at: '2026-06-11T00:00:00.000Z'
        };
        rows.subconsciousForkRun.push(row);
        return [row];
      }
      if (sql.includes('UPDATE core_memory_compression_fork_runs')) {
        const existing = rows.forkRun.find((row) => row.fork_run_id === params[6]) || rows.forkRun[0];
        const row = {
          ...(existing || {
            id: 60,
            fork_run_id: params[6],
            identity_key: 'xiaoni',
            context_session_key: 'xiaoni:test-global',
            trace_id: 'trace-1',
            run_id: 'run-1',
            conversation_id: null,
            read_cutoff_after_conversation_id: null,
            previous_read_cutoff_after_conversation_id: null,
            created_at: '2026-06-11T00:00:00.000Z'
          }),
          status: params[0],
          summary_text: params[1] || existing?.summary_text || null,
          artifact: JSON.parse(params[2]),
          error_message: params[3],
          metadata: JSON.parse(params[4]),
          completed_at: params[5] || '2026-06-11T00:00:01.000Z',
          updated_at: '2026-06-11T00:00:01.000Z'
        };
        rows.forkRun = rows.forkRun.filter((entry) => entry.fork_run_id !== row.fork_run_id);
        rows.forkRun.push(row);
        return [row];
      }
      if (sql.includes('UPDATE subconscious_agent_fork_runs')) {
        const existing = rows.subconsciousForkRun.find((row) => row.fork_run_id === params[7]) || rows.subconsciousForkRun[0];
        const row = {
          ...(existing || {
            id: 160,
            fork_run_id: params[7],
            identity_key: 'xiaoni',
            context_session_key: 'xiaoni:test-global',
            trace_id: 'trace-1',
            run_id: 'run-1',
            conversation_id: null,
            created_at: '2026-06-11T00:00:00.000Z'
          }),
          status: params[0],
          notify_queue_message_id: params[1] ?? existing?.notify_queue_message_id ?? null,
          summary_text: params[2] || existing?.summary_text || null,
          artifact: JSON.parse(params[3]),
          error_message: params[4],
          metadata: JSON.parse(params[5]),
          completed_at: params[6] || '2026-06-11T00:00:01.000Z',
          updated_at: '2026-06-11T00:00:01.000Z'
        };
        rows.subconsciousForkRun = rows.subconsciousForkRun.filter((entry) => entry.fork_run_id !== row.fork_run_id);
        rows.subconsciousForkRun.push(row);
        return [row];
      }
      if (sql.includes('FROM core_memory_compression_fork_runs')) {
        return rows.forkRun.filter((row) =>
          row.context_session_key === params[0]
          && row.status === 'running'
          && String(row.metadata?.compression_covered_end_conversation_id) === String(params[1])
        ).slice(0, 1);
      }
      if (sql.includes('INSERT INTO core_memory_compression_fork_items')) {
        const row = {
          id: forkItemId++,
          event_id: params[0],
          fork_run_id: params[1],
          identity_key: params[2],
          item_index: params[3],
          item_kind: params[4],
          role: params[5],
          phase: params[6],
          provider_item_id: params[7],
          tool_call_id: params[8],
          llm_request_slice_id: params[9],
          content: JSON.parse(params[10]),
          visibility: params[11],
          source_type: params[12],
          source_id: params[13],
          trace_id: params[14],
          run_id: params[15],
          conversation_id: params[16],
          metadata: JSON.parse(params[17]),
          created_at: '2026-06-11T00:00:00.000Z',
          updated_at: '2026-06-11T00:00:00.000Z'
        };
        rows.forkItem.push(row);
        return [row];
      }
      if (sql.includes('INSERT INTO subconscious_agent_fork_items')) {
        const row = {
          id: forkItemId++,
          event_id: params[0],
          fork_run_id: params[1],
          identity_key: params[2],
          item_index: params[3],
          item_kind: params[4],
          role: params[5],
          phase: params[6],
          provider_item_id: params[7],
          tool_call_id: params[8],
          llm_request_slice_id: params[9],
          content: JSON.parse(params[10]),
          visibility: params[11],
          source_type: params[12],
          source_id: params[13],
          trace_id: params[14],
          run_id: params[15],
          conversation_id: params[16],
          metadata: JSON.parse(params[17]),
          created_at: '2026-06-11T00:00:00.000Z',
          updated_at: '2026-06-11T00:00:00.000Z'
        };
        rows.subconsciousForkItem.push(row);
        return [row];
      }
      if (sql.includes('INSERT INTO core_memory_compression_fork_slices')) {
        const row = {
          id: 80,
          slice_id: params[0],
          fork_run_id: params[1],
          llm_call_id: params[2],
          identity_key: params[3],
          input_start_index: params[4],
          input_end_index: params[5],
          input_stack_item_ids: JSON.parse(params[6]),
          output_start_index: params[7],
          output_end_index: params[8],
          canonical_request: JSON.parse(params[9]),
          wire_request: params[10] ? JSON.parse(params[10]) : null,
          canonical_response: params[11] ? JSON.parse(params[11]) : null,
          wire_response: params[12] ? JSON.parse(params[12]) : null,
          raw_response: params[13] ? JSON.parse(params[13]) : null,
          output_items: JSON.parse(params[14]),
          status: params[15],
          token_usage: JSON.parse(params[16]),
          trace_id: params[17],
          run_id: params[18],
          conversation_id: params[19],
          agent_turn: params[20],
          model_name: params[21],
          model_provider: params[22],
          request_format_version: params[23],
          wire_provider_format: params[24],
          processing_time_ms: params[25],
          metadata: JSON.parse(params[26]),
          completed_at: params[27],
          created_at: '2026-06-11T00:00:00.000Z',
          updated_at: '2026-06-11T00:00:00.000Z'
        };
        rows.forkSlice.push(row);
        return [row];
      }
      if (sql.includes('INSERT INTO subconscious_agent_fork_slices')) {
        const row = {
          id: 180,
          slice_id: params[0],
          fork_run_id: params[1],
          llm_call_id: params[2],
          identity_key: params[3],
          input_start_index: params[4],
          input_end_index: params[5],
          input_stack_item_ids: JSON.parse(params[6]),
          output_start_index: params[7],
          output_end_index: params[8],
          canonical_request: JSON.parse(params[9]),
          wire_request: params[10] ? JSON.parse(params[10]) : null,
          canonical_response: params[11] ? JSON.parse(params[11]) : null,
          wire_response: params[12] ? JSON.parse(params[12]) : null,
          raw_response: params[13] ? JSON.parse(params[13]) : null,
          output_items: JSON.parse(params[14]),
          status: params[15],
          token_usage: JSON.parse(params[16]),
          trace_id: params[17],
          run_id: params[18],
          conversation_id: params[19],
          agent_turn: params[20],
          model_name: params[21],
          model_provider: params[22],
          request_format_version: params[23],
          wire_provider_format: params[24],
          processing_time_ms: params[25],
          metadata: JSON.parse(params[26]),
          completed_at: params[27],
          created_at: '2026-06-11T00:00:00.000Z',
          updated_at: '2026-06-11T00:00:00.000Z'
        };
        rows.subconsciousForkSlice.push(row);
        return [row];
      }
      if (sql.includes('INSERT INTO core_memory_compression_fork_tool_executions')) {
        const row = {
          id: 90,
          execution_id: params[0],
          fork_run_id: params[1],
          identity_key: params[2],
          llm_request_slice_id: params[3],
          llm_call_id: params[4],
          tool_call_id: params[5],
          tool_name: params[6],
          arguments: JSON.parse(params[7]),
          raw_arguments: params[8],
          result: JSON.parse(params[9]),
          status: params[10],
          error_message: params[11],
          side_effect: params[12],
          trace_id: params[13],
          run_id: params[14],
          conversation_id: params[15],
          agent_turn: params[16],
          stack_call_item_id: params[17],
          stack_output_item_id: params[18],
          metadata: JSON.parse(params[19]),
          created_at: '2026-06-11T00:00:00.000Z',
          started_at: '2026-06-11T00:00:00.000Z',
          completed_at: params[21],
          updated_at: '2026-06-11T00:00:00.000Z'
        };
        rows.forkTool.push(row);
        return [row];
      }
      if (sql.includes('INSERT INTO subconscious_agent_fork_tool_executions')) {
        const row = {
          id: 190,
          execution_id: params[0],
          fork_run_id: params[1],
          identity_key: params[2],
          llm_request_slice_id: params[3],
          llm_call_id: params[4],
          tool_call_id: params[5],
          tool_name: params[6],
          arguments: JSON.parse(params[7]),
          raw_arguments: params[8],
          result: JSON.parse(params[9]),
          status: params[10],
          error_message: params[11],
          side_effect: params[12],
          trace_id: params[13],
          run_id: params[14],
          conversation_id: params[15],
          agent_turn: params[16],
          stack_call_item_id: params[17],
          stack_output_item_id: params[18],
          metadata: JSON.parse(params[19]),
          created_at: '2026-06-11T00:00:00.000Z',
          started_at: '2026-06-11T00:00:00.000Z',
          completed_at: params[21],
          updated_at: '2026-06-11T00:00:00.000Z'
        };
        rows.subconsciousForkTool.push(row);
        return [row];
      }
      if (sql.includes('INSERT INTO image_vision_fork_slices')) {
        const row = {
          id: 100,
          slice_id: params[0],
          fork_run_id: params[1],
          llm_call_id: params[2],
          identity_key: params[3],
          input_start_index: params[4],
          input_end_index: params[5],
          input_stack_item_ids: JSON.parse(params[6]),
          output_start_index: params[7],
          output_end_index: params[8],
          canonical_request: JSON.parse(params[9]),
          wire_request: params[10] ? JSON.parse(params[10]) : null,
          canonical_response: params[11] ? JSON.parse(params[11]) : null,
          wire_response: params[12] ? JSON.parse(params[12]) : null,
          raw_response: params[13] ? JSON.parse(params[13]) : null,
          output_items: JSON.parse(params[14]),
          status: params[15],
          token_usage: JSON.parse(params[16]),
          trace_id: params[17],
          run_id: params[18],
          conversation_id: params[19],
          agent_turn: params[20],
          model_name: params[21],
          model_provider: params[22],
          request_format_version: params[23],
          wire_provider_format: params[24],
          processing_time_ms: params[25],
          metadata: JSON.parse(params[26]),
          completed_at: params[27],
          created_at: '2026-06-11T00:00:00.000Z',
          updated_at: '2026-06-11T00:00:00.000Z'
        };
        rows.imageForkSlice.push(row);
        return [row];
      }
      if (sql.includes('UPDATE core_memory_compression_fork_tool_executions')) {
        const existing = rows.forkTool.find((row) => row.execution_id === params[5]) || rows.forkTool[0];
        const row = {
          ...existing,
          status: params[0],
          result: JSON.parse(params[1]),
          error_message: params[2],
          stack_output_item_id: params[3],
          completed_at: params[4] || '2026-06-11T00:00:01.000Z',
          updated_at: '2026-06-11T00:00:01.000Z'
        };
        rows.forkTool = rows.forkTool.filter((entry) => entry.execution_id !== row.execution_id);
        rows.forkTool.push(row);
        return [row];
      }
      if (sql.includes('UPDATE subconscious_agent_fork_tool_executions')) {
        const existing = rows.subconsciousForkTool.find((row) => row.execution_id === params[5]) || rows.subconsciousForkTool[0];
        const row = {
          ...existing,
          status: params[0],
          result: JSON.parse(params[1]),
          error_message: params[2],
          stack_output_item_id: params[3],
          completed_at: params[4] || '2026-06-11T00:00:01.000Z',
          updated_at: '2026-06-11T00:00:01.000Z'
        };
        rows.subconsciousForkTool = rows.subconsciousForkTool.filter((entry) => entry.execution_id !== row.execution_id);
        rows.subconsciousForkTool.push(row);
        return [row];
      }
      if (sql.includes('INSERT INTO agent_stack_items')) {
        const row = {
          id: stackId++,
          event_id: params[0],
          identity_key: params[1],
          stack_index: params[2],
          item_kind: params[3],
          role: params[4],
          phase: params[5],
          provider_item_id: params[6],
          tool_call_id: params[7],
          llm_request_slice_id: params[8],
          content: JSON.parse(params[9]),
          visibility: params[10],
          source_type: params[11],
          source_id: params[12],
          trace_id: params[13],
          run_id: params[14],
          conversation_id: params[15],
          metadata: JSON.parse(params[16]),
          created_at: '2026-06-11T00:00:00.000Z',
          updated_at: '2026-06-11T00:00:00.000Z'
        };
        rows.stackInsert.push(row);
        return [row];
      }
      if (sql.includes('INSERT INTO llm_request_slices')) {
        const row = {
          id: 30,
          slice_id: params[0],
          llm_call_id: params[1],
          identity_key: params[2],
          input_start_index: params[3],
          input_end_index: params[4],
          input_stack_item_ids: JSON.parse(params[5]),
          output_start_index: params[6],
          output_end_index: params[7],
          canonical_request: JSON.parse(params[8]),
          wire_request: params[9] ? JSON.parse(params[9]) : null,
          canonical_response: params[10] ? JSON.parse(params[10]) : null,
          wire_response: params[11] ? JSON.parse(params[11]) : null,
          raw_response: params[12] ? JSON.parse(params[12]) : null,
          output_items: JSON.parse(params[13]),
          status: params[14],
          token_usage: JSON.parse(params[15]),
          trace_id: params[16],
          run_id: params[17],
          conversation_id: params[18],
          agent_turn: params[19],
          model_name: params[20],
          model_provider: params[21],
          request_format_version: params[22],
          wire_provider_format: params[23],
          processing_time_ms: params[24],
          metadata: JSON.parse(params[25]),
          completed_at: params[26],
          created_at: '2026-06-11T00:00:00.000Z',
          updated_at: '2026-06-11T00:00:00.000Z'
        };
        rows.slice.push(row);
        return [row];
      }
      if (sql.includes('INSERT INTO codex_provider_usage_events')) {
        const row = {
          id: 120,
          event_id: params[0],
          source_kind: params[1],
          source_id: params[2],
          identity_key: params[3],
          llm_call_id: params[4],
          trace_id: params[5],
          run_id: params[6],
          conversation_id: params[7],
          canonical_request: JSON.parse(params[8]),
          wire_request: params[9] ? JSON.parse(params[9]) : null,
          canonical_response: params[10] ? JSON.parse(params[10]) : null,
          wire_response: params[11] ? JSON.parse(params[11]) : null,
          raw_response: params[12] ? JSON.parse(params[12]) : null,
          output_items: JSON.parse(params[13]),
          status: params[14],
          token_usage: JSON.parse(params[15]),
          model_name: params[16],
          model_provider: params[17],
          request_format_version: params[18],
          wire_provider_format: params[19],
          processing_time_ms: params[20],
          metadata: JSON.parse(params[21]),
          created_at: params[22] || '2026-06-11T00:00:00.000Z',
          completed_at: params[23],
          updated_at: '2026-06-11T00:00:00.000Z'
        };
        rows.providerEvent = rows.providerEvent.filter((entry) => entry.event_id !== row.event_id);
        rows.providerEvent.push(row);
        return [row];
      }
      if (/SELECT\s+\*\s+FROM\s+codex_provider_usage_events/i.test(sql)) {
        return rows.providerEvent.filter((row) => {
          let index = 0;
          if (sql.includes('identity_key = ?') && row.identity_key !== params[index++]) {
            return false;
          }
          if (sql.includes('event_id = ?') && row.event_id !== params[index++]) {
            return false;
          }
          if (sql.includes('source_kind = ?') && row.source_kind !== params[index++]) {
            return false;
          }
          if (sql.includes('source_id = ?') && row.source_id !== params[index++]) {
            return false;
          }
          if (sql.includes('trace_id = ?') && row.trace_id !== params[index++]) {
            return false;
          }
          if (sql.includes('run_id = ?') && row.run_id !== params[index++]) {
            return false;
          }
          if (sql.includes('llm_call_id = ?') && row.llm_call_id !== params[index++]) {
            return false;
          }
          return true;
        });
      }
      if (sql.includes("date_trunc('hour', created_at)") && sql.includes('FROM codex_provider_usage_events') && sql.includes('WHERE slice_id = ?')) {
        const eventId = params[0];
        const row = rows.providerEvent.find((entry) => entry.event_id === eventId);
        if (!row) {
          return [];
        }
        if (
          sql.includes("source_kind = 'core_memory_compression_fork'")
          && row.source_kind === 'core_memory_compression_fork'
          && rows.forkSlice.some((slice) => slice.llm_call_id === row.llm_call_id)
        ) {
          return [];
        }
        if (
          sql.includes("source_kind = 'image_vision_fork'")
          && row.source_kind === 'image_vision_fork'
          && rows.imageForkSlice.some((slice) => slice.llm_call_id === row.llm_call_id)
        ) {
          return [];
        }
        if (
          sql.includes("source_kind = 'subconscious_agent_fork'")
          && row.source_kind === 'subconscious_agent_fork'
          && rows.subconsciousForkSlice.some((slice) => slice.llm_call_id === row.llm_call_id)
        ) {
          return [];
        }
        return [{
          slice_id: row.event_id,
          source_kind: row.source_kind,
          fork_run_id: row.source_id,
          identity_key: row.identity_key,
          llm_call_id: row.llm_call_id,
          trace_id: row.trace_id,
          created_at: row.created_at,
          hour_bucket_start: row.created_at,
          day_bucket_start: row.created_at,
          month_bucket_start: row.created_at,
          input_tokens: row.token_usage.input_tokens || row.token_usage.inputTokens || row.token_usage.prompt_tokens || 0,
          cached_tokens: row.token_usage.cached_input_tokens || row.token_usage.cachedInputTokens || 0,
          output_tokens: row.token_usage.output_tokens || row.token_usage.outputTokens || row.token_usage.completion_tokens || 0
        }];
      }
      if (sql.includes("date_trunc('hour', created_at)") && sql.includes('WHERE slice_id = ?')) {
        const sourceKind = params[0];
        const sliceId = params[1];
        const sourceRows = sourceKind === 'compression_fork'
          ? rows.forkSlice
          : sourceKind === 'image_vision_fork'
            ? rows.imageForkSlice
            : sourceKind === 'subconscious_agent_fork'
              ? rows.subconsciousForkSlice
              : rows.slice;
        const row = sourceRows.find((entry) => entry.slice_id === sliceId);
        if (!row) {
          return [];
        }
        return [{
          slice_id: row.slice_id,
          source_kind: sourceKind,
          fork_run_id: sourceKind === 'compression_fork' || sourceKind === 'image_vision_fork' || sourceKind === 'subconscious_agent_fork' ? row.fork_run_id : null,
          identity_key: row.identity_key,
          llm_call_id: row.llm_call_id,
          trace_id: row.trace_id,
          created_at: row.created_at,
          hour_bucket_start: row.created_at,
          day_bucket_start: row.created_at,
          month_bucket_start: row.created_at,
          input_tokens: row.token_usage.input_tokens || row.token_usage.inputTokens || row.token_usage.prompt_tokens || 0,
          cached_tokens: row.token_usage.cached_input_tokens || row.token_usage.cachedInputTokens || 0,
          output_tokens: row.token_usage.output_tokens || row.token_usage.outputTokens || row.token_usage.completion_tokens || 0
        }];
      }
      if (sql.includes('SELECT * FROM llm_usage_rollup_sources')) {
        return rows.rollupSource.filter((row) => row.slice_id === params[0]);
      }
      if (sql.includes('INSERT INTO llm_usage_rollup_sources')) {
        const row = {
          slice_id: params[0],
          source_kind: params[1],
          fork_run_id: params[2],
          identity_key: params[3],
          llm_call_id: params[4],
          trace_id: params[5],
          created_at: params[6],
          hour_bucket_start: params[7],
          day_bucket_start: params[8],
          month_bucket_start: params[9],
          input_tokens: params[10],
          cached_tokens: params[11],
          output_tokens: params[12],
          updated_at: '2026-06-11T00:00:02.000Z'
        };
        rows.rollupSource = rows.rollupSource.filter((entry) => entry.slice_id !== row.slice_id);
        rows.rollupSource.push(row);
        return [row];
      }
      if (sql.includes('FROM llm_usage_rollup_sources')) {
        return rows.rollupSource;
      }
      if (sql.includes('FROM core_memory_compression_fork_items')) {
        return rows.forkItem;
      }
      if (sql.includes('FROM subconscious_agent_fork_items')) {
        return rows.subconsciousForkItem;
      }
      if (sql.includes('FROM image_vision_fork_items')) {
        return rows.imageForkItem;
      }
      if (sql.includes('FROM core_memory_compression_fork_slices')) {
        return rows.forkSlice.map((row) => ({ ...row, source_kind: 'compression_fork' }));
      }
      if (sql.includes('FROM subconscious_agent_fork_slices')) {
        return rows.subconsciousForkSlice.map((row) => ({ ...row, source_kind: 'subconscious_agent_fork' }));
      }
      if (sql.includes('FROM image_vision_fork_slices')) {
        return rows.imageForkSlice.map((row) => ({ ...row, source_kind: 'image_vision_fork' }));
      }
      if (sql.includes('UPDATE llm_request_slices')) {
        const existing = rows.slice.find((row) => row.slice_id === params[6]) || rows.slice[0];
        if (!existing) {
          return [];
        }
        const row = {
          ...existing,
          input_start_index: params[0] ?? existing.input_start_index,
          input_end_index: params[1] ?? existing.input_end_index,
          input_stack_item_ids: params[2] ? JSON.parse(params[3]) : existing.input_stack_item_ids,
          output_start_index: params[4] ?? existing.output_start_index,
          output_end_index: params[5] ?? existing.output_end_index,
          updated_at: '2026-06-11T00:00:02.000Z'
        };
        rows.slice = rows.slice.map((entry) => entry.slice_id === row.slice_id ? row : entry);
        return [row];
      }
      if (sql.includes('FROM llm_request_slices')) {
        return rows.slice;
      }
      if (sql.includes('FROM core_memory_compression_fork_tool_executions')) {
        return rows.forkTool;
      }
      if (sql.includes('FROM subconscious_agent_fork_tool_executions')) {
        return rows.subconsciousForkTool;
      }
      if (sql.includes('INSERT INTO tool_executions') || sql.includes('UPDATE tool_executions')) {
        const row = {
          id: 40,
          execution_id: sql.includes('INSERT') ? params[0] : params[5],
          identity_key: 'xiaoni',
          llm_request_slice_id: 'llm-1',
          llm_call_id: 'llm-1',
          tool_call_id: 'call-1',
          tool_name: 'exec_command',
          arguments: { cmd: 'pwd' },
          raw_arguments: '{"cmd":"pwd"}',
          result: sql.includes('INSERT') ? JSON.parse(params[8]) : JSON.parse(params[1]),
          status: sql.includes('INSERT') ? params[9] : params[0],
          error_message: sql.includes('INSERT') ? params[10] : params[2],
          side_effect: true,
          trace_id: 'trace-1',
          run_id: 'run-1',
          conversation_id: null,
          agent_turn: 1,
          stack_call_item_id: 10,
          stack_output_item_id: sql.includes('INSERT') ? null : params[3],
          metadata: {},
          created_at: '2026-06-11T00:00:00.000Z',
          started_at: '2026-06-11T00:00:00.000Z',
          completed_at: sql.includes('INSERT') ? null : '2026-06-11T00:00:01.000Z',
          updated_at: '2026-06-11T00:00:01.000Z'
        };
        rows.tool.push(row);
        return [row];
      }
      if (sql.includes('FROM tool_executions')) {
        return rows.tool;
      }
      return [];
    },
    insert: async () => {
      throw new Error('not used');
    },
    withTransaction: async (callback) => callback(executor),
    close: async () => {
      calls.push({ kind: 'close' });
    }
  };
  return executor;
}

test('ensureXiaoniAgentStackSchema creates main and fork ledger tables', async () => {
  const sql = createMockSql();
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  await persistence.ensureXiaoniAgentStackSchema();

  const ddl = sql.calls.filter((call) => call.kind === 'execute').map((call) => call.sql).join('\n');
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS agent_stack_items/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS llm_request_slices/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS codex_provider_usage_events/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS tool_executions/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS stack_compactions/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS core_memory_compression_fork_runs/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS core_memory_compression_fork_items/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS core_memory_compression_fork_slices/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS core_memory_compression_fork_tool_executions/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS image_vision_fork_runs/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS image_vision_fork_items/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS image_vision_fork_slices/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS subconscious_agent_fork_runs/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS subconscious_agent_fork_items/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS subconscious_agent_fork_slices/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS subconscious_agent_fork_tool_executions/);
});

test('subconscious agent fork ledger records natural-language notify linkage and usage source', async () => {
  const sql = createMockSql();
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  const run = await persistence.recordSubconsciousAgentForkRun({
    forkRunId: 'subconscious-fork:run-1:test',
    contextSessionKey: 'xiaoni:test-global',
    status: 'running',
    traceId: 'trace-sub',
    runId: 'run-1',
    metadata: { trigger: 'empty_notify_after_final_answer' }
  });
  const items = await persistence.appendSubconsciousAgentForkItems({
    forkRunId: run.forkRunId,
    traceId: 'trace-sub',
    runId: 'run-1',
    sourceType: 'subconscious_agent_fork_slices',
    sourceId: 'sub-slice-1',
    llmRequestSliceId: 'sub-slice-1',
    items: [{
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: '继续看看昨晚留下的 seed。' }]
    }]
  });
  const slice = await persistence.recordSubconsciousAgentForkSlice({
    forkRunId: run.forkRunId,
    sliceId: 'sub-slice-1',
    llmCallId: 'llm-sub-1',
    inputStartIndex: items[0].itemIndex,
    inputEndIndex: items[0].itemIndex,
    inputStackItemIds: [items[0].id],
    outputStartIndex: items[0].itemIndex,
    outputEndIndex: items[0].itemIndex,
    canonicalRequest: { input: ['context'] },
    canonicalResponse: { output: ['继续看看昨晚留下的 seed。'] },
    outputItems: [{ type: 'message' }],
    status: 'completed',
    tokenUsage: { input_tokens: 12, output_tokens: 5 },
    traceId: 'trace-sub',
    runId: 'run-1',
    agentTurn: 1,
    modelName: 'gpt-test',
    modelProvider: 'codex'
  });
  const tool = await persistence.recordSubconsciousAgentForkToolExecution({
    forkRunId: run.forkRunId,
    executionId: 'sub-tool-1',
    llmRequestSliceId: slice.sliceId,
    llmCallId: 'llm-sub-1',
    toolCallId: 'call-sub-1',
    toolName: 'web_search',
    arguments: { q: 'fun seed' },
    result: {},
    status: 'running',
    traceId: 'trace-sub',
    runId: 'run-1',
    agentTurn: 1
  });
  const completedTool = await persistence.completeSubconsciousAgentForkToolExecution({
    executionId: tool.executionId,
    status: 'completed',
    result: { ok: true },
    stackOutputItemId: items[0].id
  });
  const completed = await persistence.completeSubconsciousAgentForkRun({
    forkRunId: run.forkRunId,
    status: 'completed',
    notifyQueueMessageId: 909,
    summaryText: '继续看看昨晚留下的 seed。',
    artifact: { notify_queue_message_id: 909 }
  });

  assert.equal(completed.notifyQueueMessageId, '909');
  assert.equal(completed.summaryText, '继续看看昨晚留下的 seed。');
  assert.equal(completedTool.status, 'completed');
  assert.equal(slice.forkRunId, run.forkRunId);
  assert.ok(sql.rows.rollupSource.some((row) =>
    row.slice_id === 'sub-slice-1'
    && row.source_kind === 'subconscious_agent_fork'
    && row.fork_run_id === run.forkRunId
    && row.input_tokens === 12
    && row.output_tokens === 5
  ));
});

test('appendAgentStackItems assigns monotonic identity-local stack indexes', async () => {
  const sql = createMockSql();
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  const rows = await persistence.appendAgentStackItems({
    identityKey: 'xiaoni',
    traceId: 'trace-1',
    runId: 'run-1',
    sourceType: 'test',
    sourceId: 'source-1',
    items: [
      { itemKind: 'runtime_input', role: 'developer', content: { source: 'self_continuation' } },
      { itemKind: 'function_call', role: 'assistant', toolCallId: 'call-1', content: { type: 'function_call' } }
    ]
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].stackIndex, 8);
  assert.equal(rows[1].stackIndex, 9);
  assert.equal(rows[1].toolCallId, 'call-1');
  assert.equal(rows[0].sourceType, 'test');
});

test('recordLlmRequestSlice stores canonical request and output item range', async () => {
  const sql = createMockSql();
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  const slice = await persistence.recordLlmRequestSlice({
    sliceId: 'llm-1',
    llmCallId: 'llm-1',
    inputStartIndex: 1,
    inputEndIndex: 8,
    outputStartIndex: 9,
    outputEndIndex: 10,
    canonicalRequest: { input: [{ role: 'developer' }] },
    canonicalResponse: { output: [{ type: 'function_call', call_id: 'call-1' }] },
    outputItems: [{ type: 'function_call', call_id: 'call-1' }],
    status: 'completed',
    tokenUsage: { input_tokens: 10, output_tokens: 3 },
    traceId: 'trace-1',
    runId: 'run-1',
    agentTurn: 1,
    modelName: 'gpt-test',
    modelProvider: 'codex'
  });

  assert.equal(slice.sliceId, 'llm-1');
  assert.equal(slice.inputStartIndex, 1);
  assert.equal(slice.outputEndIndex, 10);
  assert.equal(slice.outputItems[0].call_id, 'call-1');
  assert.equal(slice.tokenUsage.input_tokens, 10);
  assert.ok(sql.rows.rollupSource.some((row) => row.slice_id === 'llm-1' && row.source_kind === 'main'));
});

test('recordCodexProviderUsageEvent stores no-stack Codex Provider calls in usage rollups', async () => {
  const sql = createMockSql();
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  const event = await persistence.recordCodexProviderUsageEvent({
    eventId: 'codex-provider:vision-1',
    sourceKind: 'image_vision_fork',
    sourceId: 'media-observation-1',
    llmCallId: 'vision-1',
    traceId: 'trace-vision',
    runId: 'run-vision',
    canonicalRequest: { input: [{ type: 'message', content: 'describe image' }] },
    canonicalResponse: { output: [{ type: 'message' }] },
    outputItems: [{ type: 'message' }],
    tokenUsage: { input_tokens: 33, cached_input_tokens: 12, output_tokens: 7 },
    modelName: 'gpt-5-mini',
    modelProvider: 'codex'
  });

  assert.equal(event.eventId, 'codex-provider:vision-1');
  assert.equal(event.sourceKind, 'image_vision_fork');
  assert.equal(event.sourceId, 'media-observation-1');
  assert.ok(sql.rows.rollupSource.some((row) =>
    row.slice_id === 'codex-provider:vision-1'
    && row.source_kind === 'image_vision_fork'
    && row.fork_run_id === 'media-observation-1'
    && row.input_tokens === 33
    && row.output_tokens === 7
  ));
});

test('listCodexProviderUsageEvents returns cache heartbeat provider events', async () => {
  const sql = createMockSql();
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  await persistence.recordCodexProviderUsageEvent({
    eventId: 'codex-provider:llm-heartbeat',
    sourceKind: 'cache_heartbeat',
    llmCallId: 'llm-heartbeat',
    traceId: 'trace-heartbeat',
    runId: 'run-heartbeat',
    canonicalRequest: { input: [{ type: 'message', content: 'Heartbeat' }] },
    wireRequest: { model: 'gpt-test' },
    rawResponse: { output_text: '1' },
    outputItems: [{ type: 'message' }],
    tokenUsage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 1 },
    modelName: 'gpt-test',
    modelProvider: 'codex-local'
  });

  const rows = await persistence.listCodexProviderUsageEvents({
    identityKey: 'xiaoni',
    sourceKind: 'cache_heartbeat',
    limit: 10
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].eventId, 'codex-provider:llm-heartbeat');
  assert.equal(rows[0].sourceKind, 'cache_heartbeat');
  assert.equal(rows[0].llmCallId, 'llm-heartbeat');
  assert.equal(rows[0].tokenUsage.cached_input_tokens, 90);
});

test('recordCodexProviderUsageEvent skips rollup when compression fork slice owns the same llm call', async () => {
  const sql = createMockSql();
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  await persistence.recordCoreMemoryCompressionForkSlice({
    forkRunId: 'fork-usage-owner',
    sliceId: 'fork-slice-owner',
    llmCallId: 'llm-compress-owned',
    canonicalRequest: { input: [{ role: 'developer' }] },
    canonicalResponse: { output: [{ type: 'message' }] },
    outputItems: [{ type: 'message' }],
    tokenUsage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 20 },
    traceId: 'trace-compress',
    runId: 'run-compress',
    agentTurn: 1,
    modelName: 'gpt-test'
  });

  await persistence.recordCodexProviderUsageEvent({
    eventId: 'codex-provider:llm-compress-owned',
    sourceKind: 'core_memory_compression_fork',
    llmCallId: 'llm-compress-owned',
    traceId: 'trace-compress',
    runId: 'run-compress',
    canonicalRequest: { input: [{ type: 'message', content: 'compress' }] },
    canonicalResponse: { output: [{ type: 'message' }] },
    outputItems: [{ type: 'message' }],
    tokenUsage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 20 },
    modelName: 'gpt-test',
    modelProvider: 'codex'
  });

  assert.ok(sql.rows.rollupSource.some((row) =>
    row.slice_id === 'fork-slice-owner'
    && row.source_kind === 'compression_fork'
    && row.cached_tokens === 900
  ));
  assert.equal(sql.rows.rollupSource.some((row) =>
    row.slice_id === 'codex-provider:llm-compress-owned'
  ), false);
});

test('recordCodexProviderUsageEvent skips rollup when image vision fork slice owns the same llm call', async () => {
  const sql = createMockSql();
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  await persistence.recordImageVisionForkSlice({
    forkRunId: 'image-fork-usage-owner',
    sliceId: 'image-fork-slice-owner',
    llmCallId: 'llm-image-owned',
    canonicalRequest: { input: [{ role: 'user' }] },
    canonicalResponse: { output: [{ type: 'message' }] },
    outputItems: [{ type: 'message' }],
    tokenUsage: { input_tokens: 500, cached_input_tokens: 400, output_tokens: 50 },
    traceId: 'trace-image',
    runId: 'run-image',
    modelName: 'gpt-test'
  });

  await persistence.recordCodexProviderUsageEvent({
    eventId: 'codex-provider:llm-image-owned',
    sourceKind: 'image_vision_fork',
    llmCallId: 'llm-image-owned',
    traceId: 'trace-image',
    runId: 'run-image',
    canonicalRequest: { input: [{ type: 'message', content: 'inspect image' }] },
    canonicalResponse: { output: [{ type: 'message' }] },
    outputItems: [{ type: 'message' }],
    tokenUsage: { input_tokens: 500, cached_input_tokens: 400, output_tokens: 50 },
    modelName: 'gpt-test',
    modelProvider: 'codex'
  });

  assert.ok(sql.rows.rollupSource.some((row) =>
    row.slice_id === 'image-fork-slice-owner'
    && row.source_kind === 'image_vision_fork'
    && row.cached_tokens === 400
  ));
  assert.equal(sql.rows.rollupSource.some((row) =>
    row.slice_id === 'codex-provider:llm-image-owned'
  ), false);
});

test('updateLlmRequestSliceStackLinks only updates stack indexes without rewriting provider payloads', async () => {
  const sql = createMockSql();
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  await persistence.recordLlmRequestSlice({
    sliceId: 'llm-provider-owned',
    llmCallId: 'llm-provider-owned',
    canonicalRequest: { input: [{ role: 'developer', content: 'keep' }] },
    wireRequest: { model: 'gpt-test', input: ['wire'] },
    canonicalResponse: { output: [{ type: 'message' }] },
    wireResponse: { id: 'resp-1', output: [] },
    rawResponse: { id: 'resp-1' },
    outputItems: [{ type: 'message' }],
    status: 'completed',
    tokenUsage: { total_tokens: 13 },
    traceId: 'trace-1',
    runId: 'run-1',
    agentTurn: 1,
    modelName: 'gpt-test',
    modelProvider: 'codex'
  });

  const linked = await persistence.updateLlmRequestSliceStackLinks({
    sliceId: 'llm-provider-owned',
    inputStartIndex: 1,
    inputEndIndex: 8,
    inputStackItemIds: [1, 2, 3],
    outputStartIndex: 9,
    outputEndIndex: 10
  });
  const update = sql.calls.find((call) => call.kind === 'query' && call.sql.includes('UPDATE llm_request_slices'));

  assert.ok(update);
  assert.doesNotMatch(update.sql, /canonical_request/);
  assert.doesNotMatch(update.sql, /wire_request/);
  assert.doesNotMatch(update.sql, /wire_response/);
  assert.equal(linked.inputStartIndex, 1);
  assert.equal(linked.outputEndIndex, 10);
  assert.deepEqual(linked.inputStackItemIds, [1, 2, 3]);
  assert.deepEqual(linked.canonicalRequest, { input: [{ role: 'developer', content: 'keep' }] });
  assert.deepEqual(linked.wireRequest, { model: 'gpt-test', input: ['wire'] });
  assert.deepEqual(linked.wireResponse, { id: 'resp-1', output: [] });
});

test('listLlmRequestSlices summaryOnly avoids selecting large request and response payloads', async () => {
  const sql = createMockSql();
  sql.rows.slice.push({
    id: 30,
    slice_id: 'llm-1',
    llm_call_id: 'llm-1',
    identity_key: 'xiaoni',
    input_start_index: 1,
    input_end_index: 8,
    input_stack_item_ids: [],
    output_start_index: 9,
    output_end_index: 10,
    canonical_request: {},
    wire_request: null,
    provider_raw_trace_available: true,
    canonical_response: null,
    wire_response: null,
    raw_response: null,
    output_items: [],
    status: 'completed',
    token_usage: { input_tokens: 10, output_tokens: 3 },
    trace_id: 'trace-1',
    run_id: 'run-1',
    conversation_id: null,
    agent_turn: 1,
    model_name: 'gpt-test',
    model_provider: 'codex',
    request_format_version: 'responses/v1',
    wire_provider_format: 'openai/responses',
    processing_time_ms: 123,
    metadata: {},
    created_at: '2026-06-11T00:00:00.000Z',
    completed_at: '2026-06-11T00:00:01.000Z',
    updated_at: '2026-06-11T00:00:01.000Z'
  });
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  const rows = await persistence.listLlmRequestSlices({ summaryOnly: true, limit: 10 });
  const query = sql.calls.find((call) => call.kind === 'query' && call.sql.includes('FROM llm_request_slices'));

  assert.ok(query);
  assert.match(query.sql, /NULL::jsonb AS wire_request/);
  assert.match(query.sql, /wire_request IS NOT NULL AS provider_raw_trace_available/);
  assert.doesNotMatch(query.sql, /SELECT \*/);
  assert.equal(rows[0].wireRequest, null);
  assert.equal(rows[0].providerRawTraceAvailable, true);
  assert.deepEqual(rows[0].outputItems, []);
});

test('listLlmRequestSlices rawTraceOnly selects only provider exchange payload columns', async () => {
  const sql = createMockSql();
  sql.rows.slice.push({
    id: 30,
    slice_id: 'llm-1',
    llm_call_id: 'llm-1',
    identity_key: 'xiaoni',
    input_start_index: null,
    input_end_index: null,
    input_stack_item_ids: [],
    output_start_index: null,
    output_end_index: null,
    canonical_request: {},
    wire_request: { model: 'gpt-test', input: ['hello'] },
    canonical_response: null,
    wire_response: { id: 'resp-1' },
    raw_response: { id: 'resp-1', output: [] },
    output_items: [],
    status: 'completed',
    token_usage: { input_tokens: 10, output_tokens: 3 },
    trace_id: 'trace-1',
    run_id: 'run-1',
    conversation_id: null,
    agent_turn: 1,
    model_name: 'gpt-test',
    model_provider: 'codex',
    request_format_version: 'responses/v1',
    wire_provider_format: 'openai/responses',
    processing_time_ms: 123,
    metadata: {
      provider_request_headers: { 'content-type': 'application/json' },
      provider_response_headers: { 'content-type': 'text/event-stream' }
    },
    created_at: '2026-06-11T00:00:00.000Z',
    completed_at: '2026-06-11T00:00:01.000Z',
    updated_at: '2026-06-11T00:00:01.000Z'
  });
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  const rows = await persistence.listLlmRequestSlices({ rawTraceOnly: true, limit: 1 });
  const query = sql.calls.find((call) => call.kind === 'query' && call.sql.includes('FROM llm_request_slices'));

  assert.ok(query);
  assert.match(query.sql, /wire_request/);
  assert.match(query.sql, /wire_response/);
  assert.match(query.sql, /raw_response/);
  assert.match(query.sql, /metadata/);
  assert.match(query.sql, /NULL::jsonb AS canonical_response/);
  assert.doesNotMatch(query.sql, /SELECT \*/);
  assert.deepEqual(rows[0].wireRequest, { model: 'gpt-test', input: ['hello'] });
  assert.deepEqual(rows[0].rawResponse, { id: 'resp-1', output: [] });
});

test('recordToolExecution and completeToolExecution link tool result callback stack item', async () => {
  const sql = createMockSql();
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  const running = await persistence.recordToolExecution({
    executionId: 'tool:run-1:call-1',
    llmRequestSliceId: 'llm-1',
    llmCallId: 'llm-1',
    toolCallId: 'call-1',
    toolName: 'exec_command',
    arguments: { cmd: 'pwd' },
    rawArguments: '{"cmd":"pwd"}',
    status: 'running',
    sideEffect: true,
    traceId: 'trace-1',
    runId: 'run-1',
    agentTurn: 1,
    stackCallItemId: 10
  });
  const completed = await persistence.completeToolExecution({
    executionId: 'tool:run-1:call-1',
    status: 'completed',
    result: { stdout: '/tmp' },
    stackOutputItemId: 11
  });

  assert.equal(running.executionId, 'tool:run-1:call-1');
  assert.equal(running.status, 'running');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.stackOutputItemId, '11');
  assert.equal(completed.result.stdout, '/tmp');
});

test('listToolExecutions filters by tool name in persistence', async () => {
  const sql = createMockSql();
  sql.rows.tool.push({
    id: 41,
    execution_id: 'tool:run-2:call-recover',
    identity_key: 'xiaoni',
    llm_request_slice_id: 'llm-2',
    llm_call_id: 'llm-2',
    tool_call_id: 'call-recover',
    tool_name: 'recover_energy',
    arguments: { reason: '困了' },
    raw_arguments: '{"reason":"困了"}',
    result: {
      rest_rejected: true,
      reason: '现在还没到可以休息的线'
    },
    status: 'completed',
    error_message: null,
    side_effect: false,
    trace_id: 'trace-2',
    run_id: 'run-2',
    conversation_id: null,
    agent_turn: 2,
    stack_call_item_id: 12,
    stack_output_item_id: 13,
    metadata: {},
    created_at: '2026-06-11T00:02:00.000Z',
    started_at: '2026-06-11T00:02:00.000Z',
    completed_at: '2026-06-11T00:02:01.000Z',
    updated_at: '2026-06-11T00:02:01.000Z'
  });
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  const rows = await persistence.listToolExecutions({
    identityKey: 'xiaoni',
    toolName: 'recover_energy',
    limit: 10
  });
  const query = sql.calls.find((call) => call.kind === 'query' && call.sql.includes('FROM tool_executions'));

  assert.ok(query);
  assert.match(query.sql, /tool_name = \?/);
  assert.deepEqual(query.params.slice(0, 2), ['xiaoni', 'recover_energy']);
  assert.equal(rows[0].toolName, 'recover_energy');
  assert.equal(rows[0].result.rest_rejected, true);
});

test('stack trace list APIs read subconscious fork ledger tables when sourceKind is provided', async () => {
  const sql = createMockSql();
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  await persistence.recordSubconsciousAgentForkRun({
    forkRunId: 'subconscious-fork:run-1:seed',
    contextSessionKey: 'xiaoni:test-global',
    status: 'running',
    traceId: 'trace-subconscious',
    runId: 'run-subconscious'
  });
  await persistence.appendSubconsciousAgentForkItems({
    forkRunId: 'subconscious-fork:run-1:seed',
    traceId: 'trace-subconscious',
    runId: 'run-subconscious',
    llmRequestSliceId: 'sub-slice-1',
    items: [{
      itemKind: 'function_call',
      toolCallId: 'call-subconscious',
      content: { type: 'function_call', name: 'exec_command' }
    }]
  });
  await persistence.recordSubconsciousAgentForkSlice({
    forkRunId: 'subconscious-fork:run-1:seed',
    sliceId: 'sub-slice-1',
    llmCallId: 'sub-llm-1',
    traceId: 'trace-subconscious',
    runId: 'run-subconscious',
    outputItems: [],
    tokenUsage: { input_tokens: 1, output_tokens: 1 }
  });
  await persistence.recordSubconsciousAgentForkToolExecution({
    forkRunId: 'subconscious-fork:run-1:seed',
    executionId: 'sub-tool-1',
    llmRequestSliceId: 'sub-slice-1',
    llmCallId: 'sub-llm-1',
    toolCallId: 'call-subconscious',
    toolName: 'exec_command',
    traceId: 'trace-subconscious',
    runId: 'run-subconscious',
    status: 'completed',
    result: { stdout: 'seed' }
  });

  const slices = await persistence.listLlmRequestSlices({
    identityKey: 'xiaoni',
    sourceKind: 'subconscious_agent_fork',
    forkRunId: 'subconscious-fork:run-1:seed',
    sliceId: 'sub-slice-1',
    limit: 1
  });
  const items = await persistence.listAgentStackItems({
    identityKey: 'xiaoni',
    sourceKind: 'subconscious_agent_fork',
    forkRunId: 'subconscious-fork:run-1:seed',
    llmRequestSliceId: 'sub-slice-1',
    limit: 10
  });
  const tools = await persistence.listToolExecutions({
    identityKey: 'xiaoni',
    sourceKind: 'subconscious_agent_fork',
    forkRunId: 'subconscious-fork:run-1:seed',
    toolCallId: 'call-subconscious',
    limit: 10
  });

  assert.equal(slices[0].sliceId, 'sub-slice-1');
  assert.equal(slices[0].sourceKind, 'subconscious_agent_fork');
  assert.equal(items[0].forkRunId, 'subconscious-fork:run-1:seed');
  assert.equal(tools[0].forkRunId, 'subconscious-fork:run-1:seed');
  assert.ok(sql.calls.some((call) => call.kind === 'query' && call.sql.includes('FROM subconscious_agent_fork_slices')));
  assert.ok(sql.calls.some((call) => call.kind === 'query' && call.sql.includes('FROM subconscious_agent_fork_items')));
  assert.ok(sql.calls.some((call) => call.kind === 'query' && call.sql.includes('FROM subconscious_agent_fork_tool_executions')));
});

test('listToolExecutions supports offset and occurred time filters', async () => {
  const sql = createMockSql();
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  await persistence.listToolExecutions({
    identityKey: 'xiaoni',
    toolName: 'recover_energy',
    occurredAfter: '2026-06-13T06:00:00.000Z',
    occurredBefore: '2026-06-13T09:00:00.000Z',
    limit: 20,
    offset: 40
  });
  const query = sql.calls.find((call) => call.kind === 'query' && call.sql.includes('FROM tool_executions'));

  assert.ok(query);
  assert.match(query.sql, /COALESCE\(started_at, created_at\) >= \?/);
  assert.match(query.sql, /COALESCE\(started_at, created_at\) <= \?/);
  assert.match(query.sql, /LIMIT \? OFFSET \?/);
  assert.deepEqual(query.params, [
    'xiaoni',
    'recover_energy',
    new Date('2026-06-13T06:00:00.000Z'),
    new Date('2026-06-13T09:00:00.000Z'),
    20,
    40
  ]);
});

test('core memory compression fork ledger stores run, slice, items, and tool execution outside main stack', async () => {
  const sql = createMockSql();
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  const run = await persistence.recordCoreMemoryCompressionForkRun({
    forkRunId: 'fork-1',
    contextSessionKey: 'xiaoni:test-global',
    status: 'running',
    traceId: 'trace-1',
    runId: 'run-1',
    readCutoffAfterConversationId: 171,
    previousReadCutoffAfterConversationId: 99,
    metadata: { no_main_stack_persist: true }
  });
  const itemRows = await persistence.appendCoreMemoryCompressionForkItems({
    forkRunId: 'fork-1',
    traceId: 'trace-1',
    runId: 'run-1',
    sourceType: 'core_memory_compression_fork_slices',
    sourceId: 'fork-slice-1',
    llmRequestSliceId: 'fork-slice-1',
    items: [
      { itemKind: 'function_call', role: 'assistant', toolCallId: 'call-1', content: { type: 'function_call' } },
      { itemKind: 'function_call_output', role: 'tool', toolCallId: 'call-1', content: { type: 'function_call_output' } }
    ]
  });
  const slice = await persistence.recordCoreMemoryCompressionForkSlice({
    forkRunId: 'fork-1',
    sliceId: 'fork-slice-1',
    llmCallId: 'llm-fork-1',
    canonicalRequest: { input: [{ role: 'developer' }] },
    canonicalResponse: { output: [{ type: 'function_call', call_id: 'call-1' }] },
    outputItems: [{ type: 'function_call', call_id: 'call-1' }],
    outputStartIndex: 3,
    outputEndIndex: 4,
    status: 'completed',
    tokenUsage: { input_tokens: 18, cached_input_tokens: 6, output_tokens: 3 },
    traceId: 'trace-1',
    runId: 'run-1',
    agentTurn: 1,
    modelName: 'gpt-test'
  });
  const runningTool = await persistence.recordCoreMemoryCompressionForkToolExecution({
    forkRunId: 'fork-1',
    executionId: 'fork-tool-1',
    llmRequestSliceId: 'fork-slice-1',
    llmCallId: 'llm-fork-1',
    toolCallId: 'call-1',
    toolName: 'exec_command',
    arguments: { cmd: 'pwd' },
    rawArguments: '{"cmd":"pwd"}',
    status: 'running',
    sideEffect: true,
    traceId: 'trace-1',
    runId: 'run-1',
    agentTurn: 1,
    stackCallItemId: itemRows[0].id
  });
  const completedTool = await persistence.completeCoreMemoryCompressionForkToolExecution({
    executionId: 'fork-tool-1',
    status: 'completed',
    result: { stdout: '/tmp' },
    stackOutputItemId: itemRows[1].id
  });
  const completedRun = await persistence.completeCoreMemoryCompressionForkRun({
    forkRunId: 'fork-1',
    status: 'completed',
    summaryText: '压缩后的近况',
    artifact: { fork_turn_count: 1 },
    metadata: { fork_tool_call_count: 1 }
  });

  assert.equal(run.forkRunId, 'fork-1');
  assert.equal(run.readCutoffAfterConversationId, '171');
  assert.equal(itemRows.length, 2);
  assert.equal(itemRows[0].itemIndex, 3);
  assert.equal(itemRows[0].forkRunId, 'fork-1');
  assert.equal(slice.forkRunId, 'fork-1');
  assert.equal(slice.outputItems[0].call_id, 'call-1');
  assert.ok(sql.rows.rollupSource.some((row) => row.slice_id === 'fork-slice-1' && row.source_kind === 'compression_fork' && row.fork_run_id === 'fork-1'));
  assert.equal(runningTool.forkRunId, 'fork-1');
  assert.equal(completedTool.stackOutputItemId, itemRows[1].id);
  assert.equal(completedRun.summaryText, '压缩后的近况');
  assert.equal(sql.rows.stackInsert.length, 0);
});

test('findActiveCoreMemoryCompressionForkRun finds a running fork by durable coverage', async () => {
  const sql = createMockSql();
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  await persistence.recordCoreMemoryCompressionForkRun({
    forkRunId: 'fork-active',
    contextSessionKey: 'xiaoni:test-global',
    status: 'running',
    traceId: 'trace-active',
    runId: 'run-active',
    readCutoffAfterConversationId: 171,
    previousReadCutoffAfterConversationId: 99,
    metadata: {
      compression_covered_end_conversation_id: 201
    }
  });

  const active = await persistence.findActiveCoreMemoryCompressionForkRun({
    contextSessionKey: 'xiaoni:test-global',
    compressionCoveredEndConversationId: 201,
    staleAfterMinutes: 30
  });
  const query = sql.calls.find((call) =>
    call.kind === 'query'
    && call.sql.includes('FROM core_memory_compression_fork_runs')
    && call.sql.includes("metadata->>'compression_covered_end_conversation_id'")
  );

  assert.ok(active);
  assert.equal(active.forkRunId, 'fork-active');
  assert.ok(query);
  assert.deepEqual(query.params, ['xiaoni:test-global', '201', '30']);
});

test('attachConversationIdToAgentStackByTrace updates main stack, tools, and fork rows', async () => {
  const sql = createMockSql();
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  const count = await persistence.attachConversationIdToAgentStackByTrace({
    traceId: 'trace-1',
    conversationId: '42'
  });

  assert.equal(count, 15);
  const updates = sql.calls.filter((call) => call.kind === 'execute' && call.sql.includes('UPDATE '));
  assert.equal(updates.length, 15);
  assert.ok(updates.some((call) => call.sql.includes('agent_stack_items')));
  assert.ok(updates.some((call) => call.sql.includes('llm_request_slices')));
  assert.ok(updates.some((call) => call.sql.includes('tool_executions')));
  assert.ok(updates.some((call) => call.sql.includes('core_memory_compression_fork_runs')));
  assert.ok(updates.some((call) => call.sql.includes('core_memory_compression_fork_items')));
  assert.ok(updates.some((call) => call.sql.includes('core_memory_compression_fork_slices')));
  assert.ok(updates.some((call) => call.sql.includes('core_memory_compression_fork_tool_executions')));
  assert.ok(updates.some((call) => call.sql.includes('subconscious_agent_fork_runs')));
  assert.ok(updates.some((call) => call.sql.includes('subconscious_agent_fork_items')));
  assert.ok(updates.some((call) => call.sql.includes('subconscious_agent_fork_slices')));
  assert.ok(updates.some((call) => call.sql.includes('subconscious_agent_fork_tool_executions')));
  assert.ok(updates.some((call) => call.sql.includes('image_vision_fork_runs')));
  assert.ok(updates.some((call) => call.sql.includes('image_vision_fork_items')));
  assert.ok(updates.some((call) => call.sql.includes('image_vision_fork_slices')));
  assert.ok(updates.some((call) => call.sql.includes('codex_provider_usage_events')));
});

function createUsageTimelineSqlMock({ totalCount = 2, pointRows = [], searchRows = [] } = {}) {
  const calls = [];
  return {
    calls,
    execute: async (sql, params = []) => {
      calls.push({ kind: 'execute', sql, params });
      return 1;
    },
    query: async (sql, params = []) => {
      calls.push({ kind: 'query', sql, params });
      if (sql.includes('MIN(created_at) AS first_at') && sql.includes('FROM llm_usage_rollup_sources')) {
        return [{
          first_at: '2026-06-13T00:00:00.000+08:00',
          last_at: '2026-06-13T01:00:00.000+08:00',
          total_count: totalCount
        }];
      }
      if (sql.includes('SELECT initialized_at') && sql.includes('FROM llm_usage_rollup_state')) {
        return [{ initialized_at: '2026-06-13T00:00:00.000+08:00', version: 3 }];
      }
      if (sql.includes('SELECT COUNT(*) AS total_count') && sql.includes('FROM llm_usage_rollup_sources')) {
        return [{ total_count: totalCount }];
      }
      if (sql.includes('AS match_field')) {
        return searchRows;
      }
      if (sql.includes('FROM llm_usage_rollup_sources') || sql.includes('FROM llm_usage_rollups')) {
        return pointRows;
      }
      return [];
    },
    close: async () => {}
  };
}

test('getXiaoniLlmUsageTimeline returns per-call token points with anchors and peaks', async () => {
  const sql = createUsageTimelineSqlMock({
    totalCount: 2,
    pointRows: [
      {
        key: 'slice-1',
        timestamp: '2026-06-13T00:10:00.000+08:00',
        bucket_start: '2026-06-13T00:10:00.000+08:00',
        bucket_end: '2026-06-13T00:10:00.000+08:00',
        call_count: 1,
        input_tokens: 1000,
        cached_tokens: 200,
        output_tokens: 50,
        llm_request_slice_id: 'slice-1',
        llm_call_id: 'llm-1',
        trace_id: 'trace-1',
        top_llm_request_slice_id: 'slice-1',
        top_llm_call_id: 'llm-1',
        top_trace_id: 'trace-1',
        top_timestamp: '2026-06-13T00:10:00.000+08:00',
        top_input_tokens: 1000,
        top_cached_tokens: 200,
        top_output_tokens: 50
      },
      {
        key: 'slice-2',
        timestamp: '2026-06-13T00:20:00.000+08:00',
        bucket_start: '2026-06-13T00:20:00.000+08:00',
        bucket_end: '2026-06-13T00:20:00.000+08:00',
        call_count: 1,
        input_tokens: 400,
        cached_tokens: 100,
        output_tokens: 300,
        llm_request_slice_id: 'slice-2',
        llm_call_id: 'llm-2',
        trace_id: 'trace-2',
        top_llm_request_slice_id: 'slice-2',
        top_llm_call_id: 'llm-2',
        top_trace_id: 'trace-2',
        top_timestamp: '2026-06-13T00:20:00.000+08:00',
        top_input_tokens: 400,
        top_cached_tokens: 100,
        top_output_tokens: 300
      }
    ]
  });
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  const timeline = await persistence.getXiaoniLlmUsageTimeline({
    identityKey: 'xiaoni',
    bucket: 'call',
    maxPoints: 100,
    includePeaks: true
  });

  assert.equal(timeline.bucket, 'call');
  assert.equal(timeline.points.length, 2);
  assert.equal(timeline.points[0].anchorEventId, 'llm-slice:slice-1');
  assert.equal(timeline.summary.inputTokens, 1400);
  assert.equal(timeline.summary.cachedTokens, 300);
  assert.equal(timeline.summary.outputTokens, 350);
  assert.equal(timeline.summary.totalTokens, 1750);
  assert.equal(timeline.summary.cacheRatio, 300 / 1400);
  assert.ok(timeline.peaks.some((peak) => peak.reason === 'largest_input_tokens' && peak.anchorEventId === 'llm-slice:slice-1'));
});

test('getXiaoniLlmUsageTimeline auto-escalates dense call ranges to buckets', async () => {
  const sql = createUsageTimelineSqlMock({
    totalCount: 3000,
    pointRows: [
      {
        key: 'hour:2026-06-13 00:00:00',
        timestamp: '2026-06-13T00:00:00.000+08:00',
        bucket_start: '2026-06-13T00:00:00.000+08:00',
        bucket_end: '2026-06-13T01:00:00.000+08:00',
        call_count: 3000,
        input_tokens: 9000,
        cached_tokens: 3000,
        output_tokens: 1200,
        top_llm_request_slice_id: 'slice-peak',
        top_llm_call_id: 'llm-peak',
        top_trace_id: 'trace-peak',
        top_timestamp: '2026-06-13T00:30:00.000+08:00',
        top_input_tokens: 5000,
        top_cached_tokens: 1000,
        top_output_tokens: 500
      }
    ]
  });
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  const timeline = await persistence.getXiaoniLlmUsageTimeline({
    identityKey: 'xiaoni',
    bucket: 'call',
    maxPoints: 100
  });

  assert.equal(timeline.requestedBucket, 'call');
  assert.equal(timeline.bucket, 'hour');
  assert.equal(timeline.downsampled, true);
  assert.ok(timeline.warnings.includes('call_bucket_too_dense'));
  assert.equal(timeline.points[0].topEvent.eventId, 'llm-slice:slice-peak');
  assert.ok(sql.calls.some((call) => call.kind === 'query' && call.sql.includes('FROM llm_usage_rollups')));
  assert.ok(sql.calls.some((call) => call.kind === 'query' && call.sql.includes('AND bucket = ?') && call.params.includes('hour')));
});

test('getXiaoniLlmUsageTimeline preserves instant offsets in SQL time filters', async () => {
  const sql = createUsageTimelineSqlMock({ totalCount: 1 });
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  await persistence.getXiaoniLlmUsageTimeline({
    identityKey: 'xiaoni',
    bucket: 'call',
    maxPoints: 100,
    startTime: new Date('2026-06-14T01:17:37.945Z'),
    endTime: new Date('2026-06-14T07:17:37.945Z')
  });

  const callPointQuery = sql.calls.find((call) => (
    call.kind === 'query'
    && call.sql.includes('FROM llm_usage_rollup_sources')
    && call.sql.includes('ORDER BY created_at ASC')
  ));
  assert.ok(callPointQuery);
  assert.match(callPointQuery.sql, /created_at >= \?::timestamptz/);
  assert.match(callPointQuery.sql, /created_at <= \?::timestamptz/);
  assert.doesNotMatch(callPointQuery.sql, /created_at >= \?::timestamp(?!tz)/);

  const rollupSql = createUsageTimelineSqlMock({ totalCount: 3000 });
  const rollupPersistence = createXiaoniAgentStackPersistence({ sqlAdapter: rollupSql });
  await rollupPersistence.getXiaoniLlmUsageTimeline({
    identityKey: 'xiaoni',
    bucket: 'call',
    maxPoints: 100,
    startTime: new Date('2026-06-14T01:17:37.945Z'),
    endTime: new Date('2026-06-14T07:17:37.945Z')
  });

  const rollupPointQuery = rollupSql.calls.find((call) => (
    call.kind === 'query'
    && call.sql.includes('FROM llm_usage_rollups')
    && call.sql.includes('ORDER BY bucket_start ASC')
  ));
  assert.ok(rollupPointQuery);
  assert.match(rollupPointQuery.sql, /bucket_end >= \?::timestamptz/);
  assert.match(rollupPointQuery.sql, /bucket_start <= \?::timestamptz/);
  assert.doesNotMatch(rollupPointQuery.sql, /bucket_end >= \?::timestamp(?!tz)/);
});

test('getXiaoniLlmUsageTimeline includes compression fork slices with fork anchors', async () => {
  const sql = createUsageTimelineSqlMock({
    totalCount: 1,
    pointRows: [
      {
        key: 'compression_fork:fork-slice-1',
        timestamp: '2026-06-13T00:10:00.000+08:00',
        bucket_start: '2026-06-13T00:10:00.000+08:00',
        bucket_end: '2026-06-13T00:10:00.000+08:00',
        call_count: 1,
        input_tokens: 1800,
        cached_tokens: 600,
        output_tokens: 90,
        source_kind: 'compression_fork',
        fork_run_id: 'fork-1',
        llm_request_slice_id: 'fork-slice-1',
        llm_call_id: 'llm-fork-1',
        trace_id: 'trace-fork-1',
        top_llm_request_slice_id: 'fork-slice-1',
        top_source_kind: 'compression_fork',
        top_fork_run_id: 'fork-1',
        top_llm_call_id: 'llm-fork-1',
        top_trace_id: 'trace-fork-1',
        top_timestamp: '2026-06-13T00:10:00.000+08:00',
        top_input_tokens: 1800,
        top_cached_tokens: 600,
        top_output_tokens: 90
      }
    ]
  });
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  const timeline = await persistence.getXiaoniLlmUsageTimeline({
    identityKey: 'xiaoni',
    bucket: 'call',
    maxPoints: 100
  });

  assert.equal(timeline.points.length, 1);
  assert.equal(timeline.points[0].sourceKind, 'compression_fork');
  assert.equal(timeline.points[0].forkRunId, 'fork-1');
  assert.equal(timeline.points[0].anchorEventId, 'compression-fork-slice:fork-slice-1');
  assert.equal(timeline.points[0].topEvent.eventId, 'compression-fork-slice:fork-slice-1');
  assert.equal(timeline.summary.inputTokens, 1800);
});

test('getXiaoniLlmUsageTimeline includes image vision fork slices with fork anchors', async () => {
  const sql = createUsageTimelineSqlMock({
    totalCount: 1,
    pointRows: [
      {
        key: 'image_vision_fork:image-slice-1',
        timestamp: '2026-06-13T00:12:00.000+08:00',
        bucket_start: '2026-06-13T00:12:00.000+08:00',
        bucket_end: '2026-06-13T00:12:00.000+08:00',
        call_count: 1,
        input_tokens: 2200,
        cached_tokens: 2100,
        output_tokens: 70,
        source_kind: 'image_vision_fork',
        fork_run_id: 'image-fork-1',
        llm_request_slice_id: 'image-slice-1',
        llm_call_id: 'llm-image-1',
        trace_id: 'trace-image-1',
        top_llm_request_slice_id: 'image-slice-1',
        top_source_kind: 'image_vision_fork',
        top_fork_run_id: 'image-fork-1',
        top_llm_call_id: 'llm-image-1',
        top_trace_id: 'trace-image-1',
        top_timestamp: '2026-06-13T00:12:00.000+08:00',
        top_input_tokens: 2200,
        top_cached_tokens: 2100,
        top_output_tokens: 70
      }
    ]
  });
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  const timeline = await persistence.getXiaoniLlmUsageTimeline({
    identityKey: 'xiaoni',
    bucket: 'call',
    maxPoints: 100
  });

  assert.equal(timeline.points.length, 1);
  assert.equal(timeline.points[0].sourceKind, 'image_vision_fork');
  assert.equal(timeline.points[0].forkRunId, 'image-fork-1');
  assert.equal(timeline.points[0].anchorEventId, 'image-vision-fork-slice:image-slice-1');
  assert.equal(timeline.points[0].topEvent.eventId, 'image-vision-fork-slice:image-slice-1');
  assert.equal(timeline.summary.cachedTokens, 2100);
});

test('getXiaoniLlmUsageTimeline includes Codex Provider image events', async () => {
  const sql = createUsageTimelineSqlMock({
    totalCount: 1,
    pointRows: [
      {
        key: 'image_generation:codex-provider:image-generate-1',
        timestamp: '2026-06-13T00:10:00.000+08:00',
        bucket_start: '2026-06-13T00:10:00.000+08:00',
        bucket_end: '2026-06-13T00:10:00.000+08:00',
        call_count: 1,
        input_tokens: 120,
        cached_tokens: 20,
        output_tokens: 40,
        source_kind: 'image_generation',
        fork_run_id: 'image-run-1',
        llm_request_slice_id: 'codex-provider:image-generate-1',
        llm_call_id: null,
        trace_id: 'trace-image-1',
        top_llm_request_slice_id: 'codex-provider:image-generate-1',
        top_source_kind: 'image_generation',
        top_fork_run_id: 'image-run-1',
        top_llm_call_id: null,
        top_trace_id: 'trace-image-1',
        top_timestamp: '2026-06-13T00:10:00.000+08:00',
        top_input_tokens: 120,
        top_cached_tokens: 20,
        top_output_tokens: 40
      }
    ]
  });
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  const timeline = await persistence.getXiaoniLlmUsageTimeline({
    identityKey: 'xiaoni',
    bucket: 'call',
    maxPoints: 100
  });

  assert.equal(timeline.points.length, 1);
  assert.equal(timeline.points[0].sourceKind, 'image_generation');
  assert.equal(timeline.points[0].forkRunId, 'image-run-1');
  assert.equal(timeline.points[0].anchorEventId, 'codex-provider:image-generate-1');
  assert.equal(timeline.summary.inputTokens, 120);
  assert.equal(timeline.summary.outputTokens, 40);
});

test('getXiaoniLlmUsageTimeline returns search hit overlay points', async () => {
  const sql = createUsageTimelineSqlMock({
    totalCount: 1,
    pointRows: [
      {
        key: 'slice-1',
        timestamp: '2026-06-13T00:10:00.000+08:00',
        bucket_start: '2026-06-13T00:10:00.000+08:00',
        bucket_end: '2026-06-13T00:10:00.000+08:00',
        call_count: 1,
        input_tokens: 1000,
        cached_tokens: 200,
        output_tokens: 50,
        llm_request_slice_id: 'slice-1',
        llm_call_id: 'llm-1',
        trace_id: 'trace-1',
        top_llm_request_slice_id: 'slice-1',
        top_llm_call_id: 'llm-1',
        top_trace_id: 'trace-1',
        top_timestamp: '2026-06-13T00:10:00.000+08:00',
        top_input_tokens: 1000,
        top_cached_tokens: 200,
        top_output_tokens: 50
      }
    ],
    searchRows: [
      {
        llm_request_slice_id: 'slice-1',
        llm_call_id: 'llm-1',
        trace_id: 'trace-1',
        timestamp: '2026-06-13T00:10:00.000+08:00',
        input_tokens: 1000,
        cached_tokens: 200,
        output_tokens: 50,
        match_field: 'wire_response',
        snippet: '{"output":"needle"}'
      }
    ]
  });
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  const timeline = await persistence.getXiaoniLlmUsageTimeline({
    identityKey: 'xiaoni',
    bucket: 'call',
    maxPoints: 100,
    includeOverlays: 'search',
    searchQuery: 'needle'
  });

  assert.equal(timeline.overlays.searchHits.length, 1);
  assert.equal(timeline.overlays.searchHits[0].anchorEventId, 'llm-slice:slice-1');
  assert.equal(timeline.overlays.searchHits[0].field, 'wire_response');
  assert.equal(timeline.overlays.searchHits[0].query, 'needle');
  assert.ok(sql.calls.some((call) => call.kind === 'query' && call.sql.includes('AS match_field') && call.params.includes('%needle%')));
});

test('getXiaoniLlmUsageTimeline searches Codex Provider usage events', async () => {
  const sql = createUsageTimelineSqlMock({
    totalCount: 1,
    pointRows: [
      {
        key: 'image_vision_fork:codex-provider:vision-1',
        timestamp: '2026-06-13T00:10:00.000+08:00',
        bucket_start: '2026-06-13T00:10:00.000+08:00',
        bucket_end: '2026-06-13T00:10:00.000+08:00',
        call_count: 1,
        input_tokens: 33,
        cached_tokens: 12,
        output_tokens: 7,
        source_kind: 'image_vision_fork',
        fork_run_id: 'media-observation-1',
        llm_request_slice_id: 'codex-provider:vision-1',
        trace_id: 'trace-vision',
        top_llm_request_slice_id: 'codex-provider:vision-1',
        top_source_kind: 'image_vision_fork',
        top_fork_run_id: 'media-observation-1',
        top_trace_id: 'trace-vision',
        top_timestamp: '2026-06-13T00:10:00.000+08:00',
        top_input_tokens: 33,
        top_cached_tokens: 12,
        top_output_tokens: 7
      }
    ],
    searchRows: [
      {
        llm_request_slice_id: 'codex-provider:vision-1',
        source_kind: 'image_vision_fork',
        fork_run_id: 'media-observation-1',
        llm_call_id: 'vision-1',
        trace_id: 'trace-vision',
        timestamp: '2026-06-13T00:10:00.000+08:00',
        input_tokens: 33,
        cached_tokens: 12,
        output_tokens: 7,
        match_field: 'canonical_request',
        snippet: '{"content":"image_vision_fork needle"}'
      }
    ]
  });
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: sql });

  const timeline = await persistence.getXiaoniLlmUsageTimeline({
    identityKey: 'xiaoni',
    bucket: 'call',
    maxPoints: 100,
    includeOverlays: 'search',
    searchQuery: 'image_vision_fork'
  });

  assert.equal(timeline.overlays.searchHits.length, 1);
  assert.equal(timeline.overlays.searchHits[0].sourceKind, 'image_vision_fork');
  assert.equal(timeline.overlays.searchHits[0].anchorEventId, 'codex-provider:vision-1');
  assert.ok(sql.calls.some((call) => call.kind === 'query' && call.sql.includes('FROM codex_provider_usage_events')));
});

test('reapOrphanedForkRuns fails every running fork-run row across all three ledgers', async () => {
  const calls = [];
  const adapter = {
    execute: async (sql, params = []) => { calls.push({ kind: 'execute', sql, params }); return 1; },
    query: async (sql, params = []) => {
      calls.push({ kind: 'query', sql, params });
      if (/UPDATE\s+core_memory_compression_fork_runs[\s\S]*RETURNING/i.test(sql)) {
        return [{ fork_run_id: 'cm-zombie-1' }, { fork_run_id: 'cm-zombie-2' }];
      }
      if (/UPDATE\s+subconscious_agent_fork_runs[\s\S]*RETURNING/i.test(sql)) {
        return [{ fork_run_id: 'sub-zombie-1' }];
      }
      if (/UPDATE\s+image_vision_fork_runs[\s\S]*RETURNING/i.test(sql)) {
        return [];
      }
      return [];
    }
  };
  const persistence = createXiaoniAgentStackPersistence({ sqlAdapter: adapter });

  const result = await persistence.reapOrphanedForkRuns({ reason: 'orphaned_on_agent_service_restart' });

  assert.deepEqual(result.coreMemoryCompression, ['cm-zombie-1', 'cm-zombie-2']);
  assert.deepEqual(result.subconscious, ['sub-zombie-1']);
  assert.deepEqual(result.imageVision, []);
  assert.equal(result.total, 3);

  const reapUpdates = calls.filter((call) =>
    call.kind === 'query' && /UPDATE\s+\w+_fork_runs/i.test(call.sql) && /RETURNING/i.test(call.sql));
  assert.equal(reapUpdates.length, 3, 'reaps exactly the three fork-run ledgers');
  for (const update of reapUpdates) {
    assert.match(update.sql, /status = 'failed'/);
    assert.match(update.sql, /WHERE\s+identity_key = \?/);
    assert.match(update.sql, /AND\s+status = 'running'/);
    assert.equal(update.params[update.params.length - 1], 'xiaoni');
  }
});
