import { startServer } from '../server';
import { createClient } from '../client';
import {
  ResourceUpdatedNotificationSchema,
  ResourceListChangedNotificationSchema,
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

describe('MCP protocol interactions', () => {
  let server: any;
  let mcpServer: any;
  let serverReceived: JSONRPCMessage[];
  let client: any;
  let transport: any;
  const received: JSONRPCMessage[] = [];

  beforeAll(async () => {
    ({ server, mcpServer, serverReceived } = startServer(8080));
    ({ client, transport } = await createClient('http://localhost:8080/sse'));
    const origOnmessage = transport.onmessage;
    transport.onmessage = (m: JSONRPCMessage, extra?: any) => {
      received.push(m);
      origOnmessage?.(m, extra);
    };
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, () => {});
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

  test('Resource Listing', async () => {
    console.log('=== Resource Listing ===');
    const nextId = (client as any)._requestMessageId;
    await client.listResources();
    const listReq = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(listReq).toEqual({ jsonrpc: '2.0', id: nextId, method: 'resources/list' });
    const listMsg = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(listMsg).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: {
        resources: [
          { uri: 'file:///project/src/main.rs', name: 'main-rs', mimeType: 'text/x-rust' },
          { uri: 'file:///slow/data.txt', name: 'slow-resource', mimeType: 'text/plain' }
        ]
      }
    });
  });

  test('Resource List Changed Notifications', async () => {
    console.log('=== Resource List Changed Notifications ===');
    mcpServer.resource('temp-resource', 'file:///temp.txt', { mimeType: 'text/plain' }, async () => ({
      contents: [{ uri: 'file:///temp.txt', mimeType: 'text/plain', text: 'temp' }]
    }));
    await new Promise(r => setTimeout(r, 50));
    const listChanged = received.find(m => isJSONRPCNotification(m) && m.method === 'notifications/resources/list_changed');
    expect(listChanged).toEqual({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' });
  });

  test('Resource Reading', async () => {
    console.log('=== Resource Reading ===');
    const nextId = (client as any)._requestMessageId;
    await client.readResource({ uri: 'file:///project/src/main.rs' });
    const readReq = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(readReq).toEqual({ jsonrpc: '2.0', id: nextId, method: 'resources/read', params: { uri: 'file:///project/src/main.rs' } });
    const readMsg = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(readMsg).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: {
        contents: [
          { uri: 'file:///project/src/main.rs', mimeType: 'text/x-rust', text: 'fn main() {\n    println!("Hello world!");\n}' }
        ]
      }
    });
  });

  test('Resource Subscription', async () => {
    console.log('=== Resource Subscription ===');
    const nextId = (client as any)._requestMessageId;
    await client.subscribeResource({ uri: 'file:///project/src/main.rs' });
    const subReq = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(subReq).toEqual({ jsonrpc: '2.0', id: nextId, method: 'resources/subscribe', params: { uri: 'file:///project/src/main.rs' } });
    const subMsg = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId);
    expect(subMsg).toEqual({ jsonrpc: '2.0', id: nextId, result: {} });
  });

  test('Resource Updated', async () => {
    console.log('=== Resource Updated ===');
    await mcpServer.server.sendResourceUpdated({ uri: 'file:///project/src/main.rs' });
    await new Promise(r => setTimeout(r, 50));
    const updateNotification = received.find(m => isJSONRPCNotification(m) && m.method === 'notifications/resources/updated');
    expect(updateNotification).toEqual({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'file:///project/src/main.rs' } });
    await client.unsubscribeResource({ uri: 'file:///project/src/main.rs' });
  });

  test('Resource Read with Progress', async () => {
    console.log('=== Resource Read with Progress ===');
    const nextId = (client as any)._requestMessageId;
    await client.readResource({ uri: 'file:///slow/data.txt' }, {
      onprogress: () => { /* progress events logged */ }
    });
    const progressReq = serverReceived.find(m => isJSONRPCRequest(m) && (m as any).id === nextId);
    expect(progressReq).toEqual({ jsonrpc: '2.0', id: nextId, method: 'resources/read', params: { uri: 'file:///slow/data.txt', _meta: { progressToken: nextId } } });
    const progressNotifications = received.filter(m => isJSONRPCNotification(m) && m.method === 'notifications/progress');
    expect(progressNotifications.length).toBeGreaterThan(0);
    const readMsg = received.find(m => isJSONRPCResponse(m) && (m as any).id === nextId) as any;
    expect(readMsg).toEqual({
      jsonrpc: '2.0',
      id: nextId,
      result: {
        contents: [
          { uri: 'file:///slow/data.txt', mimeType: 'text/plain', text: 'slow resource' }
        ]
      }
    });
  });

  test('Resource Read Cancellation', async () => {
    console.log('=== Resource Read Cancellation ===');
    const progressId = (client as any)._requestMessageId;
    const ac = new AbortController();
    const promise = client.readResource({ uri: 'file:///slow/data.txt' }, {
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
    expect(req).toEqual({ jsonrpc: '2.0', id: progressId, method: 'resources/read', params: { uri: 'file:///slow/data.txt', _meta: { progressToken: progressId } } });
    const cancelMsg = serverReceived.find(m => isJSONRPCNotification(m) && m.method === 'notifications/cancelled');
    expect(cancelMsg).toEqual({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: progressId, reason: 'User requested cancellation' } });
    expect(progressError).toBeTruthy();
    await new Promise(r => setTimeout(r, 100));
    expect(received.some(m => (isJSONRPCResponse(m) || isJSONRPCError(m)) && (m as any).id === progressId)).toBe(false);
    const progressNotification = received.find(m => isJSONRPCNotification(m) && m.method === 'notifications/progress');
    expect(progressNotification).toEqual({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: progressId, progress: 1, total: 3, message: 'Step 1' } });
  });
});
