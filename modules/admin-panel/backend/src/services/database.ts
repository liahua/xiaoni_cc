import { createSqlAdapter, getPrismaClient, type SqlAdapter } from '@qq-bot/persistence';
import winston from 'winston';

interface DatabaseConfig {
  databaseUrl?: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  timezone: string;
  connectionLimit?: number;
}

interface RequirementData {
  id: string;
  user_id: number;
  message: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  created_at: Date;
  updated_at: Date;
  claude_code_output?: string;
  completion_details?: string;
  error_message?: string;
  processing_start_time?: Date;
  processing_end_time?: Date;
}

interface SessionData {
  session_id: string;
  user_id: number;
  session_type: 'chat' | 'requirement' | 'mixed';
  current_service: string;
  status: 'active' | 'paused' | 'completed' | 'expired';
  created_at: Date;
  last_activity: Date;
  expires_at?: Date;
  conversation_context?: any;
  business_context?: any;
  message_count: number;
}

export class DatabaseManager {
  private sql: SqlAdapter | null = null;
  private config: DatabaseConfig;
  private prisma!: ReturnType<typeof getPrismaClient>;
  private logger: winston.Logger;
  private operationalIndexesEnsured = false;

  constructor(config: DatabaseConfig, logger: winston.Logger) {
    this.config = config;
    this.logger = logger;
    this.createConnectionPool();
  }

  private createConnectionPool(): void {
    try {
      this.sql = createSqlAdapter({
        databaseUrl: this.config.databaseUrl,
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        connectionLimit: this.config.connectionLimit || 5,
        applicationName: 'admin-backend'
      });
      this.prisma = getPrismaClient({
        databaseUrl: this.config.databaseUrl,
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database
      });

      this.logger.info('Database connection pool initialized (Admin Backend)', { connectionLimit: this.config.connectionLimit || 5 });
    } catch (error) {
      this.logger.error('Error creating connection pool', { error });
      this.sql = null;
    }
  }

  private handleConnectionLost(): void {
    this.logger.warn('Connection lost, attempting to recreate pool...');
    this.sql = null;
    // 立即重建连接池，不等待
    this.createConnectionPool();
  }

  public async testConnection(): Promise<boolean> {
    try {
      if (!this.sql) {
        this.createConnectionPool();
      }
      const healthy = await this.sql!.testConnection();
      if (healthy) {
        this.logger.info('Database connection test successful');
      }
      return healthy;
    } catch (error) {
      this.logger.error('Database connection test failed', { error });
      return false;
    }
  }

  public async executeQuery<T>(query: string, params: any[] = []): Promise<T[]> {
    try {
      if (!this.sql) {
        this.createConnectionPool();
      }
      return await this.sql!.query<T>(query, params);
    } catch (error) {
      this.logger.error('Database query failed', { query, params, error });
      throw error;
    }
  }

  public async executeUpdate(query: string, params: any[] = []): Promise<number> {
    try {
      if (!this.sql) {
        this.createConnectionPool();
      }
      return await this.sql!.execute(query, params);
    } catch (error) {
      this.logger.error('Database update failed', { query, params, error });
      throw error;
    }
  }

  public async executeInsert(query: string, params: any[] = []): Promise<{ insertId: number; affectedRows: number }> {
    try {
      if (!this.sql) {
        this.createConnectionPool();
      }
      return await this.sql!.insert(query, params);
    } catch (error) {
      this.logger.error('Database insert failed', { query, params, error });
      throw error;
    }
  }

  // Requirements相关方法
  public async getRequirements(options: {
    limit?: number;
    offset?: number;
    status?: string;
  } = {}): Promise<{ data: RequirementData[]; total: number }> {
    const { limit = 20, offset = 0, status } = options;
    
    let whereClause = 'WHERE 1=1';
    const params: any[] = [];

    if (status) {
      whereClause += ' AND status = ?';
      params.push(status);
    }


    try {
      // 获取总数
      const totalQuery = `SELECT COUNT(*) as total FROM requirements ${whereClause}`;
      const totalResult = await this.executeQuery<{ total: number }>(totalQuery, params);
      const total = totalResult[0]?.total || 0;

      // 获取数据 - LIMIT/OFFSET不支持参数绑定，使用字符串插值（已验证为安全数值）
      const dataQuery = `
        SELECT id, user_id, message, status, claude_code_output, completion_details, 
               error_message, processing_start_time, processing_end_time, 
               created_at, updated_at
        FROM requirements 
        ${whereClause}
        ORDER BY created_at DESC 
        LIMIT ${parseInt(limit.toString())} OFFSET ${parseInt(offset.toString())}
      `;
      
      const data = await this.executeQuery<RequirementData>(dataQuery, params);

      return { data, total };
    } catch (error) {
      this.logger.error('Failed to query requirements table', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : 'No stack trace',
        whereClause,
        params: params,
        limit,
        offset,
        queryType: 'requirements'
      });
      throw error; // 重新抛出错误，不允许静默处理
    }
  }

  // Sessions相关方法
  public async getSessions(options: {
    limit?: number;
    offset?: number;
    status?: string;
    userId?: string;
  } = {}): Promise<{ data: SessionData[]; total: number }> {
    const { limit = 20, offset = 0, status, userId } = options;
    
    let whereClause = 'WHERE 1=1';
    const params: any[] = [];

    if (status) {
      whereClause += ' AND status = ?';
      params.push(status);
    }

    if (userId) {
      whereClause += ' AND user_id = ?';
      params.push(parseInt(userId));
    }


    try {
      // 获取总数
      const totalQuery = `SELECT COUNT(*) as total FROM conversation_sessions ${whereClause}`;
      const totalResult = await this.executeQuery<{ total: number }>(totalQuery, params);
      const total = totalResult[0]?.total || 0;

      // 获取数据 - LIMIT/OFFSET不支持参数绑定，使用字符串插值（已验证为安全数值）
      const dataQuery = `
        SELECT session_id, user_id, session_type, current_service, status, 
               created_at, last_activity, expires_at, message_count
        FROM conversation_sessions 
        ${whereClause}
        ORDER BY last_activity DESC 
        LIMIT ${parseInt(limit.toString())} OFFSET ${parseInt(offset.toString())}
      `;
      
      const data = await this.executeQuery<SessionData>(dataQuery, params);

      return { data, total };
    } catch (error) {
      this.logger.error('Failed to query conversation_sessions table', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : 'No stack trace',
        whereClause,
        params: params,
        limit,
        offset,
        queryType: 'sessions'
      });
      throw error; // 重新抛出错误，不允许静默处理
    }
  }

  // 系统统计方法
  // Prompt binding methods
  public async getAgentPromptById(id: string): Promise<any | null> {
    const query = 'SELECT * FROM agent_prompts WHERE id = ?';
    try {
      const results = await this.executeQuery<any>(query, [id]);
      if (results.length > 0) {
        const prompt = results[0];
        // Parse JSON fields
        if (typeof prompt.system_instructions === 'string') {
          prompt.system_instructions = JSON.parse(prompt.system_instructions);
        }
        if (typeof prompt.context_variables === 'string') {
          prompt.context_variables = JSON.parse(prompt.context_variables);
        }
        if (typeof prompt.model_config === 'string') {
          prompt.model_config = JSON.parse(prompt.model_config);
        }
        return prompt;
      }
      return null;
    } catch (error) {
      this.logger.error('Failed to get agent prompt by id', { error, id });
      return null;
    }
  }

  public async updatePrivateChatPrompt(userId: number, promptId: string | null): Promise<boolean> {
    try {
      await this.prisma.privateChatSetting.upsert({
        where: { user_id: BigInt(userId) },
        create: {
          user_id: BigInt(userId),
          agent_prompt_id: promptId,
          is_enabled: 1,
          continuous_learning_enabled: 1,
          auto_reply_enabled: 0,
          transcript_compact_offset: 6
        },
        update: {
          agent_prompt_id: promptId
        }
      });

      this.logger.info('Private chat prompt mapping updated', { userId, promptId });
      return true;
    } catch (error) {
      this.logger.error('Failed to update private chat prompt', { error, userId, promptId });
      return false;
    }
  }

  public async updateGroupChatPrompt(groupId: number, promptId: string | null): Promise<boolean> {
    try {
      await this.prisma.groupChatSetting.upsert({
        where: { group_id: BigInt(groupId) },
        create: {
          group_id: BigInt(groupId),
          agent_prompt_id: promptId,
          is_enabled: 1,
          continuous_learning_enabled: 1,
          auto_reply_enabled: 0,
          transcript_compact_offset: 6
        },
        update: {
          agent_prompt_id: promptId
        }
      });

      this.logger.info('Group chat prompt mapping updated', { groupId, promptId });
      return true;
    } catch (error) {
      this.logger.error('Failed to update group chat prompt', { error, groupId, promptId });
      return false;
    }
  }

  public async upsertGroupChatSettings(groupId: number, updates: Record<string, any>): Promise<boolean> {
    try {
      const fields = Object.keys(updates);
      if (fields.length === 0) {
        return false;
      }
      await this.prisma.groupChatSetting.upsert({
        where: { group_id: BigInt(groupId) },
        create: {
          group_id: BigInt(groupId),
          is_enabled: 1,
          continuous_learning_enabled: 1,
          auto_reply_enabled: 0,
          ...updates
        },
        update: updates
      });

      this.logger.info('Group chat settings upserted', { groupId, updates });
      return true;
    } catch (error) {
      this.logger.error('Failed to upsert group chat settings', { error, groupId, updates });
      return false;
    }
  }

  public async getPrivateChatSettingById(userId: number): Promise<any | null> {
    try {
      const query = `
        SELECT user_id, username, is_enabled,
               CASE WHEN is_enabled = 1 THEN continuous_learning_enabled ELSE 0 END as continuous_learning_enabled,
               CASE WHEN is_enabled = 1 THEN auto_reply_enabled ELSE 0 END as auto_reply_enabled,
               welcome_message, user_notes,
               transcript_compact_offset, agent_prompt_id, last_activity, created_at, updated_at
        FROM private_chat_settings
        WHERE user_id = ?
      `;
      const results = await this.executeQuery<any>(query, [userId]);
      return results[0] || null;
    } catch (error) {
      this.logger.error('Failed to get private chat settings', { error, userId });
      return null;
    }
  }

  private async tableExists(tableName: string): Promise<boolean> {
    const rows = await this.executeQuery<{ total: number }>(
      `SELECT COUNT(*) AS total
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = ?`,
      [tableName]
    );

    return (rows[0]?.total || 0) > 0;
  }

  private async ensureIndex(tableName: string, indexName: string, ddl: string): Promise<void> {
    if (!(await this.tableExists(tableName))) {
      return;
    }

    const rows = await this.executeQuery<{ total: number }>(
      `SELECT COUNT(*) AS total
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = ?
         AND indexname = ?`,
      [tableName, indexName]
    );

    if ((rows[0]?.total || 0) > 0) {
      return;
    }

    try {
      await this.executeUpdate(ddl);
      this.logger.info('Ensured operational index', { tableName, indexName });
    } catch (error: any) {
      if (error?.code === '42P07' || error?.code === '42710') {
        this.logger.info('Operational index already exists after concurrent creation', { tableName, indexName });
        return;
      }

      this.logger.error('Failed to ensure operational index', { tableName, indexName, error });
      throw error;
    }
  }

  public async ensureOperationalIndexes(): Promise<void> {
    if (this.operationalIndexesEnsured) {
      return;
    }

    await this.ensureChatSettingsColumns();

    const indexes = [
      {
        tableName: 'prompt_debug_sessions',
        indexName: 'idx_prompt_updated_at_id',
        ddl: 'CREATE INDEX IF NOT EXISTS idx_prompt_updated_at_id ON prompt_debug_sessions (prompt_id, updated_at, id)'
      },
      {
        tableName: 'http_traffic_logs',
        indexName: 'idx_trace_request_time_id',
        ddl: 'CREATE INDEX IF NOT EXISTS idx_trace_request_time_id ON http_traffic_logs (trace_id, request_timestamp, id)'
      },
      {
        tableName: 'http_traffic_logs',
        indexName: 'idx_conversation_request_time_id',
        ddl: 'CREATE INDEX IF NOT EXISTS idx_conversation_request_time_id ON http_traffic_logs (conversation_id, request_timestamp, id)'
      },
      {
        tableName: 'http_traffic_logs',
        indexName: 'idx_llm_call_request_time_id',
        ddl: 'CREATE INDEX IF NOT EXISTS idx_llm_call_request_time_id ON http_traffic_logs (llm_call_id, request_timestamp, id)'
      },
      {
        tableName: 'websocket_logs',
        indexName: 'idx_trace_timestamp_id',
        ddl: 'CREATE INDEX IF NOT EXISTS idx_trace_timestamp_id ON websocket_logs (trace_id, timestamp, id)'
      },
      {
        tableName: 'llm_jobs',
        indexName: 'idx_trace_created_id',
        ddl: 'CREATE INDEX IF NOT EXISTS idx_trace_created_id ON llm_jobs (trace_id, created_at, id)'
      },
      {
        tableName: 'traffic_replay_history',
        indexName: 'idx_original_log_replayed_at_id',
        ddl: 'CREATE INDEX IF NOT EXISTS idx_original_log_replayed_at_id ON traffic_replay_history (original_log_id, replayed_at, id)'
      },
      {
        tableName: 'group_message_history',
        indexName: 'idx_group_history_id',
        ddl: 'CREATE INDEX IF NOT EXISTS idx_group_history_id ON group_message_history (group_id, id)'
      },
      {
        tableName: 'group_message_history',
        indexName: 'idx_group_message_id_lookup',
        ddl: 'CREATE INDEX IF NOT EXISTS idx_group_message_id_lookup ON group_message_history (group_id, message_id, id)'
      },
      {
        tableName: 'private_message_history',
        indexName: 'idx_user_history_id',
        ddl: 'CREATE INDEX IF NOT EXISTS idx_user_history_id ON private_message_history (user_id, id)'
      },
      {
        tableName: 'private_message_history',
        indexName: 'idx_private_message_id_lookup',
        ddl: 'CREATE INDEX IF NOT EXISTS idx_private_message_id_lookup ON private_message_history (user_id, message_id, id)'
      },
      {
        tableName: 'conversation_batches',
        indexName: 'idx_source_created_at_id',
        ddl: 'CREATE INDEX IF NOT EXISTS idx_source_created_at_id ON conversation_batches (source_key, created_at, id)'
      },
      {
        tableName: 'llm_tools',
        indexName: 'idx_enabled_total_calls_success_calls_id',
        ddl: 'CREATE INDEX IF NOT EXISTS idx_enabled_total_calls_success_calls_id ON llm_tools (enabled, total_calls, success_calls, id)'
      }
    ];

    for (const index of indexes) {
      await this.ensureIndex(index.tableName, index.indexName, index.ddl);
    }

    this.operationalIndexesEnsured = true;
  }

  public async upsertPrivateChatSettings(userId: number, updates: Record<string, any>): Promise<boolean> {
    try {
      const fields = Object.keys(updates);
      if (fields.length === 0) {
        return false;
      }
      await this.prisma.privateChatSetting.upsert({
        where: { user_id: BigInt(userId) },
        create: {
          user_id: BigInt(userId),
          is_enabled: 1,
          continuous_learning_enabled: 1,
          auto_reply_enabled: 0,
          transcript_compact_offset: 6,
          ...updates
        },
        update: updates
      });

      this.logger.info('Private chat settings upserted', { userId, updates });
      return true;
    } catch (error) {
      this.logger.error('Failed to upsert private chat settings', { error, userId, updates });
      return false;
    }
  }

  public async getGroupChatSettingById(groupId: number): Promise<any | null> {
    try {
      const query = `
        SELECT group_id, group_name, is_enabled,
               CASE WHEN is_enabled = 1 THEN continuous_learning_enabled ELSE 0 END as continuous_learning_enabled,
               CASE WHEN is_enabled = 1 THEN auto_reply_enabled ELSE 0 END as auto_reply_enabled,
               welcome_message,
               transcript_compact_offset, admin_user_id, agent_prompt_id, last_activity, created_at, updated_at
        FROM group_chat_settings
        WHERE group_id = ?
      `;
      const results = await this.executeQuery<any>(query, [groupId]);
      return results[0] || null;
    } catch (error) {
      this.logger.error('Failed to get group chat settings', { error, groupId });
      return null;
    }
  }

  public async close(): Promise<void> {
    if (this.sql) {
      await this.sql.close();
      this.sql = null;
    }
    this.logger.info('Database connection pool closed');
  }

  private async ensureChatSettingsColumns(): Promise<void> {
    await this.executeUpdate(
      `ALTER TABLE private_chat_settings
       ADD COLUMN IF NOT EXISTS continuous_learning_enabled INTEGER NOT NULL DEFAULT 1`
    );
    await this.executeUpdate(
      `ALTER TABLE group_chat_settings
       ADD COLUMN IF NOT EXISTS continuous_learning_enabled INTEGER NOT NULL DEFAULT 1`
    );
    await this.executeUpdate(
      `ALTER TABLE private_chat_settings
       ADD COLUMN IF NOT EXISTS transcript_compact_offset INTEGER NOT NULL DEFAULT 6`
    );
    await this.executeUpdate(
      `ALTER TABLE group_chat_settings
       ADD COLUMN IF NOT EXISTS transcript_compact_offset INTEGER NOT NULL DEFAULT 6`
    );
  }
}
