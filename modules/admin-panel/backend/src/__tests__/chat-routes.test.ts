import express from 'express';
import request from 'supertest';
import winston from 'winston';
import { createChatRoutes, normalizeChatSettingUpdates } from '../routes/chat-routes';

function createLogger(): winston.Logger {
  return winston.createLogger({ silent: true });
}

function createDatabaseMock() {
  return {
    executeQuery: jest.fn(),
    getPrivateChatSettingById: jest.fn(),
    upsertPrivateChatSettings: jest.fn(),
    upsertGroupChatSettings: jest.fn(),
    getGroupChatSettingById: jest.fn(),
  };
}

function createApp(database: ReturnType<typeof createDatabaseMock>) {
  const app = express();
  app.use(express.json());
  app.use('/api', createChatRoutes(database as never, createLogger()));
  return app;
}

describe('chat settings routes', () => {
  it('normalizes boolean group toggle fields to integer flags', async () => {
    const database = createDatabaseMock();
    database.upsertGroupChatSettings.mockResolvedValue(true);
    database.getGroupChatSettingById.mockResolvedValue({
      group_id: 123,
      group_name: 'Test Group',
      is_enabled: 0,
      continuous_learning_enabled: 0,
      auto_reply_enabled: 0,
      transcript_compact_offset: 6,
      agent_prompt_id: 'prompt-123',
    });

    const response = await request(createApp(database))
      .put('/api/group-chats/123/settings')
      .send({ is_enabled: false, auto_reply_enabled: true });

    expect(response.status).toBe(200);
    expect(database.upsertGroupChatSettings).toHaveBeenCalledWith(123, {
      is_enabled: 0,
      auto_reply_enabled: 0,
    });
    expect(response.body.data).toMatchObject({
      group_id: 123,
      is_enabled: 0,
      auto_reply_enabled: 0,
    });
  });

  it('mirrors private chat IM entry into internal delivery state', async () => {
    const database = createDatabaseMock();
    database.upsertPrivateChatSettings.mockResolvedValue(true);
    database.getPrivateChatSettingById
      .mockResolvedValueOnce({
        user_id: 456,
        username: 'tester',
        is_enabled: 1,
        continuous_learning_enabled: 1,
        auto_reply_enabled: 1,
        transcript_compact_offset: 6,
        welcome_message: null,
        user_notes: null,
        agent_prompt_id: 'prompt-456',
        last_activity: null,
      })
      .mockResolvedValue({
        user_id: 456,
        username: 'tester',
        is_enabled: 1,
        continuous_learning_enabled: 1,
        auto_reply_enabled: 1,
        transcript_compact_offset: 6,
        welcome_message: null,
        user_notes: null,
        agent_prompt_id: 'prompt-456',
        last_activity: null,
      });

    const response = await request(createApp(database))
      .put('/api/private-chats/456/settings')
      .send({ is_enabled: true, auto_reply_enabled: false });

    expect(response.status).toBe(200);
    expect(database.upsertPrivateChatSettings).toHaveBeenCalledWith(456, {
      is_enabled: 1,
      auto_reply_enabled: 1,
    });
    expect(response.body.data).toMatchObject({
      user_id: 456,
      is_enabled: 1,
      auto_reply_enabled: 1,
    });
  });

  it('filters forced owner private chats by effective IM entry state', async () => {
    const previousDirectIds = process.env.XIAONI_DIRECT_AGENT_TRIGGER_USER_IDS;
    process.env.XIAONI_DIRECT_AGENT_TRIGGER_USER_IDS = '85178516';
    try {
      const database = createDatabaseMock();
      database.executeQuery
        .mockResolvedValueOnce([
          {
            user_id: 85178516,
            nickname: '用户85178516',
            direct_force_im_trigger_enabled: 1,
            im_receive_enabled: 1,
            agent_im_entry_enabled: 1,
            total_conversations: 0,
            successful_replies: 0,
            failed_replies: 0,
            success_rate: 0,
            avg_response_time: '0ms',
            is_enabled: 0,
            continuous_learning_enabled: 0,
            auto_reply_enabled: 1,
          },
        ])
        .mockResolvedValueOnce([{ total: '1' }]);

      const response = await request(createApp(database))
        .get('/api/private-chats?search=85178516&is_enabled=true&auto_reply_enabled=true');

      expect(response.status).toBe(200);
      expect(response.body.data[0]).toMatchObject({
        user_id: 85178516,
        direct_force_im_trigger_enabled: 1,
        im_receive_enabled: 1,
        agent_im_entry_enabled: 1,
        auto_reply_enabled: 1,
      });
      expect(database.executeQuery).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('WHEN targets.user_id IN (85178516) THEN 1'),
        ['%85178516%', '%85178516%', 1, 1]
      );
      expect(database.executeQuery.mock.calls[0][0]).toContain('CAST(targets.user_id AS TEXT) LIKE ?');
    } finally {
      if (previousDirectIds === undefined) {
        delete process.env.XIAONI_DIRECT_AGENT_TRIGGER_USER_IDS;
      } else {
        process.env.XIAONI_DIRECT_AGENT_TRIGGER_USER_IDS = previousDirectIds;
      }
    }
  });

  it('casts group ids to text for group chat search', async () => {
    const database = createDatabaseMock();
    database.executeQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: '0' }])
      .mockResolvedValueOnce([{ total_groups: '0' }]);

    const response = await request(createApp(database))
      .get('/api/group-chats?search=123');

    expect(response.status).toBe(200);
    expect(database.executeQuery.mock.calls[0][0]).toContain('CAST(g.group_id AS TEXT) LIKE ?');
    expect(database.executeQuery).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      ['%123%', '%123%']
    );
  });

  it('rejects deprecated continuous learning updates', async () => {
    const database = createDatabaseMock();

    const response = await request(createApp(database))
      .put('/api/private-chats/456/settings')
      .send({ continuous_learning_enabled: true });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('No valid fields to update');
    expect(database.upsertPrivateChatSettings).not.toHaveBeenCalled();
  });

  it('accepts transcript_compact_offset for group and private chat settings', async () => {
    const database = createDatabaseMock();
    database.upsertGroupChatSettings.mockResolvedValue(true);
    database.getGroupChatSettingById.mockResolvedValue({
      group_id: 123,
      transcript_compact_offset: 12,
    });
    database.upsertPrivateChatSettings.mockResolvedValue(true);
    database.getPrivateChatSettingById.mockResolvedValue({
        user_id: 456,
        transcript_compact_offset: 9,
      });

    const app = createApp(database);
    const [groupResponse, privateResponse] = await Promise.all([
      request(app)
        .put('/api/group-chats/123/settings')
        .send({ transcript_compact_offset: 12 }),
      request(app)
        .put('/api/private-chats/456/settings')
        .send({ transcript_compact_offset: 9 }),
    ]);

    expect(groupResponse.status).toBe(200);
    expect(privateResponse.status).toBe(200);
    expect(database.upsertGroupChatSettings).toHaveBeenCalledWith(123, {
      transcript_compact_offset: 12,
    });
    expect(database.upsertPrivateChatSettings).toHaveBeenCalledWith(456, {
      transcript_compact_offset: 9,
    });
  });

  it('rejects invalid transcript_compact_offset values', async () => {
    const database = createDatabaseMock();
    const app = createApp(database);

    const [groupResponse, privateResponse] = await Promise.all([
      request(app)
        .put('/api/group-chats/123/settings')
        .send({ transcript_compact_offset: -1 }),
      request(app)
        .put('/api/private-chats/456/settings')
        .send({ transcript_compact_offset: 1.5 }),
    ]);

    expect(groupResponse.status).toBe(400);
    expect(privateResponse.status).toBe(400);
    expect(groupResponse.body.error).toBe('transcript_compact_offset must be an integer between 0 and 500');
    expect(privateResponse.body.error).toBe('transcript_compact_offset must be an integer between 0 and 500');
  });

  it('rejects empty settings updates', async () => {
    const database = createDatabaseMock();
    const app = createApp(database);

    const groupResponse = await request(app)
      .put('/api/group-chats/123/settings')
      .send({});
    const privateResponse = await request(app)
      .put('/api/private-chats/456/settings')
      .send({});

    expect(groupResponse.status).toBe(400);
    expect(groupResponse.body.error).toBe('No valid fields to update');
    expect(privateResponse.status).toBe(400);
    expect(privateResponse.body.error).toBe('No valid fields to update');
  });

  it('rejects direct group auto reply updates because delivery is derived from IM entry', async () => {
    const database = createDatabaseMock();

    const response = await request(createApp(database))
      .put('/api/group-chats/123/settings')
      .send({ auto_reply_enabled: true });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('No valid fields to update');
    expect(database.upsertGroupChatSettings).not.toHaveBeenCalled();
  });

  it('rejects direct private auto reply updates because delivery is derived from IM entry', async () => {
    const database = createDatabaseMock();

    const response = await request(createApp(database))
      .put('/api/private-chats/456/settings')
      .send({ auto_reply_enabled: true });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('No valid fields to update');
    expect(database.upsertPrivateChatSettings).not.toHaveBeenCalled();
  });

  it('ignores private prompt binding fields in settings updates', async () => {
    const database = createDatabaseMock();
    const response = await request(createApp(database))
      .put('/api/private-chats/456/settings')
      .send({ auto_reply_enabled: true, agent_prompt_id: 'prompt-456' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('No valid fields to update');
    expect(database.upsertPrivateChatSettings).not.toHaveBeenCalled();
  });

  it('clears child switches when receive is disabled', () => {
    expect(normalizeChatSettingUpdates(
      {
        is_enabled: false,
        continuous_learning_enabled: true,
        auto_reply_enabled: true,
      },
      {
        allowedFields: ['is_enabled'],
      }
    )).toEqual({
      sanitizedUpdates: {
        is_enabled: 0,
        auto_reply_enabled: 0,
      },
      validationError: null,
    });
  });

  it('returns grouped tool hit metrics for a group chat detail page', async () => {
    const database = createDatabaseMock();
    database.executeQuery
      .mockResolvedValueOnce([{ total_runs: 20 }])
      .mockResolvedValueOnce([
        {
          tool_name: 'recover_energy',
          hit_count: 14,
          run_count: 14,
          successful_hit_count: 14,
          last_hit_at: '2026-04-28T01:23:45.000Z'
        },
        {
          tool_name: 'speak_in_group',
          hit_count: 20,
          run_count: 20,
          successful_hit_count: 20,
          last_hit_at: '2026-04-28T01:23:40.000Z'
        }
      ]);

    const response = await request(createApp(database))
      .get('/api/group-chats/253631878/tool-metrics?days=7');

    expect(response.status).toBe(200);
    expect(database.executeQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('FROM agent_runs'),
      ['qq:group:253631878', expect.any(String)]
    );
    expect(database.executeQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM tool_executions'),
      ['qq:group:253631878', expect.any(String)]
    );
    expect(response.body.data).toMatchObject({
      session_key: 'qq:group:253631878',
      window_days: 7,
      total_runs: 20
    });
    expect(response.body.data.tools).toEqual([
      {
        tool_name: 'recover_energy',
        hit_count: 14,
        run_count: 14,
        successful_hit_count: 14,
        run_hit_rate: 0.7,
        avg_hits_per_hit_run: 1,
        last_hit_at: '2026-04-28T01:23:45.000Z'
      },
      {
        tool_name: 'speak_in_group',
        hit_count: 20,
        run_count: 20,
        successful_hit_count: 20,
        run_hit_rate: 1,
        avg_hits_per_hit_run: 1,
        last_hit_at: '2026-04-28T01:23:40.000Z'
      }
    ]);
  });

  it('returns grouped tool hit metrics for a private chat detail page', async () => {
    const database = createDatabaseMock();
    database.executeQuery
      .mockResolvedValueOnce([{ total_runs: 8 }])
      .mockResolvedValueOnce([
        {
          tool_name: 'speak_in_group',
          hit_count: 3,
          run_count: 2,
          successful_hit_count: 3,
          last_hit_at: '2026-04-28T02:00:00.000Z'
        }
      ]);

    const response = await request(createApp(database))
      .get('/api/private-chats/1129974489/tool-metrics?days=14');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      session_key: 'qq:private:1129974489',
      window_days: 14,
      total_runs: 8
    });
    expect(response.body.data.tools).toEqual([
      {
        tool_name: 'speak_in_group',
        hit_count: 3,
        run_count: 2,
        successful_hit_count: 3,
        run_hit_rate: 0.25,
        avg_hits_per_hit_run: 1.5,
        last_hit_at: '2026-04-28T02:00:00.000Z'
      }
    ]);
  });
});
