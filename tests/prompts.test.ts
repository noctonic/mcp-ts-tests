import { startServer } from '../server';
import { createClient } from '../client';
import {
  PromptListChangedNotificationSchema,
  isJSONRPCResponse,
  isJSONRPCError,
  isJSONRPCRequest,
  isJSONRPCNotification,
  JSONRPCMessage
} from '@modelcontextprotocol/sdk/types.js';
import { jest } from '@jest/globals';
import util from 'node:util';

util.inspect.defaultOptions.depth = null;

jest.setTimeout(20000);

describe('MCP prompt interactions', () => {
  let server: any;
  let mcpServer: any;
  let serverReceived: JSONRPCMessage[];
  let client: any;
  let transport: any;
  const received: JSONRPCMessage[] = [];

  beforeAll(async () => {
    ({ server, mcpServer, serverReceived } = startServer(8083));
    ({ client, transport } = await createClient('http://localhost:8083/sse'));
    const origOnmessage = transport.onmessage;
    transport.onmessage = (m: JSONRPCMessage, extra?: any) => {
      received.push(m);
      origOnmessage?.(m, extra);
    };
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => {});
  });

  afterAll(async () => {
    await transport.close();
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    received.splice(0, received.length);
    serverReceived.splice(0, serverReceived.length);
  });

  test('Prompt Listing', async () => {
    console.log('=== Prompt Listing ===');
    const nextId = (client as any)._requestMessageId;
    await client.listPrompts();
    const listReq = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(listReq).toEqual({ jsonrpc: '2.0', id: nextId, method: 'prompts/list' });
    const listMsg = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(listMsg).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: {
        prompts: [
          {
            name: 'code_review',
            description: 'Code review prompt',
            arguments: [
              { name: 'language', required: true },
              { name: 'code', required: true }
            ]
          },
          {
            name: 'slow_prompt',
            description: 'Slow prompt',
            arguments: [
              { name: 'message', required: true }
            ]
          }
        ]
      }
    });
  });

  test('Prompt Retrieval', async () => {
    console.log('=== Prompt Retrieval ===');
    const nextId = (client as any)._requestMessageId;
    await client.getPrompt({ name: 'code_review', arguments: { language: 'python', code: 'print("hello")' } });
    const getReq = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(getReq).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      method: 'prompts/get',
      params: { name: 'code_review', arguments: { language: 'python', code: 'print("hello")' } }
    });
    const getMsg = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(getMsg).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: {
        description: 'Code review prompt',
        messages: [
          { role: 'user', content: { type: 'text', text: 'Please review this python code:\nprint("hello")' } }
        ]
      }
    });
  });

  test('Prompt Retrieval with Progress', async () => {
    console.log('=== Prompt Retrieval with Progress ===');
    const nextId = (client as any)._requestMessageId;
    await client.getPrompt({ name: 'slow_prompt', arguments: { message: 'hello' } }, {
      onprogress: () => { /* progress events logged */ }
    });
    const progressReq = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(progressReq).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      method: 'prompts/get',
      params: { name: 'slow_prompt', arguments: { message: 'hello' }, _meta: { progressToken: nextId } }
    });
    const progressNotifications = received.filter(m => isJSONRPCNotification(m) && m.method === 'notifications/progress');
    expect(progressNotifications.length).toBeGreaterThan(0);
    const getMsg = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(getMsg).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: {
        description: 'Slow prompt',
        messages: [
          { role: 'user', content: { type: 'text', text: 'hello' } }
        ]
      }
    });
  });

  test('Prompt Retrieval Cancellation', async () => {
    console.log('=== Prompt Retrieval Cancellation ===');
    const cancelId = (client as any)._requestMessageId;
    const ac = new AbortController();
    const promise = client.getPrompt({ name: 'slow_prompt', arguments: { message: 'cancel' } }, {
      signal: ac.signal,
      onprogress: () => { /* ignore progress */ }
    });
    setTimeout(() => ac.abort('User requested cancellation'), 100);
    let getError: unknown = null;
    try {
      await promise;
    } catch (e) {
      getError = e;
    }
    await new Promise(r => setTimeout(r, 50));
    const req = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === cancelId);
    expect(req).toEqual({
      jsonrpc: '2.0',
      id: cancelId,
      method: 'prompts/get',
      params: { name: 'slow_prompt', arguments: { message: 'cancel' }, _meta: { progressToken: cancelId } }
    });
    const cancelMsg = serverReceived.find(m => isJSONRPCNotification(m) && m.method === 'notifications/cancelled');
    expect(cancelMsg).toEqual({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: cancelId, reason: 'User requested cancellation' } });
    expect(getError).toBeTruthy();
    await new Promise(r => setTimeout(r, 100));
    expect(received.some(m => (isJSONRPCResponse(m) || isJSONRPCError(m)) && (m as any).id === cancelId)).toBe(false);
    const progressNotification = received.find(m => isJSONRPCNotification(m) && m.method === 'notifications/progress');
    expect(progressNotification).toEqual({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: cancelId, progress: 1, total: 5, message: 'Step 1' } });
  });

  test('Prompt List Changed Notifications', async () => {
    console.log('=== Prompt List Changed Notifications ===');
    mcpServer.prompt('temp_prompt', 'Temp prompt', {}, async () => ({
      description: 'Temp',
      messages: [{ role: 'user', content: { type: 'text', text: 'temp' } }]
    }));
    await new Promise(r => setTimeout(r, 50));
    const listChanged = received.find(m => isJSONRPCNotification(m) && m.method === 'notifications/prompts/list_changed');
    expect(listChanged).toEqual({ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' });
  });
});
