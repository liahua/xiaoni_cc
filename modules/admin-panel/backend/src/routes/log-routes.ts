import express from 'express';
import { DatabaseManager } from '../services/database';
import winston from 'winston';
import fs from 'fs';
import path from 'path';

// 创建日志查询相关路由
export function createLogRoutes(database: DatabaseManager, logger: winston.Logger) {
  const router = express.Router();

  // 获取日志文件
  router.get('/logs', (req, res) => {
    try {
      const logsPath = path.join(__dirname, '../logs');
      if (!fs.existsSync(logsPath)) {
        return res.status(404).json({
          success: false,
          error: 'Logs directory not found',
          timestamp: new Date().toISOString()
        });
      }

      const files = fs.readdirSync(logsPath).filter(file => file.endsWith('.log'));
      res.json({
        success: true,
        files,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to list log files', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to list log files',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  // 获取WebSocket日志
  router.get('/logs/websocket', async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = (page - 1) * limit;

      // 构建查询条件
      const filters = [];
      const params = [];

      if (req.query.level) {
        filters.push('level = ?');
        params.push(req.query.level);
      }

      if (req.query.trace_id) {
        filters.push('trace_id = ?');
        params.push(req.query.trace_id);
      }

      if (req.query.event_type) {
        filters.push('event_type = ?');
        params.push(req.query.event_type);
      }

      const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

      const logs = await database.executeQuery(
        `SELECT id, timestamp, level, event_type, trace_id, message, metadata, created_at
         FROM websocket_logs
         ${whereClause}
         ORDER BY timestamp DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      // 获取总数
      const totalResult = await database.executeQuery<{ total: number }>(
        `SELECT COUNT(*) as total FROM websocket_logs ${whereClause}`,
        params
      );
      const total = totalResult[0]?.total || 0;

      res.json({
        success: true,
        data: logs,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to fetch websocket logs', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch websocket logs',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  // 获取LLM调用日志
  router.get('/logs/llm', async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = (page - 1) * limit;

      // 构建查询条件
      const filters = [];
      const params = [];

      if (req.query.trace_id) {
        filters.push('trace_id = ?');
        params.push(req.query.trace_id);
      }

      if (req.query.model) {
        filters.push('model_name = ?');
        params.push(req.query.model);
      }

      if (req.query.status) {
        filters.push('status = ?');
        params.push(req.query.status);
      }

      const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

      const logs = await database.executeQuery(
        `SELECT
          id, trace_id, NULL::text AS session_id, model_name,
          LEFT(COALESCE(canonical_request::jsonb->>'instructions', CAST(canonical_request AS text)), 200) as prompt_preview,
          request_format_version, wire_provider_format,
          LEFT(COALESCE(CAST(canonical_response AS text), CAST(wire_response AS text), CAST(raw_response AS text), CAST(output_items AS text)), 200) as response_preview,
          status, created_at, processing_time_ms,
          COALESCE((token_usage::jsonb->>'input_tokens')::int, (token_usage::jsonb->>'prompt_tokens')::int, 0) AS input_tokens,
          COALESCE((token_usage::jsonb->>'output_tokens')::int, (token_usage::jsonb->>'completion_tokens')::int, 0) AS output_tokens
         FROM llm_request_slices
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      // 获取总数
      const totalResult = await database.executeQuery<{ total: number }>(
        `SELECT COUNT(*) as total FROM llm_request_slices ${whereClause}`,
        params
      );
      const total = totalResult[0]?.total || 0;

      res.json({
        success: true,
        data: logs,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to fetch LLM logs', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch LLM logs',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  // 获取会话日志
  router.get('/logs/sessions', async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = (page - 1) * limit;

      // 构建查询条件
      const filters = [];
      const params = [];

      if (req.query.session_id) {
        filters.push('session_id = ?');
        params.push(req.query.session_id);
      }

      if (req.query.user_id) {
        filters.push('user_id = ?');
        params.push(req.query.user_id);
      }

      if (req.query.service_type) {
        filters.push('session_type = ?');
        params.push(req.query.service_type);
      }

      const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

      const logs = await database.executeQuery(
        `SELECT
          session_id, user_id, session_type as service_type, status as event_type,
          conversation_context as event_data, created_at, last_activity as updated_at,
          CASE WHEN status = 'active' THEN 1 ELSE 0 END as is_active
         FROM conversation_sessions
         ${whereClause}
         ORDER BY last_activity DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      // 获取总数
      const totalResult = await database.executeQuery<{ total: number }>(
        `SELECT COUNT(*) as total FROM conversation_sessions ${whereClause}`,
        params
      );
      const total = totalResult[0]?.total || 0;

      res.json({
        success: true,
        data: logs,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to fetch session logs', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch session logs',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  return router;
}

export default createLogRoutes;
