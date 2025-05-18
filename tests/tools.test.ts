import { startServer } from '../server';
import { createClient } from '../client';
import {
  ToolListChangedNotificationSchema,
  isJSONRPCRequest,
  isJSONRPCResponse,
  isJSONRPCNotification,
  JSONRPCMessage,
  isJSONRPCError
} from '@modelcontextprotocol/sdk/types.js';
import { jest } from '@jest/globals';
import util from 'node:util';

util.inspect.defaultOptions.depth = null;

jest.setTimeout(20000);

describe('MCP tool interactions', () => {
  let server: any;
  let mcpServer: any;
  let serverReceived: JSONRPCMessage[];
  let client: any;
  let transport: any;
  const received: JSONRPCMessage[] = [];

  beforeAll(async () => {
    ({ server, mcpServer, serverReceived } = startServer(8082));
    ({ client, transport } = await createClient('http://localhost:8082/sse'));
    const origOnmessage = transport.onmessage;
    transport.onmessage = (m: JSONRPCMessage, extra?: any) => {
      received.push(m);
      origOnmessage?.(m, extra);
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {});
  });

  afterAll(async () => {
    await transport.close();
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    received.splice(0, received.length);
    serverReceived.splice(0, serverReceived.length);
  });

  test('Tool Listing', async () => {
    console.log('=== Tool Listing ===');
    const nextId = (client as any)._requestMessageId;
    await client.listTools();
    const listReq = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(listReq).toEqual({ jsonrpc: '2.0', id: nextId, method: 'tools/list' });
    const listMsg = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(listMsg).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: {
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather information',
            inputSchema: {
              type: 'object',
              properties: {
                location: { type: 'string', description: 'Location' }
              },
              required: ['location'],
              additionalProperties: false,
              $schema: 'http://json-schema.org/draft-07/schema#'
            }
          },
          {
            name: 'slow_echo',
            description: 'Echo text with delay',
            inputSchema: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                delay: { type: 'number', default: 500 }
              },
              required: ['message'],
              additionalProperties: false,
              $schema: 'http://json-schema.org/draft-07/schema#'
            }
          }
        ]
      }
    });
  });

  test('Tool List Changed Notifications', async () => {
    console.log('=== Tool List Changed Notifications ===');
    mcpServer.tool('ping', 'Ping tool', async () => ({ content: [{ type: 'text', text: 'pong' }] }));
    await new Promise(r => setTimeout(r, 50));
    const listChanged = received.find(m => isJSONRPCNotification(m) && m.method === 'notifications/tools/list_changed');
    expect(listChanged).toEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });

    const nextId = (client as any)._requestMessageId;
    await client.listTools();
    const listReq = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(listReq).toEqual({ jsonrpc: '2.0', id: nextId, method: 'tools/list' });
    const listMsg = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(listMsg).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: {
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather information',
            inputSchema: {
              type: 'object',
              properties: {
                location: { type: 'string', description: 'Location' }
              },
              required: ['location'],
              additionalProperties: false,
              $schema: 'http://json-schema.org/draft-07/schema#'
            }
          },
          {
            name: 'slow_echo',
            description: 'Echo text with delay',
            inputSchema: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                delay: { type: 'number', default: 500 }
              },
              required: ['message'],
              additionalProperties: false,
              $schema: 'http://json-schema.org/draft-07/schema#'
            }
          },
          {
            name: 'ping',
            description: 'Ping tool',
            inputSchema: { type: 'object' }
          }
        ]
      }
    });
  });

  test('Tool Invocation With Arguments', async () => {
    console.log('=== Tool Invocation With Arguments ===');
    const nextId = (client as any)._requestMessageId;
    await client.callTool({ name: 'get_weather', arguments: { location: 'New York' } });
    const callReq = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(callReq).toEqual({ jsonrpc: '2.0', id: nextId, method: 'tools/call', params: { name: 'get_weather', arguments: { location: 'New York' } } });
    const callMsg = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(callMsg).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: {
        content: [
          { type: 'text', text: 'Current weather in New York:\nTemperature: 72\u00B0F\nConditions: Partly cloudy' }
        ],
        isError: false
      }
    });
  });

  test('Tool Invocation Without Arguments', async () => {
    console.log('=== Tool Invocation Without Arguments ===');
    const nextId = (client as any)._requestMessageId;
    await client.callTool({ name: 'ping' });
    const callReq = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(callReq).toEqual({ jsonrpc: '2.0', id: nextId, method: 'tools/call', params: { name: 'ping' } });
    const callMsg = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(callMsg).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: {
        content: [ { type: 'text', text: 'pong' } ]
      }
    });
  });

  test('Tool Call with Progress', async () => {
    console.log('=== Tool Call with Progress ===');
    const nextId = (client as any)._requestMessageId;
    await client.callTool({ name: 'slow_echo', arguments: { message: 'hello', delay: 500 } }, undefined, {
      onprogress: () => { /* progress events logged */ }
    });
    const callReq = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(callReq).toEqual({ jsonrpc: '2.0', id: nextId, method: 'tools/call', params: { name: 'slow_echo', arguments: { message: 'hello', delay: 500 }, _meta: { progressToken: nextId } } });
    const progressNotifications = received.filter(m => isJSONRPCNotification(m) && m.method === 'notifications/progress');
    expect(progressNotifications.length).toBeGreaterThan(0);
    const callMsg = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(callMsg).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: {
        content: [ { type: 'text', text: 'hello' } ]
      }
    });
  });

  test('Tool Call Cancellation', async () => {
    console.log('=== Tool Call Cancellation ===');
    const progressId = (client as any)._requestMessageId;
    const ac = new AbortController();
    const promise = client.callTool({ name: 'slow_echo', arguments: { message: 'cancel', delay: 1000 } }, undefined, {
      signal: ac.signal,
      onprogress: () => { /* progress events ignored in this log */ }
    });
    setTimeout(() => ac.abort('User requested cancellation'), 1000);
    let progressError: unknown = null;
    try {
      await promise;
    } catch (e) {
      progressError = e;
    }
    await new Promise(r => setTimeout(r, 50));
    const req = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === progressId);
    expect(req).toEqual({ jsonrpc: '2.0', id: progressId, method: 'tools/call', params: { name: 'slow_echo', arguments: { message: 'cancel', delay: 1000 }, _meta: { progressToken: progressId } } });
    const cancelMsg = serverReceived.find(m => isJSONRPCNotification(m) && m.method === 'notifications/cancelled');
    expect(cancelMsg).toEqual({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: progressId, reason: 'User requested cancellation' } });
    expect(progressError).toBeTruthy();
    await new Promise(r => setTimeout(r, 100));
    expect(received.some(m => (isJSONRPCResponse(m) || isJSONRPCError(m)) && (m as any).id === progressId)).toBe(false);
    const progressNotification = received.find(m => isJSONRPCNotification(m) && m.method === 'notifications/progress');
    expect(progressNotification).toEqual({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: progressId, progress: 1, total: 5, message: 'Step 1' } });
  });
});
