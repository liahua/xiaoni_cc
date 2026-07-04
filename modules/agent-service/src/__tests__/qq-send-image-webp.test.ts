import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QqSendImageService, WebpEncodeMode } from '../services/qq-send-image-service';

// 出站 webp 转码专项:钉死「转码只进 data_url,不进归档/mime/path」这条铁律
// (docs/XIAONI_SEND_IMAGE_WEBP_PLAN.md §4)。守住则回看/local-image-visibility/看图 fork 历史理解三条读路零影响。

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff]);
const GIF_SIG = Buffer.from('GIF89a', 'ascii');
const WEBP_HEAD = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4, 0), Buffer.from('WEBP', 'ascii')]);

type Harness = {
  postedDataUrl: string | null;
  encoderCalls: Array<{ mode: WebpEncodeMode; inputLen: number }>;
  logs: Array<{ message: string; fields: Record<string, unknown> }>;
  result: Awaited<ReturnType<QqSendImageService['sendPrivate']>>;
};

async function sendWith(opts: {
  source: Buffer;
  ext: string;
  encoder: (input: Buffer, mode: WebpEncodeMode) => Promise<Buffer>;
}): Promise<Harness & { runtimeRoot: string; source: Buffer; srcPath: string }> {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qqimg-webp-'));
  const srcDir = path.join(runtimeRoot, 'gen');
  await fs.mkdir(srcDir, { recursive: true });
  const srcPath = path.join(srcDir, `sent.${opts.ext}`);
  await fs.writeFile(srcPath, opts.source);

  const encoderCalls: Array<{ mode: WebpEncodeMode; inputLen: number }> = [];
  const logs: Array<{ message: string; fields: Record<string, unknown> }> = [];
  let postedDataUrl: string | null = null;

  const service = new QqSendImageService({
    runtimeRoot,
    allowedRoots: [runtimeRoot],
    // 这组用例专测「webp 开启时」的编码器行为,显式打开总开关(生产默认关 = 发原图 PNG,见下方 default-off 用例)。
    webpEnabled: true,
    logImageSend: (message, fields) => { logs.push({ message, fields }); },
    webpEncoder: async (input: Buffer, mode: WebpEncodeMode) => {
      encoderCalls.push({ mode, inputLen: input.length });
      return opts.encoder(input, mode);
    },
    fetchImpl: (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { data_url?: string };
      postedDataUrl = typeof body.data_url === 'string' ? body.data_url : null;
      return { ok: true, text: async () => JSON.stringify({ success: true, data: { message_id: 7 } }) };
    }) as any
  });

  const result = await service.sendPrivate({ user_id: 85178516, image_path: srcPath });
  return { postedDataUrl, encoderCalls, logs, result, runtimeRoot, source: opts.source, srcPath };
}

function decodeDataUrl(dataUrl: string): { mime: string; bytes: Buffer } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  assert.ok(m, `data_url shape: ${dataUrl.slice(0, 40)}`);
  return { mime: m![1], bytes: Buffer.from(m![2], 'base64') };
}

test('PNG source: wire is lossless webp, archive+mime stay original PNG', async () => {
  const png = Buffer.concat([PNG_SIG, Buffer.alloc(512, 9)]); // 大一点，保证 webp 更小
  const webp = Buffer.from('FAKE-LOSSLESS-WEBP', 'ascii');
  const h = await sendWith({ source: png, ext: 'png', encoder: async () => webp });
  try {
    // ① wire = webp
    const wire = decodeDataUrl(h.postedDataUrl!);
    assert.equal(wire.mime, 'image/webp', 'NapCat 收到的是 webp');
    assert.deepEqual(wire.bytes, webp, 'wire 字节 = 编码器输出');
    // ② 编码器按无损模式被调用
    assert.deepEqual(h.encoderCalls, [{ mode: 'lossless', inputLen: png.length }]);
    // ③ 铁律:result.mime_type 仍是原图
    assert.equal(h.result.mime_type, 'image/png', 'mime_type 不泄漏 webp');
    // ④ 铁律:归档 = 原图字节，扩展名 = png
    assert.ok(h.result.archived_path!.endsWith('.png'), '归档扩展名 = png');
    const archived = await fs.readFile(h.result.archived_path!);
    assert.deepEqual(archived, png, '归档是原图逐字节副本(回看/local-image-visibility 读它)');
  } finally {
    await fs.rm(h.runtimeRoot, { recursive: true, force: true });
  }
});

test('JPEG source: encoder invoked in lossy mode', async () => {
  const jpeg = Buffer.concat([JPEG_SIG, Buffer.alloc(512, 3)]);
  const webp = Buffer.from('FAKE-LOSSY-WEBP', 'ascii');
  const h = await sendWith({ source: jpeg, ext: 'jpg', encoder: async () => webp });
  try {
    assert.deepEqual(h.encoderCalls, [{ mode: 'lossy', inputLen: jpeg.length }]);
    assert.equal(decodeDataUrl(h.postedDataUrl!).mime, 'image/webp');
    assert.equal(h.result.mime_type, 'image/jpeg', 'mime_type 仍原图');
  } finally {
    await fs.rm(h.runtimeRoot, { recursive: true, force: true });
  }
});

test('fallback: encoder output not smaller -> keep original bytes on the wire', async () => {
  const png = Buffer.concat([PNG_SIG, Buffer.alloc(16, 1)]);
  const bigger = Buffer.alloc(png.length + 100, 2);
  const h = await sendWith({ source: png, ext: 'png', encoder: async () => bigger });
  try {
    const wire = decodeDataUrl(h.postedDataUrl!);
    assert.equal(wire.mime, 'image/png', '转完更大 -> 回退原图');
    assert.deepEqual(wire.bytes, png);
  } finally {
    await fs.rm(h.runtimeRoot, { recursive: true, force: true });
  }
});

test('fallback: encoder throws (e.g. cwebp missing) -> keep original bytes on the wire', async () => {
  const png = Buffer.concat([PNG_SIG, Buffer.alloc(512, 5)]);
  const h = await sendWith({ source: png, ext: 'png', encoder: async () => { throw new Error('cwebp not found'); } });
  try {
    const wire = decodeDataUrl(h.postedDataUrl!);
    assert.equal(wire.mime, 'image/png', '编码器不可用 -> 回退原图，绝不因压缩发不出去');
    assert.deepEqual(wire.bytes, png);
    assert.equal(h.result.mime_type, 'image/png');
  } finally {
    await fs.rm(h.runtimeRoot, { recursive: true, force: true });
  }
});

test('skip GIF (maybe animated): passthrough, encoder not called', async () => {
  const gif = Buffer.concat([GIF_SIG, Buffer.alloc(64, 4)]);
  const h = await sendWith({ source: gif, ext: 'gif', encoder: async () => { throw new Error('should not encode gif'); } });
  try {
    assert.deepEqual(h.encoderCalls, [], 'gif 不进编码器(保动画)');
    const wire = decodeDataUrl(h.postedDataUrl!);
    assert.equal(wire.mime, 'image/gif');
    assert.deepEqual(wire.bytes, gif);
  } finally {
    await fs.rm(h.runtimeRoot, { recursive: true, force: true });
  }
});

test('per-send observability: log carries source/wire bytes + transcoded flag', async () => {
  // 转码成功
  const png = Buffer.concat([PNG_SIG, Buffer.alloc(1000, 9)]);
  const webp = Buffer.from('SMALL-WEBP', 'ascii');
  const ok = await sendWith({ source: png, ext: 'png', encoder: async () => webp });
  try {
    assert.equal(ok.logs.length, 1, '每次发送恰好一条 wire 日志');
    const f = ok.logs[0].fields;
    assert.equal(f.transcoded, true, 'transcoded=true');
    assert.equal(f.source_mime, 'image/png');
    assert.equal(f.source_bytes, png.length);
    assert.equal(f.wire_mime, 'image/webp');
    assert.equal(f.wire_bytes, webp.length);
    assert.equal(f.saved_bytes, png.length - webp.length, 'saved = 源 - wire');
  } finally {
    await fs.rm(ok.runtimeRoot, { recursive: true, force: true });
  }
  // 静默回退也要能一眼看出
  const gif = Buffer.concat([GIF_SIG, Buffer.alloc(32, 4)]);
  const fb = await sendWith({ source: gif, ext: 'gif', encoder: async () => { throw new Error('nope'); } });
  try {
    assert.equal(fb.logs[0].fields.transcoded, false, '回退/跳过 -> transcoded=false 可辨');
    assert.equal(fb.logs[0].fields.saved_bytes, 0);
  } finally {
    await fs.rm(fb.runtimeRoot, { recursive: true, force: true });
  }
});

test('skip already-webp: passthrough, encoder not called', async () => {
  const webpSrc = Buffer.concat([WEBP_HEAD, Buffer.alloc(64, 6)]);
  const h = await sendWith({ source: webpSrc, ext: 'webp', encoder: async () => { throw new Error('should not re-encode webp'); } });
  try {
    assert.deepEqual(h.encoderCalls, [], '已是 webp 不重编码');
    const wire = decodeDataUrl(h.postedDataUrl!);
    assert.equal(wire.mime, 'image/webp');
    assert.deepEqual(wire.bytes, webpSrc);
  } finally {
    await fs.rm(h.runtimeRoot, { recursive: true, force: true });
  }
});

// 回归钉:webp 总开关默认关(生产态)。用户 2026-07-04 定 QQ 统一收 PNG(PNG→webp 后部分 QQ 客户端
// 不渲染收到的 webp)。默认必须原图 PNG 上线,编码器绝不被调用。
test('webp disabled by default: PNG passthrough, encoder NOT called, wire=original PNG', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qqimg-webp-off-'));
  const srcDir = path.join(runtimeRoot, 'gen');
  await fs.mkdir(srcDir, { recursive: true });
  const png = Buffer.concat([PNG_SIG, Buffer.alloc(1024, 7)]);
  const srcPath = path.join(srcDir, 'sent.png');
  await fs.writeFile(srcPath, png);

  let encoderCalled = false;
  let postedDataUrl: string | null = null;
  const service = new QqSendImageService({
    runtimeRoot,
    allowedRoots: [runtimeRoot],
    // webpEnabled 缺省 → 走环境变量,测试环境未设 → 关。绝不注入 webpEnabled。
    webpEncoder: async () => { encoderCalled = true; return Buffer.from('SHOULD-NOT-RUN'); },
    fetchImpl: (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { data_url?: string };
      postedDataUrl = typeof body.data_url === 'string' ? body.data_url : null;
      return { ok: true, text: async () => JSON.stringify({ success: true, data: { message_id: 7 } }) };
    }) as any
  });

  try {
    const result = await service.sendPrivate({ user_id: 85178516, image_path: srcPath });
    assert.equal(encoderCalled, false, '默认关:编码器绝不被调用');
    const wire = decodeDataUrl(postedDataUrl!);
    assert.equal(wire.mime, 'image/png', '默认关:wire = 原图 PNG,不是 webp');
    assert.deepEqual(wire.bytes, png, 'wire 字节 = 原图逐字节');
    assert.equal(result.mime_type, 'image/png');
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

// 环境变量/选项显式打开时仍能转码(保留能力,不是删死)。
test('webp enabled via option: PNG transcodes to webp (capability retained)', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qqimg-webp-on-'));
  const srcDir = path.join(runtimeRoot, 'gen');
  await fs.mkdir(srcDir, { recursive: true });
  const png = Buffer.concat([PNG_SIG, Buffer.alloc(1024, 7)]);
  const srcPath = path.join(srcDir, 'sent.png');
  await fs.writeFile(srcPath, png);

  let postedDataUrl: string | null = null;
  const service = new QqSendImageService({
    runtimeRoot,
    allowedRoots: [runtimeRoot],
    webpEnabled: true,
    webpEncoder: async () => Buffer.from('SMALL-WEBP', 'ascii'),
    fetchImpl: (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { data_url?: string };
      postedDataUrl = typeof body.data_url === 'string' ? body.data_url : null;
      return { ok: true, text: async () => JSON.stringify({ success: true, data: { message_id: 7 } }) };
    }) as any
  });

  try {
    await service.sendPrivate({ user_id: 85178516, image_path: srcPath });
    assert.equal(decodeDataUrl(postedDataUrl!).mime, 'image/webp', '显式开启 → wire = webp');
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});
