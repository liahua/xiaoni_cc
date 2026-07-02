import express from 'express';
import request from 'supertest';
import winston from 'winston';
import axios from 'axios';
import { createAgentRuntimeRoutes } from '../routes/agent-runtime-routes';
import {
  buildStackTracePayload,
  buildStackTraceSpanDetail,
  buildStackRawProviderTrace
} from '../services/trace-span-builder';
import {
  enqueueAgentQueueMessage,
  extractPassiveRecallCuesFromActionStream,
  findXiaoniActionEventTraceTarget,
  getAgentLifeState,
  getAgentRuntimeControl,
  getLatestUnreadAgentInboundMessage,
  getXiaoniActionStream,
  getXiaoniLlmUsageTimeline,
  listAgentLifeEvents,
  listAgentRecoverySessions,
  listToolExecutions,
  updateAgentRuntimeControl
} from '@qq-bot/persistence';

jest.mock('axios');

jest.mock('@qq-bot/persistence', () => ({
  enqueueAgentQueueMessage: jest.fn(),
  extractPassiveRecallCuesFromActionStream: jest.fn(),
  getXiaoniActionStream: jest.fn(),
  getXiaoniActivityFeed: jest.fn(),
  getXiaoniLlmUsageTimeline: jest.fn(),
  getAgentLifeState: jest.fn(),
  getAgentRuntimeControl: jest.fn(),
  getLatestUnreadAgentInboundMessage: jest.fn(),
  findXiaoniActionEventTraceTarget: jest.fn(),
  listAgentLifeEvents: jest.fn(),
  listAgentMediaAssets: jest.fn(),
  listAgentRecoverySessions: jest.fn(),
  listToolExecutions: jest.fn(),
  listAgentTasks: jest.fn(),
  updateAgentRuntimeControl: jest.fn()
}));

jest.mock('../services/trace-span-builder', () => ({
  buildStackTracePayload: jest.fn(),
  buildStackTraceSpanDetail: jest.fn(),
  buildStackRawProviderTrace: jest.fn()
}));

function createLogger(): winston.Logger {
  return winston.createLogger({ silent: true });
}

function createDatabaseMock() {
  return {
    executeQuery: jest.fn()
  };
}

function createApp(database: ReturnType<typeof createDatabaseMock>) {
  const app = express();
  app.use(express.json());
  app.use('/api', createAgentRuntimeRoutes(database as never, createLogger()));
  return app;
}

describe('agent runtime control routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the full runtime control state', async () => {
    const database = createDatabaseMock();
    (getAgentRuntimeControl as jest.Mock).mockResolvedValueOnce({
      identityKey: 'xiaoni',
      enabled: true,
      cacheHeartbeatPaused: true,
      cacheHeartbeatPausedAt: '2026-06-13T20:00:00.000+08:00',
      postCompressionPauseArmed: true,
      postCompressionPauseArmedAt: '2026-06-13T20:00:00.000+08:00',
      postCompressionPauseTriggeredAt: null,
      postCompressionPauseReason: null,
      mainAgentPreModelYieldMs: 5000,
      compressionTriggerInputTokens: 80000,
      updatedAt: '2026-06-13T20:00:00.000+08:00'
    });

    const response = await request(createApp(database))
      .get('/api/agent-runtime/control');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.cacheHeartbeatPaused).toBe(true);
    expect(response.body.data.postCompressionPauseArmed).toBe(true);
    expect(response.body.data.mainAgentPreModelYieldMs).toBe(5000);
    expect(response.body.data.compressionTriggerInputTokens).toBe(80000);
    expect(getAgentRuntimeControl).toHaveBeenCalledWith({ identityKey: 'xiaoni' });
  });

  it('patches enabled without changing the delayed pause switch', async () => {
    const database = createDatabaseMock();
    (updateAgentRuntimeControl as jest.Mock).mockResolvedValueOnce({
      identityKey: 'xiaoni',
      enabled: false,
      cacheHeartbeatPaused: false,
      cacheHeartbeatPausedAt: null,
      postCompressionPauseArmed: true,
      postCompressionPauseArmedAt: '2026-06-13T20:00:00.000+08:00',
      postCompressionPauseTriggeredAt: null,
      postCompressionPauseReason: null,
      mainAgentPreModelYieldMs: 5000,
      updatedAt: '2026-06-13T20:01:00.000+08:00'
    });

    const response = await request(createApp(database))
      .patch('/api/agent-runtime/control')
      .send({ enabled: false });

    expect(response.status).toBe(200);
    expect(updateAgentRuntimeControl).toHaveBeenCalledWith({
      identityKey: 'xiaoni',
      enabled: false
    });
    expect(response.body.data.enabled).toBe(false);
  });

  it('patches cache heartbeat pause without pausing the main runtime', async () => {
    const database = createDatabaseMock();
    (updateAgentRuntimeControl as jest.Mock).mockResolvedValueOnce({
      identityKey: 'xiaoni',
      enabled: true,
      cacheHeartbeatPaused: true,
      cacheHeartbeatPausedAt: '2026-06-13T20:02:00.000+08:00',
      postCompressionPauseArmed: false,
      postCompressionPauseArmedAt: null,
      postCompressionPauseTriggeredAt: null,
      postCompressionPauseReason: null,
      mainAgentPreModelYieldMs: 5000,
      updatedAt: '2026-06-13T20:02:00.000+08:00'
    });

    const response = await request(createApp(database))
      .patch('/api/agent-runtime/control')
      .send({ cacheHeartbeatPaused: true });

    expect(response.status).toBe(200);
    expect(updateAgentRuntimeControl).toHaveBeenCalledWith({
      identityKey: 'xiaoni',
      cacheHeartbeatPaused: true
    });
    expect(response.body.data.enabled).toBe(true);
    expect(response.body.data.cacheHeartbeatPaused).toBe(true);
  });

  it('patches delayed pause without implicitly resuming runtime', async () => {
    const database = createDatabaseMock();
    (updateAgentRuntimeControl as jest.Mock).mockResolvedValueOnce({
      identityKey: 'xiaoni',
      enabled: false,
      cacheHeartbeatPaused: false,
      cacheHeartbeatPausedAt: null,
      postCompressionPauseArmed: true,
      postCompressionPauseArmedAt: '2026-06-13T20:00:00.000+08:00',
      postCompressionPauseTriggeredAt: null,
      postCompressionPauseReason: null,
      mainAgentPreModelYieldMs: 5000,
      updatedAt: '2026-06-13T20:01:00.000+08:00'
    });

    const response = await request(createApp(database))
      .patch('/api/agent-runtime/control')
      .send({ postCompressionPauseArmed: true });

    expect(response.status).toBe(200);
    expect(updateAgentRuntimeControl).toHaveBeenCalledWith({
      identityKey: 'xiaoni',
      postCompressionPauseArmed: true
    });
    expect(response.body.data.enabled).toBe(false);
  });

  it('patches the main agent pre-model yield in milliseconds', async () => {
    const database = createDatabaseMock();
    (updateAgentRuntimeControl as jest.Mock).mockResolvedValueOnce({
      identityKey: 'xiaoni',
      enabled: true,
      cacheHeartbeatPaused: false,
      cacheHeartbeatPausedAt: null,
      postCompressionPauseArmed: false,
      postCompressionPauseArmedAt: null,
      postCompressionPauseTriggeredAt: null,
      postCompressionPauseReason: null,
      mainAgentPreModelYieldMs: 125,
      updatedAt: '2026-06-13T20:03:00.000+08:00'
    });

    const response = await request(createApp(database))
      .patch('/api/agent-runtime/control')
      .send({ mainAgentPreModelYieldMs: 125 });

    expect(response.status).toBe(200);
    expect(updateAgentRuntimeControl).toHaveBeenCalledWith({
      identityKey: 'xiaoni',
      mainAgentPreModelYieldMs: 125
    });
    expect(response.body.data.mainAgentPreModelYieldMs).toBe(125);
  });

  it('rejects invalid main agent pre-model yield values', async () => {
    const database = createDatabaseMock();

    const response = await request(createApp(database))
      .patch('/api/agent-runtime/control')
      .send({ mainAgentPreModelYieldMs: -1 });

    expect(response.status).toBe(400);
    expect(updateAgentRuntimeControl).not.toHaveBeenCalled();
  });

  it('manually recovers Xiaoni by enqueueing a phone notification from the latest unread inbox message', async () => {
    const database = createDatabaseMock();
    (updateAgentRuntimeControl as jest.Mock).mockResolvedValueOnce({
      identityKey: 'xiaoni',
      enabled: true,
      cacheHeartbeatPaused: true,
      cacheHeartbeatPausedAt: '2026-06-25T00:00:00.000+08:00'
    });
    (getLatestUnreadAgentInboundMessage as jest.Mock).mockResolvedValueOnce({
      id: 42,
      trace_id: 'evt_42',
      message_sid: 'qq-msg-42',
      chat_type: 'group',
      session_key: 'qq:group:100',
      peer_id: '100',
      peer_name: '测试群',
      sender_id: '200',
      sender_name: 'Alice',
      account_id: '1129974489',
      received_at: '2026-06-25T00:00:00.000+08:00',
      body_for_agent: 'hello',
      raw_body: 'hello',
      command_body: 'hello',
      was_mentioned: 0,
      inbound_context: {
        ChatType: 'group',
        SessionKey: 'qq:group:100'
      }
    });
    (enqueueAgentQueueMessage as jest.Mock).mockResolvedValueOnce({
      queueId: 17818,
      status: 'pending',
      attempts: 0
    });

    const response = await request(createApp(database))
      .post('/api/agent-runtime/recover-now')
      .send({});

    expect(response.status).toBe(200);
    expect(updateAgentRuntimeControl).toHaveBeenCalledWith({
      identityKey: 'xiaoni',
      enabled: true
    });
    expect(getLatestUnreadAgentInboundMessage).toHaveBeenCalledWith({});
    expect(enqueueAgentQueueMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({
        source: 'phone_notification',
        sessionKey: 'qq:group:100',
        rawPayload: expect.objectContaining({
          reason: 'manual_recover_after_provider_outage',
          source_message_id: 42
        })
      }),
      payload: expect.objectContaining({
        source: 'phone_notification',
        sessionKey: 'qq:group:100'
      }),
      availableAt: expect.any(Date)
    }));
    expect(response.body.data.queue.queueId).toBe(17818);
    expect(response.body.data.sourceInboundMessage.id).toBe(42);
    expect(response.body.data.recovery.unpausedCacheHeartbeat).toBe(false);
    expect(response.body.data.control.cacheHeartbeatPaused).toBe(true);
  });

  it('only unpauses Xiaoni cache heartbeat during manual recovery when explicitly requested', async () => {
    const database = createDatabaseMock();
    (updateAgentRuntimeControl as jest.Mock).mockResolvedValueOnce({
      identityKey: 'xiaoni',
      enabled: true,
      cacheHeartbeatPaused: false,
      cacheHeartbeatPausedAt: null
    });
    (getLatestUnreadAgentInboundMessage as jest.Mock).mockResolvedValueOnce({
      id: 43,
      trace_id: 'evt_43',
      message_sid: 'qq-msg-43',
      chat_type: 'group',
      session_key: 'qq:group:100',
      peer_id: '100',
      peer_name: '测试群',
      sender_id: '200',
      sender_name: 'Alice',
      account_id: '1129974489',
      received_at: '2026-06-25T00:01:00.000+08:00',
      body_for_agent: 'recover',
      raw_body: 'recover',
      command_body: 'recover',
      was_mentioned: 0,
      inbound_context: {
        ChatType: 'group',
        SessionKey: 'qq:group:100'
      }
    });
    (enqueueAgentQueueMessage as jest.Mock).mockResolvedValueOnce({
      queueId: 17819,
      status: 'pending',
      attempts: 0
    });

    const response = await request(createApp(database))
      .post('/api/agent-runtime/recover-now')
      .send({ unpauseCacheHeartbeat: true });

    expect(response.status).toBe(200);
    expect(updateAgentRuntimeControl).toHaveBeenCalledWith({
      identityKey: 'xiaoni',
      enabled: true,
      cacheHeartbeatPaused: false
    });
    expect(response.body.data.recovery.unpausedCacheHeartbeat).toBe(true);
  });

  it('returns conflict when manual recovery has no unread inbox message to wake from', async () => {
    const database = createDatabaseMock();
    (updateAgentRuntimeControl as jest.Mock).mockResolvedValueOnce({
      identityKey: 'xiaoni',
      enabled: true,
      cacheHeartbeatPaused: false
    });
    (getLatestUnreadAgentInboundMessage as jest.Mock).mockResolvedValueOnce(null);

    const response = await request(createApp(database))
      .post('/api/agent-runtime/recover-now')
      .send({ sessionKey: 'qq:group:100' });

    expect(response.status).toBe(409);
    expect(response.body.success).toBe(false);
    expect(getLatestUnreadAgentInboundMessage).toHaveBeenCalledWith({
      sessionKey: 'qq:group:100'
    });
    expect(enqueueAgentQueueMessage).not.toHaveBeenCalled();
  });

  it('proxies prompt force-load requests to agent-service', async () => {
    const database = createDatabaseMock();
    (axios.post as jest.Mock).mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        result: {
          invalidated: true,
          had_pending_reload: false,
          reason: 'manual_force_load'
        }
      }
    });

    const response = await request(createApp(database))
      .post('/api/agent-runtime/prompt/reload')
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.invalidated).toBe(true);
    expect(axios.post).toHaveBeenCalledWith(
      'http://qqbot-agent-service:8092/api/internal/runtime/prompt/reload',
      {},
      expect.objectContaining({
        timeout: 5000
      })
    );
  });

  it('returns agent-service prompt force-load failures', async () => {
    const database = createDatabaseMock();
    (axios.post as jest.Mock).mockResolvedValueOnce({
      status: 503,
      data: {
        success: false,
        error: 'agent-service unavailable'
      }
    });

    const response = await request(createApp(database))
      .post('/api/agent-runtime/prompt/reload')
      .send({});

    expect(response.status).toBe(503);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('agent-service unavailable');
  });

  it('patches the debug cache heartbeat interval in milliseconds', async () => {
    const database = createDatabaseMock();
    (updateAgentRuntimeControl as jest.Mock).mockResolvedValueOnce({
      identityKey: 'xiaoni',
      enabled: false,
      cacheHeartbeatPaused: false,
      cacheHeartbeatPausedAt: null,
      postCompressionPauseArmed: false,
      postCompressionPauseArmedAt: null,
      postCompressionPauseTriggeredAt: null,
      postCompressionPauseReason: null,
      mainAgentPreModelYieldMs: 5000,
      debugCacheHeartbeatIntervalMs: 60000,
      updatedAt: '2026-06-13T20:04:00.000+08:00'
    });

    const response = await request(createApp(database))
      .patch('/api/agent-runtime/control')
      .send({ debugCacheHeartbeatIntervalMs: 60000 });

    expect(response.status).toBe(200);
    expect(updateAgentRuntimeControl).toHaveBeenCalledWith({
      identityKey: 'xiaoni',
      debugCacheHeartbeatIntervalMs: 60000
    });
    expect(response.body.data.debugCacheHeartbeatIntervalMs).toBe(60000);
  });

  it('rejects invalid debug cache heartbeat interval values', async () => {
    const database = createDatabaseMock();

    const response = await request(createApp(database))
      .patch('/api/agent-runtime/control')
      .send({ debugCacheHeartbeatIntervalMs: -1 });

    expect(response.status).toBe(400);
    expect(updateAgentRuntimeControl).not.toHaveBeenCalled();
  });

  it('patches the compression trigger input tokens', async () => {
    const database = createDatabaseMock();
    (updateAgentRuntimeControl as jest.Mock).mockResolvedValueOnce({
      identityKey: 'xiaoni',
      enabled: true,
      cacheHeartbeatPaused: false,
      cacheHeartbeatPausedAt: null,
      postCompressionPauseArmed: false,
      postCompressionPauseArmedAt: null,
      postCompressionPauseTriggeredAt: null,
      postCompressionPauseReason: null,
      mainAgentPreModelYieldMs: 5000,
      debugCacheHeartbeatIntervalMs: 0,
      compressionTriggerInputTokens: 120000,
      updatedAt: '2026-06-13T20:05:00.000+08:00'
    });

    const response = await request(createApp(database))
      .patch('/api/agent-runtime/control')
      .send({ compressionTriggerInputTokens: 120000 });

    expect(response.status).toBe(200);
    expect(updateAgentRuntimeControl).toHaveBeenCalledWith({
      identityKey: 'xiaoni',
      compressionTriggerInputTokens: 120000
    });
    expect(response.body.data.compressionTriggerInputTokens).toBe(120000);
  });

  it('rejects compression trigger input tokens below the lower bound', async () => {
    const database = createDatabaseMock();

    const response = await request(createApp(database))
      .patch('/api/agent-runtime/control')
      .send({ compressionTriggerInputTokens: 5000 });

    expect(response.status).toBe(400);
    expect(updateAgentRuntimeControl).not.toHaveBeenCalled();
  });

  it('rejects compression trigger input tokens above the upper bound', async () => {
    const database = createDatabaseMock();

    const response = await request(createApp(database))
      .patch('/api/agent-runtime/control')
      .send({ compressionTriggerInputTokens: 2000000 });

    expect(response.status).toBe(400);
    expect(updateAgentRuntimeControl).not.toHaveBeenCalled();
  });

  it('rejects non-integer compression trigger input tokens', async () => {
    const database = createDatabaseMock();

    const response = await request(createApp(database))
      .patch('/api/agent-runtime/control')
      .send({ compressionTriggerInputTokens: 'lots' });

    expect(response.status).toBe(400);
    expect(updateAgentRuntimeControl).not.toHaveBeenCalled();
  });

  it('proxies one-shot cache heartbeat triggers to agent-service', async () => {
    const database = createDatabaseMock();
    (axios.post as jest.Mock).mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        result: {
          triggered: true,
          cachedInputTokens: 123456,
          runId: 'run-abc'
        }
      }
    });

    const response = await request(createApp(database))
      .post('/api/agent-runtime/cache-heartbeat/trigger')
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.triggered).toBe(true);
    expect(response.body.data.cachedInputTokens).toBe(123456);
    expect(axios.post).toHaveBeenCalledWith(
      'http://qqbot-agent-service:8092/api/internal/runtime/cache-heartbeat',
      {},
      expect.objectContaining({
        timeout: 120000
      })
    );
  });

  it('returns agent-service cache heartbeat trigger failures', async () => {
    const database = createDatabaseMock();
    (axios.post as jest.Mock).mockResolvedValueOnce({
      status: 500,
      data: {
        success: false,
        error: 'heartbeat request builder unavailable'
      }
    });

    const response = await request(createApp(database))
      .post('/api/agent-runtime/cache-heartbeat/trigger')
      .send({});

    expect(response.status).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('heartbeat request builder unavailable');
  });
});

describe('agent runtime recovery session routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists recover energy sessions and exposes the active session', async () => {
    const database = createDatabaseMock();
    (axios.get as jest.Mock).mockResolvedValueOnce({
      status: 200,
      data: {
        status: 'healthy',
        service: 'agent-service',
        worker_busy: false,
        task_worker_busy: false,
        presence_tick_busy: false,
        runtime_enabled: true,
        timestamp: '2026-06-13T00:00:00.000Z'
      }
    });
    (listAgentRecoverySessions as jest.Mock).mockResolvedValueOnce([
      {
        id: 88,
        identityKey: 'xiaoni',
        status: 'active',
        reason: '累了',
        startedAt: '2026-06-13T00:00:00.000Z',
        lastCheckedAt: '2026-06-13T00:05:00.000Z',
        startEnergy: 0.62,
        currentEnergy: 0.72,
        maxEnergy: 1
      },
      {
        id: 87,
        identityKey: 'xiaoni',
        status: 'completed',
        reason: '自然醒',
        startedAt: '2026-06-12T23:00:00.000Z',
        endedAt: '2026-06-12T23:00:00.080Z',
        startEnergy: 0.42,
        currentEnergy: 0.92,
        maxEnergy: 1,
        result: {
          sleep_minutes: 30
        }
      }
    ]);
    (getAgentLifeState as jest.Mock).mockResolvedValueOnce({
      identity_key: 'xiaoni',
      projection_json: {
        generatedAt: '2026-06-13T00:15:00.000Z',
        state: {
          energy: 0.87,
          actionCost: 0.13
        }
      },
      explanation_json: {
        summary: '当前精力=0.87'
      },
      projection_updated_at: '2026-06-13T00:15:00.000Z',
      updated_at: '2026-06-13T00:15:00.000Z'
    });
    (listAgentLifeEvents as jest.Mock).mockResolvedValueOnce([
      {
        id: '9200',
        identityKey: 'xiaoni',
        eventKind: 'surface_visit',
        occurredAt: '2026-06-13T00:10:00.000Z',
        actionCost: 0.01,
        payload: {}
      }
    ]);
    (listToolExecutions as jest.Mock).mockResolvedValueOnce([
      {
        id: '701',
        executionId: 'tool:recover:rejected',
        identityKey: 'xiaoni',
        toolCallId: 'call-rejected',
        toolName: 'recover_energy',
        arguments: { reason: '还想睡一会儿' },
        result: {
          rest_rejected: true,
          reason: '现在还没到可以休息的线：当前精力 0.870/1.000，刚醒不久或精力还够时很难再次入睡。',
          energy: 0.87,
          max_energy: 1,
          pressure: 0.13,
          required_pressure: 0.5
        },
        status: 'completed',
        startedAt: '2026-06-13T00:12:00.000Z',
        completedAt: '2026-06-13T00:12:01.000Z'
      }
    ]).mockResolvedValueOnce([
      {
        id: '701',
        executionId: 'tool:recover:rejected',
        identityKey: 'xiaoni',
        toolCallId: 'call-rejected',
        toolName: 'recover_energy',
        arguments: { reason: '还想睡一会儿' },
        result: {
          rest_rejected: true,
          reason: '现在还没到可以休息的线：当前精力 0.870/1.000，刚醒不久或精力还够时很难再次入睡。',
          energy: 0.87,
          max_energy: 1,
          pressure: 0.13,
          required_pressure: 0.5
        },
        status: 'completed',
        startedAt: '2026-06-13T00:12:00.000Z',
        completedAt: '2026-06-13T00:12:01.000Z'
      }
    ]);

    const response = await request(createApp(database))
      .get('/api/agent-runtime/recovery-sessions?identity_key=xiaoni&status=all&limit=40');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(listAgentRecoverySessions).toHaveBeenCalledWith({
      identityKey: 'xiaoni',
      status: 'all',
      limit: 40
    });
    expect(getAgentLifeState).toHaveBeenCalledWith('xiaoni');
    expect(getXiaoniActionStream).not.toHaveBeenCalled();
    expect(listAgentLifeEvents).toHaveBeenCalledWith({
      identityKey: 'xiaoni',
      occurredAfter: expect.any(Date),
      occurredBefore: expect.any(Date),
      chronological: true,
      limit: 1000
    });
    expect(listToolExecutions).toHaveBeenNthCalledWith(1, {
      identityKey: 'xiaoni',
      toolName: 'recover_energy',
      occurredAfter: expect.any(Date),
      chronological: true,
      limit: 1000
    });
    expect(listToolExecutions).toHaveBeenNthCalledWith(2, {
      identityKey: 'xiaoni',
      toolName: 'recover_energy',
      limit: 21,
      offset: 0
    });
    expect(response.body.data.active.id).toBe(88);
    expect(response.body.data.sessions).toHaveLength(2);
    expect(response.body.data.recoverEnergyRequests.summary).toMatchObject({
      total: 1,
      rejected: 1,
      accepted: 0
    });
    expect(response.body.data.recoverEnergyRequests.pagination).toMatchObject({
      limit: 20,
      offset: 0,
      hasMore: false,
      nextOffset: null,
      previousOffset: null,
      sort: 'started_at_desc'
    });
    expect(response.body.data.recoverEnergyRequests.requests[0]).toMatchObject({
      status: 'rejected',
      restRejected: true,
      reason: expect.stringContaining('现在还没到可以休息的线'),
      requestedReason: '还想睡一会儿',
      energy: 0.87,
      requiredPressure: 0.5
    });
    expect(response.body.data.current.lifeState.projection.state.energy).toBe(0.87);
    expect(response.body.data.recentExperience).toBeUndefined();
    expect(response.body.data.energyTimeline.points.length).toBeGreaterThan(0);
    expect(response.body.data.energyTimeline.points).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'session_end',
          recoverySessionId: 87,
          timestamp: '2026-06-12T23:00:00.080Z'
        }),
        expect.objectContaining({
          kind: 'recover_energy_rejected',
          label: '拒绝休息',
          restRejected: true,
          rejectionReason: expect.stringContaining('现在还没到可以休息的线'),
          timestamp: '2026-06-13T00:12:00.000Z'
        })
      ])
    );
    expect(response.body.data.energyTimeline.summary.latestEnergy).toBe(0.87);
    expect(response.body.data.runtime.live).toBe(true);
    expect(response.body.data.current.runtime.live).toBe(true);
    expect(database.executeQuery).not.toHaveBeenCalled();
  });

  it('paginates and time filters recover energy request rows independently of the timeline', async () => {
    const database = createDatabaseMock();
    (axios.get as jest.Mock).mockResolvedValueOnce({
      status: 200,
      data: {
        status: 'healthy',
        service: 'agent-service',
        runtime_enabled: true,
        timestamp: '2026-06-13T00:00:00.000Z'
      }
    });
    (listAgentRecoverySessions as jest.Mock).mockResolvedValueOnce([]);
    (getAgentLifeState as jest.Mock).mockResolvedValueOnce(null);
    (listAgentLifeEvents as jest.Mock).mockResolvedValueOnce([]);
    (listToolExecutions as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: '703',
          executionId: 'tool:recover:newer',
          identityKey: 'xiaoni',
          toolCallId: 'call-newer',
          toolName: 'recover_energy',
          arguments: { reason: '困' },
          result: { recovery_session_requested: true, energy_start: 0.2, max_energy: 1 },
          status: 'completed',
          startedAt: '2026-06-13T08:00:00.000Z',
          completedAt: '2026-06-13T08:00:01.000Z'
        },
        {
          id: '702',
          executionId: 'tool:recover:older',
          identityKey: 'xiaoni',
          toolCallId: 'call-older',
          toolName: 'recover_energy',
          arguments: { reason: '累' },
          result: { rest_rejected: true, energy: 0.8, max_energy: 1 },
          status: 'completed',
          startedAt: '2026-06-13T07:00:00.000Z',
          completedAt: '2026-06-13T07:00:01.000Z'
        },
        {
          id: '701',
          executionId: 'tool:recover:extra',
          identityKey: 'xiaoni',
          toolCallId: 'call-extra',
          toolName: 'recover_energy',
          arguments: {},
          result: {},
          status: 'completed',
          startedAt: '2026-06-13T06:00:00.000Z',
          completedAt: '2026-06-13T06:00:01.000Z'
        }
      ]);

    const response = await request(createApp(database))
      .get('/api/agent-runtime/recovery-sessions?request_limit=2&request_offset=4&request_from=2026-06-13T06:00:00.000Z&request_to=2026-06-13T09:00:00.000Z');

    expect(response.status).toBe(200);
    expect(listToolExecutions).toHaveBeenNthCalledWith(2, {
      identityKey: 'xiaoni',
      toolName: 'recover_energy',
      startTime: new Date('2026-06-13T06:00:00.000Z'),
      endTime: new Date('2026-06-13T09:00:00.000Z'),
      limit: 3,
      offset: 4
    });
    expect(response.body.data.recoverEnergyRequests.requests).toHaveLength(2);
    expect(response.body.data.recoverEnergyRequests.requests.map((item: any) => item.toolExecutionId)).toEqual([
      'tool:recover:newer',
      'tool:recover:older'
    ]);
    expect(response.body.data.recoverEnergyRequests.pagination).toMatchObject({
      limit: 2,
      offset: 4,
      hasMore: true,
      nextOffset: 6,
      previousOffset: 2,
      sort: 'started_at_desc',
      filters: {
        from: '2026-06-13T06:00:00.000Z',
        to: '2026-06-13T09:00:00.000Z'
      }
    });
  });
});

describe('agent runtime action stream route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes multi-select tag filters to the Xiaoni action stream query', async () => {
    const database = createDatabaseMock();
    (axios.get as jest.Mock).mockResolvedValueOnce({
      status: 200,
      data: {
        status: 'healthy',
        service: 'agent-service',
        worker_busy: false,
        task_worker_busy: false,
        presence_tick_busy: false,
        runtime_enabled: true,
        timestamp: '2026-06-13T00:00:00.000Z'
      }
    });
    (getXiaoniActionStream as jest.Mock).mockResolvedValueOnce({
      identityKey: 'xiaoni',
      generatedAt: '2026-06-13T00:00:00.000Z',
      streamKind: 'xiaoni_action_stream',
      filters: {
        tags: ['source:llm_request', 'event:model_tool_request', 'status:ok']
      },
      availableTags: [],
      current: {
        latestActivityAt: null
      },
      focusedEventId: null,
      items: [],
      compressionForkTimeline: { runs: [] },
      imageVisionForkTimeline: { runs: [] }
    });

    const response = await request(createApp(database))
      .get('/api/xiaoni/action-stream')
      .query({
        range: 'custom',
        start_time: '2026-06-13T00:00:00+08:00',
        end_time: '2026-06-13T02:00:00+08:00',
        tags: ['Source:LLM_Request,event:model_tool_request', 'status:ok']
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(getXiaoniActionStream).toHaveBeenCalledWith({
      identityKey: 'xiaoni',
      limit: 80,
      startTime: new Date('2026-06-13T00:00:00+08:00'),
      endTime: new Date('2026-06-13T02:00:00+08:00'),
      beforeTime: null,
      tags: ['source:llm_request', 'event:model_tool_request', 'status:ok'],
      focusEvent: null,
      focusSlice: null
    });
    expect(response.body.data.filters).toEqual({
      tags: ['source:llm_request', 'event:model_tool_request', 'status:ok'],
      range: 'custom',
      startTime: '2026-06-12T16:00:00.000Z',
      endTime: '2026-06-12T18:00:00.000Z'
    });
  });

  it('passes cursor pagination to the Xiaoni action stream query', async () => {
    const database = createDatabaseMock();
    (axios.get as jest.Mock).mockResolvedValueOnce({
      status: 200,
      data: {
        status: 'healthy',
        service: 'agent-service',
        worker_busy: false,
        task_worker_busy: false,
        presence_tick_busy: false,
        runtime_enabled: true,
        timestamp: '2026-06-13T00:00:00.000Z'
      }
    });
    (getXiaoniActionStream as jest.Mock).mockResolvedValueOnce({
      identityKey: 'xiaoni',
      generatedAt: '2026-06-13T00:00:00.000Z',
      streamKind: 'xiaoni_action_stream',
      filters: {},
      availableTags: [],
      pagination: {
        limit: 40,
        hasMore: true,
        nextCursor: '2026-06-12T12:00:00.000Z'
      },
      current: {
        latestActivityAt: null
      },
      focusedEventId: null,
      items: [],
      compressionForkTimeline: { runs: [] },
      imageVisionForkTimeline: { runs: [] }
    });

    const response = await request(createApp(database))
      .get('/api/xiaoni/action-stream')
      .query({
        limit: 40,
        range: 'all',
        before_time: '2026-06-12T12:30:00.000Z'
      });

    expect(response.status).toBe(200);
    expect(getXiaoniActionStream).toHaveBeenCalledWith({
      identityKey: 'xiaoni',
      limit: 40,
      startTime: null,
      endTime: null,
      beforeTime: new Date('2026-06-12T12:30:00.000Z'),
      tags: [],
      focusEvent: null,
      focusSlice: null
    });
    expect(response.body.data.pagination).toEqual({
      limit: 40,
      hasMore: true,
      nextCursor: '2026-06-12T12:00:00.000Z'
    });
  });

  it('returns passive recall shadow cues without exposing IM body as memory text', async () => {
    const database = createDatabaseMock();
    (extractPassiveRecallCuesFromActionStream as jest.Mock).mockReturnValueOnce([{
      cueClass: 'db_life_cue',
      itemId: 'tool-exec:qq-1',
      source: 'tool_execution',
      kind: 'exec_command',
      timestamp: '2026-06-24T12:00:00.000Z',
      toolName: 'exec_command',
      qqUsage: {
        mode: 'focus_private',
        peerId: '2294133947'
      },
      runtimePaths: [],
      features: [
        'skill:qq_usage',
        'im:focus_private',
        'peer:2294133947'
      ],
      privacyScope: 'transient_private',
      memoryCandidate: null,
      safeEmbeddingText: 'xiaoni qq usage cue mode focus_private peer 2294133947'
    }]);
    (getXiaoniActionStream as jest.Mock).mockResolvedValueOnce({
      identityKey: 'xiaoni',
      generatedAt: '2026-06-24T12:00:00.000Z',
      streamKind: 'xiaoni_action_stream',
      filters: {},
      availableTags: [],
      pagination: {
        limit: 20,
        hasMore: false,
        nextCursor: null
      },
      current: {
        latestActivityAt: '2026-06-24T12:00:00.000Z'
      },
      focusedEventId: null,
      items: [{
        id: 'tool-exec:qq-1',
        source: 'tool_execution',
        kind: 'exec_command',
        title: 'tool: exec_command',
        body: '<IM_INBOX_WINDOW>用户说：我今天看了一部电影</IM_INBOX_WINDOW>',
        timestamp: '2026-06-24T12:00:00.000Z',
        metadata: {
          toolName: 'exec_command',
          toolArgumentsPreview: JSON.stringify({
            cmd: 'python3 /app/modules/agent-service/skills/qq-usage/scripts/qq_usage.py focus_private 2294133947'
          }),
          toolResultPreview: '<IM_INBOX_WINDOW>用户说：我今天看了一部电影</IM_INBOX_WINDOW>'
        },
        tags: [
          { key: 'source:tool_execution' },
          { key: 'tool:exec_command' }
        ]
      }],
      compressionForkTimeline: { runs: [] },
      imageVisionForkTimeline: { runs: [] }
    });

    const response = await request(createApp(database))
      .get('/api/xiaoni/passive-recall/shadow-cues')
      .query({
        limit: 20,
        range: '24h',
        include_files: '0'
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(getXiaoniActionStream).toHaveBeenCalledWith({
      identityKey: 'xiaoni',
      limit: 20,
      startTime: expect.any(Date),
      endTime: expect.any(Date),
      beforeTime: null,
      tags: [],
      focusEvent: null,
      focusSlice: null
    });
    expect(extractPassiveRecallCuesFromActionStream).toHaveBeenCalledTimes(1);
    expect(response.body.data.streamKind).toBe('xiaoni_passive_recall_shadow_cues');
    expect(response.body.data.deliveryMode).toBe('shadow_only');
    expect(response.body.data.counts).toEqual({
      db_life_cue: 1,
      file_shadow_candidate: 0
    });
    expect(response.body.data.sources.runtimeFiles.available).toBe(false);
    expect(response.body.data.fileCandidates).toEqual([]);
    expect(response.body.data.cues[0].cueClass).toBe('db_life_cue');
    expect(response.body.data.cues[0].features).toEqual(expect.arrayContaining([
      'skill:qq_usage',
      'im:focus_private',
      'peer:2294133947'
    ]));
    expect(response.body.data.cues[0].safeEmbeddingText).toContain('xiaoni qq usage cue');
    expect(response.body.data.cues[0].safeEmbeddingText).not.toContain('我今天看了一部电影');
  });
});

describe('agent runtime action event trace routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads Xiaoni LLM usage timeline with bucket and time filters', async () => {
    const database = createDatabaseMock();
    (getXiaoniLlmUsageTimeline as jest.Mock).mockResolvedValueOnce({
      identityKey: 'xiaoni',
      generatedAt: '2026-06-13T00:00:00.000Z',
      timezone: 'Asia/Shanghai',
      requestedBucket: 'hour',
      bucket: 'hour',
      maxPoints: 500,
      downsampled: false,
      warnings: [],
      window: {
        startTime: '2026-06-12T16:00:00.000Z',
        endTime: '2026-06-12T18:00:00.000Z'
      },
      dataBounds: {
        firstAt: '2026-06-12T16:00:00.000Z',
        lastAt: '2026-06-12T18:00:00.000Z'
      },
      summary: {
        callCount: 2,
        inputTokens: 100,
        cachedTokens: 40,
        outputTokens: 20,
        totalTokens: 120,
        cacheRatio: 0.4,
        peakInputTokens: 80,
        peakOutputTokens: 15
      },
      points: [],
      peaks: [],
      overlays: {
        eventDensity: [],
        toolDensity: [],
        runtimeBands: [],
        compressionForkBands: [],
        searchHits: []
      },
      miniMap: null
    });

    const response = await request(createApp(database))
      .get('/api/xiaoni/action-stream/llm-usage')
      .query({
        range: 'custom',
        start_time: '2026-06-13T00:00:00+08:00',
        end_time: '2026-06-13T02:00:00+08:00',
        bucket: 'hour',
        max_points: '500',
        include_peaks: '1',
        include_overlays: 'compression_fork'
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.bucket).toBe('hour');
    expect(response.body.data.filters).toEqual({
      range: 'custom',
      startTime: '2026-06-12T16:00:00.000Z',
      endTime: '2026-06-12T18:00:00.000Z'
    });
    expect(getXiaoniLlmUsageTimeline).toHaveBeenCalledWith({
      identityKey: 'xiaoni',
      range: 'custom',
      startTime: new Date('2026-06-13T00:00:00+08:00'),
      endTime: new Date('2026-06-13T02:00:00+08:00'),
      bucket: 'hour',
      maxPoints: 500,
      includePeaks: true,
      includeMiniMap: false,
      includeOverlays: 'compression_fork',
      searchQuery: null
    });
  });

  it('resolves an LLM request action event to its focused stack trace even after conversation attach', async () => {
    const database = createDatabaseMock();
    (findXiaoniActionEventTraceTarget as jest.Mock).mockResolvedValueOnce({
      traceId: 'trace-1',
      conversationId: '42',
      spanId: 'stack-slice:slice_abc',
      internalExecutionLeaseId: 'lease-1',
      llmRequestSliceId: 'slice_abc',
      toolCallId: null,
      stackItemId: '1204'
    });
    (buildStackTracePayload as jest.Mock).mockResolvedValueOnce({
      conversation_id: '42',
      batch_id: null,
      trace: { trace_id: 'trace-1', status: 'ok' },
      spans: [],
      raw_evidence: {},
      data_quality: {}
    });

    const response = await request(createApp(database))
      .get('/api/xiaoni/action-stream/events/llm-slice%3Aslice_abc/trace');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(database.executeQuery).not.toHaveBeenCalled();
    expect(findXiaoniActionEventTraceTarget).toHaveBeenCalledWith('llm-slice:slice_abc');
    expect(buildStackTracePayload).toHaveBeenCalledWith(expect.anything(), {
      traceId: 'trace-1',
      conversationId: '42',
      spanId: 'stack-slice:slice_abc',
      internalExecutionLeaseId: 'lease-1',
      llmRequestSliceId: 'slice_abc',
      toolCallId: null,
      stackItemId: '1204'
    });
    expect(response.body.data.action_event).toEqual({
      event_id: 'llm-slice:slice_abc',
      focus_span_id: 'stack-slice:slice_abc',
      trace_id: 'trace-1'
    });
  });

  it('loads focused stack span detail through the action event route after conversation attach', async () => {
    const database = createDatabaseMock();
    (findXiaoniActionEventTraceTarget as jest.Mock).mockResolvedValueOnce({
      traceId: 'trace-1',
      conversationId: '42',
      spanId: 'stack-slice:slice_abc',
      internalExecutionLeaseId: 'lease-1',
      llmRequestSliceId: 'slice_abc',
      toolCallId: null,
      stackItemId: '1204'
    });
    (buildStackTraceSpanDetail as jest.Mock).mockResolvedValueOnce({
      input: { raw_body: '{"model":"gpt"}' },
      output: { raw_body: '{"type":"response"}' },
      evidence: { synthetic: true }
    });

    const response = await request(createApp(database))
      .get('/api/xiaoni/action-stream/events/llm-slice%3Aslice_abc/trace/spans/provider-request%3Awire%3Allm_abc/detail');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(buildStackTraceSpanDetail).toHaveBeenCalledWith(
      expect.anything(),
      {
        traceId: 'trace-1',
        conversationId: '42',
        spanId: 'stack-slice:slice_abc',
        internalExecutionLeaseId: 'lease-1',
        llmRequestSliceId: 'slice_abc',
        toolCallId: null,
        stackItemId: '1204'
      },
      'provider-request:wire:llm_abc'
    );
    expect(response.body.data.input.raw_body).toBe('{"model":"gpt"}');
  });

  it('loads raw provider exchange through the narrow raw trace route', async () => {
    const database = createDatabaseMock();
    (findXiaoniActionEventTraceTarget as jest.Mock).mockResolvedValueOnce({
      traceId: 'trace-1',
      conversationId: '42',
      spanId: 'stack-slice:slice_abc',
      internalExecutionLeaseId: 'lease-1',
      llmRequestSliceId: 'slice_abc',
      toolCallId: null,
      stackItemId: '1204'
    });
    (buildStackRawProviderTrace as jest.Mock).mockResolvedValueOnce({
      span_id: 'provider-request:wire:llm_abc',
      trace_id: 'trace-1',
      conversation_id: '42',
      slice_id: 'slice_abc',
      llm_call_id: 'llm_abc',
      source: 'llm_request_slices.provider_exchange',
      model_name: 'gpt-test',
      model_provider: 'codex',
      request_format_version: 'responses/v1',
      wire_provider_format: 'openai/responses',
      started_at: '2026-06-13T00:00:00.000Z',
      completed_at: '2026-06-13T00:00:01.000Z',
      duration_ms: 1000,
      request: {
        method: 'POST',
        upstream_url: 'https://example.test/v1/responses',
        headers: { 'content-type': 'application/json' },
        body: '{"model":"gpt"}',
        bytes: 15,
        body_format: 'json',
        body_source: 'llm_request_slices.wire_request'
      },
      response: {
        status_code: 200,
        status_text: 'OK',
        headers: { 'content-type': 'text/event-stream' },
        body: '{"type":"response"}',
        bytes: 19,
        body_format: 'json',
        body_source: 'llm_request_slices.raw_response',
        error_message: null
      }
    });

    const response = await request(createApp(database))
      .get('/api/xiaoni/action-stream/events/llm-slice%3Aslice_abc/raw-trace?spanId=provider-request%3Awire%3Allm_abc');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(buildStackRawProviderTrace).toHaveBeenCalledWith(
      expect.anything(),
      {
        traceId: 'trace-1',
        conversationId: '42',
        spanId: 'stack-slice:slice_abc',
        internalExecutionLeaseId: 'lease-1',
        llmRequestSliceId: 'slice_abc',
        toolCallId: null,
        stackItemId: '1204'
      },
      'provider-request:wire:llm_abc'
    );
    expect(buildStackTracePayload).not.toHaveBeenCalled();
    expect(buildStackTraceSpanDetail).not.toHaveBeenCalled();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.data.request.headers['content-type']).toBe('application/json');
    expect(response.body.data.request.body).toBe('{"model":"gpt"}');
    expect(response.body.data.response.headers['content-type']).toBe('text/event-stream');
    expect(response.body.data.response.body).toBe('{"type":"response"}');
  });

  it('loads raw provider exchange for image vision fork item events', async () => {
    const database = createDatabaseMock();
    (findXiaoniActionEventTraceTarget as jest.Mock).mockResolvedValueOnce({
      traceId: 'trace-vision',
      conversationId: '42',
      spanId: 'image-vision-fork-tool-call:call_exec_1',
      internalExecutionLeaseId: 'run-vision',
      llmRequestSliceId: 'vision_llm_1',
      toolCallId: 'call_exec_1',
      sourceKind: 'image_vision_fork',
      forkRunId: 'image-vision-fork:run-vision:asset-1'
    });
    (buildStackRawProviderTrace as jest.Mock).mockResolvedValueOnce({
      span_id: 'provider-request:wire:vision_llm_1',
      trace_id: 'trace-vision',
      conversation_id: '42',
      slice_id: 'vision_llm_1',
      llm_call_id: 'vision_llm_1',
      source: 'image_vision_fork_slices.provider_exchange',
      model_name: 'gpt-test',
      model_provider: 'codex',
      request_format_version: 'responses/v1',
      wire_provider_format: 'openai/responses',
      started_at: '2026-06-13T00:00:00.000Z',
      completed_at: '2026-06-13T00:00:01.000Z',
      duration_ms: 1000,
      request: {
        method: 'POST',
        upstream_url: 'https://example.test/v1/responses',
        headers: { 'content-type': 'application/json' },
        body: '{"model":"gpt"}',
        bytes: 15,
        body_format: 'json',
        body_source: 'image_vision_fork_slices.wire_request'
      },
      response: {
        status_code: 200,
        status_text: 'OK',
        headers: { 'content-type': 'text/event-stream' },
        body: '{"type":"response"}',
        bytes: 19,
        body_format: 'json',
        body_source: 'image_vision_fork_slices.raw_response',
        error_message: null
      }
    });

    const response = await request(createApp(database))
      .get('/api/xiaoni/action-stream/events/image-vision-fork-item%3A10/raw-trace?spanId=provider-request%3Awire%3Avision_llm_1');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(buildStackRawProviderTrace).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceKind: 'image_vision_fork',
        forkRunId: 'image-vision-fork:run-vision:asset-1',
        llmRequestSliceId: 'vision_llm_1',
        toolCallId: 'call_exec_1'
      }),
      'provider-request:wire:vision_llm_1'
    );
    expect(response.body.data.source).toBe('image_vision_fork_slices.provider_exchange');
  });

  it('resolves a life action event to its stack trace', async () => {
    const database = createDatabaseMock();
    (findXiaoniActionEventTraceTarget as jest.Mock).mockResolvedValueOnce({
      traceId: 'trace-internal',
      conversationId: '42',
      spanId: 'llm-call:llm_abc',
      internalExecutionLeaseId: 'lease-internal'
    });
    (buildStackTracePayload as jest.Mock).mockResolvedValueOnce({
      conversation_id: null,
      batch_id: null,
      trace: { trace_id: 'trace-internal', status: 'ok' },
      spans: [],
      raw_evidence: {},
      data_quality: {}
    });

    const response = await request(createApp(database))
      .get('/api/xiaoni/action-stream/events/life%3A1/trace');

    expect(response.status).toBe(200);
    expect(buildStackTracePayload).toHaveBeenCalled();
    expect(response.body.data.action_event).toEqual({
      event_id: 'life:1',
      focus_span_id: 'llm-call:llm_abc',
      trace_id: 'trace-internal'
    });
  });

  it('does not fall back to route-local audit queries when no trace target exists', async () => {
    const database = createDatabaseMock();
    (findXiaoniActionEventTraceTarget as jest.Mock).mockResolvedValueOnce(null);

    const response = await request(createApp(database))
      .get('/api/xiaoni/action-stream/events/llm-slice%3Amissing/trace');

    expect(response.status).toBe(404);
    expect(database.executeQuery).not.toHaveBeenCalled();
  });

  it('falls back to stack trace when the target has no conversation', async () => {
    const database = createDatabaseMock();
    (findXiaoniActionEventTraceTarget as jest.Mock).mockResolvedValueOnce({
      traceId: 'runtrace-global',
      conversationId: null,
      spanId: 'stack-slice:slice_global',
      internalExecutionLeaseId: 'run-global',
      llmRequestSliceId: 'slice_global',
      toolCallId: null,
      stackItemId: '1204'
    });
    (buildStackTracePayload as jest.Mock).mockResolvedValueOnce({
      conversation_id: null,
      batch_id: null,
      trace: { trace_id: 'runtrace-global', status: 'ok' },
      spans: [],
      raw_evidence: {},
      data_quality: {}
    });

    const response = await request(createApp(database))
      .get('/api/xiaoni/action-stream/events/llm-slice%3Aslice_global/trace');

    expect(response.status).toBe(200);
    expect(database.executeQuery).not.toHaveBeenCalled();
    expect(buildStackTracePayload).toHaveBeenCalledWith(expect.anything(), {
      traceId: 'runtrace-global',
      conversationId: null,
      spanId: 'stack-slice:slice_global',
      internalExecutionLeaseId: 'run-global',
      llmRequestSliceId: 'slice_global',
      toolCallId: null,
      stackItemId: '1204'
    });
    expect(response.body.data.action_event).toEqual({
      event_id: 'llm-slice:slice_global',
      focus_span_id: 'stack-slice:slice_global',
      trace_id: 'runtrace-global'
    });
  });

  it('falls back to stack span detail when the target has no conversation', async () => {
    const database = createDatabaseMock();
    (findXiaoniActionEventTraceTarget as jest.Mock).mockResolvedValueOnce({
      traceId: 'runtrace-global',
      conversationId: null,
      spanId: 'tool-call:call_global',
      internalExecutionLeaseId: 'run-global',
      llmRequestSliceId: 'slice_global',
      toolCallId: 'call_global',
      stackItemId: '1204'
    });
    (buildStackTraceSpanDetail as jest.Mock).mockResolvedValueOnce({
      input: { arguments: { cmd: 'date' } },
      output: { result: { stdout: 'ok' } },
      evidence: { execution_id: 'tool-1' }
    });

    const response = await request(createApp(database))
      .get('/api/xiaoni/action-stream/events/stack%3A1204/trace/spans/tool-call%3Acall_global/detail');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(buildStackTraceSpanDetail).toHaveBeenCalledWith(
      expect.anything(),
      {
        traceId: 'runtrace-global',
        conversationId: null,
        spanId: 'tool-call:call_global',
        internalExecutionLeaseId: 'run-global',
        llmRequestSliceId: 'slice_global',
        toolCallId: 'call_global',
        stackItemId: '1204'
      },
      'tool-call:call_global'
    );
    expect(response.body.data.input.arguments.cmd).toBe('date');
  });
});
