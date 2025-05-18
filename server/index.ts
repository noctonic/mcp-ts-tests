import express from 'express';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
  LoggingLevel,
  McpError,
  JSONRPCMessage
} from '@modelcontextprotocol/sdk/types.js';
import { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';

class LoggingServerTransport implements Transport {
  constructor(private inner: SSEServerTransport, private received: JSONRPCMessage[]) {}
  onmessage?: (message: JSONRPCMessage, extra?: { authInfo?: unknown }) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  get sessionId() { return this.inner.sessionId; }
  async start() {
    this.inner.onmessage = (m, extra) => {
      console.log('Server Received:', m);
      this.received.push(m);
      this.onmessage?.(m, extra);
    };
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (e) => this.onerror?.(e);
    await this.inner.start();
  }
  async send(message: JSONRPCMessage, _options?: TransportSendOptions) {
    await this.inner.send(message);
  }
  async close() {
    await this.inner.close();
    this.onclose?.();
  }
  async handlePostMessage(req: any, res: any, parsedBody?: any) {
    await (this.inner as any).handlePostMessage(req, res, parsedBody);
  }
}

export function startServer(port: number = 8080) {
  const app = express();
  app.use(express.json());

  const serverReceived: JSONRPCMessage[] = [];

  const mcpServer = new McpServer({ name: 'test-sse-server', version: '1.0.0' });

  // Register capabilities used in tests
  mcpServer.server.registerCapabilities({ logging: {}, resources: { subscribe: true }, sampling: {} });

  const subscribedResources = new Set<string>();

  mcpServer.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    subscribedResources.add(req.params.uri);
    return {};
  });

  mcpServer.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscribedResources.delete(req.params.uri);
    return {};
  });

  const originalSendResourceUpdated = mcpServer.server.sendResourceUpdated.bind(mcpServer.server);
  mcpServer.server.sendResourceUpdated = async (params) => {
    if (subscribedResources.has(params.uri)) {
      await originalSendResourceUpdated(params);
    }
  };

  // Logging setup
  const levels: LoggingLevel[] = ['debug','info','notice','warning','error','critical','alert','emergency'];
  let currentLogLevel: LoggingLevel = 'info';
  mcpServer.server.setRequestHandler(SetLevelRequestSchema, async (req) => {
    if (levels.includes(req.params.level)) {
      currentLogLevel = req.params.level;
    }
    return {};
  });
  const originalSendLoggingMessage = mcpServer.server.sendLoggingMessage.bind(mcpServer.server);
  mcpServer.server.sendLoggingMessage = async (params) => {
    if (levels.indexOf(params.level) >= levels.indexOf(currentLogLevel)) {
      await originalSendLoggingMessage(params);
    }
  };

  // Sample tool
  mcpServer.tool('get_weather', 'Get weather information', {
    location: z.string().describe('Location')
  }, async ({ location }) => ({
    content: [
      { type: 'text', text: `Current weather in ${location}:\nTemperature: 72\u00B0F\nConditions: Partly cloudy` }
    ],
    isError: false
  }));

  // Tool used for progress/cancellation tests
  mcpServer.tool('slow_echo', 'Echo text with delay', {
    message: z.string(),
    delay: z.number().default(500)
  }, async ({ message, delay }, { sendNotification, _meta, signal }) => {
    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      if (signal.aborted) {
        throw new Error('Cancelled');
      }
      await new Promise(r => setTimeout(r, delay / steps));
      await sendNotification({
        method: 'notifications/progress',
        params: { progressToken: _meta?.progressToken ?? 0, progress: i, total: steps, message: `Step ${i}` }
      });
    }
    return { content: [{ type: 'text', text: message }] };
  });

  // Prompt definition
  mcpServer.prompt('code_review', 'Code review prompt', {
    language: completable(z.string(), (v) => ['python', 'pytorch', 'pyside'].filter(s => s.startsWith(v))),
    code: z.string()
  }, async ({ language, code }) => ({
    description: 'Code review prompt',
    messages: [
      { role: 'user', content: { type: 'text', text: `Please review this ${language} code:\n${code}` } }
    ]
  }));

  // Prompt used for progress/cancellation tests
  mcpServer.prompt('slow_prompt', 'Slow prompt', {
    message: z.string()
  }, async ({ message }, { sendNotification, _meta, signal }) => {
    const steps = 5;
    const delay = 500;
    for (let i = 1; i <= steps; i++) {
      if (signal.aborted) {
        throw new Error('Cancelled');
      }
      await new Promise(r => setTimeout(r, delay / steps));
      await sendNotification({
        method: 'notifications/progress',
        params: { progressToken: _meta?.progressToken ?? 0, progress: i, total: steps, message: `Step ${i}` }
      });
    }
    return {
      description: 'Slow prompt',
      messages: [
        { role: 'user', content: { type: 'text', text: message } }
      ]
    };
  });

  // Resource setup
  mcpServer.resource('main-rs', 'file:///project/src/main.rs', { mimeType: 'text/x-rust' }, async () => ({
    contents: [
      { uri: 'file:///project/src/main.rs', mimeType: 'text/x-rust', text: 'fn main() {\n    println!("Hello world!");\n}' }
    ]
  }));

  // Long running resource used for progress/cancellation tests
  mcpServer.resource('slow-resource', 'file:///slow/data.txt', { mimeType: 'text/plain' }, async (_uri, { sendNotification, _meta, signal }) => {
    const steps = 3;
    for (let i = 1; i <= steps; i++) {
      if (signal.aborted) {
        throw new Error('Cancelled');
      }
      await new Promise(r => setTimeout(r, 1000));
      await sendNotification({
        method: 'notifications/progress',
        params: { progressToken: _meta?.progressToken ?? 0, progress: i, total: steps, message: `Step ${i}` }
      });
    }
    return { contents: [{ uri: 'file:///slow/data.txt', mimeType: 'text/plain', text: 'slow resource' }] };
  });

  // Resource template setup
  const httpTemplate = new ResourceTemplate('http://example.com/{+path}', {
    list: undefined
  });
  mcpServer.resource('file-template', httpTemplate, { mimeType: 'application/octet-stream' }, async (_uri, vars, { sendNotification, _meta, signal }) => {
    if (vars.path === 'project/src/main.rs') {
      return {
        contents: [
          { uri: 'http://example.com/project/src/main.rs', mimeType: 'text/x-rust', text: 'fn main() {\n    println!("Hello world!");\n}' }
        ]
      };
    }
    if (vars.path === 'slow/data.txt') {
      const steps = 3;
      for (let i = 1; i <= steps; i++) {
        if (signal.aborted) {
          throw new Error('Cancelled');
        }
        await new Promise(r => setTimeout(r, 1000));
        await sendNotification({
          method: 'notifications/progress',
          params: { progressToken: _meta?.progressToken ?? 0, progress: i, total: steps, message: `Step ${i}` }
        });
      }
      return { contents: [{ uri: 'http://example.com/slow/data.txt', mimeType: 'text/plain', text: 'slow resource' }] };
    }
    throw new McpError(-32002, 'Resource not found', { uri: _uri.toString() });
  });


  // Override read handler to return -32002 when resource not found
  const origReadHandler = (mcpServer.server as any)._requestHandlers.get('resources/read');
  mcpServer.server.removeRequestHandler('resources/read');
  mcpServer.server.setRequestHandler(
    ReadResourceRequestSchema,
    async (request: any, extra: any) => {
      try {
        return await origReadHandler(request, extra);
      } catch (e) {
        if (e instanceof Error && (e as any).code === -32602) {
          throw new McpError(-32002, 'Resource not found', { uri: request.params.uri });
        }
        throw e;
      }
    }
  );

  const transports: Record<string, LoggingServerTransport> = {};

  app.get('/sse', async (req: any, res: any) => {
    const inner = new SSEServerTransport('/messages', res);
    const transport = new LoggingServerTransport(inner, serverReceived);
    transports[transport.sessionId!] = transport;
    transport.onclose = () => { delete transports[transport.sessionId!]; };
    await mcpServer.connect(transport);
  });

  app.post('/messages', async (req: any, res: any) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports[sessionId];
    if (!transport) {
      res.status(404).send('Session not found');
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  const server = app.listen(port, () => {
    console.log(`SSE server listening on port ${port}`);
  });
  return { server, mcpServer, serverReceived };
}
