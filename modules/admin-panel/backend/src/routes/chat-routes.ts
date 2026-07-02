import express from 'express';
import { getEast8StartOfDay, serializeTimestampForStorage } from '@qq-bot/persistence';
import { DatabaseManager } from '../services/database';
import winston from 'winston';

// Type interfaces for database query results
interface PrivateChatSettingRow {
  user_id: number;
  username: string | null;
  is_enabled: number;
  auto_reply_enabled: number;
  transcript_compact_offset: number | null;
  welcome_message: string | null;
  user_notes: string | null;
  last_activity: string | null;
}

interface GroupChatSettingRow {
  group_id: number;
  group_name: string | null;
  is_enabled: number;
  auto_reply_enabled: number;
  transcript_compact_offset: number | null;
  welcome_message: string | null;
  admin_user_id: number | null;
  last_activity: string | null;
}

interface ToolMetricRow {
  tool_name: string;
  hit_count: number | string;
  run_count: number | string;
  successful_hit_count: number | string;
  last_hit_at: string | null;
}

type ChatSettingToggleField = 'is_enabled';

type ChatSettingSanitizeOptions = {
  allowedFields: readonly string[];
};

const TOGGLE_FIELDS: readonly ChatSettingToggleField[] = ['is_enabled'];

function buildRuntimeSessionKey(scope: 'group' | 'private', id: number): string {
  return scope === 'group' ? `qq:group:${id}` : `qq:private:${id}`;
}

function parseDirectAgentTriggerUserIds(): number[] {
  const raw = process.env.XIAONI_DIRECT_AGENT_TRIGGER_USER_IDS || process.env.AUTHORIZED_USER_ID || '85178516';
  const ids = new Set<number>();
  String(raw)
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
    .forEach((item) => ids.add(Math.trunc(item)));
  return Array.from(ids);
}

function buildDirectAgentTriggerCaseSql(columnName: string): string {
  const ids = parseDirectAgentTriggerUserIds();
  if (ids.length === 0) {
    return '0';
  }
  return `CASE WHEN ${columnName} IN (${ids.join(',')}) THEN 1 ELSE 0 END`;
}

function buildDirectAgentTriggerTargetUnionSql(): string {
  const ids = parseDirectAgentTriggerUserIds();
  if (ids.length === 0) {
    return '';
  }
  return ids.map((id) => `UNION SELECT ${id} AS user_id`).join('\n');
}

function parseMetricsWindowDays(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return 7;
  }
  return Math.max(1, Math.min(30, Math.floor(value)));
}

async function loadSessionToolMetrics(
  database: DatabaseManager,
  sessionKey: string,
  windowDays: number
) {
  const windowStart = serializeTimestampForStorage(
    new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
  ) || '1970-01-01 00:00:00.000';

  const totalRunsResult = await database.executeQuery<{ total_runs: number | string }>(
    `
      SELECT COUNT(DISTINCT trace_id) AS total_runs
      FROM agent_runs
      WHERE session_key = ?
        AND created_at >= ?
    `,
    [sessionKey, windowStart]
  );

  const totalRuns = Number(totalRunsResult[0]?.total_runs || 0);

  const toolRows = await database.executeQuery<ToolMetricRow>(
    `
      WITH session_runs AS (
        SELECT DISTINCT trace_id
        FROM agent_runs
        WHERE session_key = ?
          AND created_at >= ?
      )
      SELECT
        tool_name,
        COUNT(*) AS hit_count,
        COUNT(DISTINCT trace_id) AS run_count,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) AS successful_hit_count,
        MAX(COALESCE(completed_at, started_at)) AS last_hit_at
      FROM tool_executions
      WHERE trace_id IN (SELECT trace_id FROM session_runs)
      GROUP BY tool_name
      ORDER BY COUNT(*) DESC, tool_name ASC
    `,
    [sessionKey, windowStart]
  );

  return {
    session_key: sessionKey,
    window_days: windowDays,
    total_runs: totalRuns,
    tools: toolRows.map((row) => {
      const hitCount = Number(row.hit_count || 0);
      const runCount = Number(row.run_count || 0);
      const successfulHitCount = Number(row.successful_hit_count || 0);
      return {
        tool_name: row.tool_name,
        hit_count: hitCount,
        run_count: runCount,
        successful_hit_count: successfulHitCount,
        run_hit_rate: totalRuns > 0 ? Number((runCount / totalRuns).toFixed(4)) : 0,
        avg_hits_per_hit_run: runCount > 0 ? Number((hitCount / runCount).toFixed(2)) : 0,
        last_hit_at: row.last_hit_at || null
      };
    })
  };
}

export function normalizeChatSettingUpdates(
  updates: Record<string, unknown>,
  options: ChatSettingSanitizeOptions
): { sanitizedUpdates: Record<string, unknown>; validationError: string | null } {
  const allowedFields = new Set(options.allowedFields);
  const sanitizedUpdates: Record<string, unknown> = {};
  let validationError: string | null = null;

  Object.entries(updates || {}).forEach(([key, value]) => {
    if (!allowedFields.has(key) || value === undefined) {
      return;
    }

    if ((TOGGLE_FIELDS as readonly string[]).includes(key)) {
      sanitizedUpdates[key] = value ? 1 : 0;
      return;
    }

    if (key === 'transcript_compact_offset') {
      const numericValue = Number(value);
      if (!Number.isInteger(numericValue) || numericValue < 0 || numericValue > 500) {
        validationError = 'transcript_compact_offset must be an integer between 0 and 500';
        return;
      }
      sanitizedUpdates[key] = numericValue;
      return;
    }

    sanitizedUpdates[key] = value;
  });

  if (sanitizedUpdates.is_enabled === 0) {
    sanitizedUpdates.auto_reply_enabled = 0;
  } else if (sanitizedUpdates.is_enabled === 1) {
    sanitizedUpdates.auto_reply_enabled = 1;
  }

  return { sanitizedUpdates, validationError };
}

// 创建聊天管理相关路由
export function createChatRoutes(database: DatabaseManager, logger: winston.Logger) {
  const router = express.Router();

  router.post('/group-chats', async (req, res) => {
    try {
      const groupId = Number(req.body?.group_id);
      const groupName = typeof req.body?.group_name === 'string' ? req.body.group_name.trim() : '';

      if (!Number.isFinite(groupId) || groupId <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid group ID',
          timestamp: new Date().toISOString()
        });
      }

      const success = await database.upsertGroupChatSettings(groupId, {
        group_name: groupName || null,
        is_enabled: 1,
        continuous_learning_enabled: 0,
        auto_reply_enabled: 1
      });
      const groupSettings = await database.getGroupChatSettingById(groupId);

      res.status(success ? 201 : 200).json({
        success: true,
        message: 'Group created successfully',
        data: groupSettings || {
          group_id: groupId,
          group_name: groupName || null,
          is_enabled: 1,
          continuous_learning_enabled: 0,
          auto_reply_enabled: 1
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to create group chat settings', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to create group settings',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  // 获取群聊列表和统计
  router.get('/group-chats', async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.max(1, Math.min(200, parseInt(req.query.limit as string) || 20));
      const offset = (page - 1) * limit;
      const search = req.query.search as string || '';
      const status = req.query.status as string;
      const sortBy = req.query.sortBy as string;

      // 构建查询条件
      let whereConditions = ['1=1'];
      let queryParams: any[] = [];

      if (search) {
        whereConditions.push('(g.group_name LIKE ? OR CAST(g.group_id AS TEXT) LIKE ?)');
        queryParams.push(`%${search}%`, `%${search}%`);
      }

      if (status === 'active') {
        whereConditions.push('g.is_enabled = 1');
      }

      const whereClause = whereConditions.join(' AND ');

      // 确定排序方式
      let orderBy = 'g.created_at DESC';
      if (sortBy === 'activity_level') {
        orderBy = 'activity_level DESC, g.created_at DESC';
      }

      // 获取群聊列表数据，包含统计信息
      const groupChats = await database.executeQuery(`
        SELECT
          g.group_id,
          g.group_name,
          g.is_enabled,
          CASE WHEN g.is_enabled = 1 THEN 1 ELSE 0 END as auto_reply_enabled,
          g.is_enabled as im_receive_enabled,
          CASE WHEN g.is_enabled = 1 THEN 1 ELSE 0 END as agent_im_entry_enabled,
          g.transcript_compact_offset,
          g.welcome_message,
          g.admin_user_id,
          g.last_activity,
          g.created_at,
          g.updated_at,
          COALESCE(stats.total_conversations, 0) as total_conversations,
          COALESCE(stats.successful_replies, 0) as successful_replies,
          COALESCE(stats.failed_replies, 0) as failed_replies,
          COALESCE(stats.success_rate, 0) as success_rate,
          COALESCE(stats.avg_response_time, 0) as avg_response_time,
          CASE
            WHEN g.last_activity IS NULL THEN 0
            WHEN g.last_activity >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 80
            WHEN g.last_activity >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 60
            WHEN g.last_activity >= DATE_SUB(NOW(), INTERVAL 90 DAY) THEN 30
            ELSE 10
          END as activity_level,
          CASE
            WHEN g.is_enabled = 1 THEN 'active'
            ELSE 'disabled'
          END as status,
          g.last_activity as last_conversation_time
        FROM group_chat_settings g
        LEFT JOIN (
          SELECT
            peer_id AS group_id,
            COUNT(*) as total_conversations,
            COUNT(*) as total_reply_attempts,
            COUNT(CASE WHEN status = 'completed' AND no_reply = FALSE AND final_response IS NOT NULL AND final_response != '' THEN 1 END) as successful_replies,
            COUNT(CASE WHEN status = 'failed' OR (status = 'completed' AND (no_reply = TRUE OR final_response IS NULL OR final_response = '')) THEN 1 END) as failed_replies,
            CASE
              WHEN COUNT(*) = 0 THEN 0
              ELSE ROUND(COUNT(CASE WHEN status = 'completed' AND no_reply = FALSE AND final_response IS NOT NULL AND final_response != '' THEN 1 END) * 100.0 / COUNT(*), 1)
            END as success_rate,
            AVG(CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL THEN EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 ELSE NULL END) as avg_response_time
          FROM agent_runs
          WHERE chat_type = 'group'
          GROUP BY peer_id
        ) stats ON CAST(g.group_id AS TEXT) = stats.group_id
        WHERE ${whereClause}
        ORDER BY ${orderBy}
        LIMIT ${limit} OFFSET ${offset}
      `, queryParams);

      // 获取总数
      const totalResult = await database.executeQuery<{ total: number }>(`
        SELECT COUNT(*) as total
        FROM group_chat_settings g
        WHERE ${whereClause}
      `, queryParams);
      const total = totalResult[0]?.total || 0;

      // 获取全局统计数据
      const globalStats = await database.executeQuery(`
        SELECT
          COUNT(DISTINCT g.group_id) as total_groups,
          COUNT(CASE WHEN g.is_enabled = 1 THEN 1 END) as enabled_groups,
          COUNT(CASE WHEN g.is_enabled = 1 THEN 1 END) as auto_reply_groups,
          COUNT(CASE WHEN g.is_enabled = 1 THEN 1 END) as agent_im_entry_groups,
          COUNT(CASE WHEN g.last_activity >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 END) as active_groups
        FROM group_chat_settings g
      `);

      res.json({
        success: true,
        data: groupChats,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        },
        stats: globalStats[0] || {},
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to fetch group chats', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch group chats',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  // 获取私聊列表和统计
  router.get('/private-chats', async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.max(1, Math.min(200, parseInt(req.query.limit as string) || 20));
      const offset = (page - 1) * limit;
      const search = req.query.search as string || '';
      const is_enabled = req.query.is_enabled;
      const auto_reply_enabled = req.query.auto_reply_enabled;
      const directForceCase = buildDirectAgentTriggerCaseSql('targets.user_id');
      const directTriggerTargetsSql = buildDirectAgentTriggerTargetUnionSql();

      // 构建查询条件
      let whereConditions = ['1=1'];
      let queryParams: any[] = [];

      if (search) {
        whereConditions.push('(pcs.username LIKE ? OR CAST(targets.user_id AS TEXT) LIKE ?)');
        queryParams.push(`%${search}%`, `%${search}%`);
      }

      if (is_enabled !== undefined) {
        whereConditions.push(`(
          CASE
            WHEN ${directForceCase} = 1 THEN 1
            ELSE COALESCE(pcs.is_enabled, 1)
          END
        ) = ?`);
        queryParams.push(is_enabled === 'true' ? 1 : 0);
      }

      if (auto_reply_enabled !== undefined) {
        whereConditions.push(`(
          CASE
            WHEN ${directForceCase} = 1 THEN 1
            WHEN COALESCE(pcs.is_enabled, 1) = 1 THEN 1
            ELSE 0
          END
        ) = ?`);
        queryParams.push(auto_reply_enabled === 'true' ? 1 : 0);
      }

      const whereClause = whereConditions.join(' AND ');

      // 获取私聊用户列表和统计数据
      const privateChatUsers = await database.executeQuery(`
        SELECT
          targets.user_id,
          COALESCE(pcs.username, CONCAT('用户', targets.user_id)) as nickname,
          stats.last_conversation_time,
          CASE
            WHEN COALESCE(stats.successful_replies, 0) > 0 THEN 'success'
            WHEN COALESCE(stats.failed_replies, 0) > 0 THEN 'failed'
            ELSE 'pending'
          END as status,
          ${directForceCase} as direct_force_im_trigger_enabled,
          CASE
            WHEN ${directForceCase} = 1 THEN 1
            ELSE COALESCE(pcs.is_enabled, 1)
          END as im_receive_enabled,
          CASE
            WHEN ${directForceCase} = 1 THEN 1
            WHEN COALESCE(pcs.is_enabled, 1) = 1 THEN 1
            ELSE 0
          END as agent_im_entry_enabled,
          COALESCE(stats.total_conversations, 0) as total_conversations,
          COALESCE(stats.successful_replies, 0) as successful_replies,
          COALESCE(stats.failed_replies, 0) as failed_replies,
          CASE
            WHEN COALESCE(stats.total_reply_attempts, 0) = 0 THEN 0
            ELSE ROUND(COALESCE(stats.successful_replies, 0) * 100.0 / stats.total_reply_attempts, 1)
          END as success_rate,
          CASE
            WHEN stats.avg_response_time IS NULL THEN '0ms'
            ELSE CONCAT(ROUND(stats.avg_response_time), 'ms')
          END as avg_response_time,
          COALESCE(pcs.is_enabled, 1) as is_enabled,
          CASE
            WHEN ${directForceCase} = 1 THEN 1
            WHEN COALESCE(pcs.is_enabled, 1) = 1 THEN 1
            ELSE 0
          END as auto_reply_enabled,
          COALESCE(pcs.transcript_compact_offset, 6) as transcript_compact_offset,
          pcs.user_notes
        FROM (
          SELECT user_id FROM private_chat_settings
          UNION
          SELECT DISTINCT CAST(peer_id AS BIGINT) AS user_id FROM agent_runs WHERE chat_type = 'direct' AND peer_id ~ '^[0-9]+$'
          ${directTriggerTargetsSql}
        ) targets
        LEFT JOIN private_chat_settings pcs ON targets.user_id = pcs.user_id
        LEFT JOIN (
          SELECT
            CAST(peer_id AS BIGINT) as user_id,
            MAX(created_at) as last_conversation_time,
            COUNT(*) as total_conversations,
            COUNT(*) as total_reply_attempts,
            COUNT(CASE WHEN status = 'completed' AND no_reply = FALSE AND final_response IS NOT NULL AND final_response != '' THEN 1 END) as successful_replies,
            COUNT(CASE WHEN status = 'failed' OR (status = 'completed' AND (no_reply = TRUE OR final_response IS NULL OR final_response = '')) THEN 1 END) as failed_replies,
            AVG(CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL THEN EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 ELSE NULL END) as avg_response_time
          FROM agent_runs
          WHERE chat_type = 'direct' AND peer_id ~ '^[0-9]+$'
          GROUP BY peer_id
        ) stats ON targets.user_id = stats.user_id
        WHERE ${whereClause}
        ORDER BY COALESCE(stats.last_conversation_time, pcs.updated_at, pcs.created_at) DESC, targets.user_id DESC
        LIMIT ${limit} OFFSET ${offset}
      `, queryParams);

      // 获取总用户数
      const totalUsersResult = await database.executeQuery<{ total: number }>(`
        SELECT COUNT(*) as total
        FROM (
          SELECT user_id FROM private_chat_settings
          UNION
          SELECT DISTINCT CAST(peer_id AS BIGINT) AS user_id FROM agent_runs WHERE chat_type = 'direct' AND peer_id ~ '^[0-9]+$'
          ${directTriggerTargetsSql}
        ) targets
        LEFT JOIN private_chat_settings pcs ON targets.user_id = pcs.user_id
        WHERE ${whereClause}
      `, queryParams);
      const totalUsers = totalUsersResult[0]?.total || 0;

      res.json({
        success: true,
        data: privateChatUsers,
        pagination: {
          total: totalUsers,
          page,
          limit,
          totalPages: Math.ceil(totalUsers / limit)
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to fetch private chat users', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch private chat users',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  // 批量更新私聊用户设置
  router.post('/private-chats/batch', async (req, res) => {
    try {
      const { user_ids, is_enabled } = req.body;

      if (!Array.isArray(user_ids) || user_ids.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid user_ids array',
          timestamp: new Date().toISOString()
        });
      }

      // 验证所有ID都是数字
      const validIds = user_ids.filter(id => !isNaN(Number(id)));
      if (validIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No valid user IDs provided',
          timestamp: new Date().toISOString()
        });
      }

      // 构建更新语句
      let updateFields = [];
      let updateValues = [];

      if (is_enabled !== undefined) {
        updateFields.push('is_enabled = ?');
        updateValues.push(is_enabled ? 1 : 0);
      }

      if (is_enabled !== undefined) {
        updateFields.push('auto_reply_enabled = ?');
        updateValues.push(is_enabled ? 1 : 0);
      }

      if (updateFields.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No fields to update',
          timestamp: new Date().toISOString()
        });
      }

      // 添加updated_at字段
      updateFields.push('updated_at = NOW()');

      const placeholders = validIds.map(() => '?').join(',');
      const updateQuery = `
        UPDATE private_chat_settings
        SET ${updateFields.join(', ')}
        WHERE user_id IN (${placeholders})
      `;

      const result = await database.executeUpdate(updateQuery, [...updateValues, ...validIds]);

      logger.info('Batch private chat settings updated', {
        user_ids: validIds,
        is_enabled,
        affectedRows: result
      });

      res.json({
        success: true,
        message: `Successfully updated ${result} users`,
        data: {
          updated_count: result,
          user_ids: validIds
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to batch update private chat settings', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to batch update settings',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.get('/private-chats/:userId/tool-metrics', async (req, res) => {
    try {
      const userId = parseInt(req.params.userId);
      const windowDays = parseMetricsWindowDays(req.query.days);

      if (!userId || Number.isNaN(userId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid user ID',
          timestamp: new Date().toISOString()
        });
      }

      const data = await loadSessionToolMetrics(database, buildRuntimeSessionKey('private', userId), windowDays);

      res.json({
        success: true,
        data,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to fetch private chat tool metrics', { error, userId: req.params.userId });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch private chat tool metrics',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.post('/private-chats', async (req, res) => {
    try {
      const userId = Number(req.body?.user_id);
      const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';

      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid user ID',
          timestamp: new Date().toISOString()
        });
      }

      const success = await database.upsertPrivateChatSettings(userId, {
        username: username || null,
        is_enabled: 1,
        continuous_learning_enabled: 0,
        auto_reply_enabled: 1
      });
      const settings = await database.getPrivateChatSettingById(userId);

      res.status(success ? 201 : 200).json({
        success: true,
        message: 'Private chat created successfully',
        data: settings || {
          user_id: userId,
          username: username || null,
          is_enabled: 1,
          continuous_learning_enabled: 0,
          auto_reply_enabled: 1
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to create private chat settings', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to create private chat settings',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  // 批量删除私聊用户
  router.delete('/private-chats/batch', async (req, res) => {
    try {
      const { user_ids } = req.body;

      if (!Array.isArray(user_ids) || user_ids.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid user_ids array',
          timestamp: new Date().toISOString()
        });
      }

      // 验证所有ID都是数字
      const validIds = user_ids.filter(id => !isNaN(Number(id)));
      if (validIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No valid user IDs provided',
          timestamp: new Date().toISOString()
        });
      }

      const placeholders = validIds.map(() => '?').join(',');

      // 删除用户的私聊设置
      const settingsDeleted = await database.executeUpdate(
        `DELETE FROM private_chat_settings WHERE user_id IN (${placeholders})`,
        validIds
      );

      logger.info('Batch private chat users deleted', {
        user_ids: validIds,
        settingsDeleted
      });

      res.json({
        success: true,
        message: `Successfully deleted ${validIds.length} users`,
        data: {
          deleted_count: validIds.length,
          user_ids: validIds,
          settings_deleted: settingsDeleted
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to batch delete private chat users', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to batch delete users',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  // 更新用户私聊设置
  router.put('/private-chats/:userId/settings', async (req, res) => {
    try {
      const userId = parseInt(req.params.userId);
      const updates = req.body as Record<string, any>;

      if (!userId || isNaN(userId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid user ID',
          timestamp: new Date().toISOString()
        });
      }

      const { sanitizedUpdates, validationError } = normalizeChatSettingUpdates(updates, {
        allowedFields: [
          'username',
          'is_enabled',
          'transcript_compact_offset',
          'welcome_message',
          'user_notes',
        ]
      });

      if (validationError) {
        return res.status(400).json({
          success: false,
          error: validationError,
          timestamp: new Date().toISOString()
        });
      }

      if (Object.keys(sanitizedUpdates).length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No valid fields to update',
          timestamp: new Date().toISOString()
        });
      }

      const success = await database.upsertPrivateChatSettings(userId, sanitizedUpdates);
      const updatedSettings = await database.getPrivateChatSettingById(userId);

      res.json({
        success,
        message: success ? 'User settings updated successfully' : 'User settings unchanged',
        data: updatedSettings ? { ...updatedSettings, user_id: userId } : { user_id: userId, ...sanitizedUpdates },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to update user settings', { error, userId: req.params.userId });
      res.status(500).json({
        success: false,
        error: 'Failed to update user settings',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  // 删除单个私聊用户
  router.delete('/private-chats/:userId', async (req, res) => {
    try {
      const userId = parseInt(req.params.userId);

      if (!userId || isNaN(userId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid user ID',
          timestamp: new Date().toISOString()
        });
      }

      // 删除用户的私聊设置
      await database.executeQuery('DELETE FROM private_chat_settings WHERE user_id = ?', [userId]);

      logger.info('Private chat user deleted', { userId });

      res.json({
        success: true,
        message: 'User deleted successfully',
        data: { user_id: userId },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to delete private chat user', { error, userId: req.params.userId });
      res.status(500).json({
        success: false,
        error: 'Failed to delete user',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.get('/group-chats/:groupId/tool-metrics', async (req, res) => {
    try {
      const groupId = parseInt(req.params.groupId);
      const windowDays = parseMetricsWindowDays(req.query.days);

      if (!groupId || Number.isNaN(groupId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid group ID',
          timestamp: new Date().toISOString()
        });
      }

      const data = await loadSessionToolMetrics(database, buildRuntimeSessionKey('group', groupId), windowDays);

      res.json({
        success: true,
        data,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to fetch group chat tool metrics', { error, groupId: req.params.groupId });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch group chat tool metrics',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  // 更新群聊设置
  router.put('/group-chats/:groupId/settings', async (req, res) => {
    try {
      const groupId = parseInt(req.params.groupId);
      const updates = req.body as Record<string, any>;

      if (!groupId || isNaN(groupId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid group ID',
          timestamp: new Date().toISOString()
        });
      }

      const { sanitizedUpdates, validationError } = normalizeChatSettingUpdates(updates, {
        allowedFields: [
          'group_name',
          'is_enabled',
          'transcript_compact_offset',
          'welcome_message',
          'admin_user_id'
        ]
      });

      if (validationError) {
        return res.status(400).json({
          success: false,
          error: validationError,
          timestamp: new Date().toISOString()
        });
      }

      if (Object.keys(sanitizedUpdates).length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No valid fields to update',
          timestamp: new Date().toISOString()
        });
      }

      const success = await database.upsertGroupChatSettings(groupId, sanitizedUpdates);
      const updatedSettings = await database.getGroupChatSettingById(groupId);

      if (!success) {
        const hasMismatch = updatedSettings
          ? Object.entries(sanitizedUpdates).some(([key, value]) => {
              return (updatedSettings as Record<string, any>)[key] !== value;
            })
          : true;

        if (hasMismatch) {
          return res.status(500).json({
            success: false,
            error: 'Failed to update group settings',
            timestamp: new Date().toISOString()
          });
        }
      }

      res.json({
        success: true,
        message: success ? 'Group settings updated successfully' : 'Group settings unchanged',
        data: updatedSettings || { group_id: groupId, ...sanitizedUpdates },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to update group settings', { error, groupId: req.params.groupId });
      res.status(500).json({
        success: false,
        error: 'Failed to update group settings',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  // Deprecated: Xiaoni now uses one code-owned prompt, not per-private-chat bindings.
  router.put('/private-chats/:userId/prompt', async (req, res) => {
    try {
      const userId = parseInt(req.params.userId);

      if (!userId || isNaN(userId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid user ID',
          timestamp: new Date().toISOString()
        });
      }

      logger.info('Ignored deprecated private chat prompt binding update', { userId });
      res.json({
        success: true,
        message: 'Per-chat prompt binding is deprecated; Xiaoni uses the code-owned prompt.',
        data: { user_id: userId, agent_prompt_id: null, prompt_source: 'code' },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to update private chat prompt', { error, userId: req.params.userId });
      res.status(500).json({
        success: false,
        error: 'Failed to update prompt binding',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  // Deprecated: Xiaoni now uses one code-owned prompt, not per-group bindings.
  router.put('/group-chats/:groupId/prompt', async (req, res) => {
    try {
      const groupId = parseInt(req.params.groupId);

      if (!groupId || isNaN(groupId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid group ID',
          timestamp: new Date().toISOString()
        });
      }

      logger.info('Ignored deprecated group chat prompt binding update', { groupId });
      res.json({
        success: true,
        message: 'Per-chat prompt binding is deprecated; Xiaoni uses the code-owned prompt.',
        data: { group_id: groupId, agent_prompt_id: null, prompt_source: 'code' },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to update group chat prompt', { error, groupId: req.params.groupId });
      res.status(500).json({
        success: false,
        error: 'Failed to update prompt binding',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  return router;
}

export default createChatRoutes;
