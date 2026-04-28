// Quick smoke test: connect to ws://localhost:8787/ws, send hello + one
// place_layer, observe a full turn cycle (player → cooldown → stub agent
// → cooldown back to player). Run after starting the bridge.
//
//   node proxy/smoke-test.mjs

import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8787/ws');

const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...args);

ws.on('open', () => {
  log('connected');
  ws.send(JSON.stringify({ type: 'hello' }));
  // After a short delay, place a player layer.
  setTimeout(() => {
    log('→ place_layer (player)');
    ws.send(
      JSON.stringify({
        type: 'place_layer',
        layerType: 'drone',
        position: [0, -16, -10],
        freq: 65.41,
      }),
    );
  }, 300);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  log('← ', msg.type, summarize(msg));
});

ws.on('close', () => log('closed'));
ws.on('error', (e) => log('error', e.message));

// Stop after enough time to see the full cycle.
setTimeout(() => {
  log('test ending');
  ws.close();
  process.exit(0);
}, 18000);

function summarize(m) {
  switch (m.type) {
    case 'state':
      return `phase=${m.state.phase} turn=${m.state.turnCount}/${m.state.maxLayers} who=${m.state.currentTurn}`;
    case 'layer_added':
      return `${m.layer.placedBy} ${m.layer.type} @[${m.layer.position.map((n) => n.toFixed(1)).join(',')}]${m.layer.comment ? ` "${m.layer.comment}"` : ''}`;
    case 'turn_changed':
      return `→${m.currentTurn} cd=${m.cooldownEndsAt ? Math.round((m.cooldownEndsAt - Date.now()) / 1000) + 's' : 'none'} (turn ${m.turnCount})`;
    case 'agent_thinking':
      return '(agent computing)';
    case 'finished':
      return m.reason;
    case 'error':
      return m.message;
    default:
      return '';
  }
}
