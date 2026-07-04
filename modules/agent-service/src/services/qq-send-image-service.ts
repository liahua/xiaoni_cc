import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

type FetchResponseLike = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<FetchResponseLike>;

// 出站传输压缩:把「上线给 NapCat 的那一份」转成 webp 省流量。铁律(见 docs/XIAONI_SEND_IMAGE_WEBP_PLAN.md §4):
// 转码产物只允许流向 data_url,绝不进 archiveSentImage / result.mime_type / result.image_path，
// 否则回看画质、local-image-visibility(PNG-only)、看图 fork 历史理解三条读路会被打穿。
export type WebpEncodeMode = 'lossless' | 'lossy';
// input 原始图字节 → webp 字节。抛错/返回空 = 编码器不可用，上层回退原图。可注入以便测试与将来换 sharp。
export type WebpEncoder = (input: Buffer, mode: WebpEncodeMode) => Promise<Buffer>;

const CWEBP_TIMEOUT_MS = 15000;

// 默认编码器:shell 到 cwebp(libwebp-tools)。用临时文件而非 stdin —— cwebp 解 PNG/JPEG 需要可 seek 输入，
// 管道不可 seek 会失败;临时文件确定可靠，用完即删。容器缺 cwebp 时抛错，toWireImage 回退原图。
export function defaultCwebpEncoder(input: Buffer, mode: WebpEncodeMode): Promise<Buffer> {
  return (async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'xn-webp-'));
    const inPath = path.join(dir, 'in');
    const outPath = path.join(dir, 'out.webp');
    try {
      await fs.writeFile(inPath, input);
      await new Promise<void>((resolve, reject) => {
        const args = mode === 'lossless'
          ? ['-quiet', '-lossless', inPath, '-o', outPath]
          : ['-quiet', '-q', '80', inPath, '-o', outPath];
        const child = spawn('cwebp', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('cwebp timeout'));
        }, CWEBP_TIMEOUT_MS);
        timer.unref?.();
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`cwebp exit ${code}: ${stderr.slice(0, 200)}`));
        });
      });
      return await fs.readFile(outPath);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  })();
}

export type QqSendImageActionContext = {
  traceId?: string | null;
  runId?: string | null;
  batchId?: string | null;
  toolCallId?: string | null;
  toolName?: string | null;
  sessionKey?: string | null;
};

export type QqSendImageToolResult = {
  qq_send_image: true;
  action: string;
  content: string;
  failed?: boolean;
  status_key?: string;
  message_id?: string | null;
  // 已发送图片的解析后本地路径 + mime，供上层把它注册成可 inspect 的 media asset（回看用）。
  image_path?: string;
  // 持久归档副本路径（/xiaoni-runtime/picture/outbound 下）；上层优先用它做 source_locator，
  // 保证重启/清理后 inspect 仍可解。
  archived_path?: string;
  mime_type?: string;
};

export type QqSendImageServiceOptions = {
  providerServiceUrl?: string;
  runtimeRoot?: string;
  statusDir?: string;
  allowedRoots?: string[];
  maxBytes?: number;
  fetchImpl?: FetchLike;
  webpEncoder?: WebpEncoder;
  // 出站 webp 转码总开关,默认关 = wire 走原图 PNG/JPEG。用户 2026-07-04 定:QQ 最终收到的统一是 PNG,
  // 省流量的转码交给工程内部消化、小腻侧无感(她图源本就是 PNG,停转码即发 PNG,零额外解码)。
  // 缘由:PNG→webp 后部分 QQ 客户端(PC/桌面端)不渲染收到的 webp(手机端能),为省沟通成本统一 PNG。
  // 保留编码器代码,想开只翻环境变量 XIAONI_SEND_IMAGE_WEBP。
  webpEnabled?: boolean;
  // 每次发送记一行:源→wire 字节、压了还是回退。关闭「静默回退」盲点(默认 no-op，测试静默)。
  logImageSend?: (message: string, fields: Record<string, unknown>) => void;
};

// 只有显式 1/true/on/yes 才开启;缺省、空串、其它一律关(默认发原图 PNG)。
function parseWebpEnabledEnv(value: string | undefined): boolean {
  return /^(1|true|on|yes)$/i.test((value ?? '').trim());
}

type SendMode = 'private' | 'group';

type StatusRecord = {
  status_key: string;
  status: 'pending' | 'sent' | 'failed' | 'unknown';
  mode: SendMode;
  target_id: string;
  image_path: string;
  caption: string;
  caption_sent: boolean;
  updated_at: string;
  started_at?: string;
  mime_type?: string;
  bytes?: number;
  message_id?: string | null;
  reason?: string;
  provider_response?: unknown;
};

const DEFAULT_RUNTIME_ROOT = '/xiaoni-runtime';
const STATUS_DIR_NAME = 'qq-send-image-status';
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

const QQ_SEND_IMAGE_ACTION_LABELS: Record<string, string> = {
  send_group: 'qq_send_image.send_group',
  send_private: 'qq_send_image.send_private',
  check: 'qq_send_image.check'
};

function escapeXmlAttr(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlText(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTaggedBlock(tag: string, attrs: Record<string, unknown>, body = '') {
  const renderedAttrs = Object.entries(attrs)
    .filter(([, value]) => value !== null && typeof value !== 'undefined' && value !== '')
    .map(([key, value]) => `${key}="${escapeXmlAttr(value)}"`)
    .join(' ');
  const open = renderedAttrs ? `<${tag} ${renderedAttrs}>` : `<${tag}>`;
  return body ? `${open}\n${escapeXmlText(body)}\n</${tag}>` : `${open}</${tag}>`;
}

function normalizeIdentifier(value: unknown) {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function firstNonEmptyString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function normalizeCaption(caption: unknown) {
  return typeof caption === 'string' ? caption.trim() : '';
}

function utcNowIso() {
  return new Date().toISOString();
}

function statusKey(mode: SendMode, targetId: string, imagePath: string, caption = '') {
  const payload = {
    mode,
    target_id: targetId.trim(),
    image_path: imagePath.trim(),
    caption: normalizeCaption(caption)
  };
  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 32);
}

function safeStatusFileName(key: string) {
  const safeKey = Array.from(String(key))
    .filter((ch) => /[A-Za-z0-9_-]/.test(ch))
    .join('')
    .slice(0, 80);
  return `${safeKey || 'invalid'}.json`;
}

function isPathInside(child: string, root: string) {
  const relative = path.relative(root, child);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseRootsEnv(value: string) {
  return value
    .replace(/,/g, path.delimiter)
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
}

function parseQqNumber(value: unknown, label: string) {
  const raw = normalizeIdentifier(value);
  if (!raw) {
    throw new Error(`${label} is required`);
  }
  if (raw.startsWith('qq:')) {
    throw new Error(`${label} must be a plain QQ id, not an internal QQ thread key`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive QQ number`);
  }
  return { raw, value: parsed };
}

function getGroupId(args: Record<string, unknown>) {
  return args.group_id ?? args.groupId ?? args.target_id ?? args.targetId;
}

function getUserId(args: Record<string, unknown>) {
  return args.user_id ?? args.userId ?? args.target_id ?? args.targetId;
}

function getImagePath(args: Record<string, unknown>) {
  return firstNonEmptyString(args.image_path, args.imagePath);
}

function getMode(args: Record<string, unknown>): SendMode | '' {
  const mode = firstNonEmptyString(args.mode).toLowerCase();
  return mode === 'private' || mode === 'group' ? mode : '';
}

function extractMessageId(providerResponse: unknown) {
  if (!providerResponse || typeof providerResponse !== 'object' || Array.isArray(providerResponse)) {
    return null;
  }
  const candidates: Array<Record<string, unknown>> = [providerResponse as Record<string, unknown>];
  const data = (providerResponse as Record<string, unknown>).data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    candidates.push(data as Record<string, unknown>);
  }
  for (const candidate of candidates) {
    for (const field of ['message_id', 'messageId', 'id']) {
      const value = candidate[field];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    }
  }
  return null;
}

function mimeToExt(mimeType: string): string {
  switch (mimeType) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    default: return 'png';
  }
}

function sniffMime(data: Buffer) {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return 'image/gif';
  }
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  throw new Error('unsupported image format');
}

export class QqSendImageService {
  private readonly providerServiceUrl: string;
  private readonly runtimeRoot: string;
  private readonly explicitStatusDir?: string;
  private readonly explicitAllowedRoots?: string[];
  private readonly maxBytes: number;
  private readonly fetchImpl: FetchLike;
  private readonly webpEncoder: WebpEncoder;
  private readonly webpEnabled: boolean;
  private readonly logImageSend: (message: string, fields: Record<string, unknown>) => void;

  constructor(options: QqSendImageServiceOptions = {}) {
    this.providerServiceUrl = (options.providerServiceUrl || process.env.PROVIDER_SERVICE_URL || 'http://127.0.0.1:8091').replace(/\/$/, '');
    this.runtimeRoot = options.runtimeRoot || process.env.XIAONI_RUNTIME_ROOT || DEFAULT_RUNTIME_ROOT;
    this.explicitStatusDir = options.statusDir || process.env.QQ_SEND_IMAGE_STATUS_DIR || undefined;
    this.explicitAllowedRoots = options.allowedRoots;
    this.maxBytes = options.maxBytes || Number.parseInt(process.env.QQ_SEND_IMAGE_MAX_BYTES || '', 10) || DEFAULT_MAX_BYTES;
    this.fetchImpl = options.fetchImpl || fetch;
    this.webpEncoder = options.webpEncoder || defaultCwebpEncoder;
    this.webpEnabled = options.webpEnabled ?? parseWebpEnabledEnv(process.env.XIAONI_SEND_IMAGE_WEBP);
    this.logImageSend = options.logImageSend || (() => {});
  }

  // 只转 wire 那一份:PNG→无损 webp、JPEG→有损 q80;GIF(可能动图)/已 webp/其它一律原样。
  // 编码失败、转完更大、返回空 —— 全部回退原图。绝不改动传入 data(调用方仍用原图归档)。
  private async toWireImage(data: Buffer, mimeType: string): Promise<{ data: Buffer; mimeType: string }> {
    // 总开关关闭(默认) → 原图上线,绝不转 webp。QQ 统一收 PNG,小腻侧无感(见 options.webpEnabled 注释)。
    if (!this.webpEnabled) {
      return { data, mimeType };
    }
    let mode: WebpEncodeMode;
    if (mimeType === 'image/png') {
      mode = 'lossless';
    } else if (mimeType === 'image/jpeg') {
      mode = 'lossy';
    } else {
      return { data, mimeType };
    }
    try {
      const encoded = await this.webpEncoder(data, mode);
      if (!encoded || encoded.length === 0 || encoded.length >= data.length) {
        return { data, mimeType };
      }
      return { data: encoded, mimeType: 'image/webp' };
    } catch {
      return { data, mimeType };
    }
  }

  private statusDir() {
    return this.explicitStatusDir || path.join(this.runtimeRoot, STATUS_DIR_NAME);
  }

  private statusPath(key: string) {
    return path.join(this.statusDir(), safeStatusFileName(key));
  }

  private async configuredAllowedRoots() {
    const rawRoots = this.explicitAllowedRoots && this.explicitAllowedRoots.length > 0
      ? this.explicitAllowedRoots
      : parseRootsEnv(process.env.QQ_SEND_IMAGE_ALLOWED_ROOTS || '') || [];
    const rootsToUse = rawRoots.length > 0 ? rawRoots : [this.runtimeRoot];
    const roots: string[] = [];
    const seen = new Set<string>();
    for (const rawRoot of rootsToUse) {
      try {
        const resolved = await fs.realpath(rawRoot);
        const stat = await fs.stat(resolved);
        if (!stat.isDirectory() || seen.has(resolved)) continue;
        roots.push(resolved);
        seen.add(resolved);
      } catch {
        continue;
      }
    }
    if (roots.length === 0) {
      throw new Error('no readable image roots are configured');
    }
    return roots;
  }

  private async resolveImagePath(inputPath: string) {
    const roots = await this.configuredAllowedRoots();
    const candidate = path.isAbsolute(inputPath) ? inputPath : path.join(roots[0], inputPath);
    const resolved = await fs.realpath(candidate);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      throw new Error('image_path must point to a file');
    }
    if (roots.some((root) => isPathInside(resolved, root))) {
      return resolved;
    }
    throw new Error(`image_path must be under one of the configured image roots: ${roots.join(', ')}`);
  }

  private async resolveExistingPath(inputPath: string) {
    try {
      return await fs.realpath(inputPath);
    } catch {
      return inputPath;
    }
  }

  // 把发出去的图按内容哈希存一份到持久归档目录，返回归档路径。内容哈希 → 同图幂等、不重复占空间。
  // 目录在 picture 根下（provider 的 materialize-image 只读 LOCAL_RUNTIME_PICTURE_ROOT），
  // 且 /xiaoni-runtime 是 host bind mount，重启容器不丢。
  private async archiveSentImage(data: Buffer, mimeType: string): Promise<string> {
    const dir = path.join(this.runtimeRoot, 'picture', 'outbound');
    await fs.mkdir(dir, { recursive: true });
    const hash = createHash('sha256').update(data).digest('hex').slice(0, 32);
    const ext = mimeToExt(mimeType);
    const dest = path.join(dir, `${hash}.${ext}`);
    try {
      await fs.access(dest);
    } catch {
      await fs.writeFile(dest, data);
    }
    return dest;
  }

  private async readImage(imagePath: string) {
    const stat = await fs.stat(imagePath);
    if (stat.size <= 0) {
      throw new Error('image file is empty');
    }
    if (stat.size > this.maxBytes) {
      throw new Error(`image file is too large: ${stat.size} bytes > ${this.maxBytes} bytes`);
    }
    const data = await fs.readFile(imagePath);
    return {
      data,
      mimeType: sniffMime(data),
      size: stat.size
    };
  }

  private buildStatusRecord(mode: SendMode, targetId: string, imagePath: string, caption = '', status: StatusRecord['status'] = 'pending', extra: Partial<StatusRecord> = {}): StatusRecord {
    const now = utcNowIso();
    return {
      status_key: statusKey(mode, targetId, imagePath, caption),
      status,
      mode,
      target_id: targetId,
      image_path: imagePath,
      caption: normalizeCaption(caption),
      caption_sent: Boolean(normalizeCaption(caption)),
      updated_at: now,
      started_at: extra.started_at || now,
      ...extra
    };
  }

  private async writeStatus(record: StatusRecord) {
    try {
      await fs.mkdir(this.statusDir(), { recursive: true });
      const statusPath = this.statusPath(record.status_key);
      const tmpPath = `${statusPath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(record), 'utf8');
      await fs.rename(tmpPath, statusPath);
    } catch {
      // Status is best-effort; sending should not fail because local bookkeeping failed.
    }
  }

  private async readStatus(key: string) {
    try {
      const payload = JSON.parse(await fs.readFile(this.statusPath(key), 'utf8'));
      return payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as StatusRecord
        : null;
    } catch {
      return null;
    }
  }

  private async findStatusByMessageId(messageId: string) {
    if (!messageId.trim()) return null;
    try {
      const names = await fs.readdir(this.statusDir());
      const records = await Promise.all(names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          const filePath = path.join(this.statusDir(), name);
          try {
            return { filePath, mtimeMs: (await fs.stat(filePath)).mtimeMs };
          } catch {
            return null;
          }
        }));
      const newest = records
        .filter((record): record is { filePath: string; mtimeMs: number } => Boolean(record))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 500);
      for (const record of newest) {
        try {
          const payload = JSON.parse(await fs.readFile(record.filePath, 'utf8')) as Record<string, unknown>;
          if (String(payload.message_id || '').trim() === messageId.trim()) {
            return payload as StatusRecord;
          }
        } catch {
          continue;
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  private async providerPost(mode: SendMode, payload: Record<string, unknown>) {
    const endpoint = mode === 'private' ? '/api/internal/send_private_image' : '/api/internal/send_group_image';
    const response = await this.fetchImpl(`${this.providerServiceUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const raw = await response.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    } catch {
      throw new Error(`provider-service returned non-JSON response: ${raw.slice(0, 500)}`);
    }
    if (!response.ok || parsed.success === false) {
      throw new Error(String(parsed.error || `provider-service returned HTTP ${response.status}`));
    }
    return parsed;
  }

  private async sendImage(mode: SendMode, target: { raw: string; value: number }, imagePathArg: string, captionArg: unknown, context: QqSendImageActionContext): Promise<QqSendImageToolResult> {
    let statusRecord: StatusRecord | null = null;
    try {
      const imagePath = await this.resolveImagePath(imagePathArg);
      const image = await this.readImage(imagePath);
      const caption = normalizeCaption(captionArg);
      statusRecord = this.buildStatusRecord(mode, target.raw, imagePath, caption, 'pending', {
        mime_type: image.mimeType,
        bytes: image.size
      });
      await this.writeStatus(statusRecord);

      // 传输压缩:只有发给 NapCat 的 data_url 用 webp;归档/mime_type/image_path 一律保持原图(见 §4 铁律)。
      const wire = await this.toWireImage(image.data, image.mimeType);
      const wireTranscoded = wire.mimeType !== image.mimeType;
      // per-send 观察:压了还是静默回退,一眼可辨(见方案 §7)。
      this.logImageSend('qq_send_image wire prepared', {
        mode,
        source_mime: image.mimeType,
        source_bytes: image.size,
        wire_mime: wire.mimeType,
        wire_bytes: wire.data.length,
        transcoded: wireTranscoded,
        saved_bytes: wireTranscoded ? image.size - wire.data.length : 0
      });
      const targetField = mode === 'private' ? 'user_id' : 'group_id';
      const payload: Record<string, unknown> = {
        [targetField]: target.value,
        data_url: `data:${wire.mimeType};base64,${wire.data.toString('base64')}`
      };
      if (caption) {
        payload.caption = caption;
      }
      if (mode === 'group' && context.sessionKey) {
        payload.session_key = context.sessionKey;
      }

      const providerResponse = await this.providerPost(mode, payload);
      const messageId = extractMessageId(providerResponse);
      const sentRecord: StatusRecord = {
        ...statusRecord,
        status: 'sent',
        updated_at: utcNowIso(),
        message_id: messageId,
        provider_response: providerResponse
      };
      await this.writeStatus(sentRecord);

      // 耐久性：把她发出去的图拷进持久归档目录（/xiaoni-runtime/picture/outbound，host bind mount，
      // 重启容器不丢）。inspect 用这份归档做 source_locator，原图被清理/覆盖也不影响回看。最佳努力。
      let archivedPath: string | undefined;
      try {
        archivedPath = await this.archiveSentImage(image.data, image.mimeType);
      } catch {
        archivedPath = undefined;
      }

      const content = formatTaggedBlock('QQ_IMAGE_SEND_RESULT', {
        success: 'true',
        [targetField]: target.value,
        image_path: imagePath,
        mime_type: image.mimeType,
        bytes: image.size,
        caption_sent: String(Boolean(caption)),
        status_key: statusRecord.status_key,
        message_id: messageId
      }, mode === 'private' ? '图片已发送到 QQ 私聊。' : '图片已发送到 QQ 群。');
      return {
        qq_send_image: true,
        action: `qq_send_image.send_${mode === 'private' ? 'private' : 'group'}`,
        content,
        status_key: statusRecord.status_key,
        message_id: messageId,
        image_path: imagePath,
        archived_path: archivedPath,
        mime_type: image.mimeType
      };
    } catch (error) {
      if (statusRecord) {
        await this.writeStatus({
          ...statusRecord,
          status: 'failed',
          updated_at: utcNowIso(),
          reason: error instanceof Error ? error.message : String(error)
        });
      }
      throw error;
    }
  }

  async sendGroup(args: Record<string, unknown>, context: QqSendImageActionContext = {}) {
    const group = parseQqNumber(getGroupId(args), 'group_id');
    const imagePath = getImagePath(args);
    if (!imagePath) throw new Error('image_path is required');
    return this.sendImage('group', group, imagePath, args.caption, context);
  }

  async sendPrivate(args: Record<string, unknown>, context: QqSendImageActionContext = {}) {
    const user = parseQqNumber(getUserId(args), 'user_id');
    const imagePath = getImagePath(args);
    if (!imagePath) throw new Error('image_path is required');
    return this.sendImage('private', user, imagePath, args.caption, context);
  }

  async check(args: Record<string, unknown>): Promise<QqSendImageToolResult> {
    const messageId = firstNonEmptyString(args.message_id, args.messageId);
    let key = firstNonEmptyString(args.status_key, args.statusKey);
    const mode = getMode(args);
    const targetId = firstNonEmptyString(args.target_id, args.targetId, args.user_id, args.userId, args.group_id, args.groupId);
    const rawImagePath = getImagePath(args);
    const imagePath = rawImagePath ? await this.resolveExistingPath(rawImagePath) : '';

    let record = messageId ? await this.findStatusByMessageId(messageId) : null;
    if (!record && key) {
      record = await this.readStatus(key);
    }
    if (!record && !key && mode && targetId && imagePath) {
      key = statusKey(mode, targetId, imagePath, normalizeCaption(args.caption));
      record = await this.readStatus(key);
    }

    if (!record) {
      const reason = !messageId && !key && !(mode && targetId && imagePath)
        ? '需要提供 --message-id、--status-key，或完整的 mode target_id image_path。'
        : '没有找到这次图片发送的本地状态记录。';
      return {
        qq_send_image: true,
        action: 'qq_send_image.check',
        content: formatTaggedBlock('QQ_IMAGE_SEND_STATUS', {
          status: 'unknown',
          mode,
          target_id: targetId,
          image_path: imagePath,
          status_key: key,
          message_id: messageId
        }, reason),
        failed: false
      };
    }

    const status = record.status || 'unknown';
    const content = formatTaggedBlock('QQ_IMAGE_SEND_STATUS', {
      status,
      mode: record.mode || mode,
      target_id: record.target_id || targetId,
      image_path: record.image_path || imagePath,
      caption_sent: String(Boolean(record.caption_sent)),
      status_key: record.status_key || key,
      message_id: record.message_id,
      updated_at: record.updated_at,
      reason: status === 'failed' ? record.reason || 'unknown' : undefined
    }, status === 'sent'
      ? '图片已提交到 QQ 发送链路。'
      : status === 'failed'
        ? '图片发送失败。'
        : status === 'pending'
          ? '图片发送命令已经启动，但本地状态还没有记录到成功或失败。'
          : '图片发送状态未知。');
    return {
      qq_send_image: true,
      action: 'qq_send_image.check',
      content,
      failed: false,
      status_key: record.status_key,
      message_id: record.message_id
    };
  }

  error(action: string, args: Record<string, unknown>, reason: string): QqSendImageToolResult {
    return {
      qq_send_image: true,
      action,
      failed: true,
      content: formatTaggedBlock('QQ_IMAGE_SEND_ERROR', {
        action,
        arguments: JSON.stringify(args),
        reason
      })
    };
  }
}

export class QqSendImageSkillRuntime {
  constructor(private readonly service: QqSendImageService) {}

  async execute(action: string, args: Record<string, unknown> = {}, context: QqSendImageActionContext = {}): Promise<QqSendImageToolResult> {
    try {
      if (action === 'send_group') {
        return await this.service.sendGroup(args, context);
      }
      if (action === 'send_private') {
        return await this.service.sendPrivate(args, context);
      }
      if (action === 'check') {
        return await this.service.check(args);
      }
      throw new Error(`Unsupported qq_send_image action: ${action}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.service.error(QQ_SEND_IMAGE_ACTION_LABELS[action] || `qq_send_image.${action || 'unknown'}`, args, message);
    }
  }
}
