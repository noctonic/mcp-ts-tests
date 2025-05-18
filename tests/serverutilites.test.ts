import { startServer } from '../server';
import { createClient } from '../client';
import {
  LoggingMessageNotificationSchema,
  isJSONRPCRequest,
  isJSONRPCResponse,
  isJSONRPCNotification,
  JSONRPCMessage,
  CompleteRequestSchema,
  SetLevelRequestSchema,
  ListResourcesRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { jest } from '@jest/globals';
import util from 'node:util';

util.inspect.defaultOptions.depth = null;

jest.setTimeout(20000);

describe('Server utilities interactions', () => {
  let server: any;
  let mcpServer: any;
  let serverReceived: JSONRPCMessage[];
  let client: any;
  let transport: any;
  const received: JSONRPCMessage[] = [];

  beforeAll(async () => {
    ({ server, mcpServer, serverReceived } = startServer(8086));
    ({ client, transport } = await createClient('http://localhost:8086/sse'));
    const origOnmessage = transport.onmessage;
    transport.onmessage = (m: JSONRPCMessage, extra?: any) => {
      received.push(m);
      origOnmessage?.(m, extra);
    };
    client.setNotificationHandler(LoggingMessageNotificationSchema, () => {});
  });

  afterAll(async () => {
    await transport.close();
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    received.splice(0, received.length);
    serverReceived.splice(0, serverReceived.length);
  });

  test('Completion Request', async () => {
    console.log('=== Completion Request ===');
    const nextId = (client as any)._requestMessageId;
    await client.complete({
      ref: { type: 'ref/prompt', name: 'code_review' },
      argument: { name: 'language', value: 'py' }
    });
    const compReq = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(compReq).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      method: 'completion/complete',
      params: { ref: { type: 'ref/prompt', name: 'code_review' }, argument: { name: 'language', value: 'py' } }
    });
    const compMsg = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(compMsg).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: { completion: { values: ['python','pytorch','pyside'], total: 3, hasMore: false } }
    });
  });

  test('Logging Level and Messages', async () => {
    console.log('=== Logging Level and Messages ===');
    const nextId = (client as any)._requestMessageId;
    await client.setLoggingLevel('info');
    const setReq = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(setReq).toEqual({ jsonrpc: '2.0', id: nextId, method: 'logging/setLevel', params: { level: 'info' } });
    const setResp = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId);
    expect(setResp).toEqual({ jsonrpc: '2.0', id: nextId, result: {} });

    await mcpServer.server.sendLoggingMessage({ level: 'info', logger: 'test', data: { msg: 'a' } });
    await mcpServer.server.sendLoggingMessage({ level: 'error', logger: 'test', data: { msg: 'b' } });
    await new Promise(r => setTimeout(r, 50));
    const infoMsg = received.find(m => isJSONRPCNotification(m) && (m as any).params.level === 'info');
    const errorMsg = received.find(m => isJSONRPCNotification(m) && (m as any).params.level === 'error');
    expect(infoMsg).toEqual({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', logger: 'test', data: { msg: 'a' } } });
    expect(errorMsg).toEqual({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'error', logger: 'test', data: { msg: 'b' } } });

    const nextId2 = (client as any)._requestMessageId;
    await client.setLoggingLevel('error');
    const setReq2 = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId2);
    expect(setReq2).toEqual({ jsonrpc: '2.0', id: nextId2, method: 'logging/setLevel', params: { level: 'error' } });
    const setResp2 = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId2);
    expect(setResp2).toEqual({ jsonrpc: '2.0', id: nextId2, result: {} });

    received.splice(0, received.length);
    await mcpServer.server.sendLoggingMessage({ level: 'info', logger: 'test', data: { msg: 'c' } });
    await mcpServer.server.sendLoggingMessage({ level: 'error', logger: 'test', data: { msg: 'd' } });
    await new Promise(r => setTimeout(r, 50));
    const postInfo = received.find(m => isJSONRPCNotification(m) && (m as any).params.data.msg === 'c');
    const postError = received.find(m => isJSONRPCNotification(m) && (m as any).params.data.msg === 'd');
    expect(postInfo).toBeUndefined();
    expect(postError).toEqual({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'error', logger: 'test', data: { msg: 'd' } } });
  });

  test('Paginated Resource Listing', async () => {
    console.log('=== Paginated Resource Listing ===');
    mcpServer.server.removeRequestHandler('resources/list');
    mcpServer.server.setRequestHandler(ListResourcesRequestSchema, async (req: any) => {
      if (req.params && 'cursor' in req.params && req.params.cursor === 'next') {
        return { resources: [{ uri: 'file:///two', name: 'two' }] };
      }
      return { resources: [{ uri: 'file:///one', name: 'one' }], nextCursor: 'next' };
    });
    const nextId = (client as any)._requestMessageId;
    await client.listResources();
    const firstReq = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(firstReq).toEqual({ jsonrpc: '2.0', id: nextId, method: 'resources/list' });
    const firstResp = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(firstResp).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: { resources: [{ uri: 'file:///one', name: 'one' }], nextCursor: 'next' }
    });

    const nextId2 = (client as any)._requestMessageId;
    await client.listResources({ cursor: 'next' });
    const secondReq = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId2);
    expect(secondReq).toEqual({ jsonrpc: '2.0', id: nextId2, method: 'resources/list', params: { cursor: 'next' } });
    const secondResp = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId2) as any;
    expect(secondResp).toEqual({ jsonrpc: '2.0', id: nextId2, result: { resources: [{ uri: 'file:///two', name: 'two' }] } });
  });
});
