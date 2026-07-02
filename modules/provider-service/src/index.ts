import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import {
  ensureAgentMediaSchema,
  ensureIdentityLineageSchema,
  maybeCreateQqAttentionReminder,
  markQqAttentionReminderQueued,
  ensureSelfEvolutionSchema,
  ensureTopicLabSchema,
  upsertAgentMediaAssets,
} from '@qq-bot/persistence';
import { aiConfig, inboundLivenessConfig, selfEvolutionConfig, serverConfig } from './config';
import { evaluateInboundLiveness } from './services/inbound-liveness';
import EmbeddingService from './services/embedding-service';
import { executeAgentRequest, executeDebugRequest } from './services/provider-debug-service';
import { NapcatClient } from './services/napcat-client';
import { NapcatWebuiClient, formatNapcatWebuiError, NapcatWebuiLoginStatus } from './services/napcat-webui-client';
import { ChatPolicyService } from './services/chat-policy-service';
import {
  buildNapcatInboundContext,
  OneBotMessageEvent,
  RecentMessageCache,
  rememberInboundContext,
} from './services/agent-im-input-adapter';
import { InboundInboxService } from './services/inbound-inbox-service';
import RelationshipLedgerService from './services/relationship-ledger-service';
import SelfEvolutionExecutorService from './services/self-evolution-executor-service';
import { SelfEvolutionService } from './services/self-evolution-service';
import TopicReviewMaterializationService from './services/topic-review-materialization-service';
import { GroupParticipationService } from './services/group-participation-service';
import { ImagePromptAssistantService, ImageProviderError, OpenAIImageProvider } from './services/image-provider';
import {
  buildSimpleQueueSimulationContext,
  type ProviderMessageType,
  type SimpleQueueSimulationPayload,
} from './services/simple-queue-simulation-context';
import { FinalizedInboundContext, InboxMessageRecord, InboundMediaAsset, SemanticInboundMessage } from './types';
import { runtimeStoreService } from './services/runtime-store-service';
import {
  applyForcedInboundAgentQueuePolicy,
  decideInboundAgentQueueTrigger,
  processInboundAgentQueueTrigger
} from './services/inbound-agent-trigger-service';
import {
  resolveInternalGroupSendRequest,
  resolveInternalPrivateSendRequest
} from './services/outbound-send-contract';
import { logger } from './utils/logger';

const app = express();
const moduleLogger = logger.createModuleLogger('provider-service');
const RUNTIME_ASSET_ROOT = process.env.PROVIDER_RUNTIME_ASSET_ROOT || '/app/logs/runtime-assets';
const RUNTIME_ASSET_BASE_URL = (process.env.PROVIDER_RUNTIME_ASSET_BASE_URL || `http://qqbot-provider-service:${serverConfig.port}`).replace(/\/$/, '');
const XIAONI_RUNTIME_ROOT = (process.env.XIAONI_RUNTIME_ROOT || '/xiaoni-runtime').replace(/\/+$/, '');
const INBOUND_MEDIA_ASSET_ROOT = path.join(XIAONI_RUNTIME_ROOT, 'media', 'inbound').replace(/\/+$/, '');
const LOCAL_RUNTIME_PICTURE_ROOT = path.join(XIAONI_RUNTIME_ROOT, 'picture').replace(/\/+$/, '');
const INBOUND_MEDIA_ASSET_BASE_URL = (process.env.PROVIDER_INBOUND_MEDIA_ASSET_BASE_URL || `http://qqbot-provider-service:${serverConfig.port}`).replace(/\/$/, '');
const inboundMediaMaxBytes = Number(process.env.PROVIDER_INBOUND_MEDIA_MAX_BYTES || 25 * 1024 * 1024);
const INBOUND_MEDIA_MAX_BYTES = Number.isFinite(inboundMediaMaxBytes) && inboundMediaMaxBytes > 0
  ? inboundMediaMaxBytes
  : 25 * 1024 * 1024;
const inboundMediaFetchTimeoutMs = Number(process.env.PROVIDER_INBOUND_MEDIA_FETCH_TIMEOUT_MS || 10_000);
const INBOUND_MEDIA_FETCH_TIMEOUT_MS = Number.isFinite(inboundMediaFetchTimeoutMs) && inboundMediaFetchTimeoutMs > 0
  ? inboundMediaFetchTimeoutMs
  : 10_000;
const groupNotificationAggregationFlushInterval = Number(process.env.QQ_GROUP_NOTIFICATION_AGGREGATION_FLUSH_INTERVAL_MS || 1000);
const GROUP_NOTIFICATION_AGGREGATION_FLUSH_INTERVAL_MS = Number.isFinite(groupNotificationAggregationFlushInterval) && groupNotificationAggregationFlushInterval > 0
  ? groupNotificationAggregationFlushInterval
  : 1000;
const NAPCAT_QQ_DATA_ROOT = process.env.NAPCAT_QQ_DATA_ROOT || '/app/napcat-qq-data';
const NAPCAT_QQ_CONTAINER_ROOT = '/app/.config/QQ';
const embeddingService = new EmbeddingService(aiConfig);
const imageProvider = new OpenAIImageProvider();
const imagePromptAssistant = new ImagePromptAssistantService();
const napcatClient = new NapcatClient();
const napcatWebuiClient = new NapcatWebuiClient();
const inboxService = new InboundInboxService();
const chatPolicyService = new ChatPolicyService();
const recentMessageCache = new RecentMessageCache();
const groupParticipationService = new GroupParticipationService({ embeddingService });
const GROUP_INFO_CACHE_TTL_MS = Number(process.env.NAPCAT_GROUP_INFO_CACHE_TTL_MS || 10 * 60 * 1000);
const groupNameCache = new Map<number, { name: string; expiresAt: number }>();
let groupNotificationAggregationFlushTimer: ReturnType<typeof setInterval> | null = null;
let groupNotificationAggregationFlushBusy = false;
// Last time NapCat pushed ANY event to /webhook. Seeded at boot so a fresh
// restart doesn't instantly report the pipe as dead. /health reads this to
// derive the inbound-liveness verdict ("green but dead" detection).
let lastNapcatEventAt: number | null = Date.now();

function parseDirectAgentTriggerUserIds() {
  const raw = process.env.XIAONI_DIRECT_AGENT_TRIGGER_USER_IDS
    || process.env.AUTHORIZED_USER_ID
    || String(aiConfig.authorized_user_id);
  const ids = new Set<string>();
  String(raw)
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
    .forEach((item) => ids.add(String(Math.trunc(item))));
  return ids;
}

const directAgentTriggerUserIds = parseDirectAgentTriggerUserIds();
type ChatPolicyState = Awaited<ReturnType<ChatPolicyService['getPolicyState']>>;

function applyEffectiveInboundPolicy(
  policy: ChatPolicyState,
  params: { messageType: ProviderMessageType; userId: number; wasMentioned?: boolean }
) {
  return applyForcedInboundAgentQueuePolicy(policy, {
    chatType: params.messageType === 'group' ? 'group' : 'direct',
    wasMentioned: params.wasMentioned === true,
    senderId: String(params.userId)
  }, {
    directTriggerUserIds: directAgentTriggerUserIds
  });
}

function buildIncomingPolicyResult(policy: ChatPolicyState) {
  return {
    ...policy,
    allowed: policy.isEnabled,
    reason: policy.isEnabled ? 'accepted' as const : 'receive_disabled' as const
  };
}

async function resolveNapcatGroupName(groupId: number): Promise<string | null> {
  if (!Number.isFinite(groupId)) {
    return null;
  }
  const cached = groupNameCache.get(groupId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.name;
  }

  try {
    const groupInfo = await napcatClient.getGroupInfo(groupId);
    const groupName = typeof groupInfo?.group_name === 'string' && groupInfo.group_name.trim()
      ? groupInfo.group_name.trim()
      : '';
    if (!groupName) {
      return null;
    }
    groupNameCache.set(groupId, {
      name: groupName,
      expiresAt: now + GROUP_INFO_CACHE_TTL_MS
    });
    return groupName;
  } catch (error) {
    moduleLogger.warn('Failed to resolve NapCat group name', {
      groupId,
      error: error instanceof Error ? error.message : String(error)
    });
    return cached?.name || null;
  }
}

async function enrichInboundContextWithGroupName(inboundContext: FinalizedInboundContext, groupId?: number) {
  if (inboundContext.ChatType !== 'group' || !Number.isFinite(groupId)) {
    return;
  }
  const groupName = await resolveNapcatGroupName(groupId as number);
  if (!groupName) {
    return;
  }
  inboundContext.GroupSubject = groupName;
  inboundContext.ConversationLabel = groupName;
}

function buildAutoReplyPolicyResult(policy: ChatPolicyState) {
  return {
    ...policy,
    allowed: policy.autoReplyEnabled,
    reason: policy.autoReplyEnabled ? 'accepted' as const : 'auto_reply_disabled' as const
  };
}
const relationshipLedgerService = new RelationshipLedgerService({
  recentMessageProvider: async ({ sessionKey, currentMessageSid }) => {
    const messages = await inboxService.listConversationMessages({
      sessionKey,
      includeRead: true,
      limit: 8
    });

    return messages
      .filter((message) => !currentMessageSid || message.messageSid !== currentMessageSid)
      .map((message) => ({
        messageId: message.id,
        messageSid: message.messageSid,
        senderId: message.senderId,
        senderName: message.senderName || null,
        bodyForAgent: message.bodyForAgent,
        rawBody: message.rawBody || null,
        wasMentioned: message.wasMentioned,
        replyToSender: message.replyToSender || null,
        replyToBody: message.replyToBody || null,
        receivedAtMs: new Date(message.receivedAt).getTime()
      }));
  }
});
const selfEvolutionService = new SelfEvolutionService({
  enabled: selfEvolutionConfig.enabled,
  webhookUrl: selfEvolutionConfig.webhookUrl,
  minNewTurns: selfEvolutionConfig.minNewTurns,
  minNewLedgerEvents: selfEvolutionConfig.minNewLedgerEvents
});
const selfEvolutionExecutorService = new SelfEvolutionExecutorService({
  modelName: selfEvolutionConfig.modelName
});
const topicReviewMaterializationService = new TopicReviewMaterializationService();

function parseImageDataUrl(value: string) {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const extension = mimeType === 'image/jpeg'
    ? 'jpg'
    : mimeType.replace('image/', '');
  return {
    mimeType,
    extension,
    buffer: Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
  };
}

async function materializeRuntimeImageAsset(imageFile: string) {
  const parsed = parseImageDataUrl(imageFile);
  if (!parsed) {
    return imageFile;
  }
  await fs.mkdir(RUNTIME_ASSET_ROOT, { recursive: true });
  const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.${parsed.extension}`;
  await fs.writeFile(path.join(RUNTIME_ASSET_ROOT, filename), parsed.buffer);
  return `${RUNTIME_ASSET_BASE_URL}/api/internal/runtime-assets/${encodeURIComponent(filename)}`;
}

function isSupportedImageMimeType(value?: string | null) {
  return typeof value === 'string' && /^image\/(?:png|jpeg|jpg|webp|gif)$/i.test(value);
}

function inferImageMimeTypeFromName(value?: string | null) {
  const normalized = (value || '').toLowerCase();
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg';
  if (normalized.endsWith('.webp')) return 'image/webp';
  if (normalized.endsWith('.gif')) return 'image/gif';
  return null;
}

function countImageInputs(value: any) {
  const images = Array.isArray(value?.images)
    ? value.images
    : typeof value?.image !== 'undefined'
      ? Array.isArray(value.image) ? value.image : [value.image]
      : [];
  return images.length;
}

function buildImageUsageRequestSnapshot(operation: 'generate' | 'edit', body: any) {
  return {
    operation,
    prompt: typeof body?.prompt === 'string' ? body.prompt : null,
    model: typeof body?.model === 'string' ? body.model : null,
    size: typeof body?.size === 'string' ? body.size : null,
    quality: typeof body?.quality === 'string' ? body.quality : null,
    format: typeof body?.format === 'string' ? body.format : null,
    background: typeof body?.background === 'string' ? body.background : null,
    output_compression: typeof body?.output_compression === 'number' ? body.output_compression : null,
    n: typeof body?.n === 'number' ? body.n : null,
    input_image_count: operation === 'edit' ? countImageInputs(body) : 0,
    has_mask: operation === 'edit' ? typeof body?.mask !== 'undefined' : false
  };
}

function buildImageUsageResponseSnapshot(data: any) {
  const images = Array.isArray(data?.images) ? data.images : [];
  return {
    provider: data?.provider || null,
    model: data?.model || null,
    image_count: images.length,
    revised_prompts: images
      .map((image: any) => typeof image?.revised_prompt === 'string' ? image.revised_prompt : null)
      .filter(Boolean),
    usage: data?.usage || null
  };
}

async function recordCodexImageProviderUsage(operation: 'generate' | 'edit', body: any, data: any) {
  if (data?.provider !== 'codex') {
    return;
  }
  const outputItems = Array.isArray(data?.images)
    ? data.images.map((image: any, index: number) => ({
      type: 'image_generation_result',
      index,
      mime_type: image?.mime_type || null,
      format: image?.format || null,
      revised_prompt: image?.revised_prompt || null,
      bytes_estimate: image?.bytes_estimate || null
    }))
    : [];
  await runtimeStoreService.recordCodexProviderUsageEvent({
    eventId: `codex-provider:image-${operation}:${Date.now()}:${randomUUID().slice(0, 8)}`,
    sourceKind: operation === 'edit' ? 'image_edit' : 'image_generation',
    sourceId: typeof body?.run_id === 'string' ? body.run_id : null,
    identityKey: 'xiaoni',
    modelName: data?.model || 'gpt-image-2',
    modelProvider: 'codex',
    canonicalRequest: buildImageUsageRequestSnapshot(operation, body),
    canonicalResponse: buildImageUsageResponseSnapshot(data),
    outputItems,
    usage: data?.usage || {},
    requestFormatVersion: 'image-provider/v1',
    wireProviderFormat: 'codex/responses:image_generation',
    metadata: {
      operation,
      provider_endpoint: `/api/internal/image/${operation}`
    }
  }).catch((error) => {
    moduleLogger.warn('Failed to record Codex image provider usage event', {
      operation,
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

async function recordCodexImagePromptAssistantUsage(body: any, data: any) {
  if (data?.provider !== 'codex') {
    return;
  }
  await runtimeStoreService.recordCodexProviderUsageEvent({
    eventId: data?.llmCallId ? `codex-provider:${data.llmCallId}` : undefined,
    sourceKind: 'image_prompt_assistant',
    identityKey: 'xiaoni',
    llmCallId: typeof data?.llmCallId === 'string' ? data.llmCallId : undefined,
    modelName: typeof data?.modelName === 'string' ? data.modelName : undefined,
    modelProvider: 'codex',
    canonicalRequest: {
      operation: 'prompt_assistant',
      prompt: typeof body?.prompt === 'string' ? body.prompt : null,
      mode: body?.mode === 'edit' ? 'edit' : 'generate',
      size: typeof body?.size === 'string' ? body.size : null,
      quality: typeof body?.quality === 'string' ? body.quality : null,
      format: typeof body?.format === 'string' ? body.format : null,
      reference_image_count: Array.isArray(body?.referenceImages) ? body.referenceImages.length : 0
    },
    canonicalResponse: {
      final_prompt: typeof data?.finalPrompt === 'string' ? data.finalPrompt : null,
      detected_use_case: data?.detectedUseCase || null,
      warnings: Array.isArray(data?.warnings) ? data.warnings : []
    },
    outputItems: [{
      type: 'image_prompt_assistant_result',
      detected_use_case: data?.detectedUseCase || null
    }],
    usage: data?.usage || {},
    requestFormatVersion: data?.requestFormatVersion || 'image-prompt-assistant/v1',
    wireProviderFormat: data?.wireProviderFormat || 'codex/responses',
    metadata: {
      operation: 'prompt_assistant',
      provider_endpoint: '/api/internal/image/prompt-assistant'
    }
  }).catch((error) => {
    moduleLogger.warn('Failed to record Codex image prompt assistant usage event', {
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

function sniffImageMimeType(buffer: Buffer, fallback?: string | null) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') {
    return 'image/gif';
  }
  return isSupportedImageMimeType(fallback) ? fallback!.toLowerCase().replace('image/jpg', 'image/jpeg') : null;
}

function toDataUrl(buffer: Buffer, mimeType: string) {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function mapNapcatContainerPath(filePath: string) {
  if (!filePath.startsWith(NAPCAT_QQ_CONTAINER_ROOT + '/')) {
    throw new Error('Unsupported NapCat file path');
  }
  const relative = path.relative(NAPCAT_QQ_CONTAINER_ROOT, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Unsafe NapCat file path');
  }
  return path.join(NAPCAT_QQ_DATA_ROOT, relative);
}

async function readNapcatFileAsImageDataUrl(filePath: string, filename?: string | null, mimeType?: string | null) {
  const hostPath = mapNapcatContainerPath(filePath);
  const buffer = await fs.readFile(hostPath);
  const detectedMimeType = sniffImageMimeType(buffer, mimeType || inferImageMimeTypeFromName(filename));
  if (!detectedMimeType) {
    throw new Error('Resolved NapCat file is not a supported image');
  }
  return {
    data_url: toDataUrl(buffer, detectedMimeType),
    mime_type: detectedMimeType,
    bytes: buffer.length,
    filename: filename || path.basename(filePath)
  };
}

function buildNapcatLoginStatusPayload(
  probe: { reachable: boolean; selfId?: number | null; error?: string },
  webuiStatus?: NapcatWebuiLoginStatus,
  errorMessage?: string | null
) {
  const qqLoggedIn = probe.reachable || Boolean(webuiStatus?.isLogin);
  const qrPayload = qqLoggedIn
    ? null
    : webuiStatus?.qrPayload || null;

  return {
    napcatReachable: probe.reachable,
    qqLoggedIn,
    qqAccountId: probe.selfId ? String(probe.selfId) : null,
    qrAvailable: Boolean(qrPayload),
    qrPayload,
    qrPayloadType: qrPayload ? 'url' : null,
    webuiConfigured: napcatWebuiClient.isConfigured(),
    message: qqLoggedIn ? null : errorMessage || webuiStatus?.message || probe.error || null,
    lastCheckedAt: new Date().toISOString()
  };
}

async function getNapcatLoginStatusPayload(refreshQrcode: boolean) {
  const probe = await napcatClient.probe();
  if (probe.reachable) {
    return buildNapcatLoginStatusPayload(probe);
  }

  if (!napcatWebuiClient.isConfigured()) {
    return buildNapcatLoginStatusPayload(probe, undefined, 'NapCat WebUI token is not configured');
  }

  try {
    const webuiStatus = refreshQrcode
      ? await napcatWebuiClient.requestLoginQrcode()
      : await napcatWebuiClient.checkLoginStatus();
    return buildNapcatLoginStatusPayload(probe, webuiStatus);
  } catch (error) {
    return buildNapcatLoginStatusPayload(probe, undefined, formatNapcatWebuiError(error));
  }
}

async function fetchImageAsDataUrl(url: string, mimeType?: string | null) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image source: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const detectedMimeType = sniffImageMimeType(buffer, mimeType || response.headers.get('content-type'));
  if (!detectedMimeType) {
    throw new Error('Fetched source is not a supported image');
  }
  return {
    data_url: toDataUrl(buffer, detectedMimeType),
    mime_type: detectedMimeType,
    bytes: buffer.length
  };
}

function normalizeMimeType(value?: string | null) {
  const normalized = (value || '').split(';')[0].trim().toLowerCase();
  if (!normalized || normalized === 'image/*') {
    return null;
  }
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

function extensionFromMimeType(value?: string | null) {
  switch (normalizeMimeType(value)) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'video/mp4':
      return 'mp4';
    case 'application/pdf':
      return 'pdf';
    case 'text/plain':
      return 'txt';
    default:
      return null;
  }
}

function extensionFromName(value?: string | null) {
  const extension = path.extname(value || '').replace(/^\./, '').toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : null;
}

function inferStoredMediaExtension(mimeType?: string | null, fileName?: string | null, locator?: string | null) {
  return extensionFromMimeType(mimeType)
    || extensionFromName(fileName)
    || extensionFromName(locator)
    || 'bin';
}

function inferStoredMediaMimeType(filename: string) {
  switch (path.extname(filename).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.mp3':
      return 'audio/mpeg';
    case '.ogg':
      return 'audio/ogg';
    case '.wav':
      return 'audio/wav';
    case '.mp4':
      return 'video/mp4';
    case '.pdf':
      return 'application/pdf';
    case '.txt':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

function parseMediaDataUrl(value: string) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  return {
    mimeType: normalizeMimeType(match[1]) || 'application/octet-stream',
    buffer: Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
  };
}

function assertInboundMediaSize(buffer: Buffer, source: string) {
  if (buffer.length > INBOUND_MEDIA_MAX_BYTES) {
    throw new Error(`Inbound media from ${source} exceeds ${INBOUND_MEDIA_MAX_BYTES} bytes`);
  }
}

function ensureRelativePathInside(root: string, filePath: string) {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Local image path is outside the allowed runtime picture directory');
  }
  if (relative.includes(path.sep)) {
    throw new Error('Local image path must be a direct child of the runtime picture directory');
  }
  return relative;
}

async function resolveLocalRuntimePicturePath(localPath: string) {
  const trimmed = typeof localPath === 'string' ? localPath.trim() : '';
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error('Local image path must be absolute');
  }
  const root = await fs.realpath(LOCAL_RUNTIME_PICTURE_ROOT).catch(() => path.resolve(LOCAL_RUNTIME_PICTURE_ROOT));
  const candidate = path.resolve(trimmed);
  const realPath = await fs.realpath(candidate);
  ensureRelativePathInside(root, realPath);
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) {
    throw new Error('Local image path is not a file');
  }
  return realPath;
}

async function readLocalRuntimePicture(localPath: string, requestedMimeType?: string | null) {
  const filePath = await resolveLocalRuntimePicturePath(localPath);
  const buffer = await fs.readFile(filePath);
  assertInboundMediaSize(buffer, filePath);
  const mimeType = sniffImageMimeType(
    buffer,
    normalizeMimeType(requestedMimeType) || inferImageMimeTypeFromName(filePath)
  );
  if (!mimeType) {
    throw new Error('Local runtime picture is not a supported image');
  }
  return {
    filePath,
    filename: path.basename(filePath),
    buffer,
    mimeType
  };
}

async function fetchMediaAsBuffer(url: string, mimeType?: string | null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INBOUND_MEDIA_FETCH_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch media source: ${response.status}`);
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > INBOUND_MEDIA_MAX_BYTES) {
      throw new Error(`Inbound media source exceeds ${INBOUND_MEDIA_MAX_BYTES} bytes`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    assertInboundMediaSize(buffer, url);
    return {
      buffer,
      mimeType: normalizeMimeType(response.headers.get('content-type')) || normalizeMimeType(mimeType),
      filename: path.basename(new URL(url).pathname) || null
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readNapcatFileAsBuffer(filePath: string, filename?: string | null, mimeType?: string | null) {
  const hostPath = mapNapcatContainerPath(filePath);
  const buffer = await fs.readFile(hostPath);
  assertInboundMediaSize(buffer, filePath);
  return {
    buffer,
    mimeType: normalizeMimeType(mimeType) || sniffImageMimeType(buffer, inferImageMimeTypeFromName(filename || filePath)),
    filename: filename || path.basename(filePath)
  };
}

async function resolveInboundMediaBytes(asset: InboundMediaAsset) {
  const fileId = typeof asset.fileId === 'string' && asset.fileId.trim() ? asset.fileId.trim() : '';
  let fileError: unknown = null;
  if (fileId) {
    try {
      const fileInfo = await napcatClient.getFile(fileId);
      const filePath = typeof fileInfo?.file === 'string' && fileInfo.file.trim()
        ? fileInfo.file.trim()
        : typeof fileInfo?.url === 'string' && fileInfo.url.trim()
          ? fileInfo.url.trim()
          : '';
      if (filePath && /^https?:\/\//i.test(filePath)) {
        return fetchMediaAsBuffer(filePath, asset.mimeType);
      }
      if (filePath) {
        return readNapcatFileAsBuffer(filePath, asset.fileName || fileInfo?.file_name, asset.mimeType);
      }
    } catch (error) {
      fileError = error;
    }
  }

  const locator = typeof asset.locator === 'string' && asset.locator.trim() ? asset.locator.trim() : '';
  if (locator.startsWith('data:')) {
    const parsed = parseMediaDataUrl(locator);
    if (!parsed) {
      throw new Error('Unsupported media data URL');
    }
    assertInboundMediaSize(parsed.buffer, 'data_url');
    return {
      buffer: parsed.buffer,
      mimeType: parsed.mimeType,
      filename: asset.fileName || null
    };
  }
  if (/^https?:\/\//i.test(locator)) {
    return fetchMediaAsBuffer(locator, asset.mimeType);
  }
  if (locator.startsWith(NAPCAT_QQ_CONTAINER_ROOT + '/')) {
    return readNapcatFileAsBuffer(locator, asset.fileName, asset.mimeType);
  }

  if (fileError instanceof Error) {
    throw fileError;
  }
  throw new Error('Inbound media asset has no readable locator');
}

async function materializeInboundMediaAsset(asset: InboundMediaAsset) {
  const resolved = await resolveInboundMediaBytes(asset);
  const detectedImageMimeType = sniffImageMimeType(resolved.buffer, resolved.mimeType || asset.mimeType);
  const mimeType = detectedImageMimeType || normalizeMimeType(resolved.mimeType) || normalizeMimeType(asset.mimeType) || 'application/octet-stream';
  const contentHash = createHash('sha256').update(resolved.buffer).digest('hex');
  const extension = inferStoredMediaExtension(mimeType, asset.fileName || resolved.filename, asset.locator);
  const filename = `${contentHash}.${extension}`;
  const storagePath = path.join(INBOUND_MEDIA_ASSET_ROOT, filename);
  await fs.mkdir(INBOUND_MEDIA_ASSET_ROOT, { recursive: true });
  try {
    await fs.writeFile(storagePath, resolved.buffer, { flag: 'wx' });
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }
  }
  return {
    id: `media_${contentHash.slice(0, 48)}`,
    storageUri: `${INBOUND_MEDIA_ASSET_BASE_URL}/api/internal/media-assets/${encodeURIComponent(filename)}`,
    storagePath,
    executorPath: storagePath,
    contentHash,
    bytes: resolved.buffer.length,
    mimeType,
    filename
  };
}

async function prepareInboundMediaAssets(inboundContext: FinalizedInboundContext) {
  const mediaAssets = Array.isArray(inboundContext.MediaAssets) ? inboundContext.MediaAssets : [];
  for (const asset of mediaAssets) {
    if (!asset || typeof asset !== 'object') {
      continue;
    }
    try {
      const materialized = await materializeInboundMediaAsset(asset);
      asset.id = materialized.id;
      asset.storageUri = materialized.storageUri;
      asset.storagePath = materialized.storagePath;
      asset.executorPath = materialized.executorPath;
      asset.contentHash = materialized.contentHash;
      asset.bytes = materialized.bytes;
      asset.mimeType = materialized.mimeType;
      if (!asset.fileName) {
        asset.fileName = materialized.filename;
      }
    } catch (error) {
      moduleLogger.warn('Failed to materialize inbound media asset', {
        mediaTag: asset.mediaTag,
        mediaType: asset.mediaType,
        locator: asset.locator || null,
        fileId: asset.fileId || null,
        error: error instanceof Error ? error.message : String(error)
      });
      if (typeof asset.id === 'string' && asset.id.trim()) {
        asset.id = asset.id.trim();
      } else {
        asset.id = `media_${Date.now()}_${randomUUID().slice(0, 8)}`;
      }
    }
  }
}

async function persistInboundMediaAssets(inboundContext: FinalizedInboundContext, sourceMessageId?: number | null, traceId?: string) {
  const mediaAssets = Array.isArray(inboundContext.MediaAssets) ? inboundContext.MediaAssets : [];
  if (mediaAssets.length === 0) {
    return [];
  }

  return upsertAgentMediaAssets(mediaAssets.map((asset) => ({
    id: asset.id,
    source: inboundContext.Surface || inboundContext.Provider || 'napcat',
    sourceMessageId: sourceMessageId || null,
    traceId,
    sessionKey: inboundContext.SessionKey || '',
    chatType: inboundContext.ChatType === 'group' ? 'group' : 'direct',
    peerId: inboundContext.NativeChannelId || inboundContext.To || null,
    peerName: inboundContext.ConversationLabel || null,
    senderId: inboundContext.SenderId || null,
    senderName: inboundContext.SenderName || null,
    accountId: inboundContext.AccountId || null,
    messageSid: asset.messageSid || inboundContext.MessageSid || null,
    mediaTag: asset.mediaTag,
    placeholder: asset.placeholder,
    mediaType: asset.mediaType,
    mimeType: asset.mimeType,
    sourceLocator: asset.locator,
    storageUri: asset.storageUri,
    metadata: {
      provider: inboundContext.Provider || null,
      surface: inboundContext.Surface || null,
      placeholder: asset.placeholder,
      file_id: asset.fileId || null,
      file_name: asset.fileName || null,
      file_size: asset.fileSize || null,
      content_hash: asset.contentHash || null,
      bytes: asset.bytes || null,
      storage_uri: asset.storageUri || null,
      provider_storage_path: asset.storagePath || null,
      executor_path: asset.executorPath || null
    }
  })));
}

function scheduleCompactionSideEffects(inboundContext: FinalizedInboundContext) {
  moduleLogger.debug('Skipped transcript/memory side effects for simplified runtime', {
    sessionKey: inboundContext.SessionKey,
    chatType: inboundContext.ChatType
  });
}

function respondRuntimeFeatureDisabled(
  res: express.Response,
  feature: 'transcript_summary' | 'self_evolution' | 'topic_projection'
) {
  return res.status(410).json({
    success: false,
    error: `${feature} is disabled in the simplified runtime`,
    timestamp: new Date().toISOString()
  });
}

function markIncomingActivityAsync(params: { messageType: ProviderMessageType; userId: number; groupId?: number }) {
  void chatPolicyService.markIncomingActivity(params).catch((error) => {
    moduleLogger.warn('Failed to update chat activity after accepting message', {
      error: error instanceof Error ? error.message : String(error),
      ...params
    });
  });
}

function recordRelationshipLedgerAsync(inboundContext: FinalizedInboundContext, currentMessageId?: number | null) {
  moduleLogger.debug('Skipped relationship ledger recording for simplified runtime', {
    sessionKey: inboundContext.SessionKey,
    messageSid: inboundContext.MessageSid,
    currentMessageId: currentMessageId ?? null
  });
}

function isInboxOnlyInboundMessage(_message: { chatType: 'direct' | 'group'; wasMentioned: boolean; senderId: string }) {
  return false;
}

async function runContinuousLearningIfEnabled(params: {
  policyState: Awaited<ReturnType<ChatPolicyService['getPolicyState']>>;
  inboxEventId?: number | null;
  inboundContext: FinalizedInboundContext;
  traceId: string;
  skipMaterialization?: boolean;
  inboxOnly?: boolean;
}) {
  void params;
  return {
    attempted: false,
    reason: 'continuous_learning_retired'
  };
}

function parseBoolean(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  return false;
}

function toNumericId(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function inferPolicyTargets(inboundContext: FinalizedInboundContext) {
  const messageType: ProviderMessageType = inboundContext.ChatType === 'group' ? 'group' : 'private';
  const userId = toNumericId(inboundContext.SenderId);
  const groupId = messageType === 'group' ? toNumericId(inboundContext.NativeChannelId) : null;

  if (userId === null) {
    return null;
  }

  if (messageType === 'group' && groupId === null) {
    return null;
  }

  return {
    messageType,
    userId,
    groupId: groupId === null ? undefined : groupId
  };
}

async function simulateSimpleQueueMessage(messageType: ProviderMessageType, payload: SimpleQueueSimulationPayload) {
  const inboundContext = buildSimpleQueueSimulationContext(messageType, payload);
  const result = await inboxService.simulateMessage({
    inboundContext,
    fallbackBotAccountId: String(aiConfig.bot_qq_number),
    rawPayload: {
      simulated: true,
      source: 'simple-queue',
      messageType,
      priority: payload.priority || null,
      payload
    }
  });

  markIncomingActivityAsync({
    messageType,
    userId: Number(payload.user_id),
    groupId: messageType === 'group' ? Number(payload.group_id) : undefined
  });

  const finalizedContext = inboxService.finalizeSimulationContext(
    inboundContext,
    String(aiConfig.bot_qq_number),
    result.traceId
  );
  const policyState = await chatPolicyService.getPolicyState({
    messageType,
    userId: Number(payload.user_id),
    groupId: messageType === 'group' ? Number(payload.group_id) : undefined
  });
  const effectivePolicy = applyEffectiveInboundPolicy(policyState, {
    messageType,
    userId: Number(payload.user_id),
    wasMentioned: finalizedContext.WasMentioned === true
  });
  recordRelationshipLedgerAsync(finalizedContext, result.event.id);
  const autoReply = await processAutoReply({
    inboxEvent: result.event,
    inboundContext: finalizedContext,
    rawPayload: {
      simulated: true,
      source: 'simple-queue',
      messageType,
      payload
    },
    traceId: result.traceId,
    source: 'simulator',
    policyState: effectivePolicy
  });
  const inboxOnly = isInboxOnlyInboundMessage(result.event);
  const learning = !autoReply.queued
    ? await runContinuousLearningIfEnabled({
        policyState,
        inboxEventId: result.event.id,
        inboundContext: finalizedContext,
        traceId: result.traceId,
        inboxOnly
      })
    : await runContinuousLearningIfEnabled({
        policyState,
        inboxEventId: result.event.id,
        inboundContext: finalizedContext,
        traceId: result.traceId,
        skipMaterialization: true
      });

  return {
    ...result,
    autoReply,
    learning
  };
}

async function expandForwardSegments(message: OneBotMessageEvent): Promise<OneBotMessageEvent> {
  if (!Array.isArray(message.message)) {
    return message;
  }

  const hasForward = message.message.some((seg) => seg.type === 'forward');
  if (!hasForward) {
    return message;
  }

  const expandedSegments: typeof message.message = [];
  for (const seg of message.message) {
    if (seg.type !== 'forward') {
      expandedSegments.push(seg);
      continue;
    }
    const forwardId = String(seg.data?.id ?? '');
    if (!forwardId) {
      expandedSegments.push({ type: 'text', data: { text: '[转发消息]' } });
      continue;
    }
    try {
      const items = await napcatClient.getForwardMessage(forwardId);
      const lines: string[] = ['[转发消息]'];
      for (const item of items) {
        const senderName = item.sender?.nickname || String(item.sender?.user_id ?? '');
        const segments = item.content ?? item.message ?? [];
        const parts: string[] = [];
        for (const s of segments) {
          if (s.type === 'text') {
            const t = String(s.data?.text ?? '').trim();
            if (t) parts.push(t);
          } else if (s.type === 'json') {
            const raw = String(s.data?.data ?? '');
            try {
              const parsed = JSON.parse(raw);
              const detail = parsed?.meta?.detail_1 ?? {};
              const desc = detail.desc || detail.title || parsed.prompt || '';
              const rawUrl = detail.qqdocurl || detail.url || '';
              const url = rawUrl.split('?')[0];
              parts.push(url ? `[卡片] ${desc} ${url}`.trim() : `[卡片] ${desc}`);
            } catch {
              parts.push('[卡片]');
            }
          } else if (s.type === 'xml') {
            const raw = String(s.data?.data ?? '');
            const title = /<title[^>]*>([^<]+)<\/title>/i.exec(raw)?.[1]?.trim();
            const url = /<url[^>]*>([^<]+)<\/url>/i.exec(raw)?.[1]?.trim();
            const desc = /<des[^>]*>([^<]+)<\/des>/i.exec(raw)?.[1]?.trim();
            const label = title || desc;
            parts.push(url ? `[卡片] ${label ?? ''} ${url}`.trim() : `[卡片] ${label ?? ''}`);
          } else if (s.type === 'share') {
            const title = String(s.data?.title ?? s.data?.content ?? '').trim();
            const url = String(s.data?.url ?? '').trim();
            if (url) parts.push(title ? `[链接] ${title} ${url}` : `[链接] ${url}`);
          } else if (s.type === 'forward') {
            parts.push('[嵌套转发]');
          }
        }
        const combined = parts.join(' ').trim();
        if (combined) {
          lines.push(`${senderName}: ${combined}`);
        }
      }
      expandedSegments.push({ type: 'text', data: { text: lines.join('\n') } });
    } catch {
      expandedSegments.push({ type: 'text', data: { text: '[转发消息]' } });
    }
  }

  return { ...message, message: expandedSegments };
}

async function handleOneBotMessageEvent(message: OneBotMessageEvent) {
  const messageType = message.message_type === 'group' ? 'group' : 'private';
  const userId = Number(message.user_id);
  const groupId = message.group_id !== undefined ? Number(message.group_id) : undefined;

  if (!Number.isFinite(userId)) {
    return { accepted: false, reason: 'invalid_message' as const };
  }

  if (messageType === 'group' && !Number.isFinite(groupId)) {
    return { accepted: false, reason: 'invalid_group_message' as const };
  }

  if (userId === aiConfig.bot_qq_number) {
    return { accepted: false, reason: 'self_message' as const };
  }

  const policy = await chatPolicyService.getPolicyState({
    messageType,
    userId,
    groupId
  });

  const traceId = inboxService.createTraceId('napcat');
  const expandedMessage = await expandForwardSegments(message);
  const inboundContext = buildNapcatInboundContext({
    event: expandedMessage,
    fallbackBotAccountId: String(aiConfig.bot_qq_number),
    replyCache: recentMessageCache,
  });

  if (!inboundContext) {
    return { accepted: false, reason: 'invalid_message' as const };
  }
  await enrichInboundContextWithGroupName(inboundContext, groupId);
  await prepareInboundMediaAssets(inboundContext);
  const effectivePolicy = applyEffectiveInboundPolicy(policy, {
    messageType,
    userId,
    wasMentioned: inboundContext.WasMentioned === true
  });

  const result = await inboxService.ingestIncomingMessage({
    inboundContext,
    rawPayload: message as Record<string, unknown>,
    traceId,
    source: 'napcat'
  });
  await persistInboundMediaAssets(inboundContext, result.event.id, result.traceId);
  rememberInboundContext(recentMessageCache, inboundContext);

  markIncomingActivityAsync({
    messageType,
    userId,
    groupId
  });
  recordRelationshipLedgerAsync(inboundContext, result.event.id);

  moduleLogger.info('Accepted OneBot message event', {
    messageType,
    userId,
    groupId: groupId ?? null,
    traceId: result.traceId,
    sessionKey: inboundContext.SessionKey,
    chatType: inboundContext.ChatType,
    wasMentioned: inboundContext.WasMentioned === true
  });

  if (!effectivePolicy.isEnabled) {
    const learning = await runContinuousLearningIfEnabled({
      policyState: policy,
      inboxEventId: result.event.id,
      inboundContext,
      traceId: result.traceId,
      inboxOnly: isInboxOnlyInboundMessage(result.event)
    });
    return {
      accepted: true,
      reason: 'receive_disabled' as const,
      policy: {
        ...effectivePolicy,
        allowed: false,
        reason: 'receive_disabled' as const
      },
      autoReply: {
        attempted: false,
        queued: false,
        reason: 'receive_disabled'
      },
      learning,
      ...result
    };
  }

  const autoReply = await processAutoReply({
    inboxEvent: result.event,
    inboundContext,
    rawPayload: message as Record<string, unknown>,
    traceId: result.traceId,
    source: 'napcat',
    policyState: effectivePolicy
  });
  const inboxOnly = isInboxOnlyInboundMessage(result.event);
  const learning = !autoReply.queued
    ? await runContinuousLearningIfEnabled({
        policyState: policy,
        inboxEventId: result.event.id,
        inboundContext,
        traceId: result.traceId,
        inboxOnly
      })
    : await runContinuousLearningIfEnabled({
        policyState: policy,
        inboxEventId: result.event.id,
        inboundContext,
        traceId: result.traceId,
        skipMaterialization: true
      });

  return {
    accepted: true,
    policy: {
      ...effectivePolicy,
      allowed: true,
      reason: 'accepted' as const
    },
    autoReply,
    learning,
    ...result
  };
}

async function processAutoReply(params: {
  inboxEvent: Awaited<ReturnType<InboundInboxService['ingestIncomingMessage']>>['event'];
  inboundContext: FinalizedInboundContext;
  rawPayload: Record<string, unknown>;
  traceId: string;
  source: 'napcat' | 'simulator';
  policyState?: Awaited<ReturnType<ChatPolicyService['getPolicyState']>>;
}) {
  const policyTargets = inferPolicyTargets(params.inboundContext);
  if (!policyTargets) {
    return {
      attempted: false,
      queued: false,
      reason: 'invalid_policy_targets'
    };
  }

  const policy = params.policyState || await chatPolicyService.getPolicyState(policyTargets);
  await runtimeStoreService.logTimelineEvent({
    traceId: params.traceId,
    eventType: 'phone_notification',
    eventName: 'routing',
    eventPhase: 'start',
    metadata: {
      source: params.source,
      session_key: params.inboxEvent.sessionKey,
      chat_type: params.inboxEvent.chatType
    }
  });
  const triggerDecision = decideInboundAgentQueueTrigger(params.inboxEvent, {
    notificationMode: policy.notificationMode
  });
  const notificationAllowed = policy.autoReplyEnabled && triggerDecision.shouldEnqueue;
  const participationDecision = {
    decision: notificationAllowed ? 'notify' as const : 'skip' as const,
    reason: !policy.autoReplyEnabled
      ? 'auto_reply_disabled'
      : triggerDecision.shouldEnqueue
        ? triggerDecision.reason
        : 'group_notification_mentions_only',
    confidence: 'high' as const,
    conservativeFallback: false,
    usedEmbeddings: false,
    usedLlmJudge: false,
    scores: null,
    metadata: {
      source_of_truth: 'phone_notification',
      provider_boundary_mode: 'notification_only_no_qq_body',
      trigger_reason: triggerDecision.reason,
      auto_reply_enabled: policy.autoReplyEnabled,
      notification_mode: policy.notificationMode
    }
  };
  await runtimeStoreService.logTimelineEvent({
    traceId: params.traceId,
    eventType: 'phone_notification',
    eventName: 'routing',
    eventPhase: 'end',
    metadata: {
      source: params.source,
      decision: participationDecision.decision,
      reason: participationDecision.reason,
      confidence: participationDecision.confidence,
      conservative_fallback: participationDecision.conservativeFallback,
      used_embeddings: participationDecision.usedEmbeddings,
      used_llm_judge: participationDecision.usedLlmJudge,
      scores: participationDecision.scores,
      ...participationDecision.metadata
    }
  });
  const queueResult = await processInboundAgentQueueTrigger({
    inboxEvent: params.inboxEvent,
    inboundContext: params.inboundContext,
    policyState: policy,
    rawPayload: params.rawPayload,
    traceId: params.traceId,
    source: params.source
  }, runtimeStoreService);
  const attentionReminder = await processAttentionLeaseReminder({
    inboxEvent: params.inboxEvent,
    traceId: params.traceId,
    policyState: policy
  });
  return {
    ...queueResult,
    attentionReminder,
    participationDecision
  };
}

async function processAttentionLeaseReminder(params: {
  inboxEvent: Awaited<ReturnType<InboundInboxService['ingestIncomingMessage']>>['event'];
  traceId: string;
  policyState?: Awaited<ReturnType<ChatPolicyService['getPolicyState']>>;
}) {
  if (params.policyState?.isEnabled === false) {
    return {
      attempted: false,
      queued: false,
      reason: 'receive_disabled'
    };
  }
  const prepared = await maybeCreateQqAttentionReminder({
    inboundMessageId: params.inboxEvent.id,
    policyState: params.policyState || null
  }).catch(async (error: unknown) => {
    await runtimeStoreService.logTimelineEvent({
      traceId: params.traceId,
      eventType: 'system_reminder',
      eventName: 'attention_lease.evaluate',
      eventPhase: 'error',
      metadata: {
        session_key: params.inboxEvent.sessionKey,
        error: error instanceof Error ? error.message : String(error)
      }
    });
    return { shouldEnqueue: false, reason: 'error' };
  }) as {
    shouldEnqueue?: boolean;
    reason?: string;
    reminderId?: number;
    score?: number;
    message?: Parameters<typeof runtimeStoreService.enqueueSemanticMessage>[0];
  };

  await runtimeStoreService.logTimelineEvent({
    traceId: params.traceId,
    eventType: 'system_reminder',
    eventName: 'attention_lease.evaluate',
    eventPhase: prepared.shouldEnqueue ? 'end' : 'skip',
    metadata: {
      session_key: params.inboxEvent.sessionKey,
      reason: prepared.reason || null,
      score: prepared.score ?? null
    }
  });

  if (!prepared.shouldEnqueue || !prepared.message || !prepared.reminderId) {
    return {
      attempted: true,
      queued: false,
      reason: prepared.reason || 'not_eligible'
    };
  }

  const queueResult = await runtimeStoreService.enqueueSemanticMessage(prepared.message);
  await markQqAttentionReminderQueued({
    reminderId: prepared.reminderId,
    queueMessageId: queueResult.queueId
  }).catch((error: unknown) => {
    moduleLogger.warn('Failed to mark QQ attention reminder queued', {
      reminderId: prepared.reminderId,
      queueId: queueResult.queueId,
      error: error instanceof Error ? error.message : String(error)
    });
  });
  await runtimeStoreService.logTimelineEvent({
    traceId: params.traceId,
    eventType: 'system_reminder',
    eventName: 'attention_lease.enqueue',
    eventPhase: 'end',
    metadata: {
      session_key: params.inboxEvent.sessionKey,
      queue_id: queueResult.queueId,
      queue_status: queueResult.status,
      reason: prepared.reason || 'attention_lease'
    }
  });
  return {
    attempted: true,
    queued: true,
    queueId: queueResult.queueId,
    queueStatus: queueResult.status,
    reason: prepared.reason || 'attention_lease'
  };
}

app.use(express.json({ limit: process.env.IMAGE_LAB_JSON_LIMIT || '50mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.IMAGE_LAB_JSON_LIMIT || '50mb' }));

app.get('/health', async (_req, res) => {
  const [napcat, inbox, liveness] = await Promise.all([
    napcatClient.probe(),
    inboxService.getStats(),
    napcatClient.probeLiveness()
  ]);

  const inboundLiveness = evaluateInboundLiveness({
    probe: liveness,
    lastEventAt: lastNapcatEventAt,
    now: Date.now(),
    staleMs: inboundLivenessConfig.staleMs
  });

  res.json({
    status: 'healthy',
    service: 'provider-service',
    timestamp: new Date().toISOString(),
    napcat,
    inbox,
    inboundLiveness
  });
});

app.get('/api/status', async (_req, res) => {
  const napcat = await napcatClient.probe();
  res.json({
    service: 'Provider Service',
    status: napcat.reachable ? 'running' : 'degraded',
    napcat,
    port: serverConfig.port,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/napcat-login/status', async (_req, res) => {
  const data = await getNapcatLoginStatusPayload(false);
  res.json({
    success: true,
    data,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/napcat-login/qrcode', async (_req, res) => {
  const data = await getNapcatLoginStatusPayload(true);
  res.json({
    success: true,
    data,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/internal/send_private', async (req, res) => {
  try {
    const { userId, messages, enforcePolicy } = resolveInternalPrivateSendRequest(req.body || {});
    if (!Number.isFinite(userId) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: user_id, message or messages'
      });
    }

    if (enforcePolicy) {
      const policyState = await chatPolicyService.getPolicyState({
        messageType: 'private',
        userId
      });
      const policy = buildAutoReplyPolicyResult(applyEffectiveInboundPolicy(policyState, {
        messageType: 'private',
        userId
      }));
      if (!policy.allowed) {
        return res.status(409).json({
          success: false,
          error: policy.reason,
          policy,
          timestamp: new Date().toISOString()
        });
      }
    }

    const data = [];
    for (const message of messages) {
      data.push(await napcatClient.sendPrivateMessage(userId, message));
    }
    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send private message',
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/internal/send_group', async (req, res) => {
  try {
    const { groupId, messages, mentionUserIds, sessionKey, enforcePolicy } = resolveInternalGroupSendRequest(req.body || {});
    if (!Number.isFinite(groupId) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: group_id, message or messages'
      });
    }

    if (enforcePolicy) {
      const policyState = await chatPolicyService.getPolicyState({
        messageType: 'group',
        userId: 0,
        groupId
      });
      const policy = buildAutoReplyPolicyResult(applyEffectiveInboundPolicy(policyState, {
        messageType: 'group',
        userId: 0
      }));
      if (!policy.allowed) {
        return res.status(409).json({
          success: false,
          error: policy.reason,
          policy,
          timestamp: new Date().toISOString()
        });
      }
    }

    const data = [];
    for (const [index, message] of messages.entries()) {
      data.push(await napcatClient.sendGroupMessage(
        groupId,
        message,
        index === 0 ? mentionUserIds : []
      ));
    }
    if (sessionKey) {
      groupParticipationService.recordBotReply(sessionKey);
    }
    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send group message',
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/internal/send_group_image', async (req, res) => {
  try {
    const groupId = Number(req.body?.group_id);
    const imageFile = typeof req.body?.image_file === 'string'
      ? req.body.image_file
      : typeof req.body?.data_url === 'string'
        ? req.body.data_url
        : typeof req.body?.url === 'string'
          ? req.body.url
          : '';
    const caption = typeof req.body?.caption === 'string' ? req.body.caption : undefined;
    const sessionKey = typeof req.body?.session_key === 'string' && req.body.session_key.trim().length > 0
      ? req.body.session_key.trim()
      : null;

    if (!Number.isFinite(groupId) || !imageFile.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: group_id and image_file/data_url/url'
      });
    }

    const deliverableImageFile = await materializeRuntimeImageAsset(imageFile);
    const data = await napcatClient.sendGroupImage(groupId, deliverableImageFile, caption);
    if (sessionKey) {
      groupParticipationService.recordBotReply(sessionKey);
    }
    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send group image',
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/internal/send_private_image', async (req, res) => {
  try {
    const userId = Number(req.body?.user_id);
    const imageFile = typeof req.body?.image_file === 'string'
      ? req.body.image_file
      : typeof req.body?.data_url === 'string'
        ? req.body.data_url
        : typeof req.body?.url === 'string'
          ? req.body.url
          : '';
    const caption = typeof req.body?.caption === 'string' ? req.body.caption : undefined;

    if (!Number.isFinite(userId) || !imageFile.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: user_id and image_file/data_url/url'
      });
    }

    const deliverableImageFile = await materializeRuntimeImageAsset(imageFile);
    const data = await napcatClient.sendPrivateImage(userId, deliverableImageFile, caption);
    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send private image',
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/internal/runtime-assets/:filename', async (req, res) => {
  try {
    const filename = path.basename(req.params.filename || '');
    if (!filename) {
      return res.status(404).end();
    }
    const filePath = path.join(RUNTIME_ASSET_ROOT, filename);
    const extension = path.extname(filename).toLowerCase();
    const mimeType = extension === '.jpg' || extension === '.jpeg'
      ? 'image/jpeg'
      : extension === '.webp'
        ? 'image/webp'
        : extension === '.gif'
          ? 'image/gif'
          : 'image/png';
    res.type(mimeType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(await fs.readFile(filePath));
  } catch {
    res.status(404).end();
  }
});

app.get('/api/internal/media-assets/:filename', async (req, res) => {
  try {
    const filename = path.basename(req.params.filename || '');
    if (!filename) {
      return res.status(404).end();
    }
    const filePath = path.join(INBOUND_MEDIA_ASSET_ROOT, filename);
    res.type(inferStoredMediaMimeType(filename));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(await fs.readFile(filePath));
  } catch {
    res.status(404).end();
  }
});

app.get('/api/internal/local-media-assets/:filename', async (req, res) => {
  try {
    const filename = path.basename(req.params.filename || '');
    if (!filename) {
      return res.status(404).end();
    }
    const localPath = path.join(LOCAL_RUNTIME_PICTURE_ROOT, filename);
    const image = await readLocalRuntimePicture(localPath);
    res.type(image.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(image.buffer);
  } catch {
    res.status(404).end();
  }
});

app.post('/api/internal/media-assets/register-local', async (req, res) => {
  try {
    const localPath = typeof req.body?.local_path === 'string' && req.body.local_path.trim()
      ? req.body.local_path.trim()
      : typeof req.body?.path === 'string' && req.body.path.trim()
        ? req.body.path.trim()
        : '';
    if (!localPath) {
      return res.status(400).json({
        success: false,
        error: 'Missing local_path',
        timestamp: new Date().toISOString()
      });
    }

    const image = await readLocalRuntimePicture(
      localPath,
      typeof req.body?.mime_type === 'string' ? req.body.mime_type : null
    );
    const contentHash = createHash('sha256').update(image.buffer).digest('hex');
    const assetId = `local_media_${contentHash.slice(0, 48)}`;
    const mediaTag = typeof req.body?.media_tag === 'string' && req.body.media_tag.trim()
      ? req.body.media_tag.trim()
      : assetId;
    const storageUri = `${INBOUND_MEDIA_ASSET_BASE_URL}/api/internal/local-media-assets/${encodeURIComponent(image.filename)}`;
    const assets = await upsertAgentMediaAssets([{
      id: assetId,
      source: 'local_runtime',
      traceId: typeof req.body?.trace_id === 'string' ? req.body.trace_id : null,
      sessionKey: typeof req.body?.session_key === 'string' && req.body.session_key.trim()
        ? req.body.session_key.trim()
        : 'xiaoni:global',
      chatType: req.body?.chat_type === 'group' ? 'group' : 'direct',
      peerId: typeof req.body?.peer_id === 'string' ? req.body.peer_id : null,
      peerName: typeof req.body?.peer_name === 'string' ? req.body.peer_name : null,
      senderId: typeof req.body?.sender_id === 'string' ? req.body.sender_id : 'xiaoni',
      senderName: typeof req.body?.sender_name === 'string' ? req.body.sender_name : '小腻',
      accountId: typeof req.body?.account_id === 'string' ? req.body.account_id : null,
      mediaTag,
      placeholder: '[Image]',
      mediaType: 'image',
      mimeType: image.mimeType,
      sourceLocator: image.filePath,
      storageUri,
      metadata: {
        provider: 'local_runtime',
        surface: 'xiaoni-browser',
        placeholder: '[Image]',
        file_name: image.filename,
        content_hash: contentHash,
        bytes: image.buffer.length,
        storage_uri: storageUri,
        executor_path: image.filePath,
        local_path: image.filePath,
        registered_by: typeof req.body?.registered_by === 'string' ? req.body.registered_by : 'local-media-register'
      }
    }]);
    const asset = assets[0] || null;
    res.json({
      success: true,
      data: {
        asset,
        image_id: asset?.id || assetId,
        media_tag: asset?.media_tag || mediaTag,
        placeholder: `<image>pic<${asset?.id || assetId}></image>`,
        local_path: image.filePath,
        storage_uri: storageUri,
        mime_type: image.mimeType,
        bytes: image.buffer.length
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = /outside the allowed|must be absolute|direct child|not a file|not a supported image/i.test(message)
      ? 400
      : 500;
    moduleLogger.warn('Local media asset registration failed', {
      error: message
    });
    res.status(statusCode).json({
      success: false,
      error: message,
      timestamp: new Date().toISOString()
    });
  }
});

app.post(['/webhook', '/api/onebot/events', '/api/onebot/webhook'], async (req, res) => {
  try {
    const event = (req.body || {}) as OneBotMessageEvent;
    // Any delivered event (message, meta heartbeat, notice) proves the NapCat ->
    // provider receive pipe is alive. Stamp before the post_type filter so the
    // inbound watchdog stays quiet during legitimately quiet stretches as long
    // as NapCat keeps pushing heartbeats.
    lastNapcatEventAt = Date.now();
    if (event.post_type !== 'message') {
      return res.status(202).json({
        success: true,
        ignored: true,
        reason: 'unsupported_post_type',
        timestamp: new Date().toISOString()
      });
    }

    const result = await handleOneBotMessageEvent(event);
    res.status(result.accepted ? 200 : 202).json({
      success: true,
      data: result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    moduleLogger.error('Failed to process OneBot webhook event', {
      error: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to process webhook event',
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/internal/llm/debug', async (req, res) => {
  try {
    const result = await executeDebugRequest(req.body || {});
    res.json(result);
  } catch (error) {
    moduleLogger.error('LLM debug request failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'LLM debug failed',
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/internal/agent/execute', async (req, res) => {
  try {
    const result = await executeAgentRequest(req.body || {});
    res.json(result);
  } catch (error) {
    moduleLogger.error('Agent execution request failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Agent execution failed',
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/internal/image/generate', async (req, res) => {
  try {
    const data = await imageProvider.generate(req.body || {});
    await recordCodexImageProviderUsage('generate', req.body || {}, data);
    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const statusCode = error instanceof ImageProviderError ? error.statusCode : 500;
    moduleLogger.error('Image generation request failed', {
      error: error instanceof Error ? error.message : String(error),
      statusCode
    });
    res.status(statusCode).json({
      success: false,
      error: error instanceof Error ? error.message : 'Image generation failed',
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/internal/image/edit', async (req, res) => {
  try {
    const data = await imageProvider.edit(req.body || {});
    await recordCodexImageProviderUsage('edit', req.body || {}, data);
    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const statusCode = error instanceof ImageProviderError ? error.statusCode : 500;
    moduleLogger.error('Image edit request failed', {
      error: error instanceof Error ? error.message : String(error),
      statusCode
    });
    res.status(statusCode).json({
      success: false,
      error: error instanceof Error ? error.message : 'Image edit failed',
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/internal/image/prompt-assistant', async (req, res) => {
  try {
    const data = await imagePromptAssistant.compose(req.body || {});
    await recordCodexImagePromptAssistantUsage(req.body || {}, data);
    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    moduleLogger.error('Image prompt assistant request failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Image prompt assistant failed',
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/internal/media/materialize-image', async (req, res) => {
  try {
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object'
      ? req.body.metadata as Record<string, unknown>
      : {};
    const fileId = typeof req.body?.file_id === 'string' && req.body.file_id.trim()
      ? req.body.file_id.trim()
      : typeof metadata.file_id === 'string' && metadata.file_id.trim()
        ? metadata.file_id.trim()
        : '';
    const filename = typeof req.body?.file_name === 'string' && req.body.file_name.trim()
      ? req.body.file_name.trim()
      : typeof metadata.file_name === 'string' && metadata.file_name.trim()
        ? metadata.file_name.trim()
        : null;
    const mimeType = typeof req.body?.mime_type === 'string' && req.body.mime_type.trim()
      ? req.body.mime_type.trim()
      : null;

    if (fileId) {
      const fileInfo = await napcatClient.getFile(fileId);
      const filePath = typeof fileInfo?.file === 'string' && fileInfo.file.trim()
        ? fileInfo.file.trim()
        : typeof fileInfo?.url === 'string' && fileInfo.url.trim()
          ? fileInfo.url.trim()
          : '';
      if (filePath && !/^https?:\/\//i.test(filePath)) {
        const data = await readNapcatFileAsImageDataUrl(filePath, filename || fileInfo?.file_name, mimeType);
        return res.json({
          success: true,
          data: {
            ...data,
            source: 'napcat_file'
          },
          timestamp: new Date().toISOString()
        });
      }
      if (filePath) {
        const data = await fetchImageAsDataUrl(filePath, mimeType);
        return res.json({
          success: true,
          data: {
            ...data,
            source: 'napcat_file_url'
          },
          timestamp: new Date().toISOString()
        });
      }
    }

    const sourceLocator = typeof req.body?.source_locator === 'string' && req.body.source_locator.trim()
      ? req.body.source_locator.trim()
      : typeof req.body?.url === 'string' && req.body.url.trim()
        ? req.body.url.trim()
        : '';
    if (!sourceLocator) {
      return res.status(400).json({
        success: false,
        error: 'Missing source image locator or file_id'
      });
    }
    if (sourceLocator.startsWith(LOCAL_RUNTIME_PICTURE_ROOT + '/')) {
      const image = await readLocalRuntimePicture(sourceLocator, mimeType);
      return res.json({
        success: true,
        data: {
          data_url: toDataUrl(image.buffer, image.mimeType),
          mime_type: image.mimeType,
          bytes: image.buffer.length,
          source: 'local_runtime_file'
        },
        timestamp: new Date().toISOString()
      });
    }
    if (sourceLocator.startsWith('data:')) {
      const parsed = parseImageDataUrl(sourceLocator);
      if (!parsed) {
        return res.status(400).json({
          success: false,
          error: 'Unsupported image data URL'
        });
      }
      return res.json({
        success: true,
        data: {
          data_url: toDataUrl(parsed.buffer, parsed.mimeType),
          mime_type: parsed.mimeType,
          bytes: parsed.buffer.length,
          source: 'data_url'
        },
        timestamp: new Date().toISOString()
      });
    }
    const data = await fetchImageAsDataUrl(sourceLocator, mimeType);
    res.json({
      success: true,
      data: {
        ...data,
        source: 'url'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    moduleLogger.error('Media materialize request failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Media materialize failed',
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/internal/transcript-summary/result', async (req, res) => {
  return respondRuntimeFeatureDisabled(res, 'transcript_summary');
});

app.post('/api/internal/self-evolution/execute', async (req, res) => {
  return respondRuntimeFeatureDisabled(res, 'self_evolution');
});

app.post('/api/internal/topic-projection/execute', async (req, res) => {
  return respondRuntimeFeatureDisabled(res, 'topic_projection');
});

app.post('/api/internal/topic-reviews/apply', async (req, res) => {
  return respondRuntimeFeatureDisabled(res, 'topic_projection');
});

app.post('/api/internal/config-cache/clear', (_req, res) => {
  res.json({
    success: true,
    agentType: 'all',
    timestamp: new Date().toISOString()
  });
});

app.post('/api/internal/chat-policies/check-incoming', async (req, res) => {
  try {
    const messageType = req.body?.message_type === 'group' ? 'group' : 'private';
    const userId = Number(req.body?.user_id);
    const groupId = req.body?.group_id !== undefined ? Number(req.body.group_id) : undefined;

    if (!Number.isFinite(userId) && messageType === 'private') {
      return res.status(400).json({ success: false, error: 'Missing required parameter: user_id' });
    }
    if (messageType === 'group' && !Number.isFinite(groupId)) {
      return res.status(400).json({ success: false, error: 'Missing required parameter: group_id' });
    }

    const policyState = await chatPolicyService.getPolicyState({
      messageType,
      userId: Number.isFinite(userId) ? userId : 0,
      groupId
    });
    const policy = buildIncomingPolicyResult(applyEffectiveInboundPolicy(policyState, {
      messageType,
      userId: Number.isFinite(userId) ? userId : 0
    }));

    res.json({
      success: true,
      data: policy,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to check incoming chat policy',
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/internal/chat-policies/check-auto-reply', async (req, res) => {
  try {
    const messageType = req.body?.message_type === 'group' ? 'group' : 'private';
    const userId = Number(req.body?.user_id);
    const groupId = req.body?.group_id !== undefined ? Number(req.body.group_id) : undefined;

    if (!Number.isFinite(userId) && messageType === 'private') {
      return res.status(400).json({ success: false, error: 'Missing required parameter: user_id' });
    }
    if (messageType === 'group' && !Number.isFinite(groupId)) {
      return res.status(400).json({ success: false, error: 'Missing required parameter: group_id' });
    }

    const policyState = await chatPolicyService.getPolicyState({
      messageType,
      userId: Number.isFinite(userId) ? userId : 0,
      groupId
    });
    const policy = buildAutoReplyPolicyResult(applyEffectiveInboundPolicy(policyState, {
      messageType,
      userId: Number.isFinite(userId) ? userId : 0
    }));

    res.json({
      success: true,
      data: policy,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to check auto reply policy',
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/inbox/stats', async (_req, res) => {
  try {
    const stats = await inboxService.getStats();
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load inbox stats'
    });
  }
});

app.get('/api/simple-queue/stats', async (_req, res) => {
  try {
    const [stats, conversations] = await Promise.all([
      inboxService.getStats(),
      inboxService.listConversations(200, 0)
    ]);

    res.json({
      success: true,
      data: {
        partitions: conversations.length,
        total_conversations: stats.totalConversations,
        total_messages: stats.totalMessages,
        unread_conversations: stats.unreadConversations,
        unread_messages: stats.unreadMessages,
        runtime_unread_messages: stats.runtimeUnreadMessages,
        last_received_at: stats.lastReceivedAt
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load simple queue stats'
    });
  }
});

app.get('/api/simple-queue/partitions', async (_req, res) => {
  try {
    const conversations = await inboxService.listConversations(200, 0);
    res.json({
      success: true,
      data: conversations.map((conversation) => ({
        partition_key: conversation.sessionKey,
        session_key: conversation.sessionKey,
        chat_type: conversation.chatType,
        peer_id: conversation.peerId,
        peer_name: conversation.peerName || null,
        unread_count: conversation.unreadCount,
        total_messages: conversation.totalMessages,
        last_received_at: conversation.lastReceivedAt || null
      })),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load simple queue partitions'
    });
  }
});

app.get('/api/simple-queue/health', async (_req, res) => {
  try {
    const [napcat, stats] = await Promise.all([
      napcatClient.probe(),
      inboxService.getStats()
    ]);
    res.json({
      success: true,
      data: {
        status: 'healthy',
        napcat,
        inbox: stats
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load simple queue health'
    });
  }
});

app.post('/api/simple-queue/simulate/private', async (req, res) => {
  try {
    const result = await simulateSimpleQueueMessage('private', req.body || {});
    res.json({
      success: true,
      data: {
        accepted: true,
        ...result
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to simulate private simple queue message'
    });
  }
});

app.post('/api/simple-queue/simulate/group', async (req, res) => {
  try {
    const result = await simulateSimpleQueueMessage('group', req.body || {});
    res.json({
      success: true,
      data: {
        accepted: true,
        ...result
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to simulate group simple queue message'
    });
  }
});

app.get('/api/inbox/conversations', async (req, res) => {
  try {
    const limit = Number.parseInt(String(req.query.limit || '100'), 10);
    const offset = Number.parseInt(String(req.query.offset || '0'), 10);
    const conversations = await inboxService.listConversations(limit, offset);

    res.json({
      success: true,
      data: conversations
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load inbox conversations'
    });
  }
});

app.get('/api/inbox/conversations/:sessionKey/messages', async (req, res) => {
  try {
    const sessionKey = req.params.sessionKey;
    const includeRead = parseBoolean(req.query.include_read);
    const limit = Number.parseInt(String(req.query.limit || '100'), 10);
    const messages = await inboxService.listConversationMessages({
      sessionKey,
      includeRead,
      limit
    });

    res.json({
      success: true,
      data: messages
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load inbox messages'
    });
  }
});

app.post('/api/inbox/messages/claim', async (req, res) => {
  try {
    const sessionKey = typeof req.body?.session_key === 'string' && req.body.session_key.trim()
      ? req.body.session_key.trim()
      : undefined;
    const limit = Number.parseInt(String(req.body?.limit || '20'), 10);
    const order = req.body?.order === 'latest' ? 'latest' : 'oldest';
    const markRead = req.body?.mark_read === false || req.body?.markRead === false
      ? false
      : undefined;
    const claimed = await inboxService.claimMessages({
      sessionKey,
      limit,
      order,
      markRead
    });

    res.json({
      success: true,
      data: {
        claimed,
        count: claimed.length
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to claim inbox messages'
    });
  }
});

app.post('/api/inbox/simulate', async (req, res) => {
  try {
    const inboundContextInput = req.body?.inboundContext;
    if (!inboundContextInput || typeof inboundContextInput !== 'object' || Array.isArray(inboundContextInput)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required object: inboundContext'
      });
    }

    const finalizedContext = inboxService.finalizeSimulationContext(
      inboundContextInput as Partial<FinalizedInboundContext>,
      String(aiConfig.bot_qq_number)
    );
    const targets = inferPolicyTargets(finalizedContext);
    if (!targets) {
      return res.status(400).json({
        success: false,
        error: 'inboundContext must include ChatType, SenderId and NativeChannelId/session data'
      });
    }

    const policy = await chatPolicyService.getPolicyState({
      messageType: targets.messageType,
      userId: targets.userId,
      groupId: targets.groupId
    });
    const effectivePolicy = applyEffectiveInboundPolicy(policy, {
      messageType: targets.messageType,
      userId: targets.userId,
      wasMentioned: finalizedContext.WasMentioned === true
    });

    await prepareInboundMediaAssets(finalizedContext);
    const result = await inboxService.ingestIncomingMessage({
      inboundContext: finalizedContext,
      rawPayload: (req.body?.rawPayload && typeof req.body.rawPayload === 'object' && !Array.isArray(req.body.rawPayload))
        ? req.body.rawPayload as Record<string, unknown>
        : { simulated: true, inboundContext: finalizedContext },
      traceId: finalizedContext.MessageSid,
      source: 'simulator'
    });
    await persistInboundMediaAssets(finalizedContext, result.event.id, result.traceId);
    rememberInboundContext(recentMessageCache, finalizedContext);

    markIncomingActivityAsync({
      messageType: targets.messageType,
      userId: targets.userId,
      groupId: targets.groupId
    });
    recordRelationshipLedgerAsync(finalizedContext, result.event.id);

    if (!effectivePolicy.isEnabled) {
      const learning = await runContinuousLearningIfEnabled({
        policyState: policy,
        inboxEventId: result.event.id,
        inboundContext: finalizedContext,
        traceId: result.traceId,
        inboxOnly: isInboxOnlyInboundMessage(result.event)
      });
      return res.json({
        success: true,
        data: {
          accepted: true,
          reason: 'receive_disabled',
          policy: {
            ...effectivePolicy,
            allowed: false,
            reason: 'receive_disabled'
          },
          autoReply: {
            attempted: false,
            queued: false,
            reason: 'receive_disabled'
          },
          learning,
          ...result
        }
      });
    }

    const rawPayload = (req.body?.rawPayload && typeof req.body.rawPayload === 'object' && !Array.isArray(req.body.rawPayload))
      ? req.body.rawPayload as Record<string, unknown>
      : { simulated: true, inboundContext: finalizedContext };
    const autoReply = await processAutoReply({
      inboxEvent: result.event,
      inboundContext: finalizedContext,
      rawPayload,
      traceId: result.traceId,
      source: 'simulator',
      policyState: effectivePolicy
    });
    const learning = autoReply.queued
      ? await runContinuousLearningIfEnabled({
          policyState: policy,
          inboxEventId: result.event.id,
          inboundContext: finalizedContext,
          traceId: result.traceId,
          skipMaterialization: true
        })
      : await runContinuousLearningIfEnabled({
          policyState: policy,
          inboxEventId: result.event.id,
          inboundContext: finalizedContext,
          traceId: result.traceId,
          inboxOnly: isInboxOnlyInboundMessage(result.event)
        });

    res.json({
      success: true,
      data: {
        accepted: true,
        policy: {
          ...effectivePolicy,
          allowed: true,
          reason: 'accepted'
        },
        autoReply,
        learning,
        ...result
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to simulate inbound message'
    });
  }
});

app.get('/v1/models', (_req, res) => {
  res.json(embeddingService.listModels());
});

app.post('/v1/embeddings', async (req, res) => {
  try {
    const payload = req.body || {};
    const model = typeof payload.model === 'string' ? payload.model : undefined;
    const input = payload.input;
    const encodingFormat = payload.encoding_format;
    const dimensions = payload.dimensions;

    if (!embeddingService.isEnabled()) {
      return res.status(503).json({
        error: {
          message: 'Embedding service is not enabled',
          type: 'service_unavailable'
        }
      });
    }

    if (!input || (typeof input !== 'string' && !Array.isArray(input))) {
      return res.status(400).json({
        error: {
          message: 'input must be a non-empty string or non-empty array of strings',
          type: 'invalid_request_error'
        }
      });
    }

    if (encodingFormat && encodingFormat !== 'float') {
      return res.status(400).json({
        error: {
          message: 'Only encoding_format="float" is supported',
          type: 'invalid_request_error'
        }
      });
    }

    if (dimensions !== undefined && Number(dimensions) !== embeddingService.getDimensions()) {
      return res.status(400).json({
        error: {
          message: `Only dimensions=${embeddingService.getDimensions()} is supported`,
          type: 'invalid_request_error'
        }
      });
    }

    const response = await embeddingService.createEmbeddings({
      input,
      model,
      user: typeof payload.user === 'string' ? payload.user : undefined
    });
    res.json(response);
  } catch (error) {
    res.status(500).json({
      error: {
        message: error instanceof Error ? error.message : 'Embedding request failed',
        type: 'server_error'
      }
    });
  }
});

app.get('/api/internal/embedding/health', async (_req, res) => {
  try {
    const health = await embeddingService.healthCheck();
    res.json({
      success: true,
      data: health,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Embedding health check failed',
      timestamp: new Date().toISOString()
    });
  }
});

async function startServer() {
  await ensureSelfEvolutionSchema();
  await ensureIdentityLineageSchema();
  await ensureTopicLabSchema();
  await ensureAgentMediaSchema();
  await inboxService.initialize();
  await runtimeStoreService.initialize();
  startGroupNotificationAggregationFlushLoop();

  app.listen(serverConfig.port, serverConfig.host, () => {
    moduleLogger.info('Provider service started', {
      host: serverConfig.host,
      port: serverConfig.port
    });
  });
}

async function flushGroupNotificationAggregationsOnce() {
  if (groupNotificationAggregationFlushBusy) {
    return;
  }
  groupNotificationAggregationFlushBusy = true;
  try {
    const dueItems = await runtimeStoreService.claimDueGroupNotificationAggregations(20);
    for (const item of dueItems) {
      try {
        const message = item.message as unknown as SemanticInboundMessage;
        const queueResult = await runtimeStoreService.enqueueSemanticMessage(message);
        await runtimeStoreService.cancelGroupNotificationAggregation(item.sessionKey);
        await runtimeStoreService.logTimelineEvent({
          traceId: message.traceId,
          eventType: 'phone_notification',
          eventName: 'group_aggregation.flush',
          eventPhase: 'end',
          metadata: {
            session_key: item.sessionKey,
            queue_id: queueResult.queueId,
            queue_status: queueResult.status,
            unread_delta: item.unreadDelta,
            due_at: item.dueAt
          }
        });
      } catch (error) {
        moduleLogger.warn('Failed to flush QQ group notification aggregation', {
          sessionKey: item.sessionKey,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } catch (error) {
    moduleLogger.warn('Failed to claim QQ group notification aggregations', {
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    groupNotificationAggregationFlushBusy = false;
  }
}

function startGroupNotificationAggregationFlushLoop() {
  if (groupNotificationAggregationFlushTimer) {
    return;
  }
  groupNotificationAggregationFlushTimer = setInterval(() => {
    void flushGroupNotificationAggregationsOnce();
  }, GROUP_NOTIFICATION_AGGREGATION_FLUSH_INTERVAL_MS);
  void flushGroupNotificationAggregationsOnce();
}

async function shutdown(signal: string) {
  moduleLogger.info('Shutting down provider service', { signal });
  if (groupNotificationAggregationFlushTimer) {
    clearInterval(groupNotificationAggregationFlushTimer);
    groupNotificationAggregationFlushTimer = null;
  }
  await inboxService.close().catch((error) => {
    moduleLogger.warn('Failed to close inbox service cleanly', {
      error: error instanceof Error ? error.message : String(error)
    });
  });
  await runtimeStoreService.close().catch((error) => {
    moduleLogger.warn('Failed to close runtime store cleanly', {
      error: error instanceof Error ? error.message : String(error)
    });
  });
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

startServer().catch((error) => {
  moduleLogger.error('Failed to start provider service', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
