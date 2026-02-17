const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { nanoid } = require("nanoid");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get("/health", (req, res) => res.json({ ok: true }));

const rooms = new Map();

function makeRoomCode() {
  return nanoid(5).toUpperCase();
}

const DEFAULT_PROMPTS = [
  { left: "Cold", right: "Hot" },
  { left: "Boring", right: "Exciting" },
  { left: "Weak", right: "Strong" },
  { left: "Gross", right: "Tasty" },
  { left: "Chaotic", right: "Orderly" },
  { left: "Overrated", right: "Underrated" },
];

function pickSpectrum(room) {
  const pool = Array.isArray(room.promptPool) && room.promptPool.length > 0 ? room.promptPool : DEFAULT_PROMPTS;
  return pool[Math.floor(Math.random() * pool.length)];
}

function clamp01_100(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 50;
  return Math.max(0, Math.min(100, v));
}

function clampInt(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  const i = Math.floor(v);
  return Math.max(lo, Math.min(hi, i));
}

// Points by distance (classic tiers)
function scoreFromDistance(dist) {
  if (dist <= 10) return 4;
  if (dist <= 17) return 3;
  if (dist <= 24) return 2;
  if (dist <= 34) return 1;
  return 0;
}

function parsePromptLines(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const prompts = [];
  for (const line of lines) {
    let left = null;
    let right = null;

    if (line.includes("|")) {
      const [a, b] = line.split("|");
      left = a?.trim();
      right = b?.trim();
    } else if (line.includes(",")) {
      const [a, b] = line.split(",");
      left = a?.trim();
      right = b?.trim();
    } else if (line.includes("->")) {
      const [a, b] = line.split("->");
      left = a?.trim();
      right = b?.trim();
    } else if (line.includes("—")) {
      const [a, b] = line.split("—");
      left = a?.trim();
      right = b?.trim();
    }

    if (left && right && left.length <= 50 && right.length <= 50) prompts.push({ left, right });
  }

  return prompts.slice(0, 250);
}

function leaderboard(room) {
  return room.players
    .map((p) => ({ id: p.id, name: p.name, score: room.playerScores[p.id] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function safeRoomState(room, forPlayerId) {
  const base = {
    code: room.code,
    hostId: room.hostId,
    players: room.players,
    playerScores: room.playerScores,
    phase: room.phase,
    cluegiverId: room.cluegiverId,
    spectrum: room.spectrum,
    clue: room.clue,
    guesses: Array.from(room.guesses.entries()).map(([id, value]) => ({ id, value })),
    locked: Array.from(room.locked.values()),
    score: room.score,
    finalGuess: room.finalGuess,
    lastReveal: room.lastReveal,
    promptPoolCount: room.promptPool?.length ?? 0,
    totalRounds: room.totalRounds,
    currentRound: room.currentRound,
    leaderboard: room.phase === "GAMEOVER" ? leaderboard(room) : null,
  };

  if (forPlayerId === room.cluegiverId && room.phase === "CLUE") {
    return { ...base, secretTarget: room.target };
  }
  return base;
}

function broadcastRoom(room) {
  for (const p of room.players) {
    io.to(p.id).emit("room:state", safeRoomState(room, p.id));
  }
}

function rotateCluegiver(room) {
  const idx = room.players.findIndex((p) => p.id === room.cluegiverId);
  const nextIdx = idx >= 0 ? (idx + 1) % room.players.length : 0;
  room.cluegiverId = room.players[nextIdx].id;
}

function startRound(room) {
  room.phase = "CLUE";

  rotateCluegiver(room);

  room.spectrum = pickSpectrum(room);
  room.target = Math.floor(Math.random() * 101); // 0..100

  room.clue = "";
  room.guesses = new Map();     // playerId -> number
  room.locked = new Set();      // playerId
  room.finalGuess = null;
  room.lastReveal = null;

  broadcastRoom(room);
}

function computeFinalGuess(room) {
  const guessers = room.players.filter((p) => p.id !== room.cluegiverId).map((p) => p.id);
  const lockedGuessers = guessers.filter((id) => room.locked.has(id));
  const values = lockedGuessers
    .map((id) => room.guesses.get(id))
    .filter((x) => typeof x === "number");

  if (values.length === 0) return 50;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.round(avg);
}

function revealRound(room) {
  room.phase = "REVEAL";

  const finalGuess = computeFinalGuess(room);
  room.finalGuess = finalGuess;

  if (!room.playerScores) room.playerScores = {};

  const guessers = room.players.filter((p) => p.id !== room.cluegiverId);

  // per-player results (what client uses)
  const perPlayer = {}; // id -> {guess, dist, pts}
  let sumPoints = 0;
  let counted = 0;

  for (const p of guessers) {
    const gv = room.guesses.get(p.id);
    if (typeof gv === "number") {
      const d = Math.abs(gv - room.target);
      const pts = scoreFromDistance(d);
      perPlayer[p.id] = { guess: gv, dist: d, pts };
      room.playerScores[p.id] = (room.playerScores[p.id] ?? 0) + pts;
      sumPoints += pts;
      counted += 1;
    } else {
      perPlayer[p.id] = { guess: null, dist: null, pts: 0 };
      room.playerScores[p.id] = (room.playerScores[p.id] ?? 0) + 0;
    }
  }

  // cluegiver gets average points of guessers (optional but feels fair)
  const cluePts = counted > 0 ? Math.round(sumPoints / counted) : 0;
  if (room.cluegiverId) {
    room.playerScores[room.cluegiverId] = (room.playerScores[room.cluegiverId] ?? 0) + cluePts;
  }

  // team score = sum of guesser points (not cluePts)
  room.score = (room.score ?? 0) + sumPoints;

  // keep “team tier” based on finalGuess (for display only)
  const teamDist = Math.abs(finalGuess - room.target);
  const teamDelta = scoreFromDistance(teamDist);

  room.lastReveal = {
    target: room.target,
    finalGuess,
    dist: teamDist,
    delta: teamDelta,
    total: room.score,
    perPlayer,
    cluePts,
  };

  broadcastRoom(room);
}

function endGame(room) {
  room.phase = "GAMEOVER";
  room.spectrum = null;
  room.target = null;
  room.clue = "";
  room.guesses = new Map();
  room.locked = new Set();
  room.finalGuess = null;
  room.lastReveal = null;
  broadcastRoom(room);
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ name }) => {
    const code = makeRoomCode();

    const room = {
      code,
      hostId: socket.id,
      players: [{ id: socket.id, name: name || "Player" }],
      playerScores: { [socket.id]: 0 },

      phase: "LOBBY",
      cluegiverId: socket.id,

      spectrum: null,
      target: null,
      clue: "",
      guesses: new Map(),
      locked: new Set(),
      finalGuess: null,
      lastReveal: null,

      score: 0,
      promptPool: [],

      totalRounds: 5,
      currentRound: 0,
    };

    rooms.set(code, room);
    socket.join(code);
    socket.emit("room:joined", { code });
    broadcastRoom(room);
  });

  socket.on("room:join", ({ code, name }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit("room:error", { message: "Room not found." });

    if (!room.players.find((p) => p.id === socket.id)) {
      room.players.push({ id: socket.id, name: name || "Player" });
      room.playerScores[socket.id] = room.playerScores[socket.id] ?? 0;
    }

    socket.join(code);
    socket.emit("room:joined", { code });
    broadcastRoom(room);
  });

  socket.on("prompts:set", ({ code, text }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (room.phase !== "LOBBY") return;
    room.promptPool = parsePromptLines(text);
    broadcastRoom(room);
  });

  socket.on("config:setRounds", ({ code, totalRounds }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (room.phase !== "LOBBY") return;
    room.totalRounds = clampInt(totalRounds, 1, 50, room.totalRounds || 5);
    broadcastRoom(room);
  });

  socket.on("game:start", ({ code, totalRounds }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (socket.id !== room.hostId) return;

    if (room.players.length < 2) return socket.emit("room:error", { message: "Need at least 2 players." });

    if (totalRounds != null) room.totalRounds = clampInt(totalRounds, 1, 50, room.totalRounds || 5);

    room.score = 0;
    for (const p of room.players) room.playerScores[p.id] = 0;

    room.currentRound = 1;
    room.cluegiverId = room.players[room.players.length - 1].id; // so rotate gives player[0]
    startRound(room);
  });

  socket.on("round:clue", ({ code, text }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (room.phase !== "CLUE") return;
    if (socket.id !== room.cluegiverId) return;

    room.clue = String(text || "").slice(0, 140);
    room.phase = "GUESS";
    broadcastRoom(room);
  });

  socket.on("round:guess", ({ code, value }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (room.phase !== "GUESS") return;
    if (socket.id === room.cluegiverId) return;

    room.guesses.set(socket.id, clamp01_100(value));
    broadcastRoom(room);
  });

  socket.on("round:lock", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (room.phase !== "GUESS") return;
    if (socket.id === room.cluegiverId) return;

    room.locked.add(socket.id);

    const guessers = room.players.filter((p) => p.id !== room.cluegiverId);
    const allLocked = guessers.every((p) => room.locked.has(p.id));
    if (allLocked) revealRound(room);
    else broadcastRoom(room);
  });

  socket.on("round:revealNow", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (room.phase !== "GUESS") return;
    revealRound(room);
  });

  socket.on("round:next", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (room.phase !== "REVEAL") return;

    if (room.currentRound >= room.totalRounds) return endGame(room);

    room.currentRound += 1;
    startRound(room);
  });

  socket.on("game:replay", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (socket.id !== room.hostId) return;

    room.score = 0;
    for (const p of room.players) room.playerScores[p.id] = 0;

    room.currentRound = 1;
    room.cluegiverId = room.players[room.players.length - 1].id;
    startRound(room);
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms.entries()) {
      const before = room.players.length;
      room.players = room.players.filter((p) => p.id !== socket.id);

      if (room.players.length !== before) {
        delete room.playerScores[socket.id];

        if (room.hostId === socket.id) room.hostId = room.players[0]?.id || null;
        if (room.cluegiverId === socket.id) room.cluegiverId = room.players[0]?.id || null;

        if (room.players.length === 0) rooms.delete(code);
        else broadcastRoom(room);
      }
    }
  });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

