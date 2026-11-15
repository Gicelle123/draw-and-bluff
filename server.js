const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WORDS = require('./words');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

const MIN_PLAYERS = 4;   // change to 2 only while testing alone
const MAX_PLAYERS = 10;
const TOTAL_ROUNDS = 5;
const REVEAL_MS = 8000;   // role reveal: 8 seconds
const DRAW_MS = 60000;    // drawing: 60 seconds
const VOTE_MS = 30000;    // voting: 30 seconds
const RESULT_MS = 10000;  // round results: 10 seconds
const FINAL_MS = 15000;   // final scoreboard: 15 seconds

const POINTS_CORRECT_VOTE = 2;     // for voting for the real imposter
const POINTS_IMPOSTER_ESCAPES = 3; // for the imposter if they are NOT caught

const COLORS = ['#e6194b', '#f58231', '#ffe119', '#3cb44b', '#42d4f4',
                '#4363d8', '#911eb4', '#f032e6', '#9a6324', '#808080'];

const rooms = {};

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => pick(letters.split(''))).join('');
  } while (rooms[code]);
  return code;
}

// Only public info goes here. The secret word and imposter are NEVER included
// until the reveal phase (room.reveal is null before that).
function publicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    players: room.players,            // each has id, name, color, score
    round: room.round,
    totalRounds: TOTAL_ROUNDS,
    category: room.category,
    endsIn: Math.max(0, room.phaseEndsAt - Date.now()),
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    voted: Object.keys(room.votes),   // WHO has voted, never WHO they voted for
    reveal: room.reveal
  };
}

function broadcast(room) {
  io.to(room.code).emit('room_update', publicState(room));
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 12);
}

// Move the room to a new phase, and automatically run next() when time runs out.
function setPhase(room, phase, ms, next) {
  clearTimeout(room.timer);
  room.phase = phase;
  room.phaseEndsAt = Date.now() + ms;
  broadcast(room);
  if (ms > 0 && next) room.timer = setTimeout(next, ms);
}

function startRound(room) {
  room.round += 1;
  room.category = pick(Object.keys(WORDS));
  room.word = pick(WORDS[room.category]);
  room.imposterId = pick(room.players).id;
  room.votes = {};
  room.reveal = null;

  // Each player gets their own private message
  room.players.forEach((p) => {
    const isImposter = p.id === room.imposterId;
    io.to(p.id).emit('your_role', {
      category: room.category,
      isImposter,
      word: isImposter ? null : room.word
    });
  });

  setPhase(room, 'role_reveal', REVEAL_MS, () => startDrawing(room));
}

function startDrawing(room) {
  setPhase(room, 'drawing', DRAW_MS, () => startVoting(room));
}

function startVoting(room) {
  room.votes = {};
  setPhase(room, 'voting', VOTE_MS, () => showResults(room));
}

function showResults(room) {
  if (room.phase !== 'voting') return;
  clearTimeout(room.timer);

  const imposter = room.players.find((p) => p.id === room.imposterId);

  // Count votes for each player
  const tally = {};
  Object.values(room.votes).forEach((targetId) => {
    tally[targetId] = (tally[targetId] || 0) + 1;
  });

  const gains = {};   // playerId -> points won this round
  let caught = false;

  if (imposter) {
    // Caught = the imposter got strictly more votes than anybody else
    const imposterVotes = tally[imposter.id] || 0;
    const othersMax = Math.max(
      0, ...Object.entries(tally).filter(([id]) => id !== imposter.id).map(([, n]) => n)
    );
    caught = imposterVotes > 0 && imposterVotes > othersMax;

    // Everyone who voted for the real imposter scores
    Object.entries(room.votes).forEach(([voterId, targetId]) => {
      if (targetId === imposter.id) gains[voterId] = (gains[voterId] || 0) + POINTS_CORRECT_VOTE;
    });
    // The imposter scores if they were not caught
    if (!caught) gains[imposter.id] = (gains[imposter.id] || 0) + POINTS_IMPOSTER_ESCAPES;
  }

  room.players.forEach((p) => { p.score += gains[p.id] || 0; });

  room.reveal = {
    imposterId: room.imposterId,
    imposterName: imposter ? imposter.name : null,
    imposterLeft: !imposter,
    word: room.word,
    caught,
    tally,
    gains
  };

  const isLast = room.round >= TOTAL_ROUNDS;
  setPhase(room, 'reveal', RESULT_MS, () => (isLast ? showFinal(room) : startRound(room)));
}

function showFinal(room) {
  setPhase(room, 'final', FINAL_MS, () => endGame(room));
}

// Back to the lobby with a fresh scoreboard
function endGame(room) {
  clearTimeout(room.timer);
  room.round = 0;
  room.category = null;
  room.word = null;
  room.imposterId = null;
  room.votes = {};
  room.reveal = null;
  room.players.forEach((p) => { p.score = 0; });
  setPhase(room, 'lobby', 0);
}

io.on('connection', (socket) => {
  let currentCode = null;

  socket.on('stroke', (s) => {
    const room = rooms[currentCode];
    if (!room || room.phase !== 'drawing') return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    socket.to(room.code).emit('stroke', {
      x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, color: player.color
    });
  });

  socket.on('create_room', ({ name, color }, ack) => {
    name = cleanName(name);
    if (!name) return ack({ error: 'Please enter a nickname.' });
    if (!COLORS.includes(color)) color = COLORS[0];

    const code = makeCode();
    rooms[code] = {
      code, hostId: socket.id, phase: 'lobby', phaseEndsAt: 0, round: 0,
      category: null, word: null, imposterId: null, timer: null,
      votes: {}, reveal: null,
      players: [{ id: socket.id, name, color, score: 0 }]
    };
    socket.join(code);
    currentCode = code;
    ack({ ok: true, you: socket.id });
    broadcast(rooms[code]);
  });

  socket.on('join_room', ({ code, name, color }, ack) => {
    code = String(code || '').trim().toUpperCase();
    name = cleanName(name);
    const room = rooms[code];
    if (!name) return ack({ error: 'Please enter a nickname.' });
    if (!room) return ack({ error: 'Room not found.' });
    if (room.phase !== 'lobby') return ack({ error: 'That game already started.' });
    if (room.players.length >= MAX_PLAYERS) return ack({ error: 'Room is full.' });
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase()))
      return ack({ error: 'That nickname is taken.' });
    if (room.players.some(p => p.color === color)) {
      color = COLORS.find(c => !room.players.some(p => p.color === c));
    }

    room.players.push({ id: socket.id, name, color, score: 0 });
    socket.join(code);
    currentCode = code;
    ack({ ok: true, you: socket.id });
    broadcast(room);
  });

  socket.on('start_game', (ack) => {
    const room = rooms[currentCode];
    if (!room || room.hostId !== socket.id) return ack({ error: 'Only the host can start.' });
    if (room.phase !== 'lobby') return ack({ error: 'Game already started.' });
    if (room.players.length < MIN_PLAYERS)
      return ack({ error: `Need at least ${MIN_PLAYERS} players.` });
    ack({ ok: true });
    startRound(room);
  });

  // Voting: targetId is the player you think is the imposter
  socket.on('vote', (targetId) => {
    const room = rooms[currentCode];
    if (!room || room.phase !== 'voting') return;
    if (targetId === socket.id) return;                             // no voting for yourself
    if (!room.players.some((p) => p.id === socket.id)) return;
    if (!room.players.some((p) => p.id === targetId)) return;
    room.votes[socket.id] = targetId;                               // you can change your vote
    if (Object.keys(room.votes).length >= room.players.length) showResults(room); // everyone voted
    else broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = rooms[currentCode];
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);

    // Forget the leaver's vote, and any votes cast for them
    delete room.votes[socket.id];
    Object.keys(room.votes).forEach((voterId) => {
      if (room.votes[voterId] === socket.id) delete room.votes[voterId];
    });

    if (room.players.length === 0) {
      clearTimeout(room.timer);
      delete rooms[currentCode];
      return;
    }
    if (room.hostId === socket.id) room.hostId = room.players[0].id;

    // Too few players left in a running game -> back to the lobby
    if (room.phase !== 'lobby' && room.players.length < 3) {
      endGame(room);
      return;
    }
    if (room.phase === 'voting' && Object.keys(room.votes).length >= room.players.length) {
      showResults(room);
      return;
    }
    broadcast(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Draw and Bluff running on http://localhost:${PORT}`));