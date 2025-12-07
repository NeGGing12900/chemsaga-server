// server/game-server.js
const http = require('http');
const WebSocket = require('ws');
const url = require('url');

const PHP_HOST = '127.0.0.1';     // use 127.0.0.1 on Windows
const PHP_PORT = 80;              // change if Apache uses a different port
const PHP_PATH_BOOTSTRAP = '/Newchemsaga/php/api/game_bootstrap.php';

const server = http.createServer();
const wss = new WebSocket.Server({ server });

/*
Room shape:
rooms.get(roomId) = {
  players: Map<uid, { uid, pos, score, ws }>,
  turnUid: string|null,

  // bootstrap
  configLoaded: boolean,
  config: { game_time_sec, time_per_question_sec },
  questionsLoaded: boolean,
  questions: Map<tileIndex, { q, choices, correctIndex, qid }>,

  // flow control
  awaitingAnswer: null | { uid, from, tile, qid, timeoutId },
  turnBusy: boolean,
  rollInFlightByUid: Set<string>,

  // extra
  answeredCorrectTiles: Set<number>,  // tiles na tama na ang sagot
  gameOver: boolean
};
*/
const rooms = new Map();

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
function broadcast(roomId, obj) {
  const R = rooms.get(roomId); if (!R) return;
  const msg = JSON.stringify(obj);
  for (const p of R.players.values()) {
    if (p.ws?.readyState === WebSocket.OPEN) p.ws.send(msg);
  }
}

function httpGet(path, cb) {
  const opts = {
    hostname: PHP_HOST,
    port: PHP_PORT,
    path,
    method: 'GET',
    timeout: 5000
  };
  const req = http.request(opts, res => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => cb(null, body, res.statusCode));
  });
  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  req.on('error', err => cb(err));
  req.end();
}

function ensureRoomBootstrap(roomId, cb) {
  const R = rooms.get(roomId); if (!R) { cb && cb(); return; }
  if (R.configLoaded && R.questionsLoaded) { cb && cb(); return; }

  const qs = `room_id=${encodeURIComponent(roomId)}`;
  httpGet(`${PHP_PATH_BOOTSTRAP}?${qs}`, (err, body, statusCode = 0) => {
    if (err || statusCode < 200 || statusCode >= 300) {
      console.error('[bootstrap] HTTP error:', err ? err.message : `status ${statusCode}`);
      R.configLoaded = true;
      R.questionsLoaded = true;
      R.questions = new Map();
      cb && cb();
      return;
    }
    try {
      const j = JSON.parse(body || '{}');

      // config
      if (j.ok && j.room) {
        const game_time_min = parseInt(j.room.game_time_min ?? 20, 10) || 20;
        const tpq = parseInt(j.room.time_per_question_sec ?? 10, 10) || 10;
        R.config = { game_time_sec: game_time_min * 60, time_per_question_sec: tpq };
      }
      R.configLoaded = true;

      // questions
      R.questions = new Map();
      if (Array.isArray(j.questions)) {
        j.questions.forEach((row, idx) => {
          const rawTile = row.tile_number ?? (idx + 1);
          const tileNum   = parseInt(rawTile, 10);
          const tileIndex = Number.isFinite(tileNum)
            ? Math.max(0, Math.min(99, tileNum - 1))
            : Math.max(0, Math.min(99, idx));

          const choices   = [
            String(row.choice_a ?? '').trim(),
            String(row.choice_b ?? '').trim(),
            String(row.choice_c ?? '').trim(),
            String(row.choice_d ?? '').trim()
          ];
          const q         = String(row.question_text ?? '').trim();
          const rawCI     = row.correct_index ?? row.correctIndex ?? 0;
          let ci          = parseInt(rawCI, 10);
          if (!Number.isFinite(ci)) ci = 0;
          ci = Math.max(0, Math.min(3, ci));

          if (q) {
            R.questions.set(
              tileIndex,
              { q, choices, correctIndex: ci, qid: `${roomId}:${tileIndex}` }
            );
          }
        });
      }
      R.questionsLoaded = true;
    } catch (e) {
      console.error('[bootstrap] JSON parse error:', e.message);
      R.configLoaded = true;
      R.questionsLoaded = true;
      R.questions = new Map();
    }
    cb && cb();
  });
}

function rotateTurn(R, justPlayedUid) {
  const arr = Array.from(R.players.values());
  if (arr.length === 0) { R.turnUid = null; return; }
  const idx = Math.max(0, arr.findIndex(p => p.uid === justPlayedUid));
  const next = arr[(idx + 1) % arr.length];
  R.turnUid = next?.uid || null;
}

wss.on('connection', (ws, req) => {
  const { query } = url.parse(req.url, true);
  const uid    = String(query.uid || '').trim();
  const roomId = parseInt(query.room_id, 10);

  if (!uid || !roomId) {
    send(ws, { type: 'error', error: 'missing_uid_or_room' });
    ws.close();
    return;
  }

  let R = rooms.get(roomId);
  if (!R) {
    R = {
      players: new Map(),
      turnUid: null,
      configLoaded: false,
      config: { game_time_sec: 1200, time_per_question_sec: 10 },
      questionsLoaded: false,
      questions: new Map(),
      awaitingAnswer: null,
      turnBusy: false,
      rollInFlightByUid: new Set(),
      answeredCorrectTiles: new Set(),
      gameOver: false
    };
    rooms.set(roomId, R);
  }

  let player = R.players.get(uid);
  if (!player) {
    player = { uid, pos: 0, score: 0, ws };
    R.players.set(uid, player);
  } else {
    player.ws = ws;
  }

  if (!R.turnUid) R.turnUid = uid;

  ensureRoomBootstrap(roomId, () => {
    const playersState = Array.from(R.players.values()).map(p => ({
      uid: p.uid,
      pos: p.pos || 0,
      score: p.score || 0
    }));
    send(ws, {
      type: 'state.sync',
      room_id: roomId,
      players: playersState,
      turnUid: R.turnUid,
      config: R.config,
      answeredTiles: Array.from(R.answeredCorrectTiles)
    });
  });

  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || parseInt(msg.room_id, 10) !== roomId) return;

    if (R.gameOver &&
      (msg.type === 'roll.request' ||
       msg.type === 'turn.skip'   ||
       msg.type === 'answer.submit')) {
      send(ws, { type: 'error', error: 'game_over' });
      return;
    }

    // Reject rolls while a question is being answered
    if (R.awaitingAnswer && msg.type === 'roll.request') {
      send(ws, { type: 'error', error: 'question_pending' });
      return;
    }

    // ---- Roll pipeline ----
    const handleRoll = () => {
      if (uid !== R.turnUid) { send(ws, { type: 'error', error: 'not_your_turn' }); return; }
      if (R.turnBusy) { send(ws, { type: 'error', error: 'turn_busy' }); return; }
      if (R.rollInFlightByUid.has(uid)) { send(ws, { type: 'error', error: 'roll_in_flight' }); return; }
      if (R.gameOver) { send(ws, { type: 'error', error: 'game_over' }); return; }

      const roller = R.players.get(uid); if (!roller) return;

      R.turnBusy = true;
      R.rollInFlightByUid.add(uid);

      const roll = 1 + Math.floor(Math.random() * 6);
      const from = roller.pos || 0;

      // BASIC MOVE: from + roll, clamp 99
      let to = from + roll;
      if (to > 99) to = 99;

      // SKIP landing on tiles na answeredCorrect
      const answered = R.answeredCorrectTiles || new Set();
      while (to < 99 && answered.has(to)) {
        to++;
      }

      // 1) Dice result to everyone
      broadcast(roomId, {
        type: 'roll.result',
        room_id: roomId,
        uid,
        roll
      });

      // Helper to show question on target tile
      const showQuestionForTile = () => {
        const Q = R.questions.get(to);
        if (!Q) {
          // no question → next turn
          R.turnBusy = false;
          R.rollInFlightByUid.delete(uid);
          rotateTurn(R, uid);
          broadcast(roomId, { type: 'turn.update', room_id: roomId, turnUid: R.turnUid });
          return;
        }

        // clear old awaiting
        if (R.awaitingAnswer?.timeoutId) clearTimeout(R.awaitingAnswer.timeoutId);

        const timeSec = R.config.time_per_question_sec || 10;

        // active question to roller
        if (roller.ws?.readyState === WebSocket.OPEN) {
          send(roller.ws, {
            type: 'question.show',
            room_id: roomId,
            uid: uid,
            tile_index: to,
            qid: Q.qid,
            q: Q.q,
            choices: Q.choices,
            time_sec: timeSec
          });
        }

        // passive question to others
        for (const p of R.players.values()) {
          if (p.uid === uid) continue;
          if (p.ws?.readyState === WebSocket.OPEN) {
            send(p.ws, {
              type: 'question.show',
              room_id: roomId,
              uid: uid,
              tile_index: to,
              qid: Q.qid,
              q: Q.q,
              choices: Q.choices,
              passive: true,
              time_sec: timeSec
            });
          }
        }

        // timeout → incorrect, revert to "from"
        const timeoutId = setTimeout(() => {
          const awaiting = R.awaitingAnswer;
          if (!awaiting || awaiting.uid !== uid || awaiting.qid !== Q.qid) return;

          R.awaitingAnswer = null;
          R.turnBusy = false;
          R.rollInFlightByUid.delete(uid);

          const rollerNow = R.players.get(uid);
          if (rollerNow) {
            const fromPrev = awaiting.from;
            const curPos   = typeof rollerNow.pos === 'number' ? rollerNow.pos : awaiting.tile;
            rollerNow.pos  = fromPrev;

            broadcast(roomId, {
              type: 'move.commit',
              room_id: roomId,
              uid,
              from: curPos,
              to: fromPrev
            });
          }

          rotateTurn(R, uid);
          const scoresObj = {};
          for (const pl of R.players.values()) scoresObj[pl.uid] = pl.score || 0;

          broadcast(roomId, {
            type: 'answer.result',
            room_id: roomId,
            uid,
            correct: false,
            tile_index: awaiting.tile,
            scores: scoresObj,
            turnUid: R.turnUid
          });
          broadcast(roomId, { type: 'turn.update', room_id: roomId, turnUid: R.turnUid });
        }, timeSec * 1000);

        R.awaitingAnswer = { uid, from, tile: to, qid: Q.qid, timeoutId };
      };

      // 2) after dice animation, commit move
      setTimeout(() => {
        roller.pos = to;
        broadcast(roomId, {
          type: 'move.commit',
          room_id: roomId,
          uid,
          from,
          to
        });

        // 3) delay before showing question
        setTimeout(() => {
          showQuestionForTile();
        }, 700);
      }, 950);
    };

    // ---- ROUTER ----
    if (msg.type === 'roll.request') {
      if (!R.configLoaded || !R.questionsLoaded) {
        ensureRoomBootstrap(roomId, () => handleRoll());
      } else {
        handleRoll();
      }
      return;
    }

    if (msg.type === 'turn.skip') {
      if (uid !== R.turnUid) { send(ws, { type: 'error', error: 'not_your_turn' }); return; }
      if (R.turnBusy || R.awaitingAnswer) { send(ws, { type: 'error', error: 'turn_busy' }); return; }

      R.rollInFlightByUid.delete(uid);
      rotateTurn(R, uid);
      broadcast(roomId, { type: 'turn.update', room_id: roomId, turnUid: R.turnUid });
      return;
    }

    if (msg.type === 'answer.submit') {
      if (!R.awaitingAnswer || R.awaitingAnswer.uid !== uid || R.awaitingAnswer.qid !== msg.qid) return;

      const { timeoutId, tile, from } = R.awaitingAnswer;
      if (timeoutId) clearTimeout(timeoutId);

      const Q = R.questions.get(tile);
      const choice  = parseInt(msg.choice_index, 10);
      const correct = (Q && choice === Q.correctIndex);

      const roller = R.players.get(uid);

      if (roller) {
        if (correct) {
          roller.score = (roller.score || 0) + 1;
          R.answeredCorrectTiles.add(tile);
        } else {
          const currentPos = typeof roller.pos === 'number' ? roller.pos : tile;
          roller.pos = from;
          broadcast(roomId, {
            type: 'move.commit',
            room_id: roomId,
            uid,
            from: currentPos,
            to: from
          });
        }
      }

      R.awaitingAnswer = null;
      R.turnBusy = false;
      R.rollInFlightByUid.delete(uid);

      rotateTurn(R, uid);
      const scoresObj = {};
      for (const p of R.players.values()) scoresObj[p.uid] = p.score || 0;

      broadcast(roomId, {
        type: 'answer.result',
        room_id: roomId,
        uid,
        correct,
        tile_index: tile,
        scores: scoresObj,
        answeredTiles: Array.from(R.answeredCorrectTiles),
        turnUid: R.turnUid
      });
      broadcast(roomId, { type: 'turn.update', room_id: roomId, turnUid: R.turnUid });
      return;
    }

    // client says: ubos na game timer
    if (msg.type === 'game.timeup') {
      if (R.gameOver) return;
      R.gameOver = true;
      broadcast(roomId, { type: 'game.over', room_id: roomId });
      return;
    }
  });

  ws.on('close', () => {
    // keep room for reconnect; optional cleanup if all leave
  });
});

server.listen(8081, () => console.log('✅ Game WS running ws://127.0.0.1:8081'));
