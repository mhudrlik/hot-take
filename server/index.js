'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { Room, GameError, normalizeDeck } = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const DECKS_DIR = process.env.DECKS_DIR || path.join(__dirname, '..', 'data', 'decks');
// Base URL encoded in invite links and QR codes, e.g. https://cards.example.com. Defaults to the URL the host used.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
// How long a player whose phone dropped keeps their seat before being removed.
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 120_000;
// Rooms with no activity for this long are deleted.
const ROOM_IDLE_MS = Number(process.env.ROOM_IDLE_MS) || 2 * 60 * 60_000;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 200;
// No vowels, so codes can't spell words; no I/O/0/1 lookalikes.
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

/** Loads every *.json file in `dir` as a deck, sorted by filename. The filename (minus .json) is the deck id. */
function loadDecks(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`No decks (*.json) found in ${dir}`);
  return files.map((file) => {
    const deck = normalizeDeck(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')), path.basename(file, '.json'));
    if (deck.duplicatesRemoved) console.warn(`Deck "${deck.name}": ignored ${deck.duplicatesRemoved} duplicate card(s)`);
    return deck;
  });
}

const isLoopback = (hostname) => hostname === 'localhost' || hostname.startsWith('127.') || hostname === '[::1]';

function lanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

/**
 * The base URL other phones should use. If the host opened the game via localhost, swap in this
 * machine's LAN address so the QR code works; inside Docker that address is the container's, so
 * we can only warn and point at PUBLIC_URL.
 */
function inviteBase(req) {
  if (PUBLIC_URL) return { base: PUBLIC_URL, reachable: true };
  const url = new URL(`${req.protocol}://${req.host}`);
  if (!isLoopback(url.hostname)) return { base: url.origin, reachable: true };
  const lan = fs.existsSync('/.dockerenv') ? null : lanAddress();
  if (!lan) return { base: url.origin, reachable: false };
  url.hostname = lan;
  return { base: url.origin, reachable: true };
}

function createServer({ decks = loadDecks(DECKS_DIR), graceMs = DISCONNECT_GRACE_MS } = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 16 * 1024 });
  const rooms = new Map(); // code -> Room
  const sockets = new Map(); // playerId -> socket (latest connection only)
  const dropTimers = new Map(); // playerId -> timeout

  app.disable('x-powered-by');
  // Honour X-Forwarded-Proto/Host from a reverse proxy on a private network.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

  function roomParam(req) {
    const code = String(req.query.room || '').toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) throw new GameError('Bad room code.');
    return code;
  }

  app.get('/api/invite', (req, res) => {
    try {
      const code = roomParam(req);
      const { base, reachable } = inviteBase(req);
      res.json({ url: `${base}/?room=${code}`, reachable });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/qr.svg', async (req, res) => {
    try {
      const url = `${inviteBase(req).base}/?room=${roomParam(req)}`;
      const svg = await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
      res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
    } catch (err) {
      res.status(400).type('text/plain').send(err instanceof GameError ? err.message : 'Could not make QR code.');
    }
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  function newCode() {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
    throw new GameError('Could not allocate a room code. Try again.');
  }

  function broadcast(room) {
    for (const p of room.players) {
      const s = sockets.get(p.id);
      if (s) s.emit('state', room.viewFor(p.id));
    }
  }

  function bind(socket, room, player) {
    const previous = sockets.get(player.id);
    if (previous && previous.id !== socket.id) {
      previous.data.binding = null;
      previous.emit('replaced');
      previous.disconnect(true);
    }
    clearTimeout(dropTimers.get(player.id));
    dropTimers.delete(player.id);
    sockets.set(player.id, socket);
    socket.data.binding = { code: room.code, playerId: player.id };
  }

  function unbind(socket, { remove }) {
    const binding = socket.data.binding;
    if (!binding) return;
    socket.data.binding = null;
    const room = rooms.get(binding.code);
    if (sockets.get(binding.playerId) === socket) sockets.delete(binding.playerId);
    if (!room) return;

    if (remove) {
      room.leave(binding.playerId);
    } else {
      room.setConnected(binding.playerId, false);
      dropTimers.set(
        binding.playerId,
        setTimeout(() => {
          dropTimers.delete(binding.playerId);
          if (!rooms.has(room.code) || room.player(binding.playerId)?.connected !== false) return;
          room.leave(binding.playerId);
          cleanupRoom(room);
        }, graceMs),
      );
    }
    cleanupRoom(room);
  }

  function cleanupRoom(room) {
    if (room.players.length === 0) rooms.delete(room.code);
    else broadcast(room);
  }

  // Wraps a handler so it always acks { ok } or { error } and rebroadcasts after a change.
  function handler(fn) {
    return (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const result = fn(payload && typeof payload === 'object' ? payload : {});
        reply({ ok: true, ...result });
      } catch (err) {
        if (!(err instanceof GameError)) console.error(err);
        reply({ error: err instanceof GameError ? err.message : 'Something went wrong.' });
      }
    };
  }

  function current(socket) {
    const binding = socket.data.binding;
    const room = binding && rooms.get(binding.code);
    if (!room || !room.player(binding.playerId)) throw new GameError('You are not in a game.');
    return { room, playerId: binding.playerId };
  }

  io.on('connection', (socket) => {
    socket.on('create', handler(({ name }) => {
      if (rooms.size >= MAX_ROOMS) throw new GameError('The server is full. Try again later.');
      unbind(socket, { remove: true });
      const room = new Room(newCode(), decks);
      const player = room.join(name);
      rooms.set(room.code, room);
      bind(socket, room, player);
      broadcast(room);
      return { code: room.code, token: player.token };
    }));

    socket.on('join', handler(({ code, name, token }) => {
      const room = rooms.get(String(code ?? '').trim().toUpperCase());
      if (!room) throw new GameError('No game with that code.');
      const player = room.join(name, token);
      if (socket.data.binding?.playerId !== player.id) unbind(socket, { remove: true });
      bind(socket, room, player);
      broadcast(room);
      return { code: room.code, token: player.token };
    }));

    socket.on('leave', handler(() => {
      unbind(socket, { remove: true });
    }));

    const actions = {
      settings: (room, id, p) => room.updateSettings(id, p.settings || {}),
      start: (room, id) => room.start(id),
      submit: (room, id, p) => room.submit(id, p.cardIds),
      pick: (room, id, p) => room.pickWinner(id, p.submissionId),
      next: (room, id) => room.nextRound(id),
      skip: (room, id) => room.skipRound(id),
      trade: (room, id) => room.tradeHand(id),
      mulligan: (room, id) => room.mulligan(id),
      kick: (room, id, p) => {
        const target = sockets.get(p.playerId);
        room.kick(id, p.playerId);
        if (target) {
          target.data.binding = null;
          sockets.delete(p.playerId);
          target.emit('kicked');
        }
      },
    };

    socket.on('action', handler((payload) => {
      const fn = actions[payload.type];
      if (!fn) throw new GameError('Unknown action.');
      const { room, playerId } = current(socket);
      fn(room, playerId, payload);
      cleanupRoom(room);
    }));

    socket.on('disconnect', () => unbind(socket, { remove: false }));
  });

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - ROOM_IDLE_MS;
    for (const [code, room] of rooms) {
      if (room.updatedAt < cutoff && room.connectedCount === 0) rooms.delete(code);
    }
  }, 60_000);
  sweeper.unref();

  return { app, server, io, rooms };
}

if (require.main === module) {
  const { server } = createServer();
  server.listen(PORT, () => console.log(`Hot Take listening on http://0.0.0.0:${PORT}`));
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, loadDecks };
