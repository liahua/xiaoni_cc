import test from 'node:test';
import assert from 'node:assert/strict';
import { agentConfig } from '../config';
import { AgentLoopService, XIAONI_IDENTITY_KEY, buildInitialInput, buildCanonicalAgentTurnRequest, formatEast8Timestamp } from '../services/agent-loop-service';
import { MissingAgentPromptBindingError, type ResolvedAgentRuntimePrompt } from '../services/agent-prompt-service';

process.env.XIAONI_GLOBAL_PROMPT_CONTEXT_SESSION_KEY = 'xiaoni:test-global';
agentConfig.mainAgentPreModelYieldMs = 0;

// End-to-end regression for the run-boundary prompt-cache breakdown.
//
// Acceptance criterion (user's): the input JSON the provider receives must have a
// byte-identical cacheable prefix across the run boundary. Concretely: every
// runtime_input the FOLDING run actually sent must be reproduced, verbatim and in
// order, by the NEXT run's stack-replay rebuild. If a folded notify is dropped
// from the replay (the bug), the next run's input diverges and the prompt cache
// breaks.
//
// The store below is a faithful in-memory stand-in: appendAgentStackItems honors
// ON CONFLICT(event_id) (content not rewritten), createConversation assigns ids,
// attachConversationIdToTrace COALESCE-backfills rows by trace_id, and
// listAgentStackItemsForConversations feeds the real replay path. No DB, no LLM —
// the model turns and tool result are mocked at the executeAgentTurn / executeTool
// seams.

const EXEC_COMMAND_TOOL = 'exec_command';

function createRuntimePrompt(overrides: Partial<ResolvedAgentRuntimePrompt> = {}): ResolvedAgentRuntimePrompt {
  return {
    source: 'binding',
    promptId: 'prompt-1',
    promptName: 'xiaoni-main',
    modelName: 'claude-opus-4-6',
    systemPrompt: 'You are 小腻.',
    userPromptTemplate: null,
    contextVariables: {},
    runtimeVariables: {},
    parameters: {},
    toolNames: [EXEC_COMMAND_TOOL, 'send_in_group', 'send_in_private'],
    ...overrides
  } as ResolvedAgentRuntimePrompt;
}

function baseQueuePayload(overrides: Record<string, unknown> = {}) {
  return {
    traceId: 'runtrace-A',
    runId: 'run-A',
    batchId: 'batch-A',
    source: 'phone_notification',
    chatType: 'group',
    sessionKey: 'qq:group:101',
    peerId: '101',
    peerName: 'Test Group',
    senderId: '202',
    senderName: 'Alice',
    accountId: '303',
    bodyForAgent: '群里有人找你',
    rawBody: '群里有人找你',
    commandBody: '',
    wasMentioned: true,
    receivedAt: '2026-06-29T08:00:00.000Z',
    messageTimestamp: '2026-06-29T08:00:00.000Z',
    rawPayload: {},
    inboundContext: {},
    phoneNotification: {
      app: 'qq',
      notificationId: 'phone:A',
      sessionKey: 'qq:group:101',
      chatType: 'group',
      peerId: '101',
      peerName: 'Test Group',
      unreadDelta: 1,
      directMentions: 0,
      latestReceivedAt: '2026-06-29T08:00:00.000Z',
      reason: 'group_phone_notification'
    },
    messages: [{
      queueMessageId: 1,
      traceId: 'runtrace-A',
      source: 'napcat',
      messageId: 11,
      messageSid: 'sid-A',
      chatType: 'group',
      sessionKey: 'qq:group:101',
      peerId: '101',
      peerName: 'Test Group',
      senderId: '202',
      senderName: 'Alice',
      accountId: '303',
      bodyForAgent: '群里有人找你',
      rawBody: '群里有人找你',
      commandBody: '',
      wasMentioned: true,
      receivedAt: '2026-06-29T08:00:00.000Z',
      messageTimestamp: '2026-06-29T08:00:00.000Z',
      rawPayload: {},
      inboundContext: {}
    }],
    ...overrides
  };
}

// A folded notify, as foldPendingNotifyIntoRun would return it: keyed to the PARENT
// run id, carrying its OWN trace_id. Modeled as a plain inbound QQ batch (a real
// message arriving mid-run) so its rendered text is a controllable string we can
// assert on byte-for-byte. The event_id collision the fix addresses is on ALL
// runtime_input folds, not just phone_notifications.
function foldedNotify(parentRunId: string, parentBatchId: string, ownTraceId: string, reminder: string) {
  const innerMessage = {
    queueMessageId: 99,
    traceId: ownTraceId,
    source: 'napcat',
    messageId: 99,
    messageSid: ownTraceId,
    chatType: 'group',
    sessionKey: 'qq:group:101',
    peerId: '101',
    peerName: 'Test Group',
    senderId: '202',
    senderName: 'Alice',
    accountId: '303',
    bodyForAgent: reminder,
    rawBody: reminder,
    commandBody: '',
    wasMentioned: false,
    receivedAt: '2026-06-29T08:00:05.000Z',
    messageTimestamp: '2026-06-29T08:00:05.000Z',
    rawPayload: {},
    inboundContext: {}
  };
  return {
    id: parentRunId,
    traceId: ownTraceId,
    batchId: parentBatchId,
    status: 'consumed',
    attempts: 1,
    createdAt: '2026-06-29T08:00:05.000Z',
    queueMessageIds: [Number(ownTraceId.replace(/\D/g, '') || '0')],
    payload: baseQueuePayload({
      traceId: ownTraceId,
      runId: parentRunId,
      batchId: parentBatchId,
      source: 'napcat',
      phoneNotification: undefined,
      bodyForAgent: reminder,
      rawBody: reminder,
      messages: [innerMessage]
    })
  };
}

// Faithful in-memory store: stack with ON CONFLICT(event_id) dedup + conversation
// grouping + trace-keyed COALESCE backfill, plus the read paths replay needs.
function createFaithfulStore(opts: { foldsToServe: Array<ReturnType<typeof foldedNotify>> }) {
  const stack: Array<Record<string, unknown>> = [];
  let stackIndex = 0;
  let conversationSeq = 5000;
  const conversations: Array<{ id: number; traceId: string }> = [];
  const folds = [...opts.foldsToServe];
  const calls: Record<string, any[]> = { appendAgentStackItems: [], attachConversationIdToTrace: [], createConversation: [], failQueueMessage: [], retryQueueMessage: [] };

  const store: any = {
    createLlmJob: async () => 'job-A',
    logTimelineEvent: async () => {},
    listRecentTurns: async () => conversations.map((conv) => ({
      id: conv.id,
      userMessage: '',
      aiResponse: null,
      createdAt: '2026-06-29T08:00:00.000Z'
    })),
    getSessionReadCutoffState: async () => null,
    upsertSessionReadCutoffState: async () => {},
    upsertProactiveShareState: async () => {},
    recordRuntimeIdentityActivation: async () => {},
    getExecutionLeaseDeliveryState: async () => ({
      deliveryPhase: 'idle',
      deliveryCommitCount: 0,
      blockedDeliveryAttemptCount: 0,
      lastBlockedDeliveryReason: null
    }),
    markLeaseVisibleDeliveryCommitted: async () => {},
    markLeaseDeliveryBlocked: async () => {},
    completeAgentStackToolExecution: async () => {},
    getAgentStackHead: async () => stackIndex,
    updateLlmRequestSliceStackLinks: async () => null,
    // The fold seam: serve one queued notify per call until exhausted.
    foldPendingNotifyIntoRun: async () => folds.shift() || null,
    appendAgentStackItems: async (params: any) => {
      calls.appendAgentStackItems.push(params);
      const out: Array<Record<string, unknown>> = [];
      for (const item of params.items || []) {
        const eventId = item.eventId || item.event_id;
        const existing = stack.find((row) => row.event_id === eventId);
        if (existing) {
          // ON CONFLICT(event_id) DO UPDATE SET updated_at -> content NOT rewritten.
          out.push(existing);
          continue;
        }
        stackIndex += 1;
        const row: Record<string, unknown> = {
          id: `stack-${stackIndex}`,
          event_id: eventId,
          identity_key: params.identityKey || XIAONI_IDENTITY_KEY,
          stack_index: stackIndex,
          stackIndex,
          item_kind: item.itemKind,
          itemKind: item.itemKind,
          role: item.role || null,
          tool_call_id: item.toolCallId || null,
          toolCallId: item.toolCallId || null,
          content: item.content,
          visibility: item.visibility || 'model_visible',
          source_type: params.sourceType || null,
          source_id: params.sourceId || null,
          trace_id: item.traceId || params.traceId || null,
          run_id: item.runId || params.runId || null,
          conversation_id: null
        };
        stack.push(row);
        out.push(row);
      }
      return out;
    },
    // Stack-native flat range read (the production replay path): blocks with
    // stack_index > afterStackIndex, in stack order. This is what loadStackHistoryBlocks
    // consumes — no conversation grouping.
    listAgentStackItems: async (params: any) => {
      const after = params.afterStackIndex ?? params.after_stack_index ?? null;
      const floor = after === null || typeof after === 'undefined' ? -Infinity : Number(after);
      const rows = stack
        .filter((row) => Number(row.stack_index) > floor)
        .map((row) => ({ ...row }));
      rows.sort((a, b) => Number(a.stack_index) - Number(b.stack_index));
      return params.chronological === false ? rows.reverse() : rows;
    },
    createConversation: async (params: any) => {
      calls.createConversation.push(params);
      conversationSeq += 1;
      conversations.push({ id: conversationSeq, traceId: params.traceId });
      return conversationSeq;
    },
    // COALESCE(conversation_id, ?) WHERE trace_id = ?  (first-write-wins).
    attachConversationIdToTrace: async (traceId: string, conversationId: number) => {
      calls.attachConversationIdToTrace.push({ traceId, conversationId });
      for (const row of stack) {
        if (row.trace_id === traceId && (row.conversation_id === null || row.conversation_id === undefined)) {
          row.conversation_id = conversationId;
        }
      }
    },
    settleQueueMessages: async () => {},
    failQueueMessage: async (runId: string, message: string, conversationId: number) => {
      calls.failQueueMessage.push({ runId, message, conversationId });
    },
    retryQueueMessage: async (runId: string, params: any) => {
      calls.retryQueueMessage.push({ runId, params });
      return 1;
    },
    releaseExecutionLease: async () => {},
    updateLlmJob: async () => {}
  };

  return { store, stack, calls, conversations };
}

test('next run replay reproduces every folded notify the folding run sent (cache prefix consistency)', async () => {
  const fold1Trace = 'runtrace-fold-1';
  const fold2Trace = 'runtrace-fold-2';
  const reminder1 = '【视线边缘】又堆积了 1 条新动静：阿花说做图修好了';
  const reminder2 = '【视线边缘】又堆积了 2 条新动静：群里 @了你';

  const { store, stack, calls } = createFaithfulStore({
    foldsToServe: [
      foldedNotify('run-A', 'batch-A', fold1Trace, reminder1),
      foldedNotify('run-A', 'batch-A', fold2Trace, reminder2)
    ]
  });

  const service = new AgentLoopService(store, {
    resolveForQueueMessage: async () => createRuntimePrompt()
  } as any);

  // Mock the tool execution seam so tool-call turns don't hit the network.
  (service as any).executeTool = async () => ({
    success: true,
    output: 'ok',
    message_type: 'tool_result'
  });

  // Capture the input JSON sent to the provider on every turn.
  const sentInputs: any[][] = [];
  let turn = 0;
  (service as any).executeAgentTurn = async (canonicalRequest: any) => {
    sentInputs.push(canonicalRequest.input || []);
    turn += 1;
    // Turns 1 and 2 are tool calls: each yields without a lease release, so the
    // loop folds a pending notify between turns (this is exactly how the two
    // reminders entered the folding run's request live).
    if (turn <= 2) {
      return {
        success: true,
        llm_call_id: `llm-A-${turn}`,
        llm_request_slice_id: `slice-A-${turn}`,
        canonical_response: {
          output: [{
            type: 'function_call',
            call_id: `call-A-${turn}`,
            name: EXEC_COMMAND_TOOL,
            arguments: JSON.stringify({ cmd: `echo turn-${turn}` })
          }]
        }
      };
    }
    // Turn 3: final answer ends the run.
    return {
      success: true,
      llm_call_id: `llm-A-${turn}`,
      llm_request_slice_id: `slice-A-${turn}`,
      canonical_response: {
        output: [{
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: '好的我看到了。' }]
        }]
      }
    };
  };

  const queueMessage = {
    id: 'run-A',
    traceId: 'runtrace-A',
    batchId: 'batch-A',
    status: 'processing',
    attempts: 1,
    createdAt: '2026-06-29T08:00:00.000Z',
    queueMessageIds: [1],
    payload: baseQueuePayload()
  };

  await (service as any).processRuntimeFrame(queueMessage, { queueBacked: true });

  // --- What the folding run actually SENT to the provider ---
  const lastSent = sentInputs[sentInputs.length - 1];
  const sentText = JSON.stringify(lastSent);
  assert.ok(sentText.includes(reminder1), 'folding run must have sent reminder 1 live');
  assert.ok(sentText.includes(reminder2), 'folding run must have sent reminder 2 live');

  // --- The ledger persisted BOTH folds as distinct rows (not collapsed) ---
  const runtimeInputs = stack.filter((row) => row.item_kind === 'runtime_input');
  const persistedReminders = JSON.stringify(runtimeInputs.map((row) => row.content));
  assert.ok(persistedReminders.includes(reminder1), 'fold 1 must be persisted, not dropped by ON CONFLICT');
  assert.ok(persistedReminders.includes(reminder2), 'fold 2 must be persisted, not dropped by ON CONFLICT');
  // Each fold has its own distinct event_id (the fix).
  const eventIds = runtimeInputs.map((row) => row.event_id);
  assert.equal(new Set(eventIds).size, eventIds.length, 'every runtime_input must have a unique event_id');

  // --- What the NEXT run's STACK-NATIVE replay REBUILDS (flat stack range, no cutoff) ---
  // Production reads the flat stack via loadStackHistoryBlocks(cutoff). With no cutoff the
  // whole tail replays; the assembled per-block replay items must reproduce BOTH folds.
  const replayed = await (service as any).loadStackHistoryBlocks(null, 'runtrace-B');
  const replayText = JSON.stringify(replayed.flatMap((b: any) => b.stackReplayItems || []));
  // The acceptance criterion: the next run's rebuilt input reproduces BOTH folds.
  assert.ok(replayText.includes(reminder1), 'replay must reproduce folded reminder 1 (else cache prefix diverges)');
  assert.ok(replayText.includes(reminder2), 'replay must reproduce folded reminder 2 (else cache prefix diverges)');
});

// Drives a folding run whose provider throws on the turn AFTER the fold, then
// returns the captured store calls. errorMessage decides transient vs terminal.
async function runFoldingRunThatFails(errorMessage: string) {
  const foldTrace = 'runtrace-fold-fail';
  const reminder = '【掉线前】又有 1 条新动静：阿花在等你回';
  const built = createFaithfulStore({
    foldsToServe: [foldedNotify('run-A', 'batch-A', foldTrace, reminder)]
  });
  const service = new AgentLoopService(built.store, {
    resolveForQueueMessage: async () => createRuntimePrompt()
  } as any);
  (service as any).executeTool = async () => ({ success: true, output: 'ok', message_type: 'tool_result' });

  let turn = 0;
  (service as any).executeAgentTurn = async () => {
    turn += 1;
    if (turn === 1) {
      return {
        success: true,
        llm_call_id: 'llm-A-1',
        llm_request_slice_id: 'slice-A-1',
        canonical_response: {
          output: [{ type: 'function_call', call_id: 'call-A-1', name: EXEC_COMMAND_TOOL, arguments: '{"cmd":"echo 1"}' }]
        }
      };
    }
    throw new Error(errorMessage); // turn 2: provider blows up AFTER the fold
  };

  const queueMessage = {
    id: 'run-A',
    traceId: 'runtrace-A',
    batchId: 'batch-A',
    status: 'processing',
    attempts: 1,
    maxAttempts: 3,
    queueMessageIds: [1],
    createdAt: '2026-06-29T08:00:00.000Z',
    payload: baseQueuePayload()
  };
  await (service as any).processRuntimeFrame(queueMessage, { queueBacked: true });
  return { ...built, foldTrace, reminder };
}

test('provider TERMINAL failure: folded notify is backfilled to the failed conversation (replay stays consistent)', async () => {
  // A non-transient error message (no network/timeout keywords) -> terminal failure.
  const { calls, stack, foldTrace } = await runFoldingRunThatFails('模型返回了不可恢复的错误');

  // Terminal failure -> the run is failed, not retried.
  assert.equal(calls.retryQueueMessage.length, 0, 'terminal failure must not schedule a retry');
  assert.equal(calls.failQueueMessage.length, 1, 'terminal failure must fail the queue message');

  // The fold's stack row is persisted, so replay reproduces it via stack_index
  // (the external conversation_id backfill was removed; replay no longer keys on it).
  const foldRow = stack.find((row) => row.trace_id === foldTrace && row.item_kind === 'runtime_input');
  assert.ok(foldRow, 'the folded notify must have been persisted');
});

test('provider TRANSIENT failure: folded notify stays NULL for the retry self-heal (no premature pin)', async () => {
  // A transient error message -> retry-eligible (attempts 1 < maxAttempts 3).
  const { calls, stack, foldTrace } = await runFoldingRunThatFails('fetch failed: socket timeout');

  // Transient failure -> a retry is scheduled, the queue message is NOT failed.
  assert.equal(calls.retryQueueMessage.length, 1, 'transient failure must schedule a retry');
  assert.equal(calls.failQueueMessage.length, 0, 'transient failure must not fail the queue message');

  // The fold's trace must NOT be backfilled to the failed conversation: COALESCE is
  // first-write-wins, so pinning it now would block the retry's success-settle from
  // attaching it to the real conversation. It stays NULL and rides the reprocess.
  const backfilledFoldTrace = calls.attachConversationIdToTrace.some((c: any) => c.traceId === foldTrace);
  assert.equal(backfilledFoldTrace, false, 'transient retry must NOT pin the fold to the failed conversation');
  const foldRow = stack.find((row) => row.trace_id === foldTrace && row.item_kind === 'runtime_input');
  assert.ok(foldRow, 'the folded notify must still be persisted');
  assert.equal(foldRow!.conversation_id, null, 'the folded notify must stay NULL for the retry self-heal');
});

// A terminal failure must always fire failQueueMessage so the run is marked failed
// (never left as a locked, never-retried orphan). The old conversation_id fold-backfill
// was removed with the stack-native migration (replay reproduces folds via stack_index),
// so the terminal path now just fails cleanly.
test('provider TERMINAL failure: the run is marked failed (failQueueMessage still fires)', async () => {
  const { calls } = await runFoldingRunThatFails('模型返回了不可恢复的错误');
  assert.equal(calls.failQueueMessage.length, 1, 'terminal failure must fire failQueueMessage — the run must be marked failed');
  assert.equal(calls.retryQueueMessage.length, 0, 'still a terminal failure — no retry');
});

// --- #1 + #2: main loop driven with type:text outputs + within-run prefix continuity ---
//
// The durable (non-cache_volatile) prefix of every provider request in a run must be
// an exact ordered prefix of the next turn's durable prefix — the warm cache only ever
// EXTENDS, it never diverges. This is the main loop's own 0-tolerance cache invariant.
// The run includes a turn where the model returns a type:text assistant output (a real
// production scenario) to prove text outputs don't perturb the cacheable prefix.

function stripVolatile(input: any[]) {
  return (input || []).filter((item) => !item || (item as any).cache_volatile !== true);
}

// Assert seqA is an exact ordered prefix of seqB (byte-identical, item by item).
function assertOrderedPrefix(seqA: any[], seqB: any[], label: string) {
  assert.ok(seqB.length >= seqA.length, `${label}: prefix must not shrink (${seqB.length} < ${seqA.length})`);
  for (let i = 0; i < seqA.length; i += 1) {
    assert.equal(
      JSON.stringify(seqB[i]),
      JSON.stringify(seqA[i]),
      `${label}: durable item ${i} diverged — cache prefix is not byte-identical`
    );
  }
}

test('main loop: durable prefix is byte-identical and monotonically extends across turns (incl. a type:text turn)', async () => {
  const { store } = createFaithfulStore({ foldsToServe: [] });
  const service = new AgentLoopService(store, {
    resolveForQueueMessage: async () => createRuntimePrompt()
  } as any);
  (service as any).executeTool = async () => ({ success: true, output: 'ok', message_type: 'tool_result' });

  const sentInputs: any[][] = [];
  const modelOutputsByTurn: string[] = [];
  let turn = 0;
  (service as any).executeAgentTurn = async (canonicalRequest: any) => {
    sentInputs.push(canonicalRequest.input || []);
    turn += 1;
    if (turn === 1) {
      // PRODUCTION SCENARIO: model returns a plain type:text assistant output (narration).
      modelOutputsByTurn.push('text');
      return {
        success: true, llm_call_id: 'llm-1', llm_request_slice_id: 'slice-1',
        canonical_response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我先想想怎么接。' }] }] }
      };
    }
    if (turn === 2 || turn === 3) {
      modelOutputsByTurn.push('tool');
      return {
        success: true, llm_call_id: `llm-${turn}`, llm_request_slice_id: `slice-${turn}`,
        canonical_response: { output: [{ type: 'function_call', call_id: `call-${turn}`, name: EXEC_COMMAND_TOOL, arguments: `{"cmd":"echo ${turn}"}` }] }
      };
    }
    modelOutputsByTurn.push('final');
    return {
      success: true, llm_call_id: `llm-${turn}`, llm_request_slice_id: `slice-${turn}`,
      canonical_response: { output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '好了。' }] }] }
    };
  };

  const queueMessage = {
    id: 'run-A', traceId: 'runtrace-A', batchId: 'batch-A', status: 'processing',
    attempts: 1, maxAttempts: 3, queueMessageIds: [1], createdAt: '2026-06-29T08:00:00.000Z',
    payload: baseQueuePayload()
  };
  await (service as any).processRuntimeFrame(queueMessage, { queueBacked: true });

  // The type:text scenario actually ran as turn 1, and the loop continued past it.
  assert.equal(modelOutputsByTurn[0], 'text', 'turn 1 must have exercised a type:text output');
  assert.ok(sentInputs.length >= 3, `expected a multi-turn run, got ${sentInputs.length} turns`);

  // 0-tolerance: every turn's durable prefix is an exact ordered prefix of the next.
  for (let i = 0; i + 1 < sentInputs.length; i += 1) {
    assertOrderedPrefix(stripVolatile(sentInputs[i]), stripVolatile(sentInputs[i + 1]), `turn ${i + 1}->${i + 2}`);
  }

  // The volatile current-turn trigger is the ONLY thing allowed to vary turn to turn:
  // it must be tagged cache_volatile so it never anchors the cached prefix.
  for (let i = 0; i < sentInputs.length; i += 1) {
    const volatileItems = (sentInputs[i] || []).filter((item: any) => item && item.cache_volatile === true);
    assert.ok(volatileItems.length >= 1, `turn ${i + 1}: the current-turn trigger must be tagged cache_volatile`);
  }
});

// --- #3: time-drift. The cacheable prefix must be byte-identical across a wall-clock
// change. Any re-rendered timestamp (new Date()) that leaks into the durable prefix
// (system instructions, tools, or non-volatile input) drifts the cached body at every
// run/heartbeat boundary -> cache miss. Patch the global clock, rebuild, compare.
const RealDate = Date;
function patchClock(iso: string) {
  const fixed = new RealDate(iso).getTime();
  class FakeDate extends RealDate {
    constructor(...args: any[]) { super(...((args.length ? args : [fixed]) as [])); }
    static now() { return fixed; }
  }
  (globalThis as any).Date = FakeDate;
}
function restoreClock() { (globalThis as any).Date = RealDate; }

test('main request: cacheable prefix (system + tools + durable input) is byte-identical across wall-clock change', () => {
  try {
    patchClock('2026-06-29T10:00:00+08:00');
    const morningStamp = formatEast8Timestamp();
    const reqMorning = buildCanonicalAgentTurnRequest(agentConfig.modelName, buildInitialInput([], baseQueuePayload() as any), 'group');

    patchClock('2026-06-29T23:45:00+08:00');
    const nightStamp = formatEast8Timestamp();
    const reqNight = buildCanonicalAgentTurnRequest(agentConfig.modelName, buildInitialInput([], baseQueuePayload() as any), 'group');

    // Sanity: the clock patch is effective (otherwise the test would be vacuous).
    assert.notEqual(morningStamp, nightStamp, 'clock patch must change the wall-clock stamp');

    // System prompt tier — the largest cached prefix — must be time-free.
    assert.equal(JSON.stringify(reqMorning.instructions), JSON.stringify(reqNight.instructions), 'system instructions must not carry a wall-clock stamp');
    assert.equal(JSON.stringify(reqMorning.tools), JSON.stringify(reqNight.tools), 'tools must not carry a wall-clock stamp');
    // Durable (non-cache_volatile) input must be byte-identical both directions == equal.
    assertOrderedPrefix(stripVolatile(reqMorning.input), stripVolatile(reqNight.input), 'time-drift fwd');
    assertOrderedPrefix(stripVolatile(reqNight.input), stripVolatile(reqMorning.input), 'time-drift rev');
  } finally {
    restoreClock();
  }
});

// --- compression fork FULL trigger->dispatch e2e ---
// Calls the REAL runCoreMemoryCompressionFork with the baseRequest the main loop
// passes (buildMainAgentCanonicalRequest(prompt, requestInput, payload) @ 6302),
// captures the request actually handed to the provider seam
// (executeCoreMemoryCompressionForkTurn), and asserts its prefix is byte-identical
// to the main request. This catches the wiring class of bug the compression fork
// historically had: a head-only baseRequest that cold-prefilled a separate request
// instead of riding the main loop's warm cache.
test('compression fork dispatch: real runCoreMemoryCompressionFork sends a byte-identical prefix + reminder tail', async () => {
  const { store } = createFaithfulStore({ foldsToServe: [] });
  const service = new AgentLoopService(store, {
    resolveForQueueMessage: async () => createRuntimePrompt()
  } as any);
  (service as any).recordCoreMemoryCompressionForkRunSafe = async () => {};

  // Production-shaped main request (what the main loop passes as baseRequest): user
  // message, assistant type:text output, a tool pair, and a system_reminder.
  const mainInput = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '群里在聊桌游' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我看看他们聊到哪了。' }] },
    { type: 'function_call', call_id: 'c1', name: EXEC_COMMAND_TOOL, arguments: '{"cmd":"ls"}' },
    { type: 'function_call_output', call_id: 'c1', output: 'notes.md' },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<system_reminder>x</system_reminder>' }] }
  ] as any[];
  const baseRequest = buildCanonicalAgentTurnRequest(agentConfig.modelName, mainInput, 'group');
  const baseSnapshot = JSON.stringify(baseRequest.input);
  const reminderTail = [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<compress>把旧上下文压缩成近况</compress>' }] }] as any[];

  let captured: any = null;
  (service as any).executeCoreMemoryCompressionForkTurn = async (forkRequest: any) => {
    captured = forkRequest;
    throw new Error('__CAPTURED_FORK__');
  };

  await assert.rejects(() => (service as any).runCoreMemoryCompressionFork({
    baseRequest,
    queueMessage: baseQueuePayload(),
    runtimePrompt: createRuntimePrompt(),
    compression: {
      contextSessionKey: 'xiaoni:test-global',
      readCutoffAfterStackIndex: 5,
      previousReadCutoffAfterStackIndex: null,
      compressionCoveredEndStackIndex: 5
    },
    contextSessionKey: 'xiaoni:test-global',
    compressionReminderItems: reminderTail,
    bypassRuntimeEnabledGate: true
  }), /__CAPTURED_FORK__/);

  assert.ok(captured, 'the compression fork must have dispatched a model turn');
  // 0-tolerance: the dispatched fork's cloned prefix is byte-identical to the main request.
  assert.equal(
    JSON.stringify(captured.input.slice(0, baseRequest.input.length)),
    baseSnapshot,
    'compression fork dispatched prefix must equal the main request (NOT head-only)'
  );
  assert.deepEqual(captured.instructions, baseRequest.instructions, 'system instructions must match the main loop');
  assert.deepEqual(captured.tools, baseRequest.tools, 'tools must match the main loop');
  assert.deepEqual(captured.tool_choice, baseRequest.tool_choice, 'tool_choice must match the main loop');
  // The compression instruction rides as the tail, not spliced into the prefix.
  const tail = captured.input.slice(baseRequest.input.length);
  assert.ok(JSON.stringify(tail).includes('把旧上下文压缩成近况'), 'compression reminder must ride as a cold tail');
  // Building the fork must not mutate the base request the main turn reuses.
  assert.equal(JSON.stringify(baseRequest.input), baseSnapshot, 'fork dispatch must not mutate the base request');
});

// =====================================================================================
// REAL-Postgres runtime replay e2e.
//
// In production the main agent rebuilds history by reading agent_stack_items FROM the
// database. So the truest test of the cache-prefix invariant drives processRuntimeFrame
// against a REAL Postgres: the fold path appends rows to the DB, settle backfills their
// conversation id by trace, and the replay read (listAgentStackItemsForConversations)
// reconstructs history from the DB — exactly the production path. This also exercises
// the real UNIQUE(event_id) + ON CONFLICT, so it validates the event_id fix end to end.
//
// Isolated throwaway DB (qqbot_cache_test); never touches qqbot_db. Skips if no DB.
// =====================================================================================
// eslint-disable-next-line @typescript-eslint/no-var-requires
const persistencePkg: any = require('@qq-bot/persistence');

const REALDB_HOST = process.env.DB_HOST || 'localhost';
const REALDB_PORT = process.env.DB_PORT || '5432';
const REALDB_USER = process.env.DB_USER || 'qqbot_user';
const REALDB_PW = process.env.DB_PASSWORD || 'qqbot_password';
const REALDB_NAME = 'qqbot_cache_test';
const REALDB_URL = process.env.CACHE_TEST_DATABASE_URL
  || `postgresql://${REALDB_USER}:${REALDB_PW}@${REALDB_HOST}:${REALDB_PORT}/${REALDB_NAME}`;
const REALDB_ADMIN_URL = `postgresql://${REALDB_USER}:${REALDB_PW}@${REALDB_HOST}:${REALDB_PORT}/postgres`;

let realSql: any = null;
let realPersistence: any = null;
let realDbReady = false;

test.before(async () => {
  try {
    const admin = persistencePkg.createSqlAdapter({ databaseUrl: REALDB_ADMIN_URL });
    try {
      if (!(await admin.testConnection())) throw new Error('no maintenance DB');
      const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = ?', [REALDB_NAME]);
      if (existing.length === 0) await admin.execute(`CREATE DATABASE ${REALDB_NAME}`, []);
    } finally {
      await admin.close().catch(() => {});
    }
    realSql = persistencePkg.createSqlAdapter({ databaseUrl: REALDB_URL });
    if (!(await realSql.testConnection())) throw new Error('testConnection false');
    realPersistence = persistencePkg.createXiaoniAgentStackPersistence({ sqlAdapter: realSql });
    await realPersistence.ensureXiaoniAgentStackSchema();
    realDbReady = true;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.log(`[skip] runtime real-DB replay e2e: ${error instanceof Error ? error.message : String(error)}`);
    realDbReady = false;
  }
});

test.after(async () => {
  if (realSql) await realSql.close().catch(() => {});
});

// A store whose STACK methods hit real Postgres (mirroring RuntimeStore's wrappers),
// everything else mocked. The cache-critical append/backfill/replay-read path is real.
function createDbBackedStore() {
  const conversations: Array<{ id: number; traceId: string }> = [];
  let conversationSeq = 9000;
  return {
    createLlmJob: async () => 'job-realdb',
    logTimelineEvent: async () => {},
    listRecentTurns: async () => conversations.map((c) => ({ id: c.id, userMessage: '', aiResponse: null, createdAt: '2026-06-29T08:00:00.000Z' })),
    getSessionReadCutoffState: async () => null,
    upsertSessionReadCutoffState: async () => {},
    upsertProactiveShareState: async () => {},
    recordRuntimeIdentityActivation: async () => {},
    getExecutionLeaseDeliveryState: async () => ({ deliveryPhase: 'idle', deliveryCommitCount: 0, blockedDeliveryAttemptCount: 0, lastBlockedDeliveryReason: null }),
    markLeaseVisibleDeliveryCommitted: async () => {},
    markLeaseDeliveryBlocked: async () => {},
    completeAgentStackToolExecution: async () => {},
    recordAgentStackToolExecution: async () => {},
    updateLlmRequestSliceStackLinks: async () => null,
    foldPendingNotifyIntoRun: (() => {
      const folds: any[] = [
        foldedNotify('run-RDB', 'batch-RDB', 'runtrace-rdb-fold-1', '【实库】又堆积了 1 条新动静：阿花修好了做图'),
        foldedNotify('run-RDB', 'batch-RDB', 'runtrace-rdb-fold-2', '【实库】又堆积了 2 条新动静：群里 @了你')
      ];
      return async () => folds.shift() || null;
    })(),
    // --- the stack methods delegate to REAL Postgres (mirror RuntimeStore) ---
    appendAgentStackItems: async (params: any) => realPersistence.appendAgentStackItems({ identityKey: 'xiaoni', ...params }),
    // Stack-native flat range read against real PG — the production replay path.
    listAgentStackItems: async (params: any) => realPersistence.listAgentStackItems({ identityKey: 'xiaoni', ...params }),
    listAgentStackItemsForConversations: async (params: any) => realPersistence.listAgentStackItemsForConversations({ identityKey: 'xiaoni', ...params }),
    attachConversationIdToTrace: async (traceId: string, conversationId: number) =>
      realPersistence.attachConversationIdToAgentStackByTrace({ traceId, conversationId }),
    getAgentStackHead: async () => realPersistence.getAgentStackHead({ identityKey: 'xiaoni' }),
    createConversation: async (params: any) => { conversationSeq += 1; conversations.push({ id: conversationSeq, traceId: params.traceId }); return conversationSeq; },
    settleQueueMessages: async () => {},
    failQueueMessage: async () => {},
    retryQueueMessage: async () => 1,
    releaseExecutionLease: async () => {},
    updateLlmJob: async () => {},
    __conversations: conversations
  } as any;
}

test('runtime replay from REAL Postgres reproduces every folded notify (production DB path)', async (t) => {
  if (!realDbReady) { t.skip('real cache test DB unavailable'); return; }
  await realSql.execute('TRUNCATE agent_stack_items RESTART IDENTITY', []);

  const store = createDbBackedStore();
  const service = new AgentLoopService(store, { resolveForQueueMessage: async () => createRuntimePrompt() } as any);
  (service as any).executeTool = async () => ({ success: true, output: 'ok', message_type: 'tool_result' });

  let turn = 0;
  (service as any).executeAgentTurn = async () => {
    turn += 1;
    if (turn <= 2) {
      return { success: true, llm_call_id: `llm-rdb-${turn}`, llm_request_slice_id: `slice-rdb-${turn}`,
        canonical_response: { output: [{ type: 'function_call', call_id: `call-rdb-${turn}`, name: EXEC_COMMAND_TOOL, arguments: `{"cmd":"echo ${turn}"}` }] } };
    }
    return { success: true, llm_call_id: `llm-rdb-${turn}`, llm_request_slice_id: `slice-rdb-${turn}`,
      canonical_response: { output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '好。' }] }] } };
  };

  const queueMessage = {
    id: 'run-RDB', traceId: 'runtrace-RDB', batchId: 'batch-RDB', status: 'processing',
    attempts: 1, maxAttempts: 3, queueMessageIds: [1], createdAt: '2026-06-29T08:00:00.000Z',
    payload: baseQueuePayload({ traceId: 'runtrace-RDB', runId: 'run-RDB', batchId: 'batch-RDB' })
  };
  await (service as any).processRuntimeFrame(queueMessage, { queueBacked: true });

  // Replay EXACTLY as production does: read agent_stack_items from Postgres as a flat
  // stack range (no cutoff → whole tail) via loadStackHistoryBlocks — no conversation grouping.
  const replayed = await (service as any).loadStackHistoryBlocks(null, 'runtrace-REPLAY');
  const replayText = JSON.stringify(replayed.flatMap((b: any) => b.stackReplayItems || []));
  assert.ok(replayText.includes('阿花修好了做图'), 'DB replay must reproduce folded reminder 1');
  assert.ok(replayText.includes('群里 @了你'), 'DB replay must reproduce folded reminder 2');

  // And the underlying rows: both folds persisted with distinct event_ids (the fix),
  // read stack-natively by range (NOT dropped by ON CONFLICT on real PG).
  const rows = await realPersistence.listAgentStackItems({ identityKey: 'xiaoni', afterStackIndex: -1, limit: 1000 });
  const runtimeInputs = rows.filter((r: any) => r.itemKind === 'runtime_input');
  const eventIds = runtimeInputs.map((r: any) => r.eventId);
  assert.equal(new Set(eventIds).size, eventIds.length, 'every runtime_input must have a distinct event_id on real PG');
});

// =====================================================================================
// REQ2 STW: mid-run compression switch — "one cold only" invariant.
//
// When a background compression fork commits mid-run, the running main agent switches
// to the compressed (smaller) context at the next between-turns silent point. That ONE
// switch turn must cold-read (the new <小腻近况> changes the cached prefix — necessary),
// and EVERY turn after it, plus any fork cloned afterwards, must stay warm (byte-
// identical prefix on the new baseline). No drift, no second 穿透.
// =====================================================================================
test('REQ2 STW: mid-run compression switch cold-reads exactly once; later turns stay warm', async () => {
  const KEY = 'xiaoni:test-global';
  const OLD_SUMMARY = '旧近况：很久以前的一大堆上下文';
  const NEW_SUMMARY = '压缩后近况：只保留最近的事';
  const NEW_CUTOFF = 300;

  // Stack BLOCKS (one agent_stack_item each), stack_index ascending. Eviction by a
  // stack_index cutoff shrinks the rendered prefix.
  const historyBlocks = [100, 200, 300, 400, 500].map((stackIndex) => ({
    stack_index: stackIndex, stackIndex, item_kind: 'runtime_input', itemKind: 'runtime_input',
    visibility: 'model_visible',
    content: { input_items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `历史消息-${stackIndex}` }] }] }
  }));
  let cutoffFlipped = false;

  const timelineEvents: any[] = [];
  const store: any = {
    createLlmJob: async () => 'job-stw',
    logTimelineEvent: async (e: any) => { timelineEvents.push(e); },
    // Stack-native flat range read: blocks with stack_index > afterStackIndex, in order.
    listAgentStackItems: async (params: any) => {
      const after = params.afterStackIndex ?? null;
      const floor = after === null || typeof after === 'undefined' ? -Infinity : Number(after);
      return historyBlocks.filter((b) => b.stack_index > floor).map((b) => ({ ...b }));
    },
    // OLD cutoff (keep all) until the fork "commits", then NEW cutoff + summary.
    getSessionReadCutoffState: async () => cutoffFlipped
      ? { readCutoffAfterStackIndex: NEW_CUTOFF, contextSummary: NEW_SUMMARY, pendingProactiveShare: null, pendingProactiveShareAge: 0 }
      : { readCutoffAfterStackIndex: null, contextSummary: OLD_SUMMARY, pendingProactiveShare: null, pendingProactiveShareAge: 0 },
    upsertSessionReadCutoffState: async () => {},
    upsertProactiveShareState: async () => {},
    recordRuntimeIdentityActivation: async () => {},
    getExecutionLeaseDeliveryState: async () => ({ deliveryPhase: 'idle', deliveryCommitCount: 0, blockedDeliveryAttemptCount: 0, lastBlockedDeliveryReason: null }),
    markLeaseVisibleDeliveryCommitted: async () => {},
    markLeaseDeliveryBlocked: async () => {},
    completeAgentStackToolExecution: async () => {},
    recordAgentStackToolExecution: async () => {},
    getAgentStackHead: async () => 0,
    appendAgentStackItems: async () => [],
    updateLlmRequestSliceStackLinks: async () => null,
    foldPendingNotifyIntoRun: async () => null,
    createConversation: async () => 9999,
    attachConversationIdToTrace: async () => {},
    settleQueueMessages: async () => {},
    failQueueMessage: async () => {},
    releaseExecutionLease: async () => {},
    updateLlmJob: async () => {}
  };

  const service = new AgentLoopService(store, { resolveForQueueMessage: async () => createRuntimePrompt() } as any);
  (service as any).executeTool = async () => ({ success: true, output: 'ok', message_type: 'tool_result' });

  const sentInputs: any[][] = [];
  let turn = 0;
  (service as any).executeAgentTurn = async (canonicalRequest: any) => {
    sentInputs.push(canonicalRequest.input || []);
    turn += 1;
    // After turn 2 a background compression "commits": arm the pending latch + flip the
    // session cutoff. The forks map is empty (no fork running) → turn 3's loop top will
    // adopt it (silent).
    if (turn === 2) {
      cutoffFlipped = true;
      (service as any).pendingCompressionAppliedCutoffBySession.set(KEY, NEW_CUTOFF);
    }
    if (turn <= 5) {
      return { success: true, llm_call_id: `llm-stw-${turn}`, llm_request_slice_id: `slice-stw-${turn}`,
        canonical_response: { output: [{ type: 'function_call', call_id: `call-stw-${turn}`, name: EXEC_COMMAND_TOOL, arguments: `{"cmd":"echo ${turn}"}` }] } };
    }
    return { success: true, llm_call_id: `llm-stw-${turn}`, llm_request_slice_id: `slice-stw-${turn}`,
      canonical_response: { output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '好。' }] }] } };
  };

  const queueMessage = { id: 'run-STW', traceId: 'runtrace-STW', batchId: 'batch-STW', status: 'processing',
    attempts: 1, maxAttempts: 3, queueMessageIds: [1], createdAt: '2026-06-29T08:00:00.000Z', payload: baseQueuePayload({ traceId: 'runtrace-STW', runId: 'run-STW' }) };
  await (service as any).processRuntimeFrame(queueMessage, { queueBacked: true });

  const has = (input: any[], needle: string) => JSON.stringify(input).includes(needle);
  // Which turns carry the OLD vs NEW 近况.
  const epochs = sentInputs.map((inp) => has(inp, NEW_SUMMARY) ? 'new' : (has(inp, OLD_SUMMARY) ? 'old' : '?'));
  const firstNew = epochs.indexOf('new');
  assert.ok(firstNew >= 1, `expected a switch to the compressed 近况, epochs=${epochs.join(',')}`);
  // Exactly one transition old->new, never back.
  assert.ok(epochs.slice(0, firstNew).every((e) => e === 'old'), `pre-switch turns must all carry OLD 近况: ${epochs}`);
  assert.ok(epochs.slice(firstNew).every((e) => e === 'new'), `post-switch turns must all carry NEW 近况 (no flip back): ${epochs}`);
  // The switch actually SHRANK the context (not just swapped the summary): the apply
  // evicted history <= cutoff 300, retaining only the 2 turns above it (400, 500).
  const midrunEvents = timelineEvents.filter((e) => e.eventName === 'core_memory_compression_applied_midrun');
  assert.equal(midrunEvents.length, 1, 'the mid-run switch must apply exactly once');
  assert.equal(midrunEvents[0].metadata.applied_read_cutoff, NEW_CUTOFF);
  assert.equal(midrunEvents[0].metadata.retained_history_count, 2, 'compression must shrink retained history to the 2 turns above the cutoff');

  // ONE cold only: the switch turn's durable prefix differs from the prior turn (cold),
  // and every later turn is a byte-identical extension of the switch baseline (warm).
  for (let i = firstNew; i + 1 < sentInputs.length; i += 1) {
    assertOrderedPrefix(stripVolatile(sentInputs[i]), stripVolatile(sentInputs[i + 1]), `post-switch turn ${i}->${i + 1} (must stay warm)`);
  }
  const preBase = JSON.stringify(stripVolatile(sentInputs[firstNew - 1]).slice(0, 3));
  const newBase = JSON.stringify(stripVolatile(sentInputs[firstNew]).slice(0, 3));
  assert.notEqual(newBase, preBase, 'the switch must change the cached prefix exactly once (the necessary cold read)');

  // VERBATIM-SUFFIX (user requirement): compression only DROPS the head (+ swaps 近况); it
  // never rewrites a kept block. So the retained-tail blocks (400, 500 — the two above the
  // 300 cutoff) must render BYTE-IDENTICALLY before and after the switch. Extract each
  // rendered history block (items whose text carries 历史消息-) from the pre- and post-switch
  // requests and assert the post-switch tail items hash-equal the SAME blocks in the
  // pre-switch request — a pure suffix selection, no mutation.
  const historyBlockItems = (input: any[], idsKept: number[]) =>
    (input || []).filter((it) => idsKept.some((id) => JSON.stringify(it).includes(`历史消息-${id}`)));
  const preTailItems = historyBlockItems(sentInputs[firstNew - 1], [400, 500]);
  const postTailItems = historyBlockItems(sentInputs[firstNew], [400, 500]);
  assert.equal(postTailItems.length, 2, 'the retained tail must render both kept blocks (400, 500) post-switch');
  assert.equal(
    JSON.stringify(postTailItems),
    JSON.stringify(preTailItems),
    'retained tail must be a VERBATIM SUFFIX: blocks 400/500 render byte-identically before and after compression (no rewrite)'
  );
  // And the switch genuinely DROPPED the evicted head (no 历史消息-100/200/300 survive).
  assert.equal(historyBlockItems(sentInputs[firstNew], [100, 200, 300]).length, 0,
    'the evicted head (blocks 100/200/300) must NOT survive in the post-switch request');
});

// =====================================================================================
// CONTRACT (docs/CACHE_CONTRACT.md §4): the STW drain gate waits ONLY for the
// compression fork that produced the cutoff — NOT for subconscious / image / heartbeat
// forks. Those are frozen clones on independent prefix-keyed entries and aren't 穿透ed
// by the switch; waiting for them would starve the switch in a busy session.
// =====================================================================================
function buildStwScenario() {
  const KEY = 'xiaoni:test-global';
  const NEW_CUTOFF = 300;
  const NEW_SUMMARY = '压缩后近况：只保留最近的事';
  const historyBlocks = [100, 200, 300, 400, 500].map((stackIndex) => ({
    stack_index: stackIndex, stackIndex, item_kind: 'runtime_input', itemKind: 'runtime_input',
    visibility: 'model_visible',
    content: { input_items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `历史消息-${stackIndex}` }] }] }
  }));
  let cutoffFlipped = false;
  const timelineEvents: any[] = [];
  const store: any = {
    createLlmJob: async () => 'job-stw2',
    logTimelineEvent: async (e: any) => { timelineEvents.push(e); },
    listAgentStackItems: async (params: any) => {
      const after = params.afterStackIndex ?? null;
      const floor = after === null || typeof after === 'undefined' ? -Infinity : Number(after);
      return historyBlocks.filter((b) => b.stack_index > floor).map((b) => ({ ...b }));
    },
    getSessionReadCutoffState: async () => cutoffFlipped
      ? { readCutoffAfterStackIndex: NEW_CUTOFF, contextSummary: NEW_SUMMARY, pendingProactiveShare: null, pendingProactiveShareAge: 0 }
      : { readCutoffAfterStackIndex: null, contextSummary: '旧近况', pendingProactiveShare: null, pendingProactiveShareAge: 0 },
    upsertSessionReadCutoffState: async () => {},
    upsertProactiveShareState: async () => {},
    recordRuntimeIdentityActivation: async () => {},
    getExecutionLeaseDeliveryState: async () => ({ deliveryPhase: 'idle', deliveryCommitCount: 0, blockedDeliveryAttemptCount: 0, lastBlockedDeliveryReason: null }),
    markLeaseVisibleDeliveryCommitted: async () => {},
    markLeaseDeliveryBlocked: async () => {},
    completeAgentStackToolExecution: async () => {},
    recordAgentStackToolExecution: async () => {},
    getAgentStackHead: async () => 0,
    appendAgentStackItems: async () => [],
    updateLlmRequestSliceStackLinks: async () => null,
    foldPendingNotifyIntoRun: async () => null,
    createConversation: async () => 9999,
    attachConversationIdToTrace: async () => {},
    settleQueueMessages: async () => {},
    failQueueMessage: async () => {},
    releaseExecutionLease: async () => {},
    updateLlmJob: async () => {}
  };
  return { store, KEY, NEW_CUTOFF, timelineEvents, flip: () => { cutoffFlipped = true; } };
}

async function runStwScenario(setup: (service: any, scenario: ReturnType<typeof buildStwScenario>) => void) {
  const scenario = buildStwScenario();
  const service = new AgentLoopService(scenario.store, { resolveForQueueMessage: async () => createRuntimePrompt() } as any);
  (service as any).executeTool = async () => ({ success: true, output: 'ok', message_type: 'tool_result' });
  setup(service, scenario);
  let turn = 0;
  (service as any).executeAgentTurn = async () => {
    turn += 1;
    if (turn === 2) {
      scenario.flip();
      (service as any).pendingCompressionAppliedCutoffBySession.set(scenario.KEY, scenario.NEW_CUTOFF);
    }
    if (turn <= 4) {
      return { success: true, llm_call_id: `llm-${turn}`, llm_request_slice_id: `slice-${turn}`,
        canonical_response: { output: [{ type: 'function_call', call_id: `call-${turn}`, name: EXEC_COMMAND_TOOL, arguments: `{"cmd":"echo ${turn}"}` }] } };
    }
    return { success: true, llm_call_id: `llm-${turn}`, llm_request_slice_id: `slice-${turn}`,
      canonical_response: { output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '好。' }] }] } };
  };
  const queueMessage = { id: 'run-STW2', traceId: 'runtrace-STW2', batchId: 'batch-STW2', status: 'processing',
    attempts: 1, maxAttempts: 3, queueMessageIds: [1], createdAt: '2026-06-29T08:00:00.000Z', payload: baseQueuePayload({ traceId: 'runtrace-STW2', runId: 'run-STW2' }) };
  await (service as any).processRuntimeFrame(queueMessage, { queueBacked: true });
  return scenario.timelineEvents.filter((e) => e.eventName === 'core_memory_compression_applied_midrun');
}

test('STW drain gate: a subconscious fork in flight does NOT block the switch', async () => {
  const midrun = await runStwScenario((service) => {
    // A subconscious fork is mid-flight — per contract this must NOT gate the switch.
    (service as any).subconsciousAgentForkInFlight = Promise.resolve(true);
  });
  assert.equal(midrun.length, 1, 'the switch must fire even while a subconscious fork runs');
  assert.equal(midrun[0].metadata.applied_read_cutoff, 300);
});

test('STW drain gate: the compression fork that produced the cutoff DOES block the switch until it finishes', async () => {
  const midrun = await runStwScenario((service) => {
    // The compression fork for this session is still running — must suppress the switch.
    (service as any).coreMemoryCompressionForks.set('xiaoni:test-global', { promise: Promise.resolve() });
  });
  assert.equal(midrun.length, 0, 'the switch must wait for the compression fork to finish committing');
});

// CONTRACT (docs/CACHE_CONTRACT.md §4): the drain gate is PER-KEY ("该 key 空"). A
// compression fork on a DIFFERENT session must not gate this session's switch. The old
// global `.size > 0` gate would block here (cross-session starvation); the per-key
// `.has(key)` gate ignores the foreign fork and fires (改坏即红 if it regresses to .size).
test('STW drain gate: a compression fork on ANOTHER session does NOT block this session\'s switch (per-key)', async () => {
  const midrun = await runStwScenario((service) => {
    (service as any).coreMemoryCompressionForks.set('xiaoni:some-OTHER-session', { promise: Promise.resolve() });
  });
  assert.equal(midrun.length, 1, 'a foreign-session compression fork must not gate this session\'s switch');
});

// =====================================================================================
// CONTRACT (docs/CACHE_CONTRACT.md §3 byte-replay invariant + §4 STW): the mid-run switch
// must preserve the run's OWN loopContinuation/trigger ordering. A RESUMED run is built with
// loopContinuationBeforeCurrentTrigger=true → [history, loopContinuation, trigger]. If the
// switch rebuilt with the default false it would emit [history, trigger, loopContinuation],
// diverging the live body's item order from what stack-replay reconstructs for that run →
// a run-boundary byte-replay break (the exact failure class this whole branch exists to fix).
// This regression drives the switch on a resumed run and pins the ordering. Before the fix
// (the rebuild ignored the flag) the `lc < trig` assertion goes red.
// =====================================================================================
test('REQ2 STW: the switch preserves the run\'s loopContinuation-before-trigger ordering (resumed run)', async () => {
  const scenario = buildStwScenario();
  scenario.flip(); // the compression fork has committed the new cutoff + summary
  const service = new AgentLoopService(scenario.store, { resolveForQueueMessage: async () => createRuntimePrompt() } as any);

  const LC_MARKER = '<<LOOP_CONTINUATION_MARKER>>';
  const TRIGGER_MARKER = '<<CURRENT_TRIGGER_MARKER>>';
  const loopContinuation = [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: LC_MARKER }] }
  ] as any[];
  const trigger = [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: TRIGGER_MARKER }], cache_volatile: true }
  ] as any[];

  const callApply = (loopContinuationBeforeCurrentTrigger: boolean) => (service as any).applyPendingCompressionMidRunIfSilent({
    contextSessionKey: scenario.KEY,
    appliedRunCutoff: null,
    fullHistory: [{ id: 400, userMessage: 'x', aiResponse: null }, { id: 500, userMessage: 'y', aiResponse: null }],
    loopContinuation,
    queueMessage: baseQueuePayload({ traceId: 'runtrace-STW2', runId: 'run-STW2' }),
    runtimePrompt: createRuntimePrompt(),
    runtimeIdentityFacts: [],
    pendingProactiveShare: null,
    developerContextBlock: null,
    runtimeEnergyState: null,
    precomputedCurrentTurnInputItems: trigger,
    loopContinuationBeforeCurrentTrigger
  });

  const order = (input: any[]) => {
    const s = input.map((i) => JSON.stringify(i));
    return { lc: s.findIndex((x) => x.includes(LC_MARKER)), trig: s.findIndex((x) => x.includes(TRIGGER_MARKER)) };
  };

  // Resumed run (before=true): loopContinuation must remain BEFORE the trigger after the switch.
  (service as any).pendingCompressionAppliedCutoffBySession.set(scenario.KEY, scenario.NEW_CUTOFF);
  const resumed = await callApply(true);
  assert.ok(resumed, 'the switch must fire (cutoff committed, no compression fork running)');
  const r = order(resumed.requestInput);
  assert.ok(r.lc >= 0 && r.trig >= 0, `both markers must be present in the switched body (lc=${r.lc}, trig=${r.trig})`);
  assert.ok(r.lc < r.trig, `resumed run: loopContinuation must stay BEFORE the trigger after the switch (lc=${r.lc}, trig=${r.trig})`);

  // Sanity: the flag is genuinely honored — a fresh run (before=false) puts it AFTER.
  (service as any).pendingCompressionAppliedCutoffBySession.set(scenario.KEY, scenario.NEW_CUTOFF);
  const fresh = await callApply(false);
  const f = order(fresh.requestInput);
  assert.ok(f.lc > f.trig, `fresh run: loopContinuation stays AFTER the trigger (lc=${f.lc}, trig=${f.trig})`);
});

// =====================================================================================
// PURPOSE (not implementation): the cache heartbeat exists ONLY to keep the prompt cache
// warm while the runtime is stopped, so that when the switch is flipped back on and the
// main agent runs its next request (no notify), that request HITS the warm cache instead
// of cold-prefilling. The single outcome that matters: the heartbeat's request and a real
// main-agent run's request must share a byte-identical cacheable (non-volatile) prefix over
// the SAME history. We drive both through their REAL entry points (triggerCacheHeartbeatForDebug
// + processRuntimeFrame) and compare the OUTCOMES — we do NOT mirror which builder/flag each
// uses. If the heartbeat warms a different/shorter prefix than the main run needs, the first
// real request after wake cold-reads = the heartbeat failed its only job. That goes RED here.
// =====================================================================================
test('cache continuity: the heartbeat warms exactly what the next main-agent run hits (same cacheable prefix)', async () => {
  // A non-trivial replayed history (stack blocks) both paths consume identically.
  const historyBlocks = [100, 200].map((stackIndex) => ({
    stack_index: stackIndex, stackIndex, item_kind: 'runtime_input', itemKind: 'runtime_input',
    visibility: 'model_visible',
    content: { input_items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `历史消息-${stackIndex}` }] }] }
  }));
  const store: any = {
    createLlmJob: async () => 'job-hbcont',
    logTimelineEvent: async () => {},
    listAgentStackItems: async (params: any) => {
      const after = params.afterStackIndex ?? null;
      const floor = after === null || typeof after === 'undefined' ? -Infinity : Number(after);
      return historyBlocks.filter((b) => b.stack_index > floor).map((b) => ({ ...b }));
    },
    getSessionReadCutoffState: async () => ({ readCutoffAfterStackIndex: null, contextSummary: null, pendingProactiveShare: null, pendingProactiveShareAge: 0 }),
    upsertSessionReadCutoffState: async () => {},
    upsertProactiveShareState: async () => {},
    recordRuntimeIdentityActivation: async () => {},
    getCurrentXiaoniEnergyState: async () => ({ energy: 0.5, maxEnergy: 1, lastWakeAt: null }),
    getExecutionLeaseDeliveryState: async () => ({ deliveryPhase: 'idle', deliveryCommitCount: 0, blockedDeliveryAttemptCount: 0, lastBlockedDeliveryReason: null }),
    markLeaseVisibleDeliveryCommitted: async () => {},
    markLeaseDeliveryBlocked: async () => {},
    completeAgentStackToolExecution: async () => {},
    recordAgentStackToolExecution: async () => {},
    getAgentStackHead: async () => 0,
    appendAgentStackItems: async () => [],
    updateLlmRequestSliceStackLinks: async () => null,
    foldPendingNotifyIntoRun: async () => null,
    createConversation: async () => 9999,
    attachConversationIdToTrace: async () => {},
    settleQueueMessages: async () => {},
    failQueueMessage: async () => {},
    releaseExecutionLease: async () => {},
    updateLlmJob: async () => {}
  };

  const service = new AgentLoopService(store, { resolveForQueueMessage: async () => createRuntimePrompt() } as any);
  (service as any).executeTool = async () => ({ success: true, output: 'ok', message_type: 'tool_result' });

  // Capture the HEARTBEAT request (its real dispatch goes through fetch).
  const previousFetch = globalThis.fetch;
  const previousMax = agentConfig.cacheHeartbeatMaxOutputTokens;
  agentConfig.cacheHeartbeatMaxOutputTokens = 1;
  let heartbeatRequest: any = null;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    heartbeatRequest = JSON.parse(String(init?.body || '{}')).canonicalRequest;
    return new Response(JSON.stringify({
      success: true, llm_call_id: 'llm-hbc', model: 'gpt-5-mini', provider: 'codex-local',
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 }, usage_details: { cached_input_tokens: 9 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  // Capture the MAIN-AGENT request (turn 1 of a fresh single-turn run).
  const mainSentInputs: any[][] = [];
  (service as any).executeAgentTurn = async (canonicalRequest: any) => {
    mainSentInputs.push(canonicalRequest.input || []);
    return { success: true, llm_call_id: 'llm-main', llm_request_slice_id: 'slice-main',
      canonical_response: { output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '好。' }] }] } };
  };

  let mainInstructions: any = null;
  let mainTools: any = null;
  const realExecute = (service as any).executeAgentTurn;
  (service as any).executeAgentTurn = async (canonicalRequest: any) => {
    mainInstructions = canonicalRequest.instructions;
    mainTools = canonicalRequest.tools;
    return realExecute(canonicalRequest);
  };

  try {
    // 1) Heartbeat fires while stopped (store=false, mutates nothing).
    await service.triggerCacheHeartbeatForDebug();
    // 2) Switch on: a real main run over the SAME history (a notify frame; its trigger is volatile).
    const queueMessage = { id: 'run-HBC', traceId: 'runtrace-HBC', batchId: 'batch-HBC', status: 'processing',
      attempts: 1, maxAttempts: 3, queueMessageIds: [1], createdAt: '2026-06-29T08:00:00.000Z', payload: baseQueuePayload({ traceId: 'runtrace-HBC', runId: 'run-HBC' }) };
    await (service as any).processRuntimeFrame(queueMessage, { queueBacked: true });
  } finally {
    globalThis.fetch = previousFetch;
    agentConfig.cacheHeartbeatMaxOutputTokens = previousMax;
  }

  assert.ok(heartbeatRequest, 'the heartbeat must have dispatched a request');
  assert.ok(mainSentInputs.length >= 1, 'the main run must have sent at least one request');
  const mainInput = mainSentInputs[0];
  const mainDurable = stripVolatile(mainInput);
  const heartbeatDurable = stripVolatile(heartbeatRequest.input || []);

  // The stable head (system + tools) the heartbeat warms must be the main run's head.
  assert.deepEqual(heartbeatRequest.instructions, mainInstructions, 'heartbeat system prompt must equal the main run\'s');
  assert.deepEqual(heartbeatRequest.tools, mainTools, 'heartbeat tools must equal the main run\'s');

  // Non-vacuous: the durable prefix being compared must carry real, substantial content
  // (the developer/skills tier), not an empty list that trivially satisfies ordered-prefix.
  assert.ok(mainDurable.length >= 1, 'precondition: the main run must have a non-empty durable prefix');
  assert.ok(JSON.stringify(mainDurable[0]).length > 500,
    'precondition: the compared durable head must be substantial real content (not a stub)');

  // THE PURPOSE: every durable (non-volatile) item the main run sends must be present,
  // byte-identical and in order, at the head of the heartbeat's request — i.e. the next
  // real run hits exactly what the heartbeat warmed. A divergence (heartbeat warms a
  // different/shorter prefix) means the first request after wake cold-reads.
  assertOrderedPrefix(mainDurable, heartbeatDurable,
    'heartbeat must warm the main run\'s exact cacheable prefix (cache continuity)');
});

// =====================================================================================
// PURPOSE (#3 provider request exception): when a provider call fails TRANSIENTLY and the run
// is retried, the reprocessed attempt must send a request whose cacheable prefix is BYTE-
// IDENTICAL to the first attempt's — so the provider's still-warm cache from attempt 1 is HIT
// on the retry instead of cold-prefilling. If anything (re-fold order, re-read history, a
// re-stamped value) drifts between attempts, the retry cold-reads and the cost doubles.
// =====================================================================================
test('provider TRANSIENT retry: attempt-2 sends a byte-identical cacheable prefix as attempt-1 (warm cache on retry)', async () => {
  const { store } = createFaithfulStore({ foldsToServe: [] });
  const service = new AgentLoopService(store, { resolveForQueueMessage: async () => createRuntimePrompt() } as any);
  (service as any).executeTool = async () => ({ success: true, output: 'ok', message_type: 'tool_result' });

  const attemptInputs: any[][][] = [[], []]; // [attempt1 turns, attempt2 turns]
  let currentAttempt = 0;
  let turnInAttempt = 0;
  (service as any).executeAgentTurn = async (canonicalRequest: any) => {
    attemptInputs[currentAttempt].push(canonicalRequest.input || []);
    turnInAttempt += 1;
    if (currentAttempt === 0) {
      if (turnInAttempt === 1) {
        return { success: true, llm_call_id: 'a1-1', llm_request_slice_id: 'a1s1',
          canonical_response: { output: [{ type: 'function_call', call_id: 'c1', name: EXEC_COMMAND_TOOL, arguments: '{"cmd":"echo 1"}' }] } };
      }
      throw new Error('fetch failed: socket timeout'); // transient -> retry scheduled
    }
    return { success: true, llm_call_id: 'a2-1', llm_request_slice_id: 'a2s1',
      canonical_response: { output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '好。' }] }] } };
  };

  const mk = (attempts: number) => ({ id: 'run-RETRY', traceId: 'rt-RETRY', batchId: 'b-RETRY', status: 'processing',
    attempts, maxAttempts: 3, queueMessageIds: [1], createdAt: '2026-06-29T08:00:00.000Z', payload: baseQueuePayload({ traceId: 'rt-RETRY', runId: 'run-RETRY' }) });

  await (service as any).processRuntimeFrame(mk(1), { queueBacked: true }); // attempt 1: transient fail
  currentAttempt = 1; turnInAttempt = 0;
  await (service as any).processRuntimeFrame(mk(2), { queueBacked: true }); // attempt 2: reprocess, succeed

  assert.ok(attemptInputs[0].length >= 1 && attemptInputs[1].length >= 1, 'both attempts must have sent a first turn');
  const a1 = stripVolatile(attemptInputs[0][0]);
  const a2 = stripVolatile(attemptInputs[1][0]);
  assert.ok(a1.length >= 1 && JSON.stringify(a1[0]).length > 500, 'precondition: a substantial durable prefix is being compared');
  // Warm cache on retry: every durable item attempt-1 sent must be present, byte-identical and
  // in order, at the HEAD of attempt-2's request — so the provider's warm prefix from attempt 1
  // is hit on the retry. Attempt 2 legitimately EXTENDS it (it resumes from attempt 1's recovered
  // loopContinuation), but it must never drop, reorder or re-render attempt 1's warm prefix.
  assertOrderedPrefix(a1, a2, 'transient retry: attempt-1 warm prefix must be preserved at attempt-2\'s head');
});

// =====================================================================================
// PURPOSE (#5 restart recovery): after a restart, a recovered run reprocesses with a non-empty
// initialLoopContinuation (before=true → [history, loopContinuation, trigger]). Its live request
// item order must match what the next run's stack-replay reconstructs for that lineage, or the
// run boundary cold-reads (the F1 failure class). F1's regression (1009) pins this at the
// applyPendingCompressionMidRunIfSilent unit boundary; this lifts it to the FULL frame: a real
// processRuntimeFrame driven as a recovered run must order loopContinuation BEFORE the trigger.
// =====================================================================================
test('restart recovery: a recovered run orders loopContinuation BEFORE the trigger end-to-end (frame level)', async () => {
  const { store } = createFaithfulStore({ foldsToServe: [] });
  const service = new AgentLoopService(store, { resolveForQueueMessage: async () => createRuntimePrompt() } as any);
  (service as any).executeTool = async () => ({ success: true, output: 'ok', message_type: 'tool_result' });

  const LC_MARKER = '<<RECOVERED_LOOP_CONTINUATION>>';
  const recoveredLoopContinuation = [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: LC_MARKER }] }
  ];
  const sent: any[][] = [];
  (service as any).executeAgentTurn = async (canonicalRequest: any) => {
    sent.push(canonicalRequest.input || []);
    return { success: true, llm_call_id: 'rec-1', llm_request_slice_id: 'recs-1',
      canonical_response: { output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '好。' }] }] } };
  };

  const queueMessage = { id: 'run-REC', traceId: 'rt-REC', batchId: 'b-REC', status: 'processing',
    attempts: 1, maxAttempts: 3, queueMessageIds: [1], createdAt: '2026-06-29T08:00:00.000Z', payload: baseQueuePayload({ traceId: 'rt-REC', runId: 'run-REC' }) };
  // Drive it as a RECOVERED run: the restart handed back accumulated loopContinuation.
  await (service as any).processRuntimeFrame(queueMessage, {
    queueBacked: true,
    initialLoopContinuation: recoveredLoopContinuation,
    initialLoopContinuationBeforeCurrentTrigger: true
  });

  assert.ok(sent.length >= 1, 'the recovered run must have sent a request');
  const input = sent[0];
  const lcIdx = input.findIndex((i: any) => JSON.stringify(i).includes(LC_MARKER));
  const trigIdx = input.findIndex((i: any) => i && i.cache_volatile === true);
  assert.ok(lcIdx >= 0, 'the recovered loopContinuation must be present in the live request');
  assert.ok(trigIdx >= 0, 'the current-turn trigger (cache_volatile) must be present');
  assert.ok(lcIdx < trigIdx, `recovered run must order loopContinuation BEFORE the trigger (lc=${lcIdx}, trig=${trigIdx}) to match stack-replay`);
});

// =====================================================================================
// PURPOSE (#1 STW run boundary): a run performs an STW switch, committing a new cutoff +
// compressed近况. The NEXT run must reconstruct that SAME compressed context from the committed
// cutoff/summary — so the switched run's compressed prefix is exactly what the next run extends
// (continuity across the run boundary). The existing STW test (805) only covers WITHIN-run warm
// continuity; this covers the NEXT run reading the committed compression. (Full history-byte
// replay of the switched body needs the real-Postgres runtime harness — see the 'REAL Postgres'
// test; the in-memory harness does not render replayed history into the request.)
// =====================================================================================
test('STW run boundary: the next run reconstructs the committed compressed近况 the switch produced', async () => {
  const NEW_SUMMARY = '压缩后近况：只保留最近的事'; // the summary buildStwScenario commits on flip()
  const OLD_MARKER = '旧近况'; // the pre-switch summary buildStwScenario serves before flip()
  const scenario = buildStwScenario();
  const service = new AgentLoopService(scenario.store, { resolveForQueueMessage: async () => createRuntimePrompt() } as any);
  (service as any).executeTool = async () => ({ success: true, output: 'ok', message_type: 'tool_result' });

  const run1Inputs: any[][] = [];
  let turn = 0;
  (service as any).executeAgentTurn = async (canonicalRequest: any) => {
    turn += 1;
    run1Inputs.push(canonicalRequest.input || []);
    if (turn === 2) {
      // The background compression commits mid-run-1: arm the latch + flip the live cutoff/summary.
      scenario.flip();
      (service as any).pendingCompressionAppliedCutoffBySession.set(scenario.KEY, scenario.NEW_CUTOFF);
    }
    if (turn <= 4) {
      return { success: true, llm_call_id: `r1-${turn}`, llm_request_slice_id: `r1s-${turn}`,
        canonical_response: { output: [{ type: 'function_call', call_id: `c-${turn}`, name: EXEC_COMMAND_TOOL, arguments: `{"cmd":"echo ${turn}"}` }] } };
    }
    return { success: true, llm_call_id: `r1-${turn}`, llm_request_slice_id: `r1s-${turn}`,
      canonical_response: { output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '好。' }] }] } };
  };

  const mk = (runId: string) => ({ id: runId, traceId: `rt-${runId}`, batchId: `b-${runId}`, status: 'processing',
    attempts: 1, maxAttempts: 3, queueMessageIds: [1], createdAt: '2026-06-29T08:00:00.000Z', payload: baseQueuePayload({ traceId: `rt-${runId}`, runId }) });

  // Run 1: performs the STW switch (commits cutoff + NEW_SUMMARY).
  await (service as any).processRuntimeFrame(mk('run-STW-A'), { queueBacked: true });
  const midrun = scenario.timelineEvents.filter((e: any) => e.eventName === 'core_memory_compression_applied_midrun');
  assert.equal(midrun.length, 1, 'run 1 must have performed the STW switch');

  // Run 2: the NEXT run — single final-answer turn — must read the committed cutoff/summary.
  const run2Inputs: any[][] = [];
  let turn2 = 0;
  (service as any).executeAgentTurn = async (canonicalRequest: any) => {
    turn2 += 1;
    run2Inputs.push(canonicalRequest.input || []);
    return { success: true, llm_call_id: `r2-${turn2}`, llm_request_slice_id: `r2s-${turn2}`,
      canonical_response: { output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '好。' }] }] } };
  };
  await (service as any).processRuntimeFrame(mk('run-STW-B'), { queueBacked: true });

  assert.ok(run1Inputs.length >= 2 && run2Inputs.length >= 1, 'both runs must have sent requests');
  const run1PreSwitch = run1Inputs[0];                           // OLD compressed base (before flip)
  const run1PostSwitch = run1Inputs[run1Inputs.length - 1];      // NEW compressed base (after switch)
  const run2First = run2Inputs[0];                               // the next run's opening durable prefix

  // The switch took effect within run 1: the post-switch turn carries the NEW 近况, the pre-switch
  // turn carries the OLD one. (Anchors the epochs the continuity assertion compares.)
  assert.ok(JSON.stringify(run1PreSwitch).includes(OLD_MARKER), 'run-1 pre-switch turn must carry the OLD 近况');
  assert.ok(JSON.stringify(run1PostSwitch).includes(NEW_SUMMARY) && !JSON.stringify(run1PostSwitch).includes(OLD_MARKER),
    'run-1 post-switch turn must carry the NEW 近况 and have dropped the OLD');

  // RUN-BOUNDARY CACHE CONTINUITY (the real purpose, not a substring check): the next run's durable
  // prefix must be a BYTE-IDENTICAL ordered prefix of run-1's post-switch durable prefix — run 2
  // extends the exact committed compressed base [system, 压缩近况@cutoff] the switch produced, so the
  // warm entry carries ACROSS the run boundary instead of cold-reading a re-rendered base.
  const run2Durable = stripVolatile(run2First);
  const run1PostDurable = stripVolatile(run1PostSwitch);
  assert.ok(run2Durable.length >= 2 && JSON.stringify(run2Durable).includes(NEW_SUMMARY),
    'precondition: the next run\'s DURABLE (cached) prefix must carry the committed 压缩近况');
  assertOrderedPrefix(run2Durable, run1PostDurable, 'STW run-boundary continuity (next run extends the committed compressed base)');

  // DISCRIMINATION: the same durable prefix is NOT an ordered prefix of run-1's PRE-switch (OLD)
  // base — so the continuity assertion is keyed to the committed compressed state, not trivially
  // true of any prefix. A regression that left run 2 reading the OLD base would fail the assertion
  // above AND make this throw fail to throw.
  assert.throws(() => assertOrderedPrefix(run2Durable, stripVolatile(run1PreSwitch), 'must-diverge-from-OLD'),
    'the next run\'s durable prefix must DIVERGE from the pre-switch OLD base (proves the continuity check discriminates)');
  assert.ok(!JSON.stringify(run2First).includes(OLD_MARKER),
    'the next run must NOT carry the stale pre-switch 近况');
});

// =====================================================================================
// PURPOSE (#4 小腻主流程暂停后回复): a run can be PAUSED mid-loop at the runtime-enabled gate
// (waitForRuntimeEnabledBeforeModelSlice) and resumed arbitrarily later. A pause spans wall-clock
// time; if ANYTHING in the next turn's cacheable prefix re-renders on resume (a timestamp, a
// rebuilt trigger), the warm cache the paused run held is busted. This drives the REAL gate
// (isRuntimeEnabled false for one poll) mid-loop, advances the clock during the block, and asserts
// the post-resume turn's durable prefix is byte-identical to the pre-pause turn's.
// =====================================================================================
test('pause→resume across wall-clock drift keeps the cacheable prefix byte-identical (real runtime gate)', async () => {
  const { store } = createFaithfulStore({ foldsToServe: [] });
  let paused = false;
  let turn = 0;
  const service = new AgentLoopService(
    store,
    { resolveForQueueMessage: async () => createRuntimePrompt() } as any,
    {
      runtimePausePollMs: 50,
      isRuntimeEnabled: async () => {
        // Pause exactly once at the top of turn 2 (after turn 1 ran), drifting the clock 17.5h
        // during the block; then resume.
        if (turn === 1 && !paused) { paused = true; patchClock('2026-06-30T03:30:00+08:00'); return false; }
        return true;
      }
    } as any
  );
  (service as any).executeTool = async () => ({ success: true, output: 'ok', message_type: 'tool_result' });

  const sent: any[][] = [];
  (service as any).executeAgentTurn = async (canonicalRequest: any) => {
    sent.push(canonicalRequest.input || []);
    turn += 1;
    if (turn === 1) {
      return { success: true, llm_call_id: 'p-1', llm_request_slice_id: 'ps-1',
        canonical_response: { output: [{ type: 'function_call', call_id: 'pc-1', name: EXEC_COMMAND_TOOL, arguments: '{"cmd":"echo 1"}' }] } };
    }
    return { success: true, llm_call_id: `p-${turn}`, llm_request_slice_id: `ps-${turn}`,
      canonical_response: { output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '好。' }] }] } };
  };

  patchClock('2026-06-29T10:00:00+08:00');
  try {
    const queueMessage = { id: 'run-PAUSE', traceId: 'rt-PAUSE', batchId: 'b-PAUSE', status: 'processing',
      attempts: 1, maxAttempts: 3, queueMessageIds: [1], createdAt: '2026-06-29T08:00:00.000Z', payload: baseQueuePayload({ traceId: 'rt-PAUSE', runId: 'run-PAUSE' }) };
    await (service as any).processRuntimeFrame(queueMessage, { queueBacked: true });
  } finally {
    restoreClock();
  }

  assert.ok(paused, 'the real pause gate must have blocked at least once');
  assert.ok(sent.length >= 2, 'the pause must span a turn boundary (>=2 turns sent)');
  assert.ok(stripVolatile(sent[0]).length >= 1, 'precondition: non-empty durable prefix');
  // 0-tolerance: the post-resume turn's durable prefix is an exact ordered prefix of the pre-pause
  // turn's — nothing in the cacheable prefix re-rendered across the paused wall-clock drift.
  assertOrderedPrefix(stripVolatile(sent[0]), stripVolatile(sent[1]), 'pause->resume drift');

  // CLOSING THE stripVolatile BLIND SPOT: assertOrderedPrefix only inspects the DURABLE tier, so a
  // re-rendered wall-clock hiding in the VOLATILE current-turn trigger would slip past it. The pause
  // drifted the clock from 2026-06-29 to 2026-06-30; that DRIFTED date must appear in NEITHER tier of
  // EITHER turn. If a [当前时间]-style stamp is ever reintroduced into the request (any tier), the
  // post-resume build reads the drifted clock and this goes red — the inert ordered-prefix check
  // (no time content exists to drift today) cannot catch that on its own.
  const DRIFTED_DATE = '2026-06-30';
  assert.ok(!JSON.stringify(sent[0]).includes(DRIFTED_DATE),
    'precondition: the pre-pause turn (clock 2026-06-29) must not contain the post-resume drifted date');
  assert.ok(!JSON.stringify(sent[1]).includes(DRIFTED_DATE),
    'no wall-clock value from the paused drift may render into the post-resume request (durable OR volatile tier)');

  // The current-turn trigger that survives the pause must be reused byte-for-byte, not rebuilt
  // on the resumed (drifted) clock — and the check must not be vacuous (there IS a volatile trigger).
  const vol0 = (sent[0] || []).filter((i: any) => i && i.cache_volatile === true);
  const vol1 = (sent[1] || []).filter((i: any) => i && i.cache_volatile === true);
  assert.ok(vol0.length >= 1 && vol1.length >= 1, 'precondition: each turn carries a volatile current-turn trigger to compare');
  assert.equal(JSON.stringify(vol0), JSON.stringify(vol1), 'the current-turn trigger must be reused byte-for-byte across the pause, not re-rendered');
});

// Shared committed-state store for the heartbeat business scenarios. It serves a stable committed
// context (history + cutoff/energy) — with visibility:'model_visible' so the history actually
// renders into the request — that both the heartbeat and a fresh wake run read.
function buildHeartbeatScenarioStore() {
  // Stack BLOCKS (model_visible so the history renders into the request) that both the
  // heartbeat and a fresh wake run read via loadStackHistoryBlocks.
  const historyBlocks = [100, 200].map((stackIndex) => ({
    stack_index: stackIndex, stackIndex, item_kind: 'runtime_input', itemKind: 'runtime_input',
    visibility: 'model_visible',
    content: { input_items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `历史消息-${stackIndex}` }] }] }
  }));
  const store: any = {
    createLlmJob: async () => 'job-hbs',
    logTimelineEvent: async () => {},
    listAgentStackItems: async (params: any) => {
      const after = params.afterStackIndex ?? null;
      const floor = after === null || typeof after === 'undefined' ? -Infinity : Number(after);
      return historyBlocks.filter((b) => b.stack_index > floor).map((b) => ({ ...b }));
    },
    getSessionReadCutoffState: async () => ({ readCutoffAfterStackIndex: null, contextSummary: null, pendingProactiveShare: null, pendingProactiveShareAge: 0 }),
    upsertSessionReadCutoffState: async () => {},
    upsertProactiveShareState: async () => {},
    recordRuntimeIdentityActivation: async () => {},
    getCurrentXiaoniEnergyState: async () => ({ energy: 0.5, maxEnergy: 1, lastWakeAt: null }),
    getExecutionLeaseDeliveryState: async () => ({ deliveryPhase: 'idle', deliveryCommitCount: 0, blockedDeliveryAttemptCount: 0, lastBlockedDeliveryReason: null }),
    markLeaseVisibleDeliveryCommitted: async () => {},
    markLeaseDeliveryBlocked: async () => {},
    completeAgentStackToolExecution: async () => {},
    recordAgentStackToolExecution: async () => {},
    getAgentStackHead: async () => 0,
    appendAgentStackItems: async () => [],
    updateLlmRequestSliceStackLinks: async () => null,
    foldPendingNotifyIntoRun: async () => null,
    createConversation: async () => 9999,
    attachConversationIdToTrace: async () => {},
    settleQueueMessages: async () => {},
    failQueueMessage: async () => {},
    releaseExecutionLease: async () => {},
    updateLlmJob: async () => {}
  };
  return store;
}

function interceptHeartbeatFetch(capture: (req: any) => void) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    capture(JSON.parse(String(init?.body || '{}')).canonicalRequest);
    return new Response(JSON.stringify({
      success: true, llm_call_id: 'llm-hb', model: 'gpt-5-mini', provider: 'codex-local',
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 }, usage_details: { cached_input_tokens: 9 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return () => { globalThis.fetch = previousFetch; };
}

// =====================================================================================
// SCENARIO 1 (小腻睡眠 3h 后睡醒): while 小腻 sleeps there is NO live run; a heartbeat fires to
// keep the prompt cache warm. 3 HOURS LATER she wakes and her first FRESH run must HIT that warm
// entry — same byte-identical cacheable prefix despite the long idle gap. This fires the heartbeat
// at T, drifts the clock +3h, then drives the wake-up run, and asserts the wake run's durable
// prefix is byte-identical at the head of what the heartbeat warmed.
// =====================================================================================
test('scenario 1 (slept 3h → wake): the wake-up run hits the cache entry the heartbeat kept warm', async () => {
  const store = buildHeartbeatScenarioStore();
  const service = new AgentLoopService(store, { resolveForQueueMessage: async () => createRuntimePrompt() } as any);
  (service as any).executeTool = async () => ({ success: true, output: 'ok', message_type: 'tool_result' });

  const previousMax = agentConfig.cacheHeartbeatMaxOutputTokens;
  agentConfig.cacheHeartbeatMaxOutputTokens = 1;
  let heartbeatReq: any = null;
  const restoreFetch = interceptHeartbeatFetch((r) => { heartbeatReq = r; });
  const wakeInputs: any[][] = [];
  (service as any).executeAgentTurn = async (canonicalRequest: any) => {
    wakeInputs.push(canonicalRequest.input || []);
    return { success: true, llm_call_id: 'wake-1', llm_request_slice_id: 'wakes-1',
      canonical_response: { output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '好。' }] }] } };
  };

  try {
    patchClock('2026-06-29T10:00:00+08:00');
    await service.triggerCacheHeartbeatForDebug();              // heartbeat while asleep
    patchClock('2026-06-29T13:00:00+08:00');                    // slept 3 hours
    const wake = { id: 'run-WAKE', traceId: 'rt-WAKE', batchId: 'b-WAKE', status: 'processing',
      attempts: 1, maxAttempts: 3, queueMessageIds: [1], createdAt: '2026-06-29T08:00:00.000Z', payload: baseQueuePayload({ traceId: 'rt-WAKE', runId: 'run-WAKE' }) };
    await (service as any).processRuntimeFrame(wake, { queueBacked: true }); // she wakes, fresh run
  } finally {
    restoreFetch();
    restoreClock();
    agentConfig.cacheHeartbeatMaxOutputTokens = previousMax;
  }

  assert.ok(heartbeatReq && wakeInputs.length >= 1, 'heartbeat + wake run must have dispatched');
  const wakeDurable = stripVolatile(wakeInputs[0]);
  assert.ok(wakeDurable.length >= 2 && JSON.stringify(wakeDurable[0]).length > 500,
    'precondition: substantial durable prefix WITH rendered history (not just the skills block)');
  // The wake-up run (3h later) hits EXACTLY what the heartbeat warmed: two-directional byte-equality
  // (heartbeat minus its trailing dev item == the wake's durable prefix), so heartbeat OVER-extension
  // would also fail here — not just a one-way ordered prefix.
  const hbDurable = stripVolatile(heartbeatReq.input || []);
  assert.equal(JSON.stringify(hbDurable.slice(0, -1)), JSON.stringify(wakeDurable),
    'slept 3h: the heartbeat must warm exactly the wake-up run\'s durable prefix (no over-extension)');
});

// =====================================================================================
// F1 (review-found bug): when the raw history ends in an assistant final_answer — the NORMAL
// idle state (小腻 finished replying, then went idle/asleep) — the heartbeat appended a DURABLE
// self-continuation tail (buildUserSceneInputItem, role:'user', no cache_volatile). A notify-
// driven wake run is queue-backed and does NOT append it (shouldAllowSelfContinuationOnTerminal
// FinalAnswer requires !queueBacked), so its durable prefix is [..history]. The heartbeat warmed
// [..history, self-cont]; the notify wake's [..history] was never written as a breakpoint →
// longest-prefix-match falls back to [system+tools] → COLD-READS the whole history. The heartbeat
// must warm [..history] (== the notify wake), NOT over-extend. AND it must STILL HOLD as a
// heartbeat (max_output_tokens=1, store=false, ends with the 'Return exactly: 1' dev item).
// =====================================================================================
test('F1: heartbeat does NOT over-extend with a self-continuation tail on final_answer history (== notify wake; still a valid heartbeat)', async () => {
  const store = buildHeartbeatScenarioStore();
  // Make the raw history END in an assistant final_answer (the last BLOCK) so the
  // self-continuation predicate fires.
  const finalAnswerBlocks = [100, 200].map((stackIndex) => ({
    stack_index: stackIndex, stackIndex, item_kind: 'runtime_input', itemKind: 'runtime_input',
    visibility: 'model_visible',
    content: { input_items: stackIndex === 200
      ? [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '答完了。' }] }]
      : [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `历史消息-${stackIndex}` }] }] }
  }));
  store.listAgentStackItems = async (params: any) => {
    const after = params.afterStackIndex ?? null;
    const floor = after === null || typeof after === 'undefined' ? -Infinity : Number(after);
    return finalAnswerBlocks.filter((b) => b.stack_index > floor).map((b) => ({ ...b }));
  };
  const service = new AgentLoopService(store, { resolveForQueueMessage: async () => createRuntimePrompt() } as any);
  (service as any).executeTool = async () => ({ success: true, output: 'ok', message_type: 'tool_result' });

  const previousMax = agentConfig.cacheHeartbeatMaxOutputTokens;
  agentConfig.cacheHeartbeatMaxOutputTokens = 1;
  let heartbeatReq: any = null;
  const restoreFetch = interceptHeartbeatFetch((r) => { heartbeatReq = r; });
  const wakeInputs: any[][] = [];
  (service as any).executeAgentTurn = async (canonicalRequest: any) => {
    wakeInputs.push(canonicalRequest.input || []);
    return { success: true, llm_call_id: 'wake-1', llm_request_slice_id: 'wakes-1',
      canonical_response: { output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '好。' }] }] } };
  };

  try {
    await service.triggerCacheHeartbeatForDebug();
    // A NOTIFY-driven wake run (queueBacked, the common "someone messaged her" wake).
    const wake = { id: 'run-NWAKE', traceId: 'rt-NWAKE', batchId: 'b-NWAKE', status: 'processing',
      attempts: 1, maxAttempts: 3, queueMessageIds: [1], createdAt: '2026-06-29T08:00:00.000Z', payload: baseQueuePayload({ traceId: 'rt-NWAKE', runId: 'run-NWAKE' }) };
    await (service as any).processRuntimeFrame(wake, { queueBacked: true });
  } finally {
    restoreFetch();
    agentConfig.cacheHeartbeatMaxOutputTokens = previousMax;
  }

  assert.ok(heartbeatReq && wakeInputs.length >= 1, 'heartbeat + notify wake must have dispatched');
  // The heartbeat STILL HOLDS as a heartbeat (the user's caveat): tiny output, no persist, and it
  // ends with the 'Return exactly: 1' developer item that makes max_output_tokens=1 valid.
  assert.ok(heartbeatReq.max_output_tokens <= 16, 'heartbeat must keep a tiny output budget');
  assert.equal(heartbeatReq.store, false, 'heartbeat must not persist');
  const hbDurable = stripVolatile(heartbeatReq.input || []);
  assert.ok(JSON.stringify(hbDurable[hbDurable.length - 1] || {}).includes('Heartbeat'),
    'heartbeat must still end with the Heartbeat / "Return exactly: 1" developer item');

  // THE FIX CONTRACT: drop the heartbeat dev tail and the remaining durable prefix must EQUAL the
  // notify wake's durable prefix BYTE-FOR-BYTE (two-directional, not one-way ordered-prefix) — i.e.
  // the heartbeat warms exactly [..history], with NO extra self-continuation item.
  const hbWarmedPrefix = hbDurable.slice(0, -1); // drop the trailing heartbeat dev item
  const wakeDurable = stripVolatile(wakeInputs[0]);
  assert.equal(JSON.stringify(hbWarmedPrefix), JSON.stringify(wakeDurable),
    'heartbeat must warm exactly the notify-wake durable prefix (no self-continuation over-extension)');
});

// =====================================================================================
// RUN-BOUNDARY SLIDING-FLOOR 击穿 (regression for 2026-06-30 incident).
//
// PURPOSE (not implementation): two consecutive runs over the SAME compressed epoch
// (the read cutoff does NOT move between them) must read the stack from the SAME floor,
// so run N+1's durable history prefix is byte-identical to run N's at block 0 → the
// next run's first turn hits the warm cache. The ONLY thing that may move the floor is
// a compression commit (which legitimately costs one STW cold frame).
//
// THE BUG this guards: loadStackHistoryBlocks floored the read at
// max(cutoffStackIndex, head - STACK_HISTORY_READ_BACKSTOP_BLOCKS). `head` grows ~2
// blocks per turn, so once the cutoff is >200 blocks behind head, the head-relative term
// wins and the window FRONT slides UP by however many blocks were appended since the
// prior run. The dropped front blocks make run N+1's durable prefix diverge at the first
// retained block → the entire message-tier prefix cold-reads at EVERY run boundary
// (observed: cache_read pinned at the system+tools head ~12249, cache_creation 64-75k on
// every fresh run's turn 1).
//
// WHY THE OLD SUITE MISSED IT: every prior harness either passed afterStackIndex through
// without growing `head` across a run boundary, or served a fixed history list. None
// drove TWO runs through loadStackHistoryBlocks with getAgentStackHead returning a LARGER
// head on run 2 while the cutoff stayed put — the exact condition that makes the
// head-relative floor override the stable cutoff. This test grows head across the boundary
// through the REAL floor math.
// =====================================================================================
test('run boundary: stable cutoff → next run reads from the SAME floor (no sliding-backstop 击穿)', async () => {
  // A long frozen stack: indices 1..400, each a model-visible block. The compression
  // cutoff sits at 100 and does NOT move. Head will be read as 360 on run 1 and 392 on
  // run 2 — both >300 blocks past the cutoff, so the OLD floor max(100, head-200) would
  // slide from 160 to 192 (front blocks 161..192 silently dropped on run 2).
  const FROZEN_CUTOFF = 100;
  const stack: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= 400; i += 1) {
    // Alternate the block role/kind so the front-of-window block KIND (which decides
    // whether it merges into message[0]) actually depends on where the floor lands —
    // i.e. a slid floor genuinely changes the assembled prefix, not just its length.
    const isUserInput = i % 3 === 0;
    stack.push({
      stack_index: i, stackIndex: i,
      item_kind: isUserInput ? 'runtime_input' : 'assistant_output',
      itemKind: isUserInput ? 'runtime_input' : 'assistant_output',
      role: isUserInput ? 'user' : 'assistant',
      visibility: 'model_visible',
      content: { input_items: [{
        type: 'message',
        role: isUserInput ? 'user' : 'assistant',
        content: [{ type: isUserInput ? 'input_text' : 'output_text', text: `历史块-${i}` }]
      }] }
    });
  }

  let headToReturn = 360;
  const store: any = {
    getAgentStackHead: async () => headToReturn,
    getSessionReadCutoffState: async () => ({
      readCutoffAfterStackIndex: FROZEN_CUTOFF, contextSummary: '近况', pendingProactiveShare: null, pendingProactiveShareAge: 0
    }),
    listAgentStackItems: async (params: any) => {
      const after = params.afterStackIndex ?? params.after_stack_index ?? null;
      const floor = after === null || typeof after === 'undefined' ? -Infinity : Number(after);
      return stack.filter((row) => Number(row.stack_index) > floor).map((row) => ({ ...row }));
    }
  };

  const service = new AgentLoopService(store, {
    resolveForQueueMessage: async () => createRuntimePrompt()
  } as any);

  // Run 1: head = 360. Run 2 (boundary): head grew to 392 (32 blocks appended), cutoff unchanged.
  const cutoffState = await store.getSessionReadCutoffState();

  headToReturn = 360;
  const run1History = await (service as any).loadStackHistoryBlocks(cutoffState, 'rt-run1');
  headToReturn = 392;
  const run2History = await (service as any).loadStackHistoryBlocks(cutoffState, 'rt-run2');

  // THE CONTRACT: the floor is the cutoff on BOTH runs, so both windows START at the same
  // frozen block (cutoff + 1 = 101). The front is byte-identical; run 2 only EXTENDS the tail.
  assert.ok(run1History.length > 0 && run2History.length > 0, 'both runs must retain history');
  assert.equal(
    (run1History[0] as any).id, FROZEN_CUTOFF + 1,
    `run 1 window must start at the cutoff floor (${FROZEN_CUTOFF + 1}), got ${(run1History[0] as any).id}`
  );
  assert.equal(
    (run2History[0] as any).id, FROZEN_CUTOFF + 1,
    `run 2 window must start at the SAME cutoff floor (${FROZEN_CUTOFF + 1}), not a slid head-relative floor — got ${(run2History[0] as any).id}`
  );

  // Build the actual provider input for each run and assert run 2's durable prefix is a
  // byte-identical ordered prefix of run 1's (i.e. the cacheable message-tier prefix is
  // reusable across the boundary — the warm cache survives, no full cold read).
  const payload = baseQueuePayload({ traceId: 'rt-run2', runId: 'run-2' });
  const run1Input = buildInitialInput(run1History, payload as any, createRuntimePrompt(), [], '近况');
  const run2Input = buildInitialInput(run2History, payload as any, createRuntimePrompt(), [], '近况');
  assertOrderedPrefix(
    stripVolatile(run1Input), stripVolatile(run2Input),
    'run boundary: run 2 durable prefix must be a byte-identical ordered prefix of run 1 (no sliding-floor 击穿)'
  );
});
