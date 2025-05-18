import { startServer } from '../server';
import { createClient } from '../client';
import {
  RootsListChangedNotificationSchema,
  ListRootsRequestSchema,
  isJSONRPCResponse,
  isJSONRPCRequest,
  isJSONRPCNotification,
  JSONRPCMessage
} from '@modelcontextprotocol/sdk/types.js';
import { jest } from '@jest/globals';
import util from 'node:util';

util.inspect.defaultOptions.depth = null;

jest.setTimeout(20000);

describe('MCP root interactions', () => {
  let server: any;
  let mcpServer: any;
  let serverReceived: JSONRPCMessage[];
  let client: any;
  let transport: any;
  const received: JSONRPCMessage[] = [];

  beforeAll(async () => {
    ({ server, mcpServer, serverReceived } = startServer(8084));
    ({ client, transport } = await createClient('http://localhost:8084/sse'));
    const origOnmessage = transport.onmessage;
    transport.onmessage = (m: JSONRPCMessage, extra?: any) => {
      received.push(m);
      origOnmessage?.(m, extra);
    };
  });

  afterAll(async () => {
    await transport.close();
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    received.splice(0, received.length);
    serverReceived.splice(0, serverReceived.length);
  });

  test('Root Listing', async () => {
    console.log('=== Root Listing ===');
    const nextId = (mcpServer.server as any)._requestMessageId;
    await mcpServer.server.listRoots();
    const listReq = received.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(listReq).toEqual({ jsonrpc: '2.0', id: nextId, method: 'roots/list' });
    const listMsg = serverReceived.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(listMsg).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: {
        roots: [
          { uri: 'file:///home/user/projects/myproject', name: 'My Project' }
        ]
      }
    });
  });

  test('Root List Changed Notifications', async () => {
    console.log('=== Root List Changed Notifications ===');
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: 'file:///home/user/projects/newroot', name: 'New Root' }]
    }));
    await client.sendRootsListChanged();
    const listChanged = serverReceived.find(m => isJSONRPCNotification(m) && m.method === 'notifications/roots/list_changed');
    expect(listChanged).toEqual({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' });
    const nextId = (mcpServer.server as any)._requestMessageId;
    await mcpServer.server.listRoots();
    const req = received.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(req).toEqual({ jsonrpc: '2.0', id: nextId, method: 'roots/list' });
    const resp = serverReceived.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(resp).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: {
        roots: [
          { uri: 'file:///home/user/projects/newroot', name: 'New Root' }
        ]
      }
    });
  });
});
