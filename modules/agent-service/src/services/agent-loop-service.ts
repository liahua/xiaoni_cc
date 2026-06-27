import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { v4 as uuidv4 } from 'uuid';
import { agentConfig, getGlobalPromptContextSessionKey } from '../config';
import { logger } from '../utils/logger';
import type { UnreadMeaningSocialActType } from '../types/social-act-type';
import {
  AgentToolCall,
  ConversationTranscriptItem,
  ConversationTranscriptPhase,
  ConversationTurn,
  QueueBatchMessage,
  QueueMessageRecord
} from '../types';
import {
  AgentPromptResolver,
  AgentPromptService,
  MissingAgentPromptBindingError,
  ResolvedAgentRuntimePrompt,
  applyPromptTemplate
} from './agent-prompt-service';
import {
  formatIdentity,
  normalizeTranscriptMessageText,
  renderRuntimeBatchInput
} from './runtime-input-renderer';
import {
  RuntimeStore,
  type RuntimeAcceptedIdentityFact,
  type RuntimePresenceContext,
  type SessionReadCutoffState
} from './runtime-store';
import { resolveModelContextPolicy } from './model-context-policy';
import { estimateRequestTokens } from './token-estimator';
import {
  ResponseActionRouter,
  type ResponsePostAction,
  type ReplayableModelOutput,
  extractReplayableModelOutputs,
  isReplayableToolCall
} from './response-action-router';
import { readXiaoniPromptFile, renderXiaoniPromptTemplate } from '../prompts/xiaoni-prompt-files';
import {
  DEFAULT_RECOVER_ENERGY_POLICY,
  LEGACY_RECOVER_ENERGY_POLICY,
  LEGACY_RECOVER_ENERGY_POLICY_VERSION,
  RECOVER_ENERGY_CLOCK_MAX_MINUTES,
  type RecoverySessionPolicy,
  createRecoveryPolicySnapshot,
  estimateNaturalWakeAt,
  estimateSessionWakeAt,
  normalizeRecoverEnergyClock,
  projectRecoverySession,
  recoverEnergyFullRecoveryMinutes,
  recoverySessionPolicyFromSnapshot,
  resolveRecoveryCircadianState,
  shouldAcceptVoluntaryRecovery
} from './recover-energy-policy';

type OpenResponseInputItem =
  | {
      type: 'message';
      role: 'system' | 'user' | 'assistant' | 'developer';
      content: string | OpenResponseInputContentPart[];
      phase?: ConversationTranscriptPhase;
      [key: string]: unknown;
    }
  | {
      type: 'function_call';
      call_id: string;
      name: string;
      arguments: string;
      [key: string]: unknown;
    }
  | {
      type: 'function_call_output';
      call_id: string;
      output: string | OpenResponseInputContentPart[];
      [key: string]: unknown;
    }
  | {
      type: 'reasoning';
      content?: string;
      summary?: string | Array<Record<string, unknown>>;
      encrypted_content?: string;
      [key: string]: unknown;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

type OpenResponseInputContentPart =
  | {
      type: 'input_text';
      text: string;
    }
  | {
      type: 'output_text';
      text: string;
    }
  | {
      type: 'refusal';
      refusal: string;
    }
  | {
      type: 'input_image';
      image_url: string;
      detail?: 'low' | 'high' | 'auto' | 'original';
    };

const CORE_MEMORY_COMPRESSION_REMINDER_MARKER = Symbol('coreMemoryCompressionReminder');
const OPENAI_CALL_ID_MAX_LENGTH = 64;
const IMAGE_VISION_FORK_MAX_FILE_WRITE_ATTEMPTS = 10;
const IMAGE_VISION_OBSERVATION_DIR = '/xiaoni-runtime/image-vision/observations';
const SUBCONSCIOUS_AGENT_FORK_IDLE_BACKOFF_MS = 60_000;

type OpenResponseToolDefinition = {
  type: 'function';
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: readonly string[];
      additionalProperties: false;
    };
  };
  strict?: boolean;
} | {
  type: 'web_search';
  search_context_size?: 'low' | 'medium' | 'high';
  external_web_access?: boolean;
} | {
  type: 'image_generation';
  model?: 'gpt-image-2';
  output_format?: 'png' | 'jpeg' | 'webp';
  size?: string;
  quality?: string;
  background?: string;
};

type OpenResponseToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | {
      type: 'allowed_tools';
      mode: 'auto' | 'required';
      tools: Array<
        | {
            type: 'function';
            name: string;
          }
        | {
            type: 'web_search';
          }
        | {
            type: 'image_generation';
          }
      >;
    };

type FeedbackWriterToolChoice = OpenResponseToolChoice | undefined;

type ToolContinuationAction = {
  inputItems: OpenResponseInputItem[];
  oneShotInputItems: OpenResponseInputItem[];
  forcedVisibleReply: {
    toolName: string;
    args: Record<string, unknown>;
  } | null;
};

type ToolContinuationContext = {
  loopInput: OpenResponseInputItem[];
  speakingToolName: string;
  hasVisibleReply: boolean;
  runtimeEnergyState?: RuntimeEnergyState | null;
};

type ToolExecutionContext = {
  currentCanonicalRequest?: CanonicalAgentTurnRequest;
};

export type RuntimeEnergyState = {
  energy: number;
  maxEnergy: number;
  lastWakeAt?: string | null;
};

type DeliveredAssistantMessage = {
  content: string;
  deliveryMessageId: number | null;
};

type LeaseReleaseReason =
  | 'visible_delivery_committed'
  | 'no_visible_delivery_observed'
  | 'runtime_frame_yielded'
  | 'runtime_error'
  | 'prompt_binding_error';

type LeaseReleaseRecord = {
  event_kind: 'lease_released';
  reason: LeaseReleaseReason;
  detail: string | null;
  outcome: string | null;
  no_visible_delivery: boolean;
  visible_delivery_committed: boolean;
  source: string;
  tool_result?: Record<string, unknown>;
};

type ReplayableToolCallOutput = Extract<ReplayableModelOutput, { type: 'tool_call' }>;

type StackBackedConversationTurn = ConversationTurn & {
  stackReplayItems?: OpenResponseInputItem[];
};

type PreSleepToolTimelineEntry = {
  call_id: string;
  name: string;
  completed_at: string;
  status: 'completed' | 'failed';
};

type CanonicalAgentTurnRequest = {
  model: string;
  input: OpenResponseInputItem[];
  instructions?: string;
  metadata?: Record<string, string>;
  tools?: OpenResponseToolDefinition[];
  tool_choice?: OpenResponseToolChoice;
  reasoning?: {
    effort?: string;
    summary?: string;
    [key: string]: unknown;
  };
  text?: Record<string, unknown>;
  include?: string[];
  context_management?: Array<Record<string, unknown>>;
  parallel_tool_calls: boolean;
  prompt_cache_key?: string;
  prompt_cache_retention?: string;
  max_output_tokens?: number;
  store?: boolean;
};

type CacheHeartbeatRunResult = {
  triggered: boolean;
  reason?: string;
  executionMode: string;
  traceId?: string;
  runId?: string;
  promptName?: string;
  model?: string | null;
  provider?: string | null;
  llmCallId?: string | null;
  promptCacheKey?: string | null;
  store?: boolean | null;
  maxOutputTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cachedInputTokens?: number | null;
  processingTimeMs?: number | null;
};

// Result of an operator-forced core memory compaction (admin "立即压缩" button).
// `status` mirrors scheduleCoreMemoryCompressionFork's artifact status
// (scheduled | already_running | already_running_durable | already_covered),
// plus 'nothing_to_compress' (history at/under the keep window) and
// 'request_builder_unavailable' (store wiring missing). `triggered` is true only
// when this call actually spawned a new background fork.
type ManualCoreMemoryCompressionResult = {
  triggered: boolean;
  status: string;
  contextSessionKey: string;
  traceId: string;
  runId: string;
  retainedHistoryTurns?: number;
  readCutoffAfterConversationId?: number | null;
  compressionCoveredEndConversationId?: number | null;
  artifact?: Record<string, unknown> | null;
};

// Liveness snapshot for the (fire-and-forget, possibly >5min) compaction fork.
// Reuses findActiveCoreMemoryCompressionForkRun's 30-minute running-window, so
// `running: false` means "no fork running for this covered range" (done, failed,
// or never started) — a deliberately coarse v1 signal until liveness hardening.
type CoreMemoryCompressionForkStatusResult = {
  running: boolean;
  contextSessionKey: string;
  compressionCoveredEndConversationId: number;
  forkRunId?: string | null;
  runId?: string | null;
  startedAt?: string | null;
  status?: string | null;
};

type RecoverySessionHeartbeatState = {
  id: number | string;
};

type AgentLoopServiceOptions = {
  isRuntimeEnabled?: () => boolean | Promise<boolean>;
  isCacheHeartbeatPaused?: () => boolean | Promise<boolean>;
  getMainAgentPreModelYieldMs?: () => number | Promise<number>;
  onCoreMemoryCompressionCommitted?: (commit: CoreMemoryCompressionCommit) => void | Promise<void>;
  runtimePausePollMs?: number;
  preModelSliceYieldMs?: number;
  sleepMs?: (ms: number) => Promise<void>;
};

type AgentRuntimeIterationParams = {
  workerId: string;
  idleIntervalMs: number;
  sleepMs?: (ms: number) => Promise<void>;
};

export type AgentRuntimeLoopParams = AgentRuntimeIterationParams & {
  isStopping?: () => boolean;
  recoverStaleProcessingLeases?: () => Promise<void>;
  shouldReloadRuntimePrompt?: () => boolean | Promise<boolean>;
  onBusyChange?: (busy: boolean) => void;
  onRuntimeEnabledChange?: (enabled: boolean) => void;
  onRuntimeLoopError?: (error: unknown) => void;
  sleepMs?: (ms: number) => Promise<void>;
  bootstrapPromptPayload?: QueueMessageRecord['payload'];
};

type ProcessRuntimeFrameOptions = {
  queueBacked?: boolean;
  triggerInputMode?: RuntimeTriggerInputMode;
  appendRuntimeInputStackItem?: boolean;
  logQueueLifecycle?: boolean;
  initialLoopContinuation?: OpenResponseInputItem[];
  initialLoopContinuationBeforeCurrentTrigger?: boolean;
  recoveryWakeCountStartQueueMessageId?: number | null;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ProviderAgentResponse = {
  success: boolean;
  llm_call_id?: string;
  llm_request_slice_id?: string;
  response?: string;
  model?: string;
  provider?: string;
  canonical_response?: {
    id?: string;
    output?: Array<{
      type?: string;
      call_id?: string;
      role?: 'assistant' | 'user' | 'system';
      name?: string;
      arguments?: string;
      content?: string | Array<{
        type?: string;
        text?: string;
      }>;
      summary?: string | Array<Record<string, unknown>>;
      encrypted_content?: string;
      phase?: ConversationTranscriptPhase;
      status?: string;
    }>;
  };
  canonical_request?: Record<string, unknown>;
  wire_request?: Record<string, unknown>;
  wire_request_headers?: Record<string, unknown> | null;
  wire_request_url?: string | null;
  wire_response?: Record<string, unknown>;
  wire_response_headers?: Record<string, unknown> | null;
  wire_response_status?: number | null;
  wire_response_status_text?: string | null;
  raw_response?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  usage_details?: Record<string, unknown>;
  request_format_version?: string;
  wire_provider_format?: string;
  performance?: {
    processing_time_ms?: number;
  };
  error?: string;
};

type ContextBudgetTurnRecord = {
  turn: number;
  estimatedInputTokens: number;
  actualInputTokens: number | null;
  actualOutputTokens: number | null;
  actualTotalTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  processingTimeMs: number | null;
  readHistoryCount: number;
  readCutoffAfterConversationId: number | null;
  contextWindowTokens: number | null;
  targetBudgetTokens: number | null;
  hardBudgetTokens: number | null;
  tokenizerEncoding: string | null;
  tokenizerSource: 'tiktoken' | 'heuristic' | null;
  cutoffRecomputed: boolean;
};

type CoreMemoryCompressionPlan = {
  required: true;
  contextSessionKey: string;
  readCutoffAfterConversationId: number | null;
  previousReadCutoffAfterConversationId: number | null;
  compressionCoveredEndConversationId: number | null;
  historyUserId: number;
  historyGroupId: number | null;
  historyScope: 'global';
  lastContextWindowTokens: number;
  lastTargetBudgetTokens: number;
  lastHardBudgetTokens: number;
};

type CoreMemoryCompressionCheckpoint = {
  compression: CoreMemoryCompressionPlan;
  summarySourceInput: OpenResponseInputItem[];
};

type ContextBudgetPlan = {
  requestInput: OpenResponseInputItem[];
  // The current-turn input items built ONCE for this trigger. The sent request and
  // the runtime_input 存档 (persisted for next-run replay) both reuse this exact
  // array instead of each rebuilding it, so the cached bytes == the replayed bytes.
  currentTurnInputItems: OpenResponseInputItem[];
  selfContinuationInputItem: OpenResponseInputItem | null;
  summarySourceInput: OpenResponseInputItem[] | null;
  retainedHistory: ConversationTurn[];
  runtimeIdentityFacts: RuntimeIdentityFactProjection[];
  readCutoffAfterConversationId: number | null;
  previousReadCutoffAfterConversationId: number | null;
  estimatedInputTokens: number;
  contextWindowTokens: number | null;
  targetBudgetTokens: number | null;
  hardBudgetTokens: number | null;
  tokenizerEncoding: string | null;
  tokenizerSource: 'tiktoken' | 'heuristic' | null;
  cutoffRecomputed: boolean;
  contextSummary: string | null;
  pendingProactiveShare: string | null;
  pendingProactiveShareAge: number;
  coreMemoryCompression: CoreMemoryCompressionPlan | null;
};

type CoreMemoryCompressionCommit = {
  text: string;
  artifact: Record<string, unknown>;
  toolResult: Record<string, unknown>;
};

type CoreMemoryCompressionForkState = {
  promise: Promise<CoreMemoryCompressionCommit>;
  compression: CoreMemoryCompressionPlan;
  startedAtMs: number;
};


type UnreadMeaningTopicContext = {
  hasTopic: boolean;
  topicSummary: string | null;
  addressedToMe: boolean;
};

type UnreadMeaning = {
  latestUnreadFocus: string;
  messageAct: 'statement' | 'question' | 'joke' | 'tease' | 'feedback' | 'reaction' | 'request' | 'unclear';
  socialTarget: 'me' | 'someone_else' | 'group' | 'unclear';
  addressedToMe: boolean;
  hasRealNovelty: boolean;
  confidence: 'low' | 'medium' | 'high';
  reason: string;
  socialActType: UnreadMeaningSocialActType | null;
  topicContext: UnreadMeaningTopicContext | null;
};

type FeedbackReflectionCandidate = {
  shouldPersist: boolean;
  feedbackKind: 'positive' | 'negative' | 'mixed';
  confidence: 'low' | 'medium' | 'high';
  sourceUserScope: 'current_sender' | 'other' | 'group' | 'unknown';
  summaryText: string;
  retrievalText: string;
  reason: string;
};

type FeedbackReflectionSynthesis = {
  learningKey: string;
  learningScope: string;
  reflectionType: 'semantic_lesson' | 'social_lesson' | 'self_model_update';
  feedbackKind: 'positive' | 'negative' | 'mixed';
  confidence: 'low' | 'medium' | 'high';
  importanceScore: number;
  evidenceWeight: number;
  stabilityScore: number;
  summaryText: string;
  retrievalText: string;
  embeddingText: string;
  supersedeLatest: boolean;
  conflictGroupKey: string | null;
  reason: string;
};

type FeedbackLearningStateCandidate = {
  stateType: 'reinforced' | 'tentative' | 'conflicted' | 'revised';
  activationWeight: number;
  recencyWeight: number;
  importanceWeight: number;
  sourceWeight: number;
  conflictPenalty: number;
  activateNewReflection: boolean;
  reason: string;
};

type RuntimeTriggerInputMode = 'fresh_trigger' | 'suppress_current_trigger';

type FeedbackWriterMode = 'episode_only' | 'durable_lessons';
type CompactMemoryLayer = 'episodic' | 'semantic' | 'reflection';

type FeedbackWriterEvidence = {
  sourceMessageIds: number[];
  sourceConversationId: number | null;
  sourceUserId: number | null;
  sourceUserName: string | null;
  metadata: Record<string, unknown>;
  writerSource: typeof FEEDBACK_MEMORY_SUBAGENT_TYPE | typeof CONTEXT_COMPRESSION_MEMORY_SUBAGENT_TYPE;
};

type FeedbackMemorySubagentParams = {
  queueMessage: QueueMessageRecord['payload'];
  conversationId: number;
  history: ConversationTurn[];
  runtimePrompt: ResolvedAgentRuntimePrompt;
  xiaoniOs: string | null;
  deliveredMessages: string[];
  unreadMeaningArtifact: Record<string, unknown> | null;
};

type ContextCompressionMemoryParams = {
  queueMessage: QueueMessageRecord['payload'];
  conversationId: number;
  evictedTurns: ConversationTurn[];
  runtimePrompt: ResolvedAgentRuntimePrompt;
};

type PersistedMemoryObservation = {
  id: number;
  topic: string;
  text: string;
  participants: CompactMemoryParticipant[];
  xiaoniRole: string;
  sourceTurnIds: number[];
  sourceMessageIds: number[];
  createdAt?: string | Date | null;
};

type CompactMemoryParticipant = { qq_id: string; name: string };

type RuntimeIdentityFactProjection = {
  id: number;
  factKey: string;
  factText: string;
  factType: string;
  confidence: string;
  activationTags: string[];
};

const moduleLogger = logger.createModuleLogger('agent-loop-service');
const READ_HISTORY_TARGET_RATIO = 0.7;
const READ_HISTORY_HARD_RATIO = 0.95;
const HISTORY_COMPACT_KEEP = 30;
const FEEDBACK_MEMORY_SUBAGENT_TYPE = 'feedback_memory_writer';
const CONTEXT_COMPRESSION_MEMORY_SUBAGENT_TYPE = 'context_compression_memory_writer';
const CONTEXT_COMPRESSION_MEMORY_WRITER_ENABLED = false;
const COMPACT_MEMORY_PROVIDER_MAX_ATTEMPTS = 3;
export const XIAONI_IDENTITY_KEY = 'xiaoni';
const RUNTIME_IDENTITY_FACT_LIMIT = 4;
const XIAONI_SKILL_ROOT = '/app/modules/agent-service/skills';
const RUNTIME_MAX_ENERGY = 1;

function buildRuntimeBootstrapPromptPayload(): QueueMessageRecord['payload'] {
  const receivedAt = new Date().toISOString();
  const botAccountId = agentConfig.botAccountId;
  const globalPromptContextSessionKey = getGlobalPromptContextSessionKey();
  const inboundContext: QueueMessageRecord['payload']['inboundContext'] = {
    Body: '',
    BodyForAgent: '',
    BodyForCommands: '',
    RawBody: '',
    CommandBody: '',
    From: botAccountId,
    To: botAccountId,
    SessionKey: globalPromptContextSessionKey,
    AccountId: botAccountId,
    ChatType: 'direct',
    ConversationLabel: XIAONI_IDENTITY_KEY,
    SenderName: XIAONI_IDENTITY_KEY,
    SenderId: botAccountId,
    Timestamp: Date.now(),
    Provider: 'runtime',
    Surface: 'runtime_bootstrap',
    WasMentioned: false,
    NativeChannelId: globalPromptContextSessionKey,
    CommandAuthorized: false
  };

  return {
    traceId: 'runtime_bootstrap',
    runId: 'runtime_bootstrap',
    batchId: 'runtime_bootstrap',
    source: 'runtime_bootstrap',
    chatType: 'direct',
    sessionKey: globalPromptContextSessionKey,
    peerId: XIAONI_IDENTITY_KEY,
    peerName: XIAONI_IDENTITY_KEY,
    senderId: botAccountId,
    senderName: XIAONI_IDENTITY_KEY,
    accountId: botAccountId,
    bodyForAgent: '',
    rawBody: '',
    commandBody: '',
    wasMentioned: false,
    receivedAt,
    messageTimestamp: null,
    rawPayload: {
      source: 'runtime_bootstrap'
    },
    inboundContext,
    messages: []
  };
}

function buildRuntimeLoopFrameQueueMessage(): QueueMessageRecord {
  const now = new Date();
  const id = uuidv4().slice(0, 8);
  const frameId = `runtime_${now.getTime()}_${id}`;
  const bootstrapPayload = buildRuntimeBootstrapPromptPayload();
  const payload: QueueMessageRecord['payload'] = {
    ...bootstrapPayload,
    traceId: `runtrace_${frameId}`,
    runId: frameId,
    batchId: `runtime_batch_${now.getTime()}_${id}`,
    source: 'runtime_loop',
    receivedAt: now.toISOString(),
    rawPayload: {
      source: 'runtime_loop'
    },
    inboundContext: {
      ...bootstrapPayload.inboundContext,
      Timestamp: now.getTime(),
      Surface: 'runtime_loop'
    }
  };

  return {
    id: frameId,
    traceId: payload.traceId,
    batchId: payload.batchId,
    status: 'processing',
    attempts: 0,
    createdAt: now.toISOString(),
    queueMessageIds: [],
    payload
  };
}

function normalizeRuntimeFrameOptions(options: ProcessRuntimeFrameOptions = {}): {
  queueBacked: boolean;
  triggerInputMode: RuntimeTriggerInputMode;
  appendRuntimeInputStackItem: boolean;
  logQueueLifecycle: boolean;
  initialLoopContinuation: OpenResponseInputItem[];
  initialLoopContinuationBeforeCurrentTrigger: boolean;
  recoveryWakeCountStartQueueMessageId?: number | null;
} {
  const queueBacked = options.queueBacked !== false;
  return {
    queueBacked,
    triggerInputMode: options.triggerInputMode ?? (queueBacked ? 'fresh_trigger' : 'suppress_current_trigger'),
    appendRuntimeInputStackItem: options.appendRuntimeInputStackItem ?? queueBacked,
    logQueueLifecycle: options.logQueueLifecycle ?? queueBacked,
    initialLoopContinuation: options.initialLoopContinuation ?? [],
    initialLoopContinuationBeforeCurrentTrigger: options.initialLoopContinuationBeforeCurrentTrigger ?? false,
    recoveryWakeCountStartQueueMessageId: options.recoveryWakeCountStartQueueMessageId
  };
}

const TOOL_NAMES = {
  unreadMeaning: 'emit_unread_meaning',
  inspectImage: 'inspect_image_placeholder',
  imageTask: 'request_image_task',
  feedbackReflection: 'synthesize_feedback_reflection',
  feedbackLearningState: 'update_learning_state',
  execCommand: 'exec_command',
  privateReply: 'send_in_private',
  groupReply: 'send_in_group',
  recoverEnergy: 'recover_energy',
  compressCoreMemory: 'compress_core_memory'
} as const;

const RUNTIME_TOOL_COSTS: Record<string, number> = {
  [TOOL_NAMES.groupReply]: 0.015,
  [TOOL_NAMES.privateReply]: 0.015,
  web_search: 0.080,
  [TOOL_NAMES.inspectImage]: 0.040,
  [TOOL_NAMES.imageTask]: 0.030,
  [TOOL_NAMES.execCommand]: 0.002,
  [TOOL_NAMES.recoverEnergy]: 0.000,
  [TOOL_NAMES.compressCoreMemory]: 0.020
};

const RUNTIME_SKILL_COSTS: Record<string, number | null> = {
  'skill-creator': 0.002,
  'qq-usage': 0.002,
  'qq-send-image': 0.002,
  'xiaoni-site': 0.002,
  'xiaoni-browser': 0.004
};

const WEB_SEARCH_TOOL: OpenResponseToolDefinition = {
  type: 'web_search',
  search_context_size: agentConfig.webSearchContextSize,
  external_web_access: agentConfig.webSearchExternalAccess
};

const IMAGE_GENERATION_TOOL: OpenResponseToolDefinition = {
  type: 'image_generation',
  model: 'gpt-image-2',
  output_format: 'png',
  size: 'auto',
  quality: 'auto',
  background: 'auto'
};

const IMAGE_VISION_FORK_SENTINEL = '让我来看看这个图是啥意思';
const MEDIA_ASSET_ID_PATTERN = /^media_[a-zA-Z0-9_-]+$/;
const NO_TRAFFIC_PERSIST_HEADER = 'x-qqbot-no-traffic-persist';
const CORE_MEMORY_COMPRESSION_FORK_MAX_NO_TOOL_RETRIES = 10;
const SUBCONSCIOUS_AGENT_FORK_MAX_TOOL_CALLS = 5;
const SUBCONSCIOUS_AGENT_FORK_MAX_MODEL_SLICES = SUBCONSCIOUS_AGENT_FORK_MAX_TOOL_CALLS + 1;
const CACHE_HEARTBEAT_EXECUTION_MODE = 'cache_heartbeat_no_persist';
const CACHE_HEARTBEAT_DEVELOPER_CONTENT = [
  'Heartbeat.',
  'Cache maintenance only; do not call tools.',
  'Return exactly: 1'
].join(' ');

const EXEC_COMMAND_DESCRIPTION = [
  'Runs a command in a PTY, returning output or a session ID for ongoing interaction.',
  'Use /app as the filesystem root for repository paths.',
  'qqbot-agent-service / compose service agent-service is you. Touching that container is suicide: you may inspect it, but you must not modify it.'
].join(' ');

const EXEC_COMMAND_TOOL: OpenResponseToolDefinition = {
  type: 'function',
  name: TOOL_NAMES.execCommand,
  description: EXEC_COMMAND_DESCRIPTION,
  strict: false,
  function: {
    name: TOOL_NAMES.execCommand,
    description: EXEC_COMMAND_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        cmd: {
          type: 'string',
          description: 'Shell command to execute.'
        },
        justification: {
          type: 'string',
          description: 'Only set if sandbox_permissions is "require_escalated". Request approval from the user to run this command outside the sandbox. Phrased as a simple question that summarizes the purpose of the command as it relates to the task at hand.'
        },
        login: {
          type: 'boolean',
          description: 'Whether to run the shell with -l/-i semantics. Defaults to true.'
        },
        max_output_tokens: {
          type: 'number',
          description: 'Maximum number of tokens to return. Excess output will be truncated.'
        },
        prefix_rule: {
          type: 'array',
          description: 'Only specify when sandbox_permissions is `require_escalated`. Suggest a prefix command pattern that will allow you to fulfill similar requests from the user in the future.',
          items: {
            type: 'string'
          }
        },
        sandbox_permissions: {
          type: 'string',
          description: 'Sandbox permissions for the command. Set to "require_escalated" to request running without sandbox restrictions; defaults to "use_default".'
        },
        shell: {
          type: 'string',
          description: "Shell binary to launch. Defaults to the user's default shell."
        },
        tty: {
          type: 'boolean',
          description: 'Whether to allocate a TTY for the command. Defaults to false (plain pipes); set to true to open a PTY and access TTY process.'
        },
        workdir: {
          type: 'string',
          description: 'Optional working directory to run the command in; defaults to the turn cwd.'
        },
        yield_time_ms: {
          type: 'number',
          description: 'How long to wait (in milliseconds) for output before yielding.'
        }
      },
      required: ['cmd'],
      additionalProperties: false
    }
  }
};

const COMPRESS_CORE_MEMORY_TOOL = {
  type: 'function',
  function: {
    name: TOOL_NAMES.compressCoreMemory,
    description: '【紧急生存工具】仅当 system_reminder 提示脑容量达到极限或必须压缩时强制调用。用于打包并留下你认为值得带往未来的记忆，防止意识彻底重启。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '小腻的私人记忆胶囊。存什么、存多少、以什么视角存，完全由小腻当下的主观意识和偏好决定。'
        }
      },
      required: ['text'],
      additionalProperties: false
    }
  }
} as const;

const HUMAN_REPLY_RULES = [
  '只发送群友能直接看到的话，不写工具名、阶段名或分析过程。',
  'message/messages 必须来自当前可见消息、工具结果或 proactive 材料；不要重复旧话。',
  '一句话够用就短句收住；不要为了延长场面补解释。'
] as const;

const GROUP_MENTION_RULES = [
  'mention_user_ids 只在你确实是在自然点名某个人、回应某个人、或者要把某个人拉进当前话题时使用。',
  '让每个 @ 都对应真实的指向，比如点名回应、转向某个人，或把某个人带进当前话题。',
  '如果不用 @ 也能看懂你在回谁，就不要 @。'
] as const;

const PRIVATE_MESSAGE_TOOL = {
  type: 'function',
  function: {
    name: TOOL_NAMES.privateReply,
    description: '向明确指定的 QQ 用户发送一条或多条 QQ 消息。必须提供 user_id。',
    parameters: {
      type: 'object',
      properties: {
        user_id: {
          type: 'integer',
          description: '必填。要发送到的 QQ 用户 ID。'
        },
        message: { type: 'string' },
        messages: {
          type: 'array',
          items: { type: 'string' }
        },
        xiaoni_os: {
          type: 'string',
          description: '留给后续自己的备注：当前看见的事实、自己的反应、未解决的信息缺口。不发给对方。'
        },
        pending_share: {
          type: 'string',
          description: '如果你有个想法或发现想找机会主动说出来，写在这里带到之后的上下文里。可选，不用硬填。'
        }
      },
      required: ['user_id', 'xiaoni_os'],
      additionalProperties: false
    }
  }
} as const;

const GROUP_MESSAGE_TOOL = {
  type: 'function',
  function: {
    name: TOOL_NAMES.groupReply,
    description: '向明确指定的 QQ 群发送一条或多条消息，可选指定需要 @ 的成员。必须提供 group_id。',
    parameters: {
      type: 'object',
      properties: {
        group_id: {
          type: 'integer',
          description: '必填。要发送到的 QQ 群号。'
        },
        message: { type: 'string' },
        messages: {
          type: 'array',
          items: { type: 'string' }
        },
        mention_user_ids: {
          type: 'array',
          items: { type: 'integer' }
        },
        xiaoni_os: {
          type: 'string',
          description: '留给后续自己的备注：当前看见的事实、自己的反应、未解决的信息缺口。不发给任何人。'
        },
        pending_share: {
          type: 'string',
          description: '如果你有个想法或发现想找机会主动说出来，写在这里带到之后的上下文里。可选，不用硬填。'
        }
      },
      required: ['group_id', 'xiaoni_os'],
      additionalProperties: false
    }
  }
} as const;

const INSPECT_IMAGE_TOOL = {
  type: 'function',
  function: {
    name: TOOL_NAMES.inspectImage,
    description: '读取当前上下文中图片占位符对应的真实图片。优先填写 image_id（agent_media_assets.id）；只有旧上下文没有 image_id 时才用 media_tag 兼容查找。',
    parameters: {
      type: 'object',
      properties: {
        image_id: {
          type: 'string',
          description: '优先使用的图片真实 id，即 agent_media_assets.id。'
        },
        media_tag: {
          type: 'string',
          description: '兼容旧上下文的占位符标签 fallback；最终回填仍使用真实 image id。'
        },
        reason: { type: 'string' }
      },
      required: ['reason'],
      additionalProperties: false
    }
  }
} as const;

const IMAGE_TASK_TOOL = {
  type: 'function',
  function: {
    name: TOOL_NAMES.imageTask,
    description: '提交一次图片生成或编辑请求；提交请求本身不等于已经对聊天对象发言。没有可用原图时走生成；只有 source_media_tags 指向可读图片时才走编辑。',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['generate', 'edit'],
          description: 'generate 用于从文字生成新图；edit 只用于基于当前上下文里的原图改图。'
        },
        prompt: { type: 'string' },
        target_description: { type: 'string' },
        source_media_tags: {
          type: 'array',
          items: { type: 'string' },
          description: '编辑原图时填写当前上下文里的图片真实 id；旧上下文没有 id 时可填 media tag。纯生成图片时留空。'
        },
        xiaoni_os: {
          type: 'string',
          description: '留给后续自己的备注：图片请求和相关信息缺口。不发给任何人。'
        }
      },
      required: ['operation', 'prompt', 'target_description', 'xiaoni_os'],
      additionalProperties: false
    }
  }
} as const;

const RECOVER_ENERGY_TOOL = {
  type: 'function',
  function: {
    name: TOOL_NAMES.recoverEnergy,
    description: '闭目养神，休息恢复精力。你不需要去预测自己会睡多久：不设 clock 时，身体本能和昼夜节律会决定你是短暂打盹还是睡到自然醒。clock 仅仅代表你心里定下的短闹钟，想在几分钟或几十分钟后叫醒自己起来继续干活；它不是完整睡眠时长，也不是夜间 8 小时睡眠的闹铃。如果你透支得太狠，身体出于自我保护会屏蔽闹钟，直到恢复到及格线以上才会让你醒来。注意：身体有自己的节律，如果你当前精力充沛却频繁试图强行闭眼休息，你根本睡不着，潜意识会直接拒绝这次休眠（导致失眠）。',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: '此刻决定休息的真实原因。记录你当下的感受（比如“冲浪太久累了”或“觉得无聊睡一觉”），绝对不要写“睡30分钟”这种计划时长的废话。'
        },
        xiaoni_os: {
          type: 'string',
          description: '睡前留给自己的私密备忘：醒来后想接着干嘛、有什么未完成的执念，或者单纯是对当下疲惫状态的吐槽。这只是你的脑内残影，绝不会发给任何人。'
        },
        clock: {
          type: 'integer',
          minimum: 5,
          maximum: RECOVER_ENERGY_CLOCK_MAX_MINUTES,
          description: '可选。给自己定的短闹钟（可以是几分钟，也可以是几十分钟后，最长 120 分钟）。它代表“几分钟后闹钟响”，用于中途起来继续干活，绝对不是你想睡的总时长。不填则表示彻底放空，顺其自然睡到身体和昼夜节律允许醒来。'
        }
      },
      required: ['reason', 'xiaoni_os'],
      additionalProperties: false
    }
  }
} as const;

const UNREAD_MEANING_TOOL = {
  type: 'function',
  function: {
    name: TOOL_NAMES.unreadMeaning,
    description: '提取当前新入站消息的语义重点、社交目标和消息动作。',
    parameters: {
      type: 'object',
      properties: {
        latest_unread_focus: {
          type: 'string'
        },
        message_act: {
          type: 'string',
          enum: ['statement', 'question', 'joke', 'tease', 'feedback', 'reaction', 'request', 'unclear']
        },
        social_target: {
          type: 'string',
          enum: ['me', 'someone_else', 'group', 'unclear']
        },
        addressed_to_me: {
          type: 'boolean'
        },
        has_real_novelty: {
          type: 'boolean'
        },
        confidence: {
          type: 'string',
          enum: ['low', 'medium', 'high']
        },
        reason: {
          type: 'string'
        },
        social_act_type: {
          type: 'string',
          enum: ['invitation_curiosity', 'emotional_release', 'relationship_probe', 'concrete_request', 'yes_no_reaction', 'casual_remark'],
          description: '消息对应的社交动作类型。仅当 addressed_to_me=true 时填写；说给别人的消息不填。invitation_curiosity=邀请好奇，emotional_release=释放情绪，relationship_probe=试探关系，concrete_request=具体请求，yes_no_reaction=问是否，casual_remark=随口一提'
        },
        topic_context: {
          type: 'object',
          properties: {
            has_topic: {
              type: 'boolean',
              description: '当前消息是否在讨论某个具体话题'
            },
            topic_summary: {
              type: 'string',
              description: '话题的一句话概括，用于判断是否感兴趣或需要先搜索。has_topic=false 时可省略'
            },
            addressed_to_me: {
              type: 'boolean',
              description: '话题是否明确说给小腻的'
            }
          },
          required: ['has_topic', 'addressed_to_me'],
          additionalProperties: false
        }
      },
      required: ['latest_unread_focus', 'message_act', 'social_target', 'addressed_to_me', 'has_real_novelty', 'confidence', 'reason', 'topic_context'],
      additionalProperties: false
    }
  }
} as const;

const FEEDBACK_REFLECTION_SYNTHESIS_TOOL = {
  type: 'function',
  function: {
    name: TOOL_NAMES.feedbackReflection,
    description: [
      '在上下文压缩时，把这批即将移出上下文的对话里真正值得长期保留的内容提炼成一条 append-only reflection。',
      '默认是叠加，不是覆盖；只有明确是同题新结论时，才表明 supersede 或 conflict。'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        learning_key: {
          type: 'string'
        },
        learning_scope: {
          type: 'string'
        },
        reflection_type: {
          type: 'string',
          enum: ['semantic_lesson', 'social_lesson', 'self_model_update']
        },
        feedback_kind: {
          type: 'string',
          enum: ['positive', 'negative', 'mixed']
        },
        confidence: {
          type: 'string',
          enum: ['low', 'medium', 'high']
        },
        importance_score: {
          type: 'number'
        },
        evidence_weight: {
          type: 'number'
        },
        stability_score: {
          type: 'number'
        },
        summary_text: {
          type: 'string'
        },
        retrieval_text: {
          type: 'string'
        },
        embedding_text: {
          type: 'string'
        },
        supersede_latest: {
          type: 'boolean'
        },
        conflict_group_key: {
          type: ['string', 'null']
        },
        reason: {
          type: 'string'
        }
      },
      required: ['learning_key', 'learning_scope', 'reflection_type', 'feedback_kind', 'confidence', 'importance_score', 'evidence_weight', 'stability_score', 'summary_text', 'retrieval_text', 'embedding_text', 'supersede_latest', 'conflict_group_key', 'reason'],
      additionalProperties: false
    }
  }
} as const;

const FEEDBACK_LEARNING_STATE_TOOL = {
  type: 'function',
  function: {
    name: TOOL_NAMES.feedbackLearningState,
    description: [
      '根据新 reflection 和同题当前状态，更新 learning_state。',
      '默认叠加；只有同题新结论才 revised 或 conflicted。'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        state_type: {
          type: 'string',
          enum: ['reinforced', 'tentative', 'conflicted', 'revised']
        },
        activation_weight: {
          type: 'number'
        },
        recency_weight: {
          type: 'number'
        },
        importance_weight: {
          type: 'number'
        },
        source_weight: {
          type: 'number'
        },
        conflict_penalty: {
          type: 'number'
        },
        activate_new_reflection: {
          type: 'boolean'
        },
        reason: {
          type: 'string'
        }
      },
      required: ['state_type', 'activation_weight', 'recency_weight', 'importance_weight', 'source_weight', 'conflict_penalty', 'activate_new_reflection', 'reason'],
      additionalProperties: false
    }
  }
} as const;

const MEMORY_EPISODIC_TOOL = {
  type: 'function',
  function: {
    name: 'write_episodic_observations',
    description: 'Write short Xiaoni-colored observations from evicted group-chat turns. Empty observations are valid when nothing is worth remembering.',
    parameters: {
      type: 'object',
      properties: {
        observations: {
          type: 'array',
          minItems: 0,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              topic: { type: 'string' },
              text: { type: 'string' },
              poignancy: { type: 'integer', minimum: 1, maximum: 10 },
              participants: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  properties: {
                    qq_id: { type: 'string' },
                    name: { type: 'string' }
                  },
                  required: ['qq_id', 'name'],
                  additionalProperties: false
                }
              },
              xiaoni_role: {
                type: 'string',
                enum: ['speaker', 'directly_addressed', 'mentioned_or_evaluated', 'bystander', 'not_involved']
              },
              source_turn_ids: {
                type: 'array',
                minItems: 1,
                items: { type: 'integer' }
              }
            },
            required: ['topic', 'text', 'poignancy', 'participants', 'xiaoni_role', 'source_turn_ids'],
            additionalProperties: false
          }
        }
      },
      required: ['observations'],
      additionalProperties: false
    }
  }
} as const;

const MEMORY_SEMANTIC_TOOL = {
  type: 'function',
  function: {
    name: 'write_semantic_assertions',
    description: [
      'Write objective facts, states, plans, and claims from evicted group-chat turns.',
      'Preserve who stated/owns the assertion and who/what it is about; do not collapse identifiable speakers into "the group" or "someone".',
      'Empty assertions are valid.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        assertions: {
          type: 'array',
          minItems: 0,
          maxItems: 16,
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              fact_type: {
                type: 'string',
                enum: ['stable_fact', 'current_status', 'one_time_event', 'stated_plan', 'claim']
              },
              scope: {
                type: 'string',
                enum: ['person', 'dyad', 'group', 'topic', 'system_state', 'self_continuity'],
                description: '断言适用范围。只有确实是群体共同事实时才用 group；可识别到说话人时优先 person/dyad/topic。'
              },
              owners: {
                type: 'array',
                minItems: 0,
                maxItems: 4,
                description: '谁说出、持有或负责这个断言。能识别说话人时必须填写，不要用“群里/有人”。',
                items: {
                  type: 'object',
                  properties: {
                    qq_id: { type: 'string' },
                    name: { type: 'string' }
                  },
                  required: ['qq_id', 'name'],
                  additionalProperties: false
                }
              },
              directed_to: {
                type: 'array',
                minItems: 0,
                maxItems: 4,
                description: '这个断言当时明确说给谁。没有明确对象就空数组。',
                items: {
                  type: 'object',
                  properties: {
                    qq_id: { type: 'string' },
                    name: { type: 'string' }
                  },
                  required: ['qq_id', 'name'],
                  additionalProperties: false
                }
              },
              entities: {
                type: 'array',
                minItems: 1,
                maxItems: 5,
                items: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: ['person', 'project', 'concept', 'place', 'url', 'other'] },
                    value: { type: 'string' }
                  },
                  required: ['kind', 'value'],
                  additionalProperties: false
                }
              },
              participants: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  properties: {
                    qq_id: { type: 'string' },
                    name: { type: 'string' }
                  },
                  required: ['qq_id', 'name'],
                  additionalProperties: false
                }
              },
              evidence_summary: {
                type: 'string',
                description: '一句话说明这个断言来自哪段可见文本。必须保留说话人/对象，不写内部推理。'
              },
              xiaoni_relevance: {
                type: 'string',
                enum: ['participation_judgment', 'direct_feedback', 'relationship_context', 'topic_knowledge', 'none'],
                description: '这条断言对小腻保持自己或之后召回的关系。不是行为指令。'
              },
              source_turn_ids: {
                type: 'array',
                minItems: 1,
                items: { type: 'integer' }
              }
            },
            required: ['text', 'fact_type', 'scope', 'owners', 'directed_to', 'entities', 'participants', 'evidence_summary', 'xiaoni_relevance', 'source_turn_ids'],
            additionalProperties: false
          }
        }
      },
      required: ['assertions'],
      additionalProperties: false
    }
  }
} as const;

const MEMORY_REFLECTION_TOOL = {
  type: 'function',
  function: {
    name: 'write_memory_reflections',
    description: [
      'Synthesize cross-time abstractions from recently written episodic observations.',
      'Reflections preserve person/dyad/self continuity; group-level reflections are only valid when evidence is truly group-wide.',
      'Do not write behavior instructions for Xiaoni. Empty reflections are valid when evidence is insufficient.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        reflections: {
          type: 'array',
          minItems: 0,
          maxItems: 5,
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              kind: { type: 'string', enum: ['person_pattern', 'dyad_pattern', 'group_norm', 'project_arc', 'self_continuity', 'xiaoni_perception'] },
              subjects: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } },
              subject_participants: {
                type: 'array',
                minItems: 0,
                maxItems: 5,
                items: {
                  type: 'object',
                  properties: {
                    qq_id: { type: 'string' },
                    name: { type: 'string' }
                  },
                  required: ['qq_id', 'name'],
                  additionalProperties: false
                }
              },
              object_participants: {
                type: 'array',
                minItems: 0,
                maxItems: 5,
                description: '关系或评价指向的对象，例如小腻或另一个群友。没有明确对象就空数组。',
                items: {
                  type: 'object',
                  properties: {
                    qq_id: { type: 'string' },
                    name: { type: 'string' }
                  },
                  required: ['qq_id', 'name'],
                  additionalProperties: false
                }
              },
              evidence_basis: {
                type: 'string',
                enum: ['explicit_feedback', 'xiaoni_sayable_points', 'repeated_interactions', 'repeated_group_events']
              },
              evidence_summary: {
                type: 'string',
                description: '说明至少两条 observation 如何支持这个抽象。必须点出持续的主体，不写“群里都怎样”这种泛化。'
              },
              self_continuity_note: {
                type: 'string',
                description: '这条 reflection 对小腻保持自己的含义：她怎么看自己、别人怎么看她、她对某事的稳定关注点。不是未来行为指令。'
              },
              evidence_time_start: { type: 'string' },
              evidence_time_end: { type: 'string' },
              poignancy: { type: 'integer', minimum: 1, maximum: 10 },
              source_observation_ids: { type: 'array', minItems: 2, items: { type: 'integer' } }
            },
            required: ['text', 'kind', 'subjects', 'subject_participants', 'object_participants', 'evidence_basis', 'evidence_summary', 'self_continuity_note', 'evidence_time_start', 'evidence_time_end', 'poignancy', 'source_observation_ids'],
            additionalProperties: false
          }
        }
      },
      required: ['reflections'],
      additionalProperties: false
    }
  }
} as const;

const COMPACT_MEMORY_TOOL_BY_LAYER = {
  episodic: MEMORY_EPISODIC_TOOL,
  semantic: MEMORY_SEMANTIC_TOOL,
  reflection: MEMORY_REFLECTION_TOOL
} as const;

const COMPACT_MEMORY_TOOL_NAME_BY_LAYER = {
  episodic: 'write_episodic_observations',
  semantic: 'write_semantic_assertions',
  reflection: 'write_memory_reflections'
} as const;

function readPromptSnippet(fileName: string) {
  return readXiaoniPromptFile(fileName).trimEnd();
}

function renderPromptSnippet(fileName: string, variables: Record<string, string | number | null | undefined> = {}) {
  return renderXiaoniPromptTemplate(fileName, variables).trimEnd();
}

function renderPromptTemplateText(template: string, variables: Record<string, string | number | null | undefined> = {}) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
    const value = variables[key];
    return value === null || value === undefined ? match : String(value);
  });
}

function removePlaceholderOnlyLines(template: string, placeholders: string[]) {
  const placeholderLines = new Set(placeholders.map((placeholder) => `{{${placeholder}}}`));
  return template
    .split('\n')
    .filter((line) => !placeholderLines.has(line.trim()))
    .join('\n');
}

function buildSkillsInstructions() {
  return renderPromptSnippet('skills_instructions.md', {
    XIAONI_SKILL_ROOT
  });
}

export function buildCapabilitiesDeveloperBlock(input: {
  toolCosts?: Record<string, number>;
  skillCosts?: Record<string, number | null | undefined>;
} = {}) {
  const toolCosts = input.toolCosts || RUNTIME_TOOL_COSTS;
  const skillCosts = input.skillCosts || RUNTIME_SKILL_COSTS;
  const toolLines = Object.keys(toolCosts)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => `- ${name}`);
  const skillLines: string[] = [];
  const warnings: string[] = [];
  for (const [name, cost] of Object.entries(skillCosts).sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof cost !== 'number' || !Number.isFinite(cost)) {
      warnings.push(`skill ${name} omitted from <CAPABILITIES>: missing ## Runtime Cost energy_cost`);
      continue;
    }
    skillLines.push(`- ${name}`);
  }
  const block = [
    '<CAPABILITIES>',
    '<TOOLS>',
    ...toolLines,
    '</TOOLS>',
    '<SKILLS>',
    ...(skillLines.length > 0 ? skillLines : ['- none']),
    '</SKILLS>',
    '</CAPABILITIES>'
  ].join('\n');
  return { block, warnings };
}

function isPrivateReplyToolName(name: string) {
  return name === TOOL_NAMES.privateReply;
}

function isGroupReplyToolName(name: string) {
  return name === TOOL_NAMES.groupReply;
}

function isSpeakingToolName(name: string) {
  return isPrivateReplyToolName(name) || isGroupReplyToolName(name);
}

function isToolCallSideEffecting(toolCall: Pick<AgentToolCall, 'name' | 'args'>) {
  if (isSpeakingToolName(toolCall.name) || toolCall.name === TOOL_NAMES.imageTask) {
    return true;
  }
  return false;
}

function hasToolReplay(loopInput: OpenResponseInputItem[], toolName: string) {
  return loopInput.some((item) => item.type === 'function_call' && item.name === toolName);
}

function buildAllowedToolsToolChoice(
  tools: Array<{ type: 'function'; name: string } | { type: 'web_search' } | { type: 'image_generation' }>,
  mode: 'auto' | 'required' = 'required'
): OpenResponseToolChoice {
  return {
    type: 'allowed_tools',
    mode,
    tools
  };
}

function buildImageGenerationAllowedToolsToolChoice(): OpenResponseToolChoice {
  return buildAllowedToolsToolChoice([{ type: 'image_generation' }], 'required');
}

const EAST8_OFFSET_MS = 8 * 60 * 60 * 1000;

// Historical normalization only: persisted stack items written before runtime
// time stamping was removed still carry a [当前时间: ...] prefix. We no longer ADD
// these synthetic "current time" stamps to system_reminders, but
// stripRuntimeTextEast8TimePrefix keeps replay/extraction of that legacy content
// clean. Do not reintroduce a stamp-add path here.
const RUNTIME_TIME_PREFIX_PATTERN = /^\[当前时间: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\n?/;
const LEGACY_EAST8_TIME_PREFIX_PATTERN = /^\[当前时间 东八区: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC\+08:00\]\n?/;

function padTwoDigits(value: number) {
  return String(value).padStart(2, '0');
}

// Formats a concrete event timestamp (e.g. when a tool completed or a message
// arrived) in East-8. This is NOT the removed synthetic "current time" reminder
// stamp — it renders real per-event times in conversation/timeline history.
export function formatEast8Timestamp(now: Date = new Date()) {
  const timestamp = now instanceof Date ? now.getTime() : Number.NaN;
  const date = new Date((Number.isFinite(timestamp) ? timestamp : Date.now()) + EAST8_OFFSET_MS);
  return [
    `${date.getUTCFullYear()}-${padTwoDigits(date.getUTCMonth() + 1)}-${padTwoDigits(date.getUTCDate())}`,
    `${padTwoDigits(date.getUTCHours())}:${padTwoDigits(date.getUTCMinutes())}:${padTwoDigits(date.getUTCSeconds())}`
  ].join(' ');
}

export function stripRuntimeTextEast8TimePrefix(text: string) {
  return String(text || '')
    .trim()
    .replace(RUNTIME_TIME_PREFIX_PATTERN, '')
    .replace(LEGACY_EAST8_TIME_PREFIX_PATTERN, '')
    .trim();
}

function orderRuntimeToolCalls(toolCalls: ReplayableToolCallOutput[]): ReplayableToolCallOutput[] {
  const recoverCalls: ReplayableToolCallOutput[] = [];
  const otherCalls: ReplayableToolCallOutput[] = [];
  for (const item of toolCalls) {
    if (item.toolCall.name === TOOL_NAMES.recoverEnergy) {
      recoverCalls.push(item);
    } else {
      otherCalls.push(item);
    }
  }
  return recoverCalls.length > 0 ? [...otherCalls, ...recoverCalls] : toolCalls;
}

function normalizePreSleepToolTimelineEntries(value: unknown): PreSleepToolTimelineEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): PreSleepToolTimelineEntry[] => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const callId = typeof record.call_id === 'string' ? record.call_id : '';
    const name = typeof record.name === 'string' ? record.name : '';
    const completedAt = typeof record.completed_at === 'string' ? record.completed_at : '';
    const status = record.status === 'failed' ? 'failed' : 'completed';
    if (!callId || !name || !completedAt) {
      return [];
    }
    return [{ call_id: callId, name, completed_at: completedAt, status }];
  });
}

function renderRecoverEnergyBatchFinalTimeline(input: {
  metadata?: Record<string, unknown> | null;
  recoveryStartedAt: Date;
}) {
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  const batchFinalRecovery = metadata.batch_final_recovery && typeof metadata.batch_final_recovery === 'object'
    ? metadata.batch_final_recovery as Record<string, unknown>
    : null;
  if (!batchFinalRecovery) {
    return '';
  }
  const entries = normalizePreSleepToolTimelineEntries(batchFinalRecovery.pre_sleep_tool_calls);
  if (entries.length === 0) {
    return '';
  }
  const lines = entries.map((entry, index) => {
    const completedAt = new Date(entry.completed_at);
    const completedAtText = Number.isFinite(completedAt.getTime())
      ? formatEast8Timestamp(completedAt)
      : entry.completed_at;
    const statusText = entry.status === 'failed' ? '失败并已把错误返回给你' : '完成';
    return `${index + 1}. ${completedAtText}：${entry.name} ${statusText}`;
  }).join('\n');
  const recoveryStartedAt = typeof batchFinalRecovery.recovery_started_at === 'string'
    ? new Date(batchFinalRecovery.recovery_started_at)
    : input.recoveryStartedAt;
  return renderPromptSnippet('recover_energy_batch_final_timeline.md', {
    PRE_SLEEP_TOOL_COUNT: entries.length,
    PRE_SLEEP_TOOL_LINES: lines,
    RECOVERY_STARTED_AT: formatEast8Timestamp(
      Number.isFinite(recoveryStartedAt.getTime()) ? recoveryStartedAt : input.recoveryStartedAt
    )
  });
}

function normalizeRuntimeEnergy(value: unknown, fallback = RUNTIME_MAX_ENERGY) {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function legacyRecoverySessionPolicy(): RecoverySessionPolicy {
  const fullRecoveryMinutes = recoverEnergyFullRecoveryMinutes(LEGACY_RECOVER_ENERGY_POLICY);
  return {
    version: LEGACY_RECOVER_ENERGY_POLICY_VERSION,
    policy: LEGACY_RECOVER_ENERGY_POLICY,
    circadian: resolveRecoveryCircadianState(new Date(0), LEGACY_RECOVER_ENERGY_POLICY),
    fullRecoveryMinutes,
    sessionMaxRecoveryMinutes: fullRecoveryMinutes,
    sessionCapWakeCause: 'hard_cap'
  };
}

function recoverySessionPolicyFromMetadata(metadata: unknown): RecoverySessionPolicy {
  const normalized = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return recoverySessionPolicyFromSnapshot(normalized.recovery_policy_snapshot) ?? legacyRecoverySessionPolicy();
}

export function recoverRuntimeEnergy(input: {
  rawEnergy: number;
  elapsedMs: number;
  maxEnergy?: number;
}) {
  const maxEnergy = Math.max(0.001, normalizeRuntimeEnergy(input.maxEnergy, RUNTIME_MAX_ENERGY));
  const rawEnergy = normalizeRuntimeEnergy(input.rawEnergy, maxEnergy);
  const elapsedMs = Math.max(0, normalizeRuntimeEnergy(input.elapsedMs, 0));
  const projected = projectRecoverySession({
    startEnergy: rawEnergy,
    maxEnergy,
    startedAt: new Date(0),
    now: new Date(elapsedMs),
    sessionMaxRecoveryMinutes: recoverEnergyFullRecoveryMinutes(DEFAULT_RECOVER_ENERGY_POLICY),
    sessionCapWakeCause: 'hard_cap'
  });
  return {
    rawEnergyBefore: rawEnergy,
    startEnergy: rawEnergy,
    energy: projected.energy,
    maxEnergy,
    debt: rawEnergy < 0 ? Math.abs(rawEnergy) : 0,
    elapsedMs,
    fullRecoveryMs: recoverEnergyFullRecoveryMinutes(DEFAULT_RECOVER_ENERGY_POLICY) * 60 * 1000,
    pressure: projected.pressure,
    startPressure: projected.startPressure
  };
}

function renderRecoverEnergyCompletedReminder(input: {
  reason: string | null;
  xiaoniOs?: string | null;
  wakeCause?: string | null;
  sleepMinutes: number;
  wakeCallCount?: number | null;
  wakeRequiredCount?: number | null;
  clockMinutes?: number | null;
  clockDeferredMinutes?: number | null;
  recoveredEnergy: ReturnType<typeof recoverRuntimeEnergy>;
  batchFinalRecoveryTimeline?: string | null;
}) {
  const wakeCause = input.wakeCause || 'natural';
  const template = wakeCause === 'private_or_mention_threshold'
    ? 'recover_energy_interrupted_reminder.md'
    : wakeCause === 'clock'
      ? 'recover_energy_clock_reminder.md'
      : wakeCause === 'clock_deferred'
        ? 'recover_energy_clock_deferred_reminder.md'
        : wakeCause === 'hard_cap'
          ? 'recover_energy_forced_completed_reminder.md'
          : 'recover_energy_completed_reminder.md';
  return formatSystemReminderBlock(renderPromptSnippet(template, {
    SLEEP_MINUTES: Math.max(0, Math.round(input.sleepMinutes)),
    WAKE_CAUSE: wakeCause,
    WAKE_CALL_COUNT: input.wakeCallCount ?? 0,
    WAKE_REQUIRED_COUNT: typeof input.wakeRequiredCount === 'number' && Number.isFinite(input.wakeRequiredCount) ? input.wakeRequiredCount : '无穷',
    CLOCK_MINUTES: input.clockMinutes ?? '',
    CLOCK_DEFERRED_MINUTES: input.clockDeferredMinutes ?? 0,
    REASON: input.reason || '',
    XIAONI_OS: input.xiaoniOs || '',
    BATCH_FINAL_RECOVERY_TIMELINE: input.batchFinalRecoveryTimeline || ''
  }));
}

function renderRecoverEnergyRejectedReminder(input: {
  reason: string;
}) {
  return formatSystemReminderBlock(renderPromptSnippet('recover_energy_rejected_reminder.md', {
    REJECT_REASON: input.reason
  }));
}

function selectMainLoopToolDefinitions(modelName: string): OpenResponseToolDefinition[] {
  void modelName;
  const tools: OpenResponseToolDefinition[] = agentConfig.webSearchEnabled
    ? [EXEC_COMMAND_TOOL, WEB_SEARCH_TOOL]
    : [EXEC_COMMAND_TOOL];
  // 缓存对齐：compress_core_memory 必须始终在主 loop 工具定义里（连同
  // resolveMainLoopToolChoice 的 auto allowed-tools），否则压缩 fork 的 tools 前缀
  // 与主 agent 不一致 → 冷读。禁止随意移除。详见 resolveMainLoopToolChoice 的不变量。
  tools.push(COMPRESS_CORE_MEMORY_TOOL);
  return [
    ...tools,
    IMAGE_GENERATION_TOOL,
    PRIVATE_MESSAGE_TOOL,
    GROUP_MESSAGE_TOOL,
    INSPECT_IMAGE_TOOL,
    IMAGE_TASK_TOOL,
    RECOVER_ENERGY_TOOL
  ];
}

function resolveMainLoopToolChoice(loopInput: OpenResponseInputItem[]): OpenResponseToolChoice {
  void loopInput;
  // ┌──────────────────────────────────────────────────────────────────────────┐
  // │ ⚠️ 缓存对齐不变量 — 禁止随意改动 (DO NOT casually change)                   │
  // ├──────────────────────────────────────────────────────────────────────────┤
  // │ 本函数必须永远返回 tool_choice = AUTO，且 compress_core_memory 必须始终在    │
  // │ allowed tools 里（每一轮都暴露，不分压缩/非压缩）。                          │
  // │                                                                            │
  // │ 为什么不能改成「压缩时强制 tool_choice」：                                   │
  // │   forced tool_choice (any/tool) → provider 关掉 extended thinking          │
  // │   (anthropic-translate.ts:527 thinkingEnabled = !plan.forced) → 历史里      │
  // │   每个 thinking block 被丢 (anthropic-translate.ts:280) → tools/thinking    │
  // │   前缀与主 loop 不一致 → 压缩 fork 每次 100% 冷读整窗 (~487K, "Cache 0")。   │
  // │                                                                            │
  // │ 正确做法：fork = 主 agent 的字节克隆 (同 tools + 同 auto + thinking 在)，    │
  // │   「只准压缩」靠执行层 runCoreMemoryCompressionFork 的 allowedToolNames 拦，  │
  // │   绝不靠改 request 形状。小腻不自己乱压由 system_prompt「模块五」约束。       │
  // │                                                                            │
  // │ 回归守卫：agent-loop-service.test.ts 断言 fork.tool_choice === 主.tool_choice。│
  // │ 详见 provider-service/.../anthropic-translate.ts:521-527。                  │
  // └──────────────────────────────────────────────────────────────────────────┘
  const tools: Array<{ type: 'function'; name: string } | { type: 'web_search' }> = [
    { type: 'function', name: TOOL_NAMES.execCommand },
    { type: 'function', name: TOOL_NAMES.privateReply },
    { type: 'function', name: TOOL_NAMES.groupReply },
    { type: 'function', name: TOOL_NAMES.inspectImage },
    { type: 'function', name: TOOL_NAMES.imageTask }
  ];
  if (agentConfig.webSearchEnabled) {
    tools.unshift({ type: 'web_search' });
  }
  tools.push({ type: 'function', name: TOOL_NAMES.recoverEnergy });
  tools.push({ type: 'function', name: TOOL_NAMES.compressCoreMemory });
  return buildAllowedToolsToolChoice(tools, 'auto');
}

function selectFeedbackWriterToolDefinitions(mode: FeedbackWriterMode) {
  if (mode === 'episode_only') {
    return [] satisfies OpenResponseToolDefinition[];
  }

  return [
    FEEDBACK_REFLECTION_SYNTHESIS_TOOL,
    FEEDBACK_LEARNING_STATE_TOOL
  ] satisfies OpenResponseToolDefinition[];
}

function resolveFeedbackWriterToolChoice(loopInput: OpenResponseInputItem[], mode: FeedbackWriterMode): FeedbackWriterToolChoice {
  if (mode === 'episode_only') {
    return undefined;
  }

  if (!hasToolReplay(loopInput, TOOL_NAMES.feedbackReflection)) {
    return undefined;
  }

  return buildAllowedToolsToolChoice([
    { type: 'function', name: TOOL_NAMES.feedbackLearningState }
  ]);
}

export function buildCanonicalAgentTurnRequest(
  modelName: string,
  loopInput: OpenResponseInputItem[],
  chatType: 'group' | 'direct',
  parameters?: AgentModelParameters
): CanonicalAgentTurnRequest {
  void chatType;
  const [firstItem, ...remainingItems] = loopInput;
  const baseInstructions = firstItem?.type === 'message'
    && firstItem.role === 'system'
    && typeof firstItem.content === 'string'
    ? firstItem.content
    : undefined;
  const instructions = baseInstructions;
  const tools = selectMainLoopToolDefinitions(modelName);
  const toolChoice = resolveMainLoopToolChoice(loopInput);

  return {
    model: modelName,
    input: normalizeResponseInputItems(instructions ? remainingItems : loopInput),
    ...(instructions ? { instructions } : {}),
    tools,
    tool_choice: toolChoice,
    parallel_tool_calls: true,
    ...(buildAgentReasoningConfig(modelName, parameters) ? { reasoning: buildAgentReasoningConfig(modelName, parameters) } : {}),
    ...(buildAgentTextConfig(modelName, parameters) ? { text: buildAgentTextConfig(modelName, parameters) } : {}),
    ...(buildAgentInclude(modelName, parameters) ? { include: buildAgentInclude(modelName, parameters) } : {})
  };
}

function buildMainAgentCanonicalRequest(
  runtimePrompt: ResolvedAgentRuntimePrompt,
  turnInput: OpenResponseInputItem[],
  queueMessage: QueueMessageRecord['payload']
): CanonicalAgentTurnRequest {
  return {
    ...buildCanonicalAgentTurnRequest(
      runtimePrompt.modelName,
      turnInput,
      queueMessage.chatType,
      runtimePrompt.parameters as Record<string, unknown> | undefined
    ),
    metadata: buildAgentTurnMetadata(queueMessage, runtimePrompt),
    prompt_cache_key: buildPromptCacheKey(queueMessage, runtimePrompt),
    ...(agentConfig.promptCacheRetention && agentConfig.promptCacheRetention.trim()
      ? { prompt_cache_retention: agentConfig.promptCacheRetention.trim() }
      : {})
  };
}

function cloneCanonicalAgentTurnRequest(request: CanonicalAgentTurnRequest): CanonicalAgentTurnRequest {
  return JSON.parse(JSON.stringify(request)) as CanonicalAgentTurnRequest;
}

function buildCoreMemoryCompressionForkRequest(
  baseRequest: CanonicalAgentTurnRequest,
  forkTurn: number
): CanonicalAgentTurnRequest {
  const forkRequest = cloneCanonicalAgentTurnRequest(baseRequest);
  forkRequest.parallel_tool_calls = true;
  forkRequest.store = false;
  forkRequest.metadata = {
    ...(forkRequest.metadata || {}),
    core_memory_compression_fork: 'true',
    fork_turn: String(forkTurn),
    no_persist: 'true'
  };
  return forkRequest;
}

function buildSubconsciousAgentForkRequest(
  baseRequest: CanonicalAgentTurnRequest,
  forkTurn: number
): CanonicalAgentTurnRequest {
  const forkRequest = cloneCanonicalAgentTurnRequest(baseRequest);
  forkRequest.parallel_tool_calls = false;
  forkRequest.store = false;
  forkRequest.input = normalizeResponseInputItems([
    ...forkRequest.input,
    buildDeveloperInputItem([renderSelfContinuationReminder()]),
    buildDeveloperInputItem([renderSubconsciousForkToolRestrictionReminder()])
  ]);
  // Cache-alignment (Layer 1): inherit the main loop's auto tool_choice/tools so the
  // fork's prefix is byte-identical and rides the main's warm in-context cache.
  // Tool restriction is enforced at execution time (Layer 2): allowedToolNames is
  // {execCommand}, so any speaking/image tool the model emits is rejected, never
  // executed. The appended restriction reminder hard-steers it to exec_command.
  forkRequest.metadata = {
    ...(forkRequest.metadata || {}),
    subconscious_agent_fork: 'true',
    fork_turn: String(forkTurn),
    no_persist: 'true'
  };
  return forkRequest;
}

function buildCacheHeartbeatForkRequest(baseRequest: CanonicalAgentTurnRequest): CanonicalAgentTurnRequest {
  const heartbeatRequest = cloneCanonicalAgentTurnRequest(baseRequest);
  heartbeatRequest.input = normalizeResponseInputItems([
    ...heartbeatRequest.input,
    {
      type: 'message',
      role: 'developer',
      content: CACHE_HEARTBEAT_DEVELOPER_CONTENT
    }
  ]);
  heartbeatRequest.parallel_tool_calls = true;
  // Cache-alignment: the heartbeat exists purely to keep the main loop's warm
  // prefix from expiring. To refresh the SAME cache entry the main loop reads, its
  // tool_choice + thinking must match the main loop's — so inherit the base auto
  // tool_choice (do NOT set 'none', which would warm a different messages-tier
  // entry the main loop never reads). The heartbeat runs a single dispatch with no
  // tool-execution loop, so an emitted tool_use is harmless (discarded). The tiny
  // max_output_tokens still triggers a full prefill, which is what writes/refreshes
  // the cache; thinking:{adaptive} is added by the provider so the key matches.
  heartbeatRequest.store = false;
  heartbeatRequest.max_output_tokens = Math.max(
    1,
    Math.min(16, Number(agentConfig.cacheHeartbeatMaxOutputTokens) || 1)
  );
  heartbeatRequest.metadata = {
    ...(heartbeatRequest.metadata || {}),
    cache_heartbeat: 'true',
    no_persist: 'true',
    no_main_stack_persist: 'true',
    no_traffic_persist: 'true'
  };
  return heartbeatRequest;
}

function buildImageVisionForkRequest(
  baseRequest: CanonicalAgentTurnRequest,
  imageDataUrl: string,
  imageId: string,
  outputPath: string,
  existingObservation: string | null = null
): CanonicalAgentTurnRequest {
  const forkRequest = cloneCanonicalAgentTurnRequest(baseRequest);
  const imageVisionCallId = buildImageVisionForkCallId(imageId);
  const existingObservationReminder = existingObservation && existingObservation.trim()
    ? [buildImageVisionExistingObservationReminder(existingObservation)]
    : [];
  forkRequest.input = [
    ...forkRequest.input,
    {
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: IMAGE_VISION_FORK_SENTINEL
        }
      ]
    },
    {
      type: 'function_call',
      call_id: imageVisionCallId,
      name: 'inspect_image_placeholder',
      arguments: JSON.stringify({
        image_id: imageId,
        detail: 'original'
      })
    },
    {
      type: 'function_call_output',
      call_id: imageVisionCallId,
      output: [{
        type: 'input_image',
        image_url: imageDataUrl,
        detail: 'original'
      }]
    },
    ...existingObservationReminder,
    buildImageVisionFileWriteReminder(outputPath)
  ];
  // Cache-alignment (Layer 1): keep the main loop's tool_choice/tools unchanged so
  // the fork's tools+system+history prefix is byte-identical and reads the main's
  // warm in-context cache. Tool restriction to exec_command is enforced at
  // execution time (Layer 2): only execCommand calls run; any other tool the model
  // emits gets buildImageVisionUnsupportedToolOutput and is never executed. The
  // appended write reminder hard-steers the model to exec_command only.
  forkRequest.parallel_tool_calls = true;
  forkRequest.store = false;
  forkRequest.metadata = {
    ...(forkRequest.metadata || {}),
    image_vision_fork: 'true',
    image_id: imageId,
    image_vision_output_path: outputPath,
    raw_trace_persisted: 'true'
  };
  return forkRequest;
}

function buildImageVisionObservationPath(imageId: string) {
  return `${IMAGE_VISION_OBSERVATION_DIR}/${imageId}.md`;
}

function buildImageVisionFileWriteReminder(outputPath: string): OpenResponseInputItem {
  return buildDeveloperInputItem([
    renderPromptSnippet('image_vision_write_description_reminder.md', {
      CURRENT_TIME: formatEast8Timestamp(),
      OUTPUT_PATH: outputPath
    })
  ]);
}

function buildImageVisionExistingObservationReminder(existingObservation: string): OpenResponseInputItem {
  return buildDeveloperInputItem([
    renderPromptSnippet('image_vision_existing_observation_reminder.md', {
      CURRENT_TIME: formatEast8Timestamp(),
      EXISTING_OBSERVATION: existingObservation.trim()
    })
  ]);
}

function buildImageVisionRetryReminder(params: {
  outputPath: string;
  checkResult: string;
}): OpenResponseInputItem {
  return buildDeveloperInputItem([
    renderPromptSnippet('image_vision_retry_missing_file_reminder.md', {
      CURRENT_TIME: formatEast8Timestamp(),
      OUTPUT_PATH: params.outputPath,
      CHECK_RESULT: params.checkResult
    })
  ]);
}

function buildImageVisionUnsupportedToolOutput(toolCall: AgentToolCall): Extract<OpenResponseInputItem, { type: 'function_call_output' }> {
  return {
    type: 'function_call_output',
    call_id: toolCall.callId,
    output: renderPromptSnippet('image_vision_unsupported_tool_output.md', {
      ALLOWED_TOOL: TOOL_NAMES.execCommand
    })
  };
}

function buildImageVisionFailedDescription(outputPath: string) {
  return renderPromptSnippet('image_vision_failed_after_retries_reminder.md', {
    CURRENT_TIME: formatEast8Timestamp(),
    OUTPUT_PATH: outputPath
  });
}

function buildImageVisionForkCallId(imageId: string): string {
  const digest = createHash('sha256').update(imageId).digest('hex').slice(0, 32);
  const callId = `call_image_vision_${digest}`;
  return callId.length <= OPENAI_CALL_ID_MAX_LENGTH
    ? callId
    : `call_img_${digest}`;
}

function buildImageVisionForkRunId(runId: string | null | undefined, imageId: string): string {
  const digest = createHash('sha256').update(`${runId || 'run'}:${imageId}`).digest('hex').slice(0, 16);
  return `image-vision-fork:${runId || 'run'}:${digest}:${uuidv4().slice(0, 8)}`;
}

function buildImageObservationXml(imageId: string, description: string) {
  return `<image id="${escapeTagAttribute(imageId)}">含义是: ${escapeTaggedText(description)}</image>`;
}

function buildFeedbackWriterRequest(
  modelName: string,
  loopInput: OpenResponseInputItem[],
  options: {
    metadata: Record<string, string>;
    promptCacheKey: string;
    mode: FeedbackWriterMode;
  }
): CanonicalAgentTurnRequest {
  const [firstItem, ...remainingItems] = loopInput;
  const instructions = firstItem?.type === 'message'
    && firstItem.role === 'system'
    && typeof firstItem.content === 'string'
    ? firstItem.content
    : undefined;

  const toolChoice = resolveFeedbackWriterToolChoice(loopInput, options.mode);
  return {
    model: modelName,
    input: normalizeResponseInputItems(instructions ? remainingItems : loopInput),
    ...(instructions ? { instructions } : {}),
    tools: selectFeedbackWriterToolDefinitions(options.mode),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    parallel_tool_calls: true,
    metadata: options.metadata,
    prompt_cache_key: options.promptCacheKey,
    ...(agentConfig.promptCacheRetention && agentConfig.promptCacheRetention.trim()
      ? { prompt_cache_retention: agentConfig.promptCacheRetention.trim() }
      : {})
  };
}

function buildCompactMemoryWriterRequest(
  modelName: string,
  loopInput: OpenResponseInputItem[],
  options: {
    metadata: Record<string, string>;
    promptCacheKey: string;
    layer: CompactMemoryLayer;
    reasoningEffort: string;
    textVerbosity: 'low' | 'medium' | 'high';
  }
): CanonicalAgentTurnRequest {
  const [firstItem, ...remainingItems] = loopInput;
  const instructions = firstItem?.type === 'message'
    && firstItem.role === 'system'
    && typeof firstItem.content === 'string'
    ? firstItem.content
    : undefined;
  const toolName = COMPACT_MEMORY_TOOL_NAME_BY_LAYER[options.layer];

  return {
    model: modelName,
    input: normalizeResponseInputItems(instructions ? remainingItems : loopInput),
    ...(instructions ? { instructions } : {}),
    tools: [COMPACT_MEMORY_TOOL_BY_LAYER[options.layer]],
    tool_choice: buildAllowedToolsToolChoice([{ type: 'function', name: toolName }]),
    parallel_tool_calls: true,
    metadata: options.metadata,
    prompt_cache_key: options.promptCacheKey,
    reasoning: {
      effort: options.reasoningEffort || 'medium',
      summary: 'auto'
    },
    text: {
      verbosity: options.textVerbosity
    },
    ...(agentConfig.promptCacheRetention && agentConfig.promptCacheRetention.trim()
      ? { prompt_cache_retention: agentConfig.promptCacheRetention.trim() }
      : {})
  };
}

function formatMessageSender(message: QueueMessageRecord['payload']['messages'][number]) {
  return formatIdentity(message.senderName, message.senderId);
}

function formatReplyTarget(inboundContext: QueueMessageRecord['payload']['inboundContext']) {
  return formatIdentity(
    inboundContext.ReplyToSenderName || inboundContext.ReplyToSender,
    inboundContext.ReplyToSenderId
  );
}

function renderTranscriptBatchMessage(
  message: QueueMessageRecord['payload']['messages'][number],
  index: number
) {
  void index;
  const lines: string[] = [];

  if (message.inboundContext.ReplyToBody) {
    const prefix = message.inboundContext.ReplyToIsQuote ? '引用' : '回复给';
    lines.push(`[${prefix} ${formatReplyTarget(message.inboundContext)}：${message.inboundContext.ReplyToBody}]`);
  }

  const text = normalizeTranscriptMessageText(message.bodyForAgent, message.inboundContext.MentionedUsers).trim();
  if (text) {
    lines.push(text);
  }

  const mediaAssets = Array.isArray(message.inboundContext.MediaAssets)
    ? message.inboundContext.MediaAssets
    : [];
  for (const asset of mediaAssets) {
    if (!asset || typeof asset.mediaTag !== 'string' || !asset.mediaTag.trim()) {
      continue;
    }
    const mediaTag = typeof asset.id === 'string' && asset.id.trim()
      ? asset.id.trim()
      : asset.mediaTag.trim();
    const mediaType = typeof asset.mediaType === 'string' && asset.mediaType.trim()
      ? asset.mediaType.trim()
      : 'media';
    lines.push(`<${mediaType}>pic<${mediaTag}></${mediaType}>`);
  }

  return formatTaggedBlock('INPUT_MESSAGE', {
    message_id: message.messageId,
    chat_type: renderPromptChatType(message.chatType),
    group: message.chatType === 'group' ? formatTagSpeaker(message.peerName, message.peerId) : undefined,
    private_peer: message.chatType === 'direct' ? formatTagSpeaker(message.peerName, message.peerId) : undefined
  }, lines.join('\n') || '(空消息)');
}

function buildCurrentTurnMessage(queueMessage: QueueMessageRecord['payload']) {
  return renderRuntimeBatchInput(queueMessage);
}

function buildAgentTurnMetadata(
  queueMessage: QueueMessageRecord['payload'],
  runtimePrompt: ResolvedAgentRuntimePrompt
) {
  const metadata: Record<string, string> = {
    trace_id: queueMessage.traceId,
    run_id: queueMessage.runId,
    batch_id: queueMessage.batchId,
    session_key: queueMessage.sessionKey,
    source_session_key: queueMessage.sessionKey,
    session_id: getGlobalPromptContextSessionKey(),
    codex_session_id: getGlobalPromptContextSessionKey(),
    turn_id: queueMessage.runId,
    sandbox: 'none',
    chat_type: queueMessage.chatType,
    prompt_name: runtimePrompt.promptName,
  };

  if (runtimePrompt.promptId) {
    metadata.prompt_id = runtimePrompt.promptId;
  }

  return metadata;
}

function buildFeedbackMemorySubagentTurnMetadata(params: {
  queueMessage: QueueMessageRecord['payload'];
  runtimePrompt: ResolvedAgentRuntimePrompt;
  conversationId: number;
  subagentTraceId: string;
  turn: number;
}) {
  const metadata: Record<string, string> = {
    trace_id: params.subagentTraceId,
    parent_trace_id: params.queueMessage.traceId,
    parent_run_id: params.queueMessage.runId,
    parent_conversation_id: String(params.conversationId),
    batch_id: params.queueMessage.batchId,
    session_key: params.queueMessage.sessionKey,
    source_session_key: params.queueMessage.sessionKey,
    session_id: buildSubagentPromptCacheKey({
      queueMessage: params.queueMessage,
      subagentType: FEEDBACK_MEMORY_SUBAGENT_TYPE
    }),
    codex_session_id: buildSubagentPromptCacheKey({
      queueMessage: params.queueMessage,
      subagentType: FEEDBACK_MEMORY_SUBAGENT_TYPE
    }),
    turn_id: `${params.queueMessage.runId}:feedback_memory:${params.turn}`,
    sandbox: 'none',
    chat_type: params.queueMessage.chatType,
    prompt_name: params.runtimePrompt.promptName,
    subagent_type: FEEDBACK_MEMORY_SUBAGENT_TYPE,
    parent_agent_type: 'chat_bot'
  };

  if (params.runtimePrompt.promptId) {
    metadata.prompt_id = params.runtimePrompt.promptId;
  }

  return metadata;
}

function buildCompactMemorySubagentTurnMetadata(params: {
  queueMessage: QueueMessageRecord['payload'];
  runtimePrompt: ResolvedAgentRuntimePrompt;
  conversationId: number;
  subagentTraceId: string;
  layer: CompactMemoryLayer;
}) {
  const metadata = buildFeedbackMemorySubagentTurnMetadata({
    queueMessage: params.queueMessage,
    runtimePrompt: params.runtimePrompt,
    conversationId: params.conversationId,
    subagentTraceId: params.subagentTraceId,
    turn: 1
  });
  metadata.subagent_type = CONTEXT_COMPRESSION_MEMORY_SUBAGENT_TYPE;
  metadata.turn_id = `${params.queueMessage.runId}:compact_memory:${params.layer}`;
  metadata.memory_layer = params.layer;
  metadata.session_id = buildSubagentPromptCacheKey({
    queueMessage: params.queueMessage,
    subagentType: CONTEXT_COMPRESSION_MEMORY_SUBAGENT_TYPE,
    layer: params.layer
  });
  metadata.codex_session_id = metadata.session_id;
  return metadata;
}

function buildPromptCacheKey(
  queueMessage: QueueMessageRecord['payload'],
  _runtimePrompt: ResolvedAgentRuntimePrompt
) {
  void queueMessage;
  void _runtimePrompt;
  return getGlobalPromptContextSessionKey();
}

function buildSubagentPromptCacheKey(params: {
  queueMessage: QueueMessageRecord['payload'];
  subagentType: string;
  layer?: CompactMemoryLayer;
}) {
  void params.queueMessage;
  if (params.subagentType === CONTEXT_COMPRESSION_MEMORY_SUBAGENT_TYPE && params.layer) {
    return `xiaoni:subagent:compact_memory:${params.layer}`;
  }
  return `xiaoni:subagent:${params.subagentType}`;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
    ? Number(value)
    : NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function appendCappedOutput(current: string, chunk: Buffer, maxChars: number) {
  if (current.length >= maxChars) {
    return current;
  }
  const next = current + chunk.toString('utf8');
  return next.length > maxChars ? next.slice(0, maxChars) : next;
}

function resolveExecShellArgs(shell: string, cmd: string, login: boolean) {
  const shellName = shell.split(/[\\/]/).pop() || shell;
  if (login && (shellName === 'bash' || shellName === 'zsh')) {
    return ['-lc', cmd];
  }
  return ['-c', cmd];
}

function buildCodexExecOutput(input: {
  chunkId: string;
  durationMs: number;
  exitCode: number | null;
  signal?: NodeJS.Signals | string | null;
  output: string;
  running?: boolean;
  sessionId?: string;
  blocked?: boolean;
  truncated?: boolean;
}) {
  const lines = [
    `Chunk ID: ${input.chunkId}`,
    `Wall time: ${(input.durationMs / 1000).toFixed(4)} seconds`
  ];
  if (input.blocked) {
    lines.push('Process blocked by executor policy');
  } else if (input.running) {
    lines.push(`Process running with session ID ${input.sessionId || ''}`.trim());
  } else if (typeof input.exitCode === 'number') {
    lines.push(`Process exited with code ${input.exitCode}`);
  } else if (input.signal) {
    lines.push(`Process exited with signal ${input.signal}`);
  } else {
    lines.push('Process exited without an exit code');
  }
  lines.push(`Original token count: ${Math.max(0, Math.ceil(input.output.length / 4))}`);
  if (input.truncated) {
    lines.push('Output was truncated to max_output_tokens.');
  }
  lines.push('Output:', input.output);
  return lines.join('\n');
}

function buildMainAgentParameters(parameters: Record<string, unknown> | null | undefined) {
  const base = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
    ? JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>
    : {};
  const advancedConfig = base.advanced_config && typeof base.advanced_config === 'object' && !Array.isArray(base.advanced_config)
    ? base.advanced_config as Record<string, unknown>
    : {};
  const generationConfig = advancedConfig.generationConfig
    && typeof advancedConfig.generationConfig === 'object'
    && !Array.isArray(advancedConfig.generationConfig)
    ? advancedConfig.generationConfig as Record<string, unknown>
    : {};
  const modelConfig = base.model_config && typeof base.model_config === 'object' && !Array.isArray(base.model_config)
    ? base.model_config as Record<string, unknown>
    : null;
  const providerSpecific = modelConfig?.providerSpecific && typeof modelConfig.providerSpecific === 'object' && !Array.isArray(modelConfig.providerSpecific)
    ? modelConfig.providerSpecific as Record<string, unknown>
    : null;

  if (providerSpecific) {
    delete providerSpecific.reasoningEffort;
    delete providerSpecific.reasoningSummary;
  }
  if (base.reasoning) {
    delete base.reasoning;
  }

  const configuredTimeout = generationConfig.timeout;
  const hasExplicitTimeout = typeof configuredTimeout === 'number'
    && Number.isFinite(configuredTimeout)
    && configuredTimeout > 0;

  return {
    ...base,
    advanced_config: {
      ...advancedConfig,
      generationConfig: {
        ...generationConfig,
        ...(hasExplicitTimeout ? {} : { timeout: agentConfig.mainAgentTurnTimeoutMs })
      }
    }
  };
}

function buildCompactMemoryAgentParameters(parameters: Record<string, unknown> | null | undefined) {
  const base = buildMainAgentParameters(parameters);
  const advancedConfig = base.advanced_config && typeof base.advanced_config === 'object' && !Array.isArray(base.advanced_config)
    ? base.advanced_config as Record<string, unknown>
    : {};
  const generationConfig = advancedConfig.generationConfig
    && typeof advancedConfig.generationConfig === 'object'
    && !Array.isArray(advancedConfig.generationConfig)
    ? advancedConfig.generationConfig as Record<string, unknown>
    : {};

  return {
    ...base,
    advanced_config: {
      ...advancedConfig,
      generationConfig: {
        ...generationConfig,
        timeout: agentConfig.compactMemoryTimeoutMs
      }
    }
  };
}

function buildInboundBatchTranscriptItems(
  queueMessage: QueueMessageRecord['payload']
): Array<{
  sessionKey: string;
  role: 'user' | 'assistant';
  phase?: ConversationTranscriptPhase | null;
  content: string;
  groupIndex: 0;
  itemIndex: number;
  source: 'inbound_batch' | 'sensory_event';
  runId: string;
  traceId: string;
}> {
  if (isPromptFacingRuntimeReminderPayload(queueMessage)) {
    return [];
  }
  return queueMessage.messages.map((message, index) => ({
    sessionKey: queueMessage.sessionKey,
    role: 'user' as const,
    phase: null,
    content: renderTranscriptBatchMessage(message, index),
    groupIndex: 0 as const,
    itemIndex: index,
    source: 'inbound_batch' as const,
    runId: queueMessage.runId,
    traceId: queueMessage.traceId
  }));
}

function extractDeliveryMessageIds(delivery: unknown): Array<number | null> {
  if (Array.isArray(delivery)) {
    return delivery.map((item) => {
      const raw = item && typeof item === 'object' ? (item as { message_id?: unknown }).message_id : null;
      const value = typeof raw === 'number' ? raw : Number(raw);
      return Number.isFinite(value) ? value : null;
    });
  }

  if (delivery && typeof delivery === 'object') {
    const deliveryRecord = delivery as {
      message_id?: unknown;
      messageId?: unknown;
      messages?: unknown;
      deliveries?: unknown;
    };
    if (Array.isArray(deliveryRecord.messages)) {
      return extractDeliveryMessageIds(deliveryRecord.messages);
    }
    if (Array.isArray(deliveryRecord.deliveries)) {
      return extractDeliveryMessageIds(deliveryRecord.deliveries);
    }

    const raw = deliveryRecord.message_id ?? deliveryRecord.messageId;
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(value)) {
      return [value];
    }
  }

  return [];
}

function extractDeliveredAssistantMessages(toolResult: Record<string, unknown>): DeliveredAssistantMessage[] {
  const messages = extractSentMessages(toolResult);
  const deliveryIds = extractDeliveryMessageIds(toolResult.delivery);

  return messages.map((content, index) => ({
    content,
    deliveryMessageId: deliveryIds[index] ?? null
  }));
}

function buildLeaseReleaseRecord(params: {
  reason: LeaseReleaseReason;
  detail?: string | null;
  outcome?: string | null;
  noVisibleDelivery: boolean;
  visibleDeliveryCommitted: boolean;
  source: string;
  toolResult?: Record<string, unknown>;
}): LeaseReleaseRecord {
  return {
    event_kind: 'lease_released',
    reason: params.reason,
    detail: params.detail ?? null,
    outcome: params.outcome ?? null,
    no_visible_delivery: params.noVisibleDelivery,
    visible_delivery_committed: params.visibleDeliveryCommitted,
    source: params.source,
    ...(params.toolResult ? { tool_result: params.toolResult } : {})
  };
}

function buildAssistantTranscriptItems(params: {
  queueMessage: QueueMessageRecord['payload'];
  deliveredMessages: DeliveredAssistantMessage[];
  leaseReleased: boolean;
}): ConversationTranscriptItem[] {
  if (params.deliveredMessages.length === 0) {
    return [];
  }

  return params.deliveredMessages.map((message, index) => {
    const isFinalMessage = params.leaseReleased && index === params.deliveredMessages.length - 1;
    return {
      id: null,
      conversationId: 0,
      sessionKey: params.queueMessage.sessionKey,
      role: 'assistant',
      phase: isFinalMessage ? 'final_answer' : 'commentary',
      content: message.content,
      groupIndex: 1,
      itemIndex: index,
      source: 'delivery',
      deliveryMessageId: message.deliveryMessageId,
      runId: params.queueMessage.runId,
      traceId: params.queueMessage.traceId
    };
  });
}

function appendRuntimePromptSection(basePrompt: string, sectionTitle: string, sectionBody: string) {
  const normalizedBase = basePrompt.trim();
  const normalizedBody = sectionBody.trim();

  if (!normalizedBody) {
    return normalizedBase;
  }

  return `${normalizedBase}\n\n${sectionTitle}\n${normalizedBody}`;
}

function buildTextPart(text: string): OpenResponseInputContentPart {
  return {
    type: 'input_text',
    text
  };
}

function buildOutputTextPart(text: string): OpenResponseInputContentPart {
  return {
    type: 'output_text',
    text
  };
}

function buildUserSceneInputItem(parts: string[]): OpenResponseInputItem {
  return {
    type: 'message',
    role: 'user',
    content: parts
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => buildTextPart(part))
  };
}

function buildMessageInputItem(
  role: 'user' | 'assistant' | 'developer',
  parts: string[],
  phase?: ConversationTranscriptPhase
): OpenResponseInputItem {
  const buildPart = role === 'assistant' ? buildOutputTextPart : buildTextPart;
  const content = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => buildPart(part));

  return {
    type: 'message',
    role,
    ...(phase ? { phase } : {}),
    content
  };
}

function buildAssistantCommentaryInputItem(parts: string[]): OpenResponseInputItem {
  return buildMessageInputItem('assistant', parts, 'commentary');
}

function buildAssistantFinalInputItem(parts: string[]): OpenResponseInputItem {
  return buildMessageInputItem('assistant', parts, 'final_answer');
}

function buildDeveloperInputItem(parts: string[]): OpenResponseInputItem {
  return buildMessageInputItem('developer', parts);
}

function escapeTagAttribute(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeTaggedText(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTagAttributes(attributes: Record<string, unknown>) {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim().length > 0)
    .map(([key, value]) => `${key}="${escapeTagAttribute(value)}"`)
    .join(' ');
}

function formatTaggedBlock(tagName: string, attributes: Record<string, unknown>, body: string) {
  const renderedAttributes = formatTagAttributes(attributes);
  const openTag = renderedAttributes ? `<${tagName} ${renderedAttributes}>` : `<${tagName}>`;
  return [
    openTag,
    escapeTaggedText(body || ''),
    `</${tagName}>`
  ].join('\n');
}

function formatSystemReminderBlock(body: string) {
  return formatTaggedBlock('system_reminder', {}, String(body || '').trim());
}

function extractTaggedBlockBody(content: string, tagName: string) {
  const normalized = String(content || '').trim();
  const pattern = new RegExp(`^<${tagName}(?:\\s[^>]*)?>\\n?([\\s\\S]*?)\\n?</${tagName}>$`);
  const match = normalized.match(pattern);
  return match ? match[1].trim() : normalized;
}

function renderPromptChatType(chatType: string | null | undefined) {
  const normalized = typeof chatType === 'string' ? chatType.trim().toLowerCase() : '';
  if (normalized === 'group' || normalized === '群聊') {
    return '群聊';
  }
  if (normalized === 'direct' || normalized === 'private' || normalized === '私聊') {
    return '私聊';
  }
  return typeof chatType === 'string' && chatType.trim() ? chatType.trim() : undefined;
}

function readTagAttribute(attributes: string, name: string) {
  const match = attributes.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match?.[1] || null;
}

function sanitizeInputMessageTags(content: string) {
  return content.replace(/<INPUT_MESSAGE\b([^>]*)>/g, (_match, rawAttributes: string) => {
    const attributes = {
      message_id: readTagAttribute(rawAttributes, 'message_id') ?? undefined,
      chat_type: renderPromptChatType(readTagAttribute(rawAttributes, 'chat_type')),
      group: readTagAttribute(rawAttributes, 'group') ?? undefined,
      private_peer: readTagAttribute(rawAttributes, 'private_peer') ?? undefined
    };
    const renderedAttributes = formatTagAttributes(attributes);
    return renderedAttributes ? `<INPUT_MESSAGE ${renderedAttributes}>` : '<INPUT_MESSAGE>';
  });
}

function formatTagSpeaker(name: string | null | undefined, id: string | null | undefined) {
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  const normalizedId = typeof id === 'string' ? id.trim() : '';
  if (normalizedName && normalizedId) {
    return `${normalizedName}(${normalizedId})`;
  }
  if (normalizedId) {
    return `unknown(${normalizedId})`;
  }
  return normalizedName || 'unknown';
}

function formatAssistantSceneMessage(accountId: string, content: string) {
  const body = String(content || '').trim();
  if (!body) {
    return '';
  }

  return [`小腻(${accountId})`, body].join('\n');
}

function renderAssistantAction(params: {
  timestamp?: string | null;
  source?: string | null;
  runId?: string | null;
  traceId?: string | null;
  text: string;
}) {
  return formatTaggedBlock('ACTION', {
    timestamp: params.timestamp ?? undefined,
    source: params.source ?? undefined,
    run_id: params.runId ?? undefined,
    trace_id: params.traceId ?? undefined
  }, params.text);
}

function groupTranscriptItemsForScene(
  transcriptItems: ConversationTranscriptItem[],
  accountId: string
): Array<{ role: 'user' | 'assistant'; parts: string[] }> {
  const grouped: Array<{ role: 'user' | 'assistant'; parts: string[] }> = [];

  for (const item of transcriptItems) {
    const role = item.role === 'assistant' ? 'assistant' : 'user';
    const content = String(item.content || '').trim();
    if (!content) {
      continue;
    }
    const renderedContent = role === 'assistant'
      ? formatAssistantSceneMessage(accountId, content)
      : content;

    const last = grouped[grouped.length - 1];
    if (last && last.role === role && role === 'assistant') {
      last.parts.push(renderedContent);
      continue;
    }

    grouped.push({
      role,
      parts: [renderedContent]
    });
  }

  return grouped;
}

function renderTranscriptItemForRuntimeContext(item: ConversationTranscriptItem): OpenResponseInputItem | null {
  const content = String(item.content || '').trim();
  if (!content) {
    return null;
  }

  if (item.role === 'assistant') {
    return null;
  }

  return buildUserSceneInputItem([
    content.startsWith('<INPUT_MESSAGE')
      ? sanitizeInputMessageTags(content)
      : content
  ]);
}

function renderSelfContinuationReminder() {
  return formatSystemReminderBlock(readPromptSnippet('self_continuation_reminder.md'));
}

// Layer-2 soft-enforcement reminder for the subconscious fork. The fork inherits
// the main loop's full auto tool_choice (for cache alignment), so this hard-steers
// the model to exec_command and away from any outward-facing tool. Kept separate
// from the shared self_continuation_reminder, which must stay permissive for the
// main loop (where deciding to actually message a friend is allowed).
function renderSubconsciousForkToolRestrictionReminder() {
  return formatSystemReminderBlock(readPromptSnippet('subconscious_fork_tool_restriction_reminder.md'));
}

function renderSubconsciousAgentNotify(finalAnswerText: string) {
  return renderPromptSnippet('subconscious_agent_notify.md', {
    SUBCONSCIOUS_FINAL_ANSWER: finalAnswerText
  }).trim();
}

function buildSelfContinuationInputItem(): OpenResponseInputItem {
  return buildUserSceneInputItem([renderSelfContinuationReminder()]);
}

function isOpenResponseMessageInputItem(item: OpenResponseInputItem | undefined): item is Extract<OpenResponseInputItem, { type: 'message' }> {
  if (!item || item.type !== 'message') {
    return false;
  }
  const candidate = item as {
    role?: unknown;
    content?: unknown;
  };
  return typeof candidate.role === 'string'
    && (typeof candidate.content === 'string' || Array.isArray(candidate.content));
}

function isAssistantFinalAnswerInputItem(item: OpenResponseInputItem | undefined): boolean {
  return Boolean(isOpenResponseMessageInputItem(item) && item.role === 'assistant' && item.phase === 'final_answer');
}

function shouldAllowSelfContinuationOnTerminalFinalAnswer(
  options: ReturnType<typeof normalizeRuntimeFrameOptions>
): boolean {
  return !options.queueBacked
    && options.triggerInputMode === 'suppress_current_trigger';
}

function isPhoneNotificationDirectCueMessage(
  queueMessage: QueueMessageRecord['payload'],
  message: QueueBatchMessage
) {
  return message.source === 'phone_notification'
    || message.inboundContext?.Surface === 'phone_notification'
    || queueMessage.source === 'phone_notification'
    || queueMessage.chatType === 'direct'
    || Boolean(message.wasMentioned || message.inboundContext?.WasMentioned);
}

function truncateNotificationSummary(text: string, maxChars = 20) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  const chars = Array.from(normalized);
  return chars.length > maxChars
    ? `${chars.slice(0, maxChars).join('')}...`
    : normalized;
}

function resolvePhoneNotificationCueIdentity(
  queueMessage: QueueMessageRecord['payload'],
  message: QueueBatchMessage
) {
  const isNotificationMessage = message.source === 'phone_notification'
    || message.inboundContext?.Surface === 'phone_notification';
  const rawPayload = message.rawPayload || {};
  const messageChatType = message.chatType === 'direct' || message.inboundContext?.ChatType === 'direct'
    ? 'direct'
    : (message.chatType === 'group' || message.inboundContext?.ChatType === 'group'
      ? 'group'
      : queueMessage.chatType);
  if (!isNotificationMessage) {
    return {
      senderId: message.senderId,
      senderName: message.senderName
    };
  }

  const contextSenderId = typeof message.inboundContext?.SenderId === 'string'
    ? message.inboundContext.SenderId.trim()
    : '';
  const contextSenderName = typeof message.inboundContext?.SenderName === 'string'
    ? message.inboundContext.SenderName.trim()
    : '';
  const rawSenderId = typeof rawPayload.latest_sender_id === 'string' && rawPayload.latest_sender_id.trim()
    ? rawPayload.latest_sender_id.trim()
    : typeof rawPayload.source_sender_id === 'string' && rawPayload.source_sender_id.trim()
      ? rawPayload.source_sender_id.trim()
      : '';
  const rawSenderName = typeof rawPayload.latest_sender_name === 'string' && rawPayload.latest_sender_name.trim()
    ? rawPayload.latest_sender_name.trim()
    : typeof rawPayload.source_sender_name === 'string' && rawPayload.source_sender_name.trim()
      ? rawPayload.source_sender_name.trim()
      : '';
  const messagePeerId = messageChatType === 'direct' && typeof message.peerId === 'string'
    ? message.peerId.trim()
    : '';
  const messagePeerName = messageChatType === 'direct' && typeof message.peerName === 'string'
    ? message.peerName.trim()
    : '';
  const notificationPeerId = messageChatType === 'direct' && typeof queueMessage.phoneNotification?.peerId === 'string'
    ? queueMessage.phoneNotification.peerId.trim()
    : '';
  const notificationPeerName = messageChatType === 'direct' && typeof queueMessage.phoneNotification?.peerName === 'string'
    ? queueMessage.phoneNotification.peerName.trim()
    : '';

  return {
    senderId: rawSenderId || contextSenderId || messagePeerId || notificationPeerId || message.senderId,
    senderName: rawSenderName || contextSenderName || messagePeerName || notificationPeerName || message.senderName
  };
}

function phoneNotificationMessageSummary(message: QueueBatchMessage) {
  const rawPayload = message.rawPayload || {};
  const rawPreview = rawPayload.source_preview ?? rawPayload.latest_preview;
  if (typeof rawPreview === 'string' && rawPreview.trim()) {
    return truncateNotificationSummary(
      normalizeTranscriptMessageText(rawPreview, message.inboundContext?.MentionedUsers)
    );
  }
  return truncateNotificationSummary(
    normalizeTranscriptMessageText(message.bodyForAgent || '', message.inboundContext?.MentionedUsers)
  );
}

function buildPhoneNotificationDirectCueLines(queueMessage: QueueMessageRecord['payload']) {
  const grouped = new Map<string, {
    kind: 'direct' | 'group_mention' | 'group_activity';
    groupId?: string;
    groupName?: string;
    senderId: string;
    senderName?: string;
    count: number;
    latestSummary: string;
    latestSenderId?: string;
    latestSenderName?: string;
  }>();

  for (const message of queueMessage.messages) {
    if (!isPhoneNotificationDirectCueMessage(queueMessage, message)) {
      continue;
    }
    const wasMentioned = Boolean(message.wasMentioned || message.inboundContext?.WasMentioned);
    const messageChatType = message.chatType === 'direct' || message.inboundContext?.ChatType === 'direct'
      ? 'direct'
      : (message.chatType === 'group' || message.inboundContext?.ChatType === 'group'
        ? 'group'
        : queueMessage.chatType);
    const identity = resolvePhoneNotificationCueIdentity(queueMessage, message);
    const contextGroupId = typeof message.inboundContext?.NativeChannelId === 'string'
      ? message.inboundContext.NativeChannelId.trim()
      : '';
    const contextGroupName = typeof message.inboundContext?.GroupSubject === 'string'
      ? message.inboundContext.GroupSubject.trim()
      : '';
    const groupId = messageChatType === 'group'
      ? String(message.peerId || contextGroupId || queueMessage.phoneNotification?.peerId || queueMessage.peerId || '').trim()
      : '';
    const groupName = messageChatType === 'group'
      ? String(message.peerName || contextGroupName || queueMessage.phoneNotification?.peerName || queueMessage.peerName || '').trim()
      : '';
    const kind = messageChatType === 'direct'
      ? 'direct'
      : (wasMentioned ? 'group_mention' : 'group_activity');
    const key = kind === 'group_activity'
      ? `group_activity:${groupId || groupName || 'unknown'}`
      : (kind === 'group_mention'
        ? `group_mention:${groupId || groupName || 'unknown'}:${identity.senderId || identity.senderName || 'unknown'}`
        : `direct:${identity.senderId || identity.senderName || message.peerId || 'unknown'}`);
    const current = grouped.get(key) || {
      kind,
      groupId,
      groupName,
      senderId: identity.senderId,
      senderName: identity.senderName,
      count: 0,
      latestSummary: '',
      latestSenderId: identity.senderId,
      latestSenderName: identity.senderName
    };
    current.count += 1;
    const summary = phoneNotificationMessageSummary(message);
    if (summary) {
      current.latestSummary = summary;
      current.latestSenderId = identity.senderId;
      current.latestSenderName = identity.senderName;
    }
    grouped.set(key, current);
  }

  return Array.from(grouped.values()).map((entry) => {
    const identity = formatIdentity(entry.senderName, entry.senderId);
    const latest = entry.latestSummary || '无摘要';
    if (entry.kind === 'direct') {
      return renderPromptSnippet('phone_notification_direct_cue_line.md', {
        IDENTITY: identity,
        COUNT: entry.count,
        LATEST_SUMMARY: latest
      });
    }
    const group = formatIdentity(entry.groupName, entry.groupId || queueMessage.peerId);
    if (entry.kind === 'group_mention') {
      return renderPromptSnippet('phone_notification_group_mention_cue_line.md', {
        GROUP_IDENTITY: group,
        IDENTITY: identity,
        COUNT: entry.count,
        LATEST_SUMMARY: latest
      });
    }
    const latestSender = formatIdentity(entry.latestSenderName, entry.latestSenderId);
    return renderPromptSnippet('phone_notification_group_activity_cue_line.md', {
      GROUP_IDENTITY: group,
      COUNT: entry.count,
      LATEST_SENDER: latestSender,
      LATEST_SUMMARY: latest
    });
  });
}

function renderPhoneNotification(queueMessage: QueueMessageRecord['payload']) {
  const notification = queueMessage.phoneNotification;
  const unreadDelta = Math.max(
    1,
    Number(notification?.unreadDelta || 0),
    queueMessage.messages.length || 0
  );
  const directCueLines = buildPhoneNotificationDirectCueLines(queueMessage);
  if (directCueLines.length === 0) {
    return '';
  }
  return formatSystemReminderBlock(renderPromptSnippet('phone_notification_reminder.md', {
    UNREAD_DELTA: unreadDelta,
    DIRECT_CUE_LINES: directCueLines.join('\n')
  }));
}

function renderImageTaskNotification(queueMessage: QueueMessageRecord['payload']) {
  const notification = queueMessage.imageTaskNotification;
  const taskId = notification?.taskId || queueMessage.rawPayload?.task_id || 'unknown';
  const taskStatus = notification?.taskStatus || queueMessage.rawPayload?.task_status || 'completed';
  const taskType = notification?.taskType || queueMessage.rawPayload?.task_type;
  const pictureId = notification?.pictureId || queueMessage.rawPayload?.picture_id;
  const picturePath = notification?.picturePath || queueMessage.rawPayload?.picture_path;
  const targetDescription = notification?.targetDescription || queueMessage.rawPayload?.target_description;
  const variables = {
    TASK_ID: String(taskId),
    TASK_RESULT: taskStatus === 'completed' ? '已完成' : String(taskStatus),
    TASK_TYPE_LINE: taskType ? `任务类型: ${taskType}` : '',
    PICTURE_ID_LINE: pictureId ? `图片ID: ${pictureId}` : '',
    PICTURE_PATH_LINE: picturePath ? `图片路径: ${picturePath}` : '',
    TARGET_DESCRIPTION_LINE: targetDescription ? `目标: ${targetDescription}` : ''
  };
  const emptyOptionalPlaceholders = [
    taskType ? null : 'TASK_TYPE_LINE',
    pictureId ? null : 'PICTURE_ID_LINE',
    picturePath ? null : 'PICTURE_PATH_LINE',
    targetDescription ? null : 'TARGET_DESCRIPTION_LINE'
  ].filter((value): value is string => typeof value === 'string');
  const template = removePlaceholderOnlyLines(
    readPromptSnippet('image_task_notification.md'),
    emptyOptionalPlaceholders
  );
  const body = renderPromptTemplateText(template, variables).trimEnd();
  return formatSystemReminderBlock(body);
}

function renderImageTaskPendingStatusText(params: {
  taskId: string | null;
  taskType: 'image_edit' | 'image_generate';
  requestedTaskType: 'image_edit' | 'image_generate';
  targetDescription: string | null;
}) {
  const requestedTaskTypeLine = params.requestedTaskType !== params.taskType
    ? `请求类型: ${params.requestedTaskType}`
    : '';
  const targetDescriptionLine = params.targetDescription
    ? `目标: ${params.targetDescription}`
    : '';
  const template = removePlaceholderOnlyLines(
    readPromptSnippet('image_task_pending.md'),
    [
      requestedTaskTypeLine ? null : 'REQUESTED_TASK_TYPE_LINE',
      targetDescriptionLine ? null : 'TARGET_DESCRIPTION_LINE'
    ].filter((value): value is string => typeof value === 'string')
  );
  return renderPromptTemplateText(template, {
    TASK_ID: params.taskId || 'unknown',
    TASK_TYPE: params.taskType,
    REQUESTED_TASK_TYPE_LINE: requestedTaskTypeLine,
    TARGET_DESCRIPTION_LINE: targetDescriptionLine
  }).trimEnd();
}

function normalizeAttentionLeasePreview(value: unknown) {
  return truncateNotificationSummary(typeof value === 'string' ? value : '', 20) || '无摘要';
}

function normalizeAttentionLeaseSenderLabel(queueMessage: QueueMessageRecord['payload']) {
  const rawPayload = queueMessage.rawPayload || {};
  const senderName = typeof rawPayload.source_sender_name === 'string' && rawPayload.source_sender_name.trim()
    ? rawPayload.source_sender_name.trim()
    : typeof rawPayload.latest_sender_name === 'string' && rawPayload.latest_sender_name.trim()
      ? rawPayload.latest_sender_name.trim()
      : '';
  const senderId = typeof rawPayload.source_sender_id === 'string' && rawPayload.source_sender_id.trim()
    ? rawPayload.source_sender_id.trim()
    : typeof rawPayload.latest_sender_id === 'string' && rawPayload.latest_sender_id.trim()
      ? rawPayload.latest_sender_id.trim()
      : '';
  if (senderName && senderId && senderName !== senderId) {
    return `${senderName}(${senderId})`;
  }
  return senderName || senderId || queueMessage.senderName || queueMessage.senderId || '未知发送者';
}

function buildAttentionLeaseTemplateVariables(queueMessage: QueueMessageRecord['payload']) {
  const rawPayload = queueMessage.rawPayload || {};
  const unreadDelta = Number(rawPayload.unread_delta ?? rawPayload.unreadDelta ?? 1) || 1;
  const directMentions = Number(rawPayload.direct_mentions ?? rawPayload.directMentions ?? 0) || 0;
  const focusTarget = typeof rawPayload.focus_target === 'string' && rawPayload.focus_target.trim()
    ? rawPayload.focus_target.trim()
    : queueMessage.chatType === 'direct'
      ? `focus_private ${queueMessage.peerId}`
      : `focus_group ${queueMessage.peerId}`;
  const [focusTargetAction, ...focusTargetIdParts] = focusTarget.split(/\s+/);
  return {
    UNREAD_DELTA: unreadDelta,
    DIRECT_MENTION_COUNT: directMentions,
    LATEST_SENDER_LABEL: normalizeAttentionLeaseSenderLabel(queueMessage),
    LATEST_MESSAGE_PREVIEW: normalizeAttentionLeasePreview(
      rawPayload.source_preview ?? rawPayload.latest_preview ?? queueMessage.rawBody ?? queueMessage.bodyForAgent
    ),
    FOCUS_TARGET_ACTION: focusTargetAction || (queueMessage.chatType === 'direct' ? 'focus_private' : 'focus_group'),
    FOCUS_TARGET_ID: focusTargetIdParts.join(' ') || queueMessage.peerId
  };
}

function renderAttentionLeaseReminder(queueMessage: QueueMessageRecord['payload']) {
  const rawPayload = queueMessage.rawPayload || {};
  const chatLabel = typeof rawPayload.chat_label === 'string' && rawPayload.chat_label.trim()
    ? rawPayload.chat_label.trim()
    : queueMessage.peerName
      ? `${queueMessage.chatType === 'direct' ? '私聊' : '群'} ${queueMessage.peerName}`
      : `${queueMessage.chatType === 'direct' ? '私聊' : '群'} ${queueMessage.peerId}`;
  return formatSystemReminderBlock(renderPromptSnippet('attention_lease_reminder.md', {
    CHAT_LABEL: chatLabel,
    ...buildAttentionLeaseTemplateVariables(queueMessage)
  }));
}

function getSystemReminderText(queueMessage: QueueMessageRecord['payload']) {
  const reminder = typeof queueMessage.systemReminder?.reminder === 'string' && queueMessage.systemReminder.reminder.trim()
    ? queueMessage.systemReminder.reminder.trim()
    : typeof queueMessage.bodyForAgent === 'string'
      ? queueMessage.bodyForAgent.trim()
      : '';
  return reminder;
}

function renderSystemReminder(queueMessage: QueueMessageRecord['payload']) {
  if ((queueMessage.systemReminder?.reason || queueMessage.rawPayload?.reason) === 'attention_lease') {
    return renderAttentionLeaseReminder(queueMessage);
  }
  const reminder = getSystemReminderText(queueMessage);
  return formatSystemReminderBlock(
    reminder || readPromptSnippet('system_reminder_fallback.md')
  );
}

function renderSubconsciousAgentNotifyPayload(queueMessage: QueueMessageRecord['payload']) {
  const reminder = getSystemReminderText(queueMessage);
  if (reminder) {
    return reminder;
  }
  const finalAnswerText = typeof queueMessage.rawPayload?.final_answer_text === 'string'
    ? queueMessage.rawPayload.final_answer_text.trim()
    : '';
  return finalAnswerText
    ? renderSubconsciousAgentNotify(finalAnswerText)
    : '';
}

function buildQueueMessagePayloadForBatchMessage(
  queueMessage: QueueMessageRecord['payload'],
  message: QueueBatchMessage
): QueueMessageRecord['payload'] {
  const messagePhoneNotification = typeof message.rawPayload?.phoneNotification === 'object' && message.rawPayload.phoneNotification
    ? message.rawPayload.phoneNotification as QueueMessageRecord['payload']['phoneNotification']
    : undefined;
  const messageImageTaskNotification = typeof message.rawPayload?.imageTaskNotification === 'object' && message.rawPayload.imageTaskNotification
    ? message.rawPayload.imageTaskNotification as QueueMessageRecord['payload']['imageTaskNotification']
    : undefined;
  const messageSystemReminder = typeof message.rawPayload?.systemReminder === 'object' && message.rawPayload.systemReminder
    ? message.rawPayload.systemReminder as QueueMessageRecord['payload']['systemReminder']
    : undefined;
  return {
    ...queueMessage,
    source: message.source,
    chatType: message.chatType,
    sessionKey: message.sessionKey,
    peerId: message.peerId,
    peerName: message.peerName,
    senderId: message.senderId,
    senderName: message.senderName,
    accountId: message.accountId,
    bodyForAgent: message.bodyForAgent,
    rawBody: message.rawBody,
    commandBody: message.commandBody,
    wasMentioned: message.wasMentioned,
    receivedAt: message.receivedAt,
    messageTimestamp: message.messageTimestamp,
    rawPayload: message.rawPayload,
    inboundContext: message.inboundContext,
    messages: [message],
    ...(messagePhoneNotification ? { phoneNotification: messagePhoneNotification } : {}),
    ...(messageImageTaskNotification ? { imageTaskNotification: messageImageTaskNotification } : {}),
    ...(messageSystemReminder ? { systemReminder: messageSystemReminder } : {}),
    ...(!messagePhoneNotification ? { phoneNotification: undefined } : {}),
    ...(!messageImageTaskNotification ? { imageTaskNotification: undefined } : {}),
    ...(!messageSystemReminder ? { systemReminder: undefined } : {})
  };
}

type CurrentBucketMessageTemplateKind =
  | 'deleted_final_answer_reminder'
  | 'subconscious_agent_notify'
  | 'system_reminder'
  | 'image_task_notification'
  | 'phone_notification'
  | 'conversation_input';

function classifyCurrentBucketMessageTemplate(queueMessage: QueueMessageRecord['payload']) {
  if (isDeletedFinalAnswerReminderPayload(queueMessage)) {
    return 'deleted_final_answer_reminder';
  }
  if (isSubconsciousAgentNotifyPayload(queueMessage)) {
    return 'subconscious_agent_notify';
  }
  if (isSystemReminderPayload(queueMessage)) {
    return 'system_reminder';
  }
  if (isImageTaskNotificationPayload(queueMessage)) {
    return 'image_task_notification';
  }
  if (isPhoneNotificationPayload(queueMessage)) {
    return 'phone_notification';
  }
  return 'conversation_input';
}

function getPhoneNotificationForBatchMessage(message: QueueBatchMessage) {
  return typeof message.rawPayload?.phoneNotification === 'object' && message.rawPayload.phoneNotification
    ? message.rawPayload.phoneNotification as QueueMessageRecord['payload']['phoneNotification']
    : undefined;
}

function buildPhoneNotificationPayloadForBatchMessages(
  queueMessage: QueueMessageRecord['payload'],
  messages: QueueBatchMessage[]
): QueueMessageRecord['payload'] {
  const latest = messages[messages.length - 1];
  const basePayload = buildQueueMessagePayloadForBatchMessage(queueMessage, latest);
  const notifications = messages
    .map((message) => ({
      message,
      notification: getPhoneNotificationForBatchMessage(message)
    }))
    .filter((entry): entry is {
      message: QueueBatchMessage;
      notification: NonNullable<QueueMessageRecord['payload']['phoneNotification']>;
    } => Boolean(entry.notification));
  const latestNotification = notifications[notifications.length - 1]?.notification || basePayload.phoneNotification || queueMessage.phoneNotification;
  const uniqueNotifications = new Map<string, NonNullable<QueueMessageRecord['payload']['phoneNotification']>>();
  for (const { message, notification } of notifications) {
    uniqueNotifications.set(notification.notificationId || message.messageSid || String(message.queueMessageId), notification);
  }
  const unreadDelta = uniqueNotifications.size > 0
    ? Array.from(uniqueNotifications.values()).reduce((sum, notification) => sum + Math.max(1, Number(notification.unreadDelta || 1)), 0)
    : Math.max(1, Number(queueMessage.phoneNotification?.unreadDelta || basePayload.phoneNotification?.unreadDelta || 0), messages.length);
  const directMentions = uniqueNotifications.size > 0
    ? Array.from(uniqueNotifications.values()).reduce((sum, notification) => sum + Math.max(0, Number(notification.directMentions || 0)), 0)
    : Math.max(0, Number(queueMessage.phoneNotification?.directMentions || basePayload.phoneNotification?.directMentions || 0));

  return {
    ...basePayload,
    source: 'phone_notification',
    bodyForAgent: messages.map((message) => message.bodyForAgent).join('\n'),
    rawBody: messages.map((message) => message.rawBody).join('\n'),
    commandBody: messages.map((message) => message.commandBody).join('\n'),
    wasMentioned: messages.some((message) => message.wasMentioned),
    messages,
    ...(latestNotification
      ? {
          phoneNotification: {
            ...latestNotification,
            unreadDelta,
            directMentions
          }
        }
      : { phoneNotification: undefined })
  };
}

function renderCurrentBucketMessage(queueMessage: QueueMessageRecord['payload']) {
  if (isDeletedFinalAnswerReminderPayload(queueMessage)) {
    return '';
  }
  if (isSubconsciousAgentNotifyPayload(queueMessage)) {
    return renderSubconsciousAgentNotifyPayload(queueMessage);
  }
  if (isSystemReminderPayload(queueMessage)) {
    return renderSystemReminder(queueMessage);
  }
  if (isImageTaskNotificationPayload(queueMessage)) {
    return renderImageTaskNotification(queueMessage);
  }
  if (isPhoneNotificationPayload(queueMessage)) {
    return renderPhoneNotification(queueMessage);
  }
  return renderConversationInput(queueMessage);
}

function buildCurrentBucketMessageParts(queueMessage: QueueMessageRecord['payload']) {
  const messages = Array.isArray(queueMessage.messages) ? queueMessage.messages : [];
  if (messages.length <= 1) {
    const rendered = renderCurrentBucketMessage(queueMessage);
    return rendered.trim() ? [rendered] : [];
  }

  const groupedMessages: Array<{
    kind: CurrentBucketMessageTemplateKind;
    messages: QueueBatchMessage[];
  }> = [];
  for (const message of messages) {
    const messagePayload = buildQueueMessagePayloadForBatchMessage(queueMessage, message);
    const kind = classifyCurrentBucketMessageTemplate(messagePayload);
    const previous = groupedMessages[groupedMessages.length - 1];
    if (kind === 'phone_notification' && previous?.kind === kind) {
      previous.messages.push(message);
      continue;
    }
    groupedMessages.push({ kind, messages: [message] });
  }

  return groupedMessages
    .map((group) => {
      if (group.kind === 'phone_notification' && group.messages.length > 1) {
        return renderCurrentBucketMessage(buildPhoneNotificationPayloadForBatchMessages(queueMessage, group.messages));
      }
      return group.messages
        .map((message) => renderCurrentBucketMessage(buildQueueMessagePayloadForBatchMessage(queueMessage, message)))
        .join('\n\n');
    })
    .map((message) => message.trim())
    .filter(Boolean);
}

function buildCoreMemoryCompressionReminder(input: {
  contextSessionKey: string;
  readCutoffAfterConversationId: number | null;
  pressureSummary: string;
}) {
  void input.contextSessionKey;
  void input.readCutoffAfterConversationId;
  const item = buildDeveloperInputItem([
    formatSystemReminderBlock(renderPromptSnippet('core_memory_pressure_reminder.md', {
      PRESSURE_SUMMARY: input.pressureSummary,
      COMPRESS_CORE_MEMORY_TOOL: TOOL_NAMES.compressCoreMemory
    }))
  ]);
  Object.defineProperty(item, CORE_MEMORY_COMPRESSION_REMINDER_MARKER, {
    value: true,
    enumerable: false
  });
  return item;
}

function buildCoreMemoryCompressionForkRetryReminder(input: {
  forkTurn: number;
  reason: string;
  retryCount: number;
  maxRetries: number;
}): OpenResponseInputItem {
  return buildDeveloperInputItem([
    formatSystemReminderBlock(renderPromptSnippet('core_memory_compression_fork_retry_reminder.md', {
      FORK_TURN: input.forkTurn,
      REASON: input.reason,
      RETRY_COUNT: input.retryCount,
      MAX_RETRIES: input.maxRetries,
      COMPRESS_CORE_MEMORY_TOOL: TOOL_NAMES.compressCoreMemory
    }))
  ]);
}

function flattenMessageContent(content: string | OpenResponseInputContentPart[]) {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .map((part) => {
      if (part.type === 'input_text' || part.type === 'output_text') {
        return part.text;
      }
      if (part.type === 'refusal') {
        return part.refusal;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

const CONTEXT_COMPRESSION_TOOL_CONTRACT = [
  '你正在审视一批即将从上下文窗口中永久移除的对话历史。',
  '这是这批对话最后一次被完整看见的机会。',
  '',
  '你的任务：判断这批对话里有没有值得长期保留的内容。',
  '大多数普通对话批次不包含任何值得写入长期记忆的内容——这种情况直接 should_persist=false，流程结束。',
  '',
  '只有以下情况才值得写入：',
  '- 用户给出了明确的反馈、纠偏、批评或正向肯定，且这个信号在这批对话里是清晰的',
  '- 出现了一次对关系有结构性影响的真实互动（不是泛化结论，是具体的、可复现的情境）',
  '- 这批对话里有一个清晰的新结论，改变了以后在类似场景下怎么在场的判断',
  '',
  '绝对不要写入：',
  '- 普通成功的对话流（没有人给反馈，对话只是正常流经）',
  '- 模型自己的沉默决策（没有外部信号验证的沉默不是学习证据）',
  '- 对已知规则的再次确认（如"被点名要回应"、"不要发没营养的话"）',
  '- 只是有趣的话题或讨论，没有反馈方向',
  '',
  '如果有值得写入的内容：每次只写一条最重要的 reflection，不批量写入。',
  '如果没有值得写入的内容：不要调用工具，也不要写额外说明。',
  'reflection 是从即将被压缩的上下文里提炼出的经验；learning_state 只维护同一 learning_key / learning_scope 下当前更活跃或有冲突的状态。',
  '记忆不是规则，是经历。summary_text 用第一人称转述具体发生了什么，不要把用户消息原文嵌入 summary_text 或 retrieval_text。',
  'embedding_text 要包含社交语境类型词（如 topic_opener 询问、emotional_confrontation 质疑），让向量检索能按社交语境区分召回。',
  '分数必须保守，且统一使用 0.0–1.0 浮点数（0.7 = 有合理证据，0.9 = 非常清晰的外部信号）。',
  '输出只通过工具完成，不写自然语言说明。'
].join('\n');

function composeContextCompressionSystemPrompt(systemPrompt: string) {
  return appendRuntimePromptSection(
    systemPrompt.trim(),
    'Context compression memory subagent runtime contract:',
    CONTEXT_COMPRESSION_TOOL_CONTRACT
  );
}

function buildContextCompressionFeedbackWriterInput(params: {
  evictedTurns: ConversationTurn[];
  runtimePrompt: ResolvedAgentRuntimePrompt;
}): OpenResponseInputItem[] {
  const turnLines = params.evictedTurns.map((turn) => {
    const userLine = `用户: ${turn.userMessage || '(无消息内容)'}`;
    const aiLine = turn.aiResponse
      ? `小腻: ${turn.aiResponse}`
      : `小腻: (未发送消息)`;
    return `[对话 #${turn.id}]\n${userLine}\n${aiLine}`;
  });

  const header = [
    `[即将从上下文窗口移除的对话历史 (${params.evictedTurns.length} 条)]`,
    '[这批对话将不再出现在未来的上下文中，请判断是否有值得长期保存的内容]'
  ].join('\n');

  return [
    {
      type: 'message',
      role: 'system',
      content: composeContextCompressionSystemPrompt(params.runtimePrompt.systemPrompt)
    },
    buildUserSceneInputItem([[header, ...turnLines].join('\n\n')])
  ];
}

const COMPACT_MEMORY_EPISODIC_CONTRACT = [
  '你在为小腻的长期召回写 episodic observations。',
  '目标：保留未来能帮助小腻想起“当时发生了什么、谁怎么说、小腻在场上处于什么位置”的具体片段。',
  '成功标准：每条 observation 必须来自当前这批即将移出上下文的对话；要短、具体、可召回，带话题钩子和参与者。',
  '不要把 absence 当证据；不要从一次沉默推导长期性格；不要写行为规则、人格设定、泛泛总结。',
  '如果没有值得未来召回的具体片段，调用工具并返回空 observations。'
].join('\n');

const COMPACT_MEMORY_SEMANTIC_CONTRACT = [
  '你在为小腻的长期召回写 semantic assertions。',
  '目标：保留未来回答实体、项目、状态、计划、事实性问题，或恢复“谁说过/谁认为/谁计划了什么”时有用的客观断言。',
  '成功标准：只写可从对话文本直接支持的事实、当前状态、一次性事件、计划或明确 claim；每条都要能回到 source_turn_ids，并保留 owner / directed_to / scope。',
  '如果原文能识别说话人、被回复对象、@对象或小腻的位置，text 和 evidence_summary 必须写清楚；禁止把可识别的人压成“群里”“有人”“大家”。',
  'scope=group 只用于真正群体共同事实；多数单人发言应是 person/topic，人与人之间的说法应是 dyad。',
  '不要写氛围、态度、关系判断、猜测、人格化解释；这些属于 episodic 或 reflection。不要写小腻未来应该怎么做。',
  '如果没有客观断言，调用工具并返回空 assertions。'
].join('\n');

const COMPACT_MEMORY_REFLECTION_CONTRACT = [
  '你在为小腻的长期召回写 reflection memories。',
  '目标：从已经落库的 episodic observations 中提炼跨时间模式，用于帮助小腻保持自己、理解人物、理解二人关系、群体事实或项目弧线。',
  '成功标准：每条 reflection 至少引用 2 条 source_observation_ids；必须是证据重复出现后的抽象，不是新事实，并且要有稳定主体。',
  '优先写 person_pattern、dyad_pattern、self_continuity、xiaoni_perception；只有证据确实覆盖多人且不是单个说话人的意见时才写 group_norm。',
  'text 要回答“谁持续怎样看/说/对待谁或什么”；self_continuity_note 只写这对小腻保持自己有什么意义，不写未来行为指令。',
  '禁止把一次事件提升成长期规则；不要从缺席、沉默、没发生的事推导结论；禁止写“后续应该少说/换口吻/接梗/避免解答腔”这类行为政策。',
  '如果 evidence 不足，调用工具并返回空 reflections。'
].join('\n');

function composeCompactMemorySystemPrompt(params: {
  systemPrompt: string;
  layer: CompactMemoryLayer;
}) {
  const contract = params.layer === 'episodic'
    ? COMPACT_MEMORY_EPISODIC_CONTRACT
    : params.layer === 'semantic'
    ? COMPACT_MEMORY_SEMANTIC_CONTRACT
    : COMPACT_MEMORY_REFLECTION_CONTRACT;
  return appendRuntimePromptSection(
    params.systemPrompt.trim(),
    `Compact memory ${params.layer} writer contract:`,
    contract
  );
}

function extractTaggedSender(content: string) {
  const match = content.match(/\bsender="([^"]+)"/);
  return match ? match[1] : '';
}

function renderEvictedTurnForCompactMemory(turn: ConversationTurn) {
  const itemLines = (Array.isArray(turn.items) ? turn.items : [])
    .map((item, index) => {
      const role = item.role === 'assistant' ? '小腻' : '群友';
      const taggedSender = extractTaggedSender(String(item.content || ''));
      const actor = taggedSender || (item.role === 'assistant' ? '小腻(1129974489)' : `群友(${turn.userId})`);
      const messageId = Number.isFinite(Number(item.deliveryMessageId)) ? ` message_id=${item.deliveryMessageId}` : '';
      const source = typeof item.source === 'string' && item.source ? ` source=${item.source}` : '';
      const content = String(item.content || '').trim();
      return content ? `${index + 1}. role=${role} actor=${actor}${messageId}${source}: ${content}` : '';
    })
    .filter(Boolean);
  const fallback = [
    `群友(${turn.userId}): ${turn.userMessage || '(无消息内容)'}`,
    `小腻: ${turn.aiResponse || '(未发送消息)'}`
  ];
  return [
    `[turn_id=${turn.id} user_id=${turn.userId}${turn.groupId ? ` group_id=${turn.groupId}` : ''}]`,
    ...(itemLines.length > 0 ? itemLines : fallback)
  ].join('\n');
}

function buildCompactMemoryWriterInput(params: {
  layer: 'episodic' | 'semantic';
  evictedTurns: ConversationTurn[];
  runtimePrompt: ResolvedAgentRuntimePrompt;
}): OpenResponseInputItem[] {
  const header = [
    `[即将从上下文窗口移除的对话历史 (${params.evictedTurns.length} 条)]`,
    `任务层：${params.layer}`,
    '只从下面证据写入；没有合格内容也必须调用对应工具并返回空数组。'
  ].join('\n');

  return [
    {
      type: 'message',
      role: 'system',
      content: composeCompactMemorySystemPrompt({
        systemPrompt: params.runtimePrompt.systemPrompt,
        layer: params.layer
      })
    },
    buildUserSceneInputItem([[header, ...params.evictedTurns.map(renderEvictedTurnForCompactMemory)].join('\n\n')])
  ];
}

function buildCompactMemoryReflectionInput(params: {
  observations: PersistedMemoryObservation[];
  runtimePrompt: ResolvedAgentRuntimePrompt;
}): OpenResponseInputItem[] {
  const observationLines = params.observations.map((observation) => [
    `[observation_id=${observation.id}] topic=${observation.topic}`,
    `participants=${JSON.stringify(observation.participants)} xiaoni_role=${observation.xiaoniRole}`,
    `source_turn_ids=${JSON.stringify(observation.sourceTurnIds)} source_message_ids=${JSON.stringify(observation.sourceMessageIds)}`,
    observation.text
  ].join('\n'));
  const header = [
    `[本批刚写入的 episodic observations (${params.observations.length} 条)]`,
    '任务层：reflection',
    '只允许从这些 observations 中抽象；证据不足也必须调用对应工具并返回空数组。'
  ].join('\n');

  return [
    {
      type: 'message',
      role: 'system',
      content: composeCompactMemorySystemPrompt({
        systemPrompt: params.runtimePrompt.systemPrompt,
        layer: 'reflection'
      })
    },
    buildUserSceneInputItem([[header, ...observationLines].join('\n\n')])
  ];
}

function uniquePositiveNumbers(values: unknown[]): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const value of values) {
    const normalized = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(normalized) || normalized <= 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function buildQueueMessageFeedbackWriterEvidence(
  queueMessage: QueueMessageRecord['payload'],
  conversationId: number
): FeedbackWriterEvidence {
  return {
    sourceMessageIds: uniquePositiveNumbers(queueMessage.messages.map((message) => message.messageId)),
    sourceConversationId: conversationId,
    sourceUserId: parseOptionalInteger(queueMessage.senderId),
    sourceUserName: typeof queueMessage.senderName === 'string' ? queueMessage.senderName : null,
    metadata: {},
    writerSource: FEEDBACK_MEMORY_SUBAGENT_TYPE
  };
}

function buildContextCompressionFeedbackWriterEvidence(params: {
  evictedTurns: ConversationTurn[];
}): FeedbackWriterEvidence {
  const evictedTurnIds = uniquePositiveNumbers(params.evictedTurns.map((turn) => turn.id));
  const sourceMessageIds = uniquePositiveNumbers(params.evictedTurns.flatMap((turn) => (
    (Array.isArray(turn.items) ? turn.items : [])
      .filter((item) => item.role === 'user')
      .map((item) => item.deliveryMessageId)
  )));
  const sourceUserIds = uniquePositiveNumbers(params.evictedTurns.map((turn) => turn.userId));

  return {
    sourceMessageIds,
    sourceConversationId: evictedTurnIds.length === 1 ? evictedTurnIds[0]! : null,
    sourceUserId: sourceUserIds.length === 1 ? sourceUserIds[0]! : null,
    sourceUserName: null,
    metadata: {
      evicted_turn_ids: evictedTurnIds,
      evidence_source: 'context_compression_evicted_turns'
    },
    writerSource: CONTEXT_COMPRESSION_MEMORY_SUBAGENT_TYPE
  };
}

function buildSourceMessageIdsByTurnId(evictedTurns: ConversationTurn[]) {
  const result = new Map<number, number[]>();
  for (const turn of evictedTurns) {
    const ids = uniquePositiveNumbers(
      (Array.isArray(turn.items) ? turn.items : [])
        .filter((item) => item.role === 'user')
        .map((item) => item.deliveryMessageId)
    );
    result.set(turn.id, ids);
  }
  return result;
}

function collectSourceMessageIds(sourceTurnIds: number[], messageIdsByTurnId: Map<number, number[]>) {
  return uniquePositiveNumbers(sourceTurnIds.flatMap((turnId) => messageIdsByTurnId.get(turnId) || []));
}

function composeSystemPrompt(
  systemPrompt: string,
  chatType: 'group' | 'direct'
) {
  void chatType;
  return systemPrompt.trim();
}

function extractLiveSurfaceAnchors(queueMessage: QueueMessageRecord['payload']) {
  return queueMessage.messages
    .map((message) => normalizeTranscriptMessageText(message.bodyForAgent || '', message.inboundContext.MentionedUsers))
    .filter(Boolean)
    .slice(-3)
    .map((text) => text.length > 28 ? text.slice(0, 28) : text);
}

function stripJsonCodeFence(text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractMessageText(item: OpenResponseInputItem) {
  if (!isOpenResponseMessageInputItem(item)) return '';
  if (typeof item.content === 'string') return item.content.trim();
  return item.content
    .map((part) => {
      if ((part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string') {
        return part.text.trim();
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function normalizePendingShare(value: string | null | undefined) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function appendPendingShareToXiaoniOs(xiaoniOs: string | null, pendingShare: string | null) {
  const share = normalizePendingShare(pendingShare);
  const os = typeof xiaoniOs === 'string' && xiaoniOs.trim().length > 0 ? xiaoniOs.trim() : '';
  if (!share) {
    return os || null;
  }

  const line = `我想回头分享这个：${share}`;
  if (os.includes('我想回头分享这个') && os.includes(share)) {
    return os;
  }
  return os ? `${os}\n${line}` : line;
}

function parseOptionalBoolean(value: unknown) {
  return typeof value === 'boolean' ? value : null;
}

function parseOptionalInteger(value: unknown) {
  const normalized = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return null;
  }
  return normalized;
}

function parseUnreadMeaning(value: unknown): UnreadMeaning | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const latestUnreadFocus = typeof (record.latest_unread_focus ?? record.latestUnreadFocus) === 'string'
    ? String(record.latest_unread_focus ?? record.latestUnreadFocus).trim()
    : '';
  const rawMessageAct = record.message_act ?? record.messageAct;
  const rawSocialTarget = record.social_target ?? record.socialTarget;
  const addressedToMe = parseOptionalBoolean(record.addressed_to_me ?? record.addressedToMe);
  const hasRealNovelty = parseOptionalBoolean(record.has_real_novelty ?? record.hasRealNovelty);
  const rawConfidence = record.confidence;
  const rawReason = record.reason;
  const messageAct = rawMessageAct === 'statement'
    || rawMessageAct === 'question'
    || rawMessageAct === 'joke'
    || rawMessageAct === 'tease'
    || rawMessageAct === 'feedback'
    || rawMessageAct === 'reaction'
    || rawMessageAct === 'request'
    || rawMessageAct === 'unclear'
    ? rawMessageAct
    : null;
  const socialTarget = rawSocialTarget === 'me'
    || rawSocialTarget === 'someone_else'
    || rawSocialTarget === 'group'
    || rawSocialTarget === 'unclear'
    ? rawSocialTarget
    : null;
  const confidence = rawConfidence === 'low' || rawConfidence === 'medium' || rawConfidence === 'high'
    ? rawConfidence
    : null;
  const reason = typeof rawReason === 'string' && rawReason.trim()
    ? rawReason.trim()
    : latestUnreadFocus;

  const rawSocialActType = record.social_act_type ?? record.socialActType;
  const socialActType: UnreadMeaningSocialActType | null = rawSocialActType === 'invitation_curiosity'
    || rawSocialActType === 'emotional_release'
    || rawSocialActType === 'relationship_probe'
    || rawSocialActType === 'concrete_request'
    || rawSocialActType === 'yes_no_reaction'
    || rawSocialActType === 'casual_remark'
    ? rawSocialActType
    : null;

  const rawTopicCtx = record.topic_context ?? record.topicContext;
  let topicContext: UnreadMeaningTopicContext | null = null;
  if (rawTopicCtx && typeof rawTopicCtx === 'object' && !Array.isArray(rawTopicCtx)) {
    const tc = rawTopicCtx as Record<string, unknown>;
    const hasTopic = parseOptionalBoolean(tc.has_topic ?? tc.hasTopic);
    const topicSummary = typeof tc.topic_summary === 'string' ? tc.topic_summary.trim() || null
      : typeof tc.topicSummary === 'string' ? tc.topicSummary.trim() || null
      : null;
    const tcAddressedToMe = parseOptionalBoolean(tc.addressed_to_me ?? tc.addressedToMe);
    if (hasTopic !== null && tcAddressedToMe !== null) {
      topicContext = { hasTopic, topicSummary, addressedToMe: tcAddressedToMe };
    }
  }

  if (!latestUnreadFocus || !messageAct || !socialTarget || addressedToMe === null || hasRealNovelty === null || !confidence || !reason) {
    return null;
  }

  return {
    latestUnreadFocus,
    messageAct,
    socialTarget,
    addressedToMe,
    hasRealNovelty,
    confidence,
    reason,
    socialActType,
    topicContext
  };
}

function serializeUnreadMeaning(meaning: UnreadMeaning | null) {
  if (!meaning) {
    return null;
  }
  return {
    latest_unread_focus: meaning.latestUnreadFocus,
    message_act: meaning.messageAct,
    social_target: meaning.socialTarget,
    addressed_to_me: meaning.addressedToMe,
    has_real_novelty: meaning.hasRealNovelty,
    confidence: meaning.confidence,
    reason: meaning.reason,
    ...(meaning.socialActType !== null ? { social_act_type: meaning.socialActType } : {}),
    ...(meaning.topicContext !== null ? { topic_context: meaning.topicContext } : {})
  };
}

function parseFeedbackReflectionSynthesis(value: unknown): FeedbackReflectionSynthesis | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const learningKey = typeof (record.learning_key ?? record.learningKey) === 'string'
    ? String(record.learning_key ?? record.learningKey).trim()
    : '';
  const learningScope = typeof (record.learning_scope ?? record.learningScope) === 'string'
    ? String(record.learning_scope ?? record.learningScope).trim()
    : '';
  const reflectionType = (record.reflection_type ?? record.reflectionType);
  const feedbackKind = record.feedback_kind ?? record.feedbackKind;
  const confidence = record.confidence;
  const summaryText = typeof (record.summary_text ?? record.summaryText) === 'string'
    ? String(record.summary_text ?? record.summaryText).trim()
    : '';
  const retrievalText = typeof (record.retrieval_text ?? record.retrievalText) === 'string'
    ? String(record.retrieval_text ?? record.retrievalText).trim()
    : '';
  const embeddingText = typeof (record.embedding_text ?? record.embeddingText) === 'string'
    ? String(record.embedding_text ?? record.embeddingText).trim()
    : '';
  const supersedeLatest = parseOptionalBoolean(record.supersede_latest ?? record.supersedeLatest);
  const conflictGroupKeyRaw = record.conflict_group_key ?? record.conflictGroupKey;
  const conflictGroupKey = typeof conflictGroupKeyRaw === 'string' && conflictGroupKeyRaw.trim()
    ? conflictGroupKeyRaw.trim()
    : null;
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';

  const normalizedReflectionType = reflectionType === 'semantic_lesson' || reflectionType === 'social_lesson' || reflectionType === 'self_model_update'
    ? reflectionType
    : null;
  const normalizedFeedbackKind = feedbackKind === 'positive' || feedbackKind === 'negative' || feedbackKind === 'mixed'
    ? feedbackKind
    : null;
  const normalizedConfidence = confidence === 'low' || confidence === 'medium' || confidence === 'high'
    ? confidence
    : null;
  const importanceScore = Number(record.importance_score ?? record.importanceScore);
  const evidenceWeight = Number(record.evidence_weight ?? record.evidenceWeight);
  const stabilityScore = Number(record.stability_score ?? record.stabilityScore);

  if (!learningKey || !learningScope || !normalizedReflectionType || !normalizedFeedbackKind || !normalizedConfidence || !summaryText || !retrievalText || !embeddingText || supersedeLatest === null || !Number.isFinite(importanceScore) || !Number.isFinite(evidenceWeight) || !Number.isFinite(stabilityScore) || !reason) {
    return null;
  }

  return {
    learningKey,
    learningScope,
    reflectionType: normalizedReflectionType,
    feedbackKind: normalizedFeedbackKind,
    confidence: normalizedConfidence,
    importanceScore,
    evidenceWeight,
    stabilityScore,
    summaryText,
    retrievalText,
    embeddingText,
    supersedeLatest,
    conflictGroupKey,
    reason
  };
}

function parseFeedbackLearningStateCandidate(value: unknown): FeedbackLearningStateCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const stateType = record.state_type ?? record.stateType;
  const activateNewReflection = parseOptionalBoolean(record.activate_new_reflection ?? record.activateNewReflection);
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  const activationWeight = Number(record.activation_weight ?? record.activationWeight);
  const recencyWeight = Number(record.recency_weight ?? record.recencyWeight);
  const importanceWeight = Number(record.importance_weight ?? record.importanceWeight);
  const sourceWeight = Number(record.source_weight ?? record.sourceWeight);
  const conflictPenalty = Number(record.conflict_penalty ?? record.conflictPenalty);
  const normalizedStateType = stateType === 'reinforced' || stateType === 'tentative' || stateType === 'conflicted' || stateType === 'revised'
    ? stateType
    : null;

  if (!normalizedStateType || activateNewReflection === null || !Number.isFinite(activationWeight) || !Number.isFinite(recencyWeight) || !Number.isFinite(importanceWeight) || !Number.isFinite(sourceWeight) || !Number.isFinite(conflictPenalty) || !reason) {
    return null;
  }

  return {
    stateType: normalizedStateType,
    activationWeight,
    recencyWeight,
    importanceWeight,
    sourceWeight,
    conflictPenalty,
    activateNewReflection,
    reason
  };
}

function parseRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is Record<string, unknown> => (
    Boolean(item) && typeof item === 'object' && !Array.isArray(item)
  ));
}

function parseBoundedInteger(value: unknown, min: number, max: number, fallback: number) {
  const normalized = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(normalized)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(normalized)));
}

function parsePositiveIntegerArray(value: unknown, maxItems = 20) {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniquePositiveNumbers(value).slice(0, maxItems);
}

function isXiaoniParticipant(qqId: string, name: string) {
  const botAccountId = agentConfig.botAccountId || '1129974489';
  const normalizedName = name.replace(/\s+/g, '');
  return qqId === botAccountId
    || normalizedName === '小腻'
    || normalizedName === `小腻(${botAccountId})`
    || normalizedName === `小腻（${botAccountId}）`;
}

function normalizeCompactMemoryQqId(value: string) {
  const normalized = value.trim();
  return normalized === '未知' || /^unknown$/i.test(normalized) || /^null$/i.test(normalized) || /^none$/i.test(normalized)
    ? ''
    : normalized;
}

function isMalformedCompactMemoryParticipantName(value: string) {
  const normalized = value.trim();
  return !normalized
    || /[{}]/.test(normalized)
    || /^unknown$/i.test(normalized)
    || /^群友$/i.test(normalized)
    || normalized === '未知';
}

function isNonSpecificCompactMemoryParticipantName(value: string) {
  const normalized = value.trim().replace(/\s+/g, '');
  return normalized === '主人' || normalized === '某人' || normalized === '有人' || normalized === '用户';
}

function normalizeParticipantLookupName(value: string) {
  return value.trim().replace(/\s+/g, '').toLowerCase();
}

function canonicalizeCompactMemoryAliasText(value: string) {
  return value
    .replace(/给你的\s*AI\s*一个世界去生活/g, '龙哥')
    .replace(/\bKisin\b/g, '闻震');
}

function canonicalizeCompactMemorySubject(value: string) {
  const trimmed = value.trim();
  const compact = trimmed.replace(/\s+/g, '');
  if (/^Kisin$/i.test(trimmed)) {
    return '闻震';
  }
  if (compact === '给你的AI一个世界去生活') {
    return '龙哥';
  }
  if (/^novalattice\.online$/i.test(trimmed)) {
    return 'Nova';
  }
  if (trimmed === '还有这种事') {
    return '一条大野狗';
  }
  return canonicalizeCompactMemoryAliasText(trimmed);
}

function canonicalCompactMemoryParticipant(participant: CompactMemoryParticipant): CompactMemoryParticipant {
  const qqId = normalizeCompactMemoryQqId(participant.qq_id);
  const name = participant.name.trim();
  if (isXiaoniParticipant(qqId, name)) {
    return { qq_id: agentConfig.botAccountId || '1129974489', name: '小腻' };
  }
  return { qq_id: qqId, name };
}

function parseParticipantLabel(value: string): CompactMemoryParticipant | null {
  const match = value.trim().match(/^(.+?)[(（]\s*(\d+)\s*[)）]$/);
  if (!match) {
    return null;
  }
  const name = match[1].trim();
  const qqId = normalizeCompactMemoryQqId(match[2].trim());
  if (!qqId || isMalformedCompactMemoryParticipantName(name)) {
    return null;
  }
  return canonicalCompactMemoryParticipant({ qq_id: qqId, name });
}

function addParticipantDirectoryEntry(
  directory: Map<string, CompactMemoryParticipant | null>,
  participant: CompactMemoryParticipant | null
) {
  if (!participant) {
    return;
  }
  const canonical = canonicalCompactMemoryParticipant(participant);
  if (!canonical.qq_id || isMalformedCompactMemoryParticipantName(canonical.name)) {
    return;
  }
  directory.set(`qq:${canonical.qq_id}`, canonical);
  const nameKey = `name:${normalizeParticipantLookupName(canonical.name)}`;
  const existing = directory.get(nameKey);
  if (typeof existing === 'undefined') {
    directory.set(nameKey, canonical);
  } else if (existing && existing.qq_id !== canonical.qq_id) {
    directory.set(nameKey, null);
  }
}

function buildCompactMemoryParticipantDirectory(evictedTurns: ConversationTurn[]) {
  const directory = new Map<string, CompactMemoryParticipant | null>();
  addParticipantDirectoryEntry(directory, { qq_id: agentConfig.botAccountId || '1129974489', name: '小腻' });
  for (const turn of evictedTurns) {
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      if (item.role === 'assistant') {
        addParticipantDirectoryEntry(directory, { qq_id: agentConfig.botAccountId || '1129974489', name: '小腻' });
      }
      const content = String(item.content || '');
      for (const match of content.matchAll(/\b(?:sender|private_peer)="([^"]+)"/g)) {
        addParticipantDirectoryEntry(directory, parseParticipantLabel(match[1]));
      }
    }
  }
  return directory;
}

function normalizeCompactMemoryParticipant(
  participant: CompactMemoryParticipant,
  directory: Map<string, CompactMemoryParticipant | null>
) {
  const canonical = canonicalCompactMemoryParticipant(participant);
  if (isMalformedCompactMemoryParticipantName(canonical.name)) {
    return null;
  }
  const byQq = canonical.qq_id ? directory.get(`qq:${canonical.qq_id}`) : null;
  if (byQq) {
    return byQq;
  }
  const byName = canonical.name ? directory.get(`name:${normalizeParticipantLookupName(canonical.name)}`) : null;
  if (byName && (!canonical.qq_id || canonical.qq_id === byName.qq_id)) {
    return byName;
  }
  if (!canonical.qq_id) {
    return null;
  }
  return canonical;
}

function normalizeCompactMemoryParticipants(
  participants: CompactMemoryParticipant[],
  directory: Map<string, CompactMemoryParticipant | null>
) {
  const seen = new Set<string>();
  const result: CompactMemoryParticipant[] = [];
  for (const participant of participants) {
    const normalized = normalizeCompactMemoryParticipant(participant, directory);
    if (!normalized) {
      continue;
    }
    const key = normalized.qq_id ? `qq:${normalized.qq_id}` : `name:${normalizeParticipantLookupName(normalized.name)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function parseParticipantArray(value: unknown) {
  return parseRecordArray(value)
    .map((item) => {
      const qqId = typeof (item.qq_id ?? item.qqId) === 'string'
        ? normalizeCompactMemoryQqId(String(item.qq_id ?? item.qqId))
        : normalizeCompactMemoryQqId(String(item.qq_id ?? item.qqId ?? ''));
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (isXiaoniParticipant(qqId, name)) {
        return { qq_id: agentConfig.botAccountId || '1129974489', name: '小腻' };
      }
      if (isMalformedCompactMemoryParticipantName(name) || (!qqId && isNonSpecificCompactMemoryParticipantName(name))) {
        return null;
      }
      return qqId || name ? { qq_id: qqId, name } : null;
    })
    .filter((item): item is CompactMemoryParticipant => Boolean(item))
    .slice(0, 12);
}

function parseEntityArray(value: unknown) {
  return parseRecordArray(value)
    .map((item) => {
      const kind = item.kind === 'person'
        || item.kind === 'project'
        || item.kind === 'concept'
        || item.kind === 'place'
        || item.kind === 'url'
        || item.kind === 'other'
        ? item.kind
        : 'other';
      const entityValue = typeof item.value === 'string'
        ? canonicalizeCompactMemoryAliasText(item.value.trim())
        : '';
      return entityValue ? { kind, value: entityValue } : null;
    })
    .filter((item): item is { kind: string; value: string } => Boolean(item))
    .slice(0, 8);
}

function isMalformedCompactMemoryText(...values: string[]) {
  const normalized = values.filter(Boolean).join('\n').toLowerCase();
  return /\bneed\s+remove\b/.test(normalized)
    || /\bremove\s+this\b/.test(normalized)
    || /\bmalformed\s+(assertion|reflection|memory|record)\b/.test(normalized)
    || /\?\s*no\s*$/i.test(values.find(Boolean) || '');
}

function containsFutureBehaviorPolicy(value: string) {
  const normalized = value.replace(/\s+/g, '');
  return /后续(应该|要|需要)/.test(normalized)
    || /以后(应该|要|需要)/.test(normalized)
    || /未来(应该|要|需要)/.test(normalized)
    || /少(说|回)点?话/.test(normalized)
    || /不用每条都回/.test(normalized)
    || /不要每条都回/.test(normalized)
    || /(应该|要|需要).*换口吻/.test(normalized)
    || /换口吻.*(应该|要|需要)/.test(normalized)
    || /(应该|要|需要).*接梗/.test(normalized)
    || /接梗.*(应该|要|需要)/.test(normalized)
    || /(应该|要|需要|避免).*解答腔/.test(normalized);
}

function parseCompactMemoryEvidenceTime(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const year = date.getUTCFullYear();
  return year >= 2020 && year <= 2035 ? trimmed : null;
}

function parseCompactMemoryObservations(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  return parseRecordArray((value as Record<string, unknown>).observations).map((item) => {
    const topic = typeof item.topic === 'string' ? item.topic.trim() : '';
    const text = typeof item.text === 'string' ? canonicalizeCompactMemoryAliasText(item.text.trim()) : '';
    const xiaoniRole = item.xiaoni_role === 'speaker'
      || item.xiaoni_role === 'directly_addressed'
      || item.xiaoni_role === 'mentioned_or_evaluated'
      || item.xiaoni_role === 'bystander'
      || item.xiaoni_role === 'not_involved'
      ? item.xiaoni_role
      : 'not_involved';
    const sourceTurnIds = parsePositiveIntegerArray(item.source_turn_ids ?? item.sourceTurnIds);
    if (!topic || !text || sourceTurnIds.length === 0 || isMalformedCompactMemoryText(text)) {
      return null;
    }
    return {
      topic,
      text,
      poignancy: parseBoundedInteger(item.poignancy, 1, 10, 1),
      participants: parseParticipantArray(item.participants),
      xiaoniRole,
      sourceTurnIds
    };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function parseCompactMemoryAssertions(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  return parseRecordArray((value as Record<string, unknown>).assertions).map((item) => {
    const text = typeof item.text === 'string' ? canonicalizeCompactMemoryAliasText(item.text.trim()) : '';
    const factType = item.fact_type === 'stable_fact'
      || item.fact_type === 'current_status'
      || item.fact_type === 'one_time_event'
      || item.fact_type === 'stated_plan'
      || item.fact_type === 'claim'
      ? item.fact_type
      : 'claim';
    const scope = item.scope === 'person'
      || item.scope === 'dyad'
      || item.scope === 'group'
      || item.scope === 'topic'
      || item.scope === 'system_state'
      || item.scope === 'self_continuity'
      ? item.scope
      : 'topic';
    const xiaoniRelevance = item.xiaoni_relevance === 'participation_judgment'
      || item.xiaoni_relevance === 'self_position'
      || item.xiaoni_relevance === 'direct_feedback'
      || item.xiaoni_relevance === 'relationship_context'
      || item.xiaoni_relevance === 'topic_knowledge'
      || item.xiaoni_relevance === 'none'
      ? (item.xiaoni_relevance === 'self_position' ? 'participation_judgment' : item.xiaoni_relevance)
      : 'none';
    const evidenceSummary = typeof (item.evidence_summary ?? item.evidenceSummary) === 'string'
      ? canonicalizeCompactMemoryAliasText(String(item.evidence_summary ?? item.evidenceSummary).trim())
      : '';
    const sourceTurnIds = parsePositiveIntegerArray(item.source_turn_ids ?? item.sourceTurnIds);
    if (!text || sourceTurnIds.length === 0 || isMalformedCompactMemoryText(text, evidenceSummary)) {
      return null;
    }
    return {
      text,
      factType,
      scope,
      owners: parseParticipantArray(item.owners ?? item.claim_owners ?? item.claimOwners),
      directedTo: parseParticipantArray(item.directed_to ?? item.directedTo),
      entities: parseEntityArray(item.entities),
      participants: parseParticipantArray(item.participants),
      evidenceSummary,
      xiaoniRelevance,
      sourceTurnIds
    };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function parseCompactMemoryReflections(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  return parseRecordArray((value as Record<string, unknown>).reflections).map((item) => {
    const text = typeof item.text === 'string' ? canonicalizeCompactMemoryAliasText(item.text.trim()) : '';
    const kind = item.kind === 'person_pattern'
      || item.kind === 'dyad_pattern'
      || item.kind === 'group_norm'
      || item.kind === 'project_arc'
      || item.kind === 'self_continuity'
      || item.kind === 'xiaoni_perception'
      ? item.kind
      : item.kind === 'relationship'
      ? 'dyad_pattern'
      : item.kind === 'group_pattern'
      ? 'group_norm'
    : item.kind === 'self_observation'
      || item.kind === 'self_position_continuity'
      ? 'self_continuity'
      : null;
    const evidenceBasis = item.evidence_basis === 'explicit_feedback'
      || item.evidence_basis === 'xiaoni_sayable_points'
      || item.evidence_basis === 'repeated_interactions'
      || item.evidence_basis === 'repeated_group_events'
      ? item.evidence_basis
      : item.evidence_basis === 'xiaoni_utterances'
      || item.evidence_basis === 'xiaoni_positions'
      ? 'xiaoni_sayable_points'
      : item.evidence_basis === 'group_pattern'
      ? 'repeated_group_events'
      : null;
    const evidenceSummary = typeof (item.evidence_summary ?? item.evidenceSummary) === 'string'
      ? canonicalizeCompactMemoryAliasText(String(item.evidence_summary ?? item.evidenceSummary).trim())
      : '';
    const selfContinuityNote = typeof (item.self_continuity_note ?? item.selfContinuityNote) === 'string'
      ? canonicalizeCompactMemoryAliasText(String(item.self_continuity_note ?? item.selfContinuityNote).trim())
      : '';
    const sourceObservationIds = parsePositiveIntegerArray(item.source_observation_ids ?? item.sourceObservationIds, 12);
    if (!text
      || !kind
      || !evidenceBasis
      || sourceObservationIds.length < 2
      || isMalformedCompactMemoryText(text, evidenceSummary, selfContinuityNote)
      || containsFutureBehaviorPolicy(text)
      || containsFutureBehaviorPolicy(evidenceSummary)
      || containsFutureBehaviorPolicy(selfContinuityNote)
    ) {
      return null;
    }
    return {
      text,
      kind,
      subjects: parseCompactMemorySubjectArray(item.subjects),
      subjectParticipants: parseParticipantArray(item.subject_participants ?? item.subjectParticipants),
      objectParticipants: parseParticipantArray(item.object_participants ?? item.objectParticipants),
      evidenceBasis,
      evidenceSummary,
      selfContinuityNote,
      evidenceTimeStart: parseCompactMemoryEvidenceTime(item.evidence_time_start ?? item.evidenceTimeStart),
      evidenceTimeEnd: parseCompactMemoryEvidenceTime(item.evidence_time_end ?? item.evidenceTimeEnd),
      poignancy: parseBoundedInteger(item.poignancy, 1, 10, 1),
      sourceObservationIds
    };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function parseStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, 6);
}

function parseCompactMemorySubjectArray(value: unknown) {
  const seen = new Set<string>();
  const subjects: string[] = [];
  for (const subject of parseStringArray(value)) {
    const canonical = canonicalizeCompactMemorySubject(subject);
    const key = canonical.replace(/\s+/g, '').toLowerCase();
    if (!canonical || seen.has(key)) {
      continue;
    }
    seen.add(key);
    subjects.push(canonical);
  }
  return subjects.slice(0, 6);
}

function buildIdentitySceneText(queueMessage: QueueMessageRecord['payload']) {
  return [
    queueMessage.senderName || '',
    queueMessage.senderId || '',
    queueMessage.peerName || '',
    queueMessage.peerId || '',
    queueMessage.bodyForAgent || '',
    typeof queueMessage.inboundContext?.ReplyToBody === 'string' ? queueMessage.inboundContext.ReplyToBody : '',
    ...queueMessage.messages.map((message) => [
      message.senderName || '',
      message.senderId || '',
      message.bodyForAgent || ''
    ].join(' '))
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .join('\n');
}

function scoreRuntimeIdentityFact(fact: RuntimeAcceptedIdentityFact, sceneText: string) {
  const haystack = sceneText.toLowerCase();
  const tags = fact.activationTags
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  const tagScore = tags.reduce((score, tag) => score + (haystack.includes(tag) ? 2 : 0), 0);
  const confidenceScore = fact.confidence === 'high' ? 2 : fact.confidence === 'medium' ? 1 : 0;
  const typeScore = fact.factType === 'self_boundary' || fact.factType === 'social_lesson' ? 1 : 0;
  return tagScore + confidenceScore + typeScore;
}

function selectRuntimeIdentityFacts(params: {
  facts: RuntimeAcceptedIdentityFact[];
  queueMessage: QueueMessageRecord['payload'];
  limit?: number;
}): RuntimeIdentityFactProjection[] {
  const sceneText = buildIdentitySceneText(params.queueMessage);
  return params.facts
    .filter((fact) => fact.status === 'active' && fact.factText.trim())
    .map((fact) => ({
      fact,
      score: scoreRuntimeIdentityFact(fact, sceneText)
    }))
    .sort((a, b) => b.score - a.score || b.fact.id - a.fact.id)
    .slice(0, params.limit ?? RUNTIME_IDENTITY_FACT_LIMIT)
    .map(({ fact }) => ({
      id: fact.id,
      factKey: fact.factKey,
      factText: fact.factText,
      factType: fact.factType,
      confidence: fact.confidence,
      activationTags: fact.activationTags
    }));
}

function buildIdentitySceneFingerprint(queueMessage: QueueMessageRecord['payload']) {
  const messageIds = queueMessage.messages
    .map((message) => message.messageId || message.messageSid)
    .filter(Boolean)
    .join(',');
  return `${queueMessage.sessionKey}:${messageIds || queueMessage.runId}`;
}

function buildFactKeyFromReflection(reflection: FeedbackReflectionSynthesis) {
  const base = `${reflection.learningScope}:${reflection.learningKey}`
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 150);
  return base ? `feedback.${base}` : `feedback.${uuidv4().slice(0, 12)}`;
}

function judgeFeedbackReflectionAsIdentityFact(reflection: FeedbackReflectionSynthesis) {
  const acceptedConfidence = reflection.confidence === 'high' || reflection.confidence === 'medium';
  // social_lesson type has historically over-promoted silence-biased reflections; require stronger evidence before
  // they become permanent identity facts to avoid a reinforcement spiral
  const stableEnough = reflection.reflectionType === 'social_lesson'
    ? reflection.evidenceWeight >= 0.65 && reflection.stabilityScore >= 0.55 && reflection.importanceScore >= 0.45
    : reflection.evidenceWeight >= 0.45 && reflection.stabilityScore >= 0.35 && reflection.importanceScore >= 0.35;
  const relevantType = reflection.reflectionType === 'self_model_update' || reflection.reflectionType === 'social_lesson';

  if (acceptedConfidence && stableEnough && relevantType) {
    return {
      status: 'accepted',
      judgeStatus: 'accepted',
      integrityStatus: 'accepted',
      reason: 'feedback reflection passed phase1 hard-check judge: supported, stable enough, and identity-relevant'
    } as const;
  }

  return {
    status: 'quarantined',
    judgeStatus: 'quarantined',
    integrityStatus: 'quarantined',
    reason: 'feedback reflection kept as candidate until stronger future evidence supports durable identity change'
  } as const;
}

function parseFeedbackReflectionCandidate(value: unknown): FeedbackReflectionCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const shouldPersist = parseOptionalBoolean(record.should_persist ?? record.shouldPersist);
  const rawFeedbackKind = record.feedback_kind ?? record.feedbackKind;
  const rawConfidence = record.confidence;
  const rawSourceUserScope = record.source_user_scope ?? record.sourceUserScope;
  const summaryText = typeof (record.summary_text ?? record.summaryText) === 'string'
    ? String(record.summary_text ?? record.summaryText).trim()
    : '';
  const retrievalText = typeof (record.retrieval_text ?? record.retrievalText) === 'string'
    ? String(record.retrieval_text ?? record.retrievalText).trim()
    : '';
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  const feedbackKind = rawFeedbackKind === 'positive' || rawFeedbackKind === 'negative' || rawFeedbackKind === 'mixed'
    ? rawFeedbackKind
    : null;
  const confidence = rawConfidence === 'low' || rawConfidence === 'medium' || rawConfidence === 'high'
    ? rawConfidence
    : null;
  const sourceUserScope = rawSourceUserScope === 'current_sender'
    || rawSourceUserScope === 'other'
    || rawSourceUserScope === 'group'
    || rawSourceUserScope === 'unknown'
    ? rawSourceUserScope
    : null;

  if (shouldPersist === null || !feedbackKind || !confidence || !sourceUserScope || !summaryText || !retrievalText || !reason) {
    return null;
  }

  return {
    shouldPersist,
    feedbackKind,
    confidence,
    sourceUserScope,
    summaryText,
    retrievalText,
    reason
  };
}

function buildToolErrorResult(
  toolCall: Pick<AgentToolCall, 'name' | 'callId'>,
  error: unknown
): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    tool_error: true,
    tool_name: toolCall.name,
    tool_call_id: toolCall.callId,
    error_message: message,
    error: message,
    error_name: error instanceof Error && error.name ? error.name : null
  };
}

export function applyToolResultToLoopInput(
  toolCall: Pick<AgentToolCall, 'name' | 'callId' | 'rawArguments'>,
  toolResult: Record<string, unknown>,
  context?: ToolContinuationContext
): ToolContinuationAction {
  const inputItems: OpenResponseInputItem[] = [{
    type: 'function_call_output',
    call_id: toolCall.callId,
    output: toolCall.name === TOOL_NAMES.execCommand && typeof toolResult.codex_output === 'string'
      ? toolResult.codex_output
      : toolCall.name === TOOL_NAMES.inspectImage && typeof toolResult.output_xml === 'string'
        ? String(toolResult.output_xml).trim()
        : toolCall.name === TOOL_NAMES.recoverEnergy && typeof toolResult.system_reminder === 'string'
          ? String(toolResult.system_reminder).trim()
          : JSON.stringify(toolResult)
  }];
  const oneShotInputItems: OpenResponseInputItem[] = [];
  return {
    inputItems,
    oneShotInputItems,
    forcedVisibleReply: null
  };
}

type AgentModelParameters = Record<string, unknown> | null | undefined;

function normalizeModelSlug(modelName: string) {
  const value = typeof modelName === 'string' ? modelName.trim() : '';
  if (!value) {
    return '';
  }
  return (value.includes('/') ? value.split('/').pop() || value : value).trim().toLowerCase();
}

function getProviderSpecificParameters(parameters: AgentModelParameters): Record<string, unknown> {
  const base = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
    ? parameters
    : {};
  const modelConfig = base.model_config && typeof base.model_config === 'object' && !Array.isArray(base.model_config)
    ? base.model_config as Record<string, unknown>
    : {};
  return modelConfig.providerSpecific && typeof modelConfig.providerSpecific === 'object' && !Array.isArray(modelConfig.providerSpecific)
    ? modelConfig.providerSpecific as Record<string, unknown>
    : {};
}

function shouldUseReasoningReplay(modelName: string) {
  const slug = normalizeModelSlug(modelName);
  return slug === 'gpt-5.5' || slug === 'gpt-5.5-mini' || slug.startsWith('gpt-5.5-');
}

function buildAgentReasoningConfig(modelName: string, parameters: AgentModelParameters) {
  const providerSpecific = getProviderSpecificParameters(parameters);
  const explicitEffort = typeof providerSpecific.reasoningEffort === 'string' && providerSpecific.reasoningEffort.trim()
    ? providerSpecific.reasoningEffort.trim()
    : null;
  const explicitSummary = typeof providerSpecific.reasoningSummary === 'string' && providerSpecific.reasoningSummary.trim()
    ? providerSpecific.reasoningSummary.trim()
    : null;

  if (!explicitEffort && !explicitSummary && !shouldUseReasoningReplay(modelName)) {
    return undefined;
  }

  return {
    effort: explicitEffort || 'medium',
    summary: explicitSummary || 'auto'
  };
}

function buildAgentTextConfig(modelName: string, parameters: AgentModelParameters) {
  const providerSpecific = getProviderSpecificParameters(parameters);
  const explicitVerbosity = typeof providerSpecific.textVerbosity === 'string' && providerSpecific.textVerbosity.trim()
    ? providerSpecific.textVerbosity.trim()
    : null;
  const verbosity = explicitVerbosity === 'low' || explicitVerbosity === 'medium' || explicitVerbosity === 'high'
    ? explicitVerbosity
    : shouldUseReasoningReplay(modelName)
    ? 'medium'
    : null;

  return verbosity ? { verbosity } : undefined;
}

function buildAgentInclude(modelName: string, parameters: AgentModelParameters): string[] | undefined {
  const providerSpecific = getProviderSpecificParameters(parameters);
  const include = new Set(
    Array.isArray(providerSpecific.include)
      ? providerSpecific.include.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
      : []
  );

  if (shouldUseReasoningReplay(modelName)) {
    include.add('reasoning.encrypted_content');
  }

  return include.size > 0 ? Array.from(include) : undefined;
}

export class AgentLoopService {
  private readonly responseActionRouter = new ResponseActionRouter();
  private stableRuntimePrompt: ResolvedAgentRuntimePrompt | null = null;
  private readonly coreMemoryCompressionForks = new Map<string, CoreMemoryCompressionForkState>();
  private cacheHeartbeatLastStartedAtMs = 0;
  private cacheHeartbeatInFlight: Promise<void> | null = null;
  private subconsciousAgentForkBackoffUntilMs = 0;
  private subconsciousAgentForkInFlight: Promise<boolean> | null = null;

  constructor(
    private readonly store: RuntimeStore,
    private readonly promptResolver: AgentPromptResolver = new AgentPromptService(),
    private readonly options: AgentLoopServiceOptions = {}
  ) {}

  invalidateStableRuntimePrompt(reason = 'manual') {
    const hadPrompt = this.stableRuntimePrompt !== null;
    this.stableRuntimePrompt = null;
    moduleLogger.info('Invalidated stable Xiaoni runtime prompt', {
      reason,
      hadPrompt
    });
    return hadPrompt;
  }

  private async isRuntimeEnabledForLoop() {
    if (typeof this.options.isRuntimeEnabled !== 'function') {
      return true;
    }

    try {
      return await this.options.isRuntimeEnabled() !== false;
    } catch (error) {
      moduleLogger.warn('Failed to check Xiaoni runtime control during active loop; defaulting enabled', {
        error: error instanceof Error ? error.message : String(error)
      });
      return true;
    }
  }

  private async waitForRuntimeEnabledBeforeModelSlice(payload: QueueMessageRecord['payload'], runId: string) {
    let pauseLogged = false;
    const pollMs = Math.max(50, Math.min(this.options.runtimePausePollMs ?? agentConfig.idleIntervalMs, agentConfig.idleIntervalMs));

    while (!await this.isRuntimeEnabledForLoop()) {
      if (!pauseLogged) {
        pauseLogged = true;
        await this.store.logTimelineEvent({
          traceId: payload.traceId,
          eventType: 'decision',
          eventName: 'runtime_paused',
          eventPhase: 'start',
          metadata: {
            run_id: runId,
            source: 'runtime:control'
          }
        }).catch((error) => {
          moduleLogger.warn('Failed to log Xiaoni runtime pause', {
            traceId: payload.traceId,
            runId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
      await sleep(pollMs);
    }

    if (pauseLogged) {
      await this.store.logTimelineEvent({
        traceId: payload.traceId,
        eventType: 'decision',
        eventName: 'runtime_paused',
        eventPhase: 'end',
        metadata: {
          run_id: runId,
          source: 'runtime:control'
        }
      }).catch((error) => {
        moduleLogger.warn('Failed to log Xiaoni runtime resume', {
          traceId: payload.traceId,
          runId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  }

  private async yieldBeforeMainAgentModelSlice() {
    let configuredYieldMs = this.options.preModelSliceYieldMs ?? agentConfig.mainAgentPreModelYieldMs;
    if (typeof this.options.getMainAgentPreModelYieldMs === 'function') {
      try {
        const resolved = await this.options.getMainAgentPreModelYieldMs();
        if (Number.isFinite(resolved) && resolved >= 0) {
          configuredYieldMs = resolved;
        }
      } catch (error) {
        moduleLogger.warn('Failed to load Xiaoni main agent pre-model yield; using fallback', {
          error: error instanceof Error ? error.message : String(error),
          fallbackMs: configuredYieldMs
        });
      }
    }
    const yieldMs = Math.max(0, Math.trunc(configuredYieldMs));
    if (yieldMs <= 0) {
      return;
    }

    const wait = this.options.sleepMs ?? sleep;
    await wait(yieldMs);
  }

  private async resolveStableRuntimePrompt(payload: QueueMessageRecord['payload']) {
    if (!this.stableRuntimePrompt) {
      this.stableRuntimePrompt = await this.promptResolver.resolveForQueueMessage(payload);
    }
    return this.stableRuntimePrompt;
  }

  async runRuntimeLoop(params: AgentRuntimeLoopParams) {
    const shouldStop = params.isStopping ?? (() => false);
    const wait = params.sleepMs ?? sleep;
    const bootstrapPromptPayload = params.bootstrapPromptPayload ?? buildRuntimeBootstrapPromptPayload();

    while (!shouldStop() && !this.stableRuntimePrompt) {
      try {
        await this.resolveStableRuntimePrompt(bootstrapPromptPayload);
      } catch (error) {
        params.onRuntimeLoopError?.(error);
        if (!shouldStop()) {
          await wait(params.idleIntervalMs);
        }
      }
    }

    while (!shouldStop()) {
      if (typeof params.shouldReloadRuntimePrompt === 'function') {
        try {
          if (await params.shouldReloadRuntimePrompt()) {
            this.invalidateStableRuntimePrompt('prompt_files_changed');
          }
        } catch (error) {
          params.onRuntimeLoopError?.(error);
        }
      }

      try {
        await params.recoverStaleProcessingLeases?.();
      } catch (error) {
        params.onRuntimeLoopError?.(error);
      }

      const runtimeEnabled = await this.isRuntimeEnabledForLoop();
      params.onRuntimeEnabledChange?.(runtimeEnabled);
      if (!runtimeEnabled) {
        await wait(params.idleIntervalMs);
        continue;
      }

      params.onBusyChange?.(true);
      try {
        await this.processRuntimeIteration(params);
      } catch (error) {
        params.onRuntimeLoopError?.(error);
        if (!shouldStop()) {
          await wait(params.idleIntervalMs);
        }
      } finally {
        params.onBusyChange?.(false);
      }
    }
  }

  private async processRuntimeIteration(params: AgentRuntimeIterationParams) {
    const wait = params.sleepMs ?? sleep;
    const recoveryAction = await this.reconcileActiveRecoverySession(params);
    if (recoveryAction.status === 'active') {
      await this.scheduleCacheHeartbeatDuringRecovery(recoveryAction.session);
      await wait(params.idleIntervalMs);
      return;
    }
    await this.clearCacheHeartbeatRecoverySchedule(recoveryAction.session);
    const initialLoopContinuation = recoveryAction.status === 'settled'
      ? recoveryAction.inputItems
      : [];

    const queueMessage = await this.store.claimNextQueueMessage(params.workerId);
    if (!queueMessage) {
      await this.maybeRunSubconsciousAgentFork(params, initialLoopContinuation);
      await wait(params.idleIntervalMs);
      return;
    }

    const recoveryWakeCountStartQueueMessageId = Math.max(
      ...queueMessage.queueMessageIds.map((id) => Number(id)).filter((id) => Number.isFinite(id)),
      0
    );
    await this.processRuntimeFrame(queueMessage, {
      initialLoopContinuation,
      initialLoopContinuationBeforeCurrentTrigger: initialLoopContinuation.length > 0,
      recoveryWakeCountStartQueueMessageId
    });
  }

  private async maybeRunSubconsciousAgentFork(
    _params: AgentRuntimeIterationParams,
    initialLoopContinuation: OpenResponseInputItem[]
  ) {
    if (initialLoopContinuation.length > 0) {
      const recoveryWakeCountStartQueueMessageId = await this.readRecoveryQueueHighWatermark();
      await this.processRuntimeFrame(buildRuntimeLoopFrameQueueMessage(), {
        queueBacked: false,
        triggerInputMode: 'suppress_current_trigger',
        appendRuntimeInputStackItem: false,
        logQueueLifecycle: false,
        initialLoopContinuation,
        recoveryWakeCountStartQueueMessageId
      });
      return;
    }

    if (this.subconsciousAgentForkBackoffUntilMs > Date.now()) {
      return;
    }
    if (this.subconsciousAgentForkInFlight) {
      return;
    }

    const queueMessage = buildRuntimeLoopFrameQueueMessage();
    const payload = queueMessage.payload;
    const sessionIds = resolveSessionTargets(payload);
    const contextSessionKey = getGlobalPromptContextSessionKey();
    const cutoffState = await this.store.getSessionReadCutoffState(contextSessionKey);
    const history = await this.attachStackReplayItemsToHistory(await this.store.listRecentTurns({
      userId: sessionIds.userId,
      groupId: sessionIds.groupId,
      afterConversationId: cutoffState?.readCutoffAfterConversationId ?? null,
      scope: 'global'
    }), payload.traceId);
    const runtimePrompt = await this.resolveStableRuntimePrompt(payload);
    const runtimeIdentityFacts = await this.loadRuntimeIdentityFacts(payload);
    const developerContextBlock = await this.buildDeveloperContextBlock(payload);
    const runtimeEnergyState = await this.getCurrentRuntimeEnergyState(payload);
    const budgetPlan = await this.buildContextBudgetPlan({
      history,
      queueMessage: payload,
      runtimePrompt,
      loopContinuation: [],
      runtimeIdentityFacts,
      developerContextBlock,
      runtimeEnergyState,
      contextSessionKey,
      cutoffState,
      triggerInputMode: 'suppress_current_trigger',
      appendSelfContinuationOnTerminalFinalAnswer: false,
      loopContinuationBeforeCurrentTrigger: false
    });
    const lastInputItem = budgetPlan.requestInput[budgetPlan.requestInput.length - 1];
    if (!isAssistantFinalAnswerInputItem(lastInputItem)) {
      return;
    }

    const fork = this.runSubconsciousAgentFork({
      baseRequest: buildMainAgentCanonicalRequest(runtimePrompt, budgetPlan.requestInput, payload),
      queueMessage: payload,
      runtimePrompt,
      contextSessionKey
    });
    this.subconsciousAgentForkInFlight = fork;
    void fork.then((enqueued) => {
      if (!enqueued) {
        this.subconsciousAgentForkBackoffUntilMs = Date.now() + SUBCONSCIOUS_AGENT_FORK_IDLE_BACKOFF_MS;
      }
    }).catch((error) => {
      this.subconsciousAgentForkBackoffUntilMs = Date.now() + SUBCONSCIOUS_AGENT_FORK_IDLE_BACKOFF_MS;
      moduleLogger.warn('Background subconscious agent fork failed', {
        traceId: payload.traceId,
        runId: payload.runId,
        error: error instanceof Error ? error.message : String(error)
      });
    }).finally(() => {
      if (this.subconsciousAgentForkInFlight === fork) {
        this.subconsciousAgentForkInFlight = null;
      }
    });
  }

  private async readRecoveryQueueHighWatermark(): Promise<number> {
    const reader = (this.store as RuntimeStore & {
      getAgentRecoveryQueueHighWatermark?: RuntimeStore['getAgentRecoveryQueueHighWatermark'];
    }).getAgentRecoveryQueueHighWatermark;
    if (typeof reader !== 'function') {
      return 0;
    }
    return reader.call(this.store).catch((error) => {
      moduleLogger.warn('Failed to read recovery queue high watermark', {
        error: error instanceof Error ? error.message : String(error)
      });
      return 0;
    });
  }

  private async clearCacheHeartbeatRecoverySchedule(session?: RecoverySessionHeartbeatState | null) {
    this.cacheHeartbeatLastStartedAtMs = 0;
    const store = this.store as RuntimeStore & {
      clearAgentRecoveryCacheHeartbeatSchedule?: RuntimeStore['clearAgentRecoveryCacheHeartbeatSchedule'];
    };
    if (!session?.id || typeof store.clearAgentRecoveryCacheHeartbeatSchedule !== 'function') {
      return;
    }
    await store.clearAgentRecoveryCacheHeartbeatSchedule.call(this.store, {
      id: session.id,
      reason: 'recovery_settled'
    }).catch((error) => {
      moduleLogger.warn('Failed to clear Xiaoni cache heartbeat recovery schedule', {
        recoverySessionId: session.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private shouldRunFallbackCacheHeartbeat(intervalMs: number) {
    const nowMs = Date.now();
    if (this.cacheHeartbeatLastStartedAtMs > 0 && nowMs - this.cacheHeartbeatLastStartedAtMs < intervalMs) {
      return false;
    }
    this.cacheHeartbeatLastStartedAtMs = nowMs;
    return true;
  }

  private async scheduleCacheHeartbeatDuringRecovery(session?: RecoverySessionHeartbeatState | null) {
    if (!agentConfig.cacheHeartbeatEnabled) {
      return;
    }
    if (typeof this.options.isCacheHeartbeatPaused === 'function') {
      try {
        if (await this.options.isCacheHeartbeatPaused()) {
          return;
        }
      } catch (error) {
        moduleLogger.warn('Failed to check Xiaoni cache heartbeat pause control; defaulting heartbeat enabled', {
          recoverySessionId: session?.id || null,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    if (this.cacheHeartbeatInFlight) {
      return;
    }
    const intervalMs = Math.max(60 * 1000, Number(agentConfig.cacheHeartbeatIntervalMs) || (5 * 60 * 1000));
    const store = this.store as RuntimeStore & {
      claimAgentRecoveryCacheHeartbeat?: RuntimeStore['claimAgentRecoveryCacheHeartbeat'];
      completeAgentRecoveryCacheHeartbeat?: RuntimeStore['completeAgentRecoveryCacheHeartbeat'];
    };
    let heartbeatSessionId: number | string | null = session?.id || null;
    let heartbeatStartedAt: string | null = null;

    if (heartbeatSessionId && typeof store.claimAgentRecoveryCacheHeartbeat === 'function') {
      const claim = await store.claimAgentRecoveryCacheHeartbeat.call(this.store, {
        id: heartbeatSessionId,
        intervalMs,
        inFlightStaleMs: Math.min(intervalMs, 60 * 1000),
        now: new Date()
      }).catch((error) => {
        moduleLogger.warn('Failed to claim persisted Xiaoni cache heartbeat schedule', {
          recoverySessionId: heartbeatSessionId,
          error: error instanceof Error ? error.message : String(error)
        });
        return null;
      });
      if (!claim?.claimed) {
        return;
      }
      heartbeatStartedAt = claim.inFlightStartedAt || new Date().toISOString();
    } else {
      heartbeatSessionId = null;
      if (!this.shouldRunFallbackCacheHeartbeat(intervalMs)) {
        return;
      }
      heartbeatStartedAt = new Date().toISOString();
    }

    const run = (async () => {
      try {
        const result = await this.runCacheHeartbeatDuringRecovery();
        if (heartbeatSessionId && typeof store.completeAgentRecoveryCacheHeartbeat === 'function') {
          await store.completeAgentRecoveryCacheHeartbeat.call(this.store, {
            id: heartbeatSessionId,
            intervalMs,
            status: result.triggered ? 'completed' : 'skipped',
            startedAt: heartbeatStartedAt,
            completedAt: new Date(),
            eventId: result.llmCallId ? `codex-provider:${result.llmCallId}` : null,
            llmCallId: result.llmCallId,
            traceId: result.traceId,
            runId: result.runId,
            inputTokens: result.inputTokens,
            cachedInputTokens: result.cachedInputTokens,
            outputTokens: result.outputTokens,
            processingTimeMs: result.processingTimeMs
          }).catch((error) => {
            moduleLogger.warn('Failed to persist Xiaoni cache heartbeat completion', {
              recoverySessionId: heartbeatSessionId,
              error: error instanceof Error ? error.message : String(error)
            });
          });
        }
      } catch (error) {
        if (heartbeatSessionId && typeof store.completeAgentRecoveryCacheHeartbeat === 'function') {
          await store.completeAgentRecoveryCacheHeartbeat.call(this.store, {
            id: heartbeatSessionId,
            intervalMs,
            status: 'failed',
            startedAt: heartbeatStartedAt,
            completedAt: new Date(),
            error: error instanceof Error ? error.message : String(error)
          }).catch((persistError) => {
            moduleLogger.warn('Failed to persist Xiaoni cache heartbeat failure', {
              recoverySessionId: heartbeatSessionId,
              error: persistError instanceof Error ? persistError.message : String(persistError)
            });
          });
        }
        moduleLogger.warn('Xiaoni cache heartbeat failed', {
          recoverySessionId: heartbeatSessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })();
    this.cacheHeartbeatInFlight = run;
    run.finally(() => {
      if (this.cacheHeartbeatInFlight === run) {
        this.cacheHeartbeatInFlight = null;
      }
    }).catch(() => undefined);
  }

  async triggerCacheHeartbeatForDebug(): Promise<CacheHeartbeatRunResult> {
    return this.runCacheHeartbeatDuringRecovery();
  }

  // Operator-forced core memory compaction. Mirrors the cache-heartbeat prelude
  // (synthetic runtime frame -> load history/prompt/identity/energy -> budget plan)
  // but with forceCompression so a checkpoint is produced even when the context is
  // under budget, then hands it to the SAME single-flight fork scheduler. We never
  // call runCoreMemoryCompressionFork directly: scheduleCoreMemoryCompressionFork
  // owns the in-memory + durable dedupe that keeps a manual click from racing an
  // auto-overflow fork. Returns immediately; the fork runs in the background and
  // may take >5min.
  async triggerManualCoreMemoryCompression(): Promise<ManualCoreMemoryCompressionResult> {
    const queueMessage = buildRuntimeLoopFrameQueueMessage();
    const payload: QueueMessageRecord['payload'] = {
      ...queueMessage.payload,
      source: 'manual_core_memory_compression'
    };
    const contextSessionKey = getGlobalPromptContextSessionKey();
    const store = this.store as RuntimeStore & {
      getSessionReadCutoffState?: RuntimeStore['getSessionReadCutoffState'];
      listRecentTurns?: RuntimeStore['listRecentTurns'];
    };
    if (typeof store.getSessionReadCutoffState !== 'function' || typeof store.listRecentTurns !== 'function') {
      return {
        triggered: false,
        status: 'request_builder_unavailable',
        contextSessionKey,
        traceId: payload.traceId,
        runId: payload.runId
      };
    }

    const cutoffState = await store.getSessionReadCutoffState.call(this.store, contextSessionKey);
    const sessionIds = resolveSessionTargets(payload);
    const history = await this.attachStackReplayItemsToHistory(await store.listRecentTurns.call(this.store, {
      userId: sessionIds.userId,
      groupId: sessionIds.groupId,
      afterConversationId: cutoffState?.readCutoffAfterConversationId ?? null,
      scope: 'global' as const
    }), payload.traceId);
    const runtimePrompt = await this.resolveStableRuntimePrompt(payload);
    const runtimeIdentityFacts = await this.loadRuntimeIdentityFacts(payload);
    const baseDeveloperContextBlock = await this.buildDeveloperContextBlock(payload);
    const runtimeEnergyState = await this.getCurrentRuntimeEnergyState(payload);
    const developerContextBlock = [
      baseDeveloperContextBlock
    ].filter((part): part is string => Boolean(part && part.trim())).join('\n\n') || null;

    const budgetPlan = await this.buildContextBudgetPlan({
      history,
      queueMessage: payload,
      runtimePrompt,
      loopContinuation: [],
      runtimeIdentityFacts,
      developerContextBlock,
      runtimeEnergyState,
      contextSessionKey,
      cutoffState,
      triggerInputMode: 'suppress_current_trigger',
      forceCompression: true
    });

    if (!budgetPlan.coreMemoryCompression || !budgetPlan.summarySourceInput) {
      moduleLogger.info('Manual core memory compression had nothing to compress', {
        traceId: payload.traceId,
        runId: payload.runId,
        contextSessionKey,
        retainedHistoryTurns: history.length
      });
      return {
        triggered: false,
        status: 'nothing_to_compress',
        contextSessionKey,
        traceId: payload.traceId,
        runId: payload.runId,
        retainedHistoryTurns: history.length
      };
    }

    const artifact = await this.scheduleCoreMemoryCompressionFork({
      baseRequest: buildMainAgentCanonicalRequest(runtimePrompt, budgetPlan.summarySourceInput, payload),
      queueMessage: payload,
      runtimePrompt,
      compression: budgetPlan.coreMemoryCompression,
      contextSessionKey,
      // Manual trigger: run even while the loop is stopped (see fork gate).
      bypassRuntimeEnabledGate: true
    });
    const artifactStatus = typeof (artifact as { status?: unknown })?.status === 'string'
      ? (artifact as { status: string }).status
      : 'scheduled';
    moduleLogger.info('Manual core memory compression triggered', {
      traceId: payload.traceId,
      runId: payload.runId,
      contextSessionKey,
      status: artifactStatus,
      readCutoffAfterConversationId: budgetPlan.coreMemoryCompression.readCutoffAfterConversationId,
      compressionCoveredEndConversationId: budgetPlan.coreMemoryCompression.compressionCoveredEndConversationId
    });
    return {
      triggered: artifactStatus === 'scheduled',
      status: artifactStatus,
      contextSessionKey,
      traceId: payload.traceId,
      runId: payload.runId,
      retainedHistoryTurns: history.length,
      readCutoffAfterConversationId: budgetPlan.coreMemoryCompression.readCutoffAfterConversationId,
      compressionCoveredEndConversationId: budgetPlan.coreMemoryCompression.compressionCoveredEndConversationId,
      artifact: artifact as Record<string, unknown>
    };
  }

  // Coarse liveness poll for the admin UI: is a compaction fork still running for
  // the given covered range? Reuses the durable 30-minute running-window guard, so
  // running=false means "no fork running" (done | failed | never started).
  async getCoreMemoryCompressionForkStatus(
    compressionCoveredEndConversationId: number
  ): Promise<CoreMemoryCompressionForkStatusResult> {
    const contextSessionKey = getGlobalPromptContextSessionKey();
    const finder = (this.store as RuntimeStore & {
      findActiveCoreMemoryCompressionForkRun?: RuntimeStore['findActiveCoreMemoryCompressionForkRun'];
    }).findActiveCoreMemoryCompressionForkRun;
    if (typeof finder !== 'function' || !Number.isFinite(compressionCoveredEndConversationId)) {
      return { running: false, contextSessionKey, compressionCoveredEndConversationId };
    }
    const active = await finder.call(this.store, {
      contextSessionKey,
      compressionCoveredEndConversationId
    }) as {
      forkRunId?: string | null;
      runId?: string | null;
      startedAt?: unknown;
      status?: string | null;
    } | null;
    if (!active) {
      return { running: false, contextSessionKey, compressionCoveredEndConversationId };
    }
    return {
      running: true,
      contextSessionKey,
      compressionCoveredEndConversationId,
      forkRunId: active.forkRunId ?? null,
      runId: active.runId ?? null,
      startedAt: active.startedAt ? String(active.startedAt) : null,
      status: active.status ?? null
    };
  }

  private async attachStackReplayItemsToHistory(history: ConversationTurn[], traceId: string): Promise<StackBackedConversationTurn[]> {
    if (history.length === 0) {
      return [];
    }
    const batchReader = (this.store as RuntimeStore & {
      listAgentStackItemsForConversations?: RuntimeStore['listAgentStackItemsForConversations'];
    }).listAgentStackItemsForConversations;
    if (typeof batchReader === 'function') {
      try {
        const rows = await batchReader.call(this.store, {
          identityKey: XIAONI_IDENTITY_KEY,
          conversationIds: history.map((turn) => turn.id),
          limit: Math.max(1000, history.length * 1000)
        }) as Array<Record<string, unknown>>;
        const rowsByConversationId = groupStackRowsByConversationId(rows);
        return history.map((turn) => ({
          ...turn,
          stackReplayItems: extractResponseReplayInputItemsFromStackRows(rowsByConversationId.get(turn.id) || [])
        }));
      } catch (error) {
        moduleLogger.warn('Failed to load Xiaoni stack replay items for conversation history', {
          traceId,
          conversationCount: history.length,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const reader = (this.store as RuntimeStore & {
      listAgentStackItems?: RuntimeStore['listAgentStackItems'];
    }).listAgentStackItems;
    if (typeof reader !== 'function') {
      return history.map((turn) => ({ ...turn, stackReplayItems: [] }));
    }

    const rowsByConversationId = new Map<number, Array<Record<string, unknown>>>();
    await Promise.all(history.map(async (turn) => {
      try {
        const rows = await reader.call(this.store, {
          identityKey: XIAONI_IDENTITY_KEY,
          conversationId: turn.id,
          chronological: true,
          limit: 1000
        }) as Array<Record<string, unknown>>;
        rowsByConversationId.set(turn.id, rows);
      } catch (error) {
        moduleLogger.warn('Failed to load Xiaoni stack replay items for conversation turn', {
          traceId,
          conversationId: turn.id,
          error: error instanceof Error ? error.message : String(error)
        });
        rowsByConversationId.set(turn.id, []);
      }
    }));

    return history.map((turn) => ({
      ...turn,
      stackReplayItems: extractResponseReplayInputItemsFromStackRows(rowsByConversationId.get(turn.id) || [])
    }));
  }

  private async runCacheHeartbeatDuringRecovery(): Promise<CacheHeartbeatRunResult> {
    const queueMessage = buildRuntimeLoopFrameQueueMessage();
    const built = await this.buildCacheHeartbeatCanonicalRequest(queueMessage.payload);
    if (!built) {
      return {
        triggered: false,
        reason: 'request_builder_unavailable',
        executionMode: CACHE_HEARTBEAT_EXECUTION_MODE,
        traceId: queueMessage.traceId,
        runId: queueMessage.id
      };
    }

    const modelResult = await this.executeCacheHeartbeatTurn(
      built.canonicalRequest,
      queueMessage.payload,
      built.runtimePrompt
    );
    const result = this.buildCacheHeartbeatRunResult(queueMessage, built.canonicalRequest, built.runtimePrompt, modelResult);
    moduleLogger.info('Xiaoni cache heartbeat completed', {
      traceId: result.traceId,
      runId: result.runId,
      model: result.model,
      provider: result.provider,
      cachedInputTokens: result.cachedInputTokens
    });
    return result;
  }

  private buildCacheHeartbeatRunResult(
    queueMessage: QueueMessageRecord,
    canonicalRequest: CanonicalAgentTurnRequest,
    runtimePrompt: ResolvedAgentRuntimePrompt,
    modelResult: ProviderAgentResponse
  ): CacheHeartbeatRunResult {
    return {
      triggered: true,
      executionMode: CACHE_HEARTBEAT_EXECUTION_MODE,
      traceId: queueMessage.traceId,
      runId: queueMessage.id,
      promptName: runtimePrompt.promptName,
      model: modelResult.model || runtimePrompt.modelName || null,
      provider: modelResult.provider || null,
      llmCallId: modelResult.llm_call_id || modelResult.llm_request_slice_id || null,
      promptCacheKey: canonicalRequest.prompt_cache_key || null,
      store: canonicalRequest.store ?? null,
      maxOutputTokens: canonicalRequest.max_output_tokens ?? null,
      inputTokens: readOptionalNumber(modelResult.usage?.input_tokens),
      outputTokens: readOptionalNumber(modelResult.usage?.output_tokens),
      totalTokens: readOptionalNumber(modelResult.usage?.total_tokens),
      cachedInputTokens: readOptionalNumber(modelResult.usage_details?.cached_input_tokens),
      processingTimeMs: readOptionalNumber(modelResult.performance?.processing_time_ms)
    };
  }

  private async buildCacheHeartbeatCanonicalRequest(queueMessage: QueueMessageRecord['payload']): Promise<{
    canonicalRequest: CanonicalAgentTurnRequest;
    runtimePrompt: ResolvedAgentRuntimePrompt;
  } | null> {
    const store = this.store as RuntimeStore & {
      getSessionReadCutoffState?: RuntimeStore['getSessionReadCutoffState'];
      listRecentTurns?: RuntimeStore['listRecentTurns'];
    };
    if (typeof store.getSessionReadCutoffState !== 'function' || typeof store.listRecentTurns !== 'function') {
      return null;
    }

    const contextSessionKey = getGlobalPromptContextSessionKey();
    const cutoffState = await store.getSessionReadCutoffState.call(this.store, contextSessionKey);
    const sessionIds = resolveSessionTargets(queueMessage);
    const history = await this.attachStackReplayItemsToHistory(await store.listRecentTurns.call(this.store, {
      userId: sessionIds.userId,
      groupId: sessionIds.groupId,
      afterConversationId: cutoffState?.readCutoffAfterConversationId ?? null,
      scope: 'global' as const
    }), queueMessage.traceId);
    const runtimePrompt = await this.resolveStableRuntimePrompt(queueMessage);
    const runtimeIdentityFacts = await this.loadRuntimeIdentityFacts(queueMessage);
    const baseDeveloperContextBlock = await this.buildDeveloperContextBlock(queueMessage);
    const runtimeEnergyState = await this.getCurrentRuntimeEnergyState(queueMessage);
    const developerContextBlock = [
      baseDeveloperContextBlock
    ].filter((part): part is string => Boolean(part && part.trim())).join('\n\n') || null;
    const buildBudgetPlan = (appendSelfContinuationOnTerminalFinalAnswer: boolean) => this.buildContextBudgetPlan({
      history,
      queueMessage,
      runtimePrompt,
      loopContinuation: [],
      runtimeIdentityFacts,
      developerContextBlock,
      runtimeEnergyState,
      contextSessionKey,
      cutoffState,
      triggerInputMode: 'suppress_current_trigger',
      appendSelfContinuationOnTerminalFinalAnswer
    });
    let budgetPlan = await buildBudgetPlan(false);
    const lastInputItem = budgetPlan.requestInput[budgetPlan.requestInput.length - 1];
    if (isAssistantFinalAnswerInputItem(lastInputItem)) {
      budgetPlan = await buildBudgetPlan(true);
    }

    return {
      canonicalRequest: buildCacheHeartbeatForkRequest(
        buildMainAgentCanonicalRequest(runtimePrompt, budgetPlan.requestInput, queueMessage)
      ),
      runtimePrompt
    };
  }

  private async reconcileActiveRecoverySession(_params: AgentRuntimeIterationParams): Promise<{
    status: 'none' | 'active' | 'settled';
    inputItems: OpenResponseInputItem[];
    session?: RecoverySessionHeartbeatState | null;
  }> {
    const store = this.store as RuntimeStore & {
      getActiveAgentRecoverySession?: RuntimeStore['getActiveAgentRecoverySession'];
      listAgentRecoveryWakeNotifications?: RuntimeStore['listAgentRecoveryWakeNotifications'];
      updateAgentRecoverySessionProgress?: RuntimeStore['updateAgentRecoverySessionProgress'];
      finalizeAgentRecoverySession?: RuntimeStore['finalizeAgentRecoverySession'];
      createAgentRecoverySession?: RuntimeStore['createAgentRecoverySession'];
      recordRecoverySessionLifeEvent?: RuntimeStore['recordRecoverySessionLifeEvent'];
    };

    if (typeof store.getActiveAgentRecoverySession !== 'function') {
      return { status: 'none', inputItems: [] };
    }

    let session = await store.getActiveAgentRecoverySession.call(this.store);
    if (!session) {
      const recoveryWakeCountStartQueueMessageId = await this.readRecoveryQueueHighWatermark();
      const energyState = await this.getCurrentRuntimeEnergyState(buildRuntimeLoopFrameQueueMessage().payload).catch(() => null);
      const pressure = energyState ? 1 - (energyState.energy / Math.max(0.001, energyState.maxEnergy)) : 0;
      if (!energyState || pressure < DEFAULT_RECOVER_ENERGY_POLICY.forcedSleepPressure || typeof store.createAgentRecoverySession !== 'function') {
        return { status: 'none', inputItems: [] };
      }
      const startedAt = new Date();
      const policySnapshot = createRecoveryPolicySnapshot(startedAt);
      const sessionPolicy = recoverySessionPolicyFromSnapshot(policySnapshot)!;
      const naturalWakeAt = estimateNaturalWakeAt({
        startEnergy: energyState.energy,
        maxEnergy: energyState.maxEnergy,
        startedAt,
        policy: sessionPolicy.policy
      });
      session = await store.createAgentRecoverySession.call(this.store, {
        initiator: 'runtime_forced',
        reason: '精力已经透支，工程强制进入休息恢复。',
        xiaoniOs: null,
        startedAt,
        startEnergy: energyState.energy,
        currentEnergy: energyState.energy,
        maxEnergy: energyState.maxEnergy,
        startPressure: pressure,
        currentPressure: pressure,
        plannedNaturalWakeAt: naturalWakeAt,
        hardWakeAt: estimateSessionWakeAt(startedAt, sessionPolicy),
        wakeCountStartQueueMessageId: recoveryWakeCountStartQueueMessageId,
        metadata: {
          source: 'runtime_forced_recovery',
          forced_sleep_pressure: DEFAULT_RECOVER_ENERGY_POLICY.forcedSleepPressure,
          recovery_policy_snapshot: policySnapshot
        }
      });
      moduleLogger.warn('Started forced Xiaoni recovery session', {
        recoverySessionId: session?.id,
        energy: energyState.energy,
        pressure
      });
      return { status: 'active', inputItems: [], session: session ? { id: session.id } : null };
    }

    const lastCountedId = Math.max(
      Number(session.lastWakeCountedQueueMessageId || 0),
      Number(session.wakeCountStartQueueMessageId || 0)
    );
    const wakeRows = typeof store.listAgentRecoveryWakeNotifications === 'function'
      ? await store.listAgentRecoveryWakeNotifications.call(this.store, {
          afterQueueMessageId: lastCountedId,
          limit: 250
        }).catch((error) => {
          moduleLogger.warn('Failed to scan recovery wake notifications', {
            recoverySessionId: session?.id,
            error: error instanceof Error ? error.message : String(error)
          });
          return [];
        })
      : [];
    const wakeIncrement = wakeRows.reduce((sum, row) => sum + Math.max(0, Number(row.wakeCount || 0)), 0);
    const lastWakeCountedId = wakeRows.length > 0
      ? Math.max(...wakeRows.map((row) => Number(row.id || 0)))
      : lastCountedId;
    const wakeCallCount = Math.max(0, Number(session.wakeCallCount || 0)) + wakeIncrement;
    const sessionPolicy = recoverySessionPolicyFromMetadata(session.metadata);
    const isNightNaturalRecovery = sessionPolicy.version !== LEGACY_RECOVER_ENERGY_POLICY_VERSION
      && sessionPolicy.circadian.phase === 'night'
      && !session.clockDueAt;
    const projection = projectRecoverySession({
      startEnergy: Number(session.startEnergy ?? session.currentEnergy ?? 0),
      maxEnergy: Number(session.maxEnergy || 1),
      startedAt: session.startedAt || new Date(),
      now: new Date(),
      clockDueAt: session.clockDueAt,
      clockDeferredAt: session.clockDeferredAt,
      wakeCallCount,
      policy: sessionPolicy.policy,
      sessionMaxRecoveryMinutes: sessionPolicy.sessionMaxRecoveryMinutes,
      sessionCapWakeCause: sessionPolicy.sessionCapWakeCause,
      suppressNaturalWakeBeforeSessionCap: isNightNaturalRecovery,
      shapeWakeCallsBySessionProgress: isNightNaturalRecovery
    });
    const clockDeferredAt = projection.clockShouldDefer && !session.clockDeferredAt ? new Date() : null;

    if (!projection.shouldWake) {
      if (typeof store.updateAgentRecoverySessionProgress === 'function') {
        await store.updateAgentRecoverySessionProgress.call(this.store, {
          id: session.id,
          wakeCallCount,
          wakeRequiredCount: Number.isFinite(projection.wakeRequiredCount) ? projection.wakeRequiredCount : null,
          lastWakeCountedQueueMessageId: lastWakeCountedId,
          currentPressure: projection.pressure,
          currentEnergy: projection.energy,
          plannedNaturalWakeAt: estimateNaturalWakeAt({
            startEnergy: Number(session.startEnergy ?? session.currentEnergy ?? 0),
            maxEnergy: Number(session.maxEnergy || 1),
            startedAt: new Date(session.startedAt || new Date()),
            policy: sessionPolicy.policy
          }),
          hardWakeAt: estimateSessionWakeAt(new Date(session.startedAt || new Date()), sessionPolicy),
          clockDeferredAt,
          lastCheckedAt: new Date()
        }).catch((error) => {
          moduleLogger.warn('Failed to update recovery progress', {
            recoverySessionId: session?.id,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
      return { status: 'active', inputItems: [], session: { id: session.id } };
    }

    const toolResult = this.buildRecoverySessionResult(session, projection, {
      wakeCallCount,
      lastWakeCountedQueueMessageId: lastWakeCountedId
    });
    const inputItems = await this.settleRecoverySession(session, toolResult, projection, {
      wakeCallCount,
      lastWakeCountedQueueMessageId: lastWakeCountedId
    });
    if (inputItems.length === 0) {
      return { status: 'active', inputItems: [], session: { id: session.id } };
    }
    if (typeof store.recordRecoverySessionLifeEvent === 'function') {
      await store.recordRecoverySessionLifeEvent.call(this.store, session, toolResult).catch((error) => {
        moduleLogger.warn('Failed to record recovery session life event', {
          recoverySessionId: session?.id,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    return { status: 'settled', inputItems, session: { id: session.id } };
  }

  private buildRecoverySessionResult(
    session: {
      id: number;
      reason: string | null;
      xiaoniOs: string | null;
      clockMinutes: number | null;
      clockDueAt: string | null;
      clockDeferredAt: string | null;
      startedAt: string | null;
      startEnergy: number | null;
      maxEnergy: number;
      metadata?: Record<string, unknown>;
    },
    projection: ReturnType<typeof projectRecoverySession>,
    counts: {
      wakeCallCount: number;
      lastWakeCountedQueueMessageId: number;
    }
  ) {
    const startedAt = session.startedAt ? new Date(session.startedAt) : new Date();
    const elapsedMs = Math.max(0, Date.now() - startedAt.getTime());
    const sessionPolicy = recoverySessionPolicyFromMetadata(session.metadata);
    const recoveredEnergy = {
      rawEnergyBefore: Number(session.startEnergy ?? projection.energy),
      startEnergy: Number(session.startEnergy ?? projection.energy),
      energy: projection.energy,
      maxEnergy: Number(session.maxEnergy || 1),
      debt: Number(session.startEnergy ?? 0) < 0 ? Math.abs(Number(session.startEnergy ?? 0)) : 0,
      elapsedMs,
      fullRecoveryMs: sessionPolicy.fullRecoveryMinutes * 60 * 1000,
      pressure: projection.pressure,
      startPressure: projection.startPressure
    };
    const clockDeferredMinutes = session.clockDueAt && session.clockDeferredAt
      ? Math.max(0, Math.round((Date.now() - new Date(session.clockDueAt).getTime()) / 60000))
      : 0;
    const batchFinalRecoveryTimeline = renderRecoverEnergyBatchFinalTimeline({
      metadata: session.metadata,
      recoveryStartedAt: startedAt
    });
    return {
      recovered: true,
      rest_rejected: false,
      recovery_session_id: session.id,
      reason: session.reason,
      xiaoni_os: session.xiaoniOs,
      wake_cause: projection.wakeCause,
      sleep_minutes: Math.max(0, Math.round(projection.elapsedMinutes)),
      clock_minutes: session.clockMinutes,
      energy_before: recoveredEnergy.rawEnergyBefore,
      energy_start: recoveredEnergy.startEnergy,
      energy: recoveredEnergy.energy,
      max_energy: recoveredEnergy.maxEnergy,
      recovered_energy: recoveredEnergy.energy - recoveredEnergy.startEnergy,
      energy_debt: recoveredEnergy.debt,
      pressure: projection.pressure,
      start_pressure: projection.startPressure,
      full_recovery_minutes: sessionPolicy.fullRecoveryMinutes,
      session_max_recovery_minutes: sessionPolicy.sessionMaxRecoveryMinutes,
      session_cap_wake_cause: sessionPolicy.sessionCapWakeCause,
      wake_call_count: counts.wakeCallCount,
      wake_required_count: Number.isFinite(projection.wakeRequiredCount) ? projection.wakeRequiredCount : null,
      last_wake_counted_queue_message_id: counts.lastWakeCountedQueueMessageId,
      energy_cost: RUNTIME_TOOL_COSTS[TOOL_NAMES.recoverEnergy],
      system_reminder: renderRecoverEnergyCompletedReminder({
        reason: session.reason,
        xiaoniOs: session.xiaoniOs,
        wakeCause: projection.wakeCause,
        sleepMinutes: projection.elapsedMinutes,
        wakeCallCount: counts.wakeCallCount,
        wakeRequiredCount: Number.isFinite(projection.wakeRequiredCount) ? projection.wakeRequiredCount : null,
        clockMinutes: session.clockMinutes,
        clockDeferredMinutes,
        recoveredEnergy,
        batchFinalRecoveryTimeline
      })
    };
  }

  private async settleRecoverySession(
    session: {
      id: number;
      initiator: string;
      toolCallId: string | null;
      toolExecutionId: string | null;
      llmRequestSliceId: string | null;
      traceId: string | null;
      runId: string | null;
      conversationId?: number | null;
      metadata?: Record<string, unknown>;
    },
    toolResult: Record<string, unknown>,
    projection: ReturnType<typeof projectRecoverySession>,
    counts: {
      wakeCallCount: number;
      lastWakeCountedQueueMessageId: number;
    }
  ): Promise<OpenResponseInputItem[]> {
    const store = this.store as RuntimeStore & {
      finalizeAgentRecoverySession?: RuntimeStore['finalizeAgentRecoverySession'];
    };
    const now = new Date();
    const isVoluntary = session.initiator === 'recover_energy_tool' && typeof session.toolCallId === 'string' && session.toolCallId.length > 0;
    const sessionMetadata = session.metadata && typeof session.metadata === 'object' ? session.metadata : {};
    const rawToolArgs = sessionMetadata.tool_args && typeof sessionMetadata.tool_args === 'object' && !Array.isArray(sessionMetadata.tool_args)
      ? sessionMetadata.tool_args as Record<string, unknown>
      : {};
    const rawArguments = typeof sessionMetadata.raw_arguments === 'string'
      ? sessionMetadata.raw_arguments
      : JSON.stringify(rawToolArgs);
    const wakeSystemReminder = String(toolResult.system_reminder || '').trim();
    const inputItems: OpenResponseInputItem[] = isVoluntary
      ? [{
          type: 'function_call_output',
          call_id: session.toolCallId!,
          output: wakeSystemReminder
        }]
      : [buildDeveloperInputItem([wakeSystemReminder]) as OpenResponseInputItem];

    if (isVoluntary) {
      // The original recover_energy function_call is already part of the stack
      // replay from the pre-sleep model slice. The wake callback must append
      // only the matching output, otherwise the next provider request sees the
      // same call_id twice and one of the calls has no distinct output.
      const toolCall: AgentToolCall = {
        callId: session.toolCallId!,
        name: TOOL_NAMES.recoverEnergy,
        args: rawToolArgs,
        rawArguments
      };
      const rows = await this.appendAgentStackItemsSafe({
        traceId: session.traceId || `recovery:${session.id}`,
        runId: session.runId || `recovery:${session.id}`,
        conversationId: session.conversationId ?? null,
        sourceType: 'agent_recovery_sessions',
        sourceId: String(session.id),
        llmRequestSliceId: session.llmRequestSliceId || null,
        items: buildToolResultStackItems({
          toolCall,
          toolResult,
          continuationItems: inputItems,
          llmRequestSliceId: session.llmRequestSliceId || `recovery:${session.id}`
        }) as Array<Record<string, unknown>>
      });
      if (session.toolExecutionId) {
        await this.completeAgentStackToolExecutionSafe({
          executionId: session.toolExecutionId,
          status: 'completed',
          result: toolResult,
          stackOutputItemId: (rows[0] as { id?: string | number } | undefined)?.id || null
        });
      }
    } else {
      await this.appendAgentStackItemsSafe({
        traceId: session.traceId || `recovery:${session.id}`,
        runId: session.runId || `recovery:${session.id}`,
        conversationId: session.conversationId ?? null,
        sourceType: 'agent_recovery_sessions',
        sourceId: String(session.id),
        items: [{
          eventId: `stack:recovery-session:${session.id}:runtime-reminder`,
          itemKind: 'runtime_input',
          role: 'developer',
          phase: null,
          content: {
            source: 'agent_recovery_sessions',
            recovery_session_id: session.id,
            input_items: inputItems,
            system_reminder: toolResult.system_reminder || null
          },
          visibility: 'model_visible',
          metadata: {
            wake_cause: projection.wakeCause,
            initiator: session.initiator
          }
        }]
      });
    }

    if (typeof store.finalizeAgentRecoverySession === 'function') {
      await store.finalizeAgentRecoverySession.call(this.store, {
        id: session.id,
        status: 'completed',
        wakeCause: projection.wakeCause,
        endedAt: now,
        clockFiredAt: projection.clockDue ? now : null,
        wakeCallCount: counts.wakeCallCount,
        wakeRequiredCount: Number.isFinite(projection.wakeRequiredCount) ? projection.wakeRequiredCount : null,
        lastWakeCountedQueueMessageId: counts.lastWakeCountedQueueMessageId,
        currentPressure: projection.pressure,
        currentEnergy: projection.energy,
        result: toolResult
      });
    }

    return inputItems;
  }

  private async processRuntimeFrame(queueMessage: QueueMessageRecord, frameOptions: ProcessRuntimeFrameOptions = {}) {
    const options = normalizeRuntimeFrameOptions(frameOptions);
    const startedAt = Date.now();
    const payload = queueMessage.payload;
    const inboundContext = payload.inboundContext;
    const sessionIds = resolveSessionTargets(payload);
    let jobId: string | null = null;
    const recoveryWakeCountStartQueueMessageId = typeof options.recoveryWakeCountStartQueueMessageId === 'number'
      && Number.isFinite(options.recoveryWakeCountStartQueueMessageId)
      ? Math.max(0, Math.floor(options.recoveryWakeCountStartQueueMessageId))
      : await this.readRecoveryQueueHighWatermark();

    let conversationId: number | null = null;
    let turnsExecuted = 0;
    let deliveredMessages: DeliveredAssistantMessage[] = [];
    let persistedXiaoniOs: string | null = null;
    let persistedPendingShare: string | null = null;
    let historyCount = 0;
    let runtimePrompt: ResolvedAgentRuntimePrompt | null = null;
    let storedFeedbackReflectionIds: number[] = [];
    let unreadMeaningArtifact: Record<string, unknown> | null = null;
    let coreMemoryCompressionArtifact: Record<string, unknown> | null = null;
    let presenceContext: RuntimePresenceContext | null = null;
    let runtimeIdentityFacts: RuntimeIdentityFactProjection[] = [];
    const contextBudgetTurns: ContextBudgetTurnRecord[] = [];
    let budgetPlan: ContextBudgetPlan = {
      requestInput: [],
      currentTurnInputItems: [],
      selfContinuationInputItem: null,
      summarySourceInput: null,
      retainedHistory: [],
      runtimeIdentityFacts: [],
      readCutoffAfterConversationId: null,
      previousReadCutoffAfterConversationId: null,
      estimatedInputTokens: 0,
      contextWindowTokens: null,
      targetBudgetTokens: null,
      hardBudgetTokens: null,
      tokenizerEncoding: null,
      tokenizerSource: null,
      cutoffRecomputed: false,
      contextSummary: null,
      pendingProactiveShare: null,
      pendingProactiveShareAge: 0,
      coreMemoryCompression: null
    };

    if (options.logQueueLifecycle) {
      await this.store.logTimelineEvent({
        traceId: payload.traceId,
        eventType: 'queue',
        eventName: 'dequeue',
        eventPhase: 'start',
        metadata: { run_id: queueMessage.id, batch_id: queueMessage.batchId, queue_message_ids: queueMessage.queueMessageIds, worker_id: agentConfig.workerId }
      });
      await this.store.logTimelineEvent({
        traceId: payload.traceId,
        eventType: 'queue',
        eventName: 'dequeue',
        eventPhase: 'end',
        metadata: { run_id: queueMessage.id, batch_id: queueMessage.batchId, queue_message_ids: queueMessage.queueMessageIds, worker_id: agentConfig.workerId }
      });
    }
    if (options.queueBacked) {
      jobId = await this.store.createLlmJob({
        traceId: payload.traceId,
        sessionId: payload.sessionKey,
        agentType: 'chat_bot',
        metadata: {
          run_id: queueMessage.id,
          batch_id: queueMessage.batchId,
          queue_message_ids: queueMessage.queueMessageIds,
          source: payload.source
        }
      });
      await this.store.logTimelineEvent({
        traceId: payload.traceId,
        eventType: 'decision',
        eventName: 'execution_lease',
        eventPhase: 'start',
        metadata: { internal_execution_lease_id: queueMessage.id, batch_id: queueMessage.batchId }
      });
    }
    let loopContinuation: OpenResponseInputItem[] = [...options.initialLoopContinuation];
    const continuationQueueMessages: QueueMessageRecord[] = [];

    try {
      const recorder = (this.store as RuntimeStore & {
        recordPresenceUserMessage?: RuntimeStore['recordPresenceUserMessage'];
      }).recordPresenceUserMessage;
      if (typeof recorder === 'function') {
        await recorder.call(this.store, payload).catch((error) => {
          moduleLogger.warn('Failed to record presence user-message anchor', {
            traceId: payload.traceId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
      const contextSessionKey = getGlobalPromptContextSessionKey();
      const cutoffState = await this.store.getSessionReadCutoffState(contextSessionKey);
      const historyQuery: {
        userId: number;
        groupId: number | null;
        afterConversationId: number | null;
        scope: 'global';
      } = {
        userId: sessionIds.userId,
        groupId: sessionIds.groupId,
        afterConversationId: cutoffState?.readCutoffAfterConversationId ?? null,
        scope: 'global' as const
      };
      const history = await this.attachStackReplayItemsToHistory(await this.store.listRecentTurns(historyQuery), payload.traceId);
      historyCount = history.length;
      const allowSelfContinuationOnTerminalFinalAnswer = shouldAllowSelfContinuationOnTerminalFinalAnswer(options);

      const resolvedRuntimePrompt = await this.resolveStableRuntimePrompt(payload);
      runtimePrompt = resolvedRuntimePrompt;
      runtimeIdentityFacts = await this.loadRuntimeIdentityFacts(payload);
      const baseDeveloperContextBlock = await this.buildDeveloperContextBlock(payload);
      const initialRuntimeEnergyState = await this.getCurrentRuntimeEnergyState(payload);
      {
        const presenceLoader = (this.store as RuntimeStore & {
          buildPresenceContext?: RuntimeStore['buildPresenceContext'];
        }).buildPresenceContext;
        presenceContext = typeof presenceLoader === 'function'
          ? await presenceLoader.call(this.store, payload).catch((error) => {
              moduleLogger.warn('Failed to build presence context', {
                traceId: payload.traceId,
                error: error instanceof Error ? error.message : String(error)
              });
              return null;
            })
          : null;
      }
      const developerContextBlock = [
        baseDeveloperContextBlock
      ].filter((part): part is string => Boolean(part && part.trim())).join('\n\n') || null;
      const buildBudgetPlan = (appendSelfContinuationOnTerminalFinalAnswer: boolean) => this.buildContextBudgetPlan({
        history,
        queueMessage: payload,
        runtimePrompt: resolvedRuntimePrompt,
        loopContinuation,
        runtimeIdentityFacts,
        developerContextBlock,
        runtimeEnergyState: initialRuntimeEnergyState,
        contextSessionKey,
        cutoffState,
        triggerInputMode: options.triggerInputMode,
        appendSelfContinuationOnTerminalFinalAnswer,
        loopContinuationBeforeCurrentTrigger: options.initialLoopContinuationBeforeCurrentTrigger
      });
      let appendSelfContinuationOnTerminalFinalAnswer = false;
      budgetPlan = await buildBudgetPlan(false);
      if (allowSelfContinuationOnTerminalFinalAnswer) {
        const lastInputItem = budgetPlan.requestInput[budgetPlan.requestInput.length - 1];
        if (isAssistantFinalAnswerInputItem(lastInputItem)) {
          appendSelfContinuationOnTerminalFinalAnswer = true;
          budgetPlan = await buildBudgetPlan(true);
        }
      }
      const coreMemoryCompressionCheckpoint = budgetPlan.coreMemoryCompression && budgetPlan.summarySourceInput
        ? {
            compression: budgetPlan.coreMemoryCompression,
            summarySourceInput: budgetPlan.summarySourceInput
          }
        : null;
      await this.ensureRuntimeIdentityRoot(payload, resolvedRuntimePrompt);
      if (!jobId) {
        jobId = await this.store.createLlmJob({
          traceId: payload.traceId,
          sessionId: payload.sessionKey,
          agentType: 'chat_bot',
          metadata: {
            run_id: queueMessage.id,
            batch_id: queueMessage.batchId,
            queue_message_ids: queueMessage.queueMessageIds,
            source: payload.source
          }
        });
        await this.store.logTimelineEvent({
          traceId: payload.traceId,
          eventType: 'decision',
          eventName: 'execution_lease',
          eventPhase: 'start',
          metadata: { internal_execution_lease_id: queueMessage.id, batch_id: queueMessage.batchId }
        });
      }
      // Compute evicted turns once at the start: turns pushed out by the new cutoff that
      // weren't already excluded by the previous cutoff.
      const evictedTurns: ConversationTurn[] = budgetPlan.cutoffRecomputed && budgetPlan.readCutoffAfterConversationId !== null
        ? history.filter((t) =>
            t.id <= budgetPlan.readCutoffAfterConversationId! &&
            (budgetPlan.previousReadCutoffAfterConversationId === null || t.id > budgetPlan.previousReadCutoffAfterConversationId)
          )
        : [];
      let requestInput = budgetPlan.requestInput;
      let pendingOneShotInputItems: OpenResponseInputItem[] = [];
      if (coreMemoryCompressionCheckpoint) {
        await this.scheduleCoreMemoryCompressionFork({
          baseRequest: buildMainAgentCanonicalRequest(runtimePrompt, coreMemoryCompressionCheckpoint.summarySourceInput, payload),
          queueMessage: payload,
          runtimePrompt,
          compression: coreMemoryCompressionCheckpoint.compression,
          contextSessionKey
        });
      }
      const appendLoopInputItems = (items: OpenResponseInputItem[]) => {
        if (items.length === 0) {
          return;
        }
        loopContinuation.push(...items);
        requestInput.push(...items);
      };
      const appendOneShotInputItems = (items: OpenResponseInputItem[]) => {
        if (items.length === 0) {
          return;
        }
        pendingOneShotInputItems.push(...items);
      };
      const appendAvailableQueueNotifyToLoop = async () => {
        if (!options.queueBacked) {
          return;
        }
        if (!runtimePrompt) {
          return;
        }
        const claimer = (this.store as RuntimeStore & {
          claimNextQueueMessage?: RuntimeStore['claimNextQueueMessage'];
        }).claimNextQueueMessage;
        if (typeof claimer !== 'function') {
          return;
        }
        const claimed = await claimer.call(this.store, agentConfig.workerId);
        if (!claimed) {
          return;
        }
        continuationQueueMessages.push(claimed);
        const claimedInputItems = buildCurrentTurnInputItems(claimed.payload, runtimePrompt)
          .filter((item) => !isOpenResponseMessageInputItem(item) || flattenMessageContent(item.content).trim().length > 0);
        if (claimedInputItems.length > 0) {
          appendLoopInputItems(claimedInputItems);
        }
        await this.appendAgentStackItemsSafe({
          traceId: claimed.payload.traceId,
          runId: claimed.id,
          sourceType: 'agent_queue_messages',
          sourceId: claimed.id,
          items: [
            buildRuntimeInputStackItem({
              queueMessage: claimed.payload,
              runId: claimed.id,
              runtimePrompt,
              precomputedInputItems: claimedInputItems
            }) as Record<string, unknown>
          ]
        });
        await this.store.logTimelineEvent({
          traceId: payload.traceId,
          eventType: 'queue',
          eventName: 'nonblocking_notify_append',
          eventPhase: null,
          metadata: {
            source_run_id: queueMessage.id,
            appended_run_id: claimed.id,
            appended_batch_id: claimed.batchId,
            appended_queue_message_ids: claimed.queueMessageIds,
            appended_source: claimed.payload.source
          }
        }).catch((error) => {
          moduleLogger.warn('Failed to log nonblocking notify append', {
            traceId: payload.traceId,
            runId: queueMessage.id,
            appendedRunId: claimed.id,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      };
      let leaseRelease: LeaseReleaseRecord | null = null;
      let deliveryState = await this.store.getExecutionLeaseDeliveryState(queueMessage.id);
      if (options.appendRuntimeInputStackItem) {
        await this.appendAgentStackItemsSafe({
          traceId: payload.traceId,
          runId: queueMessage.id,
          sourceType: options.queueBacked ? 'agent_queue_messages' : 'agent_runtime',
          sourceId: queueMessage.id,
          items: [
            buildRuntimeInputStackItem({
              queueMessage: payload,
              runId: queueMessage.id,
              runtimePrompt,
              precomputedInputItems: budgetPlan.currentTurnInputItems
            }) as Record<string, unknown>
          ]
        });
      }
      const selfContinuationInputItem = budgetPlan.selfContinuationInputItem;
      if (selfContinuationInputItem) {
        await this.appendAgentStackItemsSafe({
          traceId: payload.traceId,
          runId: queueMessage.id,
          sourceType: 'agent_runtime',
          sourceId: queueMessage.id,
          items: [
            buildLoopSelfContinuationStackItem({
              queueMessage: payload,
              runId: queueMessage.id,
              turn: 1,
              inputItem: selfContinuationInputItem
            }) as Record<string, unknown>
          ]
        });
      }

      for (let turn = 1; ; turn += 1) {
        await this.waitForRuntimeEnabledBeforeModelSlice(payload, queueMessage.id);
        await this.yieldBeforeMainAgentModelSlice();
        turnsExecuted = turn;
        const turnBudgetRecord: ContextBudgetTurnRecord = {
          turn,
          estimatedInputTokens: budgetPlan.estimatedInputTokens,
          actualInputTokens: null,
          actualOutputTokens: null,
          actualTotalTokens: null,
          cachedInputTokens: null,
          reasoningTokens: null,
          processingTimeMs: null,
          readHistoryCount: budgetPlan.retainedHistory.length,
          readCutoffAfterConversationId: budgetPlan.readCutoffAfterConversationId,
          contextWindowTokens: budgetPlan.contextWindowTokens,
          targetBudgetTokens: budgetPlan.targetBudgetTokens,
          hardBudgetTokens: budgetPlan.hardBudgetTokens,
          tokenizerEncoding: budgetPlan.tokenizerEncoding,
          tokenizerSource: budgetPlan.tokenizerSource,
          cutoffRecomputed: turn === 1 ? budgetPlan.cutoffRecomputed : false
        };
        contextBudgetTurns.push(turnBudgetRecord);
        const currentRequestInput = pendingOneShotInputItems.length > 0
          ? [...requestInput, ...pendingOneShotInputItems]
          : requestInput;
        pendingOneShotInputItems = [];
        const currentCanonicalRequest = buildMainAgentCanonicalRequest(runtimePrompt, currentRequestInput, payload);
        const inputEndIndex = await this.getAgentStackHeadSafe(payload.traceId);
        const inputStartIndex = inputEndIndex > 0 ? 1 : null;
        const modelResult = await this.executeAgentTurn(
          currentCanonicalRequest,
          payload,
          payload.traceId,
          turn,
          runtimePrompt,
          {
            runId: queueMessage.id,
            inputStartIndex,
            inputEndIndex: inputEndIndex > 0 ? inputEndIndex : null
          }
        );
        attachActualUsageToTurnBudget(turnBudgetRecord, modelResult);
        const sliceId = modelResult.llm_request_slice_id || modelResult.llm_call_id || `slice:${payload.traceId}:${turn}`;
        const outputItems = extractCanonicalResponseOutputItems(modelResult);
        const outputStackRows = await this.appendAgentStackItemsSafe({
          traceId: payload.traceId,
          runId: queueMessage.id,
          sourceType: 'llm_request_slices',
          sourceId: sliceId,
          llmRequestSliceId: sliceId,
          items: buildModelOutputStackItems(outputItems, sliceId) as Array<Record<string, unknown>>
        });
        const outputStackIndexes = outputStackRows
          .map((row) => Number((row as { stackIndex?: unknown }).stackIndex))
          .filter((value) => Number.isFinite(value));
        const toolCallStackItemIdByCallId = new Map<string, string | number>();
        for (const row of outputStackRows) {
          const toolCallId = typeof (row as { toolCallId?: unknown }).toolCallId === 'string'
            ? (row as { toolCallId: string }).toolCallId
            : null;
          const itemKind = typeof (row as { itemKind?: unknown }).itemKind === 'string'
            ? (row as { itemKind: string }).itemKind
            : null;
          const id = (row as { id?: unknown }).id;
          if (toolCallId && itemKind === 'function_call' && (typeof id === 'string' || typeof id === 'number')) {
            toolCallStackItemIdByCallId.set(toolCallId, id);
          }
        }
        await this.updateLlmRequestSliceStackLinksSafe({
          sliceId,
          inputStartIndex,
          inputEndIndex: inputEndIndex > 0 ? inputEndIndex : null,
          outputStartIndex: outputStackIndexes.length > 0 ? Math.min(...outputStackIndexes) : null,
          outputEndIndex: outputStackIndexes.length > 0 ? Math.max(...outputStackIndexes) : null
        });
        const actionPlan = this.responseActionRouter.route(modelResult.canonical_response);
        const replayableOutputs = actionPlan.replayableOutputs;
        const hasToolCall = actionPlan.hasToolCall;
        await this.executeResponsePostActions(actionPlan.postActions, {
          queueMessage: payload,
          runId: queueMessage.id,
          turn,
          llmCallId: modelResult.llm_call_id || null
        });

        appendLoopInputItems(outputItems as OpenResponseInputItem[]);
        const toolReplayItems = replayableOutputs.filter(isReplayableToolCall);
        const orderedToolReplayItems = orderRuntimeToolCalls(toolReplayItems);
        const hasRecoverEnergyInBatch = toolReplayItems.some((item) => item.toolCall.name === TOOL_NAMES.recoverEnergy);
        const preSleepToolTimeline: PreSleepToolTimelineEntry[] = [];
        if (
          toolReplayItems.some((item) => item.toolCall.name === TOOL_NAMES.execCommand)
          && toolReplayItems.some((item) => item.toolCall.name === TOOL_NAMES.compressCoreMemory)
        ) {
          await this.store.logTimelineEvent({
            traceId: payload.traceId,
            eventType: 'memory',
            eventName: 'core_memory_parallel_mixed_batch_observed',
            eventPhase: null,
            metadata: {
              execution_mode: 'main_loop',
              llm_request_slice_id: sliceId,
              tool_call_order: toolReplayItems.map((item) => ({
                call_id: item.toolCall.callId,
                name: item.toolCall.name
              }))
            }
          }).catch((error) => {
            moduleLogger.warn('Failed to log mixed core memory parallel batch observation', {
              traceId: payload.traceId,
              runId: queueMessage.id,
              error: error instanceof Error ? error.message : String(error)
            });
          });
        }

        for (const replayItem of orderedToolReplayItems) {
          const toolCall = replayItem.toolCall;
          const stackToolExecutionId = `tool:${queueMessage.id}:${toolCall.callId}`;
          await this.recordAgentStackToolExecutionSafe({
            executionId: stackToolExecutionId,
            llmRequestSliceId: sliceId,
            llmCallId: modelResult.llm_call_id || null,
            toolCallId: toolCall.callId,
            toolName: toolCall.name,
            arguments: toolCall.args,
            rawArguments: toolCall.rawArguments,
            status: 'running',
            sideEffect: isToolCallSideEffecting(toolCall),
            traceId: payload.traceId,
            runId: queueMessage.id,
            agentTurn: turn,
            stackCallItemId: toolCallStackItemIdByCallId.get(toolCall.callId) || null,
            metadata: {
              model_name: runtimePrompt.modelName,
              session_key: payload.sessionKey,
              chat_type: payload.chatType,
              peer_name: payload.peerName || null
            }
          });

          try {
            let rawToolResult = await this.executeTool(toolCall, payload, {
              currentCanonicalRequest
            });
            let compressedContextSummary: string | null = null;
            if (toolCall.name === TOOL_NAMES.compressCoreMemory) {
              const commit = await this.commitCoreMemoryCompression({
                rawToolResult,
                toolCall,
                compression: budgetPlan.coreMemoryCompression,
                contextSessionKey,
                sourceResponseId: modelResult.llm_call_id || null,
                metadata: {
                  trace_id: payload.traceId,
                  execution_mode: 'main_loop'
                }
              });
              coreMemoryCompressionArtifact = commit.artifact;
              rawToolResult = commit.toolResult;
              compressedContextSummary = commit.text;
            }
            const toolResult = rawToolResult;
            if (toolCall.name === TOOL_NAMES.recoverEnergy && toolResult.recovery_session_requested === true) {
              const creator = (this.store as RuntimeStore & {
                createAgentRecoverySession?: RuntimeStore['createAgentRecoverySession'];
              }).createAgentRecoverySession;
              if (typeof creator !== 'function') {
                throw new Error('recover_energy requires recovery session persistence');
              }
              const startedAt = typeof toolResult.started_at === 'string' ? new Date(toolResult.started_at) : new Date();
              const clockDueAt = typeof toolResult.clock_due_at === 'string' ? new Date(toolResult.clock_due_at) : null;
              const persistedSessionPolicy = recoverySessionPolicyFromSnapshot(toolResult.recovery_policy_snapshot)
                ?? recoverySessionPolicyFromSnapshot(createRecoveryPolicySnapshot(startedAt))!;
              await creator.call(this.store, {
                initiator: 'recover_energy_tool',
                reason: typeof toolResult.reason === 'string' ? toolResult.reason : null,
                xiaoniOs: typeof toolResult.xiaoni_os === 'string' ? toolResult.xiaoni_os : null,
                clockMinutes: typeof toolResult.clock_minutes === 'number' ? toolResult.clock_minutes : null,
                clockDueAt,
                startedAt,
                toolExecutionId: stackToolExecutionId,
                llmRequestSliceId: sliceId,
                llmCallId: modelResult.llm_call_id || null,
                toolCallId: toolCall.callId,
                traceId: payload.traceId,
                runId: queueMessage.id,
                queueMessageId: queueMessage.id,
                startEnergy: typeof toolResult.energy_start === 'number' ? toolResult.energy_start : null,
                currentEnergy: typeof toolResult.energy === 'number' ? toolResult.energy : null,
                maxEnergy: typeof toolResult.max_energy === 'number' ? toolResult.max_energy : RUNTIME_MAX_ENERGY,
                startPressure: typeof toolResult.pressure === 'number' ? toolResult.pressure : null,
                currentPressure: typeof toolResult.pressure === 'number' ? toolResult.pressure : null,
                plannedNaturalWakeAt: typeof toolResult.planned_natural_wake_at === 'string' ? new Date(toolResult.planned_natural_wake_at) : null,
                hardWakeAt: typeof toolResult.hard_wake_at === 'string' ? new Date(toolResult.hard_wake_at) : estimateSessionWakeAt(startedAt, persistedSessionPolicy),
                wakeCountStartQueueMessageId: recoveryWakeCountStartQueueMessageId,
                metadata: {
                  model_name: runtimePrompt.modelName,
                  session_key: payload.sessionKey,
                  chat_type: payload.chatType,
                  peer_name: payload.peerName || null,
                  required_pressure: toolResult.required_pressure ?? null,
                  recovery_policy_snapshot: toolResult.recovery_policy_snapshot ?? null,
                  full_recovery_minutes: toolResult.full_recovery_minutes ?? null,
                  session_max_recovery_minutes: toolResult.session_max_recovery_minutes ?? null,
                  session_cap_wake_cause: toolResult.session_cap_wake_cause ?? null,
                  tool_args: toolCall.args,
                  raw_arguments: toolCall.rawArguments,
                  ...(preSleepToolTimeline.length > 0 ? {
                    batch_final_recovery: {
                      recovery_started_at: startedAt.toISOString(),
                      pre_sleep_tool_calls: preSleepToolTimeline,
                      tool_call_order: orderedToolReplayItems.map((item) => ({
                        call_id: item.toolCall.callId,
                        name: item.toolCall.name
                      }))
                    }
                  } : {})
                }
              });
              if (typeof toolResult.xiaoni_os === 'string' && toolResult.xiaoni_os.trim().length > 0) {
                persistedXiaoniOs = toolResult.xiaoni_os.trim();
              }
              leaseRelease = buildLeaseReleaseRecord({
                reason: 'runtime_frame_yielded',
                detail: 'recover_energy session started; tool callback will be appended when recovery settles.',
                outcome: 'recover_energy_session_started',
                noVisibleDelivery: true,
                visibleDeliveryCommitted: false,
                source: 'tool:recover_energy'
              });
              await this.store.logTimelineEvent({
                traceId: payload.traceId,
                eventType: 'decision',
                eventName: 'recover_energy_session_started',
                eventPhase: null,
                metadata: {
                  tool_call_id: toolCall.callId,
                  tool_execution_id: stackToolExecutionId,
                  clock_minutes: toolResult.clock_minutes ?? null
                }
              });
              break;
            }
            if (toolCall.name === TOOL_NAMES.recoverEnergy && toolResult.recovered === true) {
              const recoveryRecorder = (this.store as RuntimeStore & {
                recordRecoverEnergyLifeEvent?: RuntimeStore['recordRecoverEnergyLifeEvent'];
              }).recordRecoverEnergyLifeEvent;
              if (typeof recoveryRecorder === 'function') {
                await recoveryRecorder.call(this.store, {
                  queueMessage: payload,
                  runId: queueMessage.id,
                  toolName: toolCall.name,
                  toolResult
                }).catch((error) => {
                  moduleLogger.warn('Failed to record recover_energy life event', {
                    traceId: payload.traceId,
                    runId: queueMessage.id,
                    error: error instanceof Error ? error.message : String(error)
                  });
                });
              }
            }
            if (typeof toolResult?.xiaoni_os === 'string' && toolResult.xiaoni_os.trim().length > 0) {
              persistedXiaoniOs = toolResult.xiaoni_os.trim();
            }
            if (typeof toolResult?.pending_share === 'string' && toolResult.pending_share.trim().length > 0) {
              persistedPendingShare = toolResult.pending_share.trim();
            }
            if (toolCall.name === TOOL_NAMES.unreadMeaning) {
              unreadMeaningArtifact = toolResult;
            }

            if (extractSentMessages(toolResult).length > 0) {
              await this.store.markLeaseVisibleDeliveryCommitted(queueMessage.id);
              await this.recordVisibleDeliveryLifeEvents(payload, queueMessage.id, toolCall.name, toolResult);
              await this.store.logTimelineEvent({
                traceId: payload.traceId,
                eventType: 'decision',
                eventName: 'delivery_commit',
                eventPhase: null,
                metadata: {
                  tool_name: toolCall.name
                }
              });
              deliveryState = await this.store.getExecutionLeaseDeliveryState(queueMessage.id);
              deliveredMessages.push(...extractDeliveredAssistantMessages(toolResult));
            }

            const runtimeEnergyState = await this.getCurrentRuntimeEnergyState(payload);
            const continuation = applyToolResultToLoopInput(toolCall, toolResult, {
              loopInput: requestInput,
              speakingToolName: payload.chatType === 'direct' ? TOOL_NAMES.privateReply : TOOL_NAMES.groupReply,
              hasVisibleReply: deliveredMessages.length > 0,
              runtimeEnergyState
            });
            const toolOutputStackRows = await this.appendAgentStackItemsSafe({
              traceId: payload.traceId,
              runId: queueMessage.id,
              sourceType: 'tool_executions',
              sourceId: stackToolExecutionId,
              llmRequestSliceId: sliceId,
              items: buildToolResultStackItems({
                toolCall,
                toolResult,
                continuationItems: continuation.inputItems,
                llmRequestSliceId: sliceId
              }) as Array<Record<string, unknown>>
            });
            const stackOutputItemId = (toolOutputStackRows[0] as { id?: string | number } | undefined)?.id || null;
            await this.completeAgentStackToolExecutionSafe({
              executionId: stackToolExecutionId,
              status: 'completed',
              result: toolResult,
              stackOutputItemId
            });
            if (hasRecoverEnergyInBatch && toolCall.name !== TOOL_NAMES.recoverEnergy) {
              preSleepToolTimeline.push({
                call_id: toolCall.callId,
                name: toolCall.name,
                completed_at: new Date().toISOString(),
                status: 'completed'
              });
            }
            if (continuation.forcedVisibleReply) {
              await this.store.logTimelineEvent({
                traceId: payload.traceId,
                eventType: 'decision',
                eventName: 'forced_visible_reply',
                eventPhase: null,
                metadata: {
                  source_tool_name: toolCall.name,
                  tool_name: continuation.forcedVisibleReply.toolName
                }
              });
              const forcedToolResult = await this.sendMessage(
                continuation.forcedVisibleReply.toolName === TOOL_NAMES.privateReply ? 'private' : 'group',
                {
                  ...buildInternalExplicitSendTargetArgs(
                    continuation.forcedVisibleReply.toolName === TOOL_NAMES.privateReply ? 'private' : 'group',
                    payload
                  ),
                  ...continuation.forcedVisibleReply.args
                },
                payload
              );
              if (typeof forcedToolResult?.xiaoni_os === 'string' && forcedToolResult.xiaoni_os.trim().length > 0) {
                persistedXiaoniOs = forcedToolResult.xiaoni_os.trim();
              }
              if (typeof forcedToolResult?.pending_share === 'string' && forcedToolResult.pending_share.trim().length > 0) {
                persistedPendingShare = forcedToolResult.pending_share.trim();
              }
              await this.store.markLeaseVisibleDeliveryCommitted(queueMessage.id);
              await this.recordVisibleDeliveryLifeEvents(payload, queueMessage.id, continuation.forcedVisibleReply.toolName, forcedToolResult, true);
              await this.store.logTimelineEvent({
                traceId: payload.traceId,
                eventType: 'decision',
                eventName: 'delivery_commit',
                eventPhase: null,
                metadata: {
                  tool_name: continuation.forcedVisibleReply.toolName,
                  forced: true
                }
              });
              deliveryState = await this.store.getExecutionLeaseDeliveryState(queueMessage.id);
              deliveredMessages.push(...extractDeliveredAssistantMessages(forcedToolResult));
              leaseRelease = buildLeaseReleaseRecord({
                reason: 'visible_delivery_committed',
                detail: 'A visible reply was forced after a side-effecting tool produced work that still needed an acknowledgement.',
                outcome: 'forced_visible_delivery_committed',
                noVisibleDelivery: false,
                visibleDeliveryCommitted: true,
                source: `tool:${continuation.forcedVisibleReply.toolName}`,
                toolResult: forcedToolResult
              });
              break;
            }
            if (continuation.inputItems.length > 0) {
              appendLoopInputItems(continuation.inputItems);
            }
            if (continuation.oneShotInputItems.length > 0) {
              appendOneShotInputItems(continuation.oneShotInputItems);
            }
            if (compressedContextSummary && budgetPlan.coreMemoryCompression) {
              requestInput = buildLoopRequestInput({
                history: budgetPlan.retainedHistory,
                queueMessage: payload,
                runtimePrompt,
                loopContinuation,
                runtimeIdentityFacts: budgetPlan.runtimeIdentityFacts,
                contextSummary: compressedContextSummary,
                pendingProactiveShare: budgetPlan.pendingProactiveShare,
                developerContextBlock,
                runtimeEnergyState,
                triggerInputMode: 'suppress_current_trigger'
              });
            }
          } catch (error) {
            const toolResult = buildToolErrorResult(toolCall, error);
            const message = String(toolResult.error_message || toolResult.error || 'Tool execution failed');
            const runtimeEnergyState = await this.getCurrentRuntimeEnergyState(payload);
            const continuation = applyToolResultToLoopInput(toolCall, toolResult, {
              loopInput: requestInput,
              speakingToolName: payload.chatType === 'direct' ? TOOL_NAMES.privateReply : TOOL_NAMES.groupReply,
              hasVisibleReply: deliveredMessages.length > 0,
              runtimeEnergyState
            });
            const toolOutputStackRows = await this.appendAgentStackItemsSafe({
              traceId: payload.traceId,
              runId: queueMessage.id,
              sourceType: 'tool_executions',
              sourceId: stackToolExecutionId,
              llmRequestSliceId: sliceId,
              items: buildToolResultStackItems({
                toolCall,
                toolResult,
                continuationItems: continuation.inputItems,
                llmRequestSliceId: sliceId
              }) as Array<Record<string, unknown>>
            });
            const stackOutputItemId = (toolOutputStackRows[0] as { id?: string | number } | undefined)?.id || null;
            await this.completeAgentStackToolExecutionSafe({
              executionId: stackToolExecutionId,
              status: 'failed',
              result: toolResult,
              errorMessage: message,
              stackOutputItemId
            });
            await this.store.logTimelineEvent({
              traceId: payload.traceId,
              eventType: 'tool',
              eventName: 'tool_execution_failed_model_visible',
              eventPhase: null,
              metadata: {
                tool_name: toolCall.name,
                tool_call_id: toolCall.callId,
                tool_execution_id: stackToolExecutionId,
                error_message: message
              }
            }).catch((timelineError) => {
              moduleLogger.warn('Failed to log model-visible tool error', {
                traceId: payload.traceId,
                runId: queueMessage.id,
                toolName: toolCall.name,
                error: timelineError instanceof Error ? timelineError.message : String(timelineError)
              });
            });
            if (continuation.inputItems.length > 0) {
              appendLoopInputItems(continuation.inputItems);
            }
            if (continuation.oneShotInputItems.length > 0) {
              appendOneShotInputItems(continuation.oneShotInputItems);
            }
            if (hasRecoverEnergyInBatch && toolCall.name !== TOOL_NAMES.recoverEnergy) {
              preSleepToolTimeline.push({
                call_id: toolCall.callId,
                name: toolCall.name,
                completed_at: new Date().toISOString(),
                status: 'failed'
              });
            }
          }
        }
        if (!hasToolCall && !actionPlan.hasFinalAnswer && !leaseRelease) {
          deliveryState = await this.store.getExecutionLeaseDeliveryState(queueMessage.id);
          if (deliveryState.deliveryPhase !== 'reasoning_open' && deliveredMessages.length > 0) {
            leaseRelease = buildLeaseReleaseRecord({
              reason: 'visible_delivery_committed',
              detail: 'Visible delivery was already committed; this bounded model slice stopped without another replayable final_answer.',
              outcome: 'frame_yielded_after_visible_delivery_without_final_answer',
              noVisibleDelivery: false,
              visibleDeliveryCommitted: true,
              source: 'model:no_tool_after_visible_delivery'
            });
          }
        }
        if (!leaseRelease && actionPlan.hasFinalAnswer) {
          leaseRelease = buildLeaseReleaseRecord({
            reason: deliveredMessages.length > 0 ? 'visible_delivery_committed' : 'runtime_frame_yielded',
            detail: deliveredMessages.length > 0
              ? 'Visible delivery was committed; this frame yielded to the runtime loop without another model call.'
              : 'Assistant final_answer reached; control returns to the Notify Bucket before any further main-agent model call.',
            outcome: deliveredMessages.length > 0
              ? 'frame_yielded_after_visible_delivery'
              : 'final_answer_yielded',
            noVisibleDelivery: deliveredMessages.length === 0,
            visibleDeliveryCommitted: deliveredMessages.length > 0,
            source: deliveredMessages.length > 0 ? 'runtime:visible_delivery_frame_yield' : 'runtime:frame_yield'
          });
        }
        if (!leaseRelease && !hasToolCall && outputItems.length === 0) {
          leaseRelease = buildLeaseReleaseRecord({
            reason: 'runtime_frame_yielded',
            detail: 'Model slice returned no replayable output item; control returns to the runtime loop to avoid repeating an unchanged request.',
            outcome: 'model_slice_yielded',
            noVisibleDelivery: deliveredMessages.length === 0,
            visibleDeliveryCommitted: deliveredMessages.length > 0,
            source: 'runtime:empty_model_slice_yield'
          });
        }
        if (!leaseRelease) {
          await appendAvailableQueueNotifyToLoop();
          continue;
        }

        await this.store.logTimelineEvent({
          traceId: payload.traceId,
          eventType: 'decision',
          eventName: 'lease_released',
          eventPhase: null,
          metadata: leaseRelease
        });
        break;
      }

      const sentMessages = deliveredMessages.map((message) => message.content);
      const finalResponse = sentMessages.length > 0 ? sentMessages.join('\n\n') : null;
      persistedXiaoniOs = appendPendingShareToXiaoniOs(persistedXiaoniOs, persistedPendingShare);
      const responseReplayItems = extractResponseReplayInputItems(loopContinuation);
      const runtimeStream = buildRuntimeStreamMetadata(payload, {
        contextSessionKey,
        responseReplayItemCount: responseReplayItems.length,
        turnsExecuted
      });
      conversationId = await this.store.createConversation({
        userId: sessionIds.userId,
        groupId: sessionIds.groupId,
        userMessage: renderConversationStorageUserMessage(payload),
        aiResponse: finalResponse,
        sessionKey: payload.sessionKey,
        transcriptItems: [
          ...buildInboundBatchTranscriptItems(payload),
          ...buildAssistantTranscriptItems({
            queueMessage: payload,
            deliveredMessages,
            leaseReleased: true
          }).map((item) => ({
            sessionKey: item.sessionKey,
            role: item.role,
            phase: item.phase,
            content: item.content,
            groupIndex: item.groupIndex,
            itemIndex: item.itemIndex,
            source: item.source,
            deliveryMessageId: item.deliveryMessageId,
            runId: item.runId,
            traceId: item.traceId
          }))
        ],
        responseTimeMs: Date.now() - startedAt,
        status: 'settled',
        modelName: runtimePrompt?.modelName || null,
        traceId: payload.traceId,
        rawRequest: {
          run_id: queueMessage.id,
          batch_id: queueMessage.batchId,
          queue_message_ids: queueMessage.queueMessageIds,
          continuation_queue_message_ids: continuationQueueMessages.flatMap((message) => message.queueMessageIds),
          continuation_runs: continuationQueueMessages.map((message) => ({
            run_id: message.id,
            batch_id: message.batchId,
            trace_id: message.traceId,
            source: message.payload.source,
            queue_message_ids: message.queueMessageIds
          })),
          batch_messages: payload.messages,
          history_count: historyCount,
          retained_history_count: budgetPlan.retainedHistory.length,
          context_budget: {
            context_session_key: contextSessionKey,
            context_window_tokens: budgetPlan.contextWindowTokens,
            target_budget_tokens: budgetPlan.targetBudgetTokens,
            hard_budget_tokens: budgetPlan.hardBudgetTokens,
            estimated_input_tokens: budgetPlan.estimatedInputTokens,
            tokenizer_encoding: budgetPlan.tokenizerEncoding,
            tokenizer_source: budgetPlan.tokenizerSource,
            read_cutoff_after_conversation_id: budgetPlan.readCutoffAfterConversationId,
            cutoff_recomputed: budgetPlan.cutoffRecomputed
          },
          prompt: {
            source: runtimePrompt.source,
            prompt_id: runtimePrompt.promptId,
            prompt_name: runtimePrompt.promptName,
            model_name: runtimePrompt.modelName
          },
          retrieved_feedback_reflections: [],
          runtime_identity_facts: runtimeIdentityFacts,
          runtime_stream: runtimeStream
        },
        rawResponse: {
          sent_messages: sentMessages,
          xiaoni_os: persistedXiaoniOs,
          pending_share: persistedPendingShare,
          loop_stage_artifacts: {
            unread_meaning: unreadMeaningArtifact,
            core_memory_compression: coreMemoryCompressionArtifact
          },
          context_budget_turns: contextBudgetTurns.map(serializeContextBudgetTurnRecord),
          responses_replay_items: responseReplayItems,
          runtime_stream: runtimeStream,
          model_request_slices: turnsExecuted,
          lease_release: leaseRelease,
          lease_release_reason: leaseRelease.reason,
          no_visible_delivery: leaseRelease.no_visible_delivery
        }
      });
      if (evictedTurns.length > 0) {
        this.scheduleContextCompressionMemoryWriter({
          queueMessage: payload,
          conversationId,
          evictedTurns,
          runtimePrompt
        });
      }

      await this.recordRuntimeIdentityActivation({
        queueMessage: payload,
        conversationId,
        runtimeIdentityFacts
      });

      await this.store.attachConversationIdToTrace(payload.traceId, conversationId);
      for (const continuationQueueMessage of continuationQueueMessages) {
        await this.store.attachConversationIdToTrace(continuationQueueMessage.payload.traceId, conversationId);
      }
      if (options.queueBacked) {
        const queueSettleResult = {
          no_visible_delivery: leaseRelease.no_visible_delivery,
          sent_messages: sentMessages,
          xiaoni_os: persistedXiaoniOs,
          pending_share: persistedPendingShare,
          stored_feedback_reflection_ids: storedFeedbackReflectionIds,
          model_request_slices: turnsExecuted,
          lease_release: leaseRelease,
          core_memory_compression: coreMemoryCompressionArtifact,
          lease_release_reason: leaseRelease.reason,
          continuation_queue_message_ids: continuationQueueMessages.flatMap((message) => message.queueMessageIds)
        };
        await this.store.settleQueueMessages(queueMessage.id, {
          conversationId,
          result: queueSettleResult
        });
        for (const continuationQueueMessage of continuationQueueMessages) {
          await this.store.settleQueueMessages(continuationQueueMessage.id, {
            conversationId,
            result: {
              ...queueSettleResult,
              consumed_as_nonblocking_notify: true,
              parent_run_id: queueMessage.id
            }
          });
        }
      }
      const presenceOutcome = sentMessages.length > 0 ? 'replied' : 'silent';
      if (presenceContext) {
        const sidecarRecorder = (this.store as RuntimeStore & {
          recordPresenceSidecar?: RuntimeStore['recordPresenceSidecar'];
        }).recordPresenceSidecar;
        if (typeof sidecarRecorder === 'function') {
          await sidecarRecorder.call(this.store, {
            queueMessage: payload,
            presenceContext,
            outcome: presenceOutcome
          }).catch((error) => {
            moduleLogger.warn('Failed to record presence sidecar', {
              traceId: payload.traceId,
              error: error instanceof Error ? error.message : String(error)
            });
          });
        }
      }
      if (options.queueBacked) {
        await this.store.releaseExecutionLease(queueMessage.id, {
          status: 'settled',
          leaseRelease,
          noVisibleDelivery: leaseRelease.no_visible_delivery,
          finalResponse,
          sentMessages,
          modelRequestSlices: turnsExecuted,
          conversationId
        });
        for (const continuationQueueMessage of continuationQueueMessages) {
          await this.store.releaseExecutionLease(continuationQueueMessage.id, {
            status: 'settled',
            leaseRelease,
            noVisibleDelivery: leaseRelease.no_visible_delivery,
            finalResponse,
            sentMessages,
            modelRequestSlices: turnsExecuted,
            conversationId
          });
        }
      }
      if (jobId) {
        await this.store.updateLlmJob(jobId, {
          status: 'settled',
          finalResponse,
          totalTurns: turnsExecuted,
          conversationId
        });
      }
      if (sentMessages.length === 0 && leaseRelease.reason !== 'runtime_frame_yielded') {
        await this.recordNoVisibleDeliveryLifeEvent(payload, queueMessage.id, presenceOutcome, leaseRelease, turnsExecuted, conversationId);
      }
      await this.store.logTimelineEvent({
        traceId: payload.traceId,
        eventType: 'decision',
        eventName: 'execution_lease',
        eventPhase: 'end',
        conversationId,
        metadata: {
          sent_count: sentMessages.length,
          model_request_slices: turnsExecuted,
          lease_release_reason: leaseRelease.reason
        },
        durationMs: Date.now() - startedAt
      });

      moduleLogger.info('Agent queue message processed', {
        traceId: payload.traceId,
        runId: queueMessage.id,
        batchId: queueMessage.batchId,
        conversationId,
        sentCount: sentMessages.length,
        turnsExecuted
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const sentMessages = deliveredMessages.map((item) => item.content);
      const responseReplayItems = extractResponseReplayInputItems(loopContinuation);
      const transientQueueRetryEligible = options.queueBacked
        && sentMessages.length === 0
        && isTransientProviderExecutionError(error)
        && queueMessage.attempts < (queueMessage.maxAttempts ?? 3);
      const runtimeStream = buildRuntimeStreamMetadata(payload, {
        contextSessionKey: getGlobalPromptContextSessionKey(),
        responseReplayItemCount: responseReplayItems.length,
        turnsExecuted
      });
      const leaseRelease = buildLeaseReleaseRecord({
        reason: error instanceof MissingAgentPromptBindingError ? 'prompt_binding_error' : 'runtime_error',
        detail: message,
        outcome: 'failed',
        noVisibleDelivery: sentMessages.length === 0,
        visibleDeliveryCommitted: sentMessages.length > 0,
        source: 'runtime:error'
      });
      conversationId = await this.store.createConversation({
        userId: sessionIds.userId,
        groupId: sessionIds.groupId,
        userMessage: renderConversationStorageUserMessage(payload),
        aiResponse: null,
        sessionKey: payload.sessionKey,
        transcriptItems: [
          ...buildInboundBatchTranscriptItems(payload),
          ...buildAssistantTranscriptItems({
            queueMessage: payload,
            deliveredMessages,
            leaseReleased: true
          }).map((item) => ({
            sessionKey: item.sessionKey,
            role: item.role,
            phase: item.phase,
            content: item.content,
            groupIndex: item.groupIndex,
            itemIndex: item.itemIndex,
            source: item.source,
            deliveryMessageId: item.deliveryMessageId,
            runId: item.runId,
            traceId: item.traceId
          }))
        ],
        responseTimeMs: Date.now() - startedAt,
        status: 'failed',
        errorReason: message,
        modelName: runtimePrompt?.modelName || null,
        traceId: payload.traceId,
        rawRequest: {
          run_id: queueMessage.id,
          batch_id: queueMessage.batchId,
          queue_message_ids: queueMessage.queueMessageIds,
          batch_messages: payload.messages,
          history_count: historyCount,
          retained_history_count: budgetPlan.retainedHistory.length,
          context_budget: {
            context_window_tokens: budgetPlan.contextWindowTokens,
            target_budget_tokens: budgetPlan.targetBudgetTokens,
            hard_budget_tokens: budgetPlan.hardBudgetTokens,
            estimated_input_tokens: budgetPlan.estimatedInputTokens,
            tokenizer_encoding: budgetPlan.tokenizerEncoding,
            tokenizer_source: budgetPlan.tokenizerSource,
            read_cutoff_after_conversation_id: budgetPlan.readCutoffAfterConversationId,
            cutoff_recomputed: budgetPlan.cutoffRecomputed
          },
          prompt: {
            source: runtimePrompt?.source || null,
            prompt_id: runtimePrompt?.promptId || null,
            prompt_name: runtimePrompt?.promptName || null,
            model_name: runtimePrompt?.modelName || null
          },
          runtime_stream: runtimeStream
        },
        rawResponse: {
          sent_messages: sentMessages,
          xiaoni_os: null,
          context_budget_turns: contextBudgetTurns.map(serializeContextBudgetTurnRecord),
          responses_replay_items: responseReplayItems,
          runtime_stream: runtimeStream,
          model_request_slices: turnsExecuted,
          lease_release: leaseRelease,
          lease_release_reason: leaseRelease.reason,
          no_visible_delivery: leaseRelease.no_visible_delivery,
          queue_retry_eligible: transientQueueRetryEligible
        }
      });
      await this.store.attachConversationIdToTrace(payload.traceId, conversationId);
      let queueRetryScheduled = false;
      if (transientQueueRetryEligible) {
        const retryStore = this.store as RuntimeStore & {
          retryQueueMessage?: (runId: string, params: { errorMessage: string; retryDelayMs?: number }) => Promise<number>;
        };
        if (typeof retryStore.retryQueueMessage === 'function') {
          const retryDelayMs = computeTransientQueueRetryDelayMs(queueMessage.attempts);
          const retried = await retryStore.retryQueueMessage.call(this.store, queueMessage.id, {
            errorMessage: message,
            retryDelayMs
          }).catch((retryError) => {
            moduleLogger.warn('Failed to requeue transient agent queue failure', {
              traceId: payload.traceId,
              runId: queueMessage.id,
              error: retryError instanceof Error ? retryError.message : String(retryError)
            });
            return 0;
          });
          queueRetryScheduled = retried > 0;
          if (queueRetryScheduled) {
            await this.store.logTimelineEvent({
              traceId: payload.traceId,
              eventType: 'decision',
              eventName: 'queue_retry_scheduled',
              eventPhase: null,
              conversationId,
              metadata: {
                run_id: queueMessage.id,
                attempts: queueMessage.attempts,
                max_attempts: queueMessage.maxAttempts ?? 3,
                retry_delay_ms: retryDelayMs,
                error_message: message
              }
            }).catch((timelineError) => {
              moduleLogger.warn('Failed to log transient queue retry schedule', {
                traceId: payload.traceId,
                runId: queueMessage.id,
                error: timelineError instanceof Error ? timelineError.message : String(timelineError)
              });
            });
          }
        }
      }
      if (options.queueBacked && !queueRetryScheduled) {
        await this.store.failQueueMessage(queueMessage.id, message, conversationId);
        for (const continuationQueueMessage of continuationQueueMessages) {
          await this.store.failQueueMessage(continuationQueueMessage.id, message, conversationId);
        }
      }
      if (presenceContext) {
        const sidecarRecorder = (this.store as RuntimeStore & {
          recordPresenceSidecar?: RuntimeStore['recordPresenceSidecar'];
        }).recordPresenceSidecar;
        if (typeof sidecarRecorder === 'function') {
          await sidecarRecorder.call(this.store, {
            queueMessage: payload,
            presenceContext,
            outcome: sentMessages.length > 0 ? 'replied' : 'silent'
          }).catch((sidecarError) => {
            moduleLogger.warn('Failed to record failed-run presence sidecar', {
              traceId: payload.traceId,
              error: sidecarError instanceof Error ? sidecarError.message : String(sidecarError)
            });
          });
        }
      }
      if (options.queueBacked) {
        await this.store.releaseExecutionLease(queueMessage.id, {
          status: 'failed',
          leaseRelease,
          noVisibleDelivery: leaseRelease.no_visible_delivery,
          finalResponse: sentMessages.length > 0 ? sentMessages.join('\n\n') : null,
          sentMessages,
          modelRequestSlices: turnsExecuted,
          errorMessage: message,
          conversationId
        });
        for (const continuationQueueMessage of continuationQueueMessages) {
          await this.store.releaseExecutionLease(continuationQueueMessage.id, {
            status: 'failed',
            leaseRelease,
            noVisibleDelivery: leaseRelease.no_visible_delivery,
            finalResponse: sentMessages.length > 0 ? sentMessages.join('\n\n') : null,
            sentMessages,
            modelRequestSlices: turnsExecuted,
            errorMessage: message,
            conversationId
          });
        }
      }
      if (jobId) {
        await this.store.updateLlmJob(jobId, {
          status: 'failed',
          errorMessage: message,
          totalTurns: turnsExecuted,
          conversationId,
          finalResponse: sentMessages.length > 0 ? sentMessages.join('\n\n') : null
        });
      }
      await this.store.logTimelineEvent({
        traceId: payload.traceId,
        eventType: 'decision',
        eventName: 'execution_lease',
        eventPhase: 'end',
        conversationId,
        metadata: {
          error_message: message,
          model_request_slices: turnsExecuted,
          lease_release_reason: leaseRelease.reason
        },
        durationMs: Date.now() - startedAt
      });
      moduleLogger.error('Agent queue message failed', {
        traceId: payload.traceId,
        runId: queueMessage.id,
        batchId: queueMessage.batchId,
        conversationId,
        error: message,
        retryScheduled: queueRetryScheduled
      });
    }
  }

  private async buildDeveloperContextBlock(_queueMessage: QueueMessageRecord['payload']): Promise<string | null> {
    return null;
  }

  private async loadRuntimeIdentityFacts(queueMessage: QueueMessageRecord['payload']): Promise<RuntimeIdentityFactProjection[]> {
    const loader = (this.store as RuntimeStore & {
      listAcceptedIdentityFacts?: RuntimeStore['listAcceptedIdentityFacts'];
    }).listAcceptedIdentityFacts;
    if (typeof loader !== 'function') {
      return [];
    }

    try {
      const facts = await loader.call(this.store, {
        identityKey: XIAONI_IDENTITY_KEY,
        status: 'active',
        limit: 12
      });
      return selectRuntimeIdentityFacts({
        facts,
        queueMessage,
        limit: RUNTIME_IDENTITY_FACT_LIMIT
      });
    } catch (error) {
      moduleLogger.warn('Failed to load runtime identity facts', {
        traceId: queueMessage.traceId,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  private async ensureRuntimeIdentityRoot(
    queueMessage: QueueMessageRecord['payload'],
    runtimePrompt: ResolvedAgentRuntimePrompt
  ) {
    const snapshot = typeof runtimePrompt.identityGenesisSnapshot === 'string'
      ? runtimePrompt.identityGenesisSnapshot.trim()
      : runtimePrompt.systemPrompt.trim();
    if (!snapshot) {
      return;
    }

    const ensureRoot = (this.store as RuntimeStore & {
      ensureXiaoniIdentityRoot?: RuntimeStore['ensureXiaoniIdentityRoot'];
    }).ensureXiaoniIdentityRoot;
    if (typeof ensureRoot !== 'function') {
      return;
    }

    try {
      await ensureRoot.call(this.store, {
        identityKey: XIAONI_IDENTITY_KEY,
        sourcePromptId: runtimePrompt.promptId,
        systemInstructionSnapshot: snapshot,
        createdBy: 'agent-service',
        metadata: {
          prompt_name: runtimePrompt.promptName,
          prompt_source: runtimePrompt.source,
          trace_id: queueMessage.traceId,
          run_id: queueMessage.runId,
          canonical_identity_key: XIAONI_IDENTITY_KEY
        }
      });
    } catch (error) {
      moduleLogger.warn('Failed to ensure Xiaoni identity root', {
        traceId: queueMessage.traceId,
        promptId: runtimePrompt.promptId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async recordRuntimeIdentityActivation(params: {
    queueMessage: QueueMessageRecord['payload'];
    conversationId: number;
    runtimeIdentityFacts: RuntimeIdentityFactProjection[];
  }) {
    if (params.runtimeIdentityFacts.length === 0) {
      return;
    }
    const recorder = (this.store as RuntimeStore & {
      recordRuntimeIdentityActivationTrace?: RuntimeStore['recordRuntimeIdentityActivationTrace'];
    }).recordRuntimeIdentityActivationTrace;
    if (typeof recorder !== 'function') {
      return;
    }

    try {
      await recorder.call(this.store, {
        identityKey: XIAONI_IDENTITY_KEY,
        runId: params.queueMessage.runId,
        traceId: params.queueMessage.traceId,
        conversationId: params.conversationId,
        sceneFingerprint: buildIdentitySceneFingerprint(params.queueMessage),
        cueSummary: params.queueMessage.bodyForAgent,
        activatedRefs: params.runtimeIdentityFacts.map((fact) => ({
          accepted_fact_id: fact.id,
          fact_key: fact.factKey,
          fact_type: fact.factType,
          confidence: fact.confidence
        })),
        suppressedRefs: [],
        selectedSkillRef: 'accepted_identity_facts',
        activationReason: 'accepted identity facts were selected for runtime metadata',
        metadata: {
          session_key: params.queueMessage.sessionKey,
          chat_type: params.queueMessage.chatType
        }
      });
    } catch (error) {
      moduleLogger.warn('Failed to record runtime identity activation trace', {
        traceId: params.queueMessage.traceId,
        conversationId: params.conversationId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private scheduleContextCompressionMemoryWriter(params: ContextCompressionMemoryParams) {
    if (!CONTEXT_COMPRESSION_MEMORY_WRITER_ENABLED) {
      const traceId = `${params.queueMessage.traceId}:subagent:${CONTEXT_COMPRESSION_MEMORY_SUBAGENT_TYPE}`;
      void this.store.logTimelineEvent({
        traceId,
        eventType: 'subagent',
        eventName: CONTEXT_COMPRESSION_MEMORY_SUBAGENT_TYPE,
        eventPhase: 'end',
        conversationId: params.conversationId,
        metadata: {
          subagent_status: 'disabled',
          parent_trace_id: params.queueMessage.traceId,
          parent_run_id: params.queueMessage.runId,
          reason: 'disabled_pending_cache_session_isolation_review'
        }
      }).catch(() => undefined);
      return;
    }

    void this.runContextCompressionMemoryWriter(params).catch((error) => {
      const traceId = `${params.queueMessage.traceId}:subagent:${CONTEXT_COMPRESSION_MEMORY_SUBAGENT_TYPE}`;
      moduleLogger.warn('Context compression memory writer failed', {
        traceId: params.queueMessage.traceId,
        conversationId: params.conversationId,
        evictedTurnCount: params.evictedTurns.length,
        error: error instanceof Error ? error.message : String(error)
      });
      void this.store.logTimelineEvent({
        traceId,
        eventType: 'subagent',
        eventName: CONTEXT_COMPRESSION_MEMORY_SUBAGENT_TYPE,
        eventPhase: 'end',
        conversationId: params.conversationId,
        metadata: {
          subagent_status: 'failed',
          parent_trace_id: params.queueMessage.traceId,
          error: error instanceof Error ? error.message : String(error)
        }
      }).catch(() => undefined);
    });
  }

  private async runContextCompressionMemoryWriter(params: ContextCompressionMemoryParams) {
    const traceId = `${params.queueMessage.traceId}:subagent:${CONTEXT_COMPRESSION_MEMORY_SUBAGENT_TYPE}`;
    const groupId = Number.isFinite(Number(params.queueMessage.peerId)) ? Number(params.queueMessage.peerId) : null;
    const messageIdsByTurnId = buildSourceMessageIdsByTurnId(params.evictedTurns);
    const participantDirectory = buildCompactMemoryParticipantDirectory(params.evictedTurns);
    const compactModelName = agentConfig.compactMemoryModelName;
    const reflectionModelName = agentConfig.compactMemoryReflectionModelName;

    await this.store.logTimelineEvent({
      traceId,
      eventType: 'subagent',
      eventName: CONTEXT_COMPRESSION_MEMORY_SUBAGENT_TYPE,
      eventPhase: 'start',
      conversationId: params.conversationId,
      metadata: {
        parent_trace_id: params.queueMessage.traceId,
        parent_run_id: params.queueMessage.runId,
        evicted_turn_count: params.evictedTurns.length,
        evicted_turn_ids: params.evictedTurns.map((t) => t.id),
        memory_architecture: 'episodic_semantic_reflection',
        episodic_model: compactModelName,
        semantic_model: compactModelName,
        reflection_model: reflectionModelName
      }
    }).catch(() => undefined);

    const episodicToolCall = await this.runCompactMemoryLayer({
      params,
      traceId,
      promptCacheKey: buildSubagentPromptCacheKey({
        queueMessage: params.queueMessage,
        subagentType: CONTEXT_COMPRESSION_MEMORY_SUBAGENT_TYPE,
        layer: 'episodic'
      }),
      layer: 'episodic',
      modelName: compactModelName,
      reasoningEffort: agentConfig.compactMemoryReasoningEffort,
      input: buildCompactMemoryWriterInput({
        layer: 'episodic',
        evictedTurns: params.evictedTurns,
        runtimePrompt: params.runtimePrompt
      })
    });
    const observations = parseCompactMemoryObservations(episodicToolCall.args);
    const persistedObservations: PersistedMemoryObservation[] = [];
    for (const observation of observations) {
      const sourceMessageIds = collectSourceMessageIds(observation.sourceTurnIds, messageIdsByTurnId);
      const participants = normalizeCompactMemoryParticipants(observation.participants, participantDirectory);
      const stored = await this.store.createAgentMemoryObservation({
        sessionKey: params.queueMessage.sessionKey,
        groupId,
        sourceConversationId: params.conversationId,
        sourceTurnIds: observation.sourceTurnIds,
        sourceMessageIds,
        topic: observation.topic,
        text: observation.text,
        poignancy: observation.poignancy,
        participants,
        xiaoniRole: observation.xiaoniRole,
        sourceTraceId: traceId,
        sourceRunId: params.queueMessage.runId,
        writerModel: compactModelName,
        metadata: {
          parent_trace_id: params.queueMessage.traceId,
          memory_layer: 'episodic',
          source: 'context_compression_evicted_turns'
        }
      });
      persistedObservations.push({
        id: Number(stored.id),
        topic: observation.topic,
        text: observation.text,
        participants,
        xiaoniRole: observation.xiaoniRole,
        sourceTurnIds: observation.sourceTurnIds,
        sourceMessageIds,
        createdAt: (stored as { created_at?: string | Date | null }).created_at ?? null
      });
    }

    const semanticToolCall = await this.runCompactMemoryLayer({
      params,
      traceId,
      promptCacheKey: buildSubagentPromptCacheKey({
        queueMessage: params.queueMessage,
        subagentType: CONTEXT_COMPRESSION_MEMORY_SUBAGENT_TYPE,
        layer: 'semantic'
      }),
      layer: 'semantic',
      modelName: compactModelName,
      reasoningEffort: agentConfig.compactMemoryReasoningEffort,
      input: buildCompactMemoryWriterInput({
        layer: 'semantic',
        evictedTurns: params.evictedTurns,
        runtimePrompt: params.runtimePrompt
      })
    });
    const assertions = parseCompactMemoryAssertions(semanticToolCall.args);
    for (const assertion of assertions) {
      const participants = normalizeCompactMemoryParticipants(assertion.participants, participantDirectory);
      const owners = normalizeCompactMemoryParticipants(assertion.owners, participantDirectory);
      const directedTo = normalizeCompactMemoryParticipants(assertion.directedTo, participantDirectory);
      await this.store.createAgentMemoryAssertion({
        sessionKey: params.queueMessage.sessionKey,
        groupId,
        sourceConversationId: params.conversationId,
        sourceTurnIds: assertion.sourceTurnIds,
        sourceMessageIds: collectSourceMessageIds(assertion.sourceTurnIds, messageIdsByTurnId),
        text: assertion.text,
        factType: assertion.factType,
        entities: assertion.entities,
        participants,
        sourceTraceId: traceId,
        sourceRunId: params.queueMessage.runId,
        writerModel: compactModelName,
        metadata: {
          parent_trace_id: params.queueMessage.traceId,
          memory_layer: 'semantic',
          source: 'context_compression_evicted_turns',
          scope: assertion.scope,
          owners,
          directed_to: directedTo,
          evidence_summary: assertion.evidenceSummary,
          xiaoni_relevance: assertion.xiaoniRelevance
        }
      });
    }

    let reflectionCount = 0;
    if (persistedObservations.length >= 2) {
      const reflectionToolCall = await this.runCompactMemoryLayer({
        params,
        traceId,
        promptCacheKey: buildSubagentPromptCacheKey({
          queueMessage: params.queueMessage,
          subagentType: CONTEXT_COMPRESSION_MEMORY_SUBAGENT_TYPE,
          layer: 'reflection'
        }),
        layer: 'reflection',
        modelName: reflectionModelName,
        reasoningEffort: agentConfig.compactMemoryReflectionReasoningEffort,
        input: buildCompactMemoryReflectionInput({
          observations: persistedObservations,
          runtimePrompt: params.runtimePrompt
        })
      });
      const validObservationIds = new Set(persistedObservations.map((observation) => observation.id));
      const sourceMessageIdsByObservationId = new Map(
        persistedObservations.map((observation) => [observation.id, observation.sourceMessageIds])
      );
      for (const reflection of parseCompactMemoryReflections(reflectionToolCall.args)) {
        const sourceObservationIds = reflection.sourceObservationIds.filter((id) => validObservationIds.has(id));
        if (sourceObservationIds.length < 2) {
          continue;
        }
        await this.store.createAgentMemoryReflection({
          sessionKey: params.queueMessage.sessionKey,
          groupId,
          sourceConversationId: params.conversationId,
          text: reflection.text,
          kind: reflection.kind,
          subjects: reflection.subjects,
          evidenceBasis: reflection.evidenceBasis,
          evidenceTimeStart: reflection.evidenceTimeStart,
          evidenceTimeEnd: reflection.evidenceTimeEnd,
          poignancy: reflection.poignancy,
          sourceObservationIds,
          sourceMessageIds: uniquePositiveNumbers(sourceObservationIds.flatMap((id) => sourceMessageIdsByObservationId.get(id) || [])),
          sourceTraceId: traceId,
          sourceRunId: params.queueMessage.runId,
          writerModel: reflectionModelName,
          metadata: {
            parent_trace_id: params.queueMessage.traceId,
            memory_layer: 'reflection',
            source: 'episodic_observations',
            subject_participants: normalizeCompactMemoryParticipants(reflection.subjectParticipants, participantDirectory),
            object_participants: normalizeCompactMemoryParticipants(reflection.objectParticipants, participantDirectory),
            evidence_summary: reflection.evidenceSummary,
            self_continuity_note: reflection.selfContinuityNote
          }
        });
        reflectionCount += 1;
      }
    }

    await this.store.logTimelineEvent({
      traceId,
      eventType: 'subagent',
      eventName: CONTEXT_COMPRESSION_MEMORY_SUBAGENT_TYPE,
      eventPhase: 'end',
      conversationId: params.conversationId,
      metadata: {
        subagent_status: 'settled',
        observation_count: persistedObservations.length,
        assertion_count: assertions.length,
        reflection_count: reflectionCount
      }
    }).catch(() => undefined);
  }

  private async runCompactMemoryLayer(params: {
    params: ContextCompressionMemoryParams;
    traceId: string;
    promptCacheKey: string;
    layer: CompactMemoryLayer;
    modelName: string;
    reasoningEffort: string;
    input: OpenResponseInputItem[];
  }) {
    const canonicalRequest = buildCompactMemoryWriterRequest(
      params.modelName,
      params.input,
      {
        metadata: buildCompactMemorySubagentTurnMetadata({
          queueMessage: params.params.queueMessage,
          runtimePrompt: params.params.runtimePrompt,
          conversationId: params.params.conversationId,
          subagentTraceId: params.traceId,
          layer: params.layer
        }),
        promptCacheKey: params.promptCacheKey,
        layer: params.layer,
        reasoningEffort: params.reasoningEffort,
        textVerbosity: agentConfig.compactMemoryTextVerbosity
      }
    );
    const requestBody = JSON.stringify({
      trace_id: params.traceId,
      agent_turn: 1,
      agent_type: `${CONTEXT_COMPRESSION_MEMORY_SUBAGENT_TYPE}:${params.layer}`,
      prompt_name: `${params.params.runtimePrompt.promptName}:${CONTEXT_COMPRESSION_MEMORY_SUBAGENT_TYPE}:${params.layer}`,
      model: params.modelName,
      parameters: buildCompactMemoryAgentParameters(params.params.runtimePrompt.parameters as Record<string, unknown> | undefined),
      canonicalRequest
    });

    let responsePayload: ProviderAgentResponse | null = null;
    for (let attempt = 1; attempt <= COMPACT_MEMORY_PROVIDER_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(`${agentConfig.providerServiceUrl}/api/internal/agent/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody
        });
        responsePayload = await response.json() as ProviderAgentResponse;
        if (response.ok && responsePayload.success) {
          break;
        }
        const error = new Error(responsePayload.error || `Compact memory ${params.layer} writer failed with ${response.status}`);
        if (attempt >= COMPACT_MEMORY_PROVIDER_MAX_ATTEMPTS || !isTransientProviderExecutionError(error)) {
          throw error;
        }
      } catch (error) {
        if (attempt >= COMPACT_MEMORY_PROVIDER_MAX_ATTEMPTS || !isTransientProviderExecutionError(error)) {
          throw error;
        }
      }
      await delay(100 * attempt);
    }

    if (!responsePayload?.success) {
      throw new Error(`Compact memory ${params.layer} writer failed without a successful provider response`);
    }

    const toolOutput = extractReplayableModelOutputs(responsePayload.canonical_response).find(isReplayableToolCall);
    if (!toolOutput || toolOutput.toolCall.name !== COMPACT_MEMORY_TOOL_NAME_BY_LAYER[params.layer]) {
      throw new Error(`Compact memory ${params.layer} writer did not call ${COMPACT_MEMORY_TOOL_NAME_BY_LAYER[params.layer]}`);
    }
    return toolOutput.toolCall;
  }

  private scheduleFeedbackMemorySubagent(params: FeedbackMemorySubagentParams) {
    void this.runFeedbackMemorySubagent(params).catch((error) => {
      const traceId = `${params.queueMessage.traceId}:subagent:${FEEDBACK_MEMORY_SUBAGENT_TYPE}`;
      moduleLogger.warn('Feedback memory subagent failed', {
        traceId: params.queueMessage.traceId,
        conversationId: params.conversationId,
        error: error instanceof Error ? error.message : String(error)
      });
      void this.store.logTimelineEvent({
        traceId,
        eventType: 'subagent',
        eventName: FEEDBACK_MEMORY_SUBAGENT_TYPE,
        eventPhase: 'end',
        conversationId: params.conversationId,
        metadata: {
          subagent_status: 'failed',
          parent_trace_id: params.queueMessage.traceId,
          error: error instanceof Error ? error.message : String(error)
        }
      }).catch(() => undefined);
    });
  }

  private async runFeedbackMemorySubagent(params: FeedbackMemorySubagentParams) {
    const traceId = `${params.queueMessage.traceId}:subagent:${FEEDBACK_MEMORY_SUBAGENT_TYPE}`;

    await this.store.logTimelineEvent({
      traceId,
      eventType: 'subagent',
      eventName: FEEDBACK_MEMORY_SUBAGENT_TYPE,
      eventPhase: 'start',
      conversationId: params.conversationId,
      metadata: {
        parent_trace_id: params.queueMessage.traceId,
        parent_run_id: params.queueMessage.runId,
        parent_agent_type: 'chat_bot',
        subagent_type: FEEDBACK_MEMORY_SUBAGENT_TYPE
      }
    }).catch(() => undefined);

    await this.store.logTimelineEvent({
      traceId,
      eventType: 'subagent',
      eventName: FEEDBACK_MEMORY_SUBAGENT_TYPE,
      eventPhase: 'end',
      conversationId: params.conversationId,
      metadata: {
        subagent_status: 'disabled_feedback_episode_tool_removed',
        parent_trace_id: params.queueMessage.traceId,
        parent_run_id: params.queueMessage.runId
      }
    }).catch(() => undefined);
  }

  private async executeFeedbackWriterTool(
    toolCall: AgentToolCall,
    deps: {
      queueMessage: QueueMessageRecord['payload'];
      conversationId: number;
      evidence?: FeedbackWriterEvidence;
      persistedReflectionId: number | null;
      activeLearningKey: string;
      activeLearningScope: string;
      stateGetter?: RuntimeStore['getFeedbackLearningState'];
      reflectionCreator: RuntimeStore['createFeedbackReflection'];
      stateUpserter: RuntimeStore['upsertFeedbackLearningState'];
      identityCandidateAppender?: RuntimeStore['appendIdentityChangeCandidate'];
      acceptedIdentityFactCreator?: RuntimeStore['createAcceptedIdentityFact'];
      mode: FeedbackWriterMode;
    }
  ) {
    const evidence = deps.evidence ?? buildQueueMessageFeedbackWriterEvidence(deps.queueMessage, deps.conversationId);
    const groupId = Number.isFinite(Number(deps.queueMessage.peerId)) ? Number(deps.queueMessage.peerId) : null;

    switch (toolCall.name) {
      case TOOL_NAMES.feedbackReflection: {
        if (deps.mode !== 'durable_lessons') {
          throw new Error(`${TOOL_NAMES.feedbackReflection} is only allowed during context compression`);
        }
        const reflection = parseFeedbackReflectionSynthesis(toolCall.args);
        if (!reflection) {
          throw new Error(`${TOOL_NAMES.feedbackReflection} returned invalid arguments`);
        }
        const currentState = typeof deps.stateGetter === 'function'
          ? await deps.stateGetter.call(this.store, {
              sessionKey: deps.queueMessage.sessionKey,
              groupId,
              scopeType: 'group_self',
              learningKey: reflection.learningKey,
              learningScope: reflection.learningScope
            }).catch(() => null)
          : null;
        const storedReflection = await deps.reflectionCreator.call(this.store, {
          sessionKey: deps.queueMessage.sessionKey,
          groupId,
          sourceUserId: evidence.sourceUserId,
          sourceUserName: evidence.sourceUserName,
          scopeType: 'group_self',
          learningKey: reflection.learningKey,
          learningScope: reflection.learningScope,
          reflectionType: reflection.reflectionType,
          feedbackKind: reflection.feedbackKind,
          confidence: reflection.confidence,
          importanceScore: reflection.importanceScore,
          evidenceWeight: reflection.evidenceWeight,
          stabilityScore: reflection.stabilityScore,
          summaryText: reflection.summaryText,
          retrievalText: reflection.retrievalText,
          embeddingText: reflection.embeddingText,
          sourceMessageIds: evidence.sourceMessageIds,
          sourceEpisodeIds: [],
          sourceConversationId: evidence.sourceConversationId,
          supersedesReflectionId: reflection.supersedeLatest ? (currentState?.latestReflectionId ?? null) : null,
          conflictGroupKey: reflection.conflictGroupKey,
          metadata: {
            trace_id: deps.queueMessage.traceId,
            synthesis_reason: reflection.reason,
            writer_source: evidence.writerSource,
            ...evidence.metadata
          }
        });
        let identityCandidateId: number | null = null;
        let acceptedIdentityFactId: number | null = null;
        const identityJudge = judgeFeedbackReflectionAsIdentityFact(reflection);
        if (typeof deps.identityCandidateAppender === 'function') {
          const candidateResult = await deps.identityCandidateAppender.call(this.store, {
            identityKey: XIAONI_IDENTITY_KEY,
            candidateType: 'natural_growth',
            proposedBy: evidence.writerSource,
            proposedFrom: 'agent_feedback_reflection',
            claimText: reflection.summaryText,
            afterSummary: reflection.retrievalText,
            status: identityJudge.status,
            judgeStatus: identityJudge.judgeStatus,
            judgeReason: identityJudge.reason,
            judgeRunId: deps.queueMessage.runId,
            judgedAt: new Date(),
            quarantineGroupKey: identityJudge.status === 'quarantined' ? reflection.conflictGroupKey || reflection.learningKey : null,
            metadata: {
              trace_id: deps.queueMessage.traceId,
              source_reflection_id: storedReflection.id,
              learning_key: reflection.learningKey,
              learning_scope: reflection.learningScope,
              reflection_type: reflection.reflectionType,
              feedback_kind: reflection.feedbackKind,
              importance_score: reflection.importanceScore,
              evidence_weight: reflection.evidenceWeight,
              stability_score: reflection.stabilityScore,
              phase1_judge_engine: 'hard_check_feedback_reflection'
            },
            evidenceRefs: [
              {
                sourceType: 'agent_feedback_reflection',
                sourceId: String(storedReflection.id),
                traceId: deps.queueMessage.traceId,
                runId: deps.queueMessage.runId,
                conversationId: evidence.sourceConversationId,
                confidence: reflection.confidence
              }
            ],
            lineageMetadata: {
              judge_status: identityJudge.judgeStatus,
              judge_reason: identityJudge.reason
            }
          }).catch((error) => {
            moduleLogger.warn('Failed to append identity candidate from feedback reflection', {
              traceId: deps.queueMessage.traceId,
              reflectionId: storedReflection.id,
              error: error instanceof Error ? error.message : String(error)
            });
            return null;
          });
          identityCandidateId = Number(candidateResult?.candidate?.id) || null;
        }
        if (identityJudge.status === 'accepted' && identityCandidateId && typeof deps.acceptedIdentityFactCreator === 'function') {
          const factResult = await deps.acceptedIdentityFactCreator.call(this.store, {
            identityKey: XIAONI_IDENTITY_KEY,
            factKey: buildFactKeyFromReflection(reflection),
            factText: reflection.summaryText,
            factType: reflection.reflectionType === 'self_model_update' ? 'self_boundary' : 'social_lesson',
            sourceCandidateId: identityCandidateId,
            confidence: reflection.confidence,
            activationTags: parseStringArray([
              reflection.learningKey,
              reflection.learningScope,
              reflection.feedbackKind,
              deps.queueMessage.senderName || ''
            ]),
            metadata: {
              trace_id: deps.queueMessage.traceId,
              source_reflection_id: storedReflection.id,
              retrieval_text: reflection.retrievalText,
              phase1_judge_reason: identityJudge.reason
            },
            evidenceRefs: [
              {
                sourceType: 'agent_feedback_reflection',
                sourceId: String(storedReflection.id),
                traceId: deps.queueMessage.traceId,
                runId: deps.queueMessage.runId,
                conversationId: evidence.sourceConversationId,
                confidence: reflection.confidence
              }
            ],
            lineageMetadata: {
              source: evidence.writerSource,
              judge_reason: identityJudge.reason
            }
          }).catch((error) => {
            moduleLogger.warn('Failed to create accepted identity fact from feedback reflection', {
              traceId: deps.queueMessage.traceId,
              reflectionId: storedReflection.id,
              identityCandidateId,
              error: error instanceof Error ? error.message : String(error)
            });
            return null;
          });
          acceptedIdentityFactId = Number(factResult?.fact?.id) || null;
        }
        return {
          reflection_id: storedReflection.id,
          identity_candidate_id: identityCandidateId,
          accepted_identity_fact_id: acceptedIdentityFactId,
          identity_judge_status: identityJudge.judgeStatus,
          learning_key: reflection.learningKey,
          learning_scope: reflection.learningScope,
          reason: reflection.reason
        };
      }
      case TOOL_NAMES.feedbackLearningState: {
        if (deps.mode !== 'durable_lessons') {
          throw new Error(`${TOOL_NAMES.feedbackLearningState} is only allowed during context compression`);
        }
        const state = parseFeedbackLearningStateCandidate(toolCall.args);
        if (!state) {
          throw new Error(`${TOOL_NAMES.feedbackLearningState} returned invalid arguments`);
        }
        if (!deps.persistedReflectionId || !deps.activeLearningKey || !deps.activeLearningScope) {
          throw new Error('Feedback writer learning_state step requires a persisted reflection');
        }
        const currentState = typeof deps.stateGetter === 'function'
          ? await deps.stateGetter.call(this.store, {
              sessionKey: deps.queueMessage.sessionKey,
              groupId,
              scopeType: 'group_self',
              learningKey: deps.activeLearningKey,
              learningScope: deps.activeLearningScope
            }).catch(() => null)
          : null;
        const storedState = await deps.stateUpserter.call(this.store, {
          sessionKey: deps.queueMessage.sessionKey,
          groupId,
          scopeType: 'group_self',
          learningKey: deps.activeLearningKey,
          learningScope: deps.activeLearningScope,
          stateType: state.stateType,
          activeReflectionId: state.activateNewReflection ? deps.persistedReflectionId : (currentState?.activeReflectionId ?? deps.persistedReflectionId),
          latestReflectionId: deps.persistedReflectionId,
          activationWeight: state.activationWeight,
          recencyWeight: state.recencyWeight,
          importanceWeight: state.importanceWeight,
          sourceWeight: state.sourceWeight,
          conflictPenalty: state.conflictPenalty,
          metadata: {
            trace_id: deps.queueMessage.traceId,
            update_reason: state.reason
          }
        });
        return {
          writer_settled: true,
          learning_state_id: storedState.id,
          learning_key: deps.activeLearningKey,
          learning_scope: deps.activeLearningScope,
          reason: state.reason
        };
      }
      default:
        throw new Error(`Unsupported feedback writer tool: ${toolCall.name}`);
    }
  }

  private async buildContextBudgetPlan(params: {
    history: ConversationTurn[];
    queueMessage: QueueMessageRecord['payload'];
    runtimePrompt: ResolvedAgentRuntimePrompt;
    loopContinuation: OpenResponseInputItem[];
    runtimeIdentityFacts: RuntimeIdentityFactProjection[];
    developerContextBlock?: string | null;
    runtimeEnergyState?: RuntimeEnergyState | null;
    contextSessionKey?: string;
    cutoffState?: SessionReadCutoffState | null;
    triggerInputMode?: RuntimeTriggerInputMode;
    appendSelfContinuationOnTerminalFinalAnswer?: boolean;
    loopContinuationBeforeCurrentTrigger?: boolean;
    // Operator-forced compaction (manual admin trigger). When true the overflow
    // gate is bypassed: instead of compressing only when the live window exceeds
    // the context budget, we compress everything older than the most recent
    // HISTORY_COMPACT_KEEP turns regardless of current token pressure. Used to
    // pre-shorten the cacheable prefix before shipping a prefix-cache-breaking
    // change, so the next prime pays for the compressed prefix once instead of
    // priming the full window now and re-priming after the natural overflow later.
    forceCompression?: boolean;
  }): Promise<ContextBudgetPlan> {
    const policy = resolveModelContextPolicy(
      params.runtimePrompt.modelName,
      params.runtimePrompt.parameters as Record<string, unknown> | undefined
    );
    const rawContextWindowTokens = policy?.contextWindowTokens ?? null;
    const calibrationSessionKey = params.contextSessionKey || getGlobalPromptContextSessionKey();
    if (!tokenizerCalibrationBySession.has(calibrationSessionKey)) {
      // seed with the model-specific baseline (1.2 expansion for Claude) before refining
      tokenizerCalibrationBySession.set(calibrationSessionKey, defaultCalibrationForModel(params.runtimePrompt.modelName));
    }
    const tokenizerCalibration = getTokenizerCalibration(calibrationSessionKey);
    // o200k_base undercounts Claude => calibration > 1 => shrink the effective
    // window so compression triggers at the model's real token budget.
    const contextWindowTokens = rawContextWindowTokens
      ? Math.max(1, Math.floor(rawContextWindowTokens / tokenizerCalibration))
      : null;
    const targetBudgetTokens = contextWindowTokens ? Math.max(1, Math.floor(contextWindowTokens * READ_HISTORY_TARGET_RATIO)) : null;
    const hardBudgetTokens = contextWindowTokens ? Math.max(1, Math.floor(contextWindowTokens * READ_HISTORY_HARD_RATIO)) : null;
    const contextSessionKey = params.contextSessionKey || getGlobalPromptContextSessionKey();
    const cutoffState = Object.prototype.hasOwnProperty.call(params, 'cutoffState')
      ? params.cutoffState ?? null
      : await this.store.getSessionReadCutoffState(contextSessionKey);
    const contextSummary = cutoffState?.contextSummary ?? null;
    const pendingProactiveShare = cutoffState?.pendingProactiveShare ?? null;
    const pendingProactiveShareAge = cutoffState?.pendingProactiveShareAge ?? 0;
    const initialRetainedHistory = applyReadCutoff(params.history, cutoffState);
    const triggerInputMode = params.triggerInputMode ?? 'fresh_trigger';

    // Build the current-turn reminder ONCE. The sent request (below, incl. the
    // anchored variant) and the runtime_input 存档 (processRuntimeFrame persist)
    // both reuse this exact array. Previously each rebuilt it via its own
    // new Date(), drifting the [当前时间] stamp ~1s, so the next run replayed
    // bytes that didn't match what this run cached -> whole-body cache 击穿 at
    // every run boundary. The compression fork builds its own input (different
    // ephemeral agent, never replayed) and intentionally does NOT share this.
    const currentTurnInputItems = buildCurrentTurnInputItems(params.queueMessage, params.runtimePrompt)
      .filter((item) => !isOpenResponseMessageInputItem(item) || flattenMessageContent(item.content).trim().length > 0);

    const appendedSelfContinuationInputItems: OpenResponseInputItem[] = [];
    const requestInput = buildLoopRequestInput({
      history: initialRetainedHistory,
      queueMessage: params.queueMessage,
      runtimePrompt: params.runtimePrompt,
      loopContinuation: params.loopContinuation,
      runtimeIdentityFacts: params.runtimeIdentityFacts,
      contextSummary,
      pendingProactiveShare,
      developerContextBlock: params.developerContextBlock ?? null,
      runtimeEnergyState: params.runtimeEnergyState ?? null,
      triggerInputMode,
      appendSelfContinuationOnTerminalFinalAnswer: params.appendSelfContinuationOnTerminalFinalAnswer ?? false,
      appendedSelfContinuationInputItems,
      loopContinuationBeforeCurrentTrigger: params.loopContinuationBeforeCurrentTrigger ?? false,
      precomputedCurrentTurnInputItems: currentTurnInputItems
    });
    const selfContinuationInputItem = appendedSelfContinuationInputItems[0] ?? null;
    const estimate = await estimateLoopInputTokens({
      modelName: params.runtimePrompt.modelName,
      queueMessage: params.queueMessage,
      loopInput: requestInput
    });

    if (!contextWindowTokens || !targetBudgetTokens || !hardBudgetTokens) {
      return {
        requestInput,
        currentTurnInputItems,
        selfContinuationInputItem,
        summarySourceInput: null,
        retainedHistory: initialRetainedHistory,
        runtimeIdentityFacts: params.runtimeIdentityFacts,
        readCutoffAfterConversationId: cutoffState?.readCutoffAfterConversationId ?? null,
        previousReadCutoffAfterConversationId: cutoffState?.readCutoffAfterConversationId ?? null,
        estimatedInputTokens: estimate.inputTokens,
        contextWindowTokens,
        targetBudgetTokens,
        hardBudgetTokens,
        tokenizerEncoding: estimate.encoding,
        tokenizerSource: estimate.source,
        cutoffRecomputed: false,
        contextSummary,
        pendingProactiveShare,
        pendingProactiveShareAge,
        coreMemoryCompression: null
      };
    }

    if (!params.forceCompression && (estimate.inputTokens <= contextWindowTokens || initialRetainedHistory.length === 0)) {
      return {
        requestInput,
        currentTurnInputItems,
        selfContinuationInputItem,
        summarySourceInput: null,
        retainedHistory: initialRetainedHistory,
        runtimeIdentityFacts: params.runtimeIdentityFacts,
        readCutoffAfterConversationId: cutoffState?.readCutoffAfterConversationId ?? null,
        previousReadCutoffAfterConversationId: cutoffState?.readCutoffAfterConversationId ?? null,
        estimatedInputTokens: estimate.inputTokens,
        contextWindowTokens,
        targetBudgetTokens,
        hardBudgetTokens,
        tokenizerEncoding: estimate.encoding,
        tokenizerSource: estimate.source,
        cutoffRecomputed: false,
        contextSummary,
        pendingProactiveShare,
        pendingProactiveShareAge,
        coreMemoryCompression: null
      };
    }

    const compressionPoint = params.forceCompression
      ? planReadCutoffForForcedCompression(initialRetainedHistory)
      : await planReadCutoffFromFirstOverflow({
          history: initialRetainedHistory,
          queueMessage: params.queueMessage,
          runtimePrompt: params.runtimePrompt,
          loopContinuation: params.loopContinuation,
          contextWindowTokens,
          runtimeIdentityFacts: params.runtimeIdentityFacts,
          contextSummary,
          pendingProactiveShare,
          developerContextBlock: params.developerContextBlock ?? null,
          runtimeEnergyState: params.runtimeEnergyState ?? null,
          triggerInputMode,
          appendSelfContinuationOnTerminalFinalAnswer: params.appendSelfContinuationOnTerminalFinalAnswer ?? false,
          loopContinuationBeforeCurrentTrigger: params.loopContinuationBeforeCurrentTrigger ?? false
        });
    if (!compressionPoint) {
      return {
        requestInput,
        currentTurnInputItems,
        selfContinuationInputItem,
        summarySourceInput: null,
        retainedHistory: initialRetainedHistory,
        runtimeIdentityFacts: params.runtimeIdentityFacts,
        readCutoffAfterConversationId: cutoffState?.readCutoffAfterConversationId ?? null,
        previousReadCutoffAfterConversationId: cutoffState?.readCutoffAfterConversationId ?? null,
        estimatedInputTokens: estimate.inputTokens,
        contextWindowTokens,
        targetBudgetTokens,
        hardBudgetTokens,
        tokenizerEncoding: estimate.encoding,
        tokenizerSource: estimate.source,
        cutoffRecomputed: false,
        contextSummary,
        pendingProactiveShare,
        pendingProactiveShareAge,
        coreMemoryCompression: null
      };
    }
    const historyTargets = resolveSessionTargets(params.queueMessage);
    const compression = {
      required: true as const,
      contextSessionKey,
      readCutoffAfterConversationId: compressionPoint.readCutoffAfterConversationId,
      previousReadCutoffAfterConversationId: cutoffState?.readCutoffAfterConversationId ?? null,
      compressionCoveredEndConversationId: compressionPoint.compressionCoveredEndConversationId,
      historyUserId: historyTargets.userId,
      historyGroupId: historyTargets.groupId,
      historyScope: 'global' as const,
      lastContextWindowTokens: contextWindowTokens,
      lastTargetBudgetTokens: targetBudgetTokens,
      lastHardBudgetTokens: hardBudgetTokens
    };
    // Byte-stable, number-free instruction. The token counts / conversation ids /
    // offsets that used to live here are internal bookkeeping (already carried in the
    // fork metadata) — they are noise to 小腻 and, because they change every run, they
    // churned the reminder tail and worked against a stable cache. The reminder only
    // needs to tell the summarizer what to do; the cutoff math stays in code/metadata.
    const pressureSummary = '把当前可压缩的稳定旧上下文整理成新的核心记忆近况，保留最近的衔接内容继续往下做。';
    // NOTE: the compression fork is deliberately fed the HEAD slice only
    // (summarySourceHistory), NOT the full retained history — so the summarizer
    // compresses exactly the evicted head and never re-summarizes retained-tail
    // items (enforced by the "isolated background fork" test). This head-only input
    // is a separately-built prefix, so on Claude it does NOT byte-match the main
    // turn's warm requestInput entry; the compression fork's first read is therefore
    // a one-time cold prefill. We accept that: compression is rare, and the post-
    // compression rebuild (new M1 summary at the head) invalidates the messages-tier
    // prefix cache anyway, so warming the head read would be a small, rare, largely-
    // negated win at the cost of breaking the head-only summarization invariant.
    const summarySourceInput = buildLoopRequestInput({
      history: compressionPoint.summarySourceHistory,
      queueMessage: params.queueMessage,
      runtimePrompt: params.runtimePrompt,
      loopContinuation: [
        ...params.loopContinuation,
        buildCoreMemoryCompressionReminder({
          contextSessionKey,
          readCutoffAfterConversationId: compressionPoint.readCutoffAfterConversationId,
          pressureSummary
        })
      ],
      runtimeIdentityFacts: params.runtimeIdentityFacts,
      contextSummary,
      pendingProactiveShare,
      developerContextBlock: params.developerContextBlock ?? null,
      runtimeEnergyState: params.runtimeEnergyState ?? null,
      triggerInputMode,
      appendSelfContinuationOnTerminalFinalAnswer: params.appendSelfContinuationOnTerminalFinalAnswer ?? false,
      loopContinuationBeforeCurrentTrigger: params.loopContinuationBeforeCurrentTrigger ?? false
    });

    // Cache reuse for the compression fork: rebuild the main turn's requestInput with
    // a cache breakpoint pinned at the compression head boundary (the last turn the
    // fork will summarize). The main turn then writes/refreshes the [..H_X] entry
    // every turn it runs, so when the (head-only) compression fork reads up to H_X it
    // hits that warm entry via the 20-block lookback instead of cold-prefilling the
    // whole near-window history. The anchor is a non-content marker, so requestInput's
    // bytes (and token estimate) are unchanged and its head stays identical to the
    // fork's head. We keep the fork head-only — this does NOT change what the
    // summarizer reads, only where the main turn places its cache breakpoint.
    const compressionHeadBoundaryConversationId =
      compressionPoint.summarySourceHistory.length > 0
        ? (compressionPoint.summarySourceHistory[compressionPoint.summarySourceHistory.length - 1] as { id?: number } | undefined)?.id ?? null
        : null;
    let anchoredRequestInput = requestInput;
    let anchoredSelfContinuationInputItem = selfContinuationInputItem;
    if (typeof compressionHeadBoundaryConversationId === 'number') {
      const rebuiltSelfContinuation: OpenResponseInputItem[] = [];
      anchoredRequestInput = buildLoopRequestInput({
        history: initialRetainedHistory,
        queueMessage: params.queueMessage,
        runtimePrompt: params.runtimePrompt,
        loopContinuation: params.loopContinuation,
        runtimeIdentityFacts: params.runtimeIdentityFacts,
        contextSummary,
        pendingProactiveShare,
        developerContextBlock: params.developerContextBlock ?? null,
        runtimeEnergyState: params.runtimeEnergyState ?? null,
        triggerInputMode,
        appendSelfContinuationOnTerminalFinalAnswer: params.appendSelfContinuationOnTerminalFinalAnswer ?? false,
        appendedSelfContinuationInputItems: rebuiltSelfContinuation,
        loopContinuationBeforeCurrentTrigger: params.loopContinuationBeforeCurrentTrigger ?? false,
        cacheAnchorAfterConversationId: compressionHeadBoundaryConversationId,
        precomputedCurrentTurnInputItems: currentTurnInputItems
      });
      anchoredSelfContinuationInputItem = rebuiltSelfContinuation[0] ?? selfContinuationInputItem;
    }

    return {
      requestInput: anchoredRequestInput,
      currentTurnInputItems,
      selfContinuationInputItem: anchoredSelfContinuationInputItem,
      summarySourceInput,
      retainedHistory: initialRetainedHistory,
      runtimeIdentityFacts: params.runtimeIdentityFacts,
      readCutoffAfterConversationId: cutoffState?.readCutoffAfterConversationId ?? null,
      previousReadCutoffAfterConversationId: cutoffState?.readCutoffAfterConversationId ?? null,
      estimatedInputTokens: estimate.inputTokens,
      contextWindowTokens,
      targetBudgetTokens,
      hardBudgetTokens,
      tokenizerEncoding: estimate.encoding,
      tokenizerSource: estimate.source,
      cutoffRecomputed: false,
      contextSummary,
      pendingProactiveShare,
      pendingProactiveShareAge,
      coreMemoryCompression: compression
    };
  }

  private async buildCoreMemoryCompressionCheckpoint(params: {
    history: ConversationTurn[];
    queueMessage: QueueMessageRecord['payload'];
    runtimePrompt: ResolvedAgentRuntimePrompt;
    loopContinuation: OpenResponseInputItem[];
    runtimeIdentityFacts: RuntimeIdentityFactProjection[];
    developerContextBlock?: string | null;
    runtimeEnergyState?: RuntimeEnergyState | null;
    contextSessionKey?: string;
    cutoffState?: SessionReadCutoffState | null;
    triggerInputMode?: RuntimeTriggerInputMode;
    appendSelfContinuationOnTerminalFinalAnswer?: boolean;
    loopContinuationBeforeCurrentTrigger?: boolean;
  }): Promise<CoreMemoryCompressionCheckpoint | null> {
    const plan = await this.buildContextBudgetPlan(params);
    return plan.coreMemoryCompression && plan.summarySourceInput
      ? {
          compression: plan.coreMemoryCompression,
          summarySourceInput: plan.summarySourceInput
        }
      : null;
  }

  private async executeResponsePostActions(
    postActions: ResponsePostAction[],
    context: {
      queueMessage: QueueMessageRecord['payload'];
      runId: string;
      turn: number;
      llmCallId: string | null;
    }
  ) {
    void postActions;
    void context;
  }

  private async getAgentStackHeadSafe(traceId: string) {
    const reader = (this.store as RuntimeStore & {
      getAgentStackHead?: RuntimeStore['getAgentStackHead'];
    }).getAgentStackHead;
    if (typeof reader !== 'function') {
      return 0;
    }
    try {
      return await reader.call(this.store, XIAONI_IDENTITY_KEY);
    } catch (error) {
      moduleLogger.warn('Failed to read Xiaoni agent stack head', {
        traceId,
        error: error instanceof Error ? error.message : String(error)
      });
      return 0;
    }
  }

  private async appendAgentStackItemsSafe(params: {
    traceId: string;
    runId: string;
    sourceType?: string | null;
    sourceId?: string | null;
    llmRequestSliceId?: string | null;
    conversationId?: number | null;
    items: Array<Record<string, unknown>>;
  }) {
    const appender = (this.store as RuntimeStore & {
      appendAgentStackItems?: RuntimeStore['appendAgentStackItems'];
    }).appendAgentStackItems;
    if (typeof appender !== 'function' || params.items.length === 0) {
      return [];
    }
    try {
      return await appender.call(this.store, {
        identityKey: XIAONI_IDENTITY_KEY,
        traceId: params.traceId,
        runId: params.runId,
        sourceType: params.sourceType || null,
        sourceId: params.sourceId || null,
        llmRequestSliceId: params.llmRequestSliceId || null,
        conversationId: params.conversationId ?? null,
        items: params.items
      }) as Array<Record<string, unknown>>;
    } catch (error) {
      moduleLogger.warn('Failed to append Xiaoni agent stack items', {
        traceId: params.traceId,
        runId: params.runId,
        itemCount: params.items.length,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  private async updateLlmRequestSliceStackLinksSafe(params: Parameters<RuntimeStore['updateLlmRequestSliceStackLinks']>[0]) {
    const updater = (this.store as RuntimeStore & {
      updateLlmRequestSliceStackLinks?: RuntimeStore['updateLlmRequestSliceStackLinks'];
    }).updateLlmRequestSliceStackLinks;
    if (typeof updater !== 'function') {
      return null;
    }
    try {
      return await updater.call(this.store, params);
    } catch (error) {
      moduleLogger.warn('Failed to update Xiaoni LLM request slice stack links', {
        sliceId: params.sliceId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async recordAgentStackToolExecutionSafe(params: Parameters<RuntimeStore['recordAgentStackToolExecution']>[0]) {
    const recorder = (this.store as RuntimeStore & {
      recordAgentStackToolExecution?: RuntimeStore['recordAgentStackToolExecution'];
    }).recordAgentStackToolExecution;
    if (typeof recorder !== 'function') {
      return null;
    }
    try {
      return await recorder.call(this.store, params);
    } catch (error) {
      moduleLogger.warn('Failed to record Xiaoni stack tool execution', {
        traceId: params.traceId,
        runId: params.runId,
        toolCallId: params.toolCallId,
        status: params.status,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async completeAgentStackToolExecutionSafe(params: Parameters<RuntimeStore['completeAgentStackToolExecution']>[0]) {
    const recorder = (this.store as RuntimeStore & {
      completeAgentStackToolExecution?: RuntimeStore['completeAgentStackToolExecution'];
    }).completeAgentStackToolExecution;
    if (typeof recorder !== 'function') {
      return null;
    }
    try {
      return await recorder.call(this.store, params);
    } catch (error) {
      moduleLogger.warn('Failed to complete Xiaoni stack tool execution', {
        executionId: params.executionId,
        status: params.status,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async recordCoreMemoryCompressionForkRunSafe(params: Parameters<RuntimeStore['recordCoreMemoryCompressionForkRun']>[0]) {
    const recorder = (this.store as RuntimeStore & {
      recordCoreMemoryCompressionForkRun?: RuntimeStore['recordCoreMemoryCompressionForkRun'];
    }).recordCoreMemoryCompressionForkRun;
    if (typeof recorder !== 'function') {
      return null;
    }
    try {
      return await recorder.call(this.store, params);
    } catch (error) {
      moduleLogger.warn('Failed to record core memory compression fork run', {
        traceId: params.traceId,
        runId: params.runId,
        forkRunId: params.forkRunId,
        status: params.status,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async completeCoreMemoryCompressionForkRunSafe(params: Parameters<RuntimeStore['completeCoreMemoryCompressionForkRun']>[0]) {
    const recorder = (this.store as RuntimeStore & {
      completeCoreMemoryCompressionForkRun?: RuntimeStore['completeCoreMemoryCompressionForkRun'];
    }).completeCoreMemoryCompressionForkRun;
    if (typeof recorder !== 'function') {
      return null;
    }
    try {
      return await recorder.call(this.store, params);
    } catch (error) {
      moduleLogger.warn('Failed to complete core memory compression fork run', {
        forkRunId: params.forkRunId,
        status: params.status,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async appendCoreMemoryCompressionForkItemsSafe(params: Parameters<RuntimeStore['appendCoreMemoryCompressionForkItems']>[0]) {
    const appender = (this.store as RuntimeStore & {
      appendCoreMemoryCompressionForkItems?: RuntimeStore['appendCoreMemoryCompressionForkItems'];
    }).appendCoreMemoryCompressionForkItems;
    if (typeof appender !== 'function' || params.items.length === 0) {
      return [];
    }
    try {
      return await appender.call(this.store, params) as Array<Record<string, unknown>>;
    } catch (error) {
      moduleLogger.warn('Failed to append core memory compression fork items', {
        traceId: params.traceId,
        runId: params.runId,
        forkRunId: params.forkRunId,
        itemCount: params.items.length,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  private async recordCoreMemoryCompressionForkSliceSafe(params: Parameters<RuntimeStore['recordCoreMemoryCompressionForkSlice']>[0]) {
    const recorder = (this.store as RuntimeStore & {
      recordCoreMemoryCompressionForkSlice?: RuntimeStore['recordCoreMemoryCompressionForkSlice'];
    }).recordCoreMemoryCompressionForkSlice;
    if (typeof recorder !== 'function') {
      return null;
    }
    try {
      return await recorder.call(this.store, params);
    } catch (error) {
      moduleLogger.warn('Failed to record core memory compression fork slice', {
        traceId: params.traceId,
        runId: params.runId,
        forkRunId: params.forkRunId,
        sliceId: params.sliceId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async recordImageVisionForkRunSafe(params: Parameters<RuntimeStore['recordImageVisionForkRun']>[0]) {
    const recorder = (this.store as RuntimeStore & {
      recordImageVisionForkRun?: RuntimeStore['recordImageVisionForkRun'];
    }).recordImageVisionForkRun;
    if (typeof recorder !== 'function') {
      return null;
    }
    try {
      return await recorder.call(this.store, params);
    } catch (error) {
      moduleLogger.warn('Failed to record image vision fork run', {
        traceId: params.traceId,
        runId: params.runId,
        forkRunId: params.forkRunId,
        status: params.status,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async completeImageVisionForkRunSafe(params: Parameters<RuntimeStore['completeImageVisionForkRun']>[0]) {
    const recorder = (this.store as RuntimeStore & {
      completeImageVisionForkRun?: RuntimeStore['completeImageVisionForkRun'];
    }).completeImageVisionForkRun;
    if (typeof recorder !== 'function') {
      return null;
    }
    try {
      return await recorder.call(this.store, params);
    } catch (error) {
      moduleLogger.warn('Failed to complete image vision fork run', {
        forkRunId: params.forkRunId,
        status: params.status,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async appendImageVisionForkItemsSafe(params: Parameters<RuntimeStore['appendImageVisionForkItems']>[0]) {
    const appender = (this.store as RuntimeStore & {
      appendImageVisionForkItems?: RuntimeStore['appendImageVisionForkItems'];
    }).appendImageVisionForkItems;
    if (typeof appender !== 'function' || params.items.length === 0) {
      return [];
    }
    try {
      return await appender.call(this.store, params) as Array<Record<string, unknown>>;
    } catch (error) {
      moduleLogger.warn('Failed to append image vision fork items', {
        traceId: params.traceId,
        runId: params.runId,
        forkRunId: params.forkRunId,
        itemCount: params.items.length,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  private async recordImageVisionForkSliceSafe(params: Parameters<RuntimeStore['recordImageVisionForkSlice']>[0]) {
    const recorder = (this.store as RuntimeStore & {
      recordImageVisionForkSlice?: RuntimeStore['recordImageVisionForkSlice'];
    }).recordImageVisionForkSlice;
    if (typeof recorder !== 'function') {
      return null;
    }
    try {
      return await recorder.call(this.store, params);
    } catch (error) {
      moduleLogger.warn('Failed to record image vision fork slice', {
        traceId: params.traceId,
        runId: params.runId,
        forkRunId: params.forkRunId,
        sliceId: params.sliceId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async recordCoreMemoryCompressionForkToolExecutionSafe(params: Parameters<RuntimeStore['recordCoreMemoryCompressionForkToolExecution']>[0]) {
    const recorder = (this.store as RuntimeStore & {
      recordCoreMemoryCompressionForkToolExecution?: RuntimeStore['recordCoreMemoryCompressionForkToolExecution'];
    }).recordCoreMemoryCompressionForkToolExecution;
    if (typeof recorder !== 'function') {
      return null;
    }
    try {
      return await recorder.call(this.store, params);
    } catch (error) {
      moduleLogger.warn('Failed to record core memory compression fork tool execution', {
        traceId: params.traceId,
        runId: params.runId,
        forkRunId: params.forkRunId,
        toolCallId: params.toolCallId,
        status: params.status,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async completeCoreMemoryCompressionForkToolExecutionSafe(params: Parameters<RuntimeStore['completeCoreMemoryCompressionForkToolExecution']>[0]) {
    const recorder = (this.store as RuntimeStore & {
      completeCoreMemoryCompressionForkToolExecution?: RuntimeStore['completeCoreMemoryCompressionForkToolExecution'];
    }).completeCoreMemoryCompressionForkToolExecution;
    if (typeof recorder !== 'function') {
      return null;
    }
    try {
      return await recorder.call(this.store, params);
    } catch (error) {
      moduleLogger.warn('Failed to complete core memory compression fork tool execution', {
        executionId: params.executionId,
        status: params.status,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async recordSubconsciousAgentForkRunSafe(params: Parameters<RuntimeStore['recordSubconsciousAgentForkRun']>[0]) {
    const recorder = (this.store as RuntimeStore & {
      recordSubconsciousAgentForkRun?: RuntimeStore['recordSubconsciousAgentForkRun'];
    }).recordSubconsciousAgentForkRun;
    if (typeof recorder !== 'function') {
      return null;
    }
    try {
      return await recorder.call(this.store, params);
    } catch (error) {
      moduleLogger.warn('Failed to record subconscious agent fork run', {
        traceId: params.traceId,
        runId: params.runId,
        forkRunId: params.forkRunId,
        status: params.status,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async completeSubconsciousAgentForkRunSafe(params: Parameters<RuntimeStore['completeSubconsciousAgentForkRun']>[0]) {
    const recorder = (this.store as RuntimeStore & {
      completeSubconsciousAgentForkRun?: RuntimeStore['completeSubconsciousAgentForkRun'];
    }).completeSubconsciousAgentForkRun;
    if (typeof recorder !== 'function') {
      return null;
    }
    try {
      return await recorder.call(this.store, params);
    } catch (error) {
      moduleLogger.warn('Failed to complete subconscious agent fork run', {
        forkRunId: params.forkRunId,
        status: params.status,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async appendSubconsciousAgentForkItemsSafe(params: Parameters<RuntimeStore['appendSubconsciousAgentForkItems']>[0]) {
    const appender = (this.store as RuntimeStore & {
      appendSubconsciousAgentForkItems?: RuntimeStore['appendSubconsciousAgentForkItems'];
    }).appendSubconsciousAgentForkItems;
    if (typeof appender !== 'function' || params.items.length === 0) {
      return [];
    }
    try {
      return await appender.call(this.store, params) as Array<Record<string, unknown>>;
    } catch (error) {
      moduleLogger.warn('Failed to append subconscious agent fork items', {
        traceId: params.traceId,
        runId: params.runId,
        forkRunId: params.forkRunId,
        itemCount: params.items.length,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  private async recordSubconsciousAgentForkSliceSafe(params: Parameters<RuntimeStore['recordSubconsciousAgentForkSlice']>[0]) {
    const recorder = (this.store as RuntimeStore & {
      recordSubconsciousAgentForkSlice?: RuntimeStore['recordSubconsciousAgentForkSlice'];
    }).recordSubconsciousAgentForkSlice;
    if (typeof recorder !== 'function') {
      return null;
    }
    try {
      return await recorder.call(this.store, params);
    } catch (error) {
      moduleLogger.warn('Failed to record subconscious agent fork slice', {
        traceId: params.traceId,
        runId: params.runId,
        forkRunId: params.forkRunId,
        sliceId: params.sliceId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async recordSubconsciousAgentForkToolExecutionSafe(params: Parameters<RuntimeStore['recordSubconsciousAgentForkToolExecution']>[0]) {
    const recorder = (this.store as RuntimeStore & {
      recordSubconsciousAgentForkToolExecution?: RuntimeStore['recordSubconsciousAgentForkToolExecution'];
    }).recordSubconsciousAgentForkToolExecution;
    if (typeof recorder !== 'function') {
      return null;
    }
    try {
      return await recorder.call(this.store, params);
    } catch (error) {
      moduleLogger.warn('Failed to record subconscious agent fork tool execution', {
        traceId: params.traceId,
        runId: params.runId,
        forkRunId: params.forkRunId,
        executionId: params.executionId,
        toolName: params.toolName,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async completeSubconsciousAgentForkToolExecutionSafe(params: Parameters<RuntimeStore['completeSubconsciousAgentForkToolExecution']>[0]) {
    const recorder = (this.store as RuntimeStore & {
      completeSubconsciousAgentForkToolExecution?: RuntimeStore['completeSubconsciousAgentForkToolExecution'];
    }).completeSubconsciousAgentForkToolExecution;
    if (typeof recorder !== 'function') {
      return null;
    }
    try {
      return await recorder.call(this.store, params);
    } catch (error) {
      moduleLogger.warn('Failed to complete subconscious agent fork tool execution', {
        executionId: params.executionId,
        status: params.status,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async resolveCoreMemoryCompressionCommitCutoff(compression: CoreMemoryCompressionPlan): Promise<number | null> {
    const plannedCutoffId = compression.readCutoffAfterConversationId;
    if (typeof plannedCutoffId !== 'number' || !Number.isFinite(plannedCutoffId)) {
      return null;
    }
    const coveredEndId = compression.compressionCoveredEndConversationId;
    if (typeof coveredEndId !== 'number' || !Number.isFinite(coveredEndId)) {
      return plannedCutoffId;
    }
    return Math.min(plannedCutoffId, coveredEndId);
  }

  private async commitCoreMemoryCompression(params: {
    rawToolResult: Record<string, unknown>;
    toolCall: AgentToolCall;
    compression: CoreMemoryCompressionPlan | null;
    contextSessionKey: string;
    sourceResponseId: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<CoreMemoryCompressionCommit> {
    const text = typeof params.rawToolResult.text === 'string' && params.rawToolResult.text.trim()
      ? params.rawToolResult.text.trim()
      : null;
    if (!text) {
      throw new Error(`${TOOL_NAMES.compressCoreMemory} requires non-empty text`);
    }

    const compressionSessionKey = params.compression?.contextSessionKey ?? params.contextSessionKey;
    const committedReadCutoffAfterConversationId = params.compression
      ? await this.resolveCoreMemoryCompressionCommitCutoff(params.compression)
      : null;
    const buildSupersededCommit = async (currentReadCutoffAfterConversationId: number | null) => {
      const artifact = {
        tool_name: params.toolCall.name,
        context_session_key: compressionSessionKey,
        read_cutoff_after_conversation_id: currentReadCutoffAfterConversationId,
        planned_read_cutoff_after_conversation_id: params.compression?.readCutoffAfterConversationId ?? null,
        previous_read_cutoff_after_conversation_id: params.compression?.previousReadCutoffAfterConversationId ?? null,
        compression_covered_end_conversation_id: params.compression?.compressionCoveredEndConversationId ?? null,
        source_response_id: params.sourceResponseId,
        tool_call_id: params.toolCall.callId,
        text_length: text.length,
        superseded: true,
        superseded_reason: 'current_read_cutoff_already_covers_fork',
        ...(params.metadata || {})
      };
      const toolResult = {
        ...params.rawToolResult,
        context_summary_written: false,
        read_cutoff_written: false,
        context_session_key: compressionSessionKey,
        read_cutoff_after_conversation_id: currentReadCutoffAfterConversationId,
        planned_read_cutoff_after_conversation_id: params.compression?.readCutoffAfterConversationId ?? null,
        compression_covered_end_conversation_id: params.compression?.compressionCoveredEndConversationId ?? null,
        superseded: true,
        superseded_reason: 'current_read_cutoff_already_covers_fork'
      };
      await this.store.logTimelineEvent({
        traceId: String(params.metadata?.trace_id || ''),
        eventType: 'memory',
        eventName: 'core_memory_compressed',
        eventPhase: 'skip',
        metadata: artifact
      });
      return {
        text,
        artifact,
        toolResult
      };
    };

    if (params.compression && committedReadCutoffAfterConversationId !== null) {
      const atomicCommitter = (this.store as RuntimeStore & {
        commitSessionContextSummaryAndReadCutoff?: RuntimeStore['commitSessionContextSummaryAndReadCutoff'];
      }).commitSessionContextSummaryAndReadCutoff;
      if (typeof atomicCommitter === 'function') {
        const atomicCommit = await atomicCommitter.call(this.store, {
          sessionKey: params.compression.contextSessionKey,
          contextSummary: text,
          readCutoffAfterConversationId: committedReadCutoffAfterConversationId,
          lastContextWindowTokens: params.compression.lastContextWindowTokens,
          lastTargetBudgetTokens: params.compression.lastTargetBudgetTokens,
          lastHardBudgetTokens: params.compression.lastHardBudgetTokens
        });
        if (!atomicCommit.committed) {
          return buildSupersededCommit(atomicCommit.state?.readCutoffAfterConversationId ?? null);
        }
      } else {
        const currentCutoffState = await this.store.getSessionReadCutoffState(params.compression.contextSessionKey);
        const currentReadCutoffAfterConversationId = currentCutoffState?.readCutoffAfterConversationId ?? null;
        if (
          currentReadCutoffAfterConversationId !== null &&
          currentReadCutoffAfterConversationId >= committedReadCutoffAfterConversationId
        ) {
          return buildSupersededCommit(currentReadCutoffAfterConversationId);
        }
        await this.store.upsertSessionContextSummary({
          sessionKey: compressionSessionKey,
          contextSummary: text
        });
        await this.store.upsertSessionReadCutoffState({
          sessionKey: params.compression.contextSessionKey,
          readCutoffAfterConversationId: committedReadCutoffAfterConversationId,
          lastContextWindowTokens: params.compression.lastContextWindowTokens,
          lastTargetBudgetTokens: params.compression.lastTargetBudgetTokens,
          lastHardBudgetTokens: params.compression.lastHardBudgetTokens
        });
      }
    } else {
      await this.store.upsertSessionContextSummary({
        sessionKey: compressionSessionKey,
        contextSummary: text
      });
    }
    if (params.compression && committedReadCutoffAfterConversationId === null) {
      await this.store.upsertSessionReadCutoffState({
        sessionKey: params.compression.contextSessionKey,
        readCutoffAfterConversationId: committedReadCutoffAfterConversationId,
        lastContextWindowTokens: params.compression.lastContextWindowTokens,
        lastTargetBudgetTokens: params.compression.lastTargetBudgetTokens,
        lastHardBudgetTokens: params.compression.lastHardBudgetTokens
      });
    }

    const artifact = {
      tool_name: params.toolCall.name,
      context_session_key: compressionSessionKey,
      read_cutoff_after_conversation_id: committedReadCutoffAfterConversationId,
      planned_read_cutoff_after_conversation_id: params.compression?.readCutoffAfterConversationId ?? null,
      previous_read_cutoff_after_conversation_id: params.compression?.previousReadCutoffAfterConversationId ?? null,
      compression_covered_end_conversation_id: params.compression?.compressionCoveredEndConversationId ?? null,
      source_response_id: params.sourceResponseId,
      tool_call_id: params.toolCall.callId,
      text_length: text.length,
      ...(params.metadata || {})
    };
    const toolResult = {
      ...params.rawToolResult,
      context_summary_written: true,
      read_cutoff_written: Boolean(params.compression),
      context_session_key: compressionSessionKey,
      read_cutoff_after_conversation_id: committedReadCutoffAfterConversationId,
      planned_read_cutoff_after_conversation_id: params.compression?.readCutoffAfterConversationId ?? null,
      compression_covered_end_conversation_id: params.compression?.compressionCoveredEndConversationId ?? null
    };
    await this.store.logTimelineEvent({
      traceId: String(params.metadata?.trace_id || ''),
      eventType: 'memory',
      eventName: 'core_memory_compressed',
      eventPhase: null,
      metadata: artifact
    });
    const commit = {
      text,
      artifact,
      toolResult
    };
    if (typeof this.options.onCoreMemoryCompressionCommitted === 'function') {
      await Promise.resolve(this.options.onCoreMemoryCompressionCommitted(commit)).catch((error: unknown) => {
        moduleLogger.warn('Failed to run post core-memory-compression hook', {
          contextSessionKey: compressionSessionKey,
          toolCallId: params.toolCall.callId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    return commit;
  }

  private async runSubconsciousAgentFork(params: {
    baseRequest: CanonicalAgentTurnRequest;
    queueMessage: QueueMessageRecord['payload'];
    runtimePrompt: ResolvedAgentRuntimePrompt;
    contextSessionKey: string;
	  }): Promise<boolean> {
    const forkRunId = `subconscious-fork:${params.queueMessage.runId}:${uuidv4().slice(0, 8)}`;
    const baseForkMetadata = {
      trigger: 'empty_notify_after_final_answer',
      context_session_key: params.contextSessionKey,
      no_main_stack_persist: true,
      no_traffic_persist: true
    };

    await this.recordSubconsciousAgentForkRunSafe({
      forkRunId,
      contextSessionKey: params.contextSessionKey,
      status: 'running',
      traceId: params.queueMessage.traceId,
      runId: params.queueMessage.runId,
      metadata: baseForkMetadata
    });
    await this.store.logTimelineEvent({
      traceId: params.queueMessage.traceId,
      eventType: 'decision',
      eventName: 'subconscious_agent_fork',
      eventPhase: 'start',
      metadata: {
        fork_run_id: forkRunId,
        no_main_stack_persist: true
      }
    });

    try {
      const allowedToolNames = new Set<string>([TOOL_NAMES.execCommand]);
      let forkInput = buildSubconsciousAgentForkRequest(params.baseRequest, 1).input;
      let pendingForkOneShotInputItems: OpenResponseInputItem[] = [];
      let forkToolCallCount = 0;
      let lastForkSliceId: string | null = null;
      let lastLlmCallId: string | null = null;

      for (let forkTurn = 1; forkTurn <= SUBCONSCIOUS_AGENT_FORK_MAX_MODEL_SLICES; forkTurn += 1) {
        const forkRequest = buildSubconsciousAgentForkRequest(params.baseRequest, forkTurn);
        const forkRequestInput = pendingForkOneShotInputItems.length > 0
          ? [...forkInput, ...pendingForkOneShotInputItems]
          : forkInput;
        pendingForkOneShotInputItems = [];
        forkRequest.input = normalizeResponseInputItems(forkRequestInput);
        await this.waitForRuntimeEnabledBeforeModelSlice(params.queueMessage, params.queueMessage.runId);
        const modelResult = await this.executeSubconsciousAgentForkTurn(
          forkRequest,
          params.queueMessage,
          params.runtimePrompt,
          forkTurn
        );
        const forkSliceId = modelResult.llm_request_slice_id
          || modelResult.llm_call_id
          || `subconscious-fork-slice:${forkRunId}:${forkTurn}`;
        lastForkSliceId = forkSliceId;
        lastLlmCallId = modelResult.llm_call_id || null;
        const inputRows = await this.appendSubconsciousAgentForkItemsSafe({
          forkRunId,
          traceId: params.queueMessage.traceId,
          runId: params.queueMessage.runId,
          sourceType: 'subconscious_agent_fork_slices',
          sourceId: forkSliceId,
          llmRequestSliceId: forkSliceId,
          items: [buildForkInputStackItem({
            forkRunId,
            sliceId: forkSliceId,
            forkTurn,
            source: 'subconscious_agent_fork_input',
            inputItems: forkRequest.input
          }) as Record<string, unknown>]
        });
        const outputItems = extractCanonicalResponseOutputItems(modelResult);
        const outputRows = await this.appendSubconsciousAgentForkItemsSafe({
          forkRunId,
          traceId: params.queueMessage.traceId,
          runId: params.queueMessage.runId,
          sourceType: 'subconscious_agent_fork_slices',
          sourceId: forkSliceId,
          llmRequestSliceId: forkSliceId,
          items: buildModelOutputStackItems(outputItems, forkSliceId) as Array<Record<string, unknown>>
        });
        const outputItemIndexes = outputRows
          .map((row) => Number((row as { itemIndex?: unknown }).itemIndex))
          .filter((value) => Number.isFinite(value));
        const inputItemIndexes = inputRows
          .map((row) => Number((row as { itemIndex?: unknown }).itemIndex))
          .filter((value) => Number.isFinite(value));
        const inputStackItemIds = inputRows
          .map((row) => (row as { id?: unknown }).id)
          .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number');
        const toolCallForkItemIdByCallId = new Map<string, string | number>();
        for (const row of outputRows) {
          const toolCallId = typeof (row as { toolCallId?: unknown }).toolCallId === 'string'
            ? (row as { toolCallId: string }).toolCallId
            : null;
          const itemKind = typeof (row as { itemKind?: unknown }).itemKind === 'string'
            ? (row as { itemKind: string }).itemKind
            : null;
          const id = (row as { id?: unknown }).id;
          if (toolCallId && itemKind === 'function_call' && (typeof id === 'string' || typeof id === 'number')) {
            toolCallForkItemIdByCallId.set(toolCallId, id);
          }
        }

        await this.recordSubconsciousAgentForkSliceSafe({
          forkRunId,
          sliceId: forkSliceId,
          llmCallId: modelResult.llm_call_id || null,
          inputStartIndex: inputItemIndexes.length > 0 ? Math.min(...inputItemIndexes) : null,
          inputEndIndex: inputItemIndexes.length > 0 ? Math.max(...inputItemIndexes) : null,
          inputStackItemIds,
          outputStartIndex: outputItemIndexes.length > 0 ? Math.min(...outputItemIndexes) : null,
          outputEndIndex: outputItemIndexes.length > 0 ? Math.max(...outputItemIndexes) : null,
          canonicalRequest: (modelResult.canonical_request || forkRequest) as Record<string, unknown>,
          wireRequest: modelResult.wire_request || null,
          canonicalResponse: modelResult.canonical_response || null,
          wireResponse: modelResult.wire_response || null,
          rawResponse: modelResult.raw_response || null,
          outputItems,
          status: modelResult.success ? 'completed' : 'failed',
          tokenUsage: buildProviderTokenUsage(modelResult),
          traceId: params.queueMessage.traceId,
          runId: params.queueMessage.runId,
          agentTurn: forkTurn,
          modelName: modelResult.model || params.runtimePrompt.modelName,
          modelProvider: modelResult.provider || null,
          requestFormatVersion: modelResult.request_format_version || null,
          wireProviderFormat: modelResult.wire_provider_format || null,
          processingTimeMs: readOptionalNumber(modelResult.performance?.processing_time_ms),
          metadata: {
            ...baseForkMetadata,
            ...buildProviderWireMetadata(modelResult),
            fork_run_id: forkRunId,
            fork_turn: forkTurn,
            execution_mode: 'subconscious_agent_fork'
          }
        });

        const naturalLanguage = extractSubconsciousNaturalLanguage(outputItems);
        if (naturalLanguage) {
          const notifyQueueMessage = await this.enqueueSubconsciousAgentNotify({
            forkRunId,
            forkSliceId,
            llmCallId: modelResult.llm_call_id || null,
            traceId: params.queueMessage.traceId,
            runId: params.queueMessage.runId,
            text: naturalLanguage
          });
          const notifyQueueMessageId = Number(notifyQueueMessage?.queueId || 0) || null;
          await this.completeSubconsciousAgentForkRunSafe({
            forkRunId,
            status: 'completed',
            notifyQueueMessageId,
            summaryText: naturalLanguage,
            artifact: {
              notify_queue_message_id: notifyQueueMessageId,
              llm_request_slice_id: forkSliceId,
              llm_call_id: modelResult.llm_call_id || null,
              text_length: naturalLanguage.length,
              fork_turn_count: forkTurn,
              fork_tool_call_count: forkToolCallCount
            },
            metadata: baseForkMetadata
          });
          await this.store.logTimelineEvent({
            traceId: params.queueMessage.traceId,
            eventType: 'decision',
            eventName: 'subconscious_agent_fork',
            eventPhase: 'end',
            metadata: {
              status: 'completed',
              fork_run_id: forkRunId,
              notify_queue_message_id: notifyQueueMessageId,
              llm_request_slice_id: forkSliceId,
              fork_turn_count: forkTurn,
              fork_tool_call_count: forkToolCallCount
            }
          });
          return true;
        }

        const actionPlan = this.responseActionRouter.route(modelResult.canonical_response);
        if (!actionPlan.hasToolCall) {
          for (const replayItem of actionPlan.replayableOutputs) {
            forkInput.push(replayItem.inputItem as OpenResponseInputItem);
          }
          continue;
        }

        for (const replayItem of actionPlan.replayableOutputs) {
          forkInput.push(replayItem.inputItem);
          if (!isReplayableToolCall(replayItem)) {
            continue;
          }
          const toolCall = replayItem.toolCall;
          forkToolCallCount += 1;
          if (forkToolCallCount > SUBCONSCIOUS_AGENT_FORK_MAX_TOOL_CALLS) {
            throw new Error(`subconscious agent fork exceeded ${SUBCONSCIOUS_AGENT_FORK_MAX_TOOL_CALLS} tool calls`);
          }
          const forkToolExecutionId = `subconscious-fork-tool:${forkRunId}:${toolCall.callId}`;
          await this.recordSubconsciousAgentForkToolExecutionSafe({
            forkRunId,
            executionId: forkToolExecutionId,
            llmRequestSliceId: forkSliceId,
            llmCallId: modelResult.llm_call_id || null,
            toolCallId: toolCall.callId,
            toolName: toolCall.name,
            arguments: toolCall.args,
            rawArguments: toolCall.rawArguments,
            status: 'running',
            sideEffect: isToolCallSideEffecting(toolCall),
            traceId: params.queueMessage.traceId,
            runId: params.queueMessage.runId,
            agentTurn: forkTurn,
            stackCallItemId: toolCallForkItemIdByCallId.get(toolCall.callId) || null,
            metadata: {
              ...baseForkMetadata,
              fork_turn: forkTurn,
              model_name: params.runtimePrompt.modelName,
              session_key: params.queueMessage.sessionKey,
              chat_type: params.queueMessage.chatType
            }
          });

          let rawToolResult: Record<string, unknown>;
          let toolStatus: 'completed' | 'failed' = 'completed';
          let toolErrorMessage: string | null = null;
          try {
            if (!allowedToolNames.has(toolCall.name)) {
              throw new Error(`subconscious agent fork tried unsupported tool: ${toolCall.name}`);
            }
            rawToolResult = await this.executeTool(toolCall, params.queueMessage, {
              currentCanonicalRequest: forkRequest
            });
          } catch (error) {
            rawToolResult = buildToolErrorResult(toolCall, error);
            toolStatus = 'failed';
            toolErrorMessage = String(rawToolResult.error_message || rawToolResult.error || 'Tool execution failed');
          }

          const runtimeEnergyState = await this.getCurrentRuntimeEnergyState(params.queueMessage);
          const continuation = applyToolResultToLoopInput(toolCall, rawToolResult, {
            loopInput: forkInput,
            speakingToolName: params.queueMessage.chatType === 'direct' ? TOOL_NAMES.privateReply : TOOL_NAMES.groupReply,
            hasVisibleReply: false,
            runtimeEnergyState
          });
          if (continuation.forcedVisibleReply) {
            rawToolResult = {
              ...rawToolResult,
              forced_visible_reply_rejected: true,
              error_message: 'subconscious agent fork cannot force visible delivery'
            };
            toolStatus = 'failed';
            toolErrorMessage = 'subconscious agent fork cannot force visible delivery';
          }
          const toolOutputRows = await this.appendSubconsciousAgentForkItemsSafe({
            forkRunId,
            traceId: params.queueMessage.traceId,
            runId: params.queueMessage.runId,
            sourceType: 'subconscious_agent_fork_tool_executions',
            sourceId: forkToolExecutionId,
            llmRequestSliceId: forkSliceId,
            items: buildToolResultStackItems({
              toolCall,
              toolResult: rawToolResult,
              continuationItems: continuation.inputItems,
              llmRequestSliceId: forkSliceId
            }) as Array<Record<string, unknown>>
          });
          await this.completeSubconsciousAgentForkToolExecutionSafe({
            executionId: forkToolExecutionId,
            status: toolStatus,
            result: rawToolResult,
            errorMessage: toolErrorMessage,
            stackOutputItemId: (toolOutputRows[0] as { id?: string | number } | undefined)?.id || null
          });
          forkInput.push(...continuation.inputItems);
          pendingForkOneShotInputItems.push(...continuation.oneShotInputItems);
        }
      }

      await this.completeSubconsciousAgentForkRunSafe({
        forkRunId,
        status: 'completed',
        summaryText: null,
        artifact: {
          no_stimulus: true,
          max_turns_exhausted: true,
          llm_request_slice_id: lastForkSliceId,
          llm_call_id: lastLlmCallId,
          fork_turn_count: SUBCONSCIOUS_AGENT_FORK_MAX_MODEL_SLICES,
          fork_tool_call_count: forkToolCallCount
        },
        metadata: baseForkMetadata
      });
      await this.store.logTimelineEvent({
        traceId: params.queueMessage.traceId,
        eventType: 'decision',
        eventName: 'subconscious_agent_fork',
        eventPhase: 'end',
        metadata: {
          status: 'no_stimulus',
          reason: 'max_turns_exhausted',
          fork_run_id: forkRunId,
          llm_request_slice_id: lastForkSliceId,
          fork_tool_call_count: forkToolCallCount
        }
      });
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.completeSubconsciousAgentForkRunSafe({
        forkRunId,
        status: 'failed',
        errorMessage: message,
        metadata: baseForkMetadata
      });
      await this.store.logTimelineEvent({
        traceId: params.queueMessage.traceId,
        eventType: 'decision',
        eventName: 'subconscious_agent_fork',
        eventPhase: 'end',
        metadata: {
          status: 'failed',
          fork_run_id: forkRunId,
          error_message: message
        }
      });
      return false;
    }
  }

  private async enqueueSubconsciousAgentNotify(params: {
    forkRunId: string;
    forkSliceId: string;
    llmCallId: string | null;
    traceId: string;
    runId: string;
    text: string;
  }) {
    const enqueuer = (this.store as RuntimeStore & {
      enqueueQueueMessage?: RuntimeStore['enqueueQueueMessage'];
    }).enqueueQueueMessage;
    if (typeof enqueuer !== 'function') {
      throw new Error('subconscious agent notify requires queue enqueue persistence');
    }
    const now = new Date();
    const messageSid = `subconscious-agent:${params.forkRunId}`;
    const botAccountId = agentConfig.botAccountId;
    const sessionKey = getGlobalPromptContextSessionKey();
    const promptFacingText = renderSubconsciousAgentNotify(params.text);
    const rawPayload = {
      reason: 'subconscious_agent',
      fork_run_id: params.forkRunId,
      fork_slice_id: params.forkSliceId,
      llm_call_id: params.llmCallId,
      final_answer_text: params.text,
      notify_template: 'subconscious_agent_notify.md',
      source_trace_id: params.traceId,
      source_run_id: params.runId
    };
    const inboundContext = {
      Body: promptFacingText,
      BodyForAgent: promptFacingText,
      BodyForCommands: promptFacingText,
      RawBody: promptFacingText,
      CommandBody: promptFacingText,
      From: botAccountId,
      To: botAccountId,
      SessionKey: sessionKey,
      AccountId: botAccountId,
      ChatType: 'direct',
      ConversationLabel: XIAONI_IDENTITY_KEY,
      SenderName: XIAONI_IDENTITY_KEY,
      SenderId: botAccountId,
      Timestamp: now.getTime(),
      Provider: 'runtime',
      Surface: 'system_reminder',
      WasMentioned: false,
      NativeChannelId: sessionKey,
      CommandAuthorized: false
    };
    const payload = {
      messageId: messageSid,
      rawBody: promptFacingText,
      commandBody: promptFacingText,
      receivedAt: now.toISOString(),
      systemReminder: {
        reminder: promptFacingText,
        reason: 'subconscious_agent',
        sourceTraceId: params.traceId,
        sourceRunId: params.runId,
        sourceLlmCallId: params.llmCallId,
        sourceTurn: 1,
        createdAt: now.toISOString()
      },
      subconsciousAgent: rawPayload
    };

    return enqueuer.call(this.store, {
      message: {
        traceId: params.traceId,
        source: 'system_reminder',
        messageSid,
        dedupeKey: messageSid,
        chatType: 'direct',
        sessionKey,
        peerId: XIAONI_IDENTITY_KEY,
        peerName: XIAONI_IDENTITY_KEY,
        senderId: botAccountId,
        senderName: XIAONI_IDENTITY_KEY,
        accountId: botAccountId,
        bodyForAgent: promptFacingText,
        rawPayload,
        inboundContext
      },
      payload,
      availableAt: now
    });
  }

  private async scheduleCoreMemoryCompressionFork(params: {
    baseRequest: CanonicalAgentTurnRequest;
    queueMessage: QueueMessageRecord['payload'];
    runtimePrompt: ResolvedAgentRuntimePrompt;
    compression: CoreMemoryCompressionPlan;
    contextSessionKey: string;
    // Manual admin triggers run as a maintenance action while the loop is
    // intentionally stopped; they must not park at the runtime-enabled gate.
    // Auto-overflow forks leave this false so they still respect the pause.
    bypassRuntimeEnabledGate?: boolean;
  }) {
    const key = params.compression.contextSessionKey || params.contextSessionKey;
    const existing = this.coreMemoryCompressionForks.get(key);
    const compression = existing?.compression ?? params.compression;
    const artifact = {
      tool_name: TOOL_NAMES.compressCoreMemory,
      context_session_key: key,
      read_cutoff_after_conversation_id: compression.readCutoffAfterConversationId,
      previous_read_cutoff_after_conversation_id: compression.previousReadCutoffAfterConversationId,
      compression_covered_end_conversation_id: compression.compressionCoveredEndConversationId,
      execution_mode: 'compression_fork_background',
      status: existing ? 'already_running' : 'scheduled'
    };
    if (existing) {
      return artifact;
    }

    const plannedCommitCutoff = await this.resolveCoreMemoryCompressionCommitCutoff(params.compression);
    const cutoffReader = (this.store as RuntimeStore & {
      getSessionReadCutoffState?: RuntimeStore['getSessionReadCutoffState'];
    }).getSessionReadCutoffState;
    if (plannedCommitCutoff !== null && typeof cutoffReader === 'function') {
      try {
        const currentCutoffState = await cutoffReader.call(this.store, key);
        const currentReadCutoffAfterConversationId = currentCutoffState?.readCutoffAfterConversationId ?? null;
        if (
          currentReadCutoffAfterConversationId !== null
          && currentReadCutoffAfterConversationId >= plannedCommitCutoff
        ) {
          return {
            ...artifact,
            status: 'already_covered',
            read_cutoff_after_conversation_id: currentReadCutoffAfterConversationId,
            planned_read_cutoff_after_conversation_id: params.compression.readCutoffAfterConversationId
          };
        }
      } catch (error) {
        moduleLogger.warn('Failed to check core memory compression cutoff before scheduling fork', {
          traceId: params.queueMessage.traceId,
          runId: params.queueMessage.runId,
          contextSessionKey: key,
          plannedCommitCutoff,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const durableFinder = (this.store as RuntimeStore & {
      findActiveCoreMemoryCompressionForkRun?: RuntimeStore['findActiveCoreMemoryCompressionForkRun'];
    }).findActiveCoreMemoryCompressionForkRun;
    if (
      typeof durableFinder === 'function'
      && typeof params.compression.compressionCoveredEndConversationId === 'number'
      && Number.isFinite(params.compression.compressionCoveredEndConversationId)
    ) {
      try {
        const activeFork = await durableFinder.call(this.store, {
          contextSessionKey: key,
          compressionCoveredEndConversationId: params.compression.compressionCoveredEndConversationId
        });
        if (activeFork) {
          return {
            ...artifact,
            status: 'already_running_durable',
            persisted_fork_run_id: activeFork.forkRunId ?? null,
            persisted_run_id: activeFork.runId ?? null
          };
        }
      } catch (error) {
        moduleLogger.warn('Failed to check active durable core memory compression fork before scheduling', {
          traceId: params.queueMessage.traceId,
          runId: params.queueMessage.runId,
          contextSessionKey: key,
          compressionCoveredEndConversationId: params.compression.compressionCoveredEndConversationId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const fork = this.runCoreMemoryCompressionFork(params);
    this.coreMemoryCompressionForks.set(key, {
      promise: fork,
      compression: params.compression,
      startedAtMs: Date.now()
    });
    void fork.catch((error) => {
      moduleLogger.warn('Background core memory compression fork failed', {
        traceId: params.queueMessage.traceId,
        runId: params.queueMessage.runId,
        contextSessionKey: key,
        error: error instanceof Error ? error.message : String(error)
      });
    }).finally(() => {
      if (this.coreMemoryCompressionForks.get(key)?.promise === fork) {
        this.coreMemoryCompressionForks.delete(key);
      }
    });
    return artifact;
  }

  private async runCoreMemoryCompressionFork(params: {
    baseRequest: CanonicalAgentTurnRequest;
    queueMessage: QueueMessageRecord['payload'];
    runtimePrompt: ResolvedAgentRuntimePrompt;
    compression: CoreMemoryCompressionPlan;
    contextSessionKey: string;
    bypassRuntimeEnabledGate?: boolean;
  }): Promise<CoreMemoryCompressionCommit> {
    const forkRunId = `core-memory-fork:${params.queueMessage.runId}:${uuidv4().slice(0, 8)}`;
    const allowedToolNames = new Set<string>([
      TOOL_NAMES.execCommand,
      TOOL_NAMES.compressCoreMemory
    ]);
    let forkInput = cloneCanonicalAgentTurnRequest(params.baseRequest).input;
    let pendingForkOneShotInputItems: OpenResponseInputItem[] = [];
    let forkToolCallCount = 0;
    let forkNoToolRetryCount = 0;
    let forkNoToolRetryTotal = 0;
    const baseForkMetadata = {
      context_session_key: params.compression.contextSessionKey,
      read_cutoff_after_conversation_id: params.compression.readCutoffAfterConversationId,
      previous_read_cutoff_after_conversation_id: params.compression.previousReadCutoffAfterConversationId,
      compression_covered_end_conversation_id: params.compression.compressionCoveredEndConversationId,
      history_user_id: params.compression.historyUserId,
      history_group_id: params.compression.historyGroupId,
      history_scope: params.compression.historyScope,
      last_context_window_tokens: params.compression.lastContextWindowTokens,
      last_target_budget_tokens: params.compression.lastTargetBudgetTokens,
      last_hard_budget_tokens: params.compression.lastHardBudgetTokens,
      no_main_stack_persist: true,
      no_traffic_persist: true
    };

    await this.recordCoreMemoryCompressionForkRunSafe({
      forkRunId,
      contextSessionKey: params.compression.contextSessionKey,
      status: 'running',
      traceId: params.queueMessage.traceId,
      runId: params.queueMessage.runId,
      readCutoffAfterConversationId: params.compression.readCutoffAfterConversationId,
      previousReadCutoffAfterConversationId: params.compression.previousReadCutoffAfterConversationId,
      metadata: baseForkMetadata
    });

    await this.store.logTimelineEvent({
      traceId: params.queueMessage.traceId,
      eventType: 'memory',
      eventName: 'core_memory_compression_fork',
      eventPhase: 'start',
      metadata: {
        fork_run_id: forkRunId,
        context_session_key: params.compression.contextSessionKey,
        read_cutoff_after_conversation_id: params.compression.readCutoffAfterConversationId,
        no_main_stack_persist: true
      }
    });

    try {
      for (let forkTurn = 1; ; forkTurn += 1) {
        const forkRequest = buildCoreMemoryCompressionForkRequest(params.baseRequest, forkTurn);
        const forkRequestInput = pendingForkOneShotInputItems.length > 0
          ? [...forkInput, ...pendingForkOneShotInputItems]
          : forkInput;
        pendingForkOneShotInputItems = [];
        forkRequest.input = normalizeResponseInputItems(forkRequestInput);
        if (!params.bypassRuntimeEnabledGate) {
          await this.waitForRuntimeEnabledBeforeModelSlice(params.queueMessage, params.queueMessage.runId);
        }
        const modelResult = await this.executeCoreMemoryCompressionForkTurn(
          forkRequest,
          params.queueMessage,
          params.runtimePrompt,
          forkTurn
        );
        const forkSliceId = modelResult.llm_request_slice_id
          || modelResult.llm_call_id
          || `core-memory-fork-slice:${forkRunId}:${forkTurn}`;
        const inputRows = await this.appendCoreMemoryCompressionForkItemsSafe({
          forkRunId,
          traceId: params.queueMessage.traceId,
          runId: params.queueMessage.runId,
          sourceType: 'core_memory_compression_fork_slices',
          sourceId: forkSliceId,
          llmRequestSliceId: forkSliceId,
          items: [buildForkInputStackItem({
            forkRunId,
            sliceId: forkSliceId,
            forkTurn,
            source: 'core_memory_compression_fork_input',
            inputItems: forkRequest.input
          }) as Record<string, unknown>]
        });
        const outputItems = extractCanonicalResponseOutputItems(modelResult);
        const outputRows = await this.appendCoreMemoryCompressionForkItemsSafe({
          forkRunId,
          traceId: params.queueMessage.traceId,
          runId: params.queueMessage.runId,
          sourceType: 'core_memory_compression_fork_slices',
          sourceId: forkSliceId,
          llmRequestSliceId: forkSliceId,
          items: buildModelOutputStackItems(outputItems, forkSliceId) as Array<Record<string, unknown>>
        });
        const outputItemIndexes = outputRows
          .map((row) => Number((row as { itemIndex?: unknown }).itemIndex))
          .filter((value) => Number.isFinite(value));
        const inputItemIndexes = inputRows
          .map((row) => Number((row as { itemIndex?: unknown }).itemIndex))
          .filter((value) => Number.isFinite(value));
        const inputStackItemIds = inputRows
          .map((row) => (row as { id?: unknown }).id)
          .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number');
        const toolCallForkItemIdByCallId = new Map<string, string | number>();
        for (const row of outputRows) {
          const toolCallId = typeof (row as { toolCallId?: unknown }).toolCallId === 'string'
            ? (row as { toolCallId: string }).toolCallId
            : null;
          const itemKind = typeof (row as { itemKind?: unknown }).itemKind === 'string'
            ? (row as { itemKind: string }).itemKind
            : null;
          const id = (row as { id?: unknown }).id;
          if (toolCallId && itemKind === 'function_call' && (typeof id === 'string' || typeof id === 'number')) {
            toolCallForkItemIdByCallId.set(toolCallId, id);
          }
        }
        await this.recordCoreMemoryCompressionForkSliceSafe({
          forkRunId,
          sliceId: forkSliceId,
          llmCallId: modelResult.llm_call_id || null,
          inputStartIndex: inputItemIndexes.length > 0 ? Math.min(...inputItemIndexes) : null,
          inputEndIndex: inputItemIndexes.length > 0 ? Math.max(...inputItemIndexes) : null,
          inputStackItemIds,
          outputStartIndex: outputItemIndexes.length > 0 ? Math.min(...outputItemIndexes) : null,
          outputEndIndex: outputItemIndexes.length > 0 ? Math.max(...outputItemIndexes) : null,
          canonicalRequest: (modelResult.canonical_request || forkRequest) as Record<string, unknown>,
          wireRequest: modelResult.wire_request || null,
          canonicalResponse: modelResult.canonical_response || null,
          wireResponse: modelResult.wire_response || null,
          rawResponse: modelResult.raw_response || null,
          outputItems,
          status: modelResult.success ? 'completed' : 'failed',
          tokenUsage: buildProviderTokenUsage(modelResult),
          traceId: params.queueMessage.traceId,
          runId: params.queueMessage.runId,
          agentTurn: forkTurn,
          modelName: modelResult.model || params.runtimePrompt.modelName,
          modelProvider: modelResult.provider || null,
          requestFormatVersion: modelResult.request_format_version || null,
          wireProviderFormat: modelResult.wire_provider_format || null,
          processingTimeMs: readOptionalNumber(modelResult.performance?.processing_time_ms),
          metadata: {
            ...baseForkMetadata,
            ...buildProviderWireMetadata(modelResult),
            fork_run_id: forkRunId,
            fork_turn: forkTurn,
            execution_mode: 'compression_fork'
          }
        });

        const actionPlan = this.responseActionRouter.route(modelResult.canonical_response);
        if (!actionPlan.hasToolCall) {
          forkNoToolRetryCount += 1;
          forkNoToolRetryTotal += 1;
          if (forkNoToolRetryCount > CORE_MEMORY_COMPRESSION_FORK_MAX_NO_TOOL_RETRIES) {
            throw new Error(`${TOOL_NAMES.compressCoreMemory} fork yielded without a tool call`);
          }
          for (const replayItem of actionPlan.replayableOutputs) {
            forkInput.push(replayItem.inputItem);
          }
          forkInput.push(buildCoreMemoryCompressionForkRetryReminder({
            forkTurn,
            retryCount: forkNoToolRetryCount,
            maxRetries: CORE_MEMORY_COMPRESSION_FORK_MAX_NO_TOOL_RETRIES,
            reason: actionPlan.hasFinalAnswer
              ? `returned final_answer instead of ${TOOL_NAMES.compressCoreMemory}`
              : `returned no callable tool; expected ${TOOL_NAMES.compressCoreMemory}`
          }));
          continue;
        }
        forkNoToolRetryCount = 0;
        const forkToolCalls = actionPlan.replayableOutputs.filter(isReplayableToolCall);
        if (
          forkToolCalls.some((item) => item.toolCall.name === TOOL_NAMES.execCommand)
          && forkToolCalls.some((item) => item.toolCall.name === TOOL_NAMES.compressCoreMemory)
        ) {
          await this.store.logTimelineEvent({
            traceId: params.queueMessage.traceId,
            eventType: 'memory',
            eventName: 'core_memory_parallel_mixed_batch_observed',
            eventPhase: null,
            metadata: {
              execution_mode: 'compression_fork',
              fork_run_id: forkRunId,
              fork_turn: forkTurn,
              llm_request_slice_id: forkSliceId,
              tool_call_order: forkToolCalls.map((item) => ({
                call_id: item.toolCall.callId,
                name: item.toolCall.name
              }))
            }
          }).catch((error) => {
            moduleLogger.warn('Failed to log mixed core memory fork parallel batch observation', {
              traceId: params.queueMessage.traceId,
              runId: params.queueMessage.runId,
              forkRunId,
              error: error instanceof Error ? error.message : String(error)
            });
          });
        }

        for (const replayItem of actionPlan.replayableOutputs) {
          forkInput.push(replayItem.inputItem);
          if (!isReplayableToolCall(replayItem)) {
            continue;
          }

          const toolCall = replayItem.toolCall;
          if (!allowedToolNames.has(toolCall.name)) {
            throw new Error(`${TOOL_NAMES.compressCoreMemory} fork tried unsupported tool: ${toolCall.name}`);
          }
          forkToolCallCount += 1;
          const forkToolExecutionId = `core-memory-fork-tool:${forkRunId}:${toolCall.callId}`;
          await this.recordCoreMemoryCompressionForkToolExecutionSafe({
            forkRunId,
            executionId: forkToolExecutionId,
            llmRequestSliceId: forkSliceId,
            llmCallId: modelResult.llm_call_id || null,
            toolCallId: toolCall.callId,
            toolName: toolCall.name,
            arguments: toolCall.args,
            rawArguments: toolCall.rawArguments,
            status: 'running',
            sideEffect: isToolCallSideEffecting(toolCall),
            traceId: params.queueMessage.traceId,
            runId: params.queueMessage.runId,
            agentTurn: forkTurn,
            stackCallItemId: toolCallForkItemIdByCallId.get(toolCall.callId) || null,
            metadata: {
              ...baseForkMetadata,
              fork_turn: forkTurn,
              model_name: params.runtimePrompt.modelName,
              session_key: params.queueMessage.sessionKey,
              chat_type: params.queueMessage.chatType,
              peer_name: params.queueMessage.peerName || null
            }
          });

          try {
            const rawToolResult = await this.executeTool(toolCall, params.queueMessage, {
              currentCanonicalRequest: forkRequest
            });

            if (toolCall.name === TOOL_NAMES.compressCoreMemory) {
              const commit = await this.commitCoreMemoryCompression({
                rawToolResult,
                toolCall,
                compression: params.compression,
                contextSessionKey: params.contextSessionKey,
                sourceResponseId: modelResult.llm_call_id || null,
                metadata: {
                  trace_id: params.queueMessage.traceId,
                  execution_mode: 'compression_fork',
                  fork_run_id: forkRunId,
                  fork_turn_count: forkTurn,
                  fork_tool_call_count: forkToolCallCount,
                  fork_no_tool_retry_count: forkNoToolRetryTotal,
                  no_main_stack_persist: true,
                  no_traffic_persist: true
                }
              });
              const runtimeEnergyState = await this.getCurrentRuntimeEnergyState(params.queueMessage);
              const continuation = applyToolResultToLoopInput(toolCall, commit.toolResult, {
                loopInput: forkInput,
                speakingToolName: params.queueMessage.chatType === 'direct' ? TOOL_NAMES.privateReply : TOOL_NAMES.groupReply,
                hasVisibleReply: false,
                runtimeEnergyState
              });
              if (continuation.forcedVisibleReply) {
                throw new Error(`${TOOL_NAMES.compressCoreMemory} fork must not force visible delivery`);
              }
              const toolOutputRows = await this.appendCoreMemoryCompressionForkItemsSafe({
                forkRunId,
                traceId: params.queueMessage.traceId,
                runId: params.queueMessage.runId,
                sourceType: 'core_memory_compression_fork_tool_executions',
                sourceId: forkToolExecutionId,
                llmRequestSliceId: forkSliceId,
                items: buildToolResultStackItems({
                  toolCall,
                  toolResult: commit.toolResult,
                  continuationItems: continuation.inputItems,
                  llmRequestSliceId: forkSliceId
                }) as Array<Record<string, unknown>>
              });
              await this.completeCoreMemoryCompressionForkToolExecutionSafe({
                executionId: forkToolExecutionId,
                status: 'completed',
                result: commit.toolResult,
                stackOutputItemId: (toolOutputRows[0] as { id?: string | number } | undefined)?.id || null
              });
              await this.completeCoreMemoryCompressionForkRunSafe({
                forkRunId,
                status: 'completed',
                summaryText: commit.text,
                artifact: commit.artifact,
                metadata: {
                  ...baseForkMetadata,
                  fork_turn_count: forkTurn,
                  fork_tool_call_count: forkToolCallCount,
                  fork_no_tool_retry_count: forkNoToolRetryTotal
                }
              });
              await this.store.logTimelineEvent({
                traceId: params.queueMessage.traceId,
                eventType: 'memory',
                eventName: 'core_memory_compression_fork',
                eventPhase: 'end',
                metadata: {
                  status: 'completed',
                  fork_run_id: forkRunId,
                  context_session_key: params.compression.contextSessionKey,
                  read_cutoff_after_conversation_id: params.compression.readCutoffAfterConversationId,
                  fork_turn_count: forkTurn,
                  fork_tool_call_count: forkToolCallCount,
                  fork_no_tool_retry_count: forkNoToolRetryTotal
                }
              });
              return commit;
            }

            const runtimeEnergyState = await this.getCurrentRuntimeEnergyState(params.queueMessage);
            const continuation = applyToolResultToLoopInput(toolCall, rawToolResult, {
              loopInput: forkInput,
              speakingToolName: params.queueMessage.chatType === 'direct' ? TOOL_NAMES.privateReply : TOOL_NAMES.groupReply,
              hasVisibleReply: false,
              runtimeEnergyState
            });
            if (continuation.forcedVisibleReply) {
              throw new Error(`${TOOL_NAMES.compressCoreMemory} fork must not force visible delivery`);
            }
            const toolOutputRows = await this.appendCoreMemoryCompressionForkItemsSafe({
              forkRunId,
              traceId: params.queueMessage.traceId,
              runId: params.queueMessage.runId,
              sourceType: 'core_memory_compression_fork_tool_executions',
              sourceId: forkToolExecutionId,
              llmRequestSliceId: forkSliceId,
              items: buildToolResultStackItems({
                toolCall,
                toolResult: rawToolResult,
                continuationItems: continuation.inputItems,
                llmRequestSliceId: forkSliceId
              }) as Array<Record<string, unknown>>
            });
            await this.completeCoreMemoryCompressionForkToolExecutionSafe({
              executionId: forkToolExecutionId,
              status: 'completed',
              result: rawToolResult,
              stackOutputItemId: (toolOutputRows[0] as { id?: string | number } | undefined)?.id || null
            });
            forkInput.push(...continuation.inputItems);
            pendingForkOneShotInputItems.push(...continuation.oneShotInputItems);
          } catch (error) {
            const toolResult = buildToolErrorResult(toolCall, error);
            const message = String(toolResult.error_message || toolResult.error || 'Tool execution failed');
            const runtimeEnergyState = await this.getCurrentRuntimeEnergyState(params.queueMessage);
            const continuation = applyToolResultToLoopInput(toolCall, toolResult, {
              loopInput: forkInput,
              speakingToolName: params.queueMessage.chatType === 'direct' ? TOOL_NAMES.privateReply : TOOL_NAMES.groupReply,
              hasVisibleReply: false,
              runtimeEnergyState
            });
            const toolOutputRows = await this.appendCoreMemoryCompressionForkItemsSafe({
              forkRunId,
              traceId: params.queueMessage.traceId,
              runId: params.queueMessage.runId,
              sourceType: 'core_memory_compression_fork_tool_executions',
              sourceId: forkToolExecutionId,
              llmRequestSliceId: forkSliceId,
              items: buildToolResultStackItems({
                toolCall,
                toolResult,
                continuationItems: continuation.inputItems,
                llmRequestSliceId: forkSliceId
              }) as Array<Record<string, unknown>>
            });
            await this.completeCoreMemoryCompressionForkToolExecutionSafe({
              executionId: forkToolExecutionId,
              status: 'failed',
              result: toolResult,
              errorMessage: message,
              stackOutputItemId: (toolOutputRows[0] as { id?: string | number } | undefined)?.id || null
            });
            forkInput.push(...continuation.inputItems);
            pendingForkOneShotInputItems.push(...continuation.oneShotInputItems);
            continue;
          }
        }
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.completeCoreMemoryCompressionForkRunSafe({
        forkRunId,
        status: 'failed',
        errorMessage: message,
        metadata: {
          ...baseForkMetadata,
          fork_tool_call_count: forkToolCallCount,
          fork_no_tool_retry_count: forkNoToolRetryTotal
        }
      });
      await this.store.logTimelineEvent({
        traceId: params.queueMessage.traceId,
        eventType: 'memory',
        eventName: 'core_memory_compression_fork',
        eventPhase: 'end',
        metadata: {
          status: 'failed',
          fork_run_id: forkRunId,
          error_message: message,
          fork_tool_call_count: forkToolCallCount,
          fork_no_tool_retry_count: forkNoToolRetryTotal
        }
      });
      throw error;
    }
  }

  private async executeCoreMemoryCompressionForkTurn(
    canonicalRequest: CanonicalAgentTurnRequest,
    queueMessage: QueueMessageRecord['payload'],
    runtimePrompt: ResolvedAgentRuntimePrompt,
    forkTurn: number
  ) {
    const response = await fetch(`${agentConfig.providerServiceUrl}/api/internal/llm/debug`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [NO_TRAFFIC_PERSIST_HEADER]: '1'
      },
      body: JSON.stringify({
        trace_id: queueMessage.traceId,
        run_id: queueMessage.runId,
        agent_turn: forkTurn,
        agent_type: 'chat_bot',
        prompt_name: runtimePrompt.promptName,
        executionMode: 'core_memory_compression_fork_no_persist',
        model: runtimePrompt.modelName,
        parameters: buildMainAgentParameters(runtimePrompt.parameters as Record<string, unknown> | undefined),
        canonicalRequest
      })
    });

    const payload = await response.json() as ProviderAgentResponse;
    if (!response.ok || !payload.success) {
      throw new Error(payload.error || `Provider compression fork execute failed with ${response.status}`);
    }

    return payload;
  }

  private async executeSubconsciousAgentForkTurn(
    canonicalRequest: CanonicalAgentTurnRequest,
    queueMessage: QueueMessageRecord['payload'],
    runtimePrompt: ResolvedAgentRuntimePrompt,
    forkTurn: number
  ) {
    const response = await fetch(`${agentConfig.providerServiceUrl}/api/internal/llm/debug`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [NO_TRAFFIC_PERSIST_HEADER]: '1'
      },
      body: JSON.stringify({
        trace_id: queueMessage.traceId,
        run_id: queueMessage.runId,
        agent_turn: forkTurn,
        agent_type: 'subconscious_agent',
        prompt_name: `${runtimePrompt.promptName}:subconscious_agent`,
        executionMode: 'subconscious_agent_fork_no_persist',
        model: runtimePrompt.modelName,
        parameters: buildMainAgentParameters(runtimePrompt.parameters as Record<string, unknown> | undefined),
        canonicalRequest
      })
    });

    const payload = await response.json() as ProviderAgentResponse;
    if (!response.ok || !payload.success) {
      throw new Error(payload.error || `Provider subconscious fork execute failed with ${response.status}`);
    }

    return payload;
  }

  private async executeCacheHeartbeatTurn(
    canonicalRequest: CanonicalAgentTurnRequest,
    queueMessage: QueueMessageRecord['payload'],
    runtimePrompt: ResolvedAgentRuntimePrompt
  ) {
    const timeoutMs = Math.max(1000, Number(agentConfig.cacheHeartbeatTimeoutMs) || 10_000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    let response: Response;
    try {
      response = await fetch(`${agentConfig.providerServiceUrl}/api/internal/llm/debug`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [NO_TRAFFIC_PERSIST_HEADER]: '1'
        },
        signal: controller.signal,
        body: JSON.stringify({
          trace_id: queueMessage.traceId,
          run_id: queueMessage.runId,
          agent_turn: 0,
          agent_type: 'chat_bot',
          prompt_name: runtimePrompt.promptName,
          executionMode: CACHE_HEARTBEAT_EXECUTION_MODE,
          model: runtimePrompt.modelName,
          parameters: buildMainAgentParameters(runtimePrompt.parameters as Record<string, unknown> | undefined),
          canonicalRequest
        })
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Provider cache heartbeat timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const payload = await response.json() as ProviderAgentResponse;
    if (!response.ok || !payload.success) {
      throw new Error(payload.error || `Provider cache heartbeat execute failed with ${response.status}`);
    }

    return payload;
  }

  private async executeAgentTurn(
    canonicalRequest: CanonicalAgentTurnRequest,
    queueMessage: QueueMessageRecord['payload'],
    traceId: string,
    turn: number,
    runtimePrompt: ResolvedAgentRuntimePrompt,
    sliceContext: {
      runId: string;
      inputStartIndex?: number | null;
      inputEndIndex?: number | null;
      inputStackItemIds?: Array<string | number>;
    } = { runId: traceId, inputStartIndex: null, inputEndIndex: null }
  ) {
    const body = JSON.stringify({
      trace_id: traceId,
      run_id: sliceContext.runId,
      agent_turn: turn,
      agent_type: 'chat_bot',
      prompt_name: runtimePrompt.promptName,
      model: runtimePrompt.modelName,
      parameters: buildMainAgentParameters(runtimePrompt.parameters as Record<string, unknown> | undefined),
      input_start_index: sliceContext.inputStartIndex ?? null,
      input_end_index: sliceContext.inputEndIndex ?? null,
      input_stack_item_ids: sliceContext.inputStackItemIds || [],
      canonicalRequest
    });
    const maxAttempts = Math.max(1, agentConfig.providerExecutionRetryAttempts || 1);
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetch(`${agentConfig.providerServiceUrl}/api/internal/agent/execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body
        });

        const payload = await response.json() as ProviderAgentResponse;
        if (!response.ok || !payload.success) {
          throw new Error(payload.error || `Provider agent execute failed with ${response.status}`);
        }

        return payload;
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts || !isTransientProviderExecutionError(error)) {
          throw error;
        }
        const retryDelayMs = computeProviderExecutionRetryDelayMs(attempt);
        moduleLogger.warn('Retrying transient provider agent execute failure', {
          traceId,
          runId: sliceContext.runId,
          turn,
          attempt,
          maxAttempts,
          retryDelayMs,
          error: error instanceof Error ? error.message : String(error)
        });
        if (retryDelayMs > 0) {
          await sleep(retryDelayMs);
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Provider agent execute failed'));
  }

  private async executeTool(
    toolCall: AgentToolCall,
    queueMessage: QueueMessageRecord['payload'],
    context: ToolExecutionContext = {}
  ): Promise<Record<string, unknown>> {
    switch (toolCall.name) {
      case TOOL_NAMES.privateReply:
        return this.sendMessage('private', toolCall.args, queueMessage);
      case TOOL_NAMES.groupReply:
        return this.sendMessage('group', toolCall.args, queueMessage);
      case TOOL_NAMES.unreadMeaning: {
        const meaning = parseUnreadMeaning(toolCall.args);
        if (!meaning) {
          throw new Error(`${TOOL_NAMES.unreadMeaning} returned invalid arguments`);
        }
        return {
          latest_unread_focus: meaning.latestUnreadFocus,
          message_act: meaning.messageAct,
          social_target: meaning.socialTarget,
          addressed_to_me: meaning.addressedToMe,
          has_real_novelty: meaning.hasRealNovelty,
          confidence: meaning.confidence,
          reason: meaning.reason,
          ...(meaning.socialActType !== null ? { social_act_type: meaning.socialActType } : {}),
          ...(meaning.topicContext !== null ? { topic_context: meaning.topicContext } : {})
        };
      }
      case TOOL_NAMES.execCommand: {
        return this.executeCommand(toolCall.args, toolCall, queueMessage);
      }
      case TOOL_NAMES.inspectImage: {
        return this.inspectImagePlaceholder(toolCall.args, queueMessage, context);
      }
      case TOOL_NAMES.imageTask: {
        return this.requestImageTask(toolCall.args, queueMessage, context);
      }
      case TOOL_NAMES.recoverEnergy: {
        const energyState = await this.getCurrentRuntimeEnergyState(queueMessage);
        const now = new Date();
        const policySnapshot = createRecoveryPolicySnapshot(now);
        const sessionPolicy = recoverySessionPolicyFromSnapshot(policySnapshot)!;
        const gate = energyState
          ? shouldAcceptVoluntaryRecovery({
              energy: energyState.energy,
              maxEnergy: energyState.maxEnergy,
              lastWakeAt: energyState.lastWakeAt ?? null,
              now,
              policy: sessionPolicy.policy
            })
          : null;
        if (energyState && gate && !gate.accepted) {
          const reason = '现在还没到可以休息的线：刚醒不久、身体还撑得住的时候，很难再次入睡。';
          return {
            recovered: false,
            rest_rejected: true,
            reason,
            energy: energyState.energy,
            max_energy: energyState.maxEnergy,
            pressure: gate.pressure,
            required_pressure: gate.requiredPressure,
            energy_cost: RUNTIME_TOOL_COSTS[TOOL_NAMES.recoverEnergy],
            system_reminder: renderRecoverEnergyRejectedReminder({
              reason
            }),
            xiaoni_os: typeof toolCall.args.xiaoni_os === 'string' && toolCall.args.xiaoni_os.trim()
              ? toolCall.args.xiaoni_os.trim()
              : null
          };
        }
        const reason = typeof toolCall.args.reason === 'string' && toolCall.args.reason.trim()
          ? toolCall.args.reason.trim()
          : null;
        const clockMinutes = normalizeRecoverEnergyClock(toolCall.args.clock);
        const startEnergy = energyState?.energy ?? 0;
        const maxEnergy = energyState?.maxEnergy ?? RUNTIME_MAX_ENERGY;
        const startedAt = now;
        const naturalWakeAt = estimateNaturalWakeAt({
          startEnergy,
          maxEnergy,
          startedAt,
          policy: sessionPolicy.policy
        });
        const hardWakeAt = estimateSessionWakeAt(startedAt, sessionPolicy);
        return {
          recovered: false,
          recovery_session_requested: true,
          rest_rejected: false,
          reason,
          clock_minutes: clockMinutes,
          clock_due_at: clockMinutes ? new Date(startedAt.getTime() + (clockMinutes * 60 * 1000)).toISOString() : null,
          started_at: startedAt.toISOString(),
          planned_natural_wake_at: naturalWakeAt.toISOString(),
          hard_wake_at: hardWakeAt.toISOString(),
          full_recovery_minutes: sessionPolicy.fullRecoveryMinutes,
          session_max_recovery_minutes: sessionPolicy.sessionMaxRecoveryMinutes,
          session_cap_wake_cause: sessionPolicy.sessionCapWakeCause,
          recovery_policy_snapshot: policySnapshot,
          energy_before: startEnergy,
          energy_start: startEnergy,
          energy: startEnergy,
          max_energy: maxEnergy,
          pressure: gate?.pressure ?? (1 - (startEnergy / Math.max(0.001, maxEnergy))),
          required_pressure: gate?.requiredPressure ?? null,
          energy_cost: RUNTIME_TOOL_COSTS[TOOL_NAMES.recoverEnergy],
          xiaoni_os: typeof toolCall.args.xiaoni_os === 'string' && toolCall.args.xiaoni_os.trim()
            ? toolCall.args.xiaoni_os.trim()
            : null
        };
      }
      case TOOL_NAMES.compressCoreMemory: {
        const text = typeof toolCall.args.text === 'string' && toolCall.args.text.trim()
          ? toolCall.args.text.trim()
          : '';
        if (!text) {
          throw new Error(`${TOOL_NAMES.compressCoreMemory} requires text`);
        }
        return {
          compressed: true,
          text,
          outcome: 'core_memory_compressed'
        };
      }
      default:
        throw new Error(`Unsupported tool: ${toolCall.name}`);
    }
  }

  private async getCurrentRuntimeEnergyState(queueMessage: QueueMessageRecord['payload']): Promise<RuntimeEnergyState | null> {
    const reader = (this.store as RuntimeStore & {
      getCurrentXiaoniEnergyState?: RuntimeStore['getCurrentXiaoniEnergyState'];
    }).getCurrentXiaoniEnergyState;
    if (typeof reader !== 'function') {
      return null;
    }
    try {
      const state = await reader.call(this.store);
      const energy = normalizeRuntimeEnergy(state?.energy, RUNTIME_MAX_ENERGY);
      const maxEnergy = Math.max(0.001, normalizeRuntimeEnergy(state?.maxEnergy, RUNTIME_MAX_ENERGY));
      return {
        energy,
        maxEnergy,
        lastWakeAt: typeof state?.lastWakeAt === 'string' ? state.lastWakeAt : null
      };
    } catch (error) {
      moduleLogger.warn('Failed to read Xiaoni energy before recover_energy', {
        traceId: queueMessage.traceId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async executeCommand(
    args: Record<string, unknown>,
    toolCall?: AgentToolCall,
    queueMessage?: QueueMessageRecord['payload']
  ): Promise<Record<string, unknown>> {
    const cmd = typeof args.cmd === 'string' && args.cmd.trim()
      ? args.cmd
      : '';
    if (!cmd) {
      const message = `${TOOL_NAMES.execCommand} requires cmd`;
      return {
        cmd,
        workdir: process.cwd(),
        shell: process.env.SHELL || '/bin/sh',
        login: args.login !== false,
        tty: Boolean(args.tty),
        sandbox_permissions: typeof args.sandbox_permissions === 'string' ? args.sandbox_permissions : 'use_default',
        exit_code: null,
        signal: null,
        timed_out: false,
        duration_ms: 0,
        stdout: '',
        stderr: message,
        truncated: false,
        error_message: message,
        codex_output: buildCodexExecOutput({
          chunkId: uuidv4().slice(0, 8),
          durationMs: 0,
          exitCode: null,
          output: message
        })
      };
    }

    const execArgs = {
      ...args,
      env: {
        ...normalizeExecEnv(args.env),
        ...buildExecCommandRuntimeEnv(toolCall, queueMessage)
      }
    };

    if (agentConfig.xiaoniExecutorUrl) {
      try {
        const response = await fetch(`${agentConfig.xiaoniExecutorUrl}/api/internal/exec-command`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(execArgs)
        });
        const text = await response.text();
        let payload: unknown = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          payload = null;
        }
        if (!response.ok) {
          throw new Error(`xiaoni-executor HTTP ${response.status}: ${text || response.statusText}`);
        }
        if (payload && typeof payload === 'object' && 'result' in payload) {
          const result = (payload as { result?: unknown }).result;
          if (result && typeof result === 'object' && !Array.isArray(result)) {
            return result as Record<string, unknown>;
          }
        }
        throw new Error(`xiaoni-executor returned invalid payload: ${text}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          cmd,
          executor: 'xiaoni-executor',
          executor_unavailable: true,
          workdir: typeof args.workdir === 'string' && args.workdir.trim() ? args.workdir.trim() : process.cwd(),
          shell: typeof args.shell === 'string' && args.shell.trim() ? args.shell.trim() : process.env.SHELL || '/bin/sh',
          login: args.login !== false,
          tty: Boolean(args.tty),
          sandbox_permissions: typeof args.sandbox_permissions === 'string' ? args.sandbox_permissions : 'use_default',
          exit_code: null,
          signal: null,
          timed_out: false,
          duration_ms: 0,
          stdout: '',
          stderr: message,
          truncated: false,
          error_message: message,
          codex_output: buildCodexExecOutput({
            chunkId: uuidv4().slice(0, 8),
            durationMs: 0,
            exitCode: null,
            output: message
          })
        };
      }
    }

    const shell = typeof args.shell === 'string' && args.shell.trim()
      ? args.shell.trim()
      : process.env.SHELL || '/bin/sh';
    const workdir = typeof args.workdir === 'string' && args.workdir.trim()
      ? args.workdir.trim()
      : process.cwd();
    const login = args.login !== false;
    const maxOutputTokens = clampNumber(args.max_output_tokens, 10_000, 1, 200_000);
    const maxOutputChars = Math.max(1, maxOutputTokens * 4);
    const timeoutMs = clampNumber(args.yield_time_ms, 10_000, 250, 30_000);
    const startedAt = Date.now();

    return await new Promise<Record<string, unknown>>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const sandboxPermissions = typeof args.sandbox_permissions === 'string'
        ? args.sandbox_permissions
        : 'use_default';
      const buildResult = (input: {
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        errorMessage?: string | null;
      }) => {
        const durationMs = Date.now() - startedAt;
        const truncated = stdout.length >= maxOutputChars || stderr.length >= maxOutputChars;
        return {
          cmd,
          workdir,
          shell,
          login,
          tty: Boolean(args.tty),
          sandbox_permissions: sandboxPermissions,
          exit_code: input.exitCode,
          signal: input.signal || null,
          timed_out: timedOut,
          duration_ms: durationMs,
          stdout,
          stderr,
          truncated,
          codex_output: buildCodexExecOutput({
            chunkId: uuidv4().slice(0, 8),
            durationMs,
            exitCode: input.exitCode,
            signal: input.signal || null,
            output: stdout + stderr,
            truncated
          }),
          ...(input.errorMessage ? { error_message: input.errorMessage } : {})
        };
      };
      const finish = (result: Record<string, unknown>) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve(result);
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(shell, resolveExecShellArgs(shell, cmd, login), {
          cwd: workdir,
          env: {
            ...process.env,
            ...normalizeExecEnv(execArgs.env)
          },
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr = appendCappedOutput(stderr, Buffer.from(message), maxOutputChars);
        finish(buildResult({
          exitCode: null,
          signal: null,
          errorMessage: message
        }));
        return;
      }

      timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) {
            child.kill('SIGKILL');
          }
        }, 1_000).unref();
      }, timeoutMs);
      timeout.unref();

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = appendCappedOutput(stdout, chunk, maxOutputChars);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = appendCappedOutput(stderr, chunk, maxOutputChars);
      });
      child.on('error', (error) => {
        const message = error instanceof Error ? error.message : String(error);
        stderr = appendCappedOutput(stderr, Buffer.from(message), maxOutputChars);
        finish(buildResult({
          exitCode: null,
          signal: null,
          errorMessage: message
        }));
      });
      child.on('close', (code, signal) => {
        finish(buildResult({
          exitCode: typeof code === 'number' ? code : null,
          signal: signal || null
        }));
      });
    });
  }

  private async inspectImagePlaceholder(
    args: Record<string, unknown>,
    queueMessage: QueueMessageRecord['payload'],
    context: ToolExecutionContext
  ) {
    const imageId = typeof args.image_id === 'string' && args.image_id.trim()
      ? args.image_id.trim()
      : '';
    const mediaTag = typeof args.media_tag === 'string' && args.media_tag.trim()
      ? args.media_tag.trim()
      : '';
    if (!imageId && !mediaTag) {
      const description = '没有提供 image_id 或 media_tag。不能猜图片 id；只能使用当前上下文明确给出的图片ID。';
      return {
        image_id: null,
        media_tag: null,
        inspected: false,
        description,
        output_xml: buildImageObservationXml('missing-image-reference', description)
      };
    }

    const asset = imageId
      ? await this.resolveMediaAssetForToolReference(queueMessage, imageId, { globalId: true })
      : await this.resolveMediaAssetForToolReference(queueMessage, mediaTag, { globalId: false });
    if (!asset) {
      const reference = imageId || mediaTag;
      const referenceKind = imageId ? 'image_id' : 'media_tag';
      const description = `这个 ${referenceKind} 不存在：${reference}。不能猜图片 id；只能使用当前上下文明确给出的图片ID。`;
      return {
        image_id: imageId || null,
        media_tag: mediaTag || null,
        inspected: false,
        description,
        output_xml: buildImageObservationXml(reference, description)
      };
    }

    const assetId = typeof asset.id === 'string' && asset.id.trim() ? asset.id.trim() : imageId;
    if (!assetId) {
      throw new Error(`${TOOL_NAMES.inspectImage} resolved an image without a stable id`);
    }

    const baseRequest = context.currentCanonicalRequest;
    if (!baseRequest) {
      throw new Error(`${TOOL_NAMES.inspectImage} requires current main-agent request context`);
    }

    let materialized: { dataUrl: string | null; mimeType: string | null; executorPath: string | null };
    try {
      materialized = await this.materializeImageAsset(asset);
    } catch (error) {
      const description = '这张图片的原始文件现在不可读取，可能是 QQ 临时图片链接已经过期。需要对方重新发图，或提供新的可读取图片。';
      const outputXml = buildImageObservationXml(assetId, description);
      return {
        image_id: assetId,
        media_tag: asset.media_tag || mediaTag || null,
        inspected: false,
        description,
        output_xml: outputXml,
        executor_path: null,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    if (!materialized.dataUrl) {
      const description = '这张图片目前只有占位符，没有可读取的图片数据。';
      const outputXml = buildImageObservationXml(assetId, description);
      return {
        image_id: assetId,
        media_tag: asset.media_tag || mediaTag || null,
        inspected: false,
        description,
        output_xml: outputXml,
        executor_path: materialized.executorPath
      };
    }

    const forkRunId = buildImageVisionForkRunId(queueMessage.runId, assetId);
    const outputPath = buildImageVisionObservationPath(assetId);
    const existingObservation = await this.readImageVisionObservationFile(outputPath, queueMessage);
    const forkRequest = buildImageVisionForkRequest(
      baseRequest,
      materialized.dataUrl,
      assetId,
      outputPath,
      existingObservation.text
    );
    await this.recordImageVisionForkRunSafe({
      forkRunId,
      status: 'running',
      traceId: queueMessage.traceId,
      runId: queueMessage.runId,
      assetId,
      imageId: assetId,
      mediaTag: asset.media_tag || mediaTag || null,
      metadata: {
        execution_mode: 'image_vision_fork',
        image_vision_output_path: outputPath,
        reason: typeof args.reason === 'string' ? args.reason : null
      }
    });

    let forkResult: {
      payload: ProviderAgentResponse | null;
      description: string;
      forkSliceId: string | null;
      failed: boolean;
      failureReason?: string | null;
    };
    try {
      forkResult = await this.runImageVisionForkToFile({
        forkRunId,
        baseRequest: forkRequest,
        queueMessage,
        outputPath,
        assetId,
        mediaTag: asset.media_tag || mediaTag || null
      });
    } catch (error) {
      await this.completeImageVisionForkRunSafe({
        forkRunId,
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
        metadata: {
          execution_mode: 'image_vision_fork',
          asset_id: assetId,
          image_vision_output_path: outputPath
        }
      });
      throw error;
    }

    if (forkResult.failed) {
      await this.completeImageVisionForkRunSafe({
        forkRunId,
        status: 'failed',
        errorMessage: forkResult.failureReason || 'image vision fork did not write a description file',
        metadata: {
          execution_mode: 'image_vision_fork',
          asset_id: assetId,
          image_vision_output_path: outputPath
        }
      });
      const description = forkResult.description;
      return {
        image_id: assetId,
        media_tag: asset.media_tag || mediaTag || null,
        inspected: false,
        description,
        output_xml: buildImageObservationXml(assetId, description),
        executor_path: materialized.executorPath,
        observation_path: outputPath
      };
    }

    const observation = await this.store.recordMediaObservation({
      assetId,
      observer: 'xiaoni',
      description: forkResult.description,
      sourceModel: forkResult.payload?.model || null,
      metadata: {
        trace_id: queueMessage.traceId,
        run_id: queueMessage.runId || null,
        fork_run_id: forkRunId,
        llm_call_id: forkResult.payload?.llm_call_id || null,
        llm_request_slice_id: forkResult.forkSliceId || null,
        image_vision_output_path: outputPath,
        provider_raw_trace_persisted: true,
        fork: 'image_vision_fork',
        reason: typeof args.reason === 'string' ? args.reason : null
      }
    });
    await this.completeImageVisionForkRunSafe({
      forkRunId,
      status: 'completed',
      observationId: typeof (observation as { id?: unknown } | null)?.id === 'string'
        ? (observation as { id: string }).id
        : null,
      description: forkResult.description,
      artifact: {
        description: forkResult.description,
        observation_path: outputPath,
        llm_request_slice_id: forkResult.forkSliceId || null,
        llm_call_id: forkResult.payload?.llm_call_id || null
      },
      metadata: {
        execution_mode: 'image_vision_fork',
        asset_id: assetId,
        media_tag: asset.media_tag || mediaTag || null,
        image_vision_output_path: outputPath
      }
    });

    const outputXml = buildImageObservationXml(assetId, forkResult.description);
    return {
      image_id: assetId,
      media_tag: asset.media_tag || mediaTag || null,
      inspected: true,
      description: forkResult.description,
      output_xml: outputXml,
      executor_path: materialized.executorPath,
      observation_path: outputPath
    };
  }

  private async runImageVisionForkToFile(params: {
    forkRunId: string;
    baseRequest: CanonicalAgentTurnRequest;
    queueMessage: QueueMessageRecord['payload'];
    outputPath: string;
    assetId: string;
    mediaTag: string | null;
  }): Promise<{
    payload: ProviderAgentResponse | null;
    description: string;
    forkSliceId: string | null;
    failed: boolean;
    failureReason?: string | null;
  }> {
    let forkInput = cloneCanonicalAgentTurnRequest(params.baseRequest).input;
    let pendingForkOneShotInputItems: OpenResponseInputItem[] = [];
    let lastPayload: ProviderAgentResponse | null = null;
    let lastForkSliceId: string | null = null;
    let lastCheckResult = 'not_checked';

    for (let forkTurn = 1; forkTurn <= IMAGE_VISION_FORK_MAX_FILE_WRITE_ATTEMPTS; forkTurn += 1) {
      const forkRequest = cloneCanonicalAgentTurnRequest(params.baseRequest);
      const forkRequestInput = pendingForkOneShotInputItems.length > 0
        ? [...forkInput, ...pendingForkOneShotInputItems]
        : forkInput;
      pendingForkOneShotInputItems = [];
      forkRequest.input = normalizeResponseInputItems(forkRequestInput);
      forkRequest.metadata = {
        ...(forkRequest.metadata || {}),
        fork_turn: String(forkTurn)
      };
      await this.waitForRuntimeEnabledBeforeModelSlice(params.queueMessage, params.queueMessage.runId);
      const payload = await this.executeImageVisionForkTurn(forkRequest, params.queueMessage);
      lastPayload = payload;
      const forkSliceId = payload.llm_request_slice_id
        || payload.llm_call_id
        || `image-vision-fork-slice:${params.forkRunId}:${forkTurn}`;
      lastForkSliceId = forkSliceId;
      const inputRows = await this.appendImageVisionForkItemsSafe({
        forkRunId: params.forkRunId,
        traceId: params.queueMessage.traceId,
        runId: params.queueMessage.runId,
        sourceType: 'image_vision_fork_slices',
        sourceId: forkSliceId,
        llmRequestSliceId: forkSliceId,
        items: [buildForkInputStackItem({
          forkRunId: params.forkRunId,
          sliceId: forkSliceId,
          forkTurn,
          source: 'image_vision_fork_input',
          inputItems: forkRequest.input
        }) as Record<string, unknown>]
      });
      const outputItems = extractCanonicalResponseOutputItems(payload);
      const outputRows = await this.appendImageVisionForkItemsSafe({
        forkRunId: params.forkRunId,
        traceId: params.queueMessage.traceId,
        runId: params.queueMessage.runId,
        sourceType: 'image_vision_fork_slices',
        sourceId: forkSliceId,
        llmRequestSliceId: forkSliceId,
        items: buildModelOutputStackItems(outputItems, forkSliceId) as Array<Record<string, unknown>>
      });
      const outputItemIndexes = outputRows
        .map((row) => Number((row as { itemIndex?: unknown }).itemIndex))
        .filter((value) => Number.isFinite(value));
      const inputItemIndexes = inputRows
        .map((row) => Number((row as { itemIndex?: unknown }).itemIndex))
        .filter((value) => Number.isFinite(value));
      const inputStackItemIds = inputRows
        .map((row) => (row as { id?: unknown }).id)
        .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number');
      await this.recordImageVisionForkSliceSafe({
        forkRunId: params.forkRunId,
        sliceId: forkSliceId,
        llmCallId: payload.llm_call_id || null,
        inputStartIndex: inputItemIndexes.length > 0 ? Math.min(...inputItemIndexes) : null,
        inputEndIndex: inputItemIndexes.length > 0 ? Math.max(...inputItemIndexes) : null,
        inputStackItemIds,
        outputStartIndex: outputItemIndexes.length > 0 ? Math.min(...outputItemIndexes) : null,
        outputEndIndex: outputItemIndexes.length > 0 ? Math.max(...outputItemIndexes) : null,
        canonicalRequest: (payload.canonical_request || forkRequest) as Record<string, unknown>,
        wireRequest: payload.wire_request || null,
        canonicalResponse: payload.canonical_response || null,
        wireResponse: payload.wire_response || null,
        rawResponse: payload.raw_response || null,
        outputItems,
        status: payload.success ? 'completed' : 'failed',
        tokenUsage: buildProviderTokenUsage(payload),
        traceId: params.queueMessage.traceId,
        runId: params.queueMessage.runId,
        agentTurn: forkTurn,
        modelName: payload.model || forkRequest.model || null,
        modelProvider: payload.provider || null,
        requestFormatVersion: payload.request_format_version || null,
        wireProviderFormat: payload.wire_provider_format || null,
        processingTimeMs: typeof payload.performance?.processing_time_ms === 'number' ? payload.performance.processing_time_ms : null,
        metadata: {
          ...buildProviderWireMetadata(payload),
          execution_mode: 'image_vision_fork',
          asset_id: params.assetId,
          media_tag: params.mediaTag,
          image_vision_output_path: params.outputPath,
          fork_turn: forkTurn
        }
      });

      const actionPlan = this.responseActionRouter.route(payload.canonical_response);
      const toolCalls = actionPlan.replayableOutputs.filter(isReplayableToolCall);
      for (const replayItem of actionPlan.replayableOutputs) {
        forkInput.push(replayItem.inputItem as OpenResponseInputItem);
      }

      const wrongToolCalls = toolCalls.filter((item) => item.toolCall.name !== TOOL_NAMES.execCommand);
      if (wrongToolCalls.length > 0) {
        const wrongToolOutputs = wrongToolCalls.map((item) => buildImageVisionUnsupportedToolOutput(item.toolCall));
        forkInput.push(...wrongToolOutputs);
        await this.appendImageVisionForkItemsSafe({
          forkRunId: params.forkRunId,
          traceId: params.queueMessage.traceId,
          runId: params.queueMessage.runId,
          sourceType: 'image_vision_fork_tool_executions',
          sourceId: `image-vision-fork-tool:${params.forkRunId}:unsupported-tools:${forkTurn}`,
          llmRequestSliceId: forkSliceId,
          items: wrongToolCalls.flatMap((item, index) => buildToolResultStackItems({
            toolCall: item.toolCall,
            toolResult: {
              success: false,
              error: wrongToolOutputs[index]?.output || `只能调用 ${TOOL_NAMES.execCommand}`,
              allowed_tool: TOOL_NAMES.execCommand,
              task: 'image_vision'
            },
            continuationItems: wrongToolOutputs[index] ? [wrongToolOutputs[index]!] : [],
            llmRequestSliceId: forkSliceId
          })) as Array<Record<string, unknown>>
        });
      }

      const execCalls = toolCalls.filter((item) => item.toolCall.name === TOOL_NAMES.execCommand);
      for (const execCall of execCalls) {
        const toolResult = await this.executeCommand(execCall.toolCall.args, execCall.toolCall, params.queueMessage);
        const continuation = applyToolResultToLoopInput(execCall.toolCall, toolResult, {
          loopInput: forkInput,
          speakingToolName: params.queueMessage.chatType === 'direct' ? TOOL_NAMES.privateReply : TOOL_NAMES.groupReply,
          hasVisibleReply: false,
          runtimeEnergyState: await this.getCurrentRuntimeEnergyState(params.queueMessage)
        });
        forkInput.push(...continuation.inputItems);
        pendingForkOneShotInputItems.push(...continuation.oneShotInputItems);
        await this.appendImageVisionForkItemsSafe({
          forkRunId: params.forkRunId,
          traceId: params.queueMessage.traceId,
          runId: params.queueMessage.runId,
          sourceType: 'image_vision_fork_tool_executions',
          sourceId: `image-vision-fork-tool:${params.forkRunId}:${execCall.toolCall.callId}`,
          llmRequestSliceId: forkSliceId,
          items: buildToolResultStackItems({
            toolCall: execCall.toolCall,
            toolResult,
            continuationItems: continuation.inputItems,
            llmRequestSliceId: forkSliceId
          }) as Array<Record<string, unknown>>
        });
      }

      if (actionPlan.hasFinalAnswer) {
        const check = await this.readImageVisionObservationFile(params.outputPath, params.queueMessage);
        lastCheckResult = check.message;
        if (check.text) {
          return {
            payload,
            description: check.text,
            forkSliceId,
            failed: false
          };
        }
        forkInput.push(buildImageVisionRetryReminder({
          outputPath: params.outputPath,
          checkResult: `你已经 final_answer，但该路径下还没有可用的图片理解内容。${check.message}`
        }));
        continue;
      }

      lastCheckResult = wrongToolCalls.length > 0
        ? `模型调用了不允许的工具 ${wrongToolCalls.map((item) => item.toolCall.name).join(', ')}；已通过 function_call_output 提醒只能调用 ${TOOL_NAMES.execCommand}`
        : execCalls.length > 0
        ? `模型调用了 ${execCalls.length} 个 ${TOOL_NAMES.execCommand}，但还没有 final_answer 表示写入完成`
        : `模型没有调用 ${TOOL_NAMES.execCommand}，也没有 final_answer`;
      forkInput.push(buildImageVisionRetryReminder({
        outputPath: params.outputPath,
        checkResult: lastCheckResult
      }));
    }

    return {
      payload: lastPayload,
      description: buildImageVisionFailedDescription(params.outputPath),
      forkSliceId: lastForkSliceId,
      failed: true,
      failureReason: `image vision fork failed to write non-empty observation file after ${IMAGE_VISION_FORK_MAX_FILE_WRITE_ATTEMPTS} attempts: ${lastCheckResult}`
    };
  }

  private async executeImageVisionForkTurn(
    forkRequest: CanonicalAgentTurnRequest,
    queueMessage: QueueMessageRecord['payload']
  ): Promise<ProviderAgentResponse> {
    const response = await fetch(`${agentConfig.providerServiceUrl}/api/internal/llm/debug`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [NO_TRAFFIC_PERSIST_HEADER]: '1'
      },
      body: JSON.stringify({
        trace_id: queueMessage.traceId,
        run_id: queueMessage.runId,
        executionMode: 'image_vision_fork',
        model: forkRequest.model,
        canonicalRequest: forkRequest
      })
    });
    const payload = await response.json() as ProviderAgentResponse;
    if (!response.ok || payload.success === false) {
      throw new Error(payload.error || `${TOOL_NAMES.inspectImage} fork failed with ${response.status}`);
    }
    return payload;
  }

  private async readImageVisionObservationFile(
    outputPath: string,
    queueMessage: QueueMessageRecord['payload']
  ): Promise<{ text: string | null; message: string }> {
    const script = [
      'python3 - <<\'PY\'',
      'from pathlib import Path',
      'p = Path(' + JSON.stringify(outputPath) + ')',
      'if not p.exists():',
      '    print("MISSING")',
      'elif not p.is_file():',
      '    print("NOT_FILE")',
      'else:',
      '    text = p.read_text(encoding="utf-8", errors="replace").strip()',
      '    if not text:',
      '        print("EMPTY")',
      '    else:',
      '        print("OK")',
      '        print(text)',
      'PY'
    ].join('\n');
    const result = await this.executeCommand({
      cmd: script,
      yield_time_ms: 10_000,
      max_output_tokens: 20_000
    }, undefined, queueMessage);
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    const [statusLine = '', ...rest] = stdout.split(/\r?\n/u);
    const status = statusLine.trim();
    if (status === 'OK') {
      const text = rest.join('\n').trim();
      return text
        ? { text, message: '文件存在且内容非空' }
        : { text: null, message: '文件状态为 OK，但内容为空' };
    }
    const detail = stderr ? `${status || 'UNKNOWN'}: ${stderr}` : status || 'UNKNOWN';
    return {
      text: null,
      message: `文件检查失败：${detail}`
    };
  }

  private async resolveMediaAssetForToolReference(
    queueMessage: QueueMessageRecord['payload'],
    requestedReference: string,
    options: { globalId: boolean }
  ) {
    const reference = typeof requestedReference === 'string' && requestedReference.trim()
      ? requestedReference.trim()
      : '';
    if (!reference) {
      return null;
    }

    const assetReaderById = (this.store as RuntimeStore & {
      getMediaAssetById?: RuntimeStore['getMediaAssetById'];
    }).getMediaAssetById;
    if (typeof assetReaderById === 'function' && (options.globalId || MEDIA_ASSET_ID_PATTERN.test(reference))) {
      return assetReaderById.call(this.store, queueMessage.sessionKey, reference);
    }

    const exact = await this.store.getMediaAssetByTag(queueMessage.sessionKey, reference);
    if (exact) {
      return exact;
    }

    const normalized = reference.toLowerCase();
    const contextualAssets = [];
    for (const message of queueMessage.messages) {
      const assets = Array.isArray(message.inboundContext.MediaAssets)
        ? message.inboundContext.MediaAssets
        : [];
      contextualAssets.push(...assets);
    }

    const candidate = contextualAssets.find((asset) => {
      const mediaTag = typeof asset.mediaTag === 'string' ? asset.mediaTag.toLowerCase() : '';
      const assetId = typeof asset.id === 'string' ? asset.id.toLowerCase() : '';
      const placeholder = typeof asset.placeholder === 'string' ? asset.placeholder.toLowerCase() : '';
      const fileName = typeof asset.fileName === 'string' ? asset.fileName.toLowerCase() : '';
      return normalized === assetId
        || normalized === mediaTag
        || normalized === `file:${fileName}`
        || normalized === fileName
        || Boolean(fileName && normalized.includes(fileName))
        || Boolean(placeholder && normalized === placeholder);
    });
    if (candidate?.id && typeof assetReaderById === 'function') {
      return assetReaderById.call(this.store, queueMessage.sessionKey, candidate.id);
    }
    if (candidate?.mediaTag) {
      return this.store.getMediaAssetByTag(queueMessage.sessionKey, candidate.mediaTag);
    }

    return null;
  }

  private async materializeImageAsset(asset: Record<string, unknown>) {
    const metadata = asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata)
      ? asset.metadata as Record<string, unknown>
      : {};
    const executorPath = typeof metadata.executor_path === 'string' && metadata.executor_path.trim()
      ? metadata.executor_path.trim()
      : typeof metadata.executorPath === 'string' && metadata.executorPath.trim()
        ? metadata.executorPath.trim()
        : typeof asset.executor_path === 'string' && asset.executor_path.trim()
          ? asset.executor_path.trim()
          : typeof asset.executorPath === 'string' && asset.executorPath.trim()
            ? asset.executorPath.trim()
            : null;
    const sourceLocator = typeof asset.storage_uri === 'string' && asset.storage_uri.trim()
      ? asset.storage_uri.trim()
      : typeof asset.storageUri === 'string' && asset.storageUri.trim()
        ? asset.storageUri.trim()
        : typeof asset.source_locator === 'string' && asset.source_locator.trim()
          ? asset.source_locator.trim()
          : typeof asset.sourceLocator === 'string' && asset.sourceLocator.trim()
            ? asset.sourceLocator.trim()
            : '';
    const fileId = typeof metadata.file_id === 'string' && metadata.file_id.trim()
      ? metadata.file_id.trim()
      : '';
    if (!sourceLocator && !fileId) {
      return { dataUrl: null as string | null, mimeType: null as string | null, executorPath };
    }

    const response = await fetch(`${agentConfig.providerServiceUrl}/api/internal/media/materialize-image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [NO_TRAFFIC_PERSIST_HEADER]: '1'
      },
      body: JSON.stringify({
        asset_id: asset.id,
        source_locator: sourceLocator || undefined,
        file_id: fileId || undefined,
        file_name: typeof metadata.file_name === 'string' ? metadata.file_name : undefined,
        mime_type: typeof asset.mime_type === 'string'
          ? asset.mime_type
          : typeof asset.mimeType === 'string'
            ? asset.mimeType
            : undefined,
        metadata: {
          file_id: fileId || undefined,
          file_name: typeof metadata.file_name === 'string' ? metadata.file_name : undefined
        }
      })
    });
    const payload = await response.json() as { success?: boolean; error?: string; data?: { data_url?: string; mime_type?: string } };
    if (!response.ok || payload.success === false) {
      throw new Error(payload.error || `${TOOL_NAMES.inspectImage} materialize failed with ${response.status}`);
    }
    const dataUrl = typeof payload.data?.data_url === 'string' && payload.data.data_url.startsWith('data:image/')
      ? payload.data.data_url
      : null;
    return {
      dataUrl,
      mimeType: typeof payload.data?.mime_type === 'string' ? payload.data.mime_type : null,
      executorPath
    };
  }

  private async requestImageTask(
    args: Record<string, unknown>,
    queueMessage: QueueMessageRecord['payload'],
    context: ToolExecutionContext = {}
  ) {
    // Image generation is temporarily disabled during the Codex->Claude migration.
    // The image path dispatches `codex_base_request` (a clone of the current canonical
    // turn) to the Codex image Responses endpoint to reuse the main agent's prefix
    // cache — but the main agent now runs on Claude, so that base request is Claude-
    // shaped and the Codex reuse is moot/broken. Return a graceful "unavailable"
    // result so the model tells the user it can't make images right now instead of
    // queuing a broken task. Re-enable with XIAONI_IMAGE_TASK_ENABLED=true once the
    // image path is ported to the Claude flow.
    if (process.env.XIAONI_IMAGE_TASK_ENABLED !== 'true') {
      void context;
      return {
        queued: false,
        available: false,
        artifact_available: false,
        task_status: 'unavailable',
        status_text: '作图功能当前临时不可用（迁移期间已停用），日后会恢复。请直接用文字告诉对方这次做不了图，不要反复重试本工具。'
      };
    }

    const requestedOperation = args.operation === 'edit' ? 'edit' : 'generate';
    const prompt = typeof args.prompt === 'string' && args.prompt.trim()
      ? args.prompt.trim()
      : '';
    const targetDescription = typeof args.target_description === 'string' && args.target_description.trim()
      ? args.target_description.trim()
      : `帮 ${queueMessage.senderName || queueMessage.senderId} 做一张图`;
    if (!prompt) {
      throw new Error(`${TOOL_NAMES.imageTask} requires prompt`);
    }

    const sourceMediaTags = Array.isArray(args.source_media_tags)
      ? args.source_media_tags.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean)
      : [];
    const mediaAssets = [];
    for (const mediaTag of sourceMediaTags) {
      const asset = await this.resolveMediaAssetForToolReference(queueMessage, mediaTag, {
        globalId: MEDIA_ASSET_ID_PATTERN.test(mediaTag)
      });
      if (asset) {
        mediaAssets.push(asset);
      }
    }
    const operation = requestedOperation === 'edit' && mediaAssets.length > 0 ? 'edit' : 'generate';
    const normalizedFromEdit = requestedOperation === 'edit' && operation === 'generate';
    const normalizationReason = normalizedFromEdit
      ? sourceMediaTags.length > 0
        ? 'source_media_unresolved'
        : 'source_media_missing'
      : null;

    const task = await this.store.createRuntimeTask({
      taskType: operation === 'edit' ? 'image_edit' : 'image_generate',
      status: 'pending',
      sessionKey: queueMessage.sessionKey,
      chatType: queueMessage.chatType,
      peerId: queueMessage.peerId,
      peerName: queueMessage.peerName || null,
      requesterSenderId: queueMessage.senderId,
      requesterSenderName: queueMessage.senderName || null,
      targetDescription,
      prompt,
      sourceTraceId: queueMessage.traceId,
      sourceRunId: queueMessage.runId,
      sourceQueueMessageIds: queueMessage.messages.map((message) => message.queueMessageId),
      sourceMediaTags,
      sourceMediaAssetIds: mediaAssets.map((asset) => asset.id),
      inputJson: {
        operation,
        requested_operation: requestedOperation,
        source_media_tags: sourceMediaTags,
        has_source_media: mediaAssets.length > 0,
        ...(context.currentCanonicalRequest ? {
          codex_base_request: cloneCanonicalAgentTurnRequest(context.currentCanonicalRequest)
        } : {}),
        ...(normalizedFromEdit ? {
          normalized_from_edit: true,
          normalization_reason: normalizationReason
        } : {})
      }
    });

    const xiaoniOs = typeof args.xiaoni_os === 'string' && args.xiaoni_os.trim()
      ? args.xiaoni_os.trim()
      : null;
    const taskId = typeof task === 'string'
      ? task
      : typeof task?.id === 'string'
        ? task.id
        : null;
    const taskType = operation === 'edit' ? 'image_edit' : 'image_generate';
    const requestedTaskType = requestedOperation === 'edit' ? 'image_edit' : 'image_generate';
    const statusText = renderImageTaskPendingStatusText({
      taskId,
      taskType,
      requestedTaskType,
      targetDescription
    });

    return {
      queued: true,
      task_id: taskId,
      task_status: 'pending',
      task_type: taskType,
      requested_task_type: requestedTaskType,
      task_context: targetDescription,
      artifact_available: false,
      picture_id: null,
      picture_path: null,
      output_path: null,
      completion_signal: 'image_task_notification',
      wait_for_notification: true,
      do_not_infer_artifact_path: true,
      xiaoni_os: xiaoniOs,
      status_text: statusText
    };
  }

  private async sendMessage(
    messageType: 'private' | 'group',
    args: Record<string, unknown>,
    queueMessage: QueueMessageRecord['payload'],
    options: Record<string, never> = {}
  ) {
    void options;
    const sanitizedArgs = args;
    const xiaoniOs = typeof sanitizedArgs.xiaoni_os === 'string' && sanitizedArgs.xiaoni_os.trim()
      ? sanitizedArgs.xiaoni_os.trim()
      : null;
    const pendingShare = typeof sanitizedArgs.pending_share === 'string' && sanitizedArgs.pending_share.trim()
      ? sanitizedArgs.pending_share.trim()
      : null;

    if (messageType === 'private') {
      const messages = normalizeMessages(sanitizedArgs);
      let userId: number | null = null;
      try {
        userId = resolveOptionalToolTargetId(sanitizedArgs, 'user_id', 'target_user_id');
      } catch (error) {
        return buildRetryableSendToolError('private', TOOL_NAMES.privateReply, sanitizedArgs, {
          errorCode: 'invalid_user_id',
          message: error instanceof Error ? error.message : String(error),
          requiredArguments: ['user_id']
        });
      }
      if (userId === null) {
        return buildRetryableSendToolError('private', TOOL_NAMES.privateReply, sanitizedArgs, {
          errorCode: 'missing_user_id',
          message: `${TOOL_NAMES.privateReply} requires explicit user_id.`,
          requiredArguments: ['user_id']
        });
      }
      if (messages.length === 0) {
        return buildRetryableSendToolError('private', TOOL_NAMES.privateReply, sanitizedArgs, {
          errorCode: 'missing_message',
          message: `${TOOL_NAMES.privateReply} requires message or messages.`,
          requiredArguments: ['message or messages']
        });
      }

      const response = await fetch(`${agentConfig.providerServiceUrl}/api/internal/send_private`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          user_id: userId,
          messages
        })
      });
      const payload = await response.json() as { success?: boolean; error?: string; data?: unknown };
      if (!response.ok || payload.success === false) {
        throw new Error(payload.error || `${TOOL_NAMES.privateReply} failed with ${response.status}`);
      }
      await this.recordPresenceAssistantAction(queueMessage);
      return {
        message_type: 'private',
        target_user_id: userId,
        sent_messages: messages,
        xiaoni_os: xiaoniOs,
        pending_share: pendingShare,
        delivery: payload.data || null
      };
    }

    const normalizedMessages = normalizeMessages(sanitizedArgs);
    let groupId: number | null = null;
    try {
      groupId = resolveOptionalToolTargetId(sanitizedArgs, 'group_id', 'target_group_id');
    } catch (error) {
      return buildRetryableSendToolError('group', TOOL_NAMES.groupReply, sanitizedArgs, {
        errorCode: 'invalid_group_id',
        message: error instanceof Error ? error.message : String(error),
        requiredArguments: ['group_id']
      });
    }
    if (groupId === null) {
      return buildRetryableSendToolError('group', TOOL_NAMES.groupReply, sanitizedArgs, {
        errorCode: 'missing_group_id',
        message: `${TOOL_NAMES.groupReply} requires explicit group_id.`,
        requiredArguments: ['group_id']
      });
    }
    const plannedDelivery = {
      messages: normalizedMessages,
      mentionUserIds: normalizeOptionalIntegerList(sanitizedArgs.mention_user_ids),
      secondBeatSuppressed: false
    };
    if (plannedDelivery.messages.length === 0) {
      return buildRetryableSendToolError('group', TOOL_NAMES.groupReply, sanitizedArgs, {
        errorCode: 'missing_message',
        message: `${TOOL_NAMES.groupReply} requires message or messages.`,
        requiredArguments: ['message or messages']
      });
    }

    let selectedMessages = plannedDelivery.messages;
    let selectedMentionUserIds = plannedDelivery.mentionUserIds;

    const response = await fetch(`${agentConfig.providerServiceUrl}/api/internal/send_group`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        session_key: `qq:group:${groupId}`,
        group_id: groupId,
        messages: selectedMessages,
        mention_user_ids: selectedMentionUserIds
      })
    });
    const payload = await response.json() as { success?: boolean; error?: string; data?: unknown };
    if (!response.ok || payload.success === false) {
      throw new Error(payload.error || `${TOOL_NAMES.groupReply} failed with ${response.status}`);
    }
    const currentGroupId = queueMessage.chatType === 'group'
      ? Number(queueMessage.inboundContext.NativeChannelId || queueMessage.peerId)
      : null;
    const presenceQueueMessage = queueMessage.chatType === 'group'
      && typeof currentGroupId === 'number'
      && Number.isFinite(currentGroupId)
      && Math.trunc(currentGroupId) === groupId
      ? queueMessage
      : {
          ...queueMessage,
          chatType: 'group' as const,
          sessionKey: `qq:group:${groupId}`,
          peerId: String(groupId),
          peerName: undefined
        };
    await this.recordPresenceAssistantAction(presenceQueueMessage);
    return {
      message_type: 'group',
      target_group_id: groupId,
      mention_user_ids: selectedMentionUserIds,
      sent_messages: selectedMessages,
      xiaoni_os: xiaoniOs,
      pending_share: pendingShare,
      second_beat_suppressed: plannedDelivery.secondBeatSuppressed,
      delivery: payload.data || null
    };
  }

  private async recordPresenceAssistantAction(queueMessage: QueueMessageRecord['payload']) {
    const recorder = (this.store as RuntimeStore & {
      recordPresenceAssistantAction?: RuntimeStore['recordPresenceAssistantAction'];
    }).recordPresenceAssistantAction;
    if (typeof recorder !== 'function') {
      return;
    }
    await recorder.call(this.store, queueMessage).catch((error) => {
      moduleLogger.warn('Failed to record presence assistant-action anchor', {
        traceId: queueMessage.traceId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private async recordVisibleDeliveryLifeEvents(
    queueMessage: QueueMessageRecord['payload'],
    runId: string,
    toolName: string,
    toolResult: Record<string, unknown>,
    forced = false
  ) {
    const recorder = (this.store as RuntimeStore & {
      recordVisibleDeliveryLifeEvents?: RuntimeStore['recordVisibleDeliveryLifeEvents'];
    }).recordVisibleDeliveryLifeEvents;
    if (typeof recorder !== 'function') {
      return;
    }
    await recorder.call(this.store, {
      queueMessage,
      runId,
      toolName,
      toolResult,
      forced
    }).catch((error) => {
      moduleLogger.warn('Failed to record visible delivery life events', {
        traceId: queueMessage.traceId,
        runId,
        toolName,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private async recordNoVisibleDeliveryLifeEvent(
    queueMessage: QueueMessageRecord['payload'],
    runId: string,
    outcome: string,
    leaseRelease: LeaseReleaseRecord,
    modelRequestSlices: number,
    conversationId: number | null
  ) {
    const recorder = (this.store as RuntimeStore & {
      recordNoVisibleDeliveryLifeEvent?: RuntimeStore['recordNoVisibleDeliveryLifeEvent'];
    }).recordNoVisibleDeliveryLifeEvent;
    if (typeof recorder !== 'function') {
      return;
    }
    await recorder.call(this.store, {
      queueMessage,
      runId,
      traceId: queueMessage.traceId,
      outcome,
      presenceOutcome: outcome,
      leaseRelease: {
        reason: leaseRelease.reason,
        detail: leaseRelease.detail,
        outcome: leaseRelease.outcome,
        noVisibleDelivery: leaseRelease.no_visible_delivery
      },
      modelRequestSlices,
      conversationId
    }).catch((error) => {
      moduleLogger.warn('Failed to record no-visible-delivery life event', {
        traceId: queueMessage.traceId,
        runId,
        outcome,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
}

function applyReadCutoffAfterConversationId(history: ConversationTurn[], readCutoffAfterConversationId: number | null | undefined) {
  if (typeof readCutoffAfterConversationId !== 'number' || !Number.isFinite(readCutoffAfterConversationId)) {
    return history.slice();
  }
  return history.filter((turn) => turn.id > readCutoffAfterConversationId);
}

function applyReadCutoff(history: ConversationTurn[], cutoffState: SessionReadCutoffState | null) {
  return applyReadCutoffAfterConversationId(history, cutoffState?.readCutoffAfterConversationId);
}

function isTransientProviderExecutionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /terminated|fetch failed|network|timeout|timed out|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR|server_is_overloaded|service_unavailable_error|currently overloaded/i.test(message);
}

function computeProviderExecutionRetryDelayMs(attempt: number) {
  const baseDelayMs = Math.max(0, agentConfig.providerExecutionRetryBaseDelayMs || 0);
  const multiplier = Math.max(1, Math.trunc(attempt));
  return baseDelayMs * multiplier;
}

function computeTransientQueueRetryDelayMs(attempts: number) {
  const baseDelayMs = Math.max(0, agentConfig.queueTransientRetryBaseDelayMs || 0);
  const maxDelayMs = Math.max(baseDelayMs, agentConfig.queueTransientRetryMaxDelayMs || baseDelayMs);
  const exponent = Math.max(0, Math.trunc(attempts) - 1);
  return Math.min(maxDelayMs, baseDelayMs * Math.pow(3, exponent));
}

function isPhoneNotificationPayload(queueMessage: QueueMessageRecord['payload']) {
  return queueMessage.source === 'phone_notification'
    || Boolean(queueMessage.phoneNotification)
    || queueMessage.inboundContext?.Surface === 'phone_notification';
}

function isImageTaskNotificationPayload(queueMessage: QueueMessageRecord['payload']) {
  return queueMessage.source === 'image_task_notification'
    || Boolean(queueMessage.imageTaskNotification)
    || queueMessage.inboundContext?.Surface === 'image_task_notification';
}

function isSystemReminderPayload(queueMessage: QueueMessageRecord['payload']) {
  if (isDeletedFinalAnswerReminderPayload(queueMessage)) {
    return false;
  }
  return queueMessage.source === 'system_reminder'
    || Boolean(queueMessage.systemReminder)
    || queueMessage.inboundContext?.Surface === 'system_reminder';
}

function isDeletedFinalAnswerReminderPayload(queueMessage: QueueMessageRecord['payload']) {
  const source = queueMessage.source === 'system_reminder'
    || Boolean(queueMessage.systemReminder)
    || queueMessage.inboundContext?.Surface === 'system_reminder';
  if (!source) {
    return false;
  }
  const reason = queueMessage.systemReminder?.reason || queueMessage.rawPayload?.reason;
  return reason === 'final_answer_idle' || reason === 'final_answer_turn_control';
}

function isSubconsciousAgentNotifyPayload(queueMessage: QueueMessageRecord['payload']) {
  if (!isSystemReminderPayload(queueMessage)) {
    return false;
  }
  const reason = queueMessage.systemReminder?.reason || queueMessage.rawPayload?.reason;
  const notifyTemplate = queueMessage.rawPayload?.notify_template;
  return reason === 'subconscious_agent'
    && notifyTemplate === 'subconscious_agent_notify.md';
}

function isPromptFacingRuntimeReminderPayload(queueMessage: QueueMessageRecord['payload']) {
  return isPhoneNotificationPayload(queueMessage)
    || isImageTaskNotificationPayload(queueMessage)
    || isSystemReminderPayload(queueMessage);
}

function buildLoopRequestInput(params: {
  history: ConversationTurn[];
  queueMessage: QueueMessageRecord['payload'];
  runtimePrompt: ResolvedAgentRuntimePrompt;
  loopContinuation: OpenResponseInputItem[];
  runtimeIdentityFacts?: RuntimeIdentityFactProjection[];
  contextSummary?: string | null;
  pendingProactiveShare?: string | null;
  developerContextBlock?: string | null;
  runtimeEnergyState?: RuntimeEnergyState | null;
  triggerInputMode?: RuntimeTriggerInputMode;
  appendSelfContinuationOnTerminalFinalAnswer?: boolean;
  appendedSelfContinuationInputItems?: OpenResponseInputItem[];
  loopContinuationBeforeCurrentTrigger?: boolean;
  cacheAnchorAfterConversationId?: number | null;
  // When provided, the fresh_trigger current-turn items reuse this exact array
  // instead of rebuilding, so the sent request and the 存档 stay byte-identical.
  precomputedCurrentTurnInputItems?: OpenResponseInputItem[];
}) {
  if (params.loopContinuationBeforeCurrentTrigger) {
    return buildInitialInput(params.history, params.queueMessage, params.runtimePrompt, params.runtimeIdentityFacts || [], params.contextSummary ?? null, params.pendingProactiveShare ?? null, params.developerContextBlock ?? null, params.triggerInputMode ?? 'fresh_trigger', params.appendSelfContinuationOnTerminalFinalAnswer ?? false, params.runtimeEnergyState ?? null, params.appendedSelfContinuationInputItems ?? null, params.loopContinuation, params.cacheAnchorAfterConversationId ?? null, params.precomputedCurrentTurnInputItems ?? null);
  }
  return [
    ...buildInitialInput(params.history, params.queueMessage, params.runtimePrompt, params.runtimeIdentityFacts || [], params.contextSummary ?? null, params.pendingProactiveShare ?? null, params.developerContextBlock ?? null, params.triggerInputMode ?? 'fresh_trigger', params.appendSelfContinuationOnTerminalFinalAnswer ?? false, params.runtimeEnergyState ?? null, params.appendedSelfContinuationInputItems ?? null, [], params.cacheAnchorAfterConversationId ?? null, params.precomputedCurrentTurnInputItems ?? null),
    ...params.loopContinuation
  ];
}

// Tokenizer calibration. The local pre-estimate (token_count.py) uses tiktoken
// o200k_base, which is NOT Claude's tokenizer. After each main turn we calibrate
// from the real input_tokens the provider returned, and scale the effective
// context window so the compression trigger matches the model's actual token
// accounting. The uncompressed history is always re-estimated fresh each turn
// (planReadCutoffFromFirstOverflow recomputes it), so only the calibration
// factor is carried across turns. EMA-smoothed + clamped to avoid jitter.
const tokenizerCalibrationBySession = new Map<string, number>();
const TOKENIZER_CALIBRATION_MIN = 0.5;
const TOKENIZER_CALIBRATION_MAX = 2.0;
// tiktoken o200k_base undercounts Claude's tokenizer; Anthropic guidance is a
// ~1.2-1.25 expansion factor. Seed the calibration with this so the FIRST turn
// already accounts for it, before self-calibration (from real input_tokens) refines.
const CLAUDE_TIKTOKEN_EXPANSION = 1.2;

function defaultCalibrationForModel(modelName?: string): number {
  const normalized = typeof modelName === 'string' ? modelName.trim().toLowerCase() : '';
  return normalized.startsWith('claude') || normalized.includes('claude-') ? CLAUDE_TIKTOKEN_EXPANSION : 1;
}

function getTokenizerCalibration(sessionKey: string): number {
  const value = tokenizerCalibrationBySession.get(sessionKey);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}

function updateTokenizerCalibration(
  sessionKey: string,
  actualInputTokens: number | null,
  estimatedInputTokens: number | null
): void {
  if (!actualInputTokens || !estimatedInputTokens || actualInputTokens <= 0 || estimatedInputTokens <= 0) {
    return;
  }
  const observed = actualInputTokens / estimatedInputTokens;
  const previous = getTokenizerCalibration(sessionKey);
  const blended = previous * 0.5 + observed * 0.5;
  const clamped = Math.min(TOKENIZER_CALIBRATION_MAX, Math.max(TOKENIZER_CALIBRATION_MIN, blended));
  tokenizerCalibrationBySession.set(sessionKey, clamped);
}

async function estimateLoopInputTokens(params: {
  modelName: string;
  queueMessage: QueueMessageRecord['payload'];
  loopInput: OpenResponseInputItem[];
}) {
  const canonicalRequest = buildCanonicalAgentTurnRequest(
    params.modelName,
    params.loopInput,
    params.queueMessage.chatType
  );
  return estimateRequestTokens({
    model: params.modelName,
    request: canonicalRequest
  });
}

async function planReadCutoffFromFirstOverflow(params: {
  history: ConversationTurn[];
  queueMessage: QueueMessageRecord['payload'];
  runtimePrompt: ResolvedAgentRuntimePrompt;
  loopContinuation: OpenResponseInputItem[];
  contextWindowTokens: number;
  runtimeIdentityFacts: RuntimeIdentityFactProjection[];
  contextSummary?: string | null;
  pendingProactiveShare?: string | null;
  developerContextBlock?: string | null;
  runtimeEnergyState?: RuntimeEnergyState | null;
  triggerInputMode?: RuntimeTriggerInputMode;
  appendSelfContinuationOnTerminalFinalAnswer?: boolean;
  loopContinuationBeforeCurrentTrigger?: boolean;
}) {
  if (params.history.length === 0) {
    return null;
  }

  const estimatePrefix = async (prefixLength: number) => estimateLoopInputTokens({
    modelName: params.runtimePrompt.modelName,
    queueMessage: params.queueMessage,
    loopInput: buildLoopRequestInput({
      history: params.history.slice(0, prefixLength),
      queueMessage: params.queueMessage,
      runtimePrompt: params.runtimePrompt,
      loopContinuation: params.loopContinuation,
      runtimeIdentityFacts: params.runtimeIdentityFacts,
      contextSummary: params.contextSummary,
      pendingProactiveShare: params.pendingProactiveShare,
      developerContextBlock: params.developerContextBlock,
      runtimeEnergyState: params.runtimeEnergyState ?? null,
      triggerInputMode: params.triggerInputMode ?? 'fresh_trigger',
      appendSelfContinuationOnTerminalFinalAnswer: params.appendSelfContinuationOnTerminalFinalAnswer ?? false
    })
  });

  let low = 1;
  let high = params.history.length;
  let firstOverflowPrefixLength: number | null = null;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const estimate = await estimatePrefix(midpoint);
    if (estimate.inputTokens > params.contextWindowTokens) {
      firstOverflowPrefixLength = midpoint;
      high = midpoint - 1;
    } else {
      low = midpoint + 1;
    }
  }

  if (firstOverflowPrefixLength === null) {
    return null;
  }

  const sourceLength = Math.max(1, firstOverflowPrefixLength - 1);
  const summarySourceHistory = params.history.slice(0, sourceLength);
  const sourceEnd = summarySourceHistory[summarySourceHistory.length - 1];
  if (!sourceEnd) {
    return null;
  }
  const overlapCount = Math.min(HISTORY_COMPACT_KEEP, Math.max(0, summarySourceHistory.length - 1));
  const readCutoffIndex = Math.max(0, summarySourceHistory.length - overlapCount - 1);
  const readCutoffAfterConversationId = summarySourceHistory[readCutoffIndex]?.id ?? sourceEnd.id;

  return {
    firstOverflowPrefixLength,
    summarySourceHistory,
    readCutoffAfterConversationId,
    compressionCoveredEndConversationId: sourceEnd.id,
    overlapCount
  };
}

// Forced/manual compaction cutoff. Unlike planReadCutoffFromFirstOverflow (which
// binary-searches the token-overflow point), this is purely turn-count driven:
// summarize the whole retained window and advance the read cutoff to keep only the
// most recent HISTORY_COMPACT_KEEP turns live. Returns the SAME shape so the
// downstream compression-plan / fork machinery is shared byte-for-byte. Returns
// null when there is nothing strictly before the safety overlap to evict (history
// at or under the keep window) — that is the only true no-op for a manual trigger.
//
//   history (oldest -> newest)
//   [ ............ evicted head ............ | last HISTORY_COMPACT_KEEP turns ]
//                                            ^ readCutoffAfterConversationId
//   summarySourceHistory = whole window (head + overlap, same as the overflow path)
//   compressionCoveredEndConversationId = newest retained turn
function planReadCutoffForForcedCompression(history: ConversationTurn[]) {
  if (history.length <= HISTORY_COMPACT_KEEP) {
    return null;
  }
  const summarySourceHistory = history;
  const sourceEnd = summarySourceHistory[summarySourceHistory.length - 1];
  if (!sourceEnd) {
    return null;
  }
  const overlapCount = Math.min(HISTORY_COMPACT_KEEP, Math.max(0, summarySourceHistory.length - 1));
  const readCutoffIndex = Math.max(0, summarySourceHistory.length - overlapCount - 1);
  const readCutoffAfterConversationId = summarySourceHistory[readCutoffIndex]?.id ?? sourceEnd.id;
  return {
    firstOverflowPrefixLength: summarySourceHistory.length,
    summarySourceHistory,
    readCutoffAfterConversationId,
    compressionCoveredEndConversationId: sourceEnd.id,
    overlapCount
  };
}

function readOptionalNumber(value: unknown) {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildProviderTokenUsage(modelResult: ProviderAgentResponse) {
  return {
    ...(modelResult.usage || {}),
    cached_input_tokens: readOptionalNumber(modelResult.usage_details?.cached_input_tokens) || 0,
    reasoning_tokens: readOptionalNumber(modelResult.usage_details?.reasoning_tokens) || 0,
    raw_usage: modelResult.usage_details?.raw_usage || null
  };
}

function buildProviderWireMetadata(modelResult: ProviderAgentResponse): Record<string, unknown> {
  return {
    wire_request_headers: modelResult.wire_request_headers || null,
    wire_request_url: modelResult.wire_request_url || null,
    wire_response_headers: modelResult.wire_response_headers || null,
    wire_response_status: modelResult.wire_response_status ?? null,
    wire_response_status_text: modelResult.wire_response_status_text || null
  };
}

function attachActualUsageToTurnBudget(
  record: ContextBudgetTurnRecord,
  modelResult: ProviderAgentResponse
) {
  record.actualInputTokens = readOptionalNumber(modelResult.usage?.input_tokens);
  record.actualOutputTokens = readOptionalNumber(modelResult.usage?.output_tokens);
  record.actualTotalTokens = readOptionalNumber(modelResult.usage?.total_tokens);
  record.cachedInputTokens = readOptionalNumber(modelResult.usage_details?.cached_input_tokens);
  record.reasoningTokens = readOptionalNumber(modelResult.usage_details?.reasoning_tokens);
  record.processingTimeMs = readOptionalNumber(modelResult.performance?.processing_time_ms);
  // Calibrate the local tokenizer estimate against the model's real input_tokens
  // for the next turn (keyed by the single global runtime session).
  updateTokenizerCalibration(
    getGlobalPromptContextSessionKey(),
    record.actualInputTokens,
    record.estimatedInputTokens
  );
}

function serializeContextBudgetTurnRecord(record: ContextBudgetTurnRecord) {
  return {
    turn: record.turn,
    estimated_input_tokens: record.estimatedInputTokens,
    actual_input_tokens: record.actualInputTokens,
    actual_output_tokens: record.actualOutputTokens,
    actual_total_tokens: record.actualTotalTokens,
    cached_input_tokens: record.cachedInputTokens,
    reasoning_tokens: record.reasoningTokens,
    processing_time_ms: record.processingTimeMs,
    read_history_count: record.readHistoryCount,
    read_cutoff_after_conversation_id: record.readCutoffAfterConversationId,
    context_window_tokens: record.contextWindowTokens,
    target_budget_tokens: record.targetBudgetTokens,
    hard_budget_tokens: record.hardBudgetTokens,
    tokenizer_encoding: record.tokenizerEncoding,
    tokenizer_source: record.tokenizerSource,
    cutoff_recomputed: record.cutoffRecomputed
  };
}

function extractCanonicalResponseOutputItems(modelResult: ProviderAgentResponse): Array<Record<string, unknown>> {
  const output = Array.isArray(modelResult.canonical_response?.output)
    ? modelResult.canonical_response.output
    : [];
  return output
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map((item) => ({ ...item }));
}

// The subconscious fork is instructed (self_continuation_reminder) to emit its plan
// wrapped in <xiaoni_plan>...</xiaoni_plan>. subconscious_agent_notify.md re-wraps the
// extracted text in <xiaoni_plan>, so without this strip the main loop would receive
// doubly-nested tags (and the model would learn to echo the double wrap). Unwrap the
// single outer wrapper and drop any residual xiaoni_plan tags so the value spliced
// into the notify template stays well-formed and can't inject structure.
function stripSubconsciousPlanWrapper(text: string): string {
  let result = text.trim();
  const wrapped = result.match(/^<xiaoni_plan>\s*([\s\S]*?)\s*<\/xiaoni_plan>$/i);
  if (wrapped) {
    result = wrapped[1]!.trim();
  }
  return result.replace(/<\/?xiaoni_plan>/gi, '').trim();
}

function extractSubconsciousNaturalLanguage(outputItems: Array<Record<string, unknown>>): string | null {
  for (let index = outputItems.length - 1; index >= 0; index -= 1) {
    const item = outputItems[index]!;
    if (item.type !== 'message' || item.role !== 'assistant' || item.phase !== 'final_answer') {
      continue;
    }
    const content = item.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? flattenMessageContent(content as OpenResponseInputContentPart[])
        : typeof item.text === 'string'
          ? item.text
          : '';
    const normalized = stripSubconsciousPlanWrapper(stripRuntimeTextEast8TimePrefix(text).trim());
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function stackKindForModelOutputItem(item: Record<string, unknown>) {
  const type = typeof item.type === 'string' ? item.type : 'assistant_output';
  if (type === 'function_call') {
    return 'function_call';
  }
  if (type === 'function_call_output') {
    return 'function_call_output';
  }
  return 'assistant_output';
}

function stackRoleForModelOutputItem(item: Record<string, unknown>) {
  return typeof item.role === 'string' ? item.role : 'assistant';
}

function stackPhaseForModelOutputItem(item: Record<string, unknown>) {
  return item.phase === 'final_answer' ? 'final_answer' : item.phase === 'commentary' ? 'commentary' : null;
}

function stackToolCallIdForModelOutputItem(item: Record<string, unknown>) {
  return typeof item.call_id === 'string' && item.call_id.trim()
    ? item.call_id.trim()
    : null;
}

function buildModelOutputStackItems(outputItems: Array<Record<string, unknown>>, sliceId: string) {
  return outputItems.map((item, index) => ({
    eventId: `stack:${sliceId}:output:${index}`,
    itemKind: stackKindForModelOutputItem(item),
    role: stackRoleForModelOutputItem(item),
    phase: stackPhaseForModelOutputItem(item),
    providerItemId: typeof item.id === 'string' ? item.id : null,
    toolCallId: stackToolCallIdForModelOutputItem(item),
    llmRequestSliceId: sliceId,
    content: item,
    visibility: 'model_visible',
    metadata: {
      output_item_index: index,
      output_item_type: typeof item.type === 'string' ? item.type : null
    }
  }));
}

function toolResultToFallbackFunctionCallOutput(toolCall: AgentToolCall, toolResult: Record<string, unknown>) {
  return {
    type: 'function_call_output',
    call_id: toolCall.callId,
    output: JSON.stringify(toolResult)
  };
}

function buildToolResultStackItems(params: {
  toolCall: AgentToolCall;
  toolResult: Record<string, unknown>;
  continuationItems?: OpenResponseInputItem[];
  llmRequestSliceId?: string | null;
}) {
  const functionCallOutputs = (params.continuationItems || [])
    .filter((item): item is Extract<OpenResponseInputItem, { type: 'function_call_output' }> => item.type === 'function_call_output');
  const outputItems = functionCallOutputs.length > 0
    ? functionCallOutputs
    : [toolResultToFallbackFunctionCallOutput(params.toolCall, params.toolResult)];

  return outputItems.map((item, index) => ({
    eventId: `stack:${params.llmRequestSliceId || 'slice'}:tool-output:${params.toolCall.callId}:${index}`,
    itemKind: 'function_call_output',
    role: 'tool',
    phase: null,
    toolCallId: item.call_id,
    llmRequestSliceId: params.llmRequestSliceId || null,
    content: item,
    visibility: functionCallOutputs.length > 0 ? 'model_visible' : 'trace_only',
    metadata: {
      output_item_index: index,
      tool_name: params.toolCall.name,
      output_forwarded_to_model: functionCallOutputs.length > 0
    }
  }));
}

function buildRuntimeInputStackItem(params: {
  queueMessage: QueueMessageRecord['payload'];
  runId: string;
  runtimePrompt: Pick<ResolvedAgentRuntimePrompt, 'userPromptTemplate' | 'contextVariables' | 'runtimeVariables'>;
  // The current-turn items already built for the sent request. When provided the
  // 存档 reuses these exact bytes (deep-copied so the persisted snapshot can't
  // share a mutable ref with the live request) instead of rebuilding with a fresh
  // clock. Falls back to a rebuild only for callers that have nothing prebuilt.
  precomputedInputItems?: OpenResponseInputItem[];
}) {
  const currentInputItems = (params.precomputedInputItems
    ? (JSON.parse(JSON.stringify(params.precomputedInputItems)) as OpenResponseInputItem[])
    : buildCurrentTurnInputItems(params.queueMessage, params.runtimePrompt))
    .filter((item) => !isOpenResponseMessageInputItem(item) || flattenMessageContent(item.content).trim().length > 0);
  return {
    eventId: `stack:${params.runId || params.queueMessage.traceId}:runtime-input`,
    itemKind: 'runtime_input',
    role: currentInputItems.some((item) => item.type === 'message' && item.role === 'user') ? 'user' : 'developer',
    phase: null,
    content: {
      source: params.queueMessage.source,
      trace_id: params.queueMessage.traceId,
      run_id: params.runId,
      session_key: params.queueMessage.sessionKey,
      chat_type: params.queueMessage.chatType,
      peer_id: params.queueMessage.peerId,
      peer_name: params.queueMessage.peerName || null,
      input_items: currentInputItems,
      system_reminder: null
    },
    visibility: 'model_visible',
    sourceType: 'agent_queue_messages',
    sourceId: params.runId || null,
    traceId: params.queueMessage.traceId,
    runId: params.runId,
    metadata: {
      queue_source: params.queueMessage.source,
      prompt_facing_runtime_reminder: isPromptFacingRuntimeReminderPayload(params.queueMessage)
    }
  };
}

function buildLoopSelfContinuationStackItem(params: {
  queueMessage: QueueMessageRecord['payload'];
  runId: string;
  turn: number;
  inputItem: OpenResponseInputItem;
}) {
  const reminder = isOpenResponseMessageInputItem(params.inputItem)
    ? flattenMessageContent(params.inputItem.content)
    : renderSelfContinuationReminder();
  return {
    eventId: `stack:${params.runId || params.queueMessage.traceId}:self-continuation:${params.turn}`,
    itemKind: 'runtime_input',
    role: isOpenResponseMessageInputItem(params.inputItem) ? params.inputItem.role : 'user',
    phase: null,
    content: {
      source: 'self_continuation',
      reason: 'final_answer',
      trace_id: params.queueMessage.traceId,
      run_id: params.runId,
      session_key: params.queueMessage.sessionKey,
      chat_type: params.queueMessage.chatType,
      peer_id: params.queueMessage.peerId,
      peer_name: params.queueMessage.peerName || null,
      input_items: [params.inputItem],
      system_reminder: reminder
    },
    visibility: 'model_visible',
    sourceType: 'agent_runtime',
    sourceId: params.runId || null,
    traceId: params.queueMessage.traceId,
    runId: params.runId,
    metadata: {
      queue_source: params.queueMessage.source,
      prompt_facing_runtime_reminder: true,
      triggered_by: 'final_answer'
    }
  };
}

function buildForkInputStackItem(params: {
  forkRunId: string;
  sliceId: string;
  forkTurn: number;
  source: string;
  inputItems: OpenResponseInputItem[];
}) {
  return {
    eventId: `stack:${params.sliceId}:input`,
    itemKind: 'runtime_input',
    role: params.inputItems.some((item) => item.type === 'message' && item.role === 'user') ? 'user' : 'developer',
    phase: null,
    llmRequestSliceId: params.sliceId,
    content: {
      source: params.source,
      fork_run_id: params.forkRunId,
      fork_turn: params.forkTurn,
      input_items: JSON.parse(JSON.stringify(params.inputItems))
    },
    visibility: 'model_visible',
    metadata: {
      fork_run_id: params.forkRunId,
      fork_turn: params.forkTurn,
      input_item_count: params.inputItems.length
    }
  };
}

export function buildInitialInput(
  history: ConversationTurn[],
  queueMessage: QueueMessageRecord['payload'],
  runtimePrompt: Pick<ResolvedAgentRuntimePrompt, 'systemPrompt' | 'userPromptTemplate' | 'contextVariables' | 'runtimeVariables'> = {
    systemPrompt: agentConfig.systemPrompt,
    userPromptTemplate: null,
    contextVariables: {},
    runtimeVariables: {}
  },
  _runtimeIdentityFacts: RuntimeIdentityFactProjection[] = [],
  contextSummary: string | null = null,
  pendingProactiveShare: string | null = null,
  developerContextBlock: string | null = null,
  triggerInputMode: RuntimeTriggerInputMode = 'fresh_trigger',
  appendSelfContinuationOnTerminalFinalAnswer = false,
  runtimeEnergyState: RuntimeEnergyState | null = null,
  appendedSelfContinuationInputItems: OpenResponseInputItem[] | null = null,
  inputItemsBeforeCurrentTurn: OpenResponseInputItem[] = [],
  cacheAnchorAfterConversationId: number | null = null,
  precomputedCurrentTurnInputItems: OpenResponseInputItem[] | null = null
): OpenResponseInputItem[] {
  const developerContextParts = splitDeveloperContextBlock(developerContextBlock);
  const items: OpenResponseInputItem[] = [
    {
      type: 'message',
      role: 'system',
      content: composeSystemPrompt(
        runtimePrompt.systemPrompt,
        queueMessage.chatType
      )
    }
  ];

  items.push(buildDeveloperInputItem([
    buildSkillsInstructions(),
    buildCapabilitiesDeveloperBlock().block
  ].filter((part): part is string => Boolean(part))));

  if (contextSummary) {
    items.push(buildDeveloperInputItem([`<小腻近况>\n${contextSummary}\n</小腻近况>`]));
  }

  // Pin a cache breakpoint on the last block this turn renders, when it is the
  // compression head boundary (H_X). The provider keeps [..H_X] warm every turn so a
  // compression fork reading exactly the head reuses it instead of cold-prefilling.
  // The marker is a non-content field (does not change the rendered text), so the
  // prefix stays byte-identical to the fork's head and they share the same entry.
  const markAnchorIfBoundary = (turnId: unknown) => {
    if (
      cacheAnchorAfterConversationId === null
      || typeof turnId !== 'number'
      || turnId !== cacheAnchorAfterConversationId
      || items.length === 0
    ) {
      return;
    }
    const lastIdx = items.length - 1;
    items[lastIdx] = {
      ...(items[lastIdx] as Record<string, unknown>),
      cache_anchor: true
    } as unknown as OpenResponseInputItem;
  };

  for (const [turnIndex, turn] of history.entries()) {
    const replayItems = buildTurnResponseReplayItems(turn);
    const appendKnownReplayItems = () => {
      items.push(...replayItems);
      if (
        appendSelfContinuationOnTerminalFinalAnswer
        && turnIndex === history.length - 1
        && isAssistantFinalAnswerInputItem(replayItems[replayItems.length - 1])
      ) {
        const selfContinuationInputItem = buildSelfContinuationInputItem();
        items.push(selfContinuationInputItem);
        appendedSelfContinuationInputItems?.push(selfContinuationInputItem);
      }
    };
    const transcriptItems = Array.isArray(turn.items) && turn.items.length > 0
      ? turn.items
      : [];

    if (transcriptItems.length === 0) {
      appendKnownReplayItems();
      markAnchorIfBoundary((turn as { id?: unknown }).id);
      continue;
    }

    for (const transcriptItem of transcriptItems) {
      const rendered = renderTranscriptItemForRuntimeContext(transcriptItem);
      if (rendered) {
        items.push(rendered);
      }
    }

    appendKnownReplayItems();
    markAnchorIfBoundary((turn as { id?: unknown }).id);
  }

  items.push(...inputItemsBeforeCurrentTurn);

  if (triggerInputMode === 'fresh_trigger') {
    items.push(...(precomputedCurrentTurnInputItems ?? buildCurrentTurnInputItems(queueMessage, runtimePrompt)));
  }
  if (developerContextParts.dynamicContext) {
    items.push({
      type: 'message',
      role: 'developer',
      content: developerContextParts.dynamicContext
    });
  }
  return items;
}

function splitDeveloperContextBlock(developerContextBlock: string | null | undefined) {
  const block = developerContextBlock
    ?.replace(/<current_relationship>[\s\S]*?<\/current_relationship>/g, '')
    .trim();
  if (!block) {
    return {
      dynamicContext: null,
      capabilityRefresh: false
    };
  }

  const capabilityRefresh = /<capability_refresh\b/i.test(block)
    || /<CAPABILITY_REFRESH\b/.test(block);
  const dynamicContext = block;

  return {
    dynamicContext: dynamicContext || null,
    capabilityRefresh
  };
}

function normalizeResponseInputItems(items: OpenResponseInputItem[]): OpenResponseInputItem[] {
  return items
    .map(normalizeReplayInputItem)
    .filter((item): item is OpenResponseInputItem => Boolean(item));
}

type ResponseReplayInputItem = OpenResponseInputItem;

function normalizeReplayInputItem(item: unknown): ResponseReplayInputItem | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return null;
  }
  const type = (item as { type?: unknown }).type;
  if (typeof type !== 'string' || !type.trim()) {
    return null;
  }
  return JSON.parse(JSON.stringify(item)) as ResponseReplayInputItem;
}

function stackRowContentAsReplayInputItems(row: Record<string, unknown>): unknown[] {
  if (row.visibility !== 'model_visible') {
    return [];
  }
  const content = row.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return [];
  }
  const inputItems = (content as { input_items?: unknown }).input_items;
  if (Array.isArray(inputItems)) {
    return inputItems;
  }
  return [content];
}

function groupStackRowsByConversationId(rows: Array<Record<string, unknown>>) {
  const grouped = new Map<number, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const rawConversationId = row.conversationId ?? row.conversation_id;
    const conversationId = typeof rawConversationId === 'number'
      ? rawConversationId
      : Number(rawConversationId);
    if (!Number.isFinite(conversationId)) {
      continue;
    }
    const key = Math.trunc(conversationId);
    const bucket = grouped.get(key) || [];
    bucket.push(row);
    grouped.set(key, bucket);
  }
  return grouped;
}

function extractResponseReplayInputItemsFromStackRows(rows: Array<Record<string, unknown>>): ResponseReplayInputItem[] {
  return extractResponseReplayInputItems(rows.flatMap(stackRowContentAsReplayInputItems) as OpenResponseInputItem[]);
}

function extractResponseReplayInputItems(items: OpenResponseInputItem[]): ResponseReplayInputItem[] {
  return items
    .map(normalizeReplayInputItem)
    .filter((item): item is ResponseReplayInputItem => Boolean(item));
}

function buildTurnResponseReplayItems(turn: StackBackedConversationTurn): OpenResponseInputItem[] {
  return extractResponseReplayInputItems(turn.stackReplayItems || []);
}

function buildCurrentTurnInputItems(
  queueMessage: QueueMessageRecord['payload'],
  runtimePrompt: Pick<ResolvedAgentRuntimePrompt, 'userPromptTemplate' | 'contextVariables' | 'runtimeVariables'>
): OpenResponseInputItem[] {
  if (isDeletedFinalAnswerReminderPayload(queueMessage)) {
    return [];
  }
  const currentMessages = buildCurrentBucketMessageParts(queueMessage);
  if (currentMessages.every((message) => !message.trim())) {
    return [];
  }
  let userPromptTemplate: string | null = null;
  if (typeof runtimePrompt.userPromptTemplate === 'string' && runtimePrompt.userPromptTemplate.trim()) {
    userPromptTemplate = runtimePrompt.userPromptTemplate;
  }
  const renderedMessages = userPromptTemplate
    ? currentMessages.map((message) => applyPromptTemplate(userPromptTemplate, runtimePrompt.contextVariables, {
        ...runtimePrompt.runtimeVariables,
        user_input: message
      }))
    : currentMessages;

  const parts = renderedMessages.filter((message) => message.trim());
  if (parts.length === 0) {
    return [];
  }
  const triggerItem = isSubconsciousAgentNotifyPayload(queueMessage)
    ? buildUserSceneInputItem(parts)
    : buildDeveloperInputItem(parts);
  // The current-turn trigger carries a fresh [当前时间] stamp every build, so the cache
  // breakpoint must NOT anchor on it: anchoring on a per-turn-varying block drifts the
  // whole cached body at every run/heartbeat boundary (the breakpoint block's bytes
  // change, so heartbeat-warmed and main-loop prefixes diverge at the tail). Tag it
  // cache_volatile so the provider's isDurableItem skips it and anchors the breakpoint on
  // the last FROZEN (replayed) message instead — the cached prefix then stays byte-
  // identical across the live build, the persisted replay, and the heartbeat fork. The
  // tag is internal (provider never forwards it to the wire). A developer-role trigger is
  // already non-durable, so the tag is a harmless no-op there.
  return [{ ...(triggerItem as Record<string, unknown>), cache_volatile: true } as unknown as OpenResponseInputItem];
}

function renderConversationInput(queueMessage: QueueMessageRecord['payload']) {
  if (isPhoneNotificationPayload(queueMessage)) {
    return renderPhoneNotification(queueMessage);
  }
  if (isImageTaskNotificationPayload(queueMessage)) {
    return renderImageTaskNotification(queueMessage);
  }
  if (isSystemReminderPayload(queueMessage)) {
    return renderSystemReminder(queueMessage);
  }
  return queueMessage.messages
    .map((message, index) => renderTranscriptBatchMessage(message, index))
    .join('\n');
}

function renderConversationStorageUserMessage(queueMessage: QueueMessageRecord['payload']) {
  return isPromptFacingRuntimeReminderPayload(queueMessage)
    ? ''
    : renderConversationInput(queueMessage);
}

function classifyRuntimeStreamInput(queueMessage: QueueMessageRecord['payload']) {
  if (isPhoneNotificationPayload(queueMessage)) {
    return 'sensory_event';
  }
  if (isImageTaskNotificationPayload(queueMessage)) {
    return 'sensory_event';
  }
  if (isSystemReminderPayload(queueMessage)) {
    return 'sensory_event';
  }
  return 'inbound_batch';
}

function buildRuntimeStreamMetadata(
  queueMessage: QueueMessageRecord['payload'],
  params: {
    contextSessionKey: string;
    responseReplayItemCount: number;
    turnsExecuted: number;
  }
) {
  return {
    stream_key: getGlobalPromptContextSessionKey(),
    context_session_key: params.contextSessionKey,
    trigger_source: queueMessage.source,
    trigger_kind: classifyRuntimeStreamInput(queueMessage),
    sensory_input: isPhoneNotificationPayload(queueMessage)
      || isImageTaskNotificationPayload(queueMessage)
      || isSystemReminderPayload(queueMessage),
    append_strategy: 'responses_replay_items',
    response_replay_item_count: params.responseReplayItemCount,
    model_request_slices: params.turnsExecuted
  };
}

function resolveOptionalToolTargetId(args: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (!(key in args)) {
      continue;
    }
    const numeric = Number(args[key]);
    if (!Number.isFinite(numeric)) {
      throw new Error(`Invalid target id in tool argument ${key}: ${String(args[key])}`);
    }
    return Math.trunc(numeric);
  }
  return null;
}

function resolvePrivateTargetUserId(queueMessage: QueueMessageRecord['payload'], args: Record<string, unknown> = {}) {
  const explicitUserId = resolveOptionalToolTargetId(args, 'user_id', 'target_user_id');
  const userId = explicitUserId
    ?? parseOptionalInteger(queueMessage.senderId)
    ?? parseOptionalInteger(queueMessage.peerId)
    ?? parseOptionalInteger(queueMessage.inboundContext.NativeChannelId);
  if (!Number.isFinite(userId)) {
    throw new Error(`Invalid private target in queue payload: sender=${queueMessage.senderId || 'unknown'}, peer=${queueMessage.peerId || 'unknown'}`);
  }
  return userId;
}

function resolveGroupTargetId(queueMessage: QueueMessageRecord['payload'], args: Record<string, unknown> = {}) {
  const explicitGroupId = resolveOptionalToolTargetId(args, 'group_id', 'target_group_id');
  if (explicitGroupId === null && queueMessage.chatType !== 'group') {
    throw new Error('Cannot derive a default group target from a non-group queue payload');
  }
  const groupId = explicitGroupId ?? Number(queueMessage.inboundContext.NativeChannelId || queueMessage.peerId);
  if (!Number.isFinite(groupId)) {
    throw new Error(
      `Invalid group target in queue payload: ${queueMessage.inboundContext.NativeChannelId || queueMessage.peerId || 'unknown'}`
    );
  }
  return groupId;
}

function buildRetryableSendToolError(
  messageType: 'private' | 'group',
  toolName: string,
  args: Record<string, unknown>,
  error: {
    errorCode: string;
    message: string;
    requiredArguments: string[];
  }
) {
  const xiaoniOs = typeof args.xiaoni_os === 'string' && args.xiaoni_os.trim()
    ? args.xiaoni_os.trim()
    : null;
  const pendingShare = typeof args.pending_share === 'string' && args.pending_share.trim()
    ? args.pending_share.trim()
    : null;

  return {
    tool_error: true,
    retryable: true,
    tool_name: toolName,
    message_type: messageType,
    error_code: error.errorCode,
    error_message: error.message,
    required_arguments: error.requiredArguments,
    received_arguments: Object.keys(args),
    sent_messages: [],
    xiaoni_os: xiaoniOs,
    pending_share: pendingShare
  };
}

function buildInternalExplicitSendTargetArgs(messageType: 'private' | 'group', queueMessage: QueueMessageRecord['payload']) {
  return messageType === 'private'
    ? { user_id: resolvePrivateTargetUserId(queueMessage) }
    : { group_id: resolveGroupTargetId(queueMessage) };
}

function resolveSessionTargets(queueMessage: QueueMessageRecord['payload']) {
  const userId = parseOptionalInteger(queueMessage.senderId)
    ?? parseOptionalInteger(queueMessage.accountId)
    ?? parseOptionalInteger(agentConfig.botAccountId)
    ?? 1129974489;
  const groupId = queueMessage.chatType === 'group'
    ? parseOptionalInteger(queueMessage.inboundContext.NativeChannelId || queueMessage.peerId)
    : null;

  return {
    userId,
    groupId: groupId !== null && Number.isFinite(groupId) ? groupId : null
  };
}

function normalizeExecEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key) || entry === null || typeof entry === 'undefined') {
      continue;
    }
    env[key] = String(entry);
  }
  return env;
}

function buildExecCommandRuntimeEnv(
  toolCall?: AgentToolCall,
  queueMessage?: QueueMessageRecord['payload']
): Record<string, string> {
  const env: Record<string, string> = {};
  if (queueMessage?.traceId) {
    env.XIAONI_TRACE_ID = queueMessage.traceId;
  }
  if (queueMessage?.runId) {
    env.XIAONI_RUN_ID = queueMessage.runId;
  }
  if (queueMessage?.batchId) {
    env.XIAONI_BATCH_ID = queueMessage.batchId;
  }
  if (queueMessage?.sessionKey) {
    env.XIAONI_SESSION_KEY = queueMessage.sessionKey;
  }
  if (toolCall?.callId) {
    env.XIAONI_TOOL_CALL_ID = toolCall.callId;
  }
  if (toolCall?.name) {
    env.XIAONI_TOOL_NAME = toolCall.name;
  }
  return env;
}

function normalizeMessages(args: Record<string, unknown>) {
  if (Array.isArray(args.messages)) {
    const messages: string[] = [];
    for (const item of args.messages) {
      if (typeof item !== 'string' || !item.trim()) {
        throw new Error('messages must be an array of non-empty strings');
      }
      messages.push(sanitizeLowValueOpeningFiller(item));
    }
    if (messages.length > 0) {
      return messages;
    }
  }

  if (typeof args.message === 'string' && args.message.trim()) {
    return [sanitizeLowValueOpeningFiller(args.message)];
  }

  return [];
}

export function sanitizeLowValueOpeningFiller(message: string) {
  const original = message.trim();
  let cleaned = original;
  let changed = false;

  while (cleaned.length > 0) {
    const before = cleaned;
    cleaned = cleaned
      .replace(/^\s+/, '')
      .replace(/^哈{2,}/, '')
      .replace(/^确实(?:是这样)?/, '')
      .replace(/^[\s,，。！？!?、~～…:：;；]+/, '');
    changed = changed || cleaned !== before;
    if (cleaned === before) {
      break;
    }
  }

  const finalMessage = cleaned.trim();
  return changed && finalMessage.length > 0 ? finalMessage : original;
}

function normalizeOptionalIntegerList(value: unknown) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error('mention_user_ids must be an array of integers');
  }

  return Array.from(new Set(value.map((item) => {
    const numeric = Number(item);
    if (!Number.isFinite(numeric)) {
      throw new Error('mention_user_ids must be an array of integers');
    }
    return Math.trunc(numeric);
  })));
}

function extractSentMessages(toolResult: Record<string, unknown>) {
  if (!Array.isArray(toolResult.sent_messages)) {
    return [];
  }

  return toolResult.sent_messages.filter((item): item is string => typeof item === 'string' && item.length > 0);
}
