import { startServer } from '../server';
import { createClient } from '../client';
import {
  CreateMessageRequestSchema,
  isJSONRPCRequest,
  isJSONRPCResponse,
  isJSONRPCNotification,
  isJSONRPCError,
  JSONRPCMessage,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { jest } from '@jest/globals';
import util from 'node:util';

util.inspect.defaultOptions.depth = null;

jest.setTimeout(20000);

describe('MCP sampling interactions', () => {
  let server: any;
  let mcpServer: any;
  let serverReceived: JSONRPCMessage[];
  let client: any;
  let transport: any;
  const received: JSONRPCMessage[] = [];

  const defaultHandler = async () => ({
    role: 'assistant',
    content: { type: 'text', text: 'The capital of France is Paris.' },
    model: 'claude-3-sonnet-20240307',
    stopReason: 'endTurn'
  });

  beforeAll(async () => {
    ({ server, mcpServer, serverReceived } = startServer(8085));
    ({ client, transport } = await createClient('http://localhost:8085/sse'));
    const origOnmessage = transport.onmessage;
    transport.onmessage = (m: JSONRPCMessage, extra?: any) => {
      received.push(m);
      origOnmessage?.(m, extra);
    };
    client.setRequestHandler(CreateMessageRequestSchema, defaultHandler);
  });

  afterAll(async () => {
    await transport.close();
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    received.splice(0, received.length);
    serverReceived.splice(0, serverReceived.length);
    client.setRequestHandler(CreateMessageRequestSchema, defaultHandler);
  });

  test('Successful Sampling Flow', async () => {
    console.log('=== Successful Sampling Flow ===');
    const nextId = (mcpServer.server as any)._requestMessageId;
    await mcpServer.server.createMessage({
      messages: [
        { role: 'user', content: { type: 'text', text: 'What is the capital of France?' } }
      ],
      modelPreferences: {
        hints: [{ name: 'claude-3-sonnet' }],
        intelligencePriority: 0.8,
        speedPriority: 0.5
      },
      systemPrompt: 'You are a helpful assistant.',
      maxTokens: 100
    });
    const req = received.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(req).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      method: 'sampling/createMessage',
      params: {
        messages: [
          { role: 'user', content: { type: 'text', text: 'What is the capital of France?' } }
        ],
        modelPreferences: {
          hints: [{ name: 'claude-3-sonnet' }],
          intelligencePriority: 0.8,
          speedPriority: 0.5
        },
        systemPrompt: 'You are a helpful assistant.',
        maxTokens: 100
      }
    });
    const resp = serverReceived.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(resp).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: {
        role: 'assistant',
        content: { type: 'text', text: 'The capital of France is Paris.' },
        model: 'claude-3-sonnet-20240307',
        stopReason: 'endTurn'
      }
    });
  });

  test('Sampling Error Handling', async () => {
    console.log('=== Sampling Error Handling ===');
    client.setRequestHandler(CreateMessageRequestSchema, async () => {
      throw new McpError(-1, 'User rejected sampling request');
    });
    const nextId = (mcpServer.server as any)._requestMessageId;
    let error: unknown = null;
    try {
      await mcpServer.server.createMessage({
        messages: [
          { role: 'user', content: { type: 'text', text: 'What is the capital of France?' } }
        ],
        maxTokens: 100
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeTruthy();
    const req = received.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(req).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      method: 'sampling/createMessage',
      params: {
        messages: [
          { role: 'user', content: { type: 'text', text: 'What is the capital of France?' } }
        ],
        maxTokens: 100
      }
    });
    const errResp = serverReceived.find(m => isJSONRPCError(m) && (m as any).id === nextId) as any;
    expect(errResp).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      error: { code: -1, message: 'MCP error -1: User rejected sampling request' }
    });
  });

  test('Sampling with Progress', async () => {
    console.log('=== Sampling with Progress ===');
    client.setRequestHandler(CreateMessageRequestSchema, async (_req: any, { sendNotification, _meta, signal }: any) => {
      for (let i = 1; i <= 2; i++) {
        if (signal.aborted) throw new Error('Cancelled');
        await new Promise(r => setTimeout(r, 50));
        await sendNotification({
          method: 'notifications/progress',
          params: { progressToken: _meta?.progressToken ?? 0, progress: i / 2, total: 1 }
        });
      }
      return {
        role: 'assistant',
        content: { type: 'text', text: 'hello' },
        model: 'claude-3-sonnet-20240307',
        stopReason: 'endTurn'
      };
    });
    const nextId = (mcpServer.server as any)._requestMessageId;
    await mcpServer.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'Say hello' } }],
      _meta: { progressToken: 'abc123' },
      maxTokens: 50
    });
    const req = received.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(req).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      method: 'sampling/createMessage',
      params: {
        messages: [{ role: 'user', content: { type: 'text', text: 'Say hello' } }],
        _meta: { progressToken: 'abc123' },
        maxTokens: 50
      }
    });
    const progress = serverReceived.filter(m => isJSONRPCNotification(m) && m.method === 'notifications/progress');
    expect(progress.length).toBeGreaterThan(0);
    const resp = serverReceived.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(resp).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: {
        role: 'assistant',
        content: { type: 'text', text: 'hello' },
        model: 'claude-3-sonnet-20240307',
        stopReason: 'endTurn'
      }
    });
  });

  test('Sampling Cancellation', async () => {
    console.log('=== Sampling Cancellation ===');
    client.setRequestHandler(CreateMessageRequestSchema, async (_req: any, { sendNotification, _meta, signal }: any) => {
      for (let i = 1; i <= 2; i++) {
        if (signal.aborted) throw new Error('Cancelled');
        await new Promise(r => setTimeout(r, 50));
        await sendNotification({
          method: 'notifications/progress',
          params: { progressToken: _meta?.progressToken ?? 0, progress: i / 2, total: 1, message: `Step ${i}` }
        });
      }
      return { role: 'assistant', content: { type: 'text', text: 'done' }, model: 'claude-3-sonnet-20240307' };
    });
    const cancelId = (mcpServer.server as any)._requestMessageId;
    const ac = new AbortController();
    const promise = mcpServer.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'Cancel me' } }],
      maxTokens: 50
    }, { signal: ac.signal, onprogress: () => { /* ignore progress */ } });
    setTimeout(() => ac.abort('User requested cancellation'), 50);
    let cancelError: unknown = null;
    try {
      await promise;
    } catch (e) {
      cancelError = e;
    }
    await new Promise(r => setTimeout(r, 50));
    const req = received.find(m => isJSONRPCRequest(m) && (m as any).id === cancelId);
    expect(req).toEqual({
      jsonrpc: '2.0',
      id: cancelId,
      method: 'sampling/createMessage',
      params: { messages: [{ role: 'user', content: { type: 'text', text: 'Cancel me' } }], _meta: { progressToken: cancelId }, maxTokens: 50 }
    });
    const cancelMsg = received.find(m => isJSONRPCNotification(m) && m.method === 'notifications/cancelled');
    expect(cancelMsg).toEqual({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: cancelId, reason: 'User requested cancellation' } });
    expect(cancelError).toBeTruthy();
    await new Promise(r => setTimeout(r, 100));
    expect(serverReceived.some(m => (isJSONRPCResponse(m) || isJSONRPCError(m)) && (m as any).id === cancelId)).toBe(false);
    const progressNotification = serverReceived.find(m => isJSONRPCNotification(m) && m.method === 'notifications/progress');
    expect(progressNotification).toEqual({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: cancelId, progress: 0.5, total: 1, message: 'Step 1' } });
  });
});
