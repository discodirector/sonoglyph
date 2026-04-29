// End-to-end smoke test for the Day 5 bridge.
//
// 1. Open WS → get session code from session_created
// 2. Open MCP client to /mcp?code=… and list tools (verifies agent_paired)
// 3. Send `hello` over WS to start the game
// 4. Player place_layer over WS
// 5. wait_for_my_turn over MCP → place_layer over MCP
// 6. Verify the agent's layer arrives back on the WS
//
// Run after `npm start` in another terminal.
//   node proxy/smoke-test.mjs

import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const log = (...args) =>
  console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...args);

const BRIDGE_HTTP = process.env.BRIDGE_HTTP ?? 'http://127.0.0.1:8787';
const BRIDGE_WS = process.env.BRIDGE_WS ?? 'ws://127.0.0.1:8787/ws';

async function main() {
  // ---- 1. Open WS, wait for session_created ----
  const ws = new WebSocket(BRIDGE_WS);
  const wsLog = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    wsLog.push(msg);
    log('WS ←', msg.type, summarize(msg));
  });
  ws.on('error', (e) => log('WS err', e.message));

  await new Promise((r) => ws.once('open', r));
  log('WS connected');

  const sessionMsg = await waitForWS(wsLog, 'session_created', 2000);
  const code = sessionMsg.code;
  log(`session code: ${code}`);

  // ---- 2. MCP connect with code ----
  const mcpUrl = new URL(`${BRIDGE_HTTP}/mcp?code=${code}`);
  const client = new Client({ name: 'sonoglyph-smoke', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(mcpUrl);
  await client.connect(transport);
  log('MCP connected');

  const tools = await client.listTools();
  log('MCP tools:', tools.tools.map((t) => t.name).join(', '));

  await waitForWS(wsLog, 'agent_paired', 1000);

  // ---- 3. start ----
  ws.send(JSON.stringify({ type: 'hello' }));
  await waitForWS(wsLog, 'state', 500, (m) => m.state.phase === 'playing');
  log('game started');

  // ---- 4. player places ----
  ws.send(
    JSON.stringify({
      type: 'place_layer',
      layerType: 'drone',
      position: [0, -16, -10],
      freq: 65.41,
    }),
  );
  await waitForWS(wsLog, 'layer_added', 500, (m) => m.layer.placedBy === 'player');
  log('player layer broadcast received');

  // ---- 5. wait_for_my_turn → place_layer ----
  log('calling wait_for_my_turn (this should block ~10s for cooldown)…');
  const waitRes = await client.callTool({
    name: 'wait_for_my_turn',
    arguments: { timeout_sec: 30 },
  });
  const waitPayload = JSON.parse(waitRes.content[0].text);
  log('wait result:', { it_is_my_turn: waitPayload.it_is_my_turn });

  if (!waitPayload.it_is_my_turn) {
    throw new Error('expected agent turn after cooldown');
  }

  const placeRes = await client.callTool({
    name: 'place_layer',
    arguments: {
      type: 'pulse',
      comment: 'Smoke test — a pulse to keep time.',
    },
  });
  log('place_layer result:', placeRes.content[0].text.slice(0, 80));

  // ---- 6. verify on WS ----
  const agentLayer = await waitForWS(
    wsLog,
    'layer_added',
    2000,
    (m) => m.layer.placedBy === 'agent',
  );
  log(
    `agent layer roundtripped: type=${agentLayer.layer.type} ` +
      `comment="${agentLayer.layer.comment}"`,
  );

  // ---- cleanup ----
  await client.close();
  ws.close();
  log('SMOKE OK');
  process.exit(0);
}

function summarize(m) {
  switch (m.type) {
    case 'session_created':
      return `code=${m.code}`;
    case 'state':
      return `phase=${m.state.phase} turn=${m.state.turnCount}/${m.state.maxLayers} who=${m.state.currentTurn} agent=${m.state.agentConnected}`;
    case 'layer_added':
      return `${m.layer.placedBy} ${m.layer.type}${m.layer.comment ? ` "${m.layer.comment}"` : ''}`;
    case 'turn_changed':
      return `→${m.currentTurn} cd=${m.cooldownEndsAt ? Math.round((m.cooldownEndsAt - Date.now()) / 1000) + 's' : 'none'}`;
    case 'finished':
      return m.reason;
    case 'error':
      return m.message;
    default:
      return '';
  }
}

async function waitForWS(buffer, type, timeoutMs, predicate = () => true) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = buffer.find((m) => m.type === type && predicate(m));
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for WS message ${type}`);
}

main().catch((e) => {
  log('SMOKE FAILED', e.message);
  process.exit(1);
});
