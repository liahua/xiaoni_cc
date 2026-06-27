import type { PrismaClient } from './generated/client';

export type DatabaseUrlConfig = {
  databaseUrl?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  connectionLimit?: number;
  applicationName?: string;
};

export type SqlTransaction = {
  query<T = Record<string, unknown>>(query: string, params?: any[]): Promise<T[]>;
  execute(query: string, params?: any[]): Promise<number>;
  insert(query: string, params?: any[]): Promise<{ insertId: number; affectedRows: number }>;
};

export type SqlAdapter = SqlTransaction & {
  testConnection(): Promise<boolean>;
  withTransaction<T>(callback: (tx: SqlTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export type XiaoniRuntimePathClassification = {
  path: string;
  relativePath: string;
  runtimeDir: string | null;
  basename: string | null;
  extension: string | null;
  indexable: boolean;
  excluded: boolean;
  operation?: 'read' | 'write' | 'reference';
};

export type XiaoniPassiveRecallCueClass =
  | 'db_file_provenance'
  | 'db_life_cue'
  | 'db_spoken_fragment';

export type XiaoniPassiveRecallCue = {
  cueClass: XiaoniPassiveRecallCueClass;
  itemId: string | null;
  source: string | null;
  kind: string | null;
  timestamp: string | null;
  runId: string | null;
  traceId: string | null;
  toolName: string | null;
  qqUsage: { mode: string; peerId: string | null } | null;
  runtimePaths: XiaoniRuntimePathClassification[];
  features: string[];
  privacyScope: string;
  memoryCandidate: 'file_memory' | 'spoken_fragment' | null;
  safeEmbeddingText: string | null;
};

export function classifyRuntimePath(path: string): XiaoniRuntimePathClassification | null;
export function extractRuntimePaths(text: string): XiaoniRuntimePathClassification[];
export function extractPassiveRecallCueFromActionStreamItem(item: Record<string, unknown>): XiaoniPassiveRecallCue | null;
export function extractPassiveRecallCuesFromActionStream(items?: Array<Record<string, unknown>>): XiaoniPassiveRecallCue[];

export type TrafficLogFilters = {
  startTime?: string | Date;
  endTime?: string | Date;
  method?: string;
  host?: string;
  status?: number | string;
  isAiRequest?: boolean;
  apiType?: string;
  containerName?: string;
  traceId?: string;
  llmCallId?: string;
  search?: string;
};

export type TrafficLogListParams = {
  page?: number;
  limit?: number;
  filters?: TrafficLogFilters;
};

export type TrafficStatsParams = {
  startTime?: string | Date;
  endTime?: string | Date;
};

export type TrafficEndpointParams = {
  limit?: number;
  sortBy?: 'request_count' | 'avg_duration' | 'error_rate';
};

export type TrafficExportParams = {
  startTime?: string | Date;
  endTime?: string | Date;
  includeBody?: boolean;
  limit?: number;
};

export type TrafficTraceParams = {
  traceId?: string;
  conversationId?: number | bigint | string;
};

export type TrafficLogBatchInput = {
  request_id?: string | null;
  trace_id?: string | null;
  conversation_id?: number | bigint | string | null;
  user_id?: string | null;
  session_id?: string | null;
  agent_turn?: number | null;
  llm_call_id?: string | null;
  tool_call_id?: string | null;
  container_name?: string | null;
  service_name?: string | null;
  method: string;
  url: string;
  host: string;
  path: string;
  query_params?: Record<string, unknown> | string | null;
  request_headers?: Record<string, unknown> | string | null;
  request_body?: string | null;
  request_content_type?: string | null;
  request_size?: number | null;
  response_status?: number | null;
  response_headers?: Record<string, unknown> | string | null;
  response_body?: string | null;
  response_content_type?: string | null;
  response_size?: number | null;
  duration_ms?: number | bigint | null;
  request_timestamp: string | Date;
  response_timestamp?: string | Date | null;
  is_ai_request?: boolean;
  api_type?: string | null;
  api_version?: string | null;
  client_ip?: string | null;
  user_agent?: string | null;
  error_message?: string | null;
};

export type TrafficReplayHistoryInput = {
  original_log_id: number | bigint;
  replay_name?: string | null;
  target_url?: string | null;
  request_method?: string | null;
  request_headers?: Record<string, unknown> | null;
  request_body?: string | null;
  response_status?: number | null;
  response_headers?: Record<string, unknown> | null;
  response_body?: string | null;
  duration_ms?: number | null;
  status?: string | null;
  error_message?: string | null;
  replayed_by?: string | null;
  modified_method?: string | null;
  modified_url?: string | null;
  modified_headers?: Record<string, unknown> | null;
  modified_body?: string | null;
  modification_summary?: Record<string, unknown> | null;
  replay_request_headers?: Record<string, unknown> | null;
  replay_request_body?: string | null;
  replay_response_status?: number | null;
  replay_duration_ms?: number | null;
  replay_response_headers?: Record<string, unknown> | null;
  replay_response_body?: string | null;
  replay_response_size?: number | null;
  diff_summary?: Record<string, unknown> | null;
  status_code_match?: boolean;
  response_body_match?: boolean;
  duration_diff_ms?: number | null;
  body_size_diff?: number | null;
  success?: boolean;
  template_id?: number | null;
};

export type RelationshipLedgerEventInput = {
  groupId?: number | bigint | string | null;
  targetUserId?: number | bigint | string | null;
  sessionKey: string;
  eventType: string;
  eventWeight?: number;
  confidence?: 'high' | 'medium' | 'low' | string;
  sourceMessageIds: Array<number | bigint | string> | Array<string>;
  sourceExcerpt?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | Date | null;
  lastReinforcedAt?: string | Date | null;
};

export type FeedbackEpisodeInput = {
  sessionKey: string;
  groupId?: number | bigint | string | null;
  sourceUserId?: number | bigint | string | null;
  sourceUserName?: string | null;
  scopeType?: 'group_self' | 'from_user' | string;
  eventKind?: 'feedback' | 'praise' | 'critique' | 'correction' | 'interaction_outcome' | string;
  excerptText?: string | null;
  sourceMessageIds?: Array<number | bigint | string> | Array<string>;
  sourceConversationId?: number | bigint | string | null;
  eventImportance?: number;
  sourceSalience?: number;
  metadata?: Record<string, unknown> | null;
};
export type FeedbackReflectionInput = {
  sessionKey: string;
  groupId?: number | bigint | string | null;
  sourceUserId?: number | bigint | string | null;
  sourceUserName?: string | null;
  scopeType?: 'group_self' | 'from_user' | string;
  learningKey?: string;
  learningScope?: string;
  reflectionType?: 'semantic_lesson' | 'social_lesson' | 'self_model_update' | string;
  feedbackKind?: 'positive' | 'negative' | 'mixed' | string;
  confidence?: 'high' | 'medium' | 'low' | string;
  importanceScore?: number;
  evidenceWeight?: number;
  stabilityScore?: number;
  isActive?: boolean;
  isSeed?: boolean | null;
  summaryText: string;
  retrievalText?: string | null;
  embeddingText?: string | null;
  sourceMessageIds?: Array<number | bigint | string> | Array<string>;
  sourceEpisodeIds?: Array<number | bigint | string> | Array<string>;
  sourceConversationId?: number | bigint | string | null;
  supersedesReflectionId?: number | bigint | string | null;
  conflictGroupKey?: string | null;
  metadata?: Record<string, unknown> | null;
  lastHitAt?: string | Date | null;
  hitCount?: number;
};
export type FeedbackReflectionHitInput = {
  hitAt?: string | Date | null;
};
export type FeedbackLearningStateInput = {
  sessionKey: string;
  groupId?: number | bigint | string | null;
  scopeType?: 'group_self' | 'from_user' | string;
  learningKey: string;
  learningScope: string;
  stateType?: 'reinforced' | 'tentative' | 'conflicted' | 'revised' | string;
  activeReflectionId?: number | bigint | string | null;
  latestReflectionId?: number | bigint | string | null;
  activationWeight?: number;
  recencyWeight?: number;
  importanceWeight?: number;
  sourceWeight?: number;
  conflictPenalty?: number;
  metadata?: Record<string, unknown> | null;
};

export type AgentMemoryObservationInput = {
  sessionKey: string;
  groupId?: number | bigint | string | null;
  sourceConversationId?: number | bigint | string | null;
  sourceTurnIds?: Array<number | bigint | string>;
  sourceMessageIds?: Array<number | bigint | string>;
  topic: string;
  text: string;
  poignancy?: number;
  participants?: Array<Record<string, unknown>>;
  xiaoniRole?: string;
  sourceTraceId?: string | null;
  sourceRunId?: string | null;
  writerModel?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type AgentMemoryAssertionInput = {
  sessionKey: string;
  groupId?: number | bigint | string | null;
  sourceConversationId?: number | bigint | string | null;
  sourceTurnIds?: Array<number | bigint | string>;
  sourceMessageIds?: Array<number | bigint | string>;
  text: string;
  factType: string;
  entities?: Array<Record<string, unknown>>;
  participants?: Array<Record<string, unknown>>;
  sourceTraceId?: string | null;
  sourceRunId?: string | null;
  writerModel?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type AgentMemoryReflectionInput = {
  sessionKey: string;
  groupId?: number | bigint | string | null;
  sourceConversationId?: number | bigint | string | null;
  text: string;
  kind: string;
  subjects?: string[];
  evidenceBasis: string;
  evidenceTimeStart?: string | Date | null;
  evidenceTimeEnd?: string | Date | null;
  poignancy?: number;
  sourceObservationIds?: Array<number | bigint | string>;
  sourceMessageIds?: Array<number | bigint | string>;
  sourceTraceId?: string | null;
  sourceRunId?: string | null;
  writerModel?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type ImageLabRunInput = {
  id: string;
  operation: string;
  status?: string;
  parentRunId?: string | null;
  parent_run_id?: string | null;
  prompt: string;
  provider?: string | null;
  model?: string | null;
  size?: string | null;
  quality?: string | null;
  format?: string | null;
  inputJson?: Record<string, unknown> | null;
  input_json?: Record<string, unknown> | null;
  resultJson?: Record<string, unknown> | null;
  result_json?: Record<string, unknown> | null;
  errorMessage?: string | null;
  error_message?: string | null;
  startedAt?: string | Date | null;
  started_at?: string | Date | null;
  completedAt?: string | Date | null;
  completed_at?: string | Date | null;
};

export type ImageLabRunUpdateInput = {
  id: string;
  status?: string;
  resultJson?: Record<string, unknown> | null;
  result_json?: Record<string, unknown> | null;
  errorMessage?: string | null;
  error_message?: string | null;
  completedAt?: string | Date | null;
  completed_at?: string | Date | null;
};

export type ImageLabArtifactInput = {
  id: string;
  kind?: string | null;
  filePath?: string;
  file_path?: string;
  publicPath?: string;
  public_path?: string;
  mimeType?: string;
  mime_type?: string;
  format?: string | null;
  bytes?: number | null;
  width?: number | null;
  height?: number | null;
  revisedPrompt?: string | null;
  revised_prompt?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type IdentityEvidenceRefInput = {
  identityKey?: string;
  identityEventId?: number | bigint | string | null;
  changeCandidateId?: number | bigint | string | null;
  acceptedFactId?: number | bigint | string | null;
  sourceType: string;
  sourceId: string | number | bigint;
  traceId?: string | null;
  runId?: string | null;
  conversationId?: number | bigint | string | null;
  redactionStatus?: 'visible' | 'redacted' | 'tombstoned' | string;
  confidence?: 'high' | 'medium' | 'low' | string;
  metadata?: Record<string, unknown> | null;
};

export type XiaoniIdentityRootInput = {
  identityKey: string;
  sourcePromptId?: string | null;
  systemInstructionHash?: string | null;
  systemInstructionSnapshot: string;
  status?: 'active' | 'retired' | string;
  createdBy?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type IdentityLineageEventInput = {
  identityKey: string;
  eventType?: 'genesis' | 'candidate_proposed' | 'candidate_judged' | 'fact_accepted' | 'fact_superseded' | 'fact_revoked' | 'natural_growth' | 'guided_growth' | 'external_intervention' | 'identity_retcon' | 'corruption' | 'fork' | 'forgetting' | 'death_or_reset' | 'continuity_trial' | string;
  sourceType?: string;
  sourceId?: string | number | bigint | null;
  summaryText: string;
  previousEventId?: number | bigint | string | null;
  parentEventId?: number | bigint | string | null;
  forkedFromIdentityKey?: string | null;
  forkPointEventId?: number | bigint | string | null;
  changeCandidateId?: number | bigint | string | null;
  acceptedFactId?: number | bigint | string | null;
  integrityStatus?: 'accepted' | 'needs_review' | 'quarantined' | 'rejected' | string;
  metadata?: Record<string, unknown> | null;
  occurredAt?: string | Date | null;
  evidenceRefs?: IdentityEvidenceRefInput[];
};

export type IdentityChangeCandidateInput = {
  identityKey: string;
  candidateType?: 'natural_growth' | 'guided_growth' | 'external_intervention' | 'identity_retcon' | 'corruption' | 'fork' | 'forgetting' | 'death_or_reset' | string;
  proposedBy?: string | null;
  proposedFrom?: string | null;
  claimText: string;
  beforeSummary?: string | null;
  afterSummary?: string | null;
  status?: 'pending' | 'accepted' | 'quarantined' | 'rejected' | 'superseded' | string;
  judgeStatus?: 'not_judged' | 'accepted' | 'quarantined' | 'rejected' | 'failed' | string;
  judgeReason?: string | null;
  judgeRunId?: string | null;
  judgeLlmCallId?: string | null;
  quarantineGroupKey?: string | null;
  supersedesFactId?: number | bigint | string | null;
  legacySourceTable?: string | null;
  legacySourceId?: string | null;
  judgedAt?: string | Date | null;
  metadata?: Record<string, unknown> | null;
  lineageMetadata?: Record<string, unknown> | null;
  recordLineageEvent?: boolean;
  evidenceRefs?: IdentityEvidenceRefInput[];
};

export type AcceptedIdentityFactInput = {
  identityKey: string;
  factKey: string;
  factText: string;
  factType?: string;
  sourceCandidateId?: number | bigint | string | null;
  sourceEventId?: number | bigint | string | null;
  status?: 'active' | 'superseded' | 'revoked' | 'inactive' | string;
  supersedesFactId?: number | bigint | string | null;
  revokedByEventId?: number | bigint | string | null;
  confidence?: 'high' | 'medium' | 'low' | string;
  activationTags?: unknown[];
  acceptedAt?: string | Date | null;
  metadata?: Record<string, unknown> | null;
  lineageMetadata?: Record<string, unknown> | null;
  recordLineageEvent?: boolean;
  evidenceRefs?: IdentityEvidenceRefInput[];
};

export type RuntimeIdentityActivationTraceInput = {
  identityKey: string;
  runId?: string | null;
  traceId?: string | null;
  conversationId?: number | bigint | string | null;
  sceneFingerprint?: string | null;
  cueSummary?: string | null;
  activatedRefs?: unknown[];
  suppressedRefs?: unknown[];
  selectedSkillRef?: string | null;
  activationReason?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type SelfEvolutionJobInput = {
  groupId?: number | bigint | string | null;
  targetUserId?: number | bigint | string | null;
  sessionKey: string;
  status?: string;
  triggerReason?: string;
  turnRangeStart?: number | bigint | string | null;
  turnRangeEnd?: number | bigint | string | null;
  sourceEventCount?: number;
  inputMessageIds?: unknown[];
  outputStateVersion?: number | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
  startedAt?: string | Date | null;
  finishedAt?: string | Date | null;
};
export type SelfEvolutionStateInput = {
  isActive?: boolean;
  socialPresenceBaseline: string;
  entryPreference: string;
  warmthBias: string;
  familiarityCeiling: string;
  topicResonance?: unknown[];
  boundaryTendencies?: Record<string, unknown>;
  reinforcedModes?: unknown[];
  suppressedModes?: unknown[];
  summaryText: string;
  sourceEventIds?: unknown[];
  sourceMessageIds?: unknown[];
  metadata?: Record<string, unknown>;
};

export type ChatSpaceTopicInput = {
  chatSpaceType: 'group' | 'direct' | string;
  chatSpaceId: number | bigint | string;
  status?: string;
  canonicalTitle?: string | null;
  startedAt?: string | Date | null;
  lastActivityAt?: string | Date | null;
  closedAt?: string | Date | null;
  currentAcceptedVersionId?: number | bigint | string | null;
  currentCandidateVersionId?: number | bigint | string | null;
  lastProjectionJobId?: number | bigint | string | null;
  metadata?: Record<string, unknown> | null;
};

export type TopicProjectionJobInput = {
  chatSpaceType: 'group' | 'direct' | string;
  chatSpaceId: number | bigint | string;
  triggerType?: string;
  status?: string;
  inputBundleJson?: Record<string, unknown> | null;
  inputBundleHash: string;
  baseVersionIds?: Array<number | bigint | string>;
  modelName?: string | null;
  modelConfigJson?: Record<string, unknown> | null;
  promptVersion?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown> | null;
  startedAt?: string | Date | null;
  finishedAt?: string | Date | null;
};

export type TopicVersionRelationshipInput = {
  targetUserId: number | bigint | string;
  relationshipKind?: string | null;
  summaryText: string;
  actors?: unknown[];
  sourceEventIds?: Array<number | bigint | string>;
  sourceMessageIds?: Array<number | bigint | string>;
  metadata?: Record<string, unknown> | null;
};

export type TopicVersionEvidenceInput = {
  sourceKind: string;
  sourceId: number | bigint | string;
  sortOrder?: number;
  excerptText?: string | null;
  speakerId?: string | null;
  speakerName?: string | null;
  occurredAt?: string | Date | null;
  metadata?: Record<string, unknown> | null;
};

export type TopicProjectionVersionSnapshotInput = {
  topicId: number | bigint | string;
  projectionJobId?: number | bigint | string | null;
  versionNumber: number;
  status?: string;
  lifecycleState?: string;
  title?: string | null;
  summaryText: string;
  reviewPriorityScore?: number;
  heatScore?: number;
  participantIds?: Array<number | bigint | string> | Array<string>;
  topicKeywords?: string[];
  evidenceCount?: number;
  relationshipCount?: number;
  runtimeHitCount?: number;
  lastRuntimeHitAt?: string | Date | null;
  inputBundleHash: string;
  snapshotJson?: Record<string, unknown> | null;
  provenanceJson?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  relationships?: TopicVersionRelationshipInput[];
  evidence?: TopicVersionEvidenceInput[];
  topicUpdates?: Partial<ChatSpaceTopicInput>;
};

export type TopicReviewEventInput = {
  topicId: number | bigint | string;
  baseProjectionVersionId?: number | bigint | string | null;
  resultProjectionVersionId?: number | bigint | string | null;
  actionType: string;
  status?: string;
  createdBy?: string | null;
  manualNote?: string | null;
  patchJson?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

export type GoldenChatCaseInput = {
  chatSpaceType: 'group' | 'direct' | string;
  chatSpaceId: number | bigint | string;
  topicId?: number | bigint | string | null;
  sourceProjectionVersionId: number | bigint | string;
  label?: string | null;
  status?: string;
  inputBundleHash: string;
  expectedSnapshotJson?: Record<string, unknown> | null;
  fixtureBundleJson?: Record<string, unknown> | null;
  createdBy?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type ChatPromptBindingSource = 'group' | 'private';

export type ResolvedChatAgentPrompt = {
  bindingSource: ChatPromptBindingSource;
  bindingPromptId: string;
  prompt: {
    id: string;
    promptName: string;
    agentType: string;
    systemInstruction: string;
    userPromptTemplate: string | null;
    contextVariables: Record<string, unknown>;
    modelName: string | null;
    modelConfig: Record<string, unknown>;
    advancedConfig: Record<string, unknown>;
  } | null;
};

export const Prisma: unknown;
export const STORAGE_TIMEZONE: string;
export const STORAGE_OFFSET: string;
export function buildDatabaseUrl(config?: DatabaseUrlConfig): string;
export function resolveDatabaseUrl(config?: DatabaseUrlConfig): string;
export function createSqlAdapter(config?: DatabaseUrlConfig): SqlAdapter;
export function getPrismaClient(config?: DatabaseUrlConfig): PrismaClient;
export function closePrismaClient(): Promise<void>;
export function resolveChatAgentPrompt(
  params: { chatType: 'direct' | 'group'; userId?: number | string | null; groupId?: number | string | null },
  config?: DatabaseUrlConfig
): Promise<ResolvedChatAgentPrompt | null>;
export function parseInstantValue(value: string | Date | null | undefined): Date | null;
export function parseStoredTimestamp(value: string | Date | null | undefined): Date | null;
export function serializeTimestampForStorage(value: string | Date | null | undefined): string | null;
export function serializeTimestampForApi(value: string | Date | null | undefined): string | null;
export function normalizeTimestampField(fieldName: string, value: unknown): unknown;
export function normalizeRowTimestampFields<T>(record: T): T;
export function prepareSqlParameter(value: unknown): unknown;
export function getEast8StartOfDay(value?: string | Date): Date;
export function formatEast8IsoOffset(value: string | Date): string;
export function formatEast8WallClock(value: string | Date): string;
export function listTrafficLogs(params?: TrafficLogListParams): Promise<{ data: any[]; total: number; page: number; limit: number }>;
export function getTrafficLogById(id: number | bigint | string): Promise<any | null>;
export function listTraceTrafficLogs(params?: TrafficTraceParams): Promise<any[]>;
export function getTrafficStats(params?: TrafficStatsParams): Promise<any>;
export function getTrafficEndpoints(params?: TrafficEndpointParams): Promise<any[]>;
export function searchTrafficLogs(params: { query: string; limit?: number }): Promise<any[]>;
export function exportTrafficLogs(params?: TrafficExportParams): Promise<any[]>;
export function ensureReplayHistorySchema(): Promise<void>;
export function listTrafficReplayHistory(originalLogId: number | bigint | string): Promise<any[]>;
export function createTrafficReplayHistory(data: TrafficReplayHistoryInput): Promise<any>;
export function listAiTrafficSamples(params?: { search?: string; limit?: number }): Promise<any[]>;
export function createTrafficLogBatch(records: TrafficLogBatchInput[]): Promise<{ count: number }>;
export function ensureSelfEvolutionSchema(config?: DatabaseUrlConfig): Promise<void>;
export function ensureFeedbackReflectionSchema(config?: DatabaseUrlConfig): Promise<void>;
export function ensureIdentityLineageSchema(config?: DatabaseUrlConfig): Promise<void>;
export function ensureTopicLabSchema(config?: DatabaseUrlConfig): Promise<void>;
export function ensureAbExperimentSchema(config?: DatabaseUrlConfig): Promise<void>;
export function appendRelationshipLedgerEvent(input: RelationshipLedgerEventInput, config?: DatabaseUrlConfig): Promise<any>;
export function reinforceRelationshipLedgerEvent(
  id: number | bigint | string,
  updates?: Partial<RelationshipLedgerEventInput>,
  config?: DatabaseUrlConfig
): Promise<any>;
export function listRelationshipLedgerEvents(
  filters?: { groupId?: number | bigint | string; targetUserId?: number | bigint | string; sessionKey?: string; eventType?: string; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function listRelationshipLedgerEventsByIds(
  ids: Array<number | bigint | string>,
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function listConversationItemsByIds(
  ids: Array<number | bigint | string>,
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function listAgentInboundMessages(
  filters?: { sessionKey?: string; chatType?: string; peerId?: string; senderId?: string; limit?: number; offset?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function listAgentInboundMessagesByIds(
  ids: Array<number | bigint | string>,
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function getLatestUnreadAgentInboundMessage(
  filters?: { sessionKey?: string; chatType?: string; peerId?: string },
  config?: DatabaseUrlConfig
): Promise<any | null>;
export function getAgentInboundMessageByMessageSid(
  messageSid: string,
  filters?: { sessionKey?: string },
  config?: DatabaseUrlConfig
): Promise<any | null>;
export type InboundInboxSource = 'napcat' | 'simulator' | string;
export type InboundInboxMessageRecord = {
  id: number;
  traceId: string;
  source: InboundInboxSource;
  messageSid: string;
  dedupeKey: string;
  chatType: 'direct' | 'group';
  sessionKey: string;
  peerId: string;
  peerName?: string;
  senderId: string;
  senderName?: string;
  accountId: string;
  isRead: boolean;
  readAt?: string | null;
  receivedAt: string;
  messageTimestamp?: string | null;
  bodyForAgent: string;
  rawBody: string;
  commandBody: string;
  wasMentioned: boolean;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  rawPayload: Record<string, unknown>;
  inboundContext: Record<string, unknown>;
};
export type InboundInboxConversationSummary = {
  sessionKey: string;
  chatType: 'direct' | 'group';
  peerId: string;
  peerName?: string;
  accountId: string;
  unreadCount: number;
  totalMessages: number;
  lastReceivedAt?: string | null;
  latestUnreadReceivedAt?: string | null;
  latestBodyForAgent?: string;
  latestSenderId?: string;
  latestSenderName?: string;
};
export type InboundInboxStats = {
  totalConversations: number;
  totalMessages: number;
  unreadConversations: number;
  unreadMessages: number;
  lastReceivedAt?: string | null;
};
export type InboundInboxPersistenceCallInput = {
  sqlAdapter?: SqlAdapter;
  [key: string]: any;
};
export type InboundInboxPersistenceApi = {
  ensureInboundInboxSchema(input?: InboundInboxPersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
  persistInboundMessage(input: InboundInboxPersistenceCallInput & {
    inboundContext: Record<string, unknown>;
    rawPayload?: Record<string, unknown>;
    traceId: string;
    source?: InboundInboxSource;
  }, config?: DatabaseUrlConfig): Promise<InboundInboxMessageRecord>;
  getInboundInboxStats(input?: InboundInboxPersistenceCallInput, config?: DatabaseUrlConfig): Promise<InboundInboxStats>;
  listInboundInboxConversations(input?: InboundInboxPersistenceCallInput & {
    limit?: number;
    offset?: number;
  }, config?: DatabaseUrlConfig): Promise<InboundInboxConversationSummary[]>;
  listInboundConversationMessages(input: InboundInboxPersistenceCallInput & {
    sessionKey: string;
    includeRead?: boolean;
    limit?: number;
  }, config?: DatabaseUrlConfig): Promise<InboundInboxMessageRecord[]>;
  listUnreadInboundMessages(input?: InboundInboxPersistenceCallInput, config?: DatabaseUrlConfig): Promise<InboundInboxMessageRecord[]>;
  claimInboundMessages(input?: InboundInboxPersistenceCallInput & {
    sessionKey?: string;
    limit?: number;
    order?: 'oldest' | 'latest';
    markRead?: boolean;
    includeMessageIds?: number[];
  }, config?: DatabaseUrlConfig): Promise<InboundInboxMessageRecord[]>;
  markInboundMessagesRead(input?: InboundInboxPersistenceCallInput & {
    ids?: number[];
  } | number[], config?: DatabaseUrlConfig): Promise<number>;
};
export function createInboundInboxPersistence(deps?: {
  createSqlAdapter?: (config?: DatabaseUrlConfig) => SqlAdapter;
  sqlAdapter?: SqlAdapter;
}): InboundInboxPersistenceApi;
export function ensureInboundInboxSchema(input?: InboundInboxPersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
export function persistInboundMessage(input: InboundInboxPersistenceCallInput & {
  inboundContext: Record<string, unknown>;
  rawPayload?: Record<string, unknown>;
  traceId: string;
  source?: InboundInboxSource;
}, config?: DatabaseUrlConfig): Promise<InboundInboxMessageRecord>;
export function getInboundInboxStats(input?: InboundInboxPersistenceCallInput, config?: DatabaseUrlConfig): Promise<InboundInboxStats>;
export function listInboundInboxConversations(input?: InboundInboxPersistenceCallInput & {
  limit?: number;
  offset?: number;
}, config?: DatabaseUrlConfig): Promise<InboundInboxConversationSummary[]>;
export function listInboundConversationMessages(input: InboundInboxPersistenceCallInput & {
  sessionKey: string;
  includeRead?: boolean;
  limit?: number;
}, config?: DatabaseUrlConfig): Promise<InboundInboxMessageRecord[]>;
export function listUnreadInboundMessages(input?: InboundInboxPersistenceCallInput, config?: DatabaseUrlConfig): Promise<InboundInboxMessageRecord[]>;
export function claimInboundMessages(input?: InboundInboxPersistenceCallInput & {
  sessionKey?: string;
  limit?: number;
  order?: 'oldest' | 'latest';
  markRead?: boolean;
  includeMessageIds?: number[];
}, config?: DatabaseUrlConfig): Promise<InboundInboxMessageRecord[]>;
export function markInboundMessagesRead(input?: InboundInboxPersistenceCallInput & {
  ids?: number[];
} | number[], config?: DatabaseUrlConfig): Promise<number>;
export type AgentRuntimePersistenceCallInput = {
  sqlAdapter?: SqlAdapter;
  [key: string]: any;
};
export type XiaoniAgentStackPersistenceCallInput = {
  sqlAdapter?: SqlAdapter;
  [key: string]: any;
};
export type XiaoniAgentStackItem = {
  id: string | null;
  eventId: string;
  identityKey: string;
  stackIndex: number;
  itemKind: string;
  role: string | null;
  phase: string | null;
  providerItemId: string | null;
  toolCallId: string | null;
  llmRequestSliceId: string | null;
  content: Record<string, unknown>;
  visibility: string | null;
  sourceType: string | null;
  sourceId: string | null;
  traceId: string | null;
  runId: string | null;
  conversationId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
};
export type XiaoniLlmRequestSlice = {
  id: string | null;
  sliceId: string;
  llmCallId: string | null;
  identityKey: string;
  inputStartIndex: number | null;
  inputEndIndex: number | null;
  inputStackItemIds: unknown[];
  outputStartIndex: number | null;
  outputEndIndex: number | null;
  canonicalRequest: Record<string, unknown>;
  wireRequest: Record<string, unknown> | null;
  canonicalResponse: Record<string, unknown> | null;
  wireResponse: Record<string, unknown> | null;
  rawResponse: Record<string, unknown> | null;
  outputItems: unknown[];
  status: string | null;
  tokenUsage: Record<string, unknown>;
  traceId: string | null;
  runId: string | null;
  conversationId: string | null;
  agentTurn: number | null;
  modelName: string | null;
  modelProvider: string | null;
  requestFormatVersion: string | null;
  wireProviderFormat: string | null;
  processingTimeMs: number | null;
  sourceKind: string | null;
  forkRunId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
};
export type XiaoniToolExecution = {
  id: string | null;
  executionId: string;
  identityKey: string;
  llmRequestSliceId: string | null;
  llmCallId: string | null;
  toolCallId: string | null;
  toolName: string | null;
  arguments: Record<string, unknown>;
  rawArguments: string | null;
  result: Record<string, unknown>;
  status: string | null;
  errorMessage: string | null;
  sideEffect: boolean;
  traceId: string | null;
  runId: string | null;
  conversationId: string | null;
  agentTurn: number | null;
  stackCallItemId: string | null;
  stackOutputItemId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
};
export type XiaoniCoreMemoryCompressionForkRun = {
  id: string | null;
  forkRunId: string;
  identityKey: string;
  contextSessionKey: string | null;
  status: string | null;
  traceId: string | null;
  runId: string | null;
  conversationId: string | null;
  readCutoffAfterConversationId: string | null;
  previousReadCutoffAfterConversationId: string | null;
  summaryText: string | null;
  artifact: Record<string, unknown>;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};
export type XiaoniOrphanedForkRunReapResult = {
  coreMemoryCompression: string[];
  subconscious: string[];
  imageVision: string[];
  total: number;
};
export type XiaoniCoreMemoryCompressionForkItem = Omit<XiaoniAgentStackItem, 'stackIndex'> & {
  forkRunId: string;
  itemIndex: number;
};
export type XiaoniCoreMemoryCompressionForkSlice = XiaoniLlmRequestSlice & {
  forkRunId: string;
};
export type XiaoniCoreMemoryCompressionForkToolExecution = XiaoniToolExecution & {
  forkRunId: string;
};
export type XiaoniSubconsciousAgentForkRun = Omit<XiaoniCoreMemoryCompressionForkRun, 'readCutoffAfterConversationId' | 'previousReadCutoffAfterConversationId'> & {
  notifyQueueMessageId: string | null;
};
export type XiaoniSubconsciousAgentForkItem = XiaoniCoreMemoryCompressionForkItem;
export type XiaoniSubconsciousAgentForkSlice = XiaoniCoreMemoryCompressionForkSlice;
export type XiaoniSubconsciousAgentForkToolExecution = XiaoniCoreMemoryCompressionForkToolExecution;
export type XiaoniImageVisionForkRun = {
  id: string | null;
  forkRunId: string;
  identityKey: string;
  status: string | null;
  traceId: string | null;
  runId: string | null;
  conversationId: string | null;
  assetId: string | null;
  imageId: string | null;
  mediaTag: string | null;
  observationId: string | null;
  description: string | null;
  artifact: Record<string, unknown>;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};
export type XiaoniImageVisionForkItem = Omit<XiaoniAgentStackItem, 'stackIndex'> & {
  forkRunId: string;
  itemIndex: number;
};
export type XiaoniImageVisionForkSlice = XiaoniLlmRequestSlice & {
  forkRunId: string;
};
export type XiaoniCodexProviderUsageEvent = {
  id: string | null;
  eventId: string;
  sourceKind: string;
  sourceId: string | null;
  identityKey: string;
  llmCallId: string | null;
  traceId: string | null;
  runId: string | null;
  conversationId: string | null;
  canonicalRequest: Record<string, unknown>;
  wireRequest: Record<string, unknown> | null;
  canonicalResponse: Record<string, unknown> | null;
  wireResponse: Record<string, unknown> | null;
  rawResponse: Record<string, unknown> | null;
  outputItems: unknown[];
  status: string | null;
  tokenUsage: Record<string, unknown>;
  modelName: string | null;
  modelProvider: string | null;
  requestFormatVersion: string | null;
  wireProviderFormat: string | null;
  processingTimeMs: number | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
};
export type XiaoniLlmUsageBucket = 'call' | 'hour' | 'day' | 'month';
export type XiaoniLlmUsageTimelineInput = XiaoniAgentStackPersistenceCallInput & {
  identityKey?: string;
  identity_key?: string;
  range?: string;
  startTime?: string | Date | null;
  start_time?: string | Date | null;
  endTime?: string | Date | null;
  end_time?: string | Date | null;
  bucket?: XiaoniLlmUsageBucket | string;
  usageBucket?: XiaoniLlmUsageBucket | string;
  usage_bucket?: XiaoniLlmUsageBucket | string;
  maxPoints?: number;
  max_points?: number;
  includePeaks?: boolean;
  include_peaks?: boolean;
  includeMiniMap?: boolean;
  include_minimap?: boolean;
  includeOverlays?: string;
  include_overlays?: string;
  searchQuery?: string | null;
  search_q?: string | null;
};
export type XiaoniLlmUsagePoint = {
  key: string;
  timestamp: string | null;
  bucketStart: string | null;
  bucketEnd: string | null;
  callCount: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheRatio: number | null;
  sourceKind: string | null;
  forkRunId: string | null;
  anchorEventId: string | null;
  llmRequestSliceId: string | null;
  llmCallId: string | null;
  traceId: string | null;
  topEvent: {
    eventId: string;
    llmRequestSliceId: string;
    sourceKind: string | null;
    forkRunId: string | null;
    timestamp: string | null;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
  } | null;
};
export type XiaoniLlmUsagePeak = {
  timestamp: string | null;
  label: string;
  severity: string;
  anchorEventId: string | null;
  llmRequestSliceId: string | null;
  reason: string;
};
export type XiaoniLlmUsageSearchHit = {
  timestamp: string | null;
  label: string;
  severity: string;
  anchorEventId: string | null;
  llmRequestSliceId: string | null;
  llmCallId: string | null;
  traceId: string | null;
  sourceKind: string | null;
  forkRunId: string | null;
  field: string | null;
  query: string;
  snippet: string | null;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
};
export type XiaoniLlmUsageTimelineResult = {
  identityKey: string;
  generatedAt: string;
  timezone: string;
  requestedBucket: XiaoniLlmUsageBucket;
  bucket: XiaoniLlmUsageBucket;
  maxPoints: number;
  downsampled: boolean;
  warnings: string[];
  window: {
    startTime: string | null;
    endTime: string | null;
  };
  dataBounds: {
    firstAt: string | null;
    lastAt: string | null;
  };
  summary: {
    callCount: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheRatio: number | null;
    peakInputTokens: number;
    peakOutputTokens: number;
  };
  points: XiaoniLlmUsagePoint[];
  peaks: XiaoniLlmUsagePeak[];
  overlays: {
    eventDensity: unknown[];
    toolDensity: unknown[];
    runtimeBands: unknown[];
    compressionForkBands: unknown[];
    searchHits: XiaoniLlmUsageSearchHit[];
  };
  miniMap: unknown;
};
export type XiaoniAgentStackPersistenceApi = {
  ensureXiaoniAgentStackSchema(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
  getAgentStackHead(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<number>;
  appendAgentStackItem(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniAgentStackItem | null>;
  appendAgentStackItems(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniAgentStackItem[]>;
  recordLlmRequestSlice(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniLlmRequestSlice | null>;
  recordCodexProviderUsageEvent(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniCodexProviderUsageEvent | null>;
  updateLlmRequestSliceStackLinks(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniLlmRequestSlice | null>;
  recordToolExecution(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniToolExecution | null>;
  completeToolExecution(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniToolExecution | null>;
  recordCoreMemoryCompressionForkRun(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniCoreMemoryCompressionForkRun | null>;
  completeCoreMemoryCompressionForkRun(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniCoreMemoryCompressionForkRun | null>;
  findActiveCoreMemoryCompressionForkRun(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniCoreMemoryCompressionForkRun | null>;
  reapOrphanedForkRuns(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniOrphanedForkRunReapResult>;
  appendCoreMemoryCompressionForkItems(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniCoreMemoryCompressionForkItem[]>;
  recordCoreMemoryCompressionForkSlice(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniCoreMemoryCompressionForkSlice | null>;
  recordCoreMemoryCompressionForkToolExecution(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniCoreMemoryCompressionForkToolExecution | null>;
  completeCoreMemoryCompressionForkToolExecution(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniCoreMemoryCompressionForkToolExecution | null>;
  recordSubconsciousAgentForkRun(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniSubconsciousAgentForkRun | null>;
  completeSubconsciousAgentForkRun(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniSubconsciousAgentForkRun | null>;
  appendSubconsciousAgentForkItems(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniSubconsciousAgentForkItem[]>;
  recordSubconsciousAgentForkSlice(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniSubconsciousAgentForkSlice | null>;
  recordSubconsciousAgentForkToolExecution(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniSubconsciousAgentForkToolExecution | null>;
  completeSubconsciousAgentForkToolExecution(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniSubconsciousAgentForkToolExecution | null>;
  recordImageVisionForkRun(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniImageVisionForkRun | null>;
  completeImageVisionForkRun(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniImageVisionForkRun | null>;
  appendImageVisionForkItems(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniImageVisionForkItem[]>;
  recordImageVisionForkSlice(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniImageVisionForkSlice | null>;
  listAgentStackItems(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniAgentStackItem[]>;
  listAgentStackItemsForConversations(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniAgentStackItem[]>;
  listLlmRequestSlices(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniLlmRequestSlice[]>;
  listCodexProviderUsageEvents(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniCodexProviderUsageEvent[]>;
  getXiaoniLlmUsageTimeline(input?: XiaoniLlmUsageTimelineInput, config?: DatabaseUrlConfig): Promise<XiaoniLlmUsageTimelineResult>;
  listToolExecutions(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniToolExecution[]>;
  findAgentStackItemByEventId(eventId: string, config?: DatabaseUrlConfig): Promise<XiaoniAgentStackItem | null>;
  attachConversationIdToAgentStackByTrace(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<number>;
};
export function createXiaoniAgentStackPersistence(deps?: {
  createSqlAdapter?: (config?: DatabaseUrlConfig) => SqlAdapter;
  sqlAdapter?: SqlAdapter;
}): XiaoniAgentStackPersistenceApi;
export function ensureXiaoniAgentStackSchema(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
export function getAgentStackHead(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<number>;
export function appendAgentStackItem(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniAgentStackItem | null>;
export function appendAgentStackItems(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniAgentStackItem[]>;
export function recordLlmRequestSlice(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniLlmRequestSlice | null>;
export function recordCodexProviderUsageEvent(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniCodexProviderUsageEvent | null>;
export function updateLlmRequestSliceStackLinks(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniLlmRequestSlice | null>;
export function recordToolExecution(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniToolExecution | null>;
export function completeToolExecution(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniToolExecution | null>;
export function recordCoreMemoryCompressionForkRun(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniCoreMemoryCompressionForkRun | null>;
export function completeCoreMemoryCompressionForkRun(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniCoreMemoryCompressionForkRun | null>;
export function findActiveCoreMemoryCompressionForkRun(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniCoreMemoryCompressionForkRun | null>;
export function reapOrphanedForkRuns(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniOrphanedForkRunReapResult>;
export function appendCoreMemoryCompressionForkItems(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniCoreMemoryCompressionForkItem[]>;
export function recordCoreMemoryCompressionForkSlice(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniCoreMemoryCompressionForkSlice | null>;
export function recordCoreMemoryCompressionForkToolExecution(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniCoreMemoryCompressionForkToolExecution | null>;
export function completeCoreMemoryCompressionForkToolExecution(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniCoreMemoryCompressionForkToolExecution | null>;
export function recordSubconsciousAgentForkRun(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniSubconsciousAgentForkRun | null>;
export function completeSubconsciousAgentForkRun(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniSubconsciousAgentForkRun | null>;
export function appendSubconsciousAgentForkItems(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniSubconsciousAgentForkItem[]>;
export function recordSubconsciousAgentForkSlice(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniSubconsciousAgentForkSlice | null>;
export function recordSubconsciousAgentForkToolExecution(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniSubconsciousAgentForkToolExecution | null>;
export function completeSubconsciousAgentForkToolExecution(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniSubconsciousAgentForkToolExecution | null>;
export function recordImageVisionForkRun(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniImageVisionForkRun | null>;
export function completeImageVisionForkRun(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniImageVisionForkRun | null>;
export function appendImageVisionForkItems(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniImageVisionForkItem[]>;
export function recordImageVisionForkSlice(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniImageVisionForkSlice | null>;
export function listAgentStackItems(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniAgentStackItem[]>;
export function listAgentStackItemsForConversations(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniAgentStackItem[]>;
export function listLlmRequestSlices(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniLlmRequestSlice[]>;
export function listCodexProviderUsageEvents(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniCodexProviderUsageEvent[]>;
export function getXiaoniLlmUsageTimeline(input?: XiaoniLlmUsageTimelineInput, config?: DatabaseUrlConfig): Promise<XiaoniLlmUsageTimelineResult>;
export function listToolExecutions(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<XiaoniToolExecution[]>;
export function findAgentStackItemByEventId(eventId: string, config?: DatabaseUrlConfig): Promise<XiaoniAgentStackItem | null>;
export function attachConversationIdToAgentStackByTrace(input?: XiaoniAgentStackPersistenceCallInput, config?: DatabaseUrlConfig): Promise<number>;
export interface CcSubscriptionQuotaWindow {
  utilization: number | null;
  remaining: number | null;
  status: string | null;
  resetEpoch: number | null;
  resetAt: string | null;
}
export interface CcSubscriptionQuotaSnapshot {
  provider: string;
  capturedAt: string | null;
  modelName: string | null;
  status: string | null;
  resetAt: string | null;
  fallbackPercentage: number | null;
  overageStatus: string | null;
  overageDisabledReason: string | null;
  organizationId: string | null;
  windows: {
    fiveHour: CcSubscriptionQuotaWindow;
    weekly: CcSubscriptionQuotaWindow;
  };
}
export interface CcSubscriptionQuotaTimelinePoint {
  timestamp: string | null;
  util5h: number | null;
  util7d: number | null;
  status5h: string | null;
  status7d: string | null;
}
export interface CcSubscriptionQuotaTimelineResult {
  provider: string;
  generatedAt: string;
  window: { startTime: string; endTime: string };
  limit: number;
  truncated: boolean;
  points: CcSubscriptionQuotaTimelinePoint[];
}
export interface CcSubscriptionQuotaSnapshotInput {
  provider?: string;
  sqlAdapter?: unknown;
}
export interface CcSubscriptionQuotaTimelineInput {
  provider?: string;
  startTime?: string | Date | null;
  endTime?: string | Date | null;
  limit?: number;
  sqlAdapter?: unknown;
}
export function getCcSubscriptionQuotaSnapshot(input?: CcSubscriptionQuotaSnapshotInput, config?: DatabaseUrlConfig): Promise<CcSubscriptionQuotaSnapshot | null>;
export function getCcSubscriptionQuotaTimeline(input?: CcSubscriptionQuotaTimelineInput, config?: DatabaseUrlConfig): Promise<CcSubscriptionQuotaTimelineResult>;
export type AgentRuntimeLeaseRecoveryResult = {
  staleBefore: string;
  staleMs: number;
  settledRuns: number;
  settledQueueMessages: number;
  failedRuns: number;
  failedQueueMessages: number;
  orphanQueueMessages: number;
};
export type AgentRuntimePersistenceApi = {
  ensureAgentRuntimeSchema(input?: AgentRuntimePersistenceCallInput & {
    includeAgentExtras?: boolean;
    profile?: 'agent' | 'provider' | string;
  }, config?: DatabaseUrlConfig): Promise<void>;
  ensureTranscriptSnapshotSchema(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
  ensureConversationStoreSchema(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
  logRuntimeTimelineEvent(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
  attachConversationIdToRuntimeTrace(input?: AgentRuntimePersistenceCallInput & {
    traceId?: string;
    trace_id?: string;
    conversationId?: number | string | null;
    conversation_id?: number | string | null;
    useCoalesceAssignment?: boolean;
  }, config?: DatabaseUrlConfig): Promise<number>;
  recoverStaleProcessingLeases(input?: AgentRuntimePersistenceCallInput & {
    staleMs?: number;
    stale_ms?: number;
    reason?: string;
  }, config?: DatabaseUrlConfig): Promise<AgentRuntimeLeaseRecoveryResult>;
  enqueueSelfContinuationQueueMessage(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<boolean>;
  releaseExecutionLease(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
  getExecutionLeaseDeliveryState(input?: AgentRuntimePersistenceCallInput & { runId?: string }, config?: DatabaseUrlConfig): Promise<{
    deliveryPhase: 'reasoning_open' | 'delivery_committed' | 'lease_released';
    deliveryCommitCount: number;
    blockedDeliveryAttemptCount: number;
    lastBlockedDeliveryReason: string | null;
  }>;
  markLeaseVisibleDeliveryCommitted(input?: AgentRuntimePersistenceCallInput & { runId?: string }, config?: DatabaseUrlConfig): Promise<void>;
  markLeaseDeliveryBlocked(input?: AgentRuntimePersistenceCallInput & { runId?: string; reason?: string }, config?: DatabaseUrlConfig): Promise<void>;
  createLlmJob(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<string>;
  updateLlmJob(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
  listRecentConversationTurns(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<any[]>;
  createConversationWithItems(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<number>;
  getSessionReadCutoffState(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<any | null>;
  upsertSessionReadCutoffState(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
  commitSessionContextSummaryAndReadCutoff(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<{
    committed: boolean;
    state: any | null;
  }>;
  upsertProactiveShareState(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
  upsertSessionContextSummary(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
  loadSessionReplayState(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<{
    summaryText: string | null;
    summarizedThroughConversationId: number | null;
  }>;
  listStoredConversationTurns(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<any[]>;
  createStoredConversation(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<number>;
  getTranscriptSnapshotBySessionId(input?: AgentRuntimePersistenceCallInput & { sessionId?: string }, config?: DatabaseUrlConfig): Promise<any | null>;
  upsertTranscriptSnapshot(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
};
export function createAgentRuntimePersistence(deps?: {
  createSqlAdapter?: (config?: DatabaseUrlConfig) => SqlAdapter;
  sqlAdapter?: SqlAdapter;
}): AgentRuntimePersistenceApi;
export function ensureAgentRuntimeSchema(input?: AgentRuntimePersistenceCallInput & {
  includeAgentExtras?: boolean;
  profile?: 'agent' | 'provider' | string;
}, config?: DatabaseUrlConfig): Promise<void>;
export function ensureTranscriptSnapshotSchema(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
export function ensureConversationStoreSchema(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
export function logRuntimeTimelineEvent(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
export function attachConversationIdToRuntimeTrace(input?: AgentRuntimePersistenceCallInput & {
  traceId?: string;
  trace_id?: string;
  conversationId?: number | string | null;
  conversation_id?: number | string | null;
  useCoalesceAssignment?: boolean;
}, config?: DatabaseUrlConfig): Promise<number>;
export function recoverStaleProcessingLeases(input?: AgentRuntimePersistenceCallInput & {
  staleMs?: number;
  stale_ms?: number;
  reason?: string;
}, config?: DatabaseUrlConfig): Promise<AgentRuntimeLeaseRecoveryResult>;
export function enqueueSelfContinuationQueueMessage(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<boolean>;
export function releaseExecutionLease(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
export function getExecutionLeaseDeliveryState(input?: AgentRuntimePersistenceCallInput & { runId?: string }, config?: DatabaseUrlConfig): Promise<{
  deliveryPhase: 'reasoning_open' | 'delivery_committed' | 'lease_released';
  deliveryCommitCount: number;
  blockedDeliveryAttemptCount: number;
  lastBlockedDeliveryReason: string | null;
}>;
export function markLeaseVisibleDeliveryCommitted(input?: AgentRuntimePersistenceCallInput & { runId?: string }, config?: DatabaseUrlConfig): Promise<void>;
export function markLeaseDeliveryBlocked(input?: AgentRuntimePersistenceCallInput & { runId?: string; reason?: string }, config?: DatabaseUrlConfig): Promise<void>;
export function createLlmJob(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<string>;
export function updateLlmJob(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
export function listRecentConversationTurns(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<any[]>;
export function createConversationWithItems(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<number>;
export function getSessionReadCutoffState(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<any | null>;
export function upsertSessionReadCutoffState(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
export function commitSessionContextSummaryAndReadCutoff(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<{
  committed: boolean;
  state: any | null;
}>;
export function upsertProactiveShareState(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
export function upsertSessionContextSummary(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
export function loadSessionReplayState(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<{
  summaryText: string | null;
  summarizedThroughConversationId: number | null;
}>;
export function listStoredConversationTurns(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<any[]>;
export function createStoredConversation(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<number>;
export function getTranscriptSnapshotBySessionId(input?: AgentRuntimePersistenceCallInput & { sessionId?: string }, config?: DatabaseUrlConfig): Promise<any | null>;
export function upsertTranscriptSnapshot(input?: AgentRuntimePersistenceCallInput, config?: DatabaseUrlConfig): Promise<void>;
export type QqUsageUnreadSummary = {
  unreadCount: number;
  directMentions: number;
};
export type QqUsageThreadSummary = {
  threadKey: string;
  chatType: string;
  peerId: string;
  peerName: string | null;
  accountId: string | null;
  imReceiveEnabled: boolean;
  notificationMuted: boolean;
  notificationAggregationSeconds: number;
  unreadCount: number;
  directMentions: number;
  totalMessages: number;
  lastReceivedAt: string | Date | null;
  latestMessage: Record<string, unknown> | null;
};
export type QqUsageThreadList = {
  offset: number;
  limit: number;
  searchQuery?: string;
  chatType?: 'direct' | 'group' | null;
  hasOlderThreads: boolean;
  hasNewerThreads: boolean;
  threads: QqUsageThreadSummary[];
};
export type QqUsageThreadWindow = {
  threadKey: string;
  mode: string;
  windowSize: number;
  cursorAnchor: string | null;
  hasOlderMessages: boolean;
  hasNewerMessages: boolean;
  newerAvailable: number;
  unreadBeforeWindow: number;
  unreadAfterWindow: number;
  reachedReadHistory: boolean;
  unreadCount: number;
  directMentions: number;
  messages: Record<string, unknown>[];
  latestMessageId: number | null;
  earliestMessageId: number | null;
  windowUnreadCount: number;
};
export type QqUsageGroupNotificationMode = 'all' | 'mentions_only';
export function getQqUsageUnreadSummary(
  input?: Record<string, unknown>,
  config?: DatabaseUrlConfig
): Promise<QqUsageUnreadSummary>;
export function listQqUsageThreads(
  input?: { limit?: number; offset?: number; searchQuery?: string; search_query?: string; query?: string; q?: string; chatType?: 'direct' | 'group'; chat_type?: 'direct' | 'group' },
  config?: DatabaseUrlConfig
): Promise<QqUsageThreadList>;
export function searchQqUsageThreads(
  input?: { limit?: number; offset?: number; searchQuery?: string; search_query?: string; query?: string; q?: string; chatType?: 'direct' | 'group'; chat_type?: 'direct' | 'group' },
  config?: DatabaseUrlConfig
): Promise<QqUsageThreadList>;
export function listQqUsageThreadWindow(
  input?: { threadKey?: string; mode?: 'latest' | 'older' | 'newer'; anchorMessageId?: string | number | bigint | null; limit?: number },
  config?: DatabaseUrlConfig
): Promise<QqUsageThreadWindow>;
export function markQqUsageThreadRead(
  input?: { threadKey?: string | null },
  config?: DatabaseUrlConfig
): Promise<{ threadKey: string | null; clearedCount: number }>;
export function setQqUsageGroupNotificationMode(
  input?: { groupId?: string | number | bigint; group_id?: string | number | bigint; mode?: QqUsageGroupNotificationMode | string },
  config?: DatabaseUrlConfig
): Promise<{ groupId: number; notificationMode: QqUsageGroupNotificationMode }>;
export function setQqUsageGroupNotificationAggregationSeconds(
  input?: { groupId?: string | number | bigint; group_id?: string | number | bigint; seconds?: number | string; notificationAggregationSeconds?: number | string; notification_aggregation_seconds?: number | string },
  config?: DatabaseUrlConfig
): Promise<{ groupId: number; notificationAggregationSeconds: number }>;
export function ensureQqGroupNotificationAggregationSchema(
  input?: { sqlAdapter?: SqlAdapter },
  config?: DatabaseUrlConfig
): Promise<void>;
export function scheduleQqGroupNotificationAggregation(
  input?: Record<string, unknown>,
  config?: DatabaseUrlConfig
): Promise<{ scheduled: boolean; reason?: string | null; sessionKey?: string; dueAt?: string | Date | null; unreadDelta?: number | null }>;
export function claimDueQqGroupNotificationAggregations(
  input?: { limit?: number; sqlAdapter?: SqlAdapter },
  config?: DatabaseUrlConfig
): Promise<Array<{ sessionKey: string; dueAt: string | Date; unreadDelta: number; message: Record<string, unknown> }>>;
export function cancelQqGroupNotificationAggregation(
  input?: { threadKey?: string; thread_key?: string; sessionKey?: string; session_key?: string },
  config?: DatabaseUrlConfig
): Promise<{ cancelledCount: number }>;
export function setQqUsageActiveSurface(
  input?: { identityKey?: string; identity_key?: string; threadKey?: string; thread_key?: string; chatType?: 'direct' | 'group'; chat_type?: 'direct' | 'group'; peerId?: string | null; peer_id?: string | null; accountId?: string | null; account_id?: string | null },
  config?: DatabaseUrlConfig
): Promise<{ identityKey: string; threadKey: string; chatType: 'direct' | 'group' }>;
export function clearQqUsageActiveSurface(
  input?: { identityKey?: string; identity_key?: string; threadKey?: string; thread_key?: string },
  config?: DatabaseUrlConfig
): Promise<{ cleared: boolean; previousThreadKey?: string | null }>;
export function ensureQqAttentionLeaseSchema(
  input?: { sqlAdapter?: SqlAdapter },
  config?: DatabaseUrlConfig
): Promise<void>;
export function renewQqAttentionLease(
  input?: Record<string, unknown>,
  config?: DatabaseUrlConfig
): Promise<Record<string, unknown> | null>;
export function closeQqAttentionLease(
  input?: Record<string, unknown>,
  config?: DatabaseUrlConfig
): Promise<{ closedCount: number }>;
export function maybeCreateQqAttentionReminder(
  input?: Record<string, unknown>,
  config?: DatabaseUrlConfig
): Promise<Record<string, unknown>>;
export function markQqAttentionReminderQueued(
  input?: Record<string, unknown>,
  config?: DatabaseUrlConfig
): Promise<Record<string, unknown> | null>;
export function createFeedbackEpisode(input: FeedbackEpisodeInput, config?: DatabaseUrlConfig): Promise<any>;
export function listFeedbackEpisodes(
  filters?: {
    sessionKey?: string;
    groupId?: number | bigint | string | null;
    sourceUserId?: number | bigint | string | null;
    scopeType?: string;
    eventKind?: string;
    limit?: number;
  },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function createFeedbackReflection(input: FeedbackReflectionInput, config?: DatabaseUrlConfig): Promise<any>;
export function listFeedbackReflections(
  filters?: {
    sessionKey?: string;
    groupId?: number | bigint | string | null;
    sourceUserId?: number | bigint | string | null;
    scopeType?: string;
    learningKey?: string;
    learningScope?: string;
    feedbackKind?: string;
    isActive?: boolean;
    limit?: number;
  },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function markFeedbackReflectionsHit(
  ids: Array<number | bigint | string>,
  params?: FeedbackReflectionHitInput,
  config?: DatabaseUrlConfig
): Promise<{ count: number; hit_at: Date | null }>;
export function getFeedbackLearningState(
  filters: {
    sessionKey?: string;
    groupId?: number | bigint | string | null;
    scopeType?: string;
    learningKey?: string;
    learningScope?: string;
    scopeHash?: string;
  },
  config?: DatabaseUrlConfig
): Promise<any | null>;
export function listFeedbackLearningStates(
  filters?: {
    sessionKey?: string;
    groupId?: number | bigint | string | null;
    scopeType?: string;
    learningKey?: string;
    learningScope?: string;
    limit?: number;
  },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function upsertFeedbackLearningState(input: FeedbackLearningStateInput, config?: DatabaseUrlConfig): Promise<any>;
export function ensureAgentMemorySchema(config?: DatabaseUrlConfig): Promise<void>;
export function createAgentMemoryObservation(input: AgentMemoryObservationInput, config?: DatabaseUrlConfig): Promise<any>;
export function createAgentMemoryAssertion(input: AgentMemoryAssertionInput, config?: DatabaseUrlConfig): Promise<any>;
export function createAgentMemoryReflection(input: AgentMemoryReflectionInput, config?: DatabaseUrlConfig): Promise<any>;
export function listAgentMemoryObservations(
  filters?: { sessionKey?: string; groupId?: number | bigint | string | null; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export const IdentityLineageValidationError: {
  new(message: string, code?: string): Error & { code?: string };
};
export function createXiaoniIdentityRoot(input: XiaoniIdentityRootInput, config?: DatabaseUrlConfig): Promise<any>;
export function ensureXiaoniIdentityRoot(
  input: XiaoniIdentityRootInput,
  config?: DatabaseUrlConfig
): Promise<{ root: any; event: any | null; created: boolean }>;
export function getActiveXiaoniIdentityRoot(identityKey: string, config?: DatabaseUrlConfig): Promise<any | null>;
export function appendIdentityLineageEvent(
  input: IdentityLineageEventInput,
  config?: DatabaseUrlConfig
): Promise<{ event: any; evidenceRefs: any[] }>;
export function appendIdentityChangeCandidate(
  input: IdentityChangeCandidateInput,
  config?: DatabaseUrlConfig
): Promise<{ candidate: any; event: any | null; evidenceRefs: any[] }>;
export function createAcceptedIdentityFact(
  input: AcceptedIdentityFactInput,
  config?: DatabaseUrlConfig
): Promise<{ fact: any; event: any | null; evidenceRefs: any[] }>;
export function recordIdentityFork(
  input: IdentityLineageEventInput & { forkedFromIdentityKey: string; forkPointEventId: number | bigint | string },
  config?: DatabaseUrlConfig
): Promise<{ event: any; evidenceRefs: any[] }>;
export function recordForgettingTombstone(
  input: IdentityLineageEventInput,
  config?: DatabaseUrlConfig
): Promise<{ event: any; evidenceRefs: any[] }>;
export function recordContinuityTrial(
  input: IdentityLineageEventInput,
  config?: DatabaseUrlConfig
): Promise<{ event: any; evidenceRefs: any[] }>;
export function recordRuntimeIdentityActivationTrace(input: RuntimeIdentityActivationTraceInput, config?: DatabaseUrlConfig): Promise<any>;
export function listIdentityLineageEvents(
  filters?: { identityKey?: string; eventType?: string; integrityStatus?: string; changeCandidateId?: number | bigint | string; acceptedFactId?: number | bigint | string; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function listIdentityChangeCandidates(
  filters?: { identityKey?: string; candidateType?: string; status?: string; judgeStatus?: string; quarantineGroupKey?: string; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function listIdentityEvidenceRefs(
  filters?: {
    identityKey?: string;
    identityEventId?: number | bigint | string;
    changeCandidateId?: number | bigint | string;
    acceptedFactId?: number | bigint | string;
    sourceType?: string;
    traceId?: string;
    runId?: string;
    redactionStatus?: string;
    limit?: number;
  },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function listAcceptedIdentityFacts(
  filters?: { identityKey?: string; factType?: string; status?: string; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function listRuntimeIdentityActivationTraces(
  filters?: { identityKey?: string; traceId?: string; runId?: string; conversationId?: number | bigint | string; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function createSelfEvolutionJob(input: SelfEvolutionJobInput, config?: DatabaseUrlConfig): Promise<any>;
export function updateSelfEvolutionJob(
  id: number | bigint | string,
  updates?: Partial<SelfEvolutionJobInput>,
  config?: DatabaseUrlConfig
): Promise<any>;
export function listSelfEvolutionJobs(
  filters?: { groupId?: number | bigint | string | null; targetUserId?: number | bigint | string | null; sessionKey?: string; status?: string; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function replaceSelfEvolutionStates(
  input: {
    sessionKey: string;
    groupId?: number | bigint | string | null;
    targetUserId?: number | bigint | string | null;
    scopeType: string;
    version: number;
    states: SelfEvolutionStateInput[];
  },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function listSelfEvolutionStates(
  filters?: { sessionKey?: string; groupId?: number | bigint | string | null; targetUserId?: number | bigint | string | null; scopeType?: string; isActive?: boolean; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function createChatSpaceTopic(input: ChatSpaceTopicInput, config?: DatabaseUrlConfig): Promise<any>;
export function updateChatSpaceTopic(
  id: number | bigint | string,
  updates?: Partial<ChatSpaceTopicInput>,
  config?: DatabaseUrlConfig
): Promise<any>;
export function getChatSpaceTopicById(id: number | bigint | string, config?: DatabaseUrlConfig): Promise<any | null>;
export function listChatSpaceTopics(
  filters?: { chatSpaceType?: string; chatSpaceId?: number | bigint | string; status?: string; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function createTopicProjectionJob(input: TopicProjectionJobInput, config?: DatabaseUrlConfig): Promise<any>;
export function updateTopicProjectionJob(
  id: number | bigint | string,
  updates?: Partial<TopicProjectionJobInput>,
  config?: DatabaseUrlConfig
): Promise<any>;
export function getTopicProjectionJobById(id: number | bigint | string, config?: DatabaseUrlConfig): Promise<any | null>;
export function listTopicProjectionJobs(
  filters?: { chatSpaceType?: string; chatSpaceId?: number | bigint | string; status?: string; triggerType?: string; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function createTopicProjectionVersionSnapshot(
  input: TopicProjectionVersionSnapshotInput,
  config?: DatabaseUrlConfig
): Promise<any>;
export function updateTopicProjectionVersion(
  id: number | bigint | string,
  updates?: Partial<TopicProjectionVersionSnapshotInput>,
  config?: DatabaseUrlConfig
): Promise<any>;
export function getTopicProjectionVersionById(id: number | bigint | string, config?: DatabaseUrlConfig): Promise<any | null>;
export function listTopicProjectionVersions(
  filters?: { topicId?: number | bigint | string; projectionJobId?: number | bigint | string; status?: string; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function listTopicVersionRelationships(
  filters?: { projectionVersionId?: number | bigint | string; targetUserId?: number | bigint | string; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function listTopicVersionEvidence(
  filters?: { projectionVersionId?: number | bigint | string; sourceKind?: string; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function createTopicReviewEvent(input: TopicReviewEventInput, config?: DatabaseUrlConfig): Promise<any>;
export function updateTopicReviewEvent(
  id: number | bigint | string,
  updates?: Partial<TopicReviewEventInput>,
  config?: DatabaseUrlConfig
): Promise<any>;
export function getTopicReviewEventById(id: number | bigint | string, config?: DatabaseUrlConfig): Promise<any | null>;
export function listTopicReviewEvents(
  filters?: { topicId?: number | bigint | string; baseProjectionVersionId?: number | bigint | string; status?: string; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function createGoldenChatCase(input: GoldenChatCaseInput, config?: DatabaseUrlConfig): Promise<any>;
export function listGoldenChatCases(
  filters?: { chatSpaceType?: string; chatSpaceId?: number | bigint | string; topicId?: number | bigint | string; status?: string; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function ensureImageLabSchema(config?: DatabaseUrlConfig): Promise<void>;
export function createImageLabRun(input: ImageLabRunInput, config?: DatabaseUrlConfig): Promise<any>;
export function updateImageLabRun(input: ImageLabRunUpdateInput, config?: DatabaseUrlConfig): Promise<any>;
export function addImageLabArtifacts(runId: string, artifacts: ImageLabArtifactInput[], config?: DatabaseUrlConfig): Promise<any[]>;
export function getImageLabRunById(id: string, config?: DatabaseUrlConfig): Promise<any | null>;
export function listImageLabRuns(
  filters?: { operation?: string; status?: string; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function ensureAgentMediaSchema(config?: DatabaseUrlConfig): Promise<void>;
export function upsertAgentMediaAsset(input: Record<string, any>, config?: DatabaseUrlConfig): Promise<any>;
export function upsertAgentMediaAssets(inputs: Record<string, any>[], config?: DatabaseUrlConfig): Promise<any[]>;
export function listAgentMediaAssets(
  filters?: { sessionKey?: string; session_key?: string; messageSids?: string[]; message_sids?: string[]; mediaTag?: string; media_tag?: string; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function getAgentMediaAssetByTag(
  filters?: { sessionKey?: string; session_key?: string; messageSids?: string[]; message_sids?: string[]; mediaTag?: string; media_tag?: string; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any | null>;
export function getAgentMediaAssetById(
  filters?: { id?: string; assetId?: string; asset_id?: string; sessionKey?: string; session_key?: string },
  config?: DatabaseUrlConfig
): Promise<any | null>;
export function createAgentMediaObservation(input: Record<string, any>, config?: DatabaseUrlConfig): Promise<any>;
export function ensureAgentTaskSchema(config?: DatabaseUrlConfig): Promise<void>;
export function createAgentTask(input: Record<string, any>, config?: DatabaseUrlConfig): Promise<any>;
export function claimNextAgentTask(workerId: string, config?: DatabaseUrlConfig): Promise<any | null>;
export function updateAgentTask(input: Record<string, any>, config?: DatabaseUrlConfig): Promise<any>;
export function addAgentTaskArtifacts(taskId: string, artifacts: Record<string, any>[], config?: DatabaseUrlConfig): Promise<any[]>;
export function getAgentTaskById(id: string, config?: DatabaseUrlConfig): Promise<any | null>;
export function listAgentTasks(
  filters?: { sessionKey?: string; session_key?: string; status?: string; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export type AbTurnSnapshotInput = {
  id?: string;
  sourceKey?: string;
  source_key?: string;
  traceId?: string | null;
  trace_id?: string | null;
  runId?: string | null;
  run_id?: string | null;
  sessionKey?: string | null;
  session_key?: string | null;
  chatType?: string | null;
  chat_type?: string | null;
  peerId?: string | null;
  peer_id?: string | null;
  senderId?: string | null;
  sender_id?: string | null;
  queueMessageIds?: unknown[];
  queue_message_ids?: unknown[];
  providerEventIds?: unknown[];
  provider_event_ids?: unknown[];
  scene?: Record<string, unknown>;
  memoryStreamView?: Record<string, unknown>;
  memory_stream_view?: Record<string, unknown>;
  retrievalPolicy?: Record<string, unknown>;
  retrieval_policy?: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
  runtime_config?: Record<string, unknown>;
  captureStatus?: string;
  capture_status?: string;
  controlStatus?: string;
  control_status?: string;
  treatmentStatus?: string;
  treatment_status?: string;
  evalStatus?: string;
  eval_status?: string;
  captureError?: string | null;
  capture_error?: string | null;
};
export type AbArmRunInput = {
  id?: string;
  snapshotId?: string;
  snapshot_id?: string;
  arm: 'control' | 'treatment' | string;
  projectOrNamespace?: string | null;
  project_or_namespace?: string | null;
  runnerName?: string | null;
  runner_name?: string | null;
  modelName?: string | null;
  model_name?: string | null;
  inputSummary?: Record<string, unknown>;
  input_summary?: Record<string, unknown>;
  outputArtifact?: Record<string, unknown>;
  output_artifact?: Record<string, unknown>;
  memoryContext?: Record<string, unknown>;
  memory_context?: Record<string, unknown>;
  failure?: Record<string, unknown> | null;
  startedAt?: string | Date | null;
  started_at?: string | Date | null;
  completedAt?: string | Date | null;
  completed_at?: string | Date | null;
  status?: string;
};
export type AbMemoryStreamItemInput = {
  id?: string;
  namespace: string;
  arm: 'control' | 'treatment' | string;
  type: 'observation' | 'reflection' | 'plan' | string;
  subtype?: string | null;
  content: string;
  retrievalText?: string | null;
  retrieval_text?: string | null;
  embeddingText?: string | null;
  embedding_text?: string | null;
  importance?: number;
  confidence?: number;
  status?: string;
  sourceEventRefs?: unknown[];
  source_event_refs?: unknown[];
  provenance?: Record<string, unknown>;
  ttlExpiresAt?: string | Date | null;
  ttl_expires_at?: string | Date | null;
  fulfilledAt?: string | Date | null;
  fulfilled_at?: string | Date | null;
};
export type AbEvalResultInput = {
  id?: string;
  snapshotId?: string;
  snapshot_id?: string;
  controlArmRunId?: string | null;
  control_arm_run_id?: string | null;
  treatmentArmRunId?: string | null;
  treatment_arm_run_id?: string | null;
  label?: 'mini_better' | 'control_better' | 'tie' | 'both_bad' | 'unclear' | string;
  dimensions?: Record<string, unknown>;
  reviewerNotes?: string | null;
  reviewer_notes?: string | null;
  isolationCheck?: Record<string, unknown>;
  isolation_check?: Record<string, unknown>;
  fixtureId?: string | null;
  fixture_id?: string | null;
};
export function createAbTurnSnapshot(input: AbTurnSnapshotInput, config?: DatabaseUrlConfig): Promise<any>;
export function getAbTurnSnapshot(idOrSourceKey: string, config?: DatabaseUrlConfig): Promise<any | null>;
export function listAbTurnSnapshots(
  filters?: {
    traceId?: string;
    trace_id?: string;
    runId?: string;
    run_id?: string;
    sessionKey?: string;
    session_key?: string;
    chatType?: string;
    chat_type?: string;
    captureStatus?: string;
    capture_status?: string;
    controlStatus?: string;
    control_status?: string;
    treatmentStatus?: string;
    treatment_status?: string;
    evalStatus?: string;
    eval_status?: string;
    limit?: number;
  },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function updateAbTurnSnapshotStatuses(snapshotId: string, statuses?: Record<string, string>, config?: DatabaseUrlConfig): Promise<any | null>;
export function upsertAbArmRun(input: AbArmRunInput, config?: DatabaseUrlConfig): Promise<any>;
export function getAbArmRunsForSnapshot(snapshotId: string, config?: DatabaseUrlConfig): Promise<any[]>;
export function createAbMemoryStreamItem(input: AbMemoryStreamItemInput, config?: DatabaseUrlConfig): Promise<any>;
export function listAbMemoryStreamItems(
  filters?: { namespace?: string; arm?: string; type?: string; subtype?: string; status?: string; includeExpired?: boolean; limit?: number },
  config?: DatabaseUrlConfig
): Promise<any[]>;
export function markAbMemoryPlanFulfilled(id: string, params?: { status?: string; fulfilledAt?: string | Date; fulfilled_at?: string | Date }, config?: DatabaseUrlConfig): Promise<any>;
export function createAbEvalResult(input: AbEvalResultInput, config?: DatabaseUrlConfig): Promise<any>;
export function getAbExperimentTrace(snapshotId: string, config?: DatabaseUrlConfig): Promise<any | null>;

export type RelationshipTrustLevel = 'L1' | 'L2' | 'L3' | 'L4';
export function ensureRelationshipTrustSchema(config?: DatabaseUrlConfig): Promise<void>;
export function getRelationshipTrustLevel(identityKey: string, speakerQq: number | bigint | string, config?: DatabaseUrlConfig): Promise<RelationshipTrustLevel>;
export function upsertRelationshipTrust(input: { identityKey: string; speakerQq: number | bigint | string; trustScore: number; level: RelationshipTrustLevel }, config?: DatabaseUrlConfig): Promise<void>;
export function incrementRelationshipTrust(input: { identityKey: string; speakerQq: number; delta: number }, config?: Record<string, unknown>): Promise<void>;

// agent-queue
export type AgentQueueEnqueueInput = {
  message?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  availableAt?: string | Date;
  available_at?: string | Date;
} & Record<string, unknown>;
export function enqueueAgentQueueMessage(input: AgentQueueEnqueueInput, config?: DatabaseUrlConfig): Promise<{
  queueId: number;
  traceId: string;
  dedupeKey: string;
  status: string;
  attempts: number;
  availableAt: string | null;
  payload: Record<string, unknown>;
}>;
export type AgentQueueClaimInput = {
  workerId?: string;
  worker_id?: string;
  sqlAdapter?: SqlAdapter;
};
export type AgentQueueBatchMessage = {
  queueMessageId: number;
  traceId: string;
  source: string;
  messageId: number;
  messageSid: string;
  chatType: 'direct' | 'group';
  sessionKey: string;
  peerId: string;
  peerName?: string;
  senderId: string;
  senderName?: string;
  accountId: string;
  bodyForAgent: string;
  rawBody: string;
  commandBody: string;
  wasMentioned: boolean;
  receivedAt: string;
  messageTimestamp?: string | null;
  rawPayload: Record<string, unknown>;
  inboundContext: Record<string, unknown>;
};
export type AgentQueueClaimedMessage = {
  id: string;
  traceId: string;
  batchId: string;
  status: string;
  attempts: number;
  maxAttempts?: number;
  createdAt: string;
  processingStartedAt?: string | null;
  completedAt?: string | null;
  conversationId?: number | null;
  errorMessage?: string | null;
  queueMessageIds: number[];
  payload: Record<string, unknown> & {
    traceId: string;
    runId: string;
    batchId: string;
    source: string;
    chatType: 'direct' | 'group';
    sessionKey: string;
    peerId: string;
    peerName?: string;
    senderId: string;
    senderName?: string;
    accountId: string;
    bodyForAgent: string;
    rawBody: string;
    commandBody: string;
    wasMentioned: boolean;
    receivedAt: string;
    messageTimestamp?: string | null;
    rawPayload: Record<string, unknown>;
    inboundContext: Record<string, unknown>;
    messages: AgentQueueBatchMessage[];
  };
};
export function claimNextAgentQueueMessage(input?: AgentQueueClaimInput, config?: DatabaseUrlConfig): Promise<AgentQueueClaimedMessage | null>;
export function settleAgentQueueMessages(input: {
  runId?: string;
  run_id?: string;
  conversationId?: number | null;
  conversation_id?: number | null;
  result?: Record<string, unknown>;
  sqlAdapter?: SqlAdapter;
}, config?: DatabaseUrlConfig): Promise<void>;
export function failAgentQueueMessage(input: {
  runId?: string;
  run_id?: string;
  errorMessage?: string;
  error_message?: string;
  conversationId?: number | null;
  conversation_id?: number | null;
  sqlAdapter?: SqlAdapter;
}, config?: DatabaseUrlConfig): Promise<void>;
export function retryAgentQueueMessage(input: {
  runId?: string;
  run_id?: string;
  errorMessage?: string;
  error_message?: string;
  retryDelayMs?: number;
  retry_delay_ms?: number;
  sqlAdapter?: SqlAdapter;
}, config?: DatabaseUrlConfig): Promise<number>;

// agent-presence
export type AgentSharePoolItemProjection = {
  id: number;
  identityKey: string;
  content: string;
  sourceKind: string;
  boundaryLabel: string;
  sourceWording: string;
  effortCost: number;
  baseHeat: number;
  createdAt: string | null;
  metadata: Record<string, unknown>;
};
export type AgentLifeEventKind =
  | 'surface_visit'
  | 'qq_message_seen'
  | 'qq_self_message'
  | 'send_in_group'
  | 'silence_decision'
  | 'surface_leave'
  | 'web_search_result'
  | 'pending_share_created'
  | 'pending_share_consumed'
  | 'state_snapshot'
  | 'terminal_action_committed'
  | 'terminal_action_blocked'
  | 'presence_tick_evaluated'
  | 'rest_period'
  | 'sleep_period';
export type AgentLifeEventVisibility =
  | 'active_surface'
  | 'public_residue'
  | 'self_private'
  | 'private_surface'
  | 'operator_only';
export type AgentLifeEventProjection = {
  id: string;
  identityKey: string;
  eventKind: AgentLifeEventKind | string;
  occurredAt: string | null;
  surface: string | null;
  chatType: string | null;
  sessionKey: string | null;
  surfaceId: string | null;
  peerId: string | null;
  accountId: string | null;
  messageSid: string | null;
  messageId: string | null;
  batchId: string | null;
  conversationId: string | null;
  conversationItemId: string | null;
  queueMessageId: string | null;
  runId: string | null;
  traceId: string | null;
  llmCallId: string | null;
  sourceActionId: string | null;
  actorType: string;
  actorId: string | null;
  targetId: string | null;
  visibility: AgentLifeEventVisibility | string;
  actionCost: number;
  pressureDelta: number;
  rewardDelta: number;
  boredomDelta: number;
  attentionDelta: number;
  payload: Record<string, unknown>;
  dedupeKey: string;
  createdAt: string | null;
};
export type AgentRecoveryWindowProjection = {
  active: boolean;
  identityKey: string;
  eventId: string | null;
  eventKind: string;
  occurredAt: string;
  recoverUntil: string;
  remainingMs: number;
  durationMs: number;
  reason: string | null;
  traceId: string | null;
  runId: string | null;
  continuationDedupeKey?: string | null;
  continuationQueued?: boolean;
};
export type XiaoniActivityFeedItem = {
  id: string;
  source: 'life_event' | 'tool_execution' | 'llm_request' | 'llm_stack_item' | 'digital_action' | 'task' | 'media_observation' | 'queue_message' | string;
  kind: string;
  title: string;
  body: string | null;
  status: string | null;
  actor: string | null;
  actorName: string | null;
  timestamp: string;
  sessionKey: string | null;
  peerName: string | null;
  runId: string | null;
  traceId: string | null;
  tone: 'xiaoni' | 'success' | 'warning' | 'danger' | 'info' | 'neutral' | string;
  metadata: Record<string, unknown>;
};
export type XiaoniForkTimelineRun = {
  id: string;
  forkRunId: string;
  source: string;
  kind: string;
  title: string;
  body: string | null;
  status: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  traceId: string | null;
  runId: string | null;
  conversationId?: string | null;
  eventCount: number;
  events: XiaoniActivityFeedItem[];
  metadata: Record<string, unknown>;
};
export type XiaoniForkTimeline = {
  runs: XiaoniForkTimelineRun[];
};
export type XiaoniActionStreamItem = Omit<XiaoniActivityFeedItem, 'runId' | 'status'> & {
  status: 'observed' | 'running' | 'ok' | 'failed' | 'blocked' | 'waiting' | 'resting' | string | null;
  eventId: string;
  eventKind: string;
  occurredAt: string;
  internalExecutionLeaseId: string | null;
  runId: null;
  traceTarget: {
    internalExecutionLeaseId: string;
    traceId: string | null;
    spanId: string | null;
    llmRequestSliceId?: string | null;
    toolCallId?: string | null;
    stackItemId?: string | null;
    sourceKind?: string | null;
    forkRunId?: string | null;
  } | null;
};
export type XiaoniActionEventTraceTarget = {
  conversationId: string | null;
  traceId: string | null;
  spanId: string | null;
  internalExecutionLeaseId: string | null;
  llmRequestSliceId?: string | null;
  toolCallId?: string | null;
  stackItemId?: string | null;
  sourceKind?: string | null;
  forkRunId?: string | null;
};
export type XiaoniActivityTimeFilters = {
  range?: string;
  startTime?: string | null;
  endTime?: string | null;
};
export type XiaoniActivityFeedResult = {
  identityKey: string;
  generatedAt: string;
  filters?: XiaoniActivityTimeFilters;
  current: {
    lifeState: Record<string, unknown> | null;
    latestActivityAt: string | null;
    queue: {
      pending: number;
      processing: number;
      staleProcessing: number;
      failed: number;
    };
    digitalActions: {
      planned: number;
      processing: number;
      completed: number;
      failed: number;
    };
    autonomy: {
      latestConsciousnessTickAt: string | null;
      latestConsciousnessTickStatus: string | null;
      latestPhoneNotificationAt: string | null;
      latestPhoneNotificationStatus: string | null;
      latestPresenceEvaluationAt: string | null;
      latestPresenceEvaluationReason: string | null;
      latestPresenceEvaluationEligible: boolean | null;
      liveSelfActionRunner: boolean;
      latestHistoricalDigitalActionAt: string | null;
      latestHistoricalDigitalActionStatus: string | null;
      latestHistoricalDigitalActionKind: string | null;
    };
    tasks: {
      pending: number;
      processing: number;
      completed: number;
      failed: number;
    };
  };
  items: XiaoniActivityFeedItem[];
  compressionForkTimeline?: XiaoniForkTimeline;
  cacheHeartbeatTimeline?: XiaoniForkTimeline;
  imageVisionForkTimeline?: XiaoniForkTimeline;
};
export type XiaoniActionStreamResult = {
  identityKey: string;
  generatedAt: string;
  streamKind: 'xiaoni_action_stream';
  filters?: XiaoniActivityTimeFilters;
  pagination?: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
  availableTags?: Array<{
    key: string;
    label: string;
    tone?: string;
    count?: number;
  }>;
  focusedEventId?: string | null;
  current: {
    lifeState: Record<string, unknown> | null;
    latestActivityAt: string | null;
    queue: {
      pending: number;
      running: number;
      staleRunning: number;
      failed: number;
    };
    backgroundActions: {
      planned: number;
      running: number;
      settled: number;
      failed: number;
    };
    autonomy: XiaoniActivityFeedResult['current']['autonomy'];
    tasks: {
      pending: number;
      running: number;
      settled: number;
      failed: number;
    };
  };
  items: XiaoniActionStreamItem[];
  compressionForkTimeline?: XiaoniForkTimeline;
  subconsciousForkTimeline?: XiaoniForkTimeline;
  cacheHeartbeatTimeline?: XiaoniForkTimeline;
  imageVisionForkTimeline?: XiaoniForkTimeline;
};
export type RecordAgentLifeEventInput = {
  identityKey?: string;
  identity_key?: string;
  eventKind: AgentLifeEventKind | string;
  event_kind?: AgentLifeEventKind | string;
  occurredAt?: string | Date;
  occurred_at?: string | Date;
  surface?: string | null;
  chatType?: string | null;
  chat_type?: string | null;
  sessionKey?: string | null;
  session_key?: string | null;
  surfaceId?: string | null;
  surface_id?: string | null;
  peerId?: string | null;
  peer_id?: string | null;
  accountId?: string | null;
  account_id?: string | null;
  messageSid?: string | null;
  message_sid?: string | null;
  messageId?: string | number | null;
  message_id?: string | number | null;
  batchId?: string | null;
  batch_id?: string | null;
  conversationId?: string | number | bigint | null;
  conversation_id?: string | number | bigint | null;
  conversationItemId?: string | number | bigint | null;
  conversation_item_id?: string | number | bigint | null;
  queueMessageId?: string | number | bigint | null;
  queue_message_id?: string | number | bigint | null;
  runId?: string | null;
  run_id?: string | null;
  traceId?: string | null;
  trace_id?: string | null;
  llmCallId?: string | null;
  llm_call_id?: string | null;
  sourceActionId?: string | null;
  source_action_id?: string | null;
  actorType?: string | null;
  actor_type?: string | null;
  actorId?: string | null;
  actor_id?: string | null;
  targetId?: string | null;
  target_id?: string | null;
  visibility?: AgentLifeEventVisibility | string;
  actionCost?: number;
  action_cost?: number;
  pressureDelta?: number;
  pressure_delta?: number;
  rewardDelta?: number;
  reward_delta?: number;
  boredomDelta?: number;
  boredom_delta?: number;
  attentionDelta?: number;
  attention_delta?: number;
  payload?: Record<string, unknown>;
  dedupeKey: string;
  dedupe_key?: string;
};
export function ensureAgentPresenceSchema(config?: DatabaseUrlConfig): Promise<void>;
export function ensureAgentLifeState(identityKey: string, config?: DatabaseUrlConfig): Promise<Record<string, unknown>>;
export function getAgentLifeState(identityKey: string, config?: DatabaseUrlConfig): Promise<Record<string, unknown> | null>;
export function updateAgentLifeState(identityKey: string, data: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<Record<string, unknown>>;
export function upsertAgentGroupPresenceState(input: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<Record<string, unknown>>;
export function listAgentSharePoolItems(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<AgentSharePoolItemProjection[]>;
export function createAgentSharePoolItem(input: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<AgentSharePoolItemProjection>;
export function createAgentShareItemUsage(input: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<Record<string, unknown>>;
export function createAgentPresenceStateSidecar(input: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<Record<string, unknown>>;
export function ensureAgentLifeEventSchema(config?: DatabaseUrlConfig): Promise<void>;
export function recordAgentLifeEvent(input: RecordAgentLifeEventInput, config?: DatabaseUrlConfig): Promise<AgentLifeEventProjection>;
export function listAgentLifeEvents(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<AgentLifeEventProjection[]>;
export function listAgentLifeEventsForPrompt(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<AgentLifeEventProjection[]>;
export function getActiveAgentRecoveryWindow(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<AgentRecoveryWindowProjection | null>;
export function getLatestAgentRecoveryWindow(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<AgentRecoveryWindowProjection | null>;
export function findAgentLifeEventByDedupeKey(dedupeKey: string, config?: DatabaseUrlConfig): Promise<AgentLifeEventProjection | null>;
export type AgentRecoverySessionProjection = {
  id: number;
  identityKey: string;
  initiator: string;
  status: string;
  wakeCause: string | null;
  reason: string | null;
  xiaoniOs: string | null;
  clockMinutes: number | null;
  clockDueAt: string | null;
  clockFiredAt: string | null;
  clockDeferredAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  lastCheckedAt: string | null;
  toolExecutionId: string | null;
  llmRequestSliceId: string | null;
  llmCallId: string | null;
  toolCallId: string | null;
  traceId: string | null;
  runId: string | null;
  conversationId: number | null;
  queueMessageId: string | null;
  wakeCountStartQueueMessageId: number | null;
  lastWakeCountedQueueMessageId: number | null;
  wakeCallCount: number;
  wakeRequiredCount: number | null;
  startPressure: number | null;
  currentPressure: number | null;
  startEnergy: number | null;
  currentEnergy: number | null;
  maxEnergy: number;
  plannedNaturalWakeAt: string | null;
  hardWakeAt: string | null;
  result: Record<string, unknown>;
  metadata: Record<string, unknown>;
  cacheHeartbeat?: {
    intervalMs: number | null;
    nextDueAt: string | null;
    lastClaimedAt: string | null;
    inFlightStartedAt: string | null;
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    lastStatus: string | null;
    lastEventId: string | null;
    lastLlmCallId: string | null;
    lastError: string | null;
    claimCount: number;
  };
  createdAt: string | null;
  updatedAt: string | null;
};
export type AgentRecoveryCacheHeartbeatClaimResult = {
  claimed: boolean;
  reason: string;
  session: AgentRecoverySessionProjection | null;
  nextDueAt: string | null;
  inFlightStartedAt?: string | null;
};
export type AgentRecoveryWakeNotificationProjection = {
  id: number;
  chatType: 'direct' | 'group';
  sessionKey: string;
  peerId: string;
  createdAt: string | null;
  payload: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  wakeCount: number;
};
export function ensureAgentRecoverySessionSchema(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<void>;
export function getAgentRecoveryQueueHighWatermark(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<number>;
export function createAgentRecoverySession(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<AgentRecoverySessionProjection>;
export function getActiveAgentRecoverySession(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<AgentRecoverySessionProjection | null>;
export function listAgentRecoverySessions(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<AgentRecoverySessionProjection[]>;
export function listAgentRecoveryWakeNotifications(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<AgentRecoveryWakeNotificationProjection[]>;
export function updateAgentRecoverySessionProgress(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<AgentRecoverySessionProjection | null>;
export function claimAgentRecoveryCacheHeartbeat(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<AgentRecoveryCacheHeartbeatClaimResult>;
export function completeAgentRecoveryCacheHeartbeat(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<AgentRecoverySessionProjection | null>;
export function clearAgentRecoveryCacheHeartbeatSchedule(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<AgentRecoverySessionProjection | null>;
export function finalizeAgentRecoverySession(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<AgentRecoverySessionProjection | null>;
export function getXiaoniActivityFeed(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<XiaoniActivityFeedResult>;
export function getXiaoniActionStream(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<XiaoniActionStreamResult>;
export function findXiaoniActionEventTraceTarget(eventId: string, config?: DatabaseUrlConfig): Promise<XiaoniActionEventTraceTarget | null>;
export type AgentRuntimeControlProjection = {
  identityKey: string;
  enabled: boolean;
  cacheHeartbeatPaused: boolean;
  cacheHeartbeatPausedAt: string | null;
  postCompressionPauseArmed: boolean;
  postCompressionPauseArmedAt: string | null;
  postCompressionPauseTriggeredAt: string | null;
  postCompressionPauseReason: string | null;
  mainAgentPreModelYieldMs: number;
  updatedAt: string | null;
};
export function ensureAgentRuntimeControlSchema(config?: DatabaseUrlConfig): Promise<void>;
export function getAgentRuntimeControl(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<AgentRuntimeControlProjection>;
export function updateAgentRuntimeControl(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<AgentRuntimeControlProjection>;
export function triggerPostCompressionRuntimePause(input?: Record<string, unknown>, config?: DatabaseUrlConfig): Promise<AgentRuntimeControlProjection>;
