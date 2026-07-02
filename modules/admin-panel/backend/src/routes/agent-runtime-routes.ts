import express from 'express';
import axios from 'axios';
import winston from 'winston';
import fs from 'fs/promises';
import path from 'path';
import {
  classifyRuntimePath,
  extractPassiveRecallCuesFromActionStream,
  getXiaoniActionStream,
  getXiaoniActivityFeed,
  getXiaoniLlmUsageTimeline,
  findXiaoniActionEventTraceTarget,
  enqueueAgentQueueMessage,
  getAgentLifeState,
  getAgentRuntimeControl,
  getLatestUnreadAgentInboundMessage,
  listAgentLifeEvents,
  listAgentMediaAssets,
  listAgentRecoverySessions,
  listToolExecutions,
  listAgentTasks,
  updateAgentRuntimeControl,
} from '@qq-bot/persistence';
import { DatabaseManager } from '../services/database';
import {
  buildStackTracePayload,
  buildStackTraceSpanDetail,
  buildStackRawProviderTrace
} from '../services/trace-span-builder';

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || 'http://qqbot-agent-service:8092';
const AGENT_REQUEST_TIMEOUT_MS = 5000;
const XIAONI_RUNTIME_ROOT = process.env.XIAONI_RUNTIME_ROOT || '/home/liahua/.qqbot-local/xiaoni-runtime';
const XIAONI_RUNTIME_CANONICAL_ROOT = '/xiaoni-runtime';
const XIAONI_PASSIVE_RECALL_FILE_DIRS = ['forever', 'notes', 'reading', 'toys'];
const XIAONI_PASSIVE_RECALL_MAX_SCAN_ENTRIES = 3000;
const ACTION_STREAM_RANGE_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
};

type AgentProbeResult =
  | {
      ok: true;
      statusCode: number;
      payload: Record<string, unknown>;
      error?: never;
    }
  | {
      ok: false;
      statusCode: number | null;
      payload?: never;
      error: string;
    };

type ActionEventTraceTarget = {
  conversationId: string | null;
  traceId: string | null;
  spanId: string | null;
  internalExecutionLeaseId?: string | null;
  llmRequestSliceId?: string | null;
  toolCallId?: string | null;
  stackItemId?: string | null;
  sourceKind?: string | null;
  forkRunId?: string | null;
};

type RuntimeFileShadowCandidate = {
  source: 'runtime_file';
  cueClass: 'file_shadow_candidate';
  path: string;
  relativePath: string;
  runtimeDir: string | null;
  basename: string | null;
  extension: string | null;
  sizeBytes: number;
  mtime: string;
  safeEmbeddingText: string;
  preview: string | null;
};

type InboundMessageRow = Record<string, unknown>;

async function probeAgentService(): Promise<AgentProbeResult> {
  return axios
    .get(`${AGENT_SERVICE_URL}/health`, {
      timeout: AGENT_REQUEST_TIMEOUT_MS,
      validateStatus: () => true
    })
    .then<AgentProbeResult>((response) => {
      if (response.status >= 200 && response.status < 300) {
        return {
          ok: true,
          statusCode: response.status,
          payload: response.data && typeof response.data === 'object'
            ? response.data as Record<string, unknown>
            : {}
        };
      }

      return {
        ok: false,
        statusCode: response.status,
        error: `agent-service health check returned HTTP ${response.status}`
      };
    })
    .catch<AgentProbeResult>((error) => ({
      ok: false,
      statusCode: null,
      error: error instanceof Error ? error.message : 'Unknown agent-service health check error'
    }));
}

function decodeEventId(raw: string) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function firstQueryString(value: unknown): string | null {
  if (Array.isArray(value)) {
    return firstQueryString(value[0]);
  }
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseQueryStringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    if (Array.isArray(entry)) {
      for (const nested of parseQueryStringList(entry)) {
        if (!seen.has(nested)) {
          seen.add(nested);
          result.push(nested);
        }
      }
      continue;
    }
    if (typeof entry !== 'string') {
      continue;
    }
    for (const raw of entry.split(',')) {
      const trimmed = raw.trim().toLowerCase();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
    }
  }
  return result;
}

function parseQueryDate(value: unknown): Date | null {
  const raw = firstQueryString(value);
  if (!raw) {
    return null;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function resolveActionStreamTimeFilter(query: express.Request['query']) {
  const range = firstQueryString(query.range) || 'all';
  if (Object.prototype.hasOwnProperty.call(ACTION_STREAM_RANGE_MS, range)) {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - ACTION_STREAM_RANGE_MS[range]);
    return {
      range,
      startTime,
      endTime
    };
  }

  const startTime = parseQueryDate(query.start_time ?? query.startTime);
  const endTime = parseQueryDate(query.end_time ?? query.endTime);
  return {
    range: range === 'custom' ? 'custom' : 'all',
    startTime,
    endTime
  };
}

function serializeActionStreamTimeFilter(filter: ReturnType<typeof resolveActionStreamTimeFilter>) {
  return {
    range: filter.range,
    startTime: filter.startTime ? filter.startTime.toISOString() : null,
    endTime: filter.endTime ? filter.endTime.toISOString() : null
  };
}

function parseQueryBoolean(value: unknown, fallback = false): boolean {
  const raw = firstQueryString(value);
  if (!raw) {
    return fallback;
  }
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

function parseNonNegativeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  if (!/^\d+$/.test(value.trim())) {
    return null;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePositiveInteger(value: unknown, fallback: number, max: number): number {
  const parsed = parseNonNegativeInteger(value);
  if (!parsed || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function trimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function boolFromRow(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function stringFromRow(row: InboundMessageRow, camelKey: string, snakeKey: string, fallback = ''): string {
  const value = row[camelKey] ?? row[snakeKey];
  return typeof value === 'string' ? value : fallback;
}

function numberFromRow(row: InboundMessageRow, camelKey: string, snakeKey: string): number {
  const value = row[camelKey] ?? row[snakeKey];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function objectFromRow(row: InboundMessageRow, camelKey: string, snakeKey: string): Record<string, unknown> {
  const value = row[camelKey] ?? row[snakeKey];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function truncateNotificationPreview(text: string, maxChars = 20): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  const chars = Array.from(normalized);
  return chars.length > maxChars
    ? `${chars.slice(0, maxChars).join('')}...`
    : normalized;
}

function buildManualRecoveryPhoneNotification(row: InboundMessageRow, now = Date.now()) {
  const id = numberFromRow(row, 'id', 'id');
  const chatType = stringFromRow(row, 'chatType', 'chat_type') === 'direct' ? 'direct' : 'group';
  const sessionKey = stringFromRow(row, 'sessionKey', 'session_key');
  const peerId = stringFromRow(row, 'peerId', 'peer_id');
  const peerName = trimmedString(row.peerName ?? row.peer_name);
  const senderId = stringFromRow(row, 'senderId', 'sender_id');
  const senderName = trimmedString(row.senderName ?? row.sender_name);
  const accountId = stringFromRow(row, 'accountId', 'account_id');
  const messageSid = stringFromRow(row, 'messageSid', 'message_sid', String(id));
  const bodyForAgent = stringFromRow(row, 'bodyForAgent', 'body_for_agent');
  const rawBody = stringFromRow(row, 'rawBody', 'raw_body');
  const commandBody = stringFromRow(row, 'commandBody', 'command_body');
  const receivedAt = row.receivedAt ?? row.received_at ?? new Date().toISOString();
  const messageTimestamp = row.messageTimestamp ?? row.message_timestamp ?? null;
  const wasMentioned = boolFromRow(row.wasMentioned ?? row.was_mentioned);
  const displayPeerName = peerName || (chatType === 'group' ? `群 ${peerId}` : `QQ ${peerId}`);
  const sourcePreview = truncateNotificationPreview(bodyForAgent || rawBody);
  const summary = chatType === 'group'
    ? `${displayPeerName} 有未读 QQ 消息${wasMentioned ? '，其中有人 @ 小腻' : ''}。`
    : `${displayPeerName} 发来未读 QQ 私聊。`;
  const preview = chatType === 'group' && !wasMentioned
    ? summary
    : (bodyForAgent || rawBody || commandBody || summary);
  const notificationId = `phone:manual-recover:${id}:${now}`;
  const inboundContext = {
    ...objectFromRow(row, 'inboundContext', 'inbound_context'),
    Body: preview,
    BodyForAgent: preview,
    BodyForCommands: '',
    RawBody: preview,
    CommandBody: '',
    Surface: 'phone_notification',
    MessageSid: notificationId,
    WasMentioned: wasMentioned,
    CommandAuthorized: false
  };

  return {
    traceId: `manual_recover_${now}_${id}`,
    source: 'phone_notification',
    messageId: id,
    messageSid: notificationId,
    dedupeKey: `phone_notification:manual_recover:${id}:${now}`,
    chatType,
    sessionKey,
    peerId,
    peerName,
    senderId: 'qq',
    senderName: 'QQ',
    accountId,
    bodyForAgent: preview,
    rawBody: preview,
    commandBody: '',
    wasMentioned,
    receivedAt,
    messageTimestamp,
    rawPayload: {
      kind: 'phone_notification',
      app: 'qq',
      reason: 'manual_recover_after_provider_outage',
      source: 'manual_recover',
      source_message_id: id,
      source_message_sid: messageSid,
      session_key: sessionKey,
      chat_type: chatType,
      peer_id: peerId,
      peer_name: peerName,
      latest_sender_id: senderId,
      latest_sender_name: senderName,
      latest_preview: sourcePreview,
      source_preview: sourcePreview,
      unread_delta: 1,
      direct_mentions: wasMentioned ? 1 : 0,
      latest_received_at: receivedAt
    },
    inboundContext,
    phoneNotification: {
      app: 'qq',
      notificationId,
      sessionKey,
      chatType,
      peerId,
      peerName,
      unreadDelta: 1,
      directMentions: wasMentioned ? 1 : 0,
      latestReceivedAt: receivedAt,
      reason: 'manual_recover_after_provider_outage'
    }
  };
}

function compactFilePreview(value: string, maxLength = 1200): string | null {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return null;
  }
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function toCanonicalRuntimePath(runtimeRoot: string, absolutePath: string): string | null {
  const relativePath = path.relative(runtimeRoot, absolutePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  return `${XIAONI_RUNTIME_CANONICAL_ROOT}/${relativePath.split(path.sep).join('/')}`;
}

async function readRuntimeFilePreview(absolutePath: string): Promise<string | null> {
  try {
    const handle = await fs.open(absolutePath, 'r');
    try {
      const buffer = Buffer.alloc(4096);
      const result = await handle.read(buffer, 0, buffer.length, 0);
      return compactFilePreview(buffer.slice(0, result.bytesRead).toString('utf8'));
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function collectRuntimeFileCandidates(options: {
  limit: number;
  runtimeRoot?: string;
}): Promise<{
  runtimeRoot: string;
  available: boolean;
  candidates: RuntimeFileShadowCandidate[];
  error: string | null;
}> {
  const runtimeRoot = options.runtimeRoot || XIAONI_RUNTIME_ROOT;
  const files: Array<{
    absolutePath: string;
    canonicalPath: string;
    stat: { size: number; mtime: Date };
  }> = [];
  let visited = 0;

  async function visit(dir: string, depth: number): Promise<void> {
    if (visited >= XIAONI_PASSIVE_RECALL_MAX_SCAN_ENTRIES || depth > 8) {
      return;
    }
    visited += 1;
    let entries: Array<{
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
    }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (visited >= XIAONI_PASSIVE_RECALL_MAX_SCAN_ENTRIES) {
        return;
      }
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
        continue;
      }
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const canonicalPath = toCanonicalRuntimePath(runtimeRoot, absolutePath);
      if (!canonicalPath) {
        continue;
      }
      const classified = classifyRuntimePath(canonicalPath);
      if (!classified?.indexable) {
        continue;
      }
      try {
        const stat = await fs.stat(absolutePath);
        files.push({
          absolutePath,
          canonicalPath,
          stat: {
            size: stat.size,
            mtime: stat.mtime
          }
        });
      } catch {
        continue;
      }
    }
  }

  try {
    const rootStat = await fs.stat(runtimeRoot);
    if (!rootStat.isDirectory()) {
      return {
        runtimeRoot,
        available: false,
        candidates: [],
        error: 'Xiaoni runtime root is not a directory'
      };
    }
  } catch (error) {
    return {
      runtimeRoot,
      available: false,
      candidates: [],
      error: error instanceof Error ? error.message : 'Xiaoni runtime root is unavailable'
    };
  }

  await Promise.all(XIAONI_PASSIVE_RECALL_FILE_DIRS.map((dir) => visit(path.join(runtimeRoot, dir), 1)));
  files.sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());

  const selected = files.slice(0, options.limit);
  const candidates = await Promise.all(selected.map(async (file): Promise<RuntimeFileShadowCandidate | null> => {
    const classified = classifyRuntimePath(file.canonicalPath);
    if (!classified?.indexable) {
      return null;
    }
    const preview = await readRuntimeFilePreview(file.absolutePath);
    return {
      source: 'runtime_file',
      cueClass: 'file_shadow_candidate',
      path: classified.path,
      relativePath: classified.relativePath,
      runtimeDir: classified.runtimeDir,
      basename: classified.basename,
      extension: classified.extension,
      sizeBytes: file.stat.size,
      mtime: file.stat.mtime.toISOString(),
      safeEmbeddingText: [
        'xiaoni runtime file',
        `${classified.runtimeDir || 'unknown'} ${classified.relativePath.replace(/[._/-]+/g, ' ')}`,
        preview
      ].filter(Boolean).join('\n'),
      preview
    };
  }));

  return {
    runtimeRoot,
    available: true,
    candidates: candidates.filter((entry): entry is RuntimeFileShadowCandidate => Boolean(entry)),
    error: null
  };
}

function parseUsageBucket(value: unknown): 'call' | 'hour' | 'day' | 'month' {
  const raw = firstQueryString(value);
  return raw === 'hour' || raw === 'day' || raw === 'month' || raw === 'call'
    ? raw
    : 'call';
}

async function resolveActionEventTraceTarget(
  rawEventId: string
): Promise<ActionEventTraceTarget | null> {
  const eventId = decodeEventId(rawEventId);
  return await findXiaoniActionEventTraceTarget(eventId) as ActionEventTraceTarget | null;
}

const DEFAULT_ACTION_COST_BY_EVENT_KIND: Record<string, number> = {
  surface_visit: 0.01,
  qq_message_seen: 0,
  qq_self_message: 0,
  send_in_group: 0.01,
  silence_decision: 0.005,
  web_search_result: 0,
  pending_share_created: 0,
  pending_share_consumed: 0.002,
  presence_tick_evaluated: 0
};

function toValidDate(value: unknown): Date | null {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function finiteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeIsoDate(value: unknown): string | null {
  const date = toValidDate(value);
  return date ? date.toISOString() : null;
}

function normalizeRecoveryLifeState(row: any) {
  if (!row) {
    return null;
  }
  const projection = normalizeJsonObject(row.projection_json);
  const projectedState = normalizeJsonObject(projection.state);
  const explanation = normalizeJsonObject(row.explanation_json);
  const contributors = Array.isArray(explanation.contributors)
    ? explanation.contributors.filter((item: any) => item?.eventKind !== 'presence_tick_evaluated').slice(-5)
    : [];
  return {
    identityKey: row.identity_key || null,
    projection: {
      version: typeof projection.version === 'string' ? projection.version : null,
      generatedAt: normalizeIsoDate(projection.generatedAt),
      state: {
        energy: finiteNumber(projectedState.energy),
        actionCost: finiteNumber(projectedState.actionCost)
      }
    },
    explanation: {
      summary: typeof explanation.summary === 'string' ? explanation.summary : null,
      generatedAt: normalizeIsoDate(explanation.generatedAt),
      contributors
    },
    reducedThroughEventId: row.reduced_through_event_id === null || typeof row.reduced_through_event_id === 'undefined'
      ? null
      : String(row.reduced_through_event_id),
    reducedThroughOccurredAt: normalizeIsoDate(row.reduced_through_occurred_at),
    projectionVersion: row.projection_version || null,
    projectionUpdatedAt: normalizeIsoDate(row.projection_updated_at),
    updatedAt: normalizeIsoDate(row.updated_at)
  };
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function normalizeEnergy(value: unknown, maxEnergy: unknown = 1): number | null {
  const energy = finiteNumber(value);
  if (energy === null) {
    return null;
  }
  const max = Math.max(0.001, finiteNumber(maxEnergy) ?? 1);
  return clamp01(energy / max);
}

function eventPayload(event: any): Record<string, unknown> {
  return event?.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload
    : {};
}

function isCorrectedZeroSleepEvent(payload: Record<string, unknown>) {
  const sleepMinutes = finiteNumber(payload.sleep_minutes ?? payload.sleepMinutes);
  return (payload.timestamp_corrected === true || payload.wake_cause === 'timestamp_corrected')
    && (sleepMinutes === null || sleepMinutes <= 0);
}

function resolveTimelineStart(sessions: any[]) {
  const firstSessionAt = sessions
    .map((session) => toValidDate(session?.startedAt))
    .filter((date): date is Date => Boolean(date))
    .sort((left, right) => left.getTime() - right.getTime())[0];
  return firstSessionAt || new Date(Date.now() - 24 * 60 * 60 * 1000);
}

function parseBoundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function parseOptionalDate(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const date = new Date(value.trim());
  return Number.isFinite(date.getTime()) ? date : null;
}

function currentProjectionEnergy(current: any) {
  return normalizeEnergy(current?.lifeState?.projection?.state?.energy, 1);
}

function currentProjectionTimestamp(current: any) {
  return toValidDate(
    current?.lifeState?.projectionUpdatedAt
      || current?.lifeState?.projection?.generatedAt
      || current?.lifeState?.updatedAt
      || current?.latestActivityAt
  );
}

function recoverEnergyResult(tool: any): Record<string, unknown> {
  return tool?.result && typeof tool.result === 'object' && !Array.isArray(tool.result)
    ? tool.result
    : {};
}

function recoverEnergyRequestStatus(tool: any) {
  const result = recoverEnergyResult(tool);
  if (result.rest_rejected === true) {
    return 'rejected';
  }
  if (result.recovery_session_requested === true) {
    return 'accepted';
  }
  if (result.recovered === true) {
    return 'completed';
  }
  return tool?.status || 'unknown';
}

function summarizeRecoverEnergyRequests(tools: any[], pagination?: Record<string, unknown>) {
  const requests = tools.map((tool) => {
    const result = recoverEnergyResult(tool);
    const args = tool?.arguments && typeof tool.arguments === 'object' && !Array.isArray(tool.arguments)
      ? tool.arguments
      : {};
    return {
      id: tool.executionId || tool.id || null,
      toolExecutionId: tool.executionId || null,
      toolCallId: tool.toolCallId || null,
      traceId: tool.traceId || null,
      runId: tool.runId || null,
      status: recoverEnergyRequestStatus(tool),
      restRejected: result.rest_rejected === true,
      reason: typeof result.reason === 'string' && result.reason.trim()
        ? result.reason.trim()
        : (typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : null),
      requestedReason: typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : null,
      xiaoniOs: typeof result.xiaoni_os === 'string' && result.xiaoni_os.trim()
        ? result.xiaoni_os.trim()
        : (typeof args.xiaoni_os === 'string' && args.xiaoni_os.trim() ? args.xiaoni_os.trim() : null),
      energy: finiteNumber(result.energy ?? result.energy_start ?? result.energy_before),
      maxEnergy: finiteNumber(result.max_energy) ?? 1,
      pressure: finiteNumber(result.pressure),
      requiredPressure: finiteNumber(result.required_pressure),
      clockMinutes: finiteNumber(result.clock_minutes),
      startedAt: tool.startedAt || tool.createdAt || null,
      completedAt: tool.completedAt || null
    };
  });
  return {
    requests,
    ...(pagination ? { pagination } : {}),
    summary: {
      total: requests.length,
      rejected: requests.filter((request) => request.restRejected).length,
      accepted: requests.filter((request) => request.status === 'accepted').length,
      completed: requests.filter((request) => request.status === 'completed').length
    }
  };
}

function buildEnergyTimeline({
  sessions,
  events,
  recoverEnergyRequests,
  current
}: {
  sessions: any[];
  events: any[];
  recoverEnergyRequests?: any[];
  current: any;
}) {
  const items: Array<{
    timestamp: Date;
    priority: number;
    source: string;
    kind: string;
    label: string;
    recoverySessionId?: number | null;
    eventId?: string | null;
    explicitEnergy?: number | null;
    event?: any;
    recoverEnergyRequest?: any;
  }> = [];

  for (const session of sessions) {
    const maxEnergy = session?.maxEnergy ?? 1;
    const startedAt = toValidDate(session?.startedAt);
    const startEnergy = normalizeEnergy(session?.startEnergy, maxEnergy);
    if (startedAt && startEnergy !== null) {
      items.push({
        timestamp: startedAt,
        priority: 0,
        source: 'recovery_session',
        kind: 'session_start',
        label: '开始休息',
        recoverySessionId: session.id,
        explicitEnergy: startEnergy
      });
    }

    const currentAt = toValidDate(session?.endedAt || session?.lastCheckedAt || session?.updatedAt);
    const currentEnergy = normalizeEnergy(session?.currentEnergy, maxEnergy);
    if (currentAt && currentEnergy !== null) {
      items.push({
        timestamp: currentAt,
        priority: 2,
        source: 'recovery_session',
        kind: session.status === 'active' ? 'session_progress' : 'session_end',
        label: session.status === 'active' ? '休息中' : '醒来',
        recoverySessionId: session.id,
        explicitEnergy: currentEnergy
      });
    }
  }

  for (const event of events) {
    const timestamp = toValidDate(event?.occurredAt);
    if (!timestamp) {
      continue;
    }
    items.push({
      timestamp,
      priority: 1,
      source: 'life_event',
      kind: event.eventKind || 'life_event',
      label: event.eventKind || 'life_event',
      eventId: event.id || null,
      event
    });
  }

  for (const request of recoverEnergyRequests || []) {
    const timestamp = toValidDate(request?.startedAt);
    if (!timestamp) {
      continue;
    }
    const maxEnergy = request?.maxEnergy ?? 1;
    const energy = normalizeEnergy(request?.energy, maxEnergy);
    items.push({
      timestamp,
      priority: request.restRejected ? 2 : 1,
      source: 'tool_execution',
      kind: request.restRejected ? 'recover_energy_rejected' : `recover_energy_${request.status || 'requested'}`,
      label: request.restRejected ? '拒绝休息' : '请求休息',
      explicitEnergy: energy,
      recoverEnergyRequest: request
    });
  }

  const projectionAt = currentProjectionTimestamp(current);
  const projectedEnergy = currentProjectionEnergy(current);
  if (projectionAt && projectedEnergy !== null) {
    items.push({
      timestamp: projectionAt,
      priority: 3,
      source: 'life_projection',
      kind: 'current_projection',
      label: '当前投影',
      explicitEnergy: projectedEnergy
    });
  }

  items.sort((left, right) => {
    const timeDelta = left.timestamp.getTime() - right.timestamp.getTime();
    return timeDelta || left.priority - right.priority;
  });

  let actionCost: number | null = null;
  const points: Array<Record<string, unknown>> = [];
  const addPoint = (item: typeof items[number], energy: number) => {
    const normalizedEnergy = clamp01(energy);
    const timestampMs = item.timestamp.getTime();
    points.push({
      key: `${item.source}:${item.kind}:${item.recoverySessionId ?? item.eventId ?? timestampMs}:${points.length}`,
      timestamp: item.timestamp.toISOString(),
      timestampMs,
      energy: normalizedEnergy,
      actionCost: clamp01(1 - normalizedEnergy),
      source: item.source,
      kind: item.kind,
      label: item.label,
      recoverySessionId: item.recoverySessionId ?? null,
      eventId: item.eventId ?? null,
      restRejected: item.recoverEnergyRequest?.restRejected === true,
      rejectionReason: item.recoverEnergyRequest?.restRejected === true ? item.recoverEnergyRequest?.reason || null : null,
      requestedReason: item.recoverEnergyRequest?.requestedReason || null,
      pressure: item.recoverEnergyRequest?.pressure ?? null,
      requiredPressure: item.recoverEnergyRequest?.requiredPressure ?? null,
      toolExecutionId: item.recoverEnergyRequest?.toolExecutionId ?? null,
      toolCallId: item.recoverEnergyRequest?.toolCallId ?? null,
      traceId: item.recoverEnergyRequest?.traceId ?? null
    });
  };

  for (const item of items) {
    if (typeof item.explicitEnergy === 'number') {
      actionCost = clamp01(1 - item.explicitEnergy);
      addPoint(item, item.explicitEnergy);
      continue;
    }

    const event = item.event;
    if (!event) {
      continue;
    }
    const payload = eventPayload(event);
    if (event.eventKind === 'sleep_period') {
      const eventEnergy = normalizeEnergy(payload.energy, payload.max_energy ?? 1);
      if (isCorrectedZeroSleepEvent(payload)) {
        if (eventEnergy !== null) {
          actionCost = clamp01(1 - eventEnergy);
          addPoint({ ...item, label: '恢复记录修正' }, eventEnergy);
        }
        continue;
      }
      if (eventEnergy !== null) {
        actionCost = clamp01(1 - eventEnergy);
        addPoint({ ...item, label: '休息恢复' }, eventEnergy);
        continue;
      }
      if (actionCost !== null) {
        actionCost = clamp01(actionCost - 0.2);
        addPoint({ ...item, label: '休息恢复' }, 1 - actionCost);
      }
      continue;
    }

    if (actionCost === null) {
      continue;
    }

    if (event.eventKind === 'rest_period') {
      actionCost = clamp01(actionCost - 0.1);
      addPoint({ ...item, label: '短暂休息' }, 1 - actionCost);
      continue;
    }

    const explicitCost = Math.max(0, finiteNumber(event.actionCost) ?? 0);
    const resolvedCost = explicitCost > 0
      ? explicitCost
      : DEFAULT_ACTION_COST_BY_EVENT_KIND[event.eventKind] ?? 0;
    if (resolvedCost > 0) {
      actionCost = clamp01(actionCost + resolvedCost);
      addPoint(item, 1 - actionCost);
    }
  }

  const energies = points
    .map((point) => finiteNumber(point.energy))
    .filter((value): value is number => value !== null);
  const latest = points[points.length - 1] || null;
  return {
    generatedAt: new Date().toISOString(),
    points,
    summary: {
      pointCount: points.length,
      minEnergy: energies.length ? Math.min(...energies) : null,
      maxEnergy: energies.length ? Math.max(...energies) : null,
      latestEnergy: latest ? latest.energy : null,
      latestTimestamp: latest ? latest.timestamp : null
    }
  };
}

export function createAgentRuntimeRoutes(database: DatabaseManager, logger: winston.Logger) {
  const router = express.Router();

  async function loadRuntimeSnapshot() {
    const agentProbe = await probeAgentService();
    const agentPayload = agentProbe.ok ? agentProbe.payload : {};
    return {
      live: agentProbe.ok,
      status: agentProbe.ok ? agentPayload.status || 'unknown' : 'offline',
      service: agentProbe.ok ? agentPayload.service || 'agent-service' : 'agent-service',
      workerBusy: Boolean(agentPayload.worker_busy),
      taskWorkerBusy: Boolean(agentPayload.task_worker_busy),
      presenceTickBusy: Boolean(agentPayload.presence_tick_busy),
      runtimeEnabled: agentPayload.runtime_enabled !== false,
      timestamp: typeof agentPayload.timestamp === 'string' ? agentPayload.timestamp : null,
      url: AGENT_SERVICE_URL,
      healthStatusCode: agentProbe.statusCode,
      errorMessage: agentProbe.ok ? null : agentProbe.error
    };
  }

  router.get('/xiaoni/action-stream', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, Number.parseInt(String(req.query.limit || '80'), 10) || 80));
      const identityKey = typeof req.query.identity_key === 'string' && req.query.identity_key.trim()
        ? req.query.identity_key.trim()
        : 'xiaoni';
      const timeFilter = resolveActionStreamTimeFilter(req.query);
      const beforeTime = parseQueryDate(req.query.before_time ?? req.query.beforeTime ?? req.query.before);
      const tags = parseQueryStringList(req.query.tags ?? req.query.tag);
      const [stream, runtime] = await Promise.all([
        getXiaoniActionStream({
          identityKey,
          limit,
          startTime: timeFilter.startTime,
          endTime: timeFilter.endTime,
          beforeTime,
          tags,
          focusEvent: firstQueryString(req.query.focus_event ?? req.query.focusEvent),
          focusSlice: firstQueryString(req.query.focus_slice ?? req.query.focusSlice)
        }),
        loadRuntimeSnapshot()
      ]);

      res.json({
        success: true,
        data: {
          ...stream,
          filters: {
            ...(typeof stream === 'object' && stream && 'filters' in stream ? (stream as Record<string, unknown>).filters as Record<string, unknown> : {}),
            ...serializeActionStreamTimeFilter(timeFilter),
            tags
          },
          current: {
            ...stream.current,
            runtime
          }
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load Xiaoni action stream',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.get('/xiaoni/passive-recall/shadow-cues', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, Number.parseInt(String(req.query.limit || '80'), 10) || 80));
      const identityKey = typeof req.query.identity_key === 'string' && req.query.identity_key.trim()
        ? req.query.identity_key.trim()
        : 'xiaoni';
      const timeFilter = resolveActionStreamTimeFilter(req.query);
      const beforeTime = parseQueryDate(req.query.before_time ?? req.query.beforeTime ?? req.query.before);
      const tags = parseQueryStringList(req.query.tags ?? req.query.tag);
      const includeFiles = parseQueryBoolean(req.query.include_files ?? req.query.includeFiles, true);
      const fileLimit = parsePositiveInteger(req.query.file_limit ?? req.query.fileLimit, 20, 100);
      const [stream, fileSource] = await Promise.all([
        getXiaoniActionStream({
          identityKey,
          limit,
          startTime: timeFilter.startTime,
          endTime: timeFilter.endTime,
          beforeTime,
          tags,
          focusEvent: firstQueryString(req.query.focus_event ?? req.query.focusEvent),
          focusSlice: firstQueryString(req.query.focus_slice ?? req.query.focusSlice)
        }),
        includeFiles
          ? collectRuntimeFileCandidates({ limit: fileLimit })
          : Promise.resolve({
            runtimeRoot: XIAONI_RUNTIME_ROOT,
            available: false,
            candidates: [],
            error: null
          })
      ]);
      const items = Array.isArray(stream.items) ? stream.items as Array<Record<string, unknown>> : [];
      const cues = extractPassiveRecallCuesFromActionStream(items);
      const cueCounts = cues.reduce((acc, cue) => {
        const key = cue.cueClass || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      res.json({
        success: true,
        data: {
          identityKey: stream.identityKey,
          generatedAt: stream.generatedAt,
          streamKind: 'xiaoni_passive_recall_shadow_cues',
          deliveryMode: 'shadow_only',
          filters: {
            ...(typeof stream === 'object' && stream && 'filters' in stream ? (stream as Record<string, unknown>).filters as Record<string, unknown> : {}),
            ...serializeActionStreamTimeFilter(timeFilter),
            tags,
            includeFiles,
            fileLimit
          },
          pagination: stream.pagination || {
            limit,
            hasMore: false,
            nextCursor: null
          },
          counts: {
            ...cueCounts,
            file_shadow_candidate: fileSource.candidates.length
          },
          sources: {
            actionStream: {
              totalItems: items.length,
              cueCount: cues.length
            },
            runtimeFiles: {
              runtimeRoot: fileSource.runtimeRoot,
              available: fileSource.available,
              candidateCount: fileSource.candidates.length,
              error: fileSource.error
            }
          },
          cues,
          fileCandidates: fileSource.candidates
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load Xiaoni passive recall shadow cues',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.get('/xiaoni/action-stream/llm-usage', async (req, res) => {
    try {
      const identityKey = typeof req.query.identity_key === 'string' && req.query.identity_key.trim()
        ? req.query.identity_key.trim()
        : 'xiaoni';
      const timeFilter = resolveActionStreamTimeFilter(req.query);
      const maxPoints = Math.max(100, Math.min(2000, Number.parseInt(String(req.query.max_points || req.query.maxPoints || '1200'), 10) || 1200));
      const timeline = await getXiaoniLlmUsageTimeline({
        identityKey,
        range: timeFilter.range,
        startTime: timeFilter.startTime,
        endTime: timeFilter.endTime,
        bucket: parseUsageBucket(req.query.bucket),
        maxPoints,
        includePeaks: parseQueryBoolean(req.query.include_peaks ?? req.query.includePeaks, true),
        includeMiniMap: parseQueryBoolean(req.query.include_minimap ?? req.query.includeMiniMap, false),
        includeOverlays: firstQueryString(req.query.include_overlays ?? req.query.includeOverlays) ?? undefined,
        searchQuery: firstQueryString(req.query.search_q ?? req.query.searchQuery)
      });

      res.json({
        success: true,
        data: {
          ...timeline,
          filters: serializeActionStreamTimeFilter(timeFilter)
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load Xiaoni LLM usage timeline',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.get('/xiaoni/action-stream/events/:eventId/trace', async (req, res) => {
    try {
      const target = await resolveActionEventTraceTarget(req.params.eventId);
      if (!target) {
        return res.status(404).json({
          success: false,
          error: 'Action event trace not found',
          timestamp: new Date().toISOString()
        });
      }

      const payload = await buildStackTracePayload(logger, target);
      if (!payload) {
        return res.status(404).json({
          success: false,
          error: 'Action event trace not available yet',
          timestamp: new Date().toISOString()
        });
      }

      res.json({
        success: true,
        data: {
          ...payload,
          action_event: {
            event_id: decodeEventId(req.params.eventId),
            focus_span_id: target.spanId,
            trace_id: target.traceId
          }
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to fetch Xiaoni action event trace', { error, eventId: req.params.eventId });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch Xiaoni action event trace',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.get('/xiaoni/action-stream/events/:eventId/trace/spans/:spanId/detail', async (req, res) => {
    try {
      const target = await resolveActionEventTraceTarget(req.params.eventId);
      if (!target) {
        return res.status(404).json({
          success: false,
          error: 'Action event trace not found',
          timestamp: new Date().toISOString()
        });
      }

      const spanId = decodeEventId(req.params.spanId);
      const detail = await buildStackTraceSpanDetail(logger, target, spanId);
      if (!detail) {
        return res.status(404).json({
          success: false,
          error: 'Action event trace span detail not found',
          timestamp: new Date().toISOString()
        });
      }

      res.json({
        success: true,
        data: detail,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to fetch Xiaoni action event trace span detail', {
        error,
        eventId: req.params.eventId,
        spanId: req.params.spanId
      });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch Xiaoni action event trace span detail',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.get('/xiaoni/action-stream/events/:eventId/raw-trace', async (req, res) => {
    try {
      const target = await resolveActionEventTraceTarget(req.params.eventId);
      if (!target) {
        return res.status(404).json({
          success: false,
          error: 'Action event raw trace not found',
          timestamp: new Date().toISOString()
        });
      }

      const requestedSpanId = firstQueryString(req.query.spanId);
      const spanId = decodeEventId(requestedSpanId || target.spanId || '');
      const rawTrace = await buildStackRawProviderTrace(logger, target, spanId);
      if (!rawTrace) {
        return res.status(404).json({
          success: false,
          error: 'Action event raw trace not available',
          timestamp: new Date().toISOString()
        });
      }

      res.setHeader('Cache-Control', 'no-store');
      res.json({
        success: true,
        data: {
          ...rawTrace,
          action_event: {
            event_id: decodeEventId(req.params.eventId),
            focus_span_id: spanId || target.spanId,
            trace_id: target.traceId
          }
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to fetch Xiaoni action event raw trace', {
        error,
        eventId: req.params.eventId,
        spanId: req.query.spanId
      });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch Xiaoni action event raw trace',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.get('/agent-runtime/control', async (_req, res) => {
    try {
      const control = await getAgentRuntimeControl({ identityKey: 'xiaoni' });
      res.json({
        success: true,
        data: control,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load Xiaoni runtime control',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.patch('/agent-runtime/control', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body as Record<string, unknown>
        : {};
      const patch: Record<string, unknown> = {
        identityKey: 'xiaoni',
      };
      if (typeof body.enabled === 'boolean') {
        patch.enabled = body.enabled;
      }
      if (typeof body.cacheHeartbeatPaused === 'boolean') {
        patch.cacheHeartbeatPaused = body.cacheHeartbeatPaused;
      }
      if (typeof body.postCompressionPauseArmed === 'boolean') {
        patch.postCompressionPauseArmed = body.postCompressionPauseArmed;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'mainAgentPreModelYieldMs')) {
        const value = parseNonNegativeInteger(body.mainAgentPreModelYieldMs);
        if (value === null) {
          res.status(400).json({
            success: false,
            error: 'mainAgentPreModelYieldMs must be a non-negative integer millisecond value',
            timestamp: new Date().toISOString()
          });
          return;
        }
        patch.mainAgentPreModelYieldMs = value;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'debugCacheHeartbeatIntervalMs')) {
        const value = parseNonNegativeInteger(body.debugCacheHeartbeatIntervalMs);
        if (value === null) {
          res.status(400).json({
            success: false,
            error: 'debugCacheHeartbeatIntervalMs must be a non-negative integer millisecond value (0 disables)',
            timestamp: new Date().toISOString()
          });
          return;
        }
        patch.debugCacheHeartbeatIntervalMs = value;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'compressionTriggerInputTokens')) {
        const value = parseNonNegativeInteger(body.compressionTriggerInputTokens);
        if (value === null || value < 10000 || value > 1000000) {
          res.status(400).json({
            success: false,
            error: 'compressionTriggerInputTokens must be an integer between 10000 and 1000000',
            timestamp: new Date().toISOString()
          });
          return;
        }
        patch.compressionTriggerInputTokens = value;
      }
      const control = await updateAgentRuntimeControl(patch);
      res.json({
        success: true,
        data: control,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update Xiaoni runtime control',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.post('/agent-runtime/recover-now', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body as Record<string, unknown>
        : {};
      const sessionKey = trimmedString(body.sessionKey ?? body.session_key);
      const resumeRuntime = body.resumeRuntime !== false && body.resume_runtime !== false;
      const unpauseCacheHeartbeat = body.unpauseCacheHeartbeat === true || body.unpause_cache_heartbeat === true;
      const controlPatch: Record<string, unknown> = {
        identityKey: 'xiaoni'
      };
      if (resumeRuntime) {
        controlPatch.enabled = true;
      }
      if (unpauseCacheHeartbeat) {
        controlPatch.cacheHeartbeatPaused = false;
      }
      const control = Object.keys(controlPatch).length > 1
        ? await updateAgentRuntimeControl(controlPatch)
        : await getAgentRuntimeControl({ identityKey: 'xiaoni' });

      const inbound = await getLatestUnreadAgentInboundMessage({
        ...(sessionKey ? { sessionKey } : {})
      });
      if (!inbound) {
        res.status(409).json({
          success: false,
          error: sessionKey
            ? `No unread QQ inbox messages found for ${sessionKey}`
            : 'No unread QQ inbox messages found to recover from',
          data: {
            control,
            sessionKey
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      const notification = buildManualRecoveryPhoneNotification(inbound);
      const queue = await enqueueAgentQueueMessage({
        message: notification,
        payload: notification,
        availableAt: new Date()
      });

      res.json({
        success: true,
        data: {
          control,
          queue,
          sourceInboundMessage: {
            id: numberFromRow(inbound, 'id', 'id'),
            sessionKey: stringFromRow(inbound, 'sessionKey', 'session_key'),
            messageSid: stringFromRow(inbound, 'messageSid', 'message_sid'),
            receivedAt: inbound.receivedAt ?? inbound.received_at ?? null
          },
          recovery: {
            kind: 'phone_notification',
            reason: 'manual_recover_after_provider_outage',
            resumedRuntime: resumeRuntime,
            unpausedCacheHeartbeat: unpauseCacheHeartbeat
          }
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to manually recover Xiaoni runtime',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.post('/agent-runtime/prompt/reload', async (_req, res) => {
    try {
      const response = await axios.post(`${AGENT_SERVICE_URL}/api/internal/runtime/prompt/reload`, {}, {
        timeout: AGENT_REQUEST_TIMEOUT_MS,
        validateStatus: () => true
      });
      const payload = response.data && typeof response.data === 'object'
        ? response.data as Record<string, unknown>
        : {};
      if (response.status < 200 || response.status >= 300 || payload.success === false) {
        res.status(response.status >= 400 ? response.status : 502).json({
          success: false,
          error: typeof payload.error === 'string'
            ? payload.error
            : `agent-service prompt reload returned HTTP ${response.status}`,
          timestamp: new Date().toISOString()
        });
        return;
      }

      res.json({
        success: true,
        data: payload.result && typeof payload.result === 'object' ? payload.result : payload,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to force-load Xiaoni runtime prompt',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.post('/agent-runtime/cache-heartbeat/trigger', async (_req, res) => {
    try {
      // Unlike the compression trigger (schedules a background fork and returns), the
      // debug heartbeat awaits a full model turn, so allow a longer timeout.
      const response = await axios.post(`${AGENT_SERVICE_URL}/api/internal/runtime/cache-heartbeat`, {}, {
        timeout: 120000,
        validateStatus: () => true
      });
      const payload = response.data && typeof response.data === 'object'
        ? response.data as Record<string, unknown>
        : {};
      if (response.status < 200 || response.status >= 300 || payload.success === false) {
        res.status(response.status >= 400 ? response.status : 502).json({
          success: false,
          error: typeof payload.error === 'string'
            ? payload.error
            : `agent-service cache heartbeat trigger returned HTTP ${response.status}`,
          timestamp: new Date().toISOString()
        });
        return;
      }

      res.json({
        success: true,
        data: payload.result && typeof payload.result === 'object' ? payload.result : payload,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to trigger Xiaoni cache heartbeat',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.post('/agent-runtime/core-memory-compression/trigger', async (_req, res) => {
    try {
      const response = await axios.post(`${AGENT_SERVICE_URL}/api/internal/runtime/core-memory-compression/trigger`, {}, {
        timeout: AGENT_REQUEST_TIMEOUT_MS,
        validateStatus: () => true
      });
      const payload = response.data && typeof response.data === 'object'
        ? response.data as Record<string, unknown>
        : {};
      if (response.status < 200 || response.status >= 300 || payload.success === false) {
        res.status(response.status >= 400 ? response.status : 502).json({
          success: false,
          error: typeof payload.error === 'string'
            ? payload.error
            : `agent-service core memory compression trigger returned HTTP ${response.status}`,
          timestamp: new Date().toISOString()
        });
        return;
      }

      res.json({
        success: true,
        data: payload.result && typeof payload.result === 'object' ? payload.result : payload,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to trigger Xiaoni core memory compression',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.get('/agent-runtime/core-memory-compression/status', async (req, res) => {
    try {
      const coveredEnd = trimmedString(
        req.query.compression_covered_end_conversation_id ?? req.query.compressionCoveredEndConversationId
      );
      if (!coveredEnd) {
        res.status(400).json({
          success: false,
          error: 'compression_covered_end_conversation_id query param required',
          timestamp: new Date().toISOString()
        });
        return;
      }
      const response = await axios.get(`${AGENT_SERVICE_URL}/api/internal/runtime/core-memory-compression/status`, {
        params: { compression_covered_end_conversation_id: coveredEnd },
        timeout: AGENT_REQUEST_TIMEOUT_MS,
        validateStatus: () => true
      });
      const payload = response.data && typeof response.data === 'object'
        ? response.data as Record<string, unknown>
        : {};
      if (response.status < 200 || response.status >= 300 || payload.success === false) {
        res.status(response.status >= 400 ? response.status : 502).json({
          success: false,
          error: typeof payload.error === 'string'
            ? payload.error
            : `agent-service core memory compression status returned HTTP ${response.status}`,
          timestamp: new Date().toISOString()
        });
        return;
      }

      res.json({
        success: true,
        data: payload.result && typeof payload.result === 'object' ? payload.result : payload,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read Xiaoni core memory compression status',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.get('/agent-runtime/activity-feed', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, Number.parseInt(String(req.query.limit || '80'), 10) || 80));
      const identityKey = typeof req.query.identity_key === 'string' && req.query.identity_key.trim()
        ? req.query.identity_key.trim()
        : 'xiaoni';
      const timeFilter = resolveActionStreamTimeFilter(req.query);
      const [feed, runtime] = await Promise.all([
        getXiaoniActivityFeed({
          identityKey,
          limit,
          startTime: timeFilter.startTime,
          endTime: timeFilter.endTime
        }),
        loadRuntimeSnapshot()
      ]);

      res.json({
        success: true,
        data: {
          ...feed,
          filters: {
            ...(typeof feed === 'object' && feed && 'filters' in feed ? (feed as Record<string, unknown>).filters as Record<string, unknown> : {}),
            ...serializeActionStreamTimeFilter(timeFilter)
          },
          current: {
            ...feed.current,
            runtime
          }
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load Xiaoni activity feed',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.get('/agent-runtime/recovery-sessions', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(100, Number.parseInt(String(req.query.limit || '30'), 10) || 30));
      const requestLimit = parseBoundedInteger(req.query.request_limit, 20, 1, 100);
      const requestOffset = parseBoundedInteger(req.query.request_offset, 0, 0, 100000);
      const requestFrom = parseOptionalDate(req.query.request_from || req.query.request_start_time || req.query.from);
      const requestTo = parseOptionalDate(req.query.request_to || req.query.request_end_time || req.query.to);
      const identityKey = typeof req.query.identity_key === 'string' && req.query.identity_key.trim()
        ? req.query.identity_key.trim()
        : 'xiaoni';
      const status = typeof req.query.status === 'string' && req.query.status.trim()
        ? req.query.status.trim()
        : 'all';
      const [sessions, lifeState, runtime] = await Promise.all([
        listAgentRecoverySessions({ identityKey, status, limit }),
        getAgentLifeState(identityKey),
        loadRuntimeSnapshot()
      ]);
      const current = {
        lifeState: normalizeRecoveryLifeState(lifeState),
        runtime
      };
      const timelineNow = new Date();
      const energyTimelineStart = resolveTimelineStart(Array.isArray(sessions) ? sessions : []);
      const requestTimeFilter = {
        ...(requestFrom ? { startTime: requestFrom } : {}),
        ...(requestTo ? { endTime: requestTo } : {})
      };
      const [energyEvents, recoverEnergyToolsForTimeline, recoverEnergyToolsForList] = await Promise.all([
        listAgentLifeEvents({
          identityKey,
          occurredAfter: energyTimelineStart,
          occurredBefore: timelineNow,
          chronological: true,
          limit: 1000
        }),
        listToolExecutions({
          identityKey,
          toolName: 'recover_energy',
          occurredAfter: energyTimelineStart,
          chronological: true,
          limit: 1000
        }),
        listToolExecutions({
          identityKey,
          toolName: 'recover_energy',
          ...requestTimeFilter,
          limit: requestLimit + 1,
          offset: requestOffset
        })
      ]);
      const requestRows = Array.isArray(recoverEnergyToolsForList) ? recoverEnergyToolsForList : [];
      const hasMoreRequests = requestRows.length > requestLimit;
      const recoverEnergyRequests = summarizeRecoverEnergyRequests(requestRows.slice(0, requestLimit), {
        limit: requestLimit,
        offset: requestOffset,
        hasMore: hasMoreRequests,
        nextOffset: hasMoreRequests ? requestOffset + requestLimit : null,
        previousOffset: requestOffset > 0 ? Math.max(0, requestOffset - requestLimit) : null,
        sort: 'started_at_desc',
        filters: {
          from: requestFrom ? requestFrom.toISOString() : null,
          to: requestTo ? requestTo.toISOString() : null
        }
      });
      const recoverEnergyRequestsForTimeline = summarizeRecoverEnergyRequests(
        Array.isArray(recoverEnergyToolsForTimeline) ? recoverEnergyToolsForTimeline : []
      );
      const energyTimeline = buildEnergyTimeline({
        sessions: Array.isArray(sessions) ? sessions : [],
        events: Array.isArray(energyEvents) ? energyEvents : [],
        recoverEnergyRequests: recoverEnergyRequestsForTimeline.requests,
        current
      });
      res.json({
        success: true,
        data: {
          identityKey,
          status,
          limit,
          requestLimit,
          requestOffset,
          active: Array.isArray(sessions) ? sessions.find((session: any) => session.status === 'active') || null : null,
          sessions,
          recoverEnergyRequests,
          current,
          energyTimeline,
          runtime
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list recovery sessions',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.get('/agent-runtime/tasks', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(100, Number.parseInt(String(req.query.limit || '30'), 10) || 30));
      const status = typeof req.query.status === 'string' && req.query.status.trim()
        ? req.query.status.trim()
        : undefined;
      const sessionKey = typeof req.query.session_key === 'string' && req.query.session_key.trim()
        ? req.query.session_key.trim()
        : undefined;
      const tasks = await listAgentTasks({ limit, status, sessionKey });
      res.json({
        success: true,
        data: tasks,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list agent tasks',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.get('/agent-runtime/media-assets', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(100, Number.parseInt(String(req.query.limit || '30'), 10) || 30));
      const sessionKey = typeof req.query.session_key === 'string' && req.query.session_key.trim()
        ? req.query.session_key.trim()
        : undefined;
      const mediaTag = typeof req.query.media_tag === 'string' && req.query.media_tag.trim()
        ? req.query.media_tag.trim()
        : undefined;
      const assets = await listAgentMediaAssets({ limit, sessionKey, mediaTag });
      res.json({
        success: true,
        data: assets,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list agent media assets',
        timestamp: new Date().toISOString()
      });
    }
  });

  return router;
}
