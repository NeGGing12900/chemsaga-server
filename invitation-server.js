// server/invitation-server.js
const http = require('http');
const WebSocket = require('ws');
const url = require('url');

const PORT = 8080;

const server = http.createServer();
const wss = new WebSocket.Server({ server });

/** Map of user_id(string) -> ws */
const clients = new Map();

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (_) {}
}
function pushTo(uid, msg) {
  const ws = clients.get(String(uid));
  if (ws && ws.readyState === WebSocket.OPEN) {
    send(ws, msg);
    return true;
  }
  return false;
}

wss.on('connection', (ws, req) => {
  const { query } = url.parse(req.url, true);
  const uid = String(query.uid || '').trim();

  if (!uid) {
    send(ws, { type: 'error', error: 'missing_uid' });
    ws.close();
    return;
  }

  // Replace old socket if the same uid reconnects
  const existing = clients.get(uid);
  if (existing && existing !== ws) {
    try { existing.close(); } catch (_) {}
  }
  clients.set(uid, ws);

  send(ws, { type: 'hello', uid });

  // Optional: keepalive to keep NAT/firewall open
  ws._pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.ping(); } catch (_) {}
    }
  }, 25000);

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch (_) { return; }

    // ---- INVITATION RELAY (do not change your payload shape) ----
    if (msg?.type === 'invite.push') {
      const delivered = pushTo(String(msg.to_user_id), {
        type: 'invite',
        invite_id: msg.invite_id,
        room_id: msg.room_id,
        from_user_id: msg.from_user_id,
        from_username: msg.from_username || 'Player',
        from_avatar: msg.from_avatar || 'assets/img/c4.png',
        ts: Date.now(),
      });
      send(ws, { type: 'invite.ack', delivered });
      return;
    }

    // You can add other message types later (e.g. game state) here
  });

  ws.on('close', () => {
    clearInterval(ws._pingInterval);
    const cur = clients.get(uid);
    if (cur === ws) clients.delete(uid);
  });

  ws.on('error', () => {
    clearInterval(ws._pingInterval);
  });
});

server.listen(PORT, () => {
  console.log(`✅ Invitation WS running ws://localhost:${PORT}`);
});
