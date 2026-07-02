import express from 'express';
import axios from 'axios';
import { DatabaseManager } from '../services/database';
import winston from 'winston';

const PROVIDER_SERVICE_URL = process.env.PROVIDER_SERVICE_URL || 'http://qqbot-provider-service:8090';
const PROVIDER_REQUEST_TIMEOUT_MS = 5000;

type ProviderProbeResult =
  | {
      ok: true;
      statusCode: number;
      payload: unknown;
      error?: never;
    }
  | {
      ok: false;
      statusCode: number | null;
      payload?: never;
      error: string;
    };

async function proxyProviderRuntimeEndpoint(
  res: express.Response,
  logger: winston.Logger,
  method: 'get' | 'post',
  path: string,
  body?: unknown
) {
  try {
    const response = await axios.request({
      method,
      url: `${PROVIDER_SERVICE_URL}${path}`,
      data: body,
      timeout: PROVIDER_REQUEST_TIMEOUT_MS,
      validateStatus: () => true
    });

    return res.status(response.status).json(response.data);
  } catch (error) {
    logger.error('Failed to proxy provider runtime endpoint', { method, path, error });
    return res.status(503).json({
      success: false,
      error: 'provider-service runtime proxy unavailable',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
}

// 创建状态和健康检查相关路由
export function createStatusRoutes(database: DatabaseManager, logger: winston.Logger) {
  const router = express.Router();

  // 健康检查端点
  router.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: process.version
    });
  });

  // API状态端点
  router.get('/status', (req, res) => {
    res.json({
      status: 'operational',
      service: 'Admin Panel Backend',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      database: database ? 'connected' : 'disconnected'
    });
  });

  router.get('/runtime/status', async (_req, res) => {
    try {
      const [databaseLive, providerProbe] = await Promise.all([
        database.testConnection(),
        axios
          .get(`${PROVIDER_SERVICE_URL}/health`, {
            timeout: PROVIDER_REQUEST_TIMEOUT_MS,
            validateStatus: () => true
          })
          .then<ProviderProbeResult>(response => {
            if (response.status >= 200 && response.status < 300) {
              return {
                ok: true,
                statusCode: response.status,
                payload: response.data
              };
            }

            return {
              ok: false,
              statusCode: response.status,
              error: `provider-service health check returned HTTP ${response.status}`
            };
          })
          .catch<ProviderProbeResult>(error => ({
            ok: false,
            statusCode: null as number | null,
            error: error instanceof Error ? error.message : 'Unknown error'
          }))
      ]);
      const providerPayload = providerProbe.ok && typeof providerProbe.payload === 'object' && providerProbe.payload !== null
        ? providerProbe.payload as Record<string, any>
        : {};
      const napcat = providerPayload.napcat && typeof providerPayload.napcat === 'object'
        ? providerPayload.napcat as Record<string, any>
        : {};
      const providerConnected = Boolean(napcat.reachable);
      const providerStatus = providerProbe.ok
        ? (providerConnected ? 'online' : 'offline')
        : 'offline';

      // Inbound liveness: NapCat can be reachable+online while its receive pipe
      // is dead ("green but dead"). provider /health computes the verdict; we
      // fold it into the dashboard health so a dead pipe shows as degraded.
      const inboundLiveness = providerPayload.inboundLiveness && typeof providerPayload.inboundLiveness === 'object'
        ? providerPayload.inboundLiveness as Record<string, any>
        : null;
      const inboundHealthy = inboundLiveness ? inboundLiveness.healthy !== false : true;

      const overallStatus =
        !providerProbe.ok
          ? 'offline'
          : !databaseLive || !providerConnected || !inboundHealthy
            ? 'degraded'
            : 'healthy';

      res.json({
        success: true,
        data: {
          status: overallStatus,
          provider: {
            live: providerProbe.ok,
            connected: providerConnected,
            status: providerStatus,
            botId: napcat.selfId ? String(napcat.selfId) : null,
            httpServerRunning: providerProbe.ok,
            lastHeartbeat: typeof providerPayload.timestamp === 'string' ? providerPayload.timestamp : null,
            errorMessage: providerProbe.ok ? (napcat.error || null) : (providerProbe.error || 'provider-service health check failed'),
            url: PROVIDER_SERVICE_URL,
            healthStatusCode: providerProbe.statusCode
          },
          inbound: {
            live: inboundHealthy,
            status: !inboundLiveness ? 'unknown' : (inboundHealthy ? 'online' : 'degraded'),
            state: inboundLiveness?.state ?? null,
            detail: inboundLiveness?.detail ?? null,
            lastEventAt: inboundLiveness?.lastEventAt ?? null,
            staleForMs: inboundLiveness?.staleForMs ?? null
          },
          admin: {
            live: true,
            status: 'online'
          },
          database: {
            live: databaseLive,
            status: databaseLive ? 'online' : 'offline'
          }
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to fetch runtime status', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch runtime status',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.get('/runtime/napcat-login/status', async (_req, res) => {
    return proxyProviderRuntimeEndpoint(res, logger, 'get', '/api/napcat-login/status');
  });

  router.post('/runtime/napcat-login/qrcode', async (_req, res) => {
    return proxyProviderRuntimeEndpoint(res, logger, 'post', '/api/napcat-login/qrcode', {});
  });

  // 数据库连接测试
  router.get('/database/test', async (req, res) => {
    try {
      if (!database) {
        return res.status(500).json({
          success: false,
          error: 'Database service not available',
          timestamp: new Date().toISOString()
        });
      }

      // 简单的数据库查询测试
      const result = await database.executeQuery('SELECT 1 as test');

      res.json({
        success: true,
        message: 'Database connection successful',
        result: result[0],
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Database connection test failed', { error });
      res.status(500).json({
        success: false,
        error: 'Database connection failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  return router;
}

export default createStatusRoutes;
