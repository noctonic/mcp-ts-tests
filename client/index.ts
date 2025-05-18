import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ListRootsRequestSchema, CreateMessageRequestSchema, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';

class LoggingTransport implements Transport {
  constructor(private inner: Transport) {}
  onmessage?: (message: JSONRPCMessage, extra?: { authInfo?: unknown }) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  get sessionId() { return this.inner.sessionId; }
  async start() {
    this.inner.onmessage = (m, extra) => {
      console.log('Client Received:', m);
      this.onmessage?.(m, extra);
    };
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (e) => this.onerror?.(e);
    await this.inner.start();
  }
  async send(message: JSONRPCMessage, options?: TransportSendOptions) {
    await this.inner.send(message, options);
  }
  async close() {
    await this.inner.close();
    this.onclose?.();
  }
}

export async function createClient(url: string) {
  const client = new Client({ name: 'test-sse-client', version: '1.0.0' });

  client.registerCapabilities({
    roots: { listChanged: true },
    sampling: {}
  });

  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: 'file:///home/user/projects/myproject', name: 'My Project' }]
  }));

  client.setRequestHandler(CreateMessageRequestSchema, async () => ({
    role: 'assistant',
    content: { type: 'text', text: 'The capital of France is Paris.' },
    model: 'claude-3-sonnet-20240307',
    stopReason: 'endTurn'
  }));

  const inner = new SSEClientTransport(new URL(url));
  const transport = new LoggingTransport(inner);
  await client.connect(transport);
  return { client, transport };
}
