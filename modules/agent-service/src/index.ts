import express from 'express';
import { getAgentRuntimeControl, triggerPostCompressionRuntimePause } from '@qq-bot/persistence';
import { agentConfig, databaseConfig, serverConfig } from './config';
import { logger } from './utils/logger';
import { RuntimeStore } from './services/runtime-store';
import { AgentLoopService } from './services/agent-loop-service';
import { AgentTaskWorkerService } from './services/agent-task-worker-service';
import { QqUsageService, QqUsageSkillRuntime } from './services/qq-usage-service';
import { QqSendImageService, QqSendImageSkillRuntime } from './services/qq-send-image-service';
import { XiaoniPromptDirectoryWatcher } from './prompts/xiaoni-prompt-directory-watcher';
import { XiaoniPromptReloadPolicy } from './prompts/xiaoni-prompt-reload-policy';

const moduleLogger = logger.createModuleLogger('agent-service');
const app = express();
const store = new RuntimeStore();
const loopService = new AgentLoopService(store, undefined, {
  isRuntimeEnabled,
  isCacheHeartbeatPaused,
  getMainAgentPreModelYieldMs,
  onCoreMemoryCompressionCommitted: handleCoreMemoryCompressionCommitted
});
const taskWorkerService = new AgentTaskWorkerService();
const qqUsageRuntime = new QqUsageSkillRuntime(new QqUsageService(store), {
  botAccountId: agentConfig.botAccountId
});
const qqSendImageRuntime = new QqSendImageSkillRuntime(new QqSendImageService({
  providerServiceUrl: agentConfig.providerServiceUrl
}));

let stopping = false;
let workerBusy = false;
let taskWorkerBusy = false;
let runtimeEnabled = true;
let lastProcessingRecoveryAt = 0;
const promptReloadPolicy = new XiaoniPromptReloadPolicy();

app.use(express.json({ limit: '2mb' }));

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

app.get('/health', async (_req, res) => {
  res.json({
    status: 'healthy',
    service: 'agent-service',
    worker_busy: workerBusy,
    task_worker_busy: taskWorkerBusy,
    runtime_enabled: runtimeEnabled,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/internal/runtime/cache-heartbeat', async (_req, res) => {
  try {
    const result = await loopService.triggerCacheHeartbeatForDebug();
    res.json({
      success: true,
      result
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    moduleLogger.warn('Manual cache heartbeat failed', { error: message });
    res.status(500).json({
      success: false,
      error: message
    });
  }
});

app.post('/api/internal/runtime/core-memory-compression/trigger', async (_req, res) => {
  try {
    const result = await loopService.triggerManualCoreMemoryCompression();
    res.json({
      success: true,
      result
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    moduleLogger.warn('Manual core memory compression trigger failed', { error: message });
    res.status(500).json({
      success: false,
      error: message
    });
  }
});

app.get('/api/internal/runtime/core-memory-compression/status', async (req, res) => {
  try {
    const raw = req.query.compression_covered_end_conversation_id;
    const coveredEnd = Number(Array.isArray(raw) ? raw[0] : raw);
    if (!Number.isFinite(coveredEnd)) {
      res.status(400).json({
        success: false,
        error: 'compression_covered_end_conversation_id query param required'
      });
      return;
    }
    const result = await loopService.getCoreMemoryCompressionForkStatus(coveredEnd);
    res.json({
      success: true,
      result
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    moduleLogger.warn('Core memory compression status check failed', { error: message });
    res.status(500).json({
      success: false,
      error: message
    });
  }
});

app.post('/api/internal/runtime/prompt/reload', async (_req, res) => {
  try {
    const hadPendingReload = promptReloadPolicy.clearPendingReload();
    const invalidated = loopService.invalidateStableRuntimePrompt('manual_force_load');
    moduleLogger.warn('Manual Xiaoni runtime prompt force-load requested', {
      invalidated,
      had_pending_reload: hadPendingReload
    });
    res.json({
      success: true,
      result: {
        invalidated,
        had_pending_reload: hadPendingReload,
        reason: 'manual_force_load'
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    moduleLogger.warn('Manual Xiaoni runtime prompt force-load failed', { error: message });
    res.status(500).json({
      success: false,
      error: message
    });
  }
});

app.post('/api/internal/qq-usage', async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  const action = typeof body.action === 'string' ? body.action.trim() : '';
  const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args)
    ? body.args as Record<string, unknown>
    : {};
  const context = body.context && typeof body.context === 'object' && !Array.isArray(body.context)
    ? body.context as Record<string, unknown>
    : {};
  const result = await qqUsageRuntime.execute(action, args, {
    traceId: optionalString(context.trace_id ?? context.traceId),
    runId: optionalString(context.run_id ?? context.runId),
    batchId: optionalString(context.batch_id ?? context.batchId),
    toolCallId: optionalString(context.tool_call_id ?? context.toolCallId),
    toolName: optionalString(context.tool_name ?? context.toolName),
    sessionKey: optionalString(context.session_key ?? context.sessionKey)
  });
  res.json({
    success: true,
    result
  });
});

app.post('/api/internal/qq-send-image', async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  const action = typeof body.action === 'string' ? body.action.trim() : '';
  const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args)
    ? body.args as Record<string, unknown>
    : {};
  const context = body.context && typeof body.context === 'object' && !Array.isArray(body.context)
    ? body.context as Record<string, unknown>
    : {};
  const result = await qqSendImageRuntime.execute(action, args, {
    traceId: optionalString(context.trace_id ?? context.traceId),
    runId: optionalString(context.run_id ?? context.runId),
    batchId: optionalString(context.batch_id ?? context.batchId),
    toolCallId: optionalString(context.tool_call_id ?? context.toolCallId),
    toolName: optionalString(context.tool_name ?? context.toolName),
    sessionKey: optionalString(context.session_key ?? context.sessionKey)
  });
  res.json({
    success: true,
    result
  });
});

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function recoverStaleProcessingLeasesPeriodically() {
  const now = Date.now();
  const minIntervalMs = Math.max(30_000, Math.min(agentConfig.processingRecoveryStaleMs, 60_000));
  if (now - lastProcessingRecoveryAt < minIntervalMs) {
    return;
  }
  lastProcessingRecoveryAt = now;
  const recovered = await store.recoverStaleProcessingLeases({
    staleMs: agentConfig.processingRecoveryStaleMs,
    reason: 'agent_service_periodic_recovery'
  }).catch((error) => {
    moduleLogger.warn('Failed to recover stale processing runs during runtime loop', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  });
  if (recovered && (recovered.failedRuns > 0 || recovered.settledRuns > 0 || recovered.failedQueueMessages > 0 || recovered.settledQueueMessages > 0)) {
    moduleLogger.warn('Recovered stale processing runs during runtime loop', recovered);
  }
}

async function pollTaskQueueOnce() {
  if (stopping || taskWorkerBusy) {
    return agentConfig.idleIntervalMs;
  }

  runtimeEnabled = await isRuntimeEnabled();
  if (!runtimeEnabled) {
    return agentConfig.idleIntervalMs;
  }

  taskWorkerBusy = true;
  try {
    const processed = await taskWorkerService.processNext(`${agentConfig.workerId}:task`);
    return processed ? 0 : agentConfig.idleIntervalMs;
  } catch (error) {
    moduleLogger.error('Agent task queue poll failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    return agentConfig.idleIntervalMs;
  } finally {
    taskWorkerBusy = false;
  }
}

async function isRuntimeEnabled() {
  try {
    const control = await getAgentRuntimeControl({ identityKey: 'xiaoni' }, databaseConfig);
    return control.enabled !== false;
  } catch (error) {
    moduleLogger.warn('Failed to load Xiaoni runtime control; defaulting enabled', {
      error: error instanceof Error ? error.message : String(error)
    });
    return true;
  }
}

async function isCacheHeartbeatPaused() {
  try {
    const control = await getAgentRuntimeControl({ identityKey: 'xiaoni' }, databaseConfig);
    return control.cacheHeartbeatPaused === true;
  } catch (error) {
    moduleLogger.warn('Failed to load Xiaoni cache heartbeat pause control; defaulting heartbeat enabled', {
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

async function getMainAgentPreModelYieldMs() {
  try {
    const control = await getAgentRuntimeControl({ identityKey: 'xiaoni' }, databaseConfig);
    return Number.isFinite(control.mainAgentPreModelYieldMs) && control.mainAgentPreModelYieldMs >= 0
      ? control.mainAgentPreModelYieldMs
      : agentConfig.mainAgentPreModelYieldMs;
  } catch (error) {
    moduleLogger.warn('Failed to load Xiaoni main agent pre-model yield control; using fallback', {
      error: error instanceof Error ? error.message : String(error),
      fallbackMs: agentConfig.mainAgentPreModelYieldMs
    });
    return agentConfig.mainAgentPreModelYieldMs;
  }
}

async function triggerRuntimePauseAfterCoreMemoryCompression() {
  const control = await triggerPostCompressionRuntimePause({
    identityKey: 'xiaoni',
    reason: 'core_memory_compression_completed'
  }, databaseConfig);
  runtimeEnabled = control.enabled !== false;
  if (!runtimeEnabled && control.postCompressionPauseTriggeredAt) {
    moduleLogger.warn('Xiaoni runtime paused after core memory compression', {
      identityKey: control.identityKey,
      triggeredAt: control.postCompressionPauseTriggeredAt,
      reason: control.postCompressionPauseReason
    });
  }
}

async function handleCoreMemoryCompressionCommitted() {
  if (promptReloadPolicy.consumePostCompressionReload()) {
    const invalidated = loopService.invalidateStableRuntimePrompt('prompt_files_changed_after_core_memory_compression');
    moduleLogger.warn('Xiaoni prompt file reload armed after core memory compression', {
      reason: 'prefix_sensitive_prompt_files_changed',
      invalidated
    });
  }
  await triggerRuntimePauseAfterCoreMemoryCompression();
}

const promptDirectoryWatcher = new XiaoniPromptDirectoryWatcher({
  logger: moduleLogger,
  onChange: (change) => {
    const decision = promptReloadPolicy.recordPromptDirectoryChange(change);
    moduleLogger.info('Xiaoni prompt files changed', {
      fingerprint: change.fingerprint.slice(0, 12),
      file_count: change.fileCount,
      files: change.files,
      changed_files: decision.changedFiles,
      prefix_sensitive_files: decision.prefixSensitiveFiles,
      reload_policy: decision.reloadPolicy
    });
  }
});

async function runTaskWorkerLoop() {
  while (!stopping) {
    const delayMs = await pollTaskQueueOnce();
    if (!stopping && delayMs > 0) {
      await wait(delayMs);
    }
  }
}

async function shutdown(signal: string) {
  if (stopping) {
    return;
  }
  stopping = true;
  moduleLogger.info('Shutting down agent service', { signal });
  promptDirectoryWatcher.stop();
  await store.close().catch(() => undefined);
  process.exit(0);
}

async function start() {
  await store.initialize();
  // Fork promises (core-memory compression / subconscious / image vision) live
  // only in the previous process. Anything left 'running' is orphaned by this
  // restart; reap it so a stale core-memory row doesn't block manual 压缩记忆.
  try {
    const reaped = await store.reapOrphanedForkRuns({ reason: 'orphaned_on_agent_service_restart' });
    if (reaped.total > 0) {
      moduleLogger.warn('Reaped orphaned fork runs on startup', reaped);
    }
  } catch (error) {
    moduleLogger.warn('Failed to reap orphaned fork runs on startup', {
      error: error instanceof Error ? error.message : String(error)
    });
  }
  promptDirectoryWatcher.start();
  app.listen(serverConfig.port, serverConfig.host, () => {
    moduleLogger.info('Agent service listening', {
      host: serverConfig.host,
      port: serverConfig.port
    });
  });
  void wait(200).then(() => loopService.runRuntimeLoop({
    workerId: agentConfig.workerId,
    idleIntervalMs: agentConfig.idleIntervalMs,
    isStopping: () => stopping,
    recoverStaleProcessingLeases: recoverStaleProcessingLeasesPeriodically,
    onBusyChange: (busy) => {
      workerBusy = busy;
    },
    onRuntimeEnabledChange: (enabled) => {
      runtimeEnabled = enabled;
    },
    onRuntimeLoopError: (error) => {
      moduleLogger.error('Agent runtime loop failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }));
  void wait(500).then(() => runTaskWorkerLoop());
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

void start().catch((error) => {
  moduleLogger.error('Failed to start agent service', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
