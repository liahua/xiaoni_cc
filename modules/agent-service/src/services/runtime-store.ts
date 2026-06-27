import {
  createAgentMediaObservation,
  createAgentTask,
  createFeedbackEpisode,
  createSqlAdapter,
  createFeedbackReflection,
  appendIdentityChangeCandidate,
  createAcceptedIdentityFact,
  ensureAgentMediaSchema,
  ensureAgentTaskSchema,
  ensureAgentPresenceSchema,
  ensureAgentLifeEventSchema,
  ensureAgentRecoverySessionSchema,
  ensureXiaoniAgentStackSchema,
  getAgentStackHead as getAgentStackHeadPersistence,
  appendAgentStackItems as appendAgentStackItemsPersistence,
  listAgentStackItems as listAgentStackItemsPersistence,
  listAgentStackItemsForConversations as listAgentStackItemsForConversationsPersistence,
  updateLlmRequestSliceStackLinks as updateLlmRequestSliceStackLinksPersistence,
  recordToolExecution as recordToolExecutionPersistence,
  completeToolExecution as completeAgentStackToolExecutionPersistence,
  recordCoreMemoryCompressionForkRun as recordCoreMemoryCompressionForkRunPersistence,
  completeCoreMemoryCompressionForkRun as completeCoreMemoryCompressionForkRunPersistence,
  findActiveCoreMemoryCompressionForkRun as findActiveCoreMemoryCompressionForkRunPersistence,
  reapOrphanedForkRuns as reapOrphanedForkRunsPersistence,
  appendCoreMemoryCompressionForkItems as appendCoreMemoryCompressionForkItemsPersistence,
  recordCoreMemoryCompressionForkSlice as recordCoreMemoryCompressionForkSlicePersistence,
  recordCoreMemoryCompressionForkToolExecution as recordCoreMemoryCompressionForkToolExecutionPersistence,
  completeCoreMemoryCompressionForkToolExecution as completeCoreMemoryCompressionForkToolExecutionPersistence,
  recordSubconsciousAgentForkRun as recordSubconsciousAgentForkRunPersistence,
  completeSubconsciousAgentForkRun as completeSubconsciousAgentForkRunPersistence,
  appendSubconsciousAgentForkItems as appendSubconsciousAgentForkItemsPersistence,
  recordSubconsciousAgentForkSlice as recordSubconsciousAgentForkSlicePersistence,
  recordSubconsciousAgentForkToolExecution as recordSubconsciousAgentForkToolExecutionPersistence,
  completeSubconsciousAgentForkToolExecution as completeSubconsciousAgentForkToolExecutionPersistence,
  recordImageVisionForkRun as recordImageVisionForkRunPersistence,
  completeImageVisionForkRun as completeImageVisionForkRunPersistence,
  appendImageVisionForkItems as appendImageVisionForkItemsPersistence,
  recordImageVisionForkSlice as recordImageVisionForkSlicePersistence,
  attachConversationIdToAgentStackByTrace,
  ensureIdentityLineageSchema,
  ensureXiaoniIdentityRoot,
  ensureFeedbackReflectionSchema,
  getAgentMediaAssetByTag,
  getAgentMediaAssetById,
  getFeedbackLearningState,
  listAgentMediaAssets,
  listAcceptedIdentityFacts,
  getTopicProjectionVersionById,
  listFeedbackLearningStates,
  listAgentInboundMessages,
  listQqUsageThreads,
  searchQqUsageThreads,
  listQqUsageThreadWindow,
  getQqUsageUnreadSummary,
  markQqUsageThreadRead,
  setQqUsageGroupNotificationMode,
  setQqUsageGroupNotificationAggregationSeconds,
  setQqUsageActiveSurface,
  clearQqUsageActiveSurface,
  renewQqAttentionLease,
  closeQqAttentionLease,
  ensureQqAttentionLeaseSchema,
  listFeedbackReflections,
  recordRuntimeIdentityActivationTrace,
  listSelfEvolutionStates,
  listChatSpaceTopics,
  markFeedbackReflectionsHit,
  upsertFeedbackLearningState,
  ensureRelationshipTrustSchema,
  getRelationshipTrustLevel,
  upsertRelationshipTrust,
  ensureAgentLifeState,
  getAgentLifeState,
  updateAgentLifeState,
  upsertAgentGroupPresenceState,
  listAgentSharePoolItems,
  createAgentShareItemUsage,
  createAgentPresenceStateSidecar,
  listAgentLifeEvents,
  recordAgentLifeEvent,
  createAgentRecoverySession as createAgentRecoverySessionPersistence,
  getAgentRecoveryQueueHighWatermark as getAgentRecoveryQueueHighWatermarkPersistence,
  getActiveAgentRecoverySession as getActiveAgentRecoverySessionPersistence,
  listAgentRecoveryWakeNotifications as listAgentRecoveryWakeNotificationsPersistence,
  updateAgentRecoverySessionProgress as updateAgentRecoverySessionProgressPersistence,
  claimAgentRecoveryCacheHeartbeat as claimAgentRecoveryCacheHeartbeatPersistence,
  completeAgentRecoveryCacheHeartbeat as completeAgentRecoveryCacheHeartbeatPersistence,
  clearAgentRecoveryCacheHeartbeatSchedule as clearAgentRecoveryCacheHeartbeatSchedulePersistence,
  finalizeAgentRecoverySession as finalizeAgentRecoverySessionPersistence,
  createAgentMemoryAssertion,
  createAgentMemoryObservation,
  createAgentMemoryReflection,
  ensureAgentMemorySchema,
  incrementRelationshipTrust,
  enqueueAgentQueueMessage,
  claimNextAgentQueueMessage,
  settleAgentQueueMessages,
  failAgentQueueMessage,
  retryAgentQueueMessage,
  ensureAgentRuntimeSchema,
  recoverStaleProcessingLeases as recoverStaleProcessingLeasesPersistence,
  releaseExecutionLease as releaseExecutionLeasePersistence,
  getExecutionLeaseDeliveryState as getExecutionLeaseDeliveryStatePersistence,
  markLeaseVisibleDeliveryCommitted as markLeaseVisibleDeliveryCommittedPersistence,
  markLeaseDeliveryBlocked as markLeaseDeliveryBlockedPersistence,
  createLlmJob as createLlmJobPersistence,
  updateLlmJob as updateLlmJobPersistence,
  logRuntimeTimelineEvent,
  listRecentConversationTurns,
  createConversationWithItems,
  attachConversationIdToRuntimeTrace,
  getSessionReadCutoffState as getSessionReadCutoffStatePersistence,
  upsertSessionReadCutoffState as upsertSessionReadCutoffStatePersistence,
  commitSessionContextSummaryAndReadCutoff as commitSessionContextSummaryAndReadCutoffPersistence,
  upsertProactiveShareState as upsertProactiveShareStatePersistence,
  upsertSessionContextSummary as upsertSessionContextSummaryPersistence,
  loadSessionReplayState as loadSessionReplayStatePersistence,
  serializeTimestampForApi,
  type AgentLifeEventProjection,
  type AgentRecoveryCacheHeartbeatClaimResult,
  type AgentRecoverySessionProjection,
  type AgentRecoveryWakeNotificationProjection,
  type QqUsageThreadList,
  type QqUsageThreadWindow,
  type QqUsageUnreadSummary,
  type RecordAgentLifeEventInput,
  type SqlAdapter
} from '@qq-bot/persistence';
import { v4 as uuidv4 } from 'uuid';
import { agentConfig, databaseConfig } from '../config';
import { logger } from '../utils/logger';
import {
  PRESENCE_FATIGUE_RECOVERY_THRESHOLD,
  scoreSharePoolItem,
  type PresenceAnchors,
  type PresenceSharePoolItem
} from './presence-context';
import {
  reduceXiaoniLifeState,
  XIAONI_LIFE_PROJECTION_VERSION,
  type XiaoniLifeStateExplanation,
  type XiaoniLifeStateProjection
} from './xiaoni-life-reducer';
import type { UnreadMeaningSocialActType } from '../types/social-act-type';
import {
  ConversationTranscriptItem,
  ConversationTranscriptPhase,
  ConversationTranscriptRole,
  ConversationTranscriptSource,
  ConversationTurn,
  QueueMessagePayload,
  QueueMessageRecord
} from '../types';

const moduleLogger = logger.createModuleLogger('runtime-store');
const LIFE_PROJECTION_EVENT_BATCH_LIMIT = 1000;
const LIFE_PROJECTION_MAX_BATCHES = 50;

export type AgentLifeStateRow = {
  last_active_at?: Date | string | null;
  service_started_at?: Date | string | null;
  last_boredom_reset_at?: Date | string | null;
  last_sleep_at?: Date | string | null;
  last_presence_tick_enqueued_at?: Date | string | null;
  last_proactive_at?: Date | string | null;
  last_user_message_at?: Date | string | null;
  daily_proactive_count?: number | string | null;
  daily_proactive_date?: Date | string | null;
  projection_json?: Record<string, unknown> | null;
  explanation_json?: Record<string, unknown> | null;
  reduced_through_event_id?: bigint | number | string | null;
  reduced_through_occurred_at?: Date | string | null;
  projection_version?: string | null;
  projection_updated_at?: Date | string | null;
};

function toValidDate(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateValueNotAfter(value: Date | string | null | undefined, now: Date) {
  const date = toValidDate(value);
  return date && date.getTime() <= now.getTime() ? value : null;
}

export function shouldDiscardLifeProjectionCursor(
  life: Pick<AgentLifeStateRow, 'reduced_through_occurred_at'>,
  previousProjection: Record<string, unknown> | null,
  now: Date
) {
  const projectionCursor = toValidDate((previousProjection as Partial<XiaoniLifeStateProjection> | null)?.reducedThroughOccurredAt);
  const storedCursor = toValidDate(life.reduced_through_occurred_at);
  const cursor = projectionCursor || storedCursor;
  return Boolean(cursor && cursor.getTime() > now.getTime());
}

function isSameUtcDate(left: Date | string | null | undefined, right: Date) {
  const leftDate = toValidDate(left);
  return Boolean(leftDate
    && leftDate.getUTCFullYear() === right.getUTCFullYear()
    && leftDate.getUTCMonth() === right.getUTCMonth()
    && leftDate.getUTCDate() === right.getUTCDate());
}

export function buildPresenceAnchorsFromLife(life: AgentLifeStateRow, now: Date): PresenceAnchors {
  const dailyProactiveCount = isSameUtcDate(life.daily_proactive_date, now)
    ? Number(life.daily_proactive_count || 0)
    : 0;
  return {
    now,
    lastActiveAt: dateValueNotAfter(life.last_active_at, now),
    serviceStartedAt: dateValueNotAfter(life.service_started_at, now),
    lastBoredomResetAt: dateValueNotAfter(life.last_boredom_reset_at, now),
    lastSleepAt: dateValueNotAfter(life.last_sleep_at, now),
    lastPresenceTickEnqueuedAt: dateValueNotAfter(life.last_presence_tick_enqueued_at, now),
    lastProactiveAt: dateValueNotAfter(life.last_proactive_at, now),
    lastUserMessageAt: dateValueNotAfter(life.last_user_message_at, now),
    dailyProactiveCount
  };
}

function normalizeProjectionJson(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function eventOccurredAfterProjection(
  event: AgentLifeEventProjection,
  reducedThroughEventId: bigint | null,
  reducedThroughOccurredAt: Date | null
) {
  if (!reducedThroughEventId || !reducedThroughOccurredAt) {
    return true;
  }
  const occurredAt = event.occurredAt ? new Date(event.occurredAt) : null;
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) {
    return true;
  }
  if (occurredAt.getTime() > reducedThroughOccurredAt.getTime()) {
    return true;
  }
  if (occurredAt.getTime() < reducedThroughOccurredAt.getTime()) {
    return false;
  }
  try {
    return BigInt(event.id || '0') > reducedThroughEventId;
  } catch {
    return true;
  }
}

function projectionEventId(value: bigint | number | string | null | undefined): bigint | null {
  if (value === null || typeof value === 'undefined' || value === '') {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

const REST_RECOVERY_BUCKET_MS = 60 * 60 * 1000;
const SLEEP_RECOVERY_BUCKET_MS = 8 * 60 * 60 * 1000;
const VISIBLE_REPLY_BASE_ACTION_COST = 0.01;
const VISIBLE_REPLY_EXTRA_MESSAGE_ACTION_COST = 0.005;
const VISIBLE_REPLY_MAX_ACTION_COST = 0.02;

function shanghaiHour(now: Date) {
  const value = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    hourCycle: 'h23'
  }).format(now);
  const hour = Number.parseInt(value, 10);
  return Number.isFinite(hour) ? hour : now.getHours();
}

function visibleReplyActionCost(messageCount: number) {
  const extraCount = Math.max(0, Math.floor(messageCount) - 1);
  return Math.min(
    VISIBLE_REPLY_MAX_ACTION_COST,
    VISIBLE_REPLY_BASE_ACTION_COST + (extraCount * VISIBLE_REPLY_EXTRA_MESSAGE_ACTION_COST)
  );
}

export function resolvePresenceRecoveryEvent(
  state: XiaoniLifeStateProjection['state'],
  now: Date
): {
  eventKind: 'rest_period' | 'sleep_period';
  reason: string;
  bucketMs: number;
} | null {
  if (state.fatigue <= PRESENCE_FATIGUE_RECOVERY_THRESHOLD) {
    return null;
  }
  const hour = shanghaiHour(now);
  if (hour >= 1 && hour < 9) {
    return {
      eventKind: 'sleep_period',
      reason: 'fatigue_sleep_window',
      bucketMs: SLEEP_RECOVERY_BUCKET_MS
    };
  }
  return {
    eventKind: 'rest_period',
    reason: 'fatigue_recovery',
    bucketMs: REST_RECOVERY_BUCKET_MS
  };
}

export type ExecutionLeaseDeliveryPhase = 'reasoning_open' | 'delivery_committed' | 'lease_released';

type ExecutionLeaseDeliveryStateRow = {
  delivery_phase: string | null;
  delivery_commit_count: number | string | null;
  blocked_delivery_attempt_count: number | string | null;
  last_blocked_delivery_reason: string | null;
};

export type ExecutionLeaseDeliveryState = {
  deliveryPhase: ExecutionLeaseDeliveryPhase;
  deliveryCommitCount: number;
  blockedDeliveryAttemptCount: number;
  lastBlockedDeliveryReason: string | null;
};

export type SessionReadCutoffState = {
  sessionKey: string;
  readCutoffAfterConversationId: number | null;
  lastContextWindowTokens: number | null;
  lastTargetBudgetTokens: number | null;
  lastHardBudgetTokens: number | null;
  contextSummary: string | null;
  pendingProactiveShare: string | null;
  pendingProactiveShareAge: number;
  updatedAt: string | null;
};

export type RuntimeSelfEvolutionState = {
  id: number;
  sessionKey: string;
  groupId: number | null;
  targetUserId: number | null;
  scopeType: string;
  version: number;
  socialPresenceBaseline: string;
  entryPreference: string;
  warmthBias: string;
  familiarityCeiling: string;
  topicResonance: string[];
  boundaryTendencies: Record<string, unknown>;
  reinforcedModes: string[];
  suppressedModes: string[];
  summaryText: string;
  sourceEventIds: number[];
  sourceMessageIds: number[];
  metadata: Record<string, unknown>;
  updatedAt: string | null;
};

export type RuntimeFeedbackReflection = {
  id: number;
  sessionKey: string;
  groupId: number | null;
  sourceUserId: number | null;
  sourceUserName: string | null;
  scopeType: string;
  learningKey: string;
  learningScope: string;
  reflectionType: string;
  feedbackKind: string;
  confidence: string;
  importanceScore: number;
  evidenceWeight: number;
  stabilityScore: number;
  summaryText: string;
  retrievalText: string | null;
  embeddingText: string | null;
  sourceMessageIds: number[];
  sourceEpisodeIds: number[];
  sourceConversationId: number | null;
  supersedesReflectionId: number | null;
  conflictGroupKey: string | null;
  metadata: Record<string, unknown>;
  lastHitAt: string | null;
  hitCount: number;
  updatedAt: string | null;
};

export type RuntimeFeedbackEpisode = {
  id: number;
  sessionKey: string;
  groupId: number | null;
  sourceUserId: number | null;
  sourceUserName: string | null;
  scopeType: string;
  eventKind: string;
  excerptText: string | null;
  sourceMessageIds: number[];
  sourceConversationId: number | null;
  eventImportance: number;
  sourceSalience: number;
  metadata: Record<string, unknown>;
  updatedAt: string | null;
};

export type RuntimePresenceContext = {
  sourceItems: PresenceSharePoolItem[];
  recallScores: Record<string, unknown>[];
  boundaryJudgments: Record<string, unknown>[];
  compressionMapping: Record<string, unknown>;
  lifeProjection: XiaoniLifeStateProjection;
  lifeExplanation: XiaoniLifeStateExplanation;
};

function isPhoneNotificationQueueMessage(queueMessage: QueueMessagePayload) {
  return queueMessage.source === 'phone_notification'
    || Boolean(queueMessage.phoneNotification)
    || queueMessage.inboundContext?.Surface === 'phone_notification';
}

function normalizeLifeEventOccurredAt(value: unknown) {
  if (!value) {
    return new Date();
  }
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function compactDedupePart(value: unknown, fallback: string) {
  const normalized = String(value || fallback).replace(/\s+/g, '_');
  return normalized.length > 80 ? normalized.slice(0, 80) : normalized;
}

function extractDeliveredTexts(toolResult: Record<string, unknown>) {
  if (!Array.isArray(toolResult.sent_messages)) {
    return [];
  }
  return toolResult.sent_messages
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
}

export type RuntimeFeedbackLearningState = {
  id: number;
  sessionKey: string;
  groupId: number | null;
  scopeType: string;
  learningKey: string;
  learningScope: string;
  scopeHash: string;
  stateType: string;
  activeReflectionId: number | null;
  latestReflectionId: number | null;
  activationWeight: number;
  recencyWeight: number;
  importanceWeight: number;
  sourceWeight: number;
  conflictPenalty: number;
  metadata: Record<string, unknown>;
  updatedAt: string | null;
};

export type RuntimeAcceptedIdentityFact = {
  id: number;
  identityKey: string;
  factKey: string;
  factText: string;
  factType: string;
  sourceCandidateId: number | null;
  sourceEventId: number | null;
  status: string;
  confidence: string;
  activationTags: string[];
  metadata: Record<string, unknown>;
  acceptedAt: string | null;
  updatedAt: string | null;
};

export type RuntimeTopicProjection = {
  topicId: number;
  versionId: number;
  source: 'candidate' | 'accepted';
  title: string;
  summaryText: string;
  lifecycleState: string;
  topicKeywords: string[];
  participantIds: number[];
  relationshipSummaries: string[];
  evidenceMessageIds: number[];
  heatScore: number;
  reviewPriorityScore: number;
  updatedAt: string | null;
};

export type RuntimeMemoryRagContext = {
  packSummary: string;
  timeScope: {
    oldestMessageAt: string | null;
    newestMessageAt: string | null;
  };
  segments: Array<{
    segmentId: string;
    reason: string;
    source: 'recent_turns' | 'summary_bridge';
    messageIds: number[];
    content: string;
  }>;
  bridgeNotes: Array<{
    kind: 'compact_bridge';
    summary: string;
  }>;
};

type FeedbackReflectionScore = {
  reflection: RuntimeFeedbackReflection;
  learningState: RuntimeFeedbackLearningState | null;
  bm25Score: number;
  embeddingScore: number;
  learningStateScore: number;
  evidenceScore: number;
  combinedScore: number;
};

type IdentityEvidenceRefParams = {
  sourceType: string;
  sourceId: string;
  traceId?: string | null;
  runId?: string | null;
  conversationId?: number | string | null;
  confidence?: string;
  redactionStatus?: string;
  metadata?: Record<string, unknown>;
};

function toIso(value: string | Date | null | undefined): string | null {
  return serializeTimestampForApi(value) as string | null;
}

function normalizeSearchText(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

function buildSearchTokens(text: string) {
  const normalized = normalizeSearchText(text)
    .replace(/[\s,，。！？!?:：;；、()[\]{}"']/g, ' ')
    .trim();
  if (!normalized) {
    return [];
  }

  const tokens = new Set<string>();
  for (const token of normalized.split(/\s+/).filter(Boolean)) {
    if (token.length >= 2) {
      tokens.add(token);
    }
  }

  const compact = normalized.replace(/\s+/g, '');
  for (let index = 0; index < compact.length - 1; index += 1) {
    const gram = compact.slice(index, index + 2);
    if (!/\s/.test(gram)) {
      tokens.add(gram);
    }
  }

  return Array.from(tokens);
}

function estimateBudgetLength(targetTokenBudget: number) {
  const normalized = Number.isFinite(targetTokenBudget) ? Math.max(1024, Math.trunc(targetTokenBudget)) : 12000;
  return normalized * 3;
}

function renderTranscriptItemForMemoryPack(turn: ConversationTurn) {
  const transcriptItems = Array.isArray(turn.items) ? turn.items : [];
  if (transcriptItems.length > 0) {
    return transcriptItems
      .map((item) => `${item.role}${item.phase ? `/${item.phase}` : ''}: ${item.content}`)
      .join('\n');
  }

  return [
    `user: ${turn.userMessage}`,
    turn.aiResponse ? `assistant: ${turn.aiResponse}` : ''
  ].filter(Boolean).join('\n');
}

function parseSelfEvolutionState(row: Record<string, unknown>): RuntimeSelfEvolutionState {
  return {
    id: Number(row.id),
    sessionKey: typeof row.session_key === 'string' ? row.session_key : '',
    groupId: row.group_id === null || typeof row.group_id === 'undefined' ? null : Number(row.group_id),
    targetUserId: row.target_user_id === null || typeof row.target_user_id === 'undefined' ? null : Number(row.target_user_id),
    scopeType: typeof row.scope_type === 'string' ? row.scope_type : 'group_self',
    version: Number(row.version || 1),
    socialPresenceBaseline: typeof row.social_presence_baseline === 'string' ? row.social_presence_baseline : 'light',
    entryPreference: typeof row.entry_preference === 'string' ? row.entry_preference : 'cue_first',
    warmthBias: typeof row.warmth_bias === 'string' ? row.warmth_bias : 'warm_light',
    familiarityCeiling: typeof row.familiarity_ceiling === 'string' ? row.familiarity_ceiling : 'warm_not_performative',
    topicResonance: normalizeStringArray(row.topic_resonance),
    boundaryTendencies: row.boundary_tendencies && typeof row.boundary_tendencies === 'object' && !Array.isArray(row.boundary_tendencies)
      ? row.boundary_tendencies as Record<string, unknown>
      : {},
    reinforcedModes: normalizeStringArray(row.reinforced_modes),
    suppressedModes: normalizeStringArray(row.suppressed_modes),
    summaryText: typeof row.summary_text === 'string' ? row.summary_text : '',
    sourceEventIds: normalizeNumberArray(row.source_event_ids),
    sourceMessageIds: normalizeNumberArray(row.source_message_ids),
    metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : {},
    updatedAt: toIso(row.updated_at as string | Date | null | undefined)
  };
}

function parseFeedbackReflection(row: Record<string, unknown>): RuntimeFeedbackReflection {
  return {
    id: Number(row.id),
    sessionKey: typeof row.session_key === 'string' ? row.session_key : '',
    groupId: row.group_id === null || typeof row.group_id === 'undefined' ? null : Number(row.group_id),
    sourceUserId: row.source_user_id === null || typeof row.source_user_id === 'undefined' ? null : Number(row.source_user_id),
    sourceUserName: typeof row.source_user_name === 'string' && row.source_user_name.trim() ? row.source_user_name.trim() : null,
    scopeType: typeof row.scope_type === 'string' ? row.scope_type : 'group_self',
    learningKey: typeof row.learning_key === 'string' && row.learning_key.trim() ? row.learning_key.trim() : 'feedback.general',
    learningScope: typeof row.learning_scope === 'string' && row.learning_scope.trim() ? row.learning_scope.trim() : 'group_self',
    reflectionType: typeof row.reflection_type === 'string' && row.reflection_type.trim() ? row.reflection_type.trim() : 'social_lesson',
    feedbackKind: typeof row.feedback_kind === 'string' ? row.feedback_kind : 'mixed',
    confidence: typeof row.confidence === 'string' ? row.confidence : 'medium',
    importanceScore: Number.isFinite(Number(row.importance_score)) ? Number(row.importance_score) : 0,
    evidenceWeight: Number.isFinite(Number(row.evidence_weight)) ? Number(row.evidence_weight) : 0,
    stabilityScore: Number.isFinite(Number(row.stability_score)) ? Number(row.stability_score) : 0,
    summaryText: typeof row.summary_text === 'string' ? row.summary_text.trim() : '',
    retrievalText: typeof row.retrieval_text === 'string' && row.retrieval_text.trim() ? row.retrieval_text.trim() : null,
    embeddingText: typeof row.embedding_text === 'string' && row.embedding_text.trim() ? row.embedding_text.trim() : null,
    sourceMessageIds: normalizeNumberArray(row.source_message_ids),
    sourceEpisodeIds: normalizeNumberArray(row.source_episode_ids),
    sourceConversationId: row.source_conversation_id === null || typeof row.source_conversation_id === 'undefined'
      ? null
      : Number(row.source_conversation_id),
    supersedesReflectionId: row.supersedes_reflection_id === null || typeof row.supersedes_reflection_id === 'undefined'
      ? null
      : Number(row.supersedes_reflection_id),
    conflictGroupKey: typeof row.conflict_group_key === 'string' && row.conflict_group_key.trim() ? row.conflict_group_key.trim() : null,
    metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : {},
    lastHitAt: toIso(row.last_hit_at as string | Date | null | undefined),
    hitCount: Number.isFinite(Number(row.hit_count)) ? Number(row.hit_count) : 0,
    updatedAt: toIso(row.updated_at as string | Date | null | undefined)
  };
}

function parseFeedbackEpisode(row: Record<string, unknown>): RuntimeFeedbackEpisode {
  return {
    id: Number(row.id),
    sessionKey: typeof row.session_key === 'string' ? row.session_key : '',
    groupId: row.group_id === null || typeof row.group_id === 'undefined' ? null : Number(row.group_id),
    sourceUserId: row.source_user_id === null || typeof row.source_user_id === 'undefined' ? null : Number(row.source_user_id),
    sourceUserName: typeof row.source_user_name === 'string' && row.source_user_name.trim() ? row.source_user_name.trim() : null,
    scopeType: typeof row.scope_type === 'string' ? row.scope_type : 'group_self',
    eventKind: typeof row.event_kind === 'string' ? row.event_kind : 'feedback',
    excerptText: typeof row.excerpt_text === 'string' && row.excerpt_text.trim() ? row.excerpt_text.trim() : null,
    sourceMessageIds: normalizeNumberArray(row.source_message_ids),
    sourceConversationId: row.source_conversation_id === null || typeof row.source_conversation_id === 'undefined'
      ? null
      : Number(row.source_conversation_id),
    eventImportance: Number.isFinite(Number(row.event_importance)) ? Number(row.event_importance) : 0,
    sourceSalience: Number.isFinite(Number(row.source_salience)) ? Number(row.source_salience) : 0,
    metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : {},
    updatedAt: toIso(row.updated_at as string | Date | null | undefined)
  };
}

function parseFeedbackLearningState(row: Record<string, unknown>): RuntimeFeedbackLearningState {
  return {
    id: Number(row.id),
    sessionKey: typeof row.session_key === 'string' ? row.session_key : '',
    groupId: row.group_id === null || typeof row.group_id === 'undefined' ? null : Number(row.group_id),
    scopeType: typeof row.scope_type === 'string' ? row.scope_type : 'group_self',
    learningKey: typeof row.learning_key === 'string' ? row.learning_key : '',
    learningScope: typeof row.learning_scope === 'string' ? row.learning_scope : '',
    scopeHash: typeof row.scope_hash === 'string' ? row.scope_hash : '',
    stateType: typeof row.state_type === 'string' ? row.state_type : 'reinforced',
    activeReflectionId: row.active_reflection_id === null || typeof row.active_reflection_id === 'undefined'
      ? null
      : Number(row.active_reflection_id),
    latestReflectionId: row.latest_reflection_id === null || typeof row.latest_reflection_id === 'undefined'
      ? null
      : Number(row.latest_reflection_id),
    activationWeight: Number.isFinite(Number(row.activation_weight)) ? Number(row.activation_weight) : 0,
    recencyWeight: Number.isFinite(Number(row.recency_weight)) ? Number(row.recency_weight) : 0,
    importanceWeight: Number.isFinite(Number(row.importance_weight)) ? Number(row.importance_weight) : 0,
    sourceWeight: Number.isFinite(Number(row.source_weight)) ? Number(row.source_weight) : 0,
    conflictPenalty: Number.isFinite(Number(row.conflict_penalty)) ? Number(row.conflict_penalty) : 0,
    metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : {},
    updatedAt: toIso(row.updated_at as string | Date | null | undefined)
  };
}

function parseAcceptedIdentityFact(row: Record<string, unknown>): RuntimeAcceptedIdentityFact {
  return {
    id: Number(row.id),
    identityKey: typeof row.identity_key === 'string' ? row.identity_key : '',
    factKey: typeof row.fact_key === 'string' ? row.fact_key : '',
    factText: typeof row.fact_text === 'string' ? row.fact_text : '',
    factType: typeof row.fact_type === 'string' ? row.fact_type : 'self_boundary',
    sourceCandidateId: row.source_candidate_id === null || typeof row.source_candidate_id === 'undefined'
      ? null
      : Number(row.source_candidate_id),
    sourceEventId: row.source_event_id === null || typeof row.source_event_id === 'undefined'
      ? null
      : Number(row.source_event_id),
    status: typeof row.status === 'string' ? row.status : 'active',
    confidence: typeof row.confidence === 'string' ? row.confidence : 'medium',
    activationTags: normalizeStringArray(row.activation_tags),
    metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : {},
    acceptedAt: toIso(row.accepted_at as string | Date | null | undefined),
    updatedAt: toIso(row.updated_at as string | Date | null | undefined)
  };
}

function parseRuntimeTopicProjection(params: {
  topicRow: Record<string, unknown>;
  versionRow: Record<string, unknown>;
  source: 'candidate' | 'accepted';
}): RuntimeTopicProjection | null {
  const snapshot = params.versionRow.snapshot_json && typeof params.versionRow.snapshot_json === 'object' && !Array.isArray(params.versionRow.snapshot_json)
    ? params.versionRow.snapshot_json as Record<string, unknown>
    : {};
  const title = typeof params.versionRow.title === 'string' && params.versionRow.title.trim()
    ? params.versionRow.title.trim()
    : typeof snapshot.title === 'string' && snapshot.title.trim()
      ? snapshot.title.trim()
      : typeof params.topicRow.canonical_title === 'string' && params.topicRow.canonical_title.trim()
        ? params.topicRow.canonical_title.trim()
        : '';
  const summaryText = typeof params.versionRow.summary_text === 'string' && params.versionRow.summary_text.trim()
    ? params.versionRow.summary_text.trim()
    : typeof snapshot.summary_text === 'string' && snapshot.summary_text.trim()
      ? snapshot.summary_text.trim()
      : '';
  if (!title || !summaryText) {
    return null;
  }

  const relationships = Array.isArray(snapshot.relationships)
    ? snapshot.relationships
      .map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return '';
        }
        const summaryText = (item as Record<string, unknown>).summary_text;
        return typeof summaryText === 'string' ? summaryText.trim() : '';
      })
      .filter(Boolean)
      .slice(0, 4)
    : [];

  return {
    topicId: Number(params.topicRow.id),
    versionId: Number(params.versionRow.id),
    source: params.source,
    title,
    summaryText,
    lifecycleState: typeof params.versionRow.lifecycle_state === 'string' && params.versionRow.lifecycle_state.trim()
      ? params.versionRow.lifecycle_state.trim()
      : typeof snapshot.lifecycle_state === 'string' && snapshot.lifecycle_state.trim()
        ? snapshot.lifecycle_state.trim()
        : (typeof params.topicRow.status === 'string' && params.topicRow.status.trim() ? params.topicRow.status.trim() : 'active'),
    topicKeywords: normalizeStringArray(
      typeof params.versionRow.topic_keywords !== 'undefined'
        ? params.versionRow.topic_keywords
        : snapshot.topic_keywords
    ).slice(0, 8),
    participantIds: normalizeNumberArray(
      typeof params.versionRow.participant_ids !== 'undefined'
        ? params.versionRow.participant_ids
        : snapshot.participant_ids
    ),
    relationshipSummaries: relationships,
    evidenceMessageIds: normalizeNumberArray(
      typeof snapshot.evidence_message_ids !== 'undefined'
        ? snapshot.evidence_message_ids
        : params.versionRow.evidence_message_ids
    ),
    heatScore: Number.isFinite(Number(params.versionRow.heat_score)) ? Number(params.versionRow.heat_score) : 0,
    reviewPriorityScore: Number.isFinite(Number(params.versionRow.review_priority_score)) ? Number(params.versionRow.review_priority_score) : 0,
    updatedAt: toIso(params.versionRow.updated_at as string | Date | null | undefined) || toIso(params.topicRow.updated_at as string | Date | null | undefined)
  };
}

function normalizeScoreMap(scores: Map<number, number>) {
  let maxScore = 0;
  for (const score of scores.values()) {
    maxScore = Math.max(maxScore, score);
  }
  if (maxScore <= 0) {
    return new Map<number, number>();
  }

  const normalized = new Map<number, number>();
  for (const [cardId, score] of scores.entries()) {
    normalized.set(cardId, score / maxScore);
  }
  return normalized;
}

function cosineSimilarity(left: number[], right: number[]) {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function computeLastHitBoost(lastHitAt: string | null) {
  if (!lastHitAt) {
    return 0;
  }
  const ageMs = Date.now() - new Date(lastHitAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return 0;
  }
  const dayMs = 24 * 60 * 60 * 1000;
  if (ageMs <= dayMs) {
    return 1;
  }
  if (ageMs <= 7 * dayMs) {
    return 0.55;
  }
  return 0.15;
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(value, 1));
}

function buildFeedbackReflectionSearchText(reflection: RuntimeFeedbackReflection) {
  return [
    reflection.learningKey,
    reflection.learningScope,
    reflection.reflectionType,
    reflection.feedbackKind,
    reflection.summaryText,
    reflection.retrievalText || '',
    reflection.embeddingText || ''
  ]
    .map((item) => item.trim())
    .filter(Boolean)
    .join('\n');
}

function computeFeedbackBm25Scores(reflections: RuntimeFeedbackReflection[], queryText: string) {
  const queryTokens = buildSearchTokens(queryText);
  if (queryTokens.length === 0 || reflections.length === 0) {
    return new Map<number, number>();
  }

  const documents = reflections.map((reflection) => {
    const tokens = buildSearchTokens(buildFeedbackReflectionSearchText(reflection));
    const frequencies = new Map<string, number>();
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) || 0) + 1);
    }
    return {
      reflectionId: reflection.id,
      length: Math.max(tokens.length, 1),
      frequencies
    };
  });
  const avgDocLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length;
  const docFrequency = new Map<string, number>();
  for (const token of queryTokens) {
    const count = documents.reduce((sum, document) => sum + (document.frequencies.has(token) ? 1 : 0), 0);
    docFrequency.set(token, count);
  }

  const scores = new Map<number, number>();
  const k1 = 1.2;
  const b = 0.75;
  for (const document of documents) {
    let score = 0;
    for (const token of queryTokens) {
      const termFrequency = document.frequencies.get(token) || 0;
      if (!termFrequency) {
        continue;
      }
      const df = docFrequency.get(token) || 0;
      const idf = Math.log(1 + ((documents.length - df + 0.5) / (df + 0.5)));
      const numerator = termFrequency * (k1 + 1);
      const denominator = termFrequency + k1 * (1 - b + b * (document.length / Math.max(avgDocLength, 1)));
      score += idf * (numerator / denominator);
    }
    scores.set(document.reflectionId, score);
  }
  return scores;
}

function computeFeedbackLearningStateScore(state: RuntimeFeedbackLearningState | null) {
  if (!state) {
    return 0;
  }
  return clamp01(
    state.activationWeight * 0.3
    + state.recencyWeight * 0.25
    + state.importanceWeight * 0.25
    + state.sourceWeight * 0.15
    - state.conflictPenalty * 0.2
  );
}

function computeFeedbackEvidenceScore(reflection: RuntimeFeedbackReflection) {
  return clamp01(
    reflection.importanceScore * 0.35
    + reflection.evidenceWeight * 0.35
    + reflection.stabilityScore * 0.2
    + (reflection.confidence === 'high' ? 0.1 : reflection.confidence === 'medium' ? 0.05 : 0)
  );
}

export function rankFeedbackReflectionsForRecall(params: {
  reflections: RuntimeFeedbackReflection[];
  learningStates: RuntimeFeedbackLearningState[];
  queryText: string;
  currentUserId: number;
  recentUserIds: number[];
  embeddingScores?: Map<number, number>;
  limit: number;
  socialActTypeHint?: UnreadMeaningSocialActType | null;
}) {
  const reflectionById = new Map(params.reflections.map((reflection) => [reflection.id, reflection]));
  const supersededIds = new Set(
    params.reflections
      .map((reflection) => reflection.supersedesReflectionId)
      .filter((id): id is number => typeof id === 'number' && Number.isFinite(id) && reflectionById.has(id))
  );
  const stateByReflectionId = new Map<number, RuntimeFeedbackLearningState>();
  for (const state of params.learningStates) {
    if (typeof state.activeReflectionId === 'number' && reflectionById.has(state.activeReflectionId)) {
      stateByReflectionId.set(state.activeReflectionId, state);
    }
  }

  const activeReflectionIds = new Set(stateByReflectionId.keys());
  const baseReflections = params.reflections
    .filter((reflection) => !supersededIds.has(reflection.id) || activeReflectionIds.has(reflection.id));
  const bm25Scores = normalizeScoreMap(computeFeedbackBm25Scores(baseReflections, params.queryText));
  const embeddingScores = normalizeScoreMap(params.embeddingScores || new Map<number, number>());
  const recentUserIds = new Set(params.recentUserIds);

  const ranked = baseReflections
    .map((reflection) => {
      const learningState = stateByReflectionId.get(reflection.id) || null;
      const bm25Score = bm25Scores.get(reflection.id) || 0;
      const embeddingScore = embeddingScores.get(reflection.id) || 0;
      const learningStateScore = computeFeedbackLearningStateScore(learningState);
      const evidenceScore = computeFeedbackEvidenceScore(reflection);
      const sourceScore = reflection.sourceUserId === params.currentUserId
        ? 0.25
        : reflection.sourceUserId && recentUserIds.has(reflection.sourceUserId)
          ? 0.15
          : 0;
      const freshnessScore = reflection.updatedAt ? computeLastHitBoost(reflection.updatedAt) * 0.08 : 0;
      const hitPenalty = Math.min(reflection.hitCount * 0.03, 0.24);
      const conflictPenalty = learningState?.stateType === 'conflicted' ? 0.08 : 0;
      const actHintScore = (() => {
        if (!params.socialActTypeHint) return 0;
        if (params.socialActTypeHint === 'invitation_curiosity' && reflection.reflectionType === 'self_model_update') return 0.08;
        if (params.socialActTypeHint === 'relationship_probe' && reflection.reflectionType === 'social_lesson') return 0.06;
        return 0;
      })();
      return {
        reflection,
        learningState,
        bm25Score,
        embeddingScore,
        learningStateScore,
        evidenceScore,
        combinedScore: bm25Score * 0.36
          + embeddingScore * 0.32
          + learningStateScore * 0.16
          + evidenceScore * 0.1
          + sourceScore
          + freshnessScore
          + actHintScore
          - hitPenalty
          - conflictPenalty
      } satisfies FeedbackReflectionScore;
    })
    .filter((item) => item.bm25Score > 0 || item.embeddingScore >= 0.2)
    .sort((left, right) => (
      right.combinedScore - left.combinedScore
      || right.learningStateScore - left.learningStateScore
      || right.evidenceScore - left.evidenceScore
      || right.reflection.id - left.reflection.id
    ));

  const selected: FeedbackReflectionScore[] = [];
  const selectedKeys = new Set<string>();
  const selectedConflictGroups = new Set<string>();
  for (const item of ranked) {
    const learningKey = `${item.reflection.learningKey}\u0000${item.reflection.learningScope}`;
    if (selectedKeys.has(learningKey)) {
      continue;
    }
    const conflictGroupKey = item.reflection.conflictGroupKey;
    if (conflictGroupKey && selectedConflictGroups.has(conflictGroupKey)) {
      continue;
    }
    selected.push(item);
    selectedKeys.add(learningKey);
    if (conflictGroupKey) {
      selectedConflictGroups.add(conflictGroupKey);
    }
    if (selected.length >= Math.max(1, Math.min(params.limit, 3))) {
      break;
    }
  }

  return selected;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'object') {
    return value as T;
  }
  if (typeof value !== 'string') {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeDeliveryPhase(value: unknown): ExecutionLeaseDeliveryPhase {
  if (value === 'delivery_committed' || value === 'lease_released') {
    return value;
  }
  if (value === 'finished') {
    return 'lease_released';
  }
  return 'reasoning_open';
}

function mapExecutionLeaseDeliveryState(row?: Partial<ExecutionLeaseDeliveryStateRow> | null): ExecutionLeaseDeliveryState {
  return {
    deliveryPhase: normalizeDeliveryPhase(row?.delivery_phase),
    deliveryCommitCount: Number(row?.delivery_commit_count || 0),
    blockedDeliveryAttemptCount: Number(row?.blocked_delivery_attempt_count || 0),
    lastBlockedDeliveryReason: typeof row?.last_blocked_delivery_reason === 'string' && row.last_blocked_delivery_reason.trim().length > 0
      ? row.last_blocked_delivery_reason
      : null
  };
}

function isPresenceTickPayload(queueMessage: QueueMessagePayload) {
  return queueMessage.source === 'presence_tick'
    || queueMessage.sessionKey === 'presence_tick:xiaoni'
    || Boolean((queueMessage as QueueMessagePayload & { presenceTick?: unknown }).presenceTick);
}

function buildTranscriptSessionId(userId: number, groupId?: number | null) {
  if (groupId && Number.isFinite(groupId)) {
    return `group:${groupId}`;
  }
  return `private:${userId}`;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

function normalizeNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
    .map((item) => Math.trunc(item));
}

type ConversationTranscriptItemInput = {
  sessionKey: string | null;
  role: ConversationTranscriptRole;
  phase?: ConversationTranscriptPhase | null;
  content: string;
  groupIndex: number;
  itemIndex: number;
  source: ConversationTranscriptSource;
  deliveryMessageId?: number | null;
  runId?: string | null;
  traceId?: string | null;
};

export class RuntimeStore {
  private readonly sql: SqlAdapter;

  constructor() {
    this.sql = createSqlAdapter({
      databaseUrl: databaseConfig.url,
      host: databaseConfig.host,
      port: databaseConfig.port,
      user: databaseConfig.user,
      password: databaseConfig.password,
      database: databaseConfig.database,
      connectionLimit: databaseConfig.connectionLimit,
      applicationName: 'agent-service'
    });
  }

  private async recordLifeEventSafe(input: RecordAgentLifeEventInput) {
    try {
      await recordAgentLifeEvent(input, databaseConfig);
    } catch (error) {
      moduleLogger.warn('Failed to record agent life event', {
        eventKind: input.eventKind || input.event_kind,
        dedupeKey: input.dedupeKey || input.dedupe_key,
        runId: input.runId || input.run_id,
        traceId: input.traceId || input.trace_id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async refreshXiaoniLifeProjection(now = new Date()) {
    const life = (await getAgentLifeState('xiaoni', databaseConfig) || await ensureAgentLifeState('xiaoni', databaseConfig)) as AgentLifeStateRow;
    const projectionIsCurrent = life.projection_version === XIAONI_LIFE_PROJECTION_VERSION;
    const storedProjection = projectionIsCurrent ? normalizeProjectionJson(life.projection_json) : null;
    const discardProjectionCursor = projectionIsCurrent && shouldDiscardLifeProjectionCursor(life, storedProjection, now);
    if (discardProjectionCursor) {
      moduleLogger.warn('Discarding future Xiaoni life projection cursor before replay', {
        identityKey: 'xiaoni',
        reducedThroughEventId: life.reduced_through_event_id ? String(life.reduced_through_event_id) : null,
        reducedThroughOccurredAt: life.reduced_through_occurred_at ? new Date(life.reduced_through_occurred_at).toISOString() : null,
        now: now.toISOString()
      });
    }
    const previousProjection = projectionIsCurrent && !discardProjectionCursor ? storedProjection : null;
    const reducedThroughEventId = projectionIsCurrent && !discardProjectionCursor ? projectionEventId(life.reduced_through_event_id) : null;
    const previousReducedThroughOccurredAt = toValidDate((previousProjection as XiaoniLifeStateProjection | null)?.reducedThroughOccurredAt);
    const reducedThroughOccurredAt = projectionIsCurrent && !discardProjectionCursor
      ? (previousReducedThroughOccurredAt || toValidDate(life.reduced_through_occurred_at))
      : null;
    const events: AgentLifeEventProjection[] = [];
    let cursorEventId = reducedThroughEventId;
    let cursorOccurredAt = reducedThroughOccurredAt;
    for (let batchIndex = 0; batchIndex < LIFE_PROJECTION_MAX_BATCHES; batchIndex += 1) {
      const candidateEvents = await listAgentLifeEvents({
        identityKey: 'xiaoni',
        ...(cursorOccurredAt ? { occurredAfter: cursorOccurredAt } : {}),
        ...(cursorEventId ? { afterEventId: String(cursorEventId) } : {}),
        occurredBefore: now,
        chronological: true,
        limit: LIFE_PROJECTION_EVENT_BATCH_LIMIT
      }, databaseConfig) as AgentLifeEventProjection[];
      const batchEvents = previousProjection
        ? candidateEvents.filter((event) => eventOccurredAfterProjection(event, cursorEventId, cursorOccurredAt))
        : candidateEvents;
      if (batchEvents.length === 0) {
        break;
      }
      events.push(...batchEvents);
      const lastEvent = batchEvents[batchEvents.length - 1];
      cursorEventId = projectionEventId(lastEvent.id);
      cursorOccurredAt = toValidDate(lastEvent.occurredAt) || cursorOccurredAt;
      if (candidateEvents.length < LIFE_PROJECTION_EVENT_BATCH_LIMIT) {
        break;
      }
    }
    const { projection, explanation } = reduceXiaoniLifeState({
      identityKey: 'xiaoni',
      now,
      events,
      previousProjection,
      legacyAnchors: buildPresenceAnchorsFromLife(life, now)
    });
    const reducedThroughEventIdForDb = projection.reducedThroughEventId
      ? projectionEventId(projection.reducedThroughEventId)
      : null;
    await updateAgentLifeState('xiaoni', {
      projection_json: projection,
      explanation_json: explanation,
      reduced_through_event_id: reducedThroughEventIdForDb,
      reduced_through_occurred_at: projection.reducedThroughOccurredAt ? new Date(projection.reducedThroughOccurredAt) : null,
      projection_version: XIAONI_LIFE_PROJECTION_VERSION,
      projection_updated_at: now
    }, databaseConfig);
    return { projection, explanation };
  }

  async initialize() {
    await this.ensureSchema();
    const recovered = await this.recoverStaleProcessingLeases({
      staleMs: agentConfig.processingRecoveryStaleMs,
      reason: 'agent_service_startup_recovery'
    }).catch((error) => {
      moduleLogger.warn('Failed to recover stale processing runs during startup', {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    });
    if (recovered && (recovered.failedRuns > 0 || recovered.settledRuns > 0 || recovered.failedQueueMessages > 0 || recovered.settledQueueMessages > 0)) {
      moduleLogger.warn('Recovered stale processing runs during startup', recovered);
    }
    await ensureFeedbackReflectionSchema(databaseConfig);
    await ensureRelationshipTrustSchema(databaseConfig);
    await ensureIdentityLineageSchema(databaseConfig);
    await ensureAgentMediaSchema(databaseConfig);
    await ensureAgentTaskSchema(databaseConfig);
    await ensureAgentPresenceSchema(databaseConfig);
    await ensureAgentLifeEventSchema(databaseConfig);
    await ensureAgentRecoverySessionSchema({ sqlAdapter: this.sql }, databaseConfig);
    await ensureAgentMemorySchema(databaseConfig);
    await ensureQqAttentionLeaseSchema({ sqlAdapter: this.sql }, databaseConfig);
    await ensureAgentLifeState('xiaoni', databaseConfig);
    await this.refreshXiaoniLifeProjection(new Date()).catch((error) => {
      moduleLogger.warn('Failed to refresh Xiaoni life projection during startup', {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  async close() {
    await this.sql.close();
  }

  async recoverStaleProcessingLeases(input: { staleMs: number; reason: string }) {
    return recoverStaleProcessingLeasesPersistence({
      ...input,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async getCurrentXiaoniEnergyState(now = new Date()) {
    const { projection } = await this.refreshXiaoniLifeProjection(now);
    return {
      energy: Number(projection.state.energy),
      maxEnergy: 1,
      lastWakeAt: projection.anchors.lastRestAt || null
    };
  }

  async createAgentRecoverySession(params: Record<string, unknown>): Promise<AgentRecoverySessionProjection> {
    return createAgentRecoverySessionPersistence({
      identityKey: 'xiaoni',
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async getAgentRecoveryQueueHighWatermark(): Promise<number> {
    return getAgentRecoveryQueueHighWatermarkPersistence({
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async getActiveAgentRecoverySession(): Promise<AgentRecoverySessionProjection | null> {
    return getActiveAgentRecoverySessionPersistence({
      identityKey: 'xiaoni',
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async listAgentRecoveryWakeNotifications(params: {
    afterQueueMessageId?: number | string | bigint | null;
    limit?: number;
  }): Promise<AgentRecoveryWakeNotificationProjection[]> {
    return listAgentRecoveryWakeNotificationsPersistence({
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async updateAgentRecoverySessionProgress(params: Record<string, unknown>): Promise<AgentRecoverySessionProjection | null> {
    return updateAgentRecoverySessionProgressPersistence({
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async claimAgentRecoveryCacheHeartbeat(params: Record<string, unknown>): Promise<AgentRecoveryCacheHeartbeatClaimResult> {
    return claimAgentRecoveryCacheHeartbeatPersistence({
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async completeAgentRecoveryCacheHeartbeat(params: Record<string, unknown>): Promise<AgentRecoverySessionProjection | null> {
    return completeAgentRecoveryCacheHeartbeatPersistence({
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async clearAgentRecoveryCacheHeartbeatSchedule(params: Record<string, unknown>): Promise<AgentRecoverySessionProjection | null> {
    return clearAgentRecoveryCacheHeartbeatSchedulePersistence({
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async finalizeAgentRecoverySession(params: Record<string, unknown>): Promise<AgentRecoverySessionProjection | null> {
    return finalizeAgentRecoverySessionPersistence({
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async recordPresenceUserMessage(queueMessage: QueueMessagePayload) {
    if (!isPhoneNotificationQueueMessage(queueMessage)) {
      return;
    }

    const now = new Date();
    await updateAgentLifeState('xiaoni', {
      last_user_message_at: now,
      last_boredom_reset_at: now
    }, databaseConfig);
    if (queueMessage.chatType === 'group') {
      await upsertAgentGroupPresenceState({
        identityKey: 'xiaoni',
        sessionKey: queueMessage.sessionKey,
        lastUserMessageAt: now
      }, databaseConfig);
    }

    const notification = queueMessage.phoneNotification;
    await this.recordLifeEventSafe({
      identityKey: 'xiaoni',
      eventKind: 'phone_notification',
      occurredAt: now,
      surface: 'qq',
      chatType: queueMessage.chatType,
      sessionKey: queueMessage.sessionKey,
      surfaceId: queueMessage.sessionKey,
      peerId: queueMessage.peerId,
      accountId: queueMessage.accountId,
      batchId: queueMessage.batchId,
      runId: queueMessage.runId,
      traceId: queueMessage.traceId,
      actorType: 'system',
      actorId: 'qq',
      targetId: 'xiaoni',
      visibility: 'private_surface',
      actionCost: 0,
      attentionDelta: 0.05,
      payload: {
        source: queueMessage.source,
        app: notification?.app || 'qq',
        peer_name: queueMessage.peerName || null,
        unread_delta: notification?.unreadDelta ?? queueMessage.messages.length,
        direct_mentions: notification?.directMentions ?? queueMessage.messages.filter((message) => Boolean(message.wasMentioned || message.inboundContext?.WasMentioned)).length,
        notification_id: notification?.notificationId || null,
        latest_received_at: notification?.latestReceivedAt || queueMessage.receivedAt,
        policy: 'notification_only_no_qq_body'
      },
      dedupeKey: `phone_notification:${compactDedupePart(queueMessage.runId, queueMessage.traceId)}:${compactDedupePart(queueMessage.sessionKey, 'session')}`
    });
  }

  async recordPresenceAssistantAction(queueMessage: QueueMessagePayload) {
    const now = new Date();
    await updateAgentLifeState('xiaoni', {
      last_active_at: now,
      last_boredom_reset_at: now
    }, databaseConfig);
    if (queueMessage.chatType === 'group') {
      await upsertAgentGroupPresenceState({
        identityKey: 'xiaoni',
        sessionKey: queueMessage.sessionKey,
        lastSpokeAt: now
      }, databaseConfig);
    }
  }

  async recordVisibleDeliveryLifeEvents(input: {
    queueMessage: QueueMessagePayload;
    runId?: string;
    toolName: string;
    toolResult: Record<string, unknown>;
    forced?: boolean;
  }) {
    const now = new Date();
    const queueMessage = input.queueMessage;
    const runId = input.runId || queueMessage.runId;
    const messages = extractDeliveredTexts(input.toolResult);
    if (messages.length === 0) {
      return;
    }
    const replyActionCost = visibleReplyActionCost(messages.length);
    const actualChatType = input.toolResult.message_type === 'group'
      ? 'group'
      : input.toolResult.message_type === 'private'
      ? 'direct'
      : queueMessage.chatType === 'group'
      ? 'group'
      : 'direct';
    const targetGroupId = Number(input.toolResult.target_group_id);
    const targetUserId = Number(input.toolResult.target_user_id);
    const deliverySessionKey = actualChatType === 'group'
      ? queueMessage.chatType === 'group' && queueMessage.sessionKey
        ? queueMessage.sessionKey
        : `qq:group:${Math.trunc(targetGroupId)}`
      : queueMessage.chatType === 'direct' && queueMessage.sessionKey
      ? queueMessage.sessionKey
      : `qq:direct:${queueMessage.accountId}:${Math.trunc(targetUserId)}`;
    const deliveryPeerId = actualChatType === 'group' && Number.isFinite(targetGroupId)
      ? String(Math.trunc(targetGroupId))
      : actualChatType === 'direct' && Number.isFinite(targetUserId)
      ? String(Math.trunc(targetUserId))
      : queueMessage.peerId;
    const deliveryVisibility = actualChatType === 'direct' ? 'private_surface' : 'active_surface';

    if (actualChatType === 'group') {
      await this.recordLifeEventSafe({
        identityKey: 'xiaoni',
        eventKind: 'send_in_group',
        occurredAt: now,
        surface: 'qq',
        chatType: actualChatType,
        sessionKey: deliverySessionKey,
        surfaceId: deliverySessionKey,
        peerId: deliveryPeerId,
        accountId: queueMessage.accountId,
        batchId: queueMessage.batchId,
        runId,
        traceId: queueMessage.traceId,
        actorType: 'xiaoni',
        actorId: queueMessage.accountId,
        targetId: deliveryPeerId,
        visibility: 'active_surface',
        actionCost: replyActionCost,
        payload: {
          tool_name: input.toolName,
          forced: Boolean(input.forced),
          message_count: messages.length,
          sent_messages: messages,
          delivery: input.toolResult.delivery || null
        },
        dedupeKey: `send_in_group:${compactDedupePart(runId, queueMessage.traceId)}`
      });
    }

    for (const [index, content] of messages.entries()) {
      await this.recordLifeEventSafe({
        identityKey: 'xiaoni',
        eventKind: 'qq_self_message',
        occurredAt: now,
        surface: 'qq',
        chatType: actualChatType,
        sessionKey: deliverySessionKey,
        surfaceId: deliverySessionKey,
        peerId: deliveryPeerId,
        accountId: queueMessage.accountId,
        batchId: queueMessage.batchId,
        runId,
        traceId: queueMessage.traceId,
        actorType: 'xiaoni',
        actorId: queueMessage.accountId,
        targetId: deliveryPeerId,
        visibility: deliveryVisibility,
        actionCost: actualChatType === 'direct' && index === 0 ? replyActionCost : 0,
        payload: {
          tool_name: input.toolName,
          forced: Boolean(input.forced),
          index,
          content,
          delivery: input.toolResult.delivery || null
        },
        dedupeKey: `qq_self_message:${compactDedupePart(runId, queueMessage.traceId)}:${index}`
      });
    }
  }

  async recordNoVisibleDeliveryLifeEvent(input: {
    queueMessage: QueueMessagePayload;
    runId?: string;
    traceId?: string;
    outcome?: string | null;
    presenceOutcome?: string | null;
    leaseRelease: {
      reason: string;
      detail?: string | null;
      outcome?: string | null;
      noVisibleDelivery?: boolean;
    };
    modelRequestSlices?: number;
    conversationId?: number | null;
  }) {
    const now = new Date();
    const queueMessage = input.queueMessage;
    const runId = input.runId || queueMessage.runId;
    const traceId = input.traceId || queueMessage.traceId;
    const outcome = input.outcome || input.presenceOutcome || (isPresenceTickPayload(queueMessage) ? 'lurked' : 'silent');
    const firstMessage = queueMessage.messages[0] || null;

    await this.recordLifeEventSafe({
      identityKey: 'xiaoni',
      eventKind: 'no_visible_delivery_observed',
      occurredAt: now,
      surface: isPresenceTickPayload(queueMessage) ? 'presence_tick' : 'qq',
      chatType: queueMessage.chatType,
      sessionKey: queueMessage.sessionKey,
      surfaceId: queueMessage.sessionKey,
      peerId: queueMessage.peerId,
      accountId: queueMessage.accountId,
      messageSid: firstMessage?.messageSid || null,
      messageId: typeof firstMessage?.messageId === 'undefined' ? null : String(firstMessage.messageId),
      batchId: queueMessage.batchId,
      queueMessageId: firstMessage?.queueMessageId,
      runId,
      traceId,
      actorType: 'xiaoni',
      actorId: queueMessage.accountId,
      targetId: queueMessage.peerId,
      visibility: 'self_private',
      actionCost: isPresenceTickPayload(queueMessage) ? 0.01 : 0.005,
      payload: {
        run_id: runId,
        trace_id: traceId,
        chat_type: queueMessage.chatType,
        session_key: queueMessage.sessionKey,
        peer_id: queueMessage.peerId,
        peer_name: queueMessage.peerName || null,
        account_id: queueMessage.accountId,
        batch_id: queueMessage.batchId,
        source: queueMessage.source,
        outcome,
        presence_outcome: input.presenceOutcome || outcome,
        lease_release: {
          reason: input.leaseRelease.reason,
          detail: input.leaseRelease.detail || null,
          outcome: input.leaseRelease.outcome || null,
          no_visible_delivery: input.leaseRelease.noVisibleDelivery ?? true
        },
        reason: input.leaseRelease.detail || input.leaseRelease.reason,
        model_request_slices: input.modelRequestSlices ?? null,
        conversation_id: input.conversationId ?? null,
        unread_batch_size: queueMessage.messages.length
      },
      dedupeKey: `no_visible_delivery:${compactDedupePart(runId, traceId || 'lease')}:${compactDedupePart(queueMessage.sessionKey, 'session')}`
    });
  }

  async recordRecoverEnergyLifeEvent(input: {
    queueMessage: QueueMessagePayload;
    runId?: string;
    toolName: string;
    toolResult: Record<string, unknown>;
  }) {
    const now = new Date();
    const queueMessage = input.queueMessage;
    const runId = input.runId || queueMessage.runId;
    await this.recordLifeEventSafe({
      identityKey: 'xiaoni',
      eventKind: 'sleep_period',
      occurredAt: now,
      surface: isPresenceTickPayload(queueMessage) ? 'presence_tick' : 'qq',
      chatType: queueMessage.chatType,
      sessionKey: queueMessage.sessionKey,
      surfaceId: queueMessage.sessionKey,
      peerId: queueMessage.peerId,
      accountId: queueMessage.accountId,
      batchId: queueMessage.batchId,
      runId,
      traceId: queueMessage.traceId,
      actorType: 'xiaoni',
      actorId: queueMessage.accountId,
      targetId: queueMessage.peerId,
      visibility: 'self_private',
      actionCost: 0,
      payload: {
        tool_name: input.toolName,
        source: queueMessage.source,
        reason: typeof input.toolResult.reason === 'string' ? input.toolResult.reason : null,
        xiaoni_os: typeof input.toolResult.xiaoni_os === 'string' ? input.toolResult.xiaoni_os : null,
        duration_minutes: typeof input.toolResult.duration_minutes === 'number' ? input.toolResult.duration_minutes : null,
        duration_ms: typeof input.toolResult.duration_ms === 'number' ? input.toolResult.duration_ms : null,
        recovery_policy: 'recover_energy_tool_only'
      },
      dedupeKey: `sleep_period:${compactDedupePart(runId, queueMessage.traceId)}:recover_energy`
    });
    await updateAgentLifeState('xiaoni', {
      last_sleep_at: now
    }, databaseConfig).catch((error) => {
      moduleLogger.warn('Failed to update Xiaoni last_sleep_at after recover_energy', {
        traceId: queueMessage.traceId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    await this.refreshXiaoniLifeProjection(now).catch((error) => {
      moduleLogger.warn('Failed to refresh Xiaoni life projection after recover_energy', {
        traceId: queueMessage.traceId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  async recordRecoverySessionLifeEvent(
    session: {
      id: number;
      initiator: string;
      reason: string | null;
      xiaoniOs: string | null;
      traceId: string | null;
      runId: string | null;
      startedAt: string | null;
    },
    toolResult: Record<string, unknown>
  ) {
    const now = new Date();
    await this.recordLifeEventSafe({
      identityKey: 'xiaoni',
      eventKind: 'sleep_period',
      occurredAt: now,
      surface: 'runtime_recovery',
      runId: session.runId || undefined,
      traceId: session.traceId || undefined,
      actorType: 'xiaoni',
      actorId: 'xiaoni',
      visibility: 'self_private',
      actionCost: 0,
      payload: {
        recovery_session_id: session.id,
        initiator: session.initiator,
        reason: typeof toolResult.reason === 'string' ? toolResult.reason : session.reason,
        xiaoni_os: typeof toolResult.xiaoni_os === 'string' ? toolResult.xiaoni_os : session.xiaoniOs,
        sleep_minutes: typeof toolResult.sleep_minutes === 'number' ? toolResult.sleep_minutes : null,
        wake_cause: typeof toolResult.wake_cause === 'string' ? toolResult.wake_cause : null,
        wake_call_count: typeof toolResult.wake_call_count === 'number' ? toolResult.wake_call_count : null,
        wake_required_count: typeof toolResult.wake_required_count === 'number' ? toolResult.wake_required_count : null,
        energy_before: typeof toolResult.energy_before === 'number' ? toolResult.energy_before : null,
        energy: typeof toolResult.energy === 'number' ? toolResult.energy : null,
        max_energy: typeof toolResult.max_energy === 'number' ? toolResult.max_energy : 1,
        pressure: typeof toolResult.pressure === 'number' ? toolResult.pressure : null,
        recovery_policy: 'recover_energy_curve_session'
      },
      dedupeKey: `sleep_period:recovery_session:${session.id}`
    });
    await updateAgentLifeState('xiaoni', {
      last_sleep_at: now
    }, databaseConfig).catch((error) => {
      moduleLogger.warn('Failed to update Xiaoni last_sleep_at after recovery session', {
        recoverySessionId: session.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    await this.refreshXiaoniLifeProjection(now).catch((error) => {
      moduleLogger.warn('Failed to refresh Xiaoni life projection after recovery session', {
        recoverySessionId: session.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  async recordPresenceProactiveCompletion(queueMessage: QueueMessagePayload, outcome: string) {
    const now = new Date();
    const spoke = outcome === 'shared' || outcome === 'replied';
    const nextState: Record<string, unknown> = {
      last_proactive_at: now
    };
    if (spoke) {
      const currentDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const life = await getAgentLifeState('xiaoni', databaseConfig) || await ensureAgentLifeState('xiaoni', databaseConfig);
      const sameDay = isSameUtcDate(life.daily_proactive_date as Date | string | null | undefined, now);
      nextState.daily_proactive_date = currentDate;
      nextState.daily_proactive_count = sameDay ? { increment: 1 } : 1;
    }
    await updateAgentLifeState('xiaoni', nextState, databaseConfig);
    if (queueMessage.chatType === 'group') {
      await upsertAgentGroupPresenceState({
        identityKey: 'xiaoni',
        sessionKey: queueMessage.sessionKey,
        ...(spoke ? { lastSpokeAt: now } : {})
      }, databaseConfig);
    }
  }

  async buildPresenceContext(queueMessage: QueueMessagePayload): Promise<RuntimePresenceContext> {
    const now = new Date();
    const { projection, explanation } = await this.refreshXiaoniLifeProjection(now);
    const items = await listAgentSharePoolItems({
      identityKey: 'xiaoni',
      targetSessionKey: queueMessage.sessionKey,
      limit: 8
    }, databaseConfig) as PresenceSharePoolItem[];
    const scored = items
      .map((item) => ({ item, score: scoreSharePoolItem(item, now) }))
      .sort((left, right) => right.score.finalScore - left.score.finalScore);
    const selectedItems = scored.slice(0, 3).map((entry) => entry.item);
    const recallScores = scored.map((entry) => entry.score);
    return {
      sourceItems: selectedItems,
      recallScores,
      boundaryJudgments: selectedItems.map((item) => ({
        item_id: item.id,
        boundary_label: item.boundaryLabel,
        source_wording: item.sourceWording
      })),
      compressionMapping: {
        selected_item_ids: selectedItems.map((item) => item.id),
        life_projection_version: projection.version,
        reduced_through_event_id: projection.reducedThroughEventId,
        explanation_contributors: explanation.contributors,
        sections: ['source_items', 'recall_scores', 'boundary_judgments', 'life_projection']
      },
      lifeProjection: projection,
      lifeExplanation: explanation
    };
  }

  async recordPresenceSidecar(input: {
    queueMessage: QueueMessagePayload;
    presenceContext: RuntimePresenceContext;
    outcome?: string | null;
  }) {
    await createAgentPresenceStateSidecar({
      runId: input.queueMessage.runId,
      traceId: input.queueMessage.traceId,
      identityKey: 'xiaoni',
      targetSessionKey: input.queueMessage.sessionKey,
      sourceItems: input.presenceContext.sourceItems.map((item) => ({
        id: item.id,
        content: item.content,
        source_kind: item.sourceKind
      })),
      recallScores: input.presenceContext.recallScores,
      boundaryJudgments: input.presenceContext.boundaryJudgments,
      compressionMapping: input.presenceContext.compressionMapping,
      finalContextBlock: '',
      modelActionOutcome: input.outcome || null
    }, databaseConfig);

    for (const item of input.presenceContext.sourceItems) {
      await createAgentShareItemUsage({
        itemId: item.id,
        identityKey: 'xiaoni',
        targetSessionKey: input.queueMessage.sessionKey,
        targetGroupId: input.queueMessage.chatType === 'group' ? Number(input.queueMessage.peerId) : null,
        runId: input.queueMessage.runId,
        traceId: input.queueMessage.traceId,
        outcome: input.outcome || 'lurked'
      }, databaseConfig);

      await this.recordLifeEventSafe({
        identityKey: 'xiaoni',
        eventKind: 'pending_share_consumed',
        occurredAt: new Date(),
        surface: 'qq',
        chatType: input.queueMessage.chatType,
        sessionKey: input.queueMessage.sessionKey,
        surfaceId: input.queueMessage.sessionKey,
        peerId: input.queueMessage.peerId,
        accountId: input.queueMessage.accountId,
        batchId: input.queueMessage.batchId,
        runId: input.queueMessage.runId,
        traceId: input.queueMessage.traceId,
        actorType: 'xiaoni',
        actorId: input.queueMessage.accountId,
        targetId: input.queueMessage.peerId,
        visibility: 'self_private',
        actionCost: 0.002,
        payload: {
          share_pool_item_id: item.id,
          source_kind: item.sourceKind,
          source_wording: item.sourceWording,
          outcome: input.outcome || 'lurked'
        },
        dedupeKey: `pending_share_consumed:${item.id}:${compactDedupePart(input.queueMessage.runId, input.queueMessage.traceId)}`
      });
    }
  }

  async listMediaAssetsForQueueMessage(queueMessage: QueueMessagePayload) {
    const messageSids = queueMessage.messages
      .map((message) => message.messageSid)
      .filter(Boolean);
    return listAgentMediaAssets({
      sessionKey: queueMessage.sessionKey,
      messageSids,
      limit: 50
    }, databaseConfig);
  }

  async getMediaAssetByTag(sessionKey: string, mediaTag: string) {
    return getAgentMediaAssetByTag({
      sessionKey,
      mediaTag,
      limit: 1
    }, databaseConfig);
  }

  async getMediaAssetById(_sessionKey: string, assetId: string) {
    return getAgentMediaAssetById({
      id: assetId
    }, databaseConfig);
  }

  async recordMediaObservation(input: Record<string, unknown>) {
    return createAgentMediaObservation(input, databaseConfig);
  }

  async createRuntimeTask(input: Record<string, unknown>) {
    return createAgentTask(input, databaseConfig);
  }

  async claimNextQueueMessage(workerId: string): Promise<QueueMessageRecord | null> {
    return claimNextAgentQueueMessage({
      workerId,
      sqlAdapter: this.sql
    }, databaseConfig) as Promise<QueueMessageRecord | null>;
  }

  async enqueueQueueMessage(input: {
    message: Record<string, unknown>;
    payload?: Record<string, unknown>;
    availableAt?: string | Date;
  }) {
    return enqueueAgentQueueMessage(input, databaseConfig);
  }

  async settleQueueMessages(runId: string, params: { conversationId?: number | null; result?: Record<string, unknown> }) {
    await settleAgentQueueMessages({
      runId,
      conversationId: params.conversationId ?? null,
      result: params.result || {},
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async failQueueMessage(runId: string, errorMessage: string, conversationId?: number | null) {
    await failAgentQueueMessage({
      runId,
      errorMessage,
      conversationId: conversationId ?? null,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async retryQueueMessage(runId: string, params: { errorMessage: string; retryDelayMs?: number }) {
    return retryAgentQueueMessage({
      runId,
      errorMessage: params.errorMessage,
      retryDelayMs: params.retryDelayMs ?? 0,
      sqlAdapter: this.sql
    }, databaseConfig) as Promise<number>;
  }

  async releaseExecutionLease(runId: string, updates: {
    status: string;
    leaseRelease: {
      reason: string;
      detail?: string | null;
      outcome?: string | null;
    };
    noVisibleDelivery: boolean;
    finalResponse?: string | null;
    sentMessages?: string[];
    modelRequestSlices?: number;
    errorMessage?: string | null;
    conversationId?: number | null;
  }) {
    await releaseExecutionLeasePersistence({
      runId,
      ...updates,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async getExecutionLeaseDeliveryState(runId: string): Promise<ExecutionLeaseDeliveryState> {
    return getExecutionLeaseDeliveryStatePersistence({
      runId,
      sqlAdapter: this.sql
    }, databaseConfig) as Promise<ExecutionLeaseDeliveryState>;
  }

  async markLeaseVisibleDeliveryCommitted(runId: string) {
    await markLeaseVisibleDeliveryCommittedPersistence({
      runId,
      sqlAdapter: this.sql
    }, databaseConfig);
    await this.recordLifeEventSafe({
      identityKey: 'xiaoni',
      eventKind: 'visible_delivery_committed',
      occurredAt: new Date(),
      runId,
      actorType: 'xiaoni',
      actorId: 'xiaoni',
      visibility: 'operator_only',
      payload: {
        delivery_phase: 'delivery_committed'
      },
      dedupeKey: `visible_delivery_committed:${compactDedupePart(runId, 'lease')}`
    });
  }

  async markLeaseDeliveryBlocked(runId: string, reason: string) {
    await markLeaseDeliveryBlockedPersistence({
      runId,
      reason,
      sqlAdapter: this.sql
    }, databaseConfig);
    await this.recordLifeEventSafe({
      identityKey: 'xiaoni',
      eventKind: 'post_commit_side_effect_blocked',
      occurredAt: new Date(),
      runId,
      actorType: 'xiaoni',
      actorId: 'xiaoni',
      visibility: 'operator_only',
      payload: {
        reason
      },
      dedupeKey: `post_commit_side_effect_blocked:${compactDedupePart(runId, 'lease')}:${Date.now()}:${uuidv4().slice(0, 8)}`
    });
  }

  async createLlmJob(params: {
    traceId: string;
    sessionId: string;
    agentType: string;
    metadata?: Record<string, unknown>;
  }) {
    return createLlmJobPersistence({
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async updateLlmJob(jobId: string, updates: {
    status: string;
    finalResponse?: string | null;
    errorMessage?: string | null;
    totalTurns?: number;
    conversationId?: number | null;
    metadata?: Record<string, unknown>;
  }) {
    await updateLlmJobPersistence({
      jobId,
      ...updates,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async getAgentStackHead(identityKey = 'xiaoni') {
    return getAgentStackHeadPersistence({
      identityKey,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async appendAgentStackItems(params: {
    identityKey?: string;
    traceId?: string | null;
    runId?: string | null;
    conversationId?: number | null;
    sourceType?: string | null;
    sourceId?: string | null;
    llmRequestSliceId?: string | null;
    items: Array<Record<string, unknown>>;
  }) {
    return appendAgentStackItemsPersistence({
      identityKey: params.identityKey || 'xiaoni',
      traceId: params.traceId || null,
      runId: params.runId || null,
      conversationId: params.conversationId ?? null,
      sourceType: params.sourceType || null,
      sourceId: params.sourceId || null,
      llmRequestSliceId: params.llmRequestSliceId || null,
      items: params.items,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async listAgentStackItems(params: {
    identityKey?: string;
    traceId?: string | null;
    runId?: string | null;
    conversationId?: number | string | null;
    itemKind?: string | null;
    limit?: number;
    chronological?: boolean;
  } = {}) {
    return listAgentStackItemsPersistence({
      identityKey: params.identityKey || 'xiaoni',
      traceId: params.traceId || null,
      runId: params.runId || null,
      conversationId: params.conversationId ?? null,
      itemKind: params.itemKind || null,
      limit: params.limit,
      chronological: params.chronological,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async listAgentStackItemsForConversations(params: {
    identityKey?: string;
    conversationIds: Array<number | string>;
    limit?: number;
  }) {
    return listAgentStackItemsForConversationsPersistence({
      identityKey: params.identityKey || 'xiaoni',
      conversationIds: params.conversationIds,
      limit: params.limit,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async updateLlmRequestSliceStackLinks(params: {
    sliceId: string;
    inputStartIndex?: number | null;
    inputEndIndex?: number | null;
    inputStackItemIds?: Array<string | number>;
    outputStartIndex?: number | null;
    outputEndIndex?: number | null;
  }) {
    return updateLlmRequestSliceStackLinksPersistence({
      identityKey: 'xiaoni',
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async recordAgentStackToolExecution(params: {
    executionId: string;
    llmRequestSliceId?: string | null;
    llmCallId?: string | null;
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    rawArguments?: string | null;
    result?: Record<string, unknown>;
    status: string;
    errorMessage?: string | null;
    sideEffect?: boolean;
    traceId: string;
    runId: string;
    conversationId?: number | null;
    agentTurn: number;
    stackCallItemId?: string | number | null;
    stackOutputItemId?: string | number | null;
    metadata?: Record<string, unknown>;
  }) {
    return recordToolExecutionPersistence({
      identityKey: 'xiaoni',
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async completeAgentStackToolExecution(params: {
    executionId: string;
    status: string;
    result?: Record<string, unknown>;
    errorMessage?: string | null;
    stackOutputItemId?: string | number | null;
  }) {
    return completeAgentStackToolExecutionPersistence({
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async recordCoreMemoryCompressionForkRun(params: {
    forkRunId: string;
    contextSessionKey?: string | null;
    status: string;
    traceId: string;
    runId: string;
    conversationId?: number | null;
    readCutoffAfterConversationId?: number | null;
    previousReadCutoffAfterConversationId?: number | null;
    summaryText?: string | null;
    artifact?: Record<string, unknown>;
    errorMessage?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    return recordCoreMemoryCompressionForkRunPersistence({
      identityKey: 'xiaoni',
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async completeCoreMemoryCompressionForkRun(params: {
    forkRunId: string;
    status: string;
    summaryText?: string | null;
    artifact?: Record<string, unknown>;
    errorMessage?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    return completeCoreMemoryCompressionForkRunPersistence({
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async findActiveCoreMemoryCompressionForkRun(params: {
    contextSessionKey: string;
    compressionCoveredEndConversationId: number;
    staleAfterMinutes?: number;
  }) {
    return findActiveCoreMemoryCompressionForkRunPersistence({
      identityKey: 'xiaoni',
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  // Boot-time recovery: agent-service's fork promises die with the process, so
  // any fork-run row still 'running' at our startup is orphaned. Mark them
  // failed so a stale core-memory row stops blocking the manual 压缩记忆 trigger.
  async reapOrphanedForkRuns(params: { reason?: string } = {}) {
    return reapOrphanedForkRunsPersistence({
      identityKey: 'xiaoni',
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async appendCoreMemoryCompressionForkItems(params: {
    forkRunId: string;
    traceId?: string | null;
    runId?: string | null;
    conversationId?: number | null;
    sourceType?: string | null;
    sourceId?: string | null;
    llmRequestSliceId?: string | null;
    items: Array<Record<string, unknown>>;
  }) {
    return appendCoreMemoryCompressionForkItemsPersistence({
      identityKey: 'xiaoni',
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async recordCoreMemoryCompressionForkSlice(params: {
    forkRunId: string;
    sliceId: string;
    llmCallId?: string | null;
    inputStartIndex?: number | null;
    inputEndIndex?: number | null;
    inputStackItemIds?: Array<string | number>;
    outputStartIndex?: number | null;
    outputEndIndex?: number | null;
    canonicalRequest?: Record<string, unknown>;
    wireRequest?: Record<string, unknown> | null;
    canonicalResponse?: Record<string, unknown> | null;
    wireResponse?: Record<string, unknown> | null;
    rawResponse?: Record<string, unknown> | null;
    outputItems?: Array<Record<string, unknown>>;
    status?: string;
    tokenUsage?: Record<string, unknown>;
    traceId?: string | null;
    runId?: string | null;
    conversationId?: number | null;
    agentTurn?: number | null;
    modelName?: string | null;
    modelProvider?: string | null;
    requestFormatVersion?: string | null;
    wireProviderFormat?: string | null;
    processingTimeMs?: number | null;
    metadata?: Record<string, unknown>;
  }) {
    return recordCoreMemoryCompressionForkSlicePersistence({
      identityKey: 'xiaoni',
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async recordSubconsciousAgentForkRun(params: {
    forkRunId: string;
    contextSessionKey?: string | null;
    status: string;
    traceId: string;
    runId: string;
    conversationId?: number | null;
    notifyQueueMessageId?: number | null;
    summaryText?: string | null;
    artifact?: Record<string, unknown>;
    errorMessage?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    return recordSubconsciousAgentForkRunPersistence({
      identityKey: 'xiaoni',
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async completeSubconsciousAgentForkRun(params: {
    forkRunId: string;
    status: string;
    notifyQueueMessageId?: number | null;
    summaryText?: string | null;
    artifact?: Record<string, unknown>;
    errorMessage?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    return completeSubconsciousAgentForkRunPersistence({
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async appendSubconsciousAgentForkItems(params: {
    forkRunId: string;
    traceId?: string | null;
    runId?: string | null;
    conversationId?: number | null;
    sourceType?: string | null;
    sourceId?: string | null;
    llmRequestSliceId?: string | null;
    items: Array<Record<string, unknown>>;
  }) {
    return appendSubconsciousAgentForkItemsPersistence({
      identityKey: 'xiaoni',
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async recordSubconsciousAgentForkSlice(params: {
    forkRunId: string;
    sliceId: string;
    llmCallId?: string | null;
    inputStartIndex?: number | null;
    inputEndIndex?: number | null;
    inputStackItemIds?: Array<string | number>;
    outputStartIndex?: number | null;
    outputEndIndex?: number | null;
    canonicalRequest?: Record<string, unknown>;
    wireRequest?: Record<string, unknown> | null;
    canonicalResponse?: Record<string, unknown> | null;
    wireResponse?: Record<string, unknown> | null;
    rawResponse?: Record<string, unknown> | null;
    outputItems?: Array<Record<string, unknown>>;
    status?: string;
    tokenUsage?: Record<string, unknown>;
    traceId?: string | null;
    runId?: string | null;
    conversationId?: number | null;
    agentTurn?: number | null;
    modelName?: string | null;
    modelProvider?: string | null;
    requestFormatVersion?: string | null;
    wireProviderFormat?: string | null;
    processingTimeMs?: number | null;
    metadata?: Record<string, unknown>;
  }) {
    return recordSubconsciousAgentForkSlicePersistence({
      identityKey: 'xiaoni',
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async recordSubconsciousAgentForkToolExecution(params: {
    forkRunId: string;
    executionId: string;
    llmRequestSliceId?: string | null;
    llmCallId?: string | null;
    toolCallId?: string | null;
    toolName: string;
    arguments?: Record<string, unknown>;
    rawArguments?: string | null;
    result?: Record<string, unknown>;
    status?: string;
    errorMessage?: string | null;
    sideEffect?: boolean;
    traceId?: string | null;
    runId?: string | null;
    conversationId?: number | null;
    agentTurn?: number | null;
    stackCallItemId?: string | number | null;
    stackOutputItemId?: string | number | null;
    metadata?: Record<string, unknown>;
  }) {
    return recordSubconsciousAgentForkToolExecutionPersistence({
      identityKey: 'xiaoni',
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async completeSubconsciousAgentForkToolExecution(params: {
    executionId: string;
    status: string;
    result?: Record<string, unknown>;
    errorMessage?: string | null;
    stackOutputItemId?: string | number | null;
  }) {
    return completeSubconsciousAgentForkToolExecutionPersistence({
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async recordImageVisionForkRun(params: {
    forkRunId: string;
    status: string;
    traceId: string;
    runId: string;
    conversationId?: number | null;
    assetId?: string | null;
    imageId?: string | null;
    mediaTag?: string | null;
    observationId?: number | string | null;
    description?: string | null;
    artifact?: Record<string, unknown>;
    errorMessage?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    return recordImageVisionForkRunPersistence({
      identityKey: 'xiaoni',
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async completeImageVisionForkRun(params: {
    forkRunId: string;
    status: string;
    observationId?: number | string | null;
    description?: string | null;
    artifact?: Record<string, unknown>;
    errorMessage?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    return completeImageVisionForkRunPersistence({
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async appendImageVisionForkItems(params: {
    forkRunId: string;
    traceId?: string | null;
    runId?: string | null;
    conversationId?: number | null;
    sourceType?: string | null;
    sourceId?: string | null;
    llmRequestSliceId?: string | null;
    items: Array<Record<string, unknown>>;
  }) {
    return appendImageVisionForkItemsPersistence({
      identityKey: 'xiaoni',
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async recordImageVisionForkSlice(params: {
    forkRunId: string;
    sliceId: string;
    llmCallId?: string | null;
    inputStartIndex?: number | null;
    inputEndIndex?: number | null;
    inputStackItemIds?: Array<string | number>;
    outputStartIndex?: number | null;
    outputEndIndex?: number | null;
    canonicalRequest?: Record<string, unknown>;
    wireRequest?: Record<string, unknown> | null;
    canonicalResponse?: Record<string, unknown> | null;
    wireResponse?: Record<string, unknown> | null;
    rawResponse?: Record<string, unknown> | null;
    outputItems?: Array<Record<string, unknown>>;
    status?: string;
    tokenUsage?: Record<string, unknown>;
    traceId?: string | null;
    runId?: string | null;
    conversationId?: number | null;
    agentTurn?: number | null;
    modelName?: string | null;
    modelProvider?: string | null;
    requestFormatVersion?: string | null;
    wireProviderFormat?: string | null;
    processingTimeMs?: number | null;
    metadata?: Record<string, unknown>;
  }) {
    return recordImageVisionForkSlicePersistence({
      identityKey: 'xiaoni',
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async recordCoreMemoryCompressionForkToolExecution(params: {
    forkRunId: string;
    executionId: string;
    llmRequestSliceId?: string | null;
    llmCallId?: string | null;
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    rawArguments?: string | null;
    result?: Record<string, unknown>;
    status: string;
    errorMessage?: string | null;
    sideEffect?: boolean;
    traceId: string;
    runId: string;
    conversationId?: number | null;
    agentTurn: number;
    stackCallItemId?: string | number | null;
    stackOutputItemId?: string | number | null;
    metadata?: Record<string, unknown>;
  }) {
    return recordCoreMemoryCompressionForkToolExecutionPersistence({
      identityKey: 'xiaoni',
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async completeCoreMemoryCompressionForkToolExecution(params: {
    executionId: string;
    status: string;
    result?: Record<string, unknown>;
    errorMessage?: string | null;
    stackOutputItemId?: string | number | null;
  }) {
    return completeCoreMemoryCompressionForkToolExecutionPersistence({
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async logTimelineEvent(params: {
    traceId: string;
    eventType: string;
    eventName: string;
    eventPhase?: string | null;
    conversationId?: number | null;
    metadata?: Record<string, unknown>;
    durationMs?: number | null;
  }) {
    await logRuntimeTimelineEvent({
      ...params,
      component: 'agent-service',
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async listRecentTurns(params: {
    userId: number;
    groupId?: number | null;
    afterConversationId?: number | null;
    limit?: number;
    scope?: 'session' | 'global';
  }): Promise<ConversationTurn[]> {
    return listRecentConversationTurns({
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig) as Promise<ConversationTurn[]>;
  }

  async getSessionReadCutoffState(sessionKey: string): Promise<SessionReadCutoffState | null> {
    return getSessionReadCutoffStatePersistence({
      sessionKey,
      sqlAdapter: this.sql
    }, databaseConfig) as Promise<SessionReadCutoffState | null>;
  }

  async upsertSessionReadCutoffState(params: {
    sessionKey: string;
    readCutoffAfterConversationId: number | null;
    lastContextWindowTokens: number;
    lastTargetBudgetTokens: number;
    lastHardBudgetTokens: number;
  }) {
    await upsertSessionReadCutoffStatePersistence({
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async commitSessionContextSummaryAndReadCutoff(params: {
    sessionKey: string;
    contextSummary: string;
    readCutoffAfterConversationId: number;
    lastContextWindowTokens: number;
    lastTargetBudgetTokens: number;
    lastHardBudgetTokens: number;
  }): Promise<{ committed: boolean; state: SessionReadCutoffState | null }> {
    return commitSessionContextSummaryAndReadCutoffPersistence({
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig) as Promise<{ committed: boolean; state: SessionReadCutoffState | null }>;
  }

  async upsertProactiveShareState(sessionKey: string, share: string | null, age: number) {
    await upsertProactiveShareStatePersistence({
      sessionKey,
      share,
      age,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async upsertSessionContextSummary(params: {
    sessionKey: string;
    contextSummary: string;
  }) {
    await upsertSessionContextSummaryPersistence({
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async loadSessionReplayState(params: {
    userId: number;
    groupId?: number | null;
  }): Promise<{
    summaryText: string | null;
    summarizedThroughConversationId: number | null;
  }> {
    return loadSessionReplayStatePersistence({
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig) as Promise<{
      summaryText: string | null;
      summarizedThroughConversationId: number | null;
    }>;
  }

  async getSpeakerTrustLevel(identityKey: string, speakerQq: number): Promise<'L1' | 'L2' | 'L3' | 'L4'> {
    try {
      return await getRelationshipTrustLevel(identityKey, speakerQq, databaseConfig);
    } catch {
      return 'L1';
    }
  }

  async updateSpeakerTrustLevel(identityKey: string, speakerQq: number, trustScore: number, level: 'L1' | 'L2' | 'L3' | 'L4') {
    try {
      await upsertRelationshipTrust({ identityKey, speakerQq, trustScore, level }, databaseConfig);
    } catch {
      // Non-fatal — trust update failure doesn't block the main flow
    }
  }

  async getSessionEmotionalState(_sessionKey: string): Promise<{ dopamine: 'low' | 'medium' | 'high'; stress: 'low' | 'medium' | 'high' } | null> {
    try {
      const { projection } = await this.refreshXiaoniLifeProjection(new Date());
      const state = projection.state;
      const dopamine: 'low' | 'medium' | 'high' = state.sharingDesire > 0.66 ? 'high' : state.sharingDesire < 0.33 ? 'low' : 'medium';
      const stress: 'low' | 'medium' | 'high' = state.fatigue > 0.75 ? 'high' : state.fatigue > 0.45 ? 'medium' : 'low';
      return { dopamine, stress };
    } catch {
      return null;
    }
  }

  async updateSessionEmotionalState(_sessionKey: string, dopamine: 'low' | 'medium' | 'high', stress: 'low' | 'medium' | 'high') {
    try {
      const now = new Date();
      await updateAgentLifeState('xiaoni', {
        ...(dopamine === 'high' || stress === 'low' ? { last_boredom_reset_at: now } : {}),
        last_active_at: now
      }, databaseConfig);
    } catch {
      // Non-fatal — state update failure doesn't block the main flow
    }
  }

  async incrementSpeakerTrustLevel(identityKey: string, speakerQq: number, delta: number) {
    try {
      await incrementRelationshipTrust({ identityKey, speakerQq, delta }, databaseConfig);
    } catch {
      // Non-fatal — trust increment failure doesn't block the main flow
    }
  }

  async listInboundMessagesForMemoryBackfill(params: {
    groupId: string;
    offset?: number;
    limit?: number | null;
  }) {
    return listAgentInboundMessages({
      chatType: 'group',
      peerId: params.groupId,
      offset: params.offset ?? 0,
      limit: params.limit ?? undefined
    }, databaseConfig);
  }

  async getQqUsageUnreadSummary(): Promise<QqUsageUnreadSummary> {
    return getQqUsageUnreadSummary({}, databaseConfig);
  }

  async listQqUsageThreads(params: { limit?: number; offset?: number }): Promise<QqUsageThreadList> {
    return listQqUsageThreads({
      limit: params.limit,
      offset: params.offset
    }, databaseConfig);
  }

  async searchQqUsageThreads(params: {
    query: string;
    chatType?: 'direct' | 'group';
    limit?: number;
    offset?: number;
  }): Promise<QqUsageThreadList> {
    return searchQqUsageThreads({
      query: params.query,
      chatType: params.chatType,
      limit: params.limit,
      offset: params.offset
    }, databaseConfig);
  }

  async listQqUsageThreadWindow(params: {
    threadKey: string;
    mode?: 'latest' | 'older' | 'newer';
    anchorMessageId?: number | string | null;
    limit?: number;
  }): Promise<QqUsageThreadWindow> {
    return listQqUsageThreadWindow({
      threadKey: params.threadKey,
      mode: params.mode,
      anchorMessageId: params.anchorMessageId ?? null,
      limit: params.limit
    }, databaseConfig);
  }

  async recordQqUsageThreadSeen(
    result: QqUsageThreadWindow,
    action: string,
    context: {
      traceId?: string | null;
      runId?: string | null;
      batchId?: string | null;
      toolCallId?: string | null;
      toolName?: string | null;
      sessionKey?: string | null;
    } = {}
  ): Promise<void> {
    const messages = Array.isArray(result.messages) ? result.messages : [];
    if (!result.threadKey || messages.length === 0) {
      return;
    }
    const latest = messages[messages.length - 1] || {};
    const chatType = latest.chat_type === 'group' ? 'group' : 'direct';
    const peerId = String(latest.peer_id || '');
    const accountId = String(latest.account_id || agentConfig.botAccountId || '1129974489');
    const now = new Date();

    await renewQqAttentionLease({
      threadKey: result.threadKey,
      action,
      chatType,
      peerId,
      peerName: latest.peer_name || null,
      accountId,
      latestMessageId: result.latestMessageId,
      traceId: context.traceId || null,
      runId: context.runId || null,
      batchId: context.batchId || null,
      toolCallId: context.toolCallId || null,
      metadata: {
        source: 'qq_usage',
        action,
        cursor_anchor: result.cursorAnchor || null,
        earliest_message_id: result.earliestMessageId,
        latest_message_id: result.latestMessageId,
        window_unread_count: result.windowUnreadCount
      }
    }, databaseConfig).catch((error) => {
      moduleLogger.warn('Failed to renew QQ attention lease', {
        threadKey: result.threadKey,
        action,
        error: error instanceof Error ? error.message : String(error)
      });
    });

    await this.recordLifeEventSafe({
      identityKey: 'xiaoni',
      eventKind: 'surface_visit',
      occurredAt: now,
      surface: 'qq',
      chatType,
      sessionKey: result.threadKey,
      surfaceId: result.threadKey,
      peerId,
      accountId,
      batchId: context.batchId || undefined,
      runId: context.runId || undefined,
      traceId: context.traceId || undefined,
      actorType: 'xiaoni',
      actorId: accountId,
      targetId: peerId,
      visibility: 'active_surface',
      actionCost: 0.01,
      attentionDelta: 0.2,
      payload: {
        source: 'qq_usage',
        action,
        unread_count: result.unreadCount,
        window_unread_count: result.windowUnreadCount,
        window_size: messages.length,
        trace_id: context.traceId || null,
        run_id: context.runId || null,
        batch_id: context.batchId || null,
        tool_call_id: context.toolCallId || null,
        tool_name: context.toolName || null,
        source_session_key: context.sessionKey || null
      },
      dedupeKey: `surface_visit:qq_usage:${compactDedupePart(action, 'action')}:${compactDedupePart(result.threadKey, 'thread')}:${compactDedupePart(result.cursorAnchor || String(result.latestMessageId || Date.now()), 'window')}`
    });

    for (const message of messages) {
      const messageSid = String(message.message_sid || message.messageSid || message.id || '');
      await this.recordLifeEventSafe({
        identityKey: 'xiaoni',
        eventKind: 'qq_message_seen',
        occurredAt: now,
        surface: 'qq',
        chatType: message.chat_type === 'group' ? 'group' : 'direct',
        sessionKey: result.threadKey,
        surfaceId: result.threadKey,
        peerId: String(message.peer_id || peerId),
        accountId: String(message.account_id || accountId),
        messageSid,
        messageId: String(message.id || ''),
        batchId: context.batchId || undefined,
        runId: context.runId || undefined,
        traceId: context.traceId || undefined,
        actorType: 'human',
        actorId: String(message.sender_id || ''),
        targetId: accountId,
        visibility: 'active_surface',
        attentionDelta: 0.1,
        payload: {
          source: 'qq_usage',
          action,
          sender_id: message.sender_id || null,
          sender_name: message.sender_name || null,
          peer_name: message.peer_name || null,
          was_mentioned: Number(message.was_mentioned || 0) === 1,
          body_for_agent: typeof message.body_for_agent === 'string' ? message.body_for_agent : null,
          raw_body: typeof message.raw_body === 'string' ? message.raw_body : null,
          message_timestamp: message.message_timestamp || null,
          trace_id: context.traceId || null,
          run_id: context.runId || null,
          batch_id: context.batchId || null,
          tool_call_id: context.toolCallId || null,
          tool_name: context.toolName || null,
          source_session_key: context.sessionKey || null
        },
        dedupeKey: `qq_message_seen:qq_usage:${messageSid || message.id || `${result.threadKey}:${action}`}`
      });
    }
  }

  async markQqUsageThreadRead(params: { threadKey?: string | null }): Promise<{ threadKey: string | null; clearedCount: number }> {
    const result = await markQqUsageThreadRead({
      threadKey: params.threadKey || null
    }, databaseConfig);
    if (result.threadKey) {
      await closeQqAttentionLease({
        threadKey: result.threadKey,
        reason: 'put_away'
      }, databaseConfig).catch((error) => {
        moduleLogger.warn('Failed to close QQ attention lease', {
          threadKey: result.threadKey,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    return result;
  }

  async setQqUsageGroupNotificationMode(params: {
    groupId: string | number | bigint;
    mode: 'all' | 'mentions_only' | string;
  }): Promise<{ groupId: number; notificationMode: 'all' | 'mentions_only' }> {
    return setQqUsageGroupNotificationMode({
      groupId: params.groupId,
      mode: params.mode
    }, databaseConfig);
  }

  async setQqUsageGroupNotificationAggregationSeconds(params: {
    groupId: string | number | bigint;
    seconds: number;
  }): Promise<{ groupId: number; notificationAggregationSeconds: number }> {
    return setQqUsageGroupNotificationAggregationSeconds({
      groupId: params.groupId,
      seconds: params.seconds
    }, databaseConfig);
  }

  async setQqUsageActiveSurface(params: {
    threadKey: string;
    chatType: 'direct' | 'group';
    peerId?: string | null;
    accountId?: string | null;
  }): Promise<void> {
    await setQqUsageActiveSurface({
      threadKey: params.threadKey,
      chatType: params.chatType,
      peerId: params.peerId || null,
      accountId: params.accountId || null
    }, databaseConfig).catch((error) => {
      moduleLogger.warn('Failed to update QQ active surface', {
        threadKey: params.threadKey,
        chatType: params.chatType,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  async clearQqUsageActiveSurface(params: { threadKey?: string | null } = {}): Promise<void> {
    await clearQqUsageActiveSurface({
      threadKey: params.threadKey || undefined
    }, databaseConfig).catch((error) => {
      moduleLogger.warn('Failed to clear QQ active surface', {
        threadKey: params.threadKey || null,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  async listRelevantFeedbackReflections(params: {
    sessionKey: string;
    groupId?: number | null;
    currentUserId: number;
    recentUserIds?: number[];
    queryText: string;
    limit?: number;
    socialActTypeHint?: UnreadMeaningSocialActType | null;
  }): Promise<RuntimeFeedbackReflection[]> {
    const [reflectionRows, learningStateRows] = await Promise.all([
      listFeedbackReflections({
        sessionKey: params.sessionKey,
        groupId: params.groupId ?? null,
        isActive: true,
        limit: 96
      }, databaseConfig),
      listFeedbackLearningStates({
        sessionKey: params.sessionKey,
        groupId: params.groupId ?? null,
        scopeType: 'group_self',
        limit: 64
      }, databaseConfig)
    ]);
    const reflections = reflectionRows.map((row) => parseFeedbackReflection(row as Record<string, unknown>));
    if (reflections.length === 0) {
      return [];
    }
    const learningStates = learningStateRows.map((row) => parseFeedbackLearningState(row as Record<string, unknown>));
    const recentUserIds = (Array.isArray(params.recentUserIds) ? params.recentUserIds : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    const embeddingScores = await this.computeFeedbackEmbeddingScores(reflections, params.queryText);
    const ranked = rankFeedbackReflectionsForRecall({
      reflections,
      learningStates,
      queryText: params.queryText,
      currentUserId: params.currentUserId,
      recentUserIds,
      embeddingScores,
      limit: Math.max(1, Math.min(params.limit ?? 3, 3)),
      socialActTypeHint: params.socialActTypeHint
    });
    const selected = ranked.map((item) => item.reflection);

    if (selected.length > 0) {
      await markFeedbackReflectionsHit(selected.map((item) => item.id), { hitAt: new Date() }, databaseConfig).catch(() => undefined);
    }

    return selected;
  }

  private async computeFeedbackEmbeddingScores(reflections: RuntimeFeedbackReflection[], queryText: string) {
    const normalizedQuery = queryText.trim();
    if (!normalizedQuery || reflections.length === 0) {
      return new Map<number, number>();
    }

    const indexedTexts = reflections
      .map((reflection) => ({
        reflectionId: reflection.id,
        text: reflection.embeddingText || reflection.retrievalText || reflection.summaryText
      }))
      .filter((item) => item.text.trim());
    if (indexedTexts.length === 0) {
      return new Map<number, number>();
    }

    try {
      const response = await fetch(`${agentConfig.providerServiceUrl}/v1/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          input: [normalizedQuery, ...indexedTexts.map((item) => item.text)]
        })
      });
      if (!response.ok) {
        return new Map<number, number>();
      }
      const payload = await response.json() as {
        data?: Array<{ embedding?: number[] }>;
      };
      const embeddings = Array.isArray(payload.data)
        ? payload.data.map((item) => Array.isArray(item.embedding) ? item.embedding : [])
        : [];
      if (embeddings.length !== indexedTexts.length + 1 || embeddings[0].length === 0) {
        return new Map<number, number>();
      }

      const queryEmbedding = embeddings[0];
      const scores = new Map<number, number>();
      for (let index = 0; index < indexedTexts.length; index += 1) {
        const vector = embeddings[index + 1];
        if (!Array.isArray(vector) || vector.length === 0 || vector.length !== queryEmbedding.length) {
          continue;
        }
        scores.set(indexedTexts[index]!.reflectionId, cosineSimilarity(queryEmbedding, vector));
      }
      return scores;
    } catch {
      return new Map<number, number>();
    }
  }

  async createFeedbackReflection(params: {
    sessionKey: string;
    groupId?: number | null;
    sourceUserId?: number | null;
    sourceUserName?: string | null;
    scopeType?: string;
    learningKey?: string;
    learningScope?: string;
    reflectionType?: string;
    feedbackKind?: string;
    confidence?: string;
    importanceScore?: number;
    evidenceWeight?: number;
    stabilityScore?: number;
    summaryText: string;
    retrievalText?: string | null;
    embeddingText?: string | null;
    sourceMessageIds?: number[];
    sourceEpisodeIds?: number[];
    sourceConversationId?: number | null;
    supersedesReflectionId?: number | null;
    conflictGroupKey?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    return createFeedbackReflection({
      sessionKey: params.sessionKey,
      groupId: params.groupId ?? null,
      sourceUserId: params.sourceUserId ?? null,
      sourceUserName: params.sourceUserName ?? null,
      scopeType: params.scopeType || 'group_self',
      learningKey: params.learningKey || 'feedback.general',
      learningScope: params.learningScope || params.scopeType || 'group_self',
      reflectionType: params.reflectionType || 'social_lesson',
      feedbackKind: params.feedbackKind || 'mixed',
      confidence: params.confidence || 'medium',
      importanceScore: params.importanceScore ?? 0,
      evidenceWeight: params.evidenceWeight ?? 0,
      stabilityScore: params.stabilityScore ?? 0,
      summaryText: params.summaryText,
      retrievalText: params.retrievalText ?? null,
      embeddingText: params.embeddingText ?? null,
      sourceMessageIds: params.sourceMessageIds || [],
      sourceEpisodeIds: params.sourceEpisodeIds || [],
      sourceConversationId: params.sourceConversationId ?? null,
      supersedesReflectionId: params.supersedesReflectionId ?? null,
      conflictGroupKey: params.conflictGroupKey ?? null,
      metadata: params.metadata || {}
    }, databaseConfig);
  }

  async createFeedbackEpisode(params: {
    sessionKey: string;
    groupId?: number | null;
    sourceUserId?: number | null;
    sourceUserName?: string | null;
    scopeType?: string;
    eventKind?: string;
    excerptText?: string | null;
    sourceMessageIds?: number[];
    sourceConversationId?: number | null;
    eventImportance?: number;
    sourceSalience?: number;
    metadata?: Record<string, unknown>;
  }) {
    const row = await createFeedbackEpisode({
      sessionKey: params.sessionKey,
      groupId: params.groupId ?? null,
      sourceUserId: params.sourceUserId ?? null,
      sourceUserName: params.sourceUserName ?? null,
      scopeType: params.scopeType || 'group_self',
      eventKind: params.eventKind || 'feedback',
      excerptText: params.excerptText ?? null,
      sourceMessageIds: params.sourceMessageIds || [],
      sourceConversationId: params.sourceConversationId ?? null,
      eventImportance: params.eventImportance ?? 0,
      sourceSalience: params.sourceSalience ?? 0,
      metadata: params.metadata || {}
    }, databaseConfig);
    return parseFeedbackEpisode(row as Record<string, unknown>);
  }

  async createAgentMemoryObservation(params: {
    sessionKey: string;
    groupId?: number | null;
    sourceConversationId?: number | null;
    sourceTurnIds?: number[];
    sourceMessageIds?: number[];
    topic: string;
    text: string;
    poignancy?: number;
    participants?: Array<Record<string, unknown>>;
    xiaoniRole: string;
    sourceTraceId?: string | null;
    sourceRunId?: string | null;
    writerModel?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    return createAgentMemoryObservation({
      sessionKey: params.sessionKey,
      groupId: params.groupId ?? null,
      sourceConversationId: params.sourceConversationId ?? null,
      sourceTurnIds: params.sourceTurnIds || [],
      sourceMessageIds: params.sourceMessageIds || [],
      topic: params.topic,
      text: params.text,
      poignancy: params.poignancy ?? 1,
      participants: params.participants || [],
      xiaoniRole: params.xiaoniRole,
      sourceTraceId: params.sourceTraceId ?? null,
      sourceRunId: params.sourceRunId ?? null,
      writerModel: params.writerModel ?? null,
      metadata: params.metadata || {}
    }, databaseConfig);
  }

  async createAgentMemoryAssertion(params: {
    sessionKey: string;
    groupId?: number | null;
    sourceConversationId?: number | null;
    sourceTurnIds?: number[];
    sourceMessageIds?: number[];
    text: string;
    factType: string;
    entities?: Array<Record<string, unknown>>;
    participants?: Array<Record<string, unknown>>;
    sourceTraceId?: string | null;
    sourceRunId?: string | null;
    writerModel?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    return createAgentMemoryAssertion({
      sessionKey: params.sessionKey,
      groupId: params.groupId ?? null,
      sourceConversationId: params.sourceConversationId ?? null,
      sourceTurnIds: params.sourceTurnIds || [],
      sourceMessageIds: params.sourceMessageIds || [],
      text: params.text,
      factType: params.factType,
      entities: params.entities || [],
      participants: params.participants || [],
      sourceTraceId: params.sourceTraceId ?? null,
      sourceRunId: params.sourceRunId ?? null,
      writerModel: params.writerModel ?? null,
      metadata: params.metadata || {}
    }, databaseConfig);
  }

  async createAgentMemoryReflection(params: {
    sessionKey: string;
    groupId?: number | null;
    sourceConversationId?: number | null;
    text: string;
    kind: string;
    subjects?: string[];
    evidenceBasis: string;
    evidenceTimeStart?: string | Date | null;
    evidenceTimeEnd?: string | Date | null;
    poignancy?: number;
    sourceObservationIds?: number[];
    sourceMessageIds?: number[];
    sourceTraceId?: string | null;
    sourceRunId?: string | null;
    writerModel?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    return createAgentMemoryReflection({
      sessionKey: params.sessionKey,
      groupId: params.groupId ?? null,
      sourceConversationId: params.sourceConversationId ?? null,
      text: params.text,
      kind: params.kind,
      subjects: params.subjects || [],
      evidenceBasis: params.evidenceBasis,
      evidenceTimeStart: params.evidenceTimeStart ?? null,
      evidenceTimeEnd: params.evidenceTimeEnd ?? null,
      poignancy: params.poignancy ?? 1,
      sourceObservationIds: params.sourceObservationIds || [],
      sourceMessageIds: params.sourceMessageIds || [],
      sourceTraceId: params.sourceTraceId ?? null,
      sourceRunId: params.sourceRunId ?? null,
      writerModel: params.writerModel ?? null,
      metadata: params.metadata || {}
    }, databaseConfig);
  }

  async listAcceptedIdentityFacts(params: {
    identityKey: string;
    status?: string;
    factType?: string;
    limit?: number;
  }) {
    const rows = await listAcceptedIdentityFacts({
      identityKey: params.identityKey,
      status: params.status || 'active',
      factType: params.factType,
      limit: params.limit ?? 12
    }, databaseConfig);
    return rows.map((row: Record<string, unknown>) => parseAcceptedIdentityFact(row));
  }

  async ensureXiaoniIdentityRoot(params: {
    identityKey: string;
    sourcePromptId?: string | null;
    systemInstructionSnapshot: string;
    createdBy?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    return ensureXiaoniIdentityRoot({
      identityKey: params.identityKey,
      sourcePromptId: params.sourcePromptId ?? null,
      systemInstructionSnapshot: params.systemInstructionSnapshot,
      createdBy: params.createdBy ?? 'agent-service',
      metadata: params.metadata || {}
    }, databaseConfig);
  }

  async recordRuntimeIdentityActivationTrace(params: {
    identityKey: string;
    runId?: string | null;
    traceId?: string | null;
    conversationId?: number | null;
    sceneFingerprint?: string | null;
    cueSummary?: string | null;
    activatedRefs?: unknown[];
    suppressedRefs?: unknown[];
    selectedSkillRef?: string | null;
    activationReason?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    return recordRuntimeIdentityActivationTrace({
      identityKey: params.identityKey,
      runId: params.runId ?? null,
      traceId: params.traceId ?? null,
      conversationId: params.conversationId ?? null,
      sceneFingerprint: params.sceneFingerprint ?? null,
      cueSummary: params.cueSummary ?? null,
      activatedRefs: params.activatedRefs || [],
      suppressedRefs: params.suppressedRefs || [],
      selectedSkillRef: params.selectedSkillRef ?? null,
      activationReason: params.activationReason ?? null,
      metadata: params.metadata || {}
    }, databaseConfig);
  }

  async appendIdentityChangeCandidate(params: {
    identityKey: string;
    candidateType?: string;
    proposedBy?: string | null;
    proposedFrom?: string | null;
    claimText: string;
    beforeSummary?: string | null;
    afterSummary?: string | null;
    status?: string;
    judgeStatus?: string;
    judgeReason?: string | null;
    judgeRunId?: string | null;
    judgeLlmCallId?: string | null;
    quarantineGroupKey?: string | null;
    supersedesFactId?: number | null;
    metadata?: Record<string, unknown>;
    judgedAt?: string | Date | null;
    evidenceRefs?: IdentityEvidenceRefParams[];
    lineageMetadata?: Record<string, unknown>;
  }) {
    return appendIdentityChangeCandidate({
      identityKey: params.identityKey,
      candidateType: params.candidateType || 'natural_growth',
      proposedBy: params.proposedBy ?? null,
      proposedFrom: params.proposedFrom ?? null,
      claimText: params.claimText,
      beforeSummary: params.beforeSummary ?? null,
      afterSummary: params.afterSummary ?? null,
      status: params.status || 'pending',
      judgeStatus: params.judgeStatus || 'not_judged',
      judgeReason: params.judgeReason ?? null,
      judgeRunId: params.judgeRunId ?? null,
      judgeLlmCallId: params.judgeLlmCallId ?? null,
      quarantineGroupKey: params.quarantineGroupKey ?? null,
      supersedesFactId: params.supersedesFactId ?? null,
      metadata: params.metadata || {},
      judgedAt: params.judgedAt ?? null,
      evidenceRefs: params.evidenceRefs || [],
      lineageMetadata: params.lineageMetadata || {}
    }, databaseConfig);
  }

  async createAcceptedIdentityFact(params: {
    identityKey: string;
    factKey: string;
    factText: string;
    factType?: string;
    sourceCandidateId?: number | null;
    sourceEventId?: number | null;
    status?: string;
    confidence?: string;
    activationTags?: string[];
    metadata?: Record<string, unknown>;
    evidenceRefs?: IdentityEvidenceRefParams[];
    lineageMetadata?: Record<string, unknown>;
  }) {
    return createAcceptedIdentityFact({
      identityKey: params.identityKey,
      factKey: params.factKey,
      factText: params.factText,
      factType: params.factType || 'self_boundary',
      sourceCandidateId: params.sourceCandidateId ?? null,
      sourceEventId: params.sourceEventId ?? null,
      status: params.status || 'active',
      confidence: params.confidence || 'medium',
      activationTags: params.activationTags || [],
      metadata: params.metadata || {},
      evidenceRefs: params.evidenceRefs || [],
      lineageMetadata: params.lineageMetadata || {}
    }, databaseConfig);
  }

  async getFeedbackLearningState(params: {
    sessionKey: string;
    groupId?: number | null;
    scopeType?: string;
    learningKey: string;
    learningScope: string;
  }) {
    const row = await getFeedbackLearningState({
      sessionKey: params.sessionKey,
      groupId: params.groupId ?? null,
      scopeType: params.scopeType || 'group_self',
      learningKey: params.learningKey,
      learningScope: params.learningScope
    }, databaseConfig);
    return row ? parseFeedbackLearningState(row as Record<string, unknown>) : null;
  }

  async listFeedbackLearningStates(params: {
    sessionKey: string;
    groupId?: number | null;
    scopeType?: string;
    learningKey?: string;
    learningScope?: string;
    limit?: number;
  }) {
    const rows = await listFeedbackLearningStates({
      sessionKey: params.sessionKey,
      groupId: params.groupId ?? null,
      scopeType: params.scopeType,
      learningKey: params.learningKey,
      learningScope: params.learningScope,
      limit: params.limit
    }, databaseConfig);
    return rows.map((row) => parseFeedbackLearningState(row as Record<string, unknown>));
  }

  async upsertFeedbackLearningState(params: {
    sessionKey: string;
    groupId?: number | null;
    scopeType?: string;
    learningKey: string;
    learningScope: string;
    stateType?: string;
    activeReflectionId?: number | null;
    latestReflectionId?: number | null;
    activationWeight?: number;
    recencyWeight?: number;
    importanceWeight?: number;
    sourceWeight?: number;
    conflictPenalty?: number;
    metadata?: Record<string, unknown>;
  }) {
    const row = await upsertFeedbackLearningState({
      sessionKey: params.sessionKey,
      groupId: params.groupId ?? null,
      scopeType: params.scopeType || 'group_self',
      learningKey: params.learningKey,
      learningScope: params.learningScope,
      stateType: params.stateType || 'reinforced',
      activeReflectionId: params.activeReflectionId ?? null,
      latestReflectionId: params.latestReflectionId ?? null,
      activationWeight: params.activationWeight ?? 0,
      recencyWeight: params.recencyWeight ?? 0,
      importanceWeight: params.importanceWeight ?? 0,
      sourceWeight: params.sourceWeight ?? 0,
      conflictPenalty: params.conflictPenalty ?? 0,
      metadata: params.metadata || {}
    }, databaseConfig);
    return parseFeedbackLearningState(row as Record<string, unknown>);
  }

  private async loadTopicProjectionState(params: {
    userId: number;
    groupId?: number | null;
    recentUserIds?: number[];
  }): Promise<{
    activeTopics: RuntimeTopicProjection[];
  }> {
    const chatSpaceType = params.groupId && Number.isFinite(params.groupId) ? 'group' : 'direct';
    const chatSpaceId = chatSpaceType === 'group' ? Number(params.groupId) : Number(params.userId);
    if (!Number.isFinite(chatSpaceId) || chatSpaceId <= 0) {
      return { activeTopics: [] };
    }

    const topicRows = await listChatSpaceTopics({
      chatSpaceType,
      chatSpaceId,
      limit: 12
    }, databaseConfig);

    const collected: RuntimeTopicProjection[] = [];
    for (const topicRow of topicRows) {
      if (!topicRow || typeof topicRow !== 'object') {
        continue;
      }
      const status = typeof topicRow.status === 'string' ? topicRow.status.trim() : '';
      if (status === 'archived') {
        continue;
      }

      const candidateVersionId = Number((topicRow as Record<string, unknown>).current_candidate_version_id);
      const acceptedVersionId = Number((topicRow as Record<string, unknown>).current_accepted_version_id);
      const versionRef = Number.isFinite(candidateVersionId) && candidateVersionId > 0
        ? { versionId: candidateVersionId, source: 'candidate' as const }
        : Number.isFinite(acceptedVersionId) && acceptedVersionId > 0
          ? { versionId: acceptedVersionId, source: 'accepted' as const }
          : null;
      if (!versionRef) {
        continue;
      }

      const versionRow = await getTopicProjectionVersionById(versionRef.versionId, databaseConfig);
      if (!versionRow || typeof versionRow !== 'object') {
        continue;
      }

      const parsed = parseRuntimeTopicProjection({
        topicRow: topicRow as Record<string, unknown>,
        versionRow: versionRow as Record<string, unknown>,
        source: versionRef.source
      });
      if (parsed) {
        collected.push(parsed);
      }
    }

    const recentUserIds = Array.isArray(params.recentUserIds) ? params.recentUserIds : [];
    collected.sort((left, right) => {
      const leftSenderHit = left.participantIds.includes(params.userId) ? 1 : 0;
      const rightSenderHit = right.participantIds.includes(params.userId) ? 1 : 0;
      if (leftSenderHit !== rightSenderHit) {
        return rightSenderHit - leftSenderHit;
      }

      const leftRecentHit = recentUserIds.some((userId) => left.participantIds.includes(userId)) ? 1 : 0;
      const rightRecentHit = recentUserIds.some((userId) => right.participantIds.includes(userId)) ? 1 : 0;
      if (leftRecentHit !== rightRecentHit) {
        return rightRecentHit - leftRecentHit;
      }

      if (left.heatScore !== right.heatScore) {
        return right.heatScore - left.heatScore;
      }

      if (left.reviewPriorityScore !== right.reviewPriorityScore) {
        return right.reviewPriorityScore - left.reviewPriorityScore;
      }

      return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
    });

    return {
      activeTopics: collected.slice(0, 3)
    };
  }

  async buildMemoryRagContext(params: {
    userId: number;
    groupId?: number | null;
    currentMessageText: string;
    recentUserIds?: number[];
    targetTokenBudget?: number;
  }): Promise<RuntimeMemoryRagContext> {
    const replayState = await this.loadSessionReplayState({
      userId: params.userId,
      groupId: params.groupId ?? null
    });
    const history = await this.listRecentTurns({
      userId: params.userId,
      groupId: params.groupId ?? null,
      afterConversationId: replayState.summarizedThroughConversationId
    });

    const maxChars = estimateBudgetLength(params.targetTokenBudget || 12000);
    const pickedTurns: ConversationTurn[] = [];
    let usedChars = 0;

    for (const turn of [...history].reverse()) {
      const block = renderTranscriptItemForMemoryPack(turn);
      if (!block.trim()) {
        continue;
      }
      if (pickedTurns.length > 0 && usedChars + block.length > maxChars) {
        break;
      }
      pickedTurns.unshift(turn);
      usedChars += block.length;
    }

    const segments = pickedTurns.map((turn, index) => {
      const transcriptItems = Array.isArray(turn.items) ? turn.items : [];
      const messageIds = transcriptItems
        .map((item) => Number(item.id))
        .filter((value) => Number.isFinite(value) && value > 0);
      return {
        segmentId: `recent-turn-${index + 1}`,
        reason: index === 0 ? 'oldest retained recent turn' : index === pickedTurns.length - 1 ? 'latest retained recent turn' : 'recent thread continuation',
        source: 'recent_turns' as const,
        messageIds,
        content: renderTranscriptItemForMemoryPack(turn)
      };
    });

    const bridgeNotes = replayState.summaryText
      ? [{
          kind: 'compact_bridge' as const,
          summary: replayState.summaryText
        }]
      : [];

    return {
      packSummary: segments.length > 0
        ? 'Long-context memory pack stitched from recent transcript trajectory.'
        : bridgeNotes.length > 0
          ? 'No raw recent turns available, using compact bridge only.'
          : 'No historical memory context available.',
      timeScope: {
        oldestMessageAt: null,
        newestMessageAt: null
      },
      segments,
      bridgeNotes
    };
  }

  private async loadSelfEvolutionStates(params: {
    groupId: number | null;
    currentUserId: number;
    recentUserIds: number[];
    sessionKey: string;
  }): Promise<{
    groupStates: RuntimeSelfEvolutionState[];
    currentUserStates: RuntimeSelfEvolutionState[];
    recentUserStates: RuntimeSelfEvolutionState[];
  }> {
    if (!params.groupId || !Number.isFinite(params.groupId)) {
      return {
        groupStates: [],
        currentUserStates: [],
        recentUserStates: []
      };
    }

    const uniqueRecentUserIds = Array.from(new Set(
      params.recentUserIds
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0 && value !== params.currentUserId)
    )).slice(0, 2);

    const [groupRows, currentUserRows, ...recentRowsList] = await Promise.all([
      listSelfEvolutionStates({
        sessionKey: params.sessionKey,
        groupId: params.groupId,
        targetUserId: null,
        isActive: true,
        limit: 6
      }, databaseConfig),
      listSelfEvolutionStates({
        sessionKey: params.sessionKey,
        groupId: params.groupId,
        targetUserId: params.currentUserId,
        isActive: true,
        limit: 6
      }, databaseConfig),
      ...uniqueRecentUserIds.map((userId) => listSelfEvolutionStates({
        sessionKey: params.sessionKey,
        groupId: params.groupId as number,
        targetUserId: userId,
        isActive: true,
        limit: 4
      }, databaseConfig))
    ]);

    return {
      groupStates: groupRows.map((row) => parseSelfEvolutionState(row as Record<string, unknown>)),
      currentUserStates: currentUserRows.map((row) => parseSelfEvolutionState(row as Record<string, unknown>)),
      recentUserStates: recentRowsList.flat().map((row) => parseSelfEvolutionState(row as Record<string, unknown>))
    };
  }

  async createConversation(params: {
    batchId?: number | null;
    userId: number;
    groupId?: number | null;
    userMessage: string;
    aiResponse?: string | null;
    sessionKey?: string | null;
    transcriptItems?: ConversationTranscriptItemInput[];
    responseTimeMs: number;
    status: string;
    errorReason?: string | null;
    modelName?: string | null;
    traceId: string;
    rawRequest?: Record<string, unknown>;
    rawResponse?: Record<string, unknown>;
  }) {
    return createConversationWithItems({
      ...params,
      sqlAdapter: this.sql
    }, databaseConfig);
  }

  async attachConversationIdToTrace(traceId: string, conversationId: number) {
    await Promise.all([
      attachConversationIdToRuntimeTrace({
        traceId,
        conversationId,
        useCoalesceAssignment: true,
        sqlAdapter: this.sql
      }, databaseConfig),
      attachConversationIdToAgentStackByTrace({
        traceId,
        conversationId,
        sqlAdapter: this.sql
      }, databaseConfig)
    ]);
  }

  private async ensureSchema() {
    await ensureXiaoniAgentStackSchema({
      sqlAdapter: this.sql
    }, databaseConfig);
    await ensureAgentRuntimeSchema({
      profile: 'agent',
      sqlAdapter: this.sql
    }, databaseConfig);
  }
}
