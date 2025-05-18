import { startServer } from '../server';
import { createClient } from '../client';
import {
  ResourceListChangedNotificationSchema,
  isJSONRPCResponse,
  isJSONRPCError,
  isJSONRPCRequest,
  isJSONRPCNotification,
  JSONRPCMessage
} from '@modelcontextprotocol/sdk/types.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jest } from '@jest/globals';
import util from 'node:util';

util.inspect.defaultOptions.depth = null;

jest.setTimeout(20000);

describe('MCP resource template interactions', () => {
  let server: any;
  let mcpServer: any;
  let serverReceived: JSONRPCMessage[];
  let client: any;
  let transport: any;
  const received: JSONRPCMessage[] = [];

  beforeAll(async () => {
    ({ server, mcpServer, serverReceived } = startServer(8081));
    ({ client, transport } = await createClient('http://localhost:8081/sse'));
    const origOnmessage = transport.onmessage;
    transport.onmessage = (m: JSONRPCMessage, extra?: any) => {
      received.push(m);
      origOnmessage?.(m, extra);
    };
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {});
  });

  afterAll(async () => {
    await transport.close();
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    received.splice(0, received.length);
    serverReceived.splice(0, serverReceived.length);
  });

  test('Templates Listing', async () => {
    console.log('=== Templates Listing ===');
    const nextId = (client as any)._requestMessageId;
    await client.listResourceTemplates();
    const listReq = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(listReq).toEqual({ jsonrpc: '2.0', id: nextId, method: 'resources/templates/list' });
    const listMsg = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(listMsg).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: {
        resourceTemplates: [
          { uriTemplate: 'http://example.com/{+path}', name: 'file-template', mimeType: 'application/octet-stream' }
        ]
      }
    });
  });

  test('Template List Changed Notifications', async () => {
    console.log('=== Template List Changed Notifications ===');
    mcpServer.resource('temp-template', new ResourceTemplate('http://example.com/temp/{name}', { list: async () => ({ resources: [] }) }), { mimeType: 'text/plain' }, async () => ({
      contents: []
    }));
    await new Promise(r => setTimeout(r, 50));
    const listChanged = received.find(m => isJSONRPCNotification(m) && m.method === 'notifications/resources/list_changed');
    expect(listChanged).toEqual({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' });
  });

  test('Template Reading', async () => {
    console.log('=== Template Reading ===');
    const nextId = (client as any)._requestMessageId;
    await client.readResource({ uri: 'http://example.com/project/src/main.rs' });
    const readReq = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(readReq).toEqual({ jsonrpc: '2.0', id: nextId, method: 'resources/read', params: { uri: 'http://example.com/project/src/main.rs' } });
    const readMsg = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(readMsg).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: {
        contents: [
          { uri: 'http://example.com/project/src/main.rs', mimeType: 'text/x-rust', text: 'fn main() {\n    println!("Hello world!\");\n}' }
        ]
      }
    });
  });

  test('Template Read with Progress', async () => {
    console.log('=== Template Read with Progress ===');
    const nextId = (client as any)._requestMessageId;
    await client.readResource({ uri: 'http://example.com/slow/data.txt' }, {
      onprogress: () => { /* progress events logged */ }
    });
    const progressReq = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(progressReq).toEqual({ jsonrpc: '2.0', id: nextId, method: 'resources/read', params: { uri: 'http://example.com/slow/data.txt', _meta: { progressToken: nextId } } });
    const progressNotifications = received.filter(m => isJSONRPCNotification(m) && m.method === 'notifications/progress');
    expect(progressNotifications.length).toBeGreaterThan(0);
    const readMsg = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(readMsg).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: {
        contents: [
          { uri: 'http://example.com/slow/data.txt', mimeType: 'text/plain', text: 'slow resource' }
        ]
      }
    });
  });

  test('Template Read Cancellation', async () => {
    console.log('=== Template Read Cancellation ===');
    const cancelId = (client as any)._requestMessageId;
    const ac = new AbortController();
    const promise = client.readResource({ uri: 'http://example.com/slow/data.txt' }, { signal: ac.signal });
    setTimeout(() => ac.abort('User aborted'), 100);
    let readError: unknown = null;
    try {
      await promise;
    } catch (e) {
      readError = e;
    }
    await new Promise(r => setTimeout(r, 50));
    const req = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === cancelId);
    expect(req).toEqual({ jsonrpc: '2.0', id: cancelId, method: 'resources/read', params: { uri: 'http://example.com/slow/data.txt' } });
    const cancelMsg = serverReceived.find(m => isJSONRPCNotification(m) && m.method === 'notifications/cancelled');
    expect(cancelMsg).toEqual({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: cancelId, reason: 'User aborted' } });
    expect(readError).toBeTruthy();
    await new Promise(r => setTimeout(r, 100));
    expect(received.some(m => (isJSONRPCResponse(m) || isJSONRPCError(m)) && (m as any).id === cancelId)).toBe(false);
  });
});
