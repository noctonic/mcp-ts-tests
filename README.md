# mcp-protocol-test
The purpose of this project is to systematically test all features of the MCP protocol.

We build a test-client and test-server. 

We connect test-client to test-server via SSE on port 8080 and series of test are performed and the results are collected and displayed.

## Testing
Run `npm test` to execute the Jest suite. Tests rely on Node's ECMAScript module
support, so Node is run with the `--experimental-vm-modules` flag automatically.

