const socket = io();
const $ = (id) => document.getElementById(id);

const COLORS = ['#e6194b', '#f58231', '#ffe119', '#3cb44b', '#42d4f4',
                '#4363d8', '#911eb4', '#f032e6', '#9a6324', '#808080'];
let myColor = COLORS[0];
let myId = null;
let myRole = null;
let countdown = null;
let myVote = null;       // who I voted for this round
let lastPhase = null;

// ---------- Drawing canvas setup (declared first so renderGame can use it) ----------
const canvas = $('board');
const ctx = canvas.getContext('2d');
let drawing = false;
let last = null;
let currentPhase = null;
let lastRound = null;

// Small helper to build elements safely
function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text !== undefined && text !== null) e.textContent = text;
  if (className) e.className = className;
  return e;
}

function renderColors() {
  $('colors').innerHTML = '';
  COLORS.forEach((c) => {
    const d = document.createElement('div');
    d.className = 'swatch' + (c === myColor ? ' selected' : '');
    d.style.background = c;
    d.onclick = () => { myColor = c; renderColors(); };
    $('colors').appendChild(d);
  });
}
renderColors();

function show(screen) {
  ['home', 'lobby', 'game'].forEach((s) => $(s).classList.toggle('hidden', s !== screen));
}

function afterJoin(res) {
  if (res.error) { $('error').textContent = res.error; return; }
  myId = res.you;
  $('error').textContent = '';
}

$('createBtn').onclick = () => {
  socket.emit('create_room', { name: $('name').value, color: myColor }, afterJoin);
};
$('joinBtn').onclick = () => {
  socket.emit('join_room', { code: $('code').value, name: $('name').value, color: myColor }, afterJoin);
};
$('startBtn').onclick = () => {
  socket.emit('start_game', (res) => { $('lobbyError').textContent = res.error || ''; });
};

// Private message: only this player gets their own role
socket.on('your_role', (role) => { myRole = role; });

socket.on('room_update', (room) => {
  if (room.phase === 'lobby') renderLobby(room);
  else renderGame(room);
});

function renderLobby(room) {
  show('lobby');
  lastPhase = null;
  $('roomCode').textContent = room.code;
  $('players').innerHTML = '';
  room.players.forEach((p) => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color;
    const name = document.createElement('span');
    name.textContent = p.name + (p.id === myId ? ' (you)' : '');
    li.append(dot, name);
    if (p.id === room.hostId) {
      const crown = document.createElement('span');
      crown.className = 'crown';
      crown.textContent = '👑';
      li.append(crown);
    }
    $('players').appendChild(li);
  });
  $('count').textContent = `${room.players.length} / ${room.maxPlayers} players (need ${room.minPlayers} to start)`;
  const isHost = room.hostId === myId;
  $('startBtn').classList.toggle('hidden', !isHost);
  $('waiting').classList.toggle('hidden', isHost);
  $('startBtn').disabled = room.players.length < room.minPlayers;
}

function renderGame(room) {
  currentPhase = room.phase;
  if (room.round !== lastRound) {              // new round -> blank canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    lastRound = room.round;
  }
  if (room.phase !== lastPhase) {              // new phase -> forget my old vote
    myVote = null;
    lastPhase = room.phase;
  }

  show('game');
  $('roundInfo').textContent = `Round ${room.round} of ${room.totalRounds}`;
  $('category').textContent = room.category;

  // Show the player's secret role the whole time (they need it while drawing)
  const box = $('roleBox');
  box.innerHTML = '';
  if (myRole && myRole.isImposter) {
    box.className = 'rolebox imposter';
    box.textContent = "🕵️ You're the imposter";
    const small = document.createElement('small');
    small.textContent = 'Fake it! Draw something that fits the category.';
    box.appendChild(small);
  } else if (myRole) {
    box.className = 'rolebox';
    box.textContent = myRole.word;
    const small = document.createElement('small');
    small.textContent = 'Your secret word. Do not tell anyone!';
    box.appendChild(small);
  }

  const messages = {
    role_reveal: 'Memorize your role. Drawing starts soon…',
    drawing: 'Draw now!',
    voting: 'Time to vote! Who is the imposter?',
    reveal: 'Round results',
    final: 'Game over!'
  };
  $('phaseMsg').textContent = messages[room.phase] || '';

  renderVoting(room);
  renderResult(room);
  renderScoreboard(room);
  startCountdown(room.endsIn);
}

// ---------- Voting ----------
function renderVoting(room) {
  const isVoting = room.phase === 'voting';
  $('voteBox').classList.toggle('hidden', !isVoting);
  if (!isVoting) return;

  $('voteList').innerHTML = '';
  room.players.forEach((p) => {
    if (p.id === myId) return;               // you can't vote for yourself
    const b = el('button', null, 'votebtn' + (myVote === p.id ? ' picked' : ''));
    const dot = el('span', null, 'dot');
    dot.style.background = p.color;
    b.append(dot, el('span', p.name));
    b.onclick = () => {
      myVote = p.id;
      socket.emit('vote', p.id);
      renderVoting(room);                    // update the highlight right away
    };
    $('voteList').appendChild(b);
  });
  $('voteStatus').textContent = `${room.voted.length} / ${room.players.length} players have voted`;
}

// ---------- Round results + final winner ----------
function renderResult(room) {
  const box = $('resultBox');
  const showIt = (room.phase === 'reveal' || room.phase === 'final') && room.reveal;
  box.classList.toggle('hidden', !showIt);
  if (!showIt) return;

  const r = room.reveal;
  box.innerHTML = '';

  if (r.imposterLeft) {
    box.appendChild(el('div', 'The imposter left the game! 😮', 'resulttitle'));
  } else {
    box.appendChild(el('div', `🕵️ The imposter was ${r.imposterName}`, 'resulttitle'));
  }
  box.appendChild(el('p', `The secret word was: ${r.word}`, 'resultline'));
  if (!r.imposterLeft) {
    box.appendChild(el('p', r.caught ? 'The imposter got caught! 🎉' : 'The imposter fooled everyone! 😈', 'resultline'));
  }

  // Who scored this round
  room.players.forEach((p) => {
    const g = r.gains[p.id];
    if (g) box.appendChild(el('p', `+${g}  ${p.name}`, 'gain'));
  });

  if (room.phase === 'final') {
    const top = Math.max(...room.players.map((p) => p.score));
    const winners = room.players.filter((p) => p.score === top).map((p) => p.name);
    box.appendChild(el('div', `🏆 Winner: ${winners.join(' & ')} (${top} pts)`, 'winner'));
  }
}

// ---------- Scoreboard ----------
function renderScoreboard(room) {
  const list = $('scoreboard');
  list.innerHTML = '';
  [...room.players].sort((a, b) => b.score - a.score).forEach((p) => {
    const li = document.createElement('li');
    const dot = el('span', null, 'dot');
    dot.style.background = p.color;
    li.append(dot, el('span', p.name + (p.id === myId ? ' (you)' : '')), el('span', `${p.score} pts`, 'score'));
    list.appendChild(li);
  });
}

function startCountdown(ms) {
  clearInterval(countdown);
  const end = Date.now() + ms;
  const tick = () => {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    $('timer').textContent = ms > 0 ? left : '';
    if (left <= 0) clearInterval(countdown);
  };
  tick();
  countdown = setInterval(tick, 250);
}

// ---------- Drawing canvas ----------
function drawLine(x0, y0, x1, y1, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x0 * canvas.width, y0 * canvas.height);
  ctx.lineTo(x1 * canvas.width, y1 * canvas.height);
  ctx.stroke();
}

function pos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

canvas.addEventListener('pointerdown', (e) => {
  if (currentPhase !== 'drawing') return;
  drawing = true;
  last = pos(e);
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!drawing || currentPhase !== 'drawing') return;
  const p = pos(e);
  drawLine(last.x, last.y, p.x, p.y, myColor);
  socket.emit('stroke', { x0: last.x, y0: last.y, x1: p.x, y1: p.y });
  last = p;
});

['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
  canvas.addEventListener(ev, () => { drawing = false; })
);

socket.on('stroke', (s) => drawLine(s.x0, s.y0, s.x1, s.y1, s.color));