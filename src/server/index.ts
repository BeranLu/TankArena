import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { Server, Socket } from 'socket.io';
import type {
  ArenaMap,
  ClientToServerEvents,
  GameMode,
  GameSnapshot,
  LobbySummary,
  MatchPhase,
  ModeSettings,
  PlayerInput,
  PlayerSnapshot,
  ProjectileSnapshot,
  RoundResult,
  ServerToClientEvents,
  TeamId,
} from '../shared/types.js';

type PlayerState = PlayerSnapshot & {
  input: PlayerInput;
  socketId: string | null;
  clientKey: string;
  joinedAt: number;
  respawnAt: number;
  shootCooldown: number;
  shieldUntil: number;
};

type RecoverablePlayer = {
  name: string;
  team: TeamId;
  score: number;
  ready: boolean;
  observer: boolean;
  expiresAt: number;
};

type ProjectileState = ProjectileSnapshot & {
  vx: number;
  vy: number;
  ttl: number;
};

type FlagState = { x: number; y: number; homeX: number; homeY: number; carriedBy: string | null };
type Point = { x: number; y: number };
type BotMovementTarget = Point & { preferredDistance: number };
type LobbyState = {
  id: string;
  name: string;
  password: string | null;
  phase: MatchPhase;
  countdownEndsAt: number | null;
  mode: GameMode;
  map: ArenaMap;
  players: Map<string, PlayerState>;
  reconnectCache: Map<string, RecoverablePlayer>;
  projectiles: Map<string, ProjectileState>;
  redFlag: FlagState;
  blueFlag: FlagState;
  score: { red: number; blue: number };
  modeSettings: ModeSettings;
  adminId: string | null;
  nextBotId: number;
  message: string;
  roundResult: RoundResult | null;
};
type LobbyRuntime = {
  id: string;
  name: string;
  state: LobbyState;
  loop: NodeJS.Timeout;
  emptyTimer: NodeJS.Timeout | null;
};

const PORT = Number(process.env.PORT ?? 3001);
const TICK_MS = 1000 / 60;
const PLAYER_RADIUS = 14;
const BULLET_RADIUS = 4;
const BASE_HEALTH = 100;
const KING_RADIUS_MULTIPLIER = 1.2;
const PLAYER_SPEED = 170;
const REVERSE_SPEED_MULTIPLIER = 0.65;
const HULL_TURN_SPEED = 2.5;
const TURRET_TURN_SPEED = 3.4;
const BULLET_SPEED = 460;
const RESPAWN_SHIELD_MS = 5000;
const DEFAULT_CTF_WIN_SCORE = 3;
const DEFAULT_TEAM_DEATHMATCH_WIN_SCORE = 10;
const DEFAULT_KING_HEALTH = 500;
const BOT_NAME_PREFIX = 'BOT';
const MAX_LOBBIES = parseLimit(process.env.MAX_LOBBIES, 8);
const MAX_PLAYERS_PER_LOBBY = parseLimit(process.env.MAX_PLAYERS_PER_LOBBY, 10);
const MAX_BOTS_PER_LOBBY = parseLimit(process.env.MAX_BOTS_PER_LOBBY, 6);
const MAX_TOTAL_PLAYERS = parseLimit(process.env.MAX_TOTAL_PLAYERS, 40);
const EMPTY_LOBBY_GRACE_MS = parseLimit(process.env.EMPTY_LOBBY_GRACE_MS, 45000);
const RECONNECT_GRACE_MS = parseLimit(process.env.RECONNECT_GRACE_MS, 25000);
const REDIS_URL = (process.env.REDIS_URL ?? '').trim();
const DEFAULT_LOBBY_ID = 'main';
type ActiveTeam = Exclude<TeamId, 'observer'>;

const MAPS: Record<string, ArenaMap> = {
  'cargo-yard': {
    id: 'cargo-yard',
    name: 'Cargo Yard',
    width: 1280,
    height: 800,
    obstacles: [
      { x: 470, y: 160, width: 320, height: 50 },
      { x: 470, y: 590, width: 320, height: 50 },
      { x: 220, y: 280, width: 90, height: 220 },
      { x: 970, y: 280, width: 90, height: 220 },
    ],
    spawns: {
      red: [{ x: 130, y: 150 }, { x: 130, y: 400 }, { x: 130, y: 650 }],
      blue: [{ x: 1150, y: 150 }, { x: 1150, y: 400 }, { x: 1150, y: 650 }],
    },
    redBase: { x: 95, y: 400 },
    blueBase: { x: 1185, y: 400 },
    redFlag: { x: 145, y: 400 },
    blueFlag: { x: 1135, y: 400 },
    redKing: { x: 170, y: 400 },
    blueKing: { x: 1110, y: 400 },
  },
  'iron-pass': {
    id: 'iron-pass',
    name: 'Iron Pass',
    width: 1220,
    height: 760,
    obstacles: [
      { x: 340, y: 120, width: 540, height: 45 },
      { x: 340, y: 595, width: 540, height: 45 },
      { x: 530, y: 210, width: 160, height: 340 },
      { x: 90, y: 270, width: 120, height: 220 },
      { x: 1010, y: 270, width: 120, height: 220 },
    ],
    spawns: {
      red: [{ x: 245, y: 150 }, { x: 245, y: 390 }, { x: 245, y: 610 }],
      blue: [{ x: 975, y: 150 }, { x: 975, y: 390 }, { x: 975, y: 610 }],
    },
    redBase: { x: 220, y: 380 },
    blueBase: { x: 1000, y: 380 },
    redFlag: { x: 270, y: 380 },
    blueFlag: { x: 950, y: 380 },
    redKing: { x: 300, y: 380 },
    blueKing: { x: 920, y: 380 },
  },
  'dune-stronghold': {
    id: 'dune-stronghold',
    name: 'Dune Stronghold',
    width: 1300,
    height: 820,
    obstacles: [
      { x: 360, y: 140, width: 120, height: 240 },
      { x: 820, y: 440, width: 120, height: 240 },
      { x: 560, y: 260, width: 180, height: 300 },
      { x: 160, y: 500, width: 180, height: 110 },
      { x: 960, y: 210, width: 180, height: 110 },
    ],
    spawns: {
      red: [{ x: 130, y: 170 }, { x: 130, y: 410 }, { x: 130, y: 650 }],
      blue: [{ x: 1170, y: 170 }, { x: 1170, y: 410 }, { x: 1170, y: 650 }],
    },
    redBase: { x: 95, y: 410 },
    blueBase: { x: 1205, y: 410 },
    redFlag: { x: 150, y: 410 },
    blueFlag: { x: 1150, y: 410 },
    redKing: { x: 190, y: 410 },
    blueKing: { x: 1110, y: 410 },
  },
  'frostline': {
    id: 'frostline',
    name: 'Frostline',
    width: 1240,
    height: 780,
    obstacles: [
      { x: 280, y: 110, width: 680, height: 45 },
      { x: 280, y: 625, width: 680, height: 45 },
      { x: 460, y: 220, width: 90, height: 340 },
      { x: 690, y: 220, width: 90, height: 340 },
      { x: 100, y: 330, width: 120, height: 120 },
      { x: 1020, y: 330, width: 120, height: 120 },
    ],
    spawns: {
      red: [{ x: 145, y: 150 }, { x: 145, y: 390 }, { x: 145, y: 630 }],
      blue: [{ x: 1095, y: 150 }, { x: 1095, y: 390 }, { x: 1095, y: 630 }],
    },
    redBase: { x: 95, y: 390 },
    blueBase: { x: 1145, y: 390 },
    redFlag: { x: 150, y: 390 },
    blueFlag: { x: 1090, y: 390 },
    redKing: { x: 190, y: 390 },
    blueKing: { x: 1050, y: 390 },
  },
  'reactor-ridge': {
    id: 'reactor-ridge',
    name: 'Reactor Ridge',
    width: 1320,
    height: 820,
    obstacles: [
      { x: 530, y: 170, width: 260, height: 120 },
      { x: 530, y: 530, width: 260, height: 120 },
      { x: 360, y: 320, width: 120, height: 180 },
      { x: 840, y: 320, width: 120, height: 180 },
      { x: 180, y: 240, width: 130, height: 100 },
      { x: 1010, y: 480, width: 130, height: 100 },
    ],
    spawns: {
      red: [{ x: 140, y: 180 }, { x: 140, y: 410 }, { x: 140, y: 640 }],
      blue: [{ x: 1180, y: 180 }, { x: 1180, y: 410 }, { x: 1180, y: 640 }],
    },
    redBase: { x: 100, y: 410 },
    blueBase: { x: 1220, y: 410 },
    redFlag: { x: 155, y: 410 },
    blueFlag: { x: 1165, y: 410 },
    redKing: { x: 195, y: 410 },
    blueKing: { x: 1125, y: 410 },
  },
};

const app = express();
const server = http.createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: { origin: true, credentials: true },
});

const clientDir = path.resolve(process.cwd(), 'dist/client');
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get('*', (_request, response) => {
    response.sendFile(path.join(clientDir, 'index.html'));
  });
}

const lobbyRuntimes = new Map<string, LobbyRuntime>();
const socketLobbyMap = new Map<string, string>();
let lobbyCounter = 1;
let state: LobbyState = createLobbyState('__bootstrap', 'Bootstrap Lobby', null);

createLobbyRuntime(DEFAULT_LOBBY_ID, 'Main Lobby', null);

io.on('connection', (socket) => {
  socket.emit('lobbyList', buildLobbyList());

  socket.on('listLobbies', () => {
    socket.emit('lobbyList', buildLobbyList());
  });

  socket.on('createLobby', ({ name, playerName, password, clientKey }: { name: string; playerName: string; password?: string; clientKey?: string }) => {
    if (lobbyRuntimes.size >= MAX_LOBBIES) {
      socket.emit('message', `Lobby limit reached (${MAX_LOBBIES}).`);
      return;
    }
    const sanitizedPassword = sanitizeLobbyPassword(password);
    const runtime = createLobbyRuntime(nextLobbyId(), sanitizeLobbyName(name), sanitizedPassword);
    joinSocketToLobby(socket, runtime, playerName, { forceAdmin: true, clientKey });
    socket.emit('message', `Lobby ${runtime.name} created. You are the admin.`);
    emitLobbyList();
  });

  socket.on('joinLobby', ({ lobbyId, name, password, clientKey }: { lobbyId: string; name: string; password?: string; clientKey?: string }) => {
    const runtime = lobbyRuntimes.get(lobbyId);
    if (!runtime) {
      socket.emit('message', 'That lobby no longer exists.');
      socket.emit('lobbyList', buildLobbyList());
      return;
    }

    const current = getSocketLobby(socket.id);
    if (current?.id === lobbyId && runtime.state.players.has(socket.id)) {
      socket.emit('message', `Already in ${runtime.name}.`);
      return;
    }

    if (runtime.state.password && runtime.state.password !== sanitizeLobbyPassword(password)) {
      socket.emit('message', 'Lobby password is incorrect.');
      return;
    }

    if (countLobbyHumans(runtime) >= MAX_PLAYERS_PER_LOBBY) {
      socket.emit('message', `Lobby is full (${MAX_PLAYERS_PER_LOBBY} players max).`);
      return;
    }
    const countedInTotal = current?.state.players.has(socket.id) ? 1 : 0;
    if (countTotalHumans() - countedInTotal >= MAX_TOTAL_PLAYERS) {
      socket.emit('message', `Server is full (${MAX_TOTAL_PLAYERS} total players max).`);
      return;
    }

    joinSocketToLobby(socket, runtime, name, { forceAdmin: false, clientKey });

    emitLobbyList();
  });

  socket.on('leaveLobby', () => {
    if (leaveLobby(socket.id, '', false)) {
      socket.emit('message', 'Left lobby.');
      socket.emit('lobbyList', buildLobbyList());
    }
  });

  socket.on('transferAdmin', ({ playerId }: { playerId: string }) => {
    const runtime = getSocketLobby(socket.id);
    if (!runtime) {
      return;
    }
    runInLobby(runtime, () => {
      if (!isAdmin(socket.id)) {
        return;
      }
      const target = state.players.get(playerId);
      if (!target || target.isBot) {
        socket.emit('message', 'Selected player is not available for admin transfer.');
        return;
      }
      state.adminId = target.id;
      refreshAdminFlags();
      broadcast(`Admin transferred to ${target.name}.`);
      emitSnapshot();
    });
  });

  socket.on('kickPlayer', ({ playerId }: { playerId: string }) => {
    const runtime = getSocketLobby(socket.id);
    if (!runtime) {
      return;
    }

    let targetName = '';
    runInLobby(runtime, () => {
      if (!isAdmin(socket.id)) {
        return;
      }
      const target = state.players.get(playerId);
      if (!target || target.isBot || target.id === socket.id) {
        return;
      }
      targetName = target.name;
    });

    if (!targetName) {
      return;
    }
    io.to(playerId).emit('kicked', { reason: 'You were removed from the lobby by admin.' });
    io.to(playerId).emit('message', 'You were removed from the lobby by admin.');
    leaveLobby(playerId, `${targetName} was removed by admin.`, false);
  });

  socket.on('addBot', () => {
    const runtime = getSocketLobby(socket.id);
    if (!runtime) {
      return;
    }
    runInLobby(runtime, () => {
      if (!isAdmin(socket.id) || state.phase !== 'lobby') {
        return;
      }
      const botCount = Array.from(state.players.values()).filter((player) => player.isBot).length;
      if (botCount >= MAX_BOTS_PER_LOBBY) {
        socket.emit('message', `Bot limit reached in this lobby (${MAX_BOTS_PER_LOBBY}).`);
        return;
      }
      const bot = createBot();
      state.players.set(bot.id, bot);
      state.message = `${bot.name} added to lobby.`;
      emitSnapshot();
      emitLobbyList();
    });
  });

  socket.on('removeBot', () => {
    const runtime = getSocketLobby(socket.id);
    if (!runtime) {
      return;
    }
    runInLobby(runtime, () => {
      if (!isAdmin(socket.id) || state.phase !== 'lobby') {
        return;
      }
      const bots = Array.from(state.players.values()).filter((player) => player.isBot);
      const bot = bots[bots.length - 1];
      if (!bot) {
        return;
      }
      state.players.delete(bot.id);
      state.message = `${bot.name} removed from lobby.`;
      emitSnapshot();
      emitLobbyList();
    });
  });

  socket.on('setReady', (ready: boolean) => {
    const runtime = getSocketLobby(socket.id);
    if (!runtime) {
      return;
    }
    runInLobby(runtime, () => {
      const player = state.players.get(socket.id);
      if (!player || player.observer) {
        return;
      }
      player.ready = ready;
      emitSnapshot();
    });
  });

  socket.on('setMap', (mapId: string) => {
    const runtime = getSocketLobby(socket.id);
    if (!runtime) {
      return;
    }
    runInLobby(runtime, () => {
      if (!isAdmin(socket.id) || state.phase !== 'lobby') {
        return;
      }
      const map = MAPS[mapId];
      if (!map) {
        return;
      }
      state.map = map;
      resetWorld(true);
      emitSnapshot();
      emitLobbyList();
    });
  });

  socket.on('setMode', (mode: GameMode) => {
    const runtime = getSocketLobby(socket.id);
    if (!runtime) {
      return;
    }
    runInLobby(runtime, () => {
      if (!isAdmin(socket.id) || state.phase !== 'lobby') {
        return;
      }
      state.mode = mode;
      emitSnapshot();
      emitLobbyList();
    });
  });

  socket.on('setModeSettings', (settings: ModeSettings) => {
    const runtime = getSocketLobby(socket.id);
    if (!runtime) {
      return;
    }
    runInLobby(runtime, () => {
      if (!isAdmin(socket.id) || state.phase !== 'lobby') {
        return;
      }
      if (!settings) {
        return;
      }
      state.modeSettings = sanitizeModeSettings(settings);
      emitSnapshot();
    });
  });

  socket.on('startMatch', () => {
    const runtime = getSocketLobby(socket.id);
    if (!runtime) {
      return;
    }
    runInLobby(runtime, () => {
      if (!isAdmin(socket.id) || state.phase !== 'lobby') {
        return;
      }
      state.phase = 'countdown';
      state.countdownEndsAt = Date.now() + 5000;
      state.message = 'Round starts in 5...';
      resetRoundState(true);
      emitSnapshot();
      emitLobbyList();
    });
  });

  socket.on('togglePause', () => {
    const runtime = getSocketLobby(socket.id);
    if (!runtime) {
      return;
    }
    runInLobby(runtime, () => {
      if (!isAdmin(socket.id) || (state.phase !== 'running' && state.phase !== 'paused')) {
        return;
      }
      state.phase = state.phase === 'paused' ? 'running' : 'paused';
      state.message = state.phase === 'paused' ? 'Match paused.' : 'Match resumed.';
      emitSnapshot();
      emitLobbyList();
    });
  });

  socket.on('resetLobby', () => {
    const runtime = getSocketLobby(socket.id);
    if (!runtime) {
      return;
    }
    runInLobby(runtime, () => {
      if (!isAdmin(socket.id)) {
        return;
      }
      state.phase = 'lobby';
      state.countdownEndsAt = null;
      state.message = 'Lobby reset. Players can ready up again.';
      resetRoundState();
      emitSnapshot();
      emitLobbyList();
    });
  });

  socket.on('input', (input: PlayerInput) => {
    const runtime = getSocketLobby(socket.id);
    if (!runtime) {
      return;
    }
    runInLobby(runtime, () => {
      const player = state.players.get(socket.id);
      if (!player || player.observer) {
        return;
      }
      player.input = input;
    });
  });

  socket.on('disconnect', () => {
    leaveLobby(socket.id, '', true);
  });
});

function parseLimit(raw: string | undefined, fallback: number) {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function nextLobbyId() {
  lobbyCounter += 1;
  return `lobby-${lobbyCounter}`;
}

function sanitizeLobbyName(name: string) {
  const trimmed = name.trim().slice(0, 28);
  return trimmed.length ? trimmed : `Lobby ${lobbyCounter + 1}`;
}

function lobbyRoom(lobbyId: string) {
  return `lobby:${lobbyId}`;
}

function createLobbyState(id: string, name: string, password: string | null): LobbyState {
  return {
    id,
    name,
    password,
    phase: 'lobby',
    countdownEndsAt: null,
    mode: 'deathmatch',
    map: MAPS['cargo-yard'],
    players: new Map<string, PlayerState>(),
    reconnectCache: new Map<string, RecoverablePlayer>(),
    projectiles: new Map<string, ProjectileState>(),
    redFlag: { x: MAPS['cargo-yard'].redFlag.x, y: MAPS['cargo-yard'].redFlag.y, homeX: MAPS['cargo-yard'].redFlag.x, homeY: MAPS['cargo-yard'].redFlag.y, carriedBy: null },
    blueFlag: { x: MAPS['cargo-yard'].blueFlag.x, y: MAPS['cargo-yard'].blueFlag.y, homeX: MAPS['cargo-yard'].blueFlag.x, homeY: MAPS['cargo-yard'].blueFlag.y, carriedBy: null },
    score: { red: 0, blue: 0 },
    modeSettings: {
      deathmatchTarget: DEFAULT_TEAM_DEATHMATCH_WIN_SCORE,
      ctfTarget: DEFAULT_CTF_WIN_SCORE,
      kingHealth: DEFAULT_KING_HEALTH,
    },
    adminId: null,
    nextBotId: 1,
    message: 'Waiting for players to join the lobby.',
    roundResult: null,
  };
}

function createLobbyRuntime(id: string, name: string, password: string | null) {
  const runtime: LobbyRuntime = {
    id,
    name,
    state: createLobbyState(id, name, password),
    emptyTimer: null,
    loop: setInterval(() => {
      runInLobby(runtime, () => {
        gameLoop();
      });
    }, TICK_MS),
  };
  lobbyRuntimes.set(id, runtime);
  return runtime;
}

function runInLobby<T>(runtime: LobbyRuntime, callback: () => T) {
  const previous = state;
  state = runtime.state;
  try {
    const result = callback();
    runtime.state = state;
    return result;
  } finally {
    state = previous;
  }
}

function getSocketLobby(socketId: string) {
  const lobbyId = socketLobbyMap.get(socketId);
  if (!lobbyId) {
    return undefined;
  }
  return lobbyRuntimes.get(lobbyId);
}

function countLobbyHumans(runtime: LobbyRuntime) {
  return Array.from(runtime.state.players.values()).filter((player) => !player.isBot).length;
}

function countTotalHumans() {
  return Array.from(lobbyRuntimes.values()).reduce((total, runtime) => total + countLobbyHumans(runtime), 0);
}

function buildLobbyList(): LobbySummary[] {
  return Array.from(lobbyRuntimes.values()).map((runtime) => ({
    id: runtime.id,
    name: runtime.name,
    phase: runtime.state.phase,
    mode: runtime.state.mode,
    mapName: runtime.state.map.name,
    players: countLobbyHumans(runtime),
    bots: Array.from(runtime.state.players.values()).filter((player) => player.isBot).length,
    requiresPassword: Boolean(runtime.state.password),
  }));
}

function emitLobbyList() {
  io.emit('lobbyList', buildLobbyList());
}

function joinSocketToLobby(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  runtime: LobbyRuntime,
  name: string,
  options: { forceAdmin: boolean; clientKey?: string },
) {
  leaveLobby(socket.id, '', false);
  clearEmptyLobbyTimer(runtime);
  socket.join(lobbyRoom(runtime.id));
  socketLobbyMap.set(socket.id, runtime.id);

  runInLobby(runtime, () => {
    const key = sanitizeClientKey(options.clientKey);
    const recovered = key ? takeRecoverablePlayer(key) : null;
    const observer = state.phase !== 'lobby';
    const recoveredTeam: TeamId = recovered?.observer ? 'observer' : (recovered?.team ?? 'none');
    const team: TeamId = observer ? (recovered ? recoveredTeam : 'observer') : (recovered ? recoveredTeam : 'none');
    const spawnSlot = observer || team === 'observer' ? 0 : teamPlayerCount(team as ActiveTeam);
    const spawnTeam = observer || team === 'observer' ? 'none' : (team as ActiveTeam);
    const spawn = observer ? { x: state.map.width / 2, y: state.map.height / 2 } : findSpawnPosition(spawnTeam, PLAYER_RADIUS, spawnSlot);
    const player: PlayerState = {
      id: socket.id,
      socketId: socket.id,
      clientKey: key,
      joinedAt: Date.now(),
      name: sanitizeName(recovered?.name ?? name),
      isBot: false,
      team,
      x: spawn.x,
      y: spawn.y,
      bodyAngle: 0,
      turretAngle: 0,
      health: BASE_HEALTH,
      maxHealth: BASE_HEALTH,
      score: recovered?.score ?? 0,
      ready: recovered?.ready ?? false,
      observer: observer ? true : (recovered?.observer ?? false),
      admin: false,
      carryingFlag: false,
      isKing: false,
      shielded: false,
      input: { up: false, down: false, left: false, right: false, fire: false, aimX: spawn.x, aimY: spawn.y },
      respawnAt: 0,
      shootCooldown: 0,
      shieldUntil: 0,
    };

    if (recovered && !observer) {
      player.team = recovered.team;
      player.score = recovered.score;
      player.ready = recovered.ready;
    }

    state.players.set(socket.id, player);
    if (options.forceAdmin || !state.adminId) {
      state.adminId = socket.id;
    }
    refreshAdminFlags();

    socket.emit('joined', { observer, admin: player.id === state.adminId, team, lobbyId: runtime.id, lobbyName: runtime.name });
    broadcast(`${player.name} joined ${observer ? 'as an observer' : 'the lobby'}.`);
    emitSnapshot();
  });
}

function leaveLobby(socketId: string, reason: string, preserveForReconnect: boolean) {
  const runtime = getSocketLobby(socketId);
  if (!runtime) {
    return false;
  }
  socketLobbyMap.delete(socketId);
  io.sockets.sockets.get(socketId)?.leave(lobbyRoom(runtime.id));

  runInLobby(runtime, () => {
    const player = state.players.get(socketId);
    if (!player) {
      return;
    }
    if (preserveForReconnect && player.clientKey && !player.isBot) {
      state.reconnectCache.set(player.clientKey, {
        name: player.name,
        team: player.team,
        score: player.score,
        ready: player.ready,
        observer: player.observer,
        expiresAt: Date.now() + RECONNECT_GRACE_MS,
      });
    }
    const wasAdmin = state.adminId === socketId;
    state.players.delete(socketId);
    if (wasAdmin) {
      const next = pickNextAdmin();
      state.adminId = next?.id ?? null;
      refreshAdminFlags();
    }
    state.message = reason || `${player.name} left the lobby.`;
    io.to(lobbyRoom(runtime.id)).emit('message', state.message);
    emitSnapshot();
  });

  scheduleLobbyCleanupIfEmpty(runtime);
  emitLobbyList();
  return true;
}

function pickNextAdmin() {
  return Array.from(state.players.values())
    .filter((candidate) => !candidate.isBot)
    .sort((left, right) => left.joinedAt - right.joinedAt || left.id.localeCompare(right.id))[0];
}

function sanitizeLobbyPassword(password?: string) {
  const trimmed = (password ?? '').trim().slice(0, 48);
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeClientKey(clientKey?: string) {
  const trimmed = (clientKey ?? '').trim().slice(0, 80);
  return trimmed.length > 0 ? trimmed : '';
}

function takeRecoverablePlayer(clientKey: string) {
  pruneReconnectCache();
  const cached = state.reconnectCache.get(clientKey);
  if (!cached) {
    return null;
  }
  state.reconnectCache.delete(clientKey);
  return cached;
}

function pruneReconnectCache() {
  const now = Date.now();
  for (const [key, cached] of state.reconnectCache.entries()) {
    if (cached.expiresAt <= now) {
      state.reconnectCache.delete(key);
    }
  }
}

function clearEmptyLobbyTimer(runtime: LobbyRuntime) {
  if (!runtime.emptyTimer) {
    return;
  }
  clearTimeout(runtime.emptyTimer);
  runtime.emptyTimer = null;
}

function scheduleLobbyCleanupIfEmpty(runtime: LobbyRuntime) {
  if (runtime.id === DEFAULT_LOBBY_ID) {
    return;
  }
  const humans = countLobbyHumans(runtime);
  if (humans > 0) {
    clearEmptyLobbyTimer(runtime);
    return;
  }
  if (runtime.emptyTimer) {
    return;
  }
  runtime.emptyTimer = setTimeout(() => {
    const activeRuntime = lobbyRuntimes.get(runtime.id);
    if (!activeRuntime) {
      return;
    }
    if (countLobbyHumans(activeRuntime) > 0) {
      clearEmptyLobbyTimer(activeRuntime);
      return;
    }
    destroyLobby(activeRuntime);
  }, EMPTY_LOBBY_GRACE_MS);
}

function destroyLobby(runtime: LobbyRuntime) {
  clearEmptyLobbyTimer(runtime);
  clearInterval(runtime.loop);
  lobbyRuntimes.delete(runtime.id);
  emitLobbyList();
}

function formatMode(mode: GameMode) {
  return mode.replaceAll('-', ' ');
}

function sanitizeName(name: string) {
  const trimmed = name.trim().slice(0, 20);
  return trimmed.length ? trimmed : 'Tank Pilot';
}

function isAdmin(socketId: string) {
  return state.adminId === socketId;
}

function refreshAdminFlags() {
  for (const player of state.players.values()) {
    player.admin = !player.isBot && player.id === state.adminId;
  }
}

function createBot() {
  const id = `bot-${state.nextBotId}`;
  state.nextBotId += 1;
  const spawnSlot = teamPlayerCount('none');
  const spawn = findSpawnPosition('none', PLAYER_RADIUS, spawnSlot);
  const name = `${BOT_NAME_PREFIX}-${String(state.nextBotId - 1).padStart(2, '0')}`;
  const player: PlayerState = {
    id,
    socketId: null,
    clientKey: `bot:${id}`,
    joinedAt: Date.now(),
    name,
    isBot: true,
    team: 'none',
    x: spawn.x,
    y: spawn.y,
    bodyAngle: Math.random() * Math.PI * 2,
    turretAngle: 0,
    health: BASE_HEALTH,
    maxHealth: BASE_HEALTH,
    score: 0,
    ready: true,
    observer: false,
    admin: false,
    carryingFlag: false,
    isKing: false,
    shielded: false,
    input: { up: false, down: false, left: false, right: false, fire: false, aimX: spawn.x, aimY: spawn.y },
    respawnAt: 0,
    shootCooldown: 0,
    shieldUntil: 0,
  };
  player.turretAngle = player.bodyAngle;
  return player;
}

function teamPlayerCount(team: ActiveTeam) {
  return Array.from(state.players.values()).filter((player) => player.team === team && !player.observer).length;
}

function getSpawn(team: ActiveTeam, slot?: number) {
  const spawns = team === 'none' ? [...state.map.spawns.red, ...state.map.spawns.blue] : state.map.spawns[team];
  if (typeof slot === 'number') {
    return spawns[slot % spawns.length];
  }
  return spawns[Math.floor(Math.random() * spawns.length)];
}

function getSpawnCandidates(team: ActiveTeam, slot?: number) {
  const spawns = team === 'none' ? [...state.map.spawns.red, ...state.map.spawns.blue] : state.map.spawns[team];
  if (spawns.length === 0) {
    return [{ x: state.map.width / 2, y: state.map.height / 2 }];
  }
  if (typeof slot !== 'number') {
    const start = Math.floor(Math.random() * spawns.length);
    return [...spawns.slice(start), ...spawns.slice(0, start)];
  }
  const normalized = ((slot % spawns.length) + spawns.length) % spawns.length;
  return [spawns[normalized], ...spawns.slice(0, normalized), ...spawns.slice(normalized + 1)];
}

function findSpawnPosition(team: ActiveTeam, radius: number, slot?: number) {
  const candidates = getSpawnCandidates(team, slot);

  for (const candidate of candidates) {
    if (isSpawnFree(candidate.x, candidate.y, radius)) {
      return candidate;
    }

    for (let ring = 1; ring <= 4; ring += 1) {
      const ringDistance = ring * (radius * 2.4);
      for (let step = 0; step < 12; step += 1) {
        const angle = (Math.PI * 2 * step) / 12;
        const x = clamp(candidate.x + Math.cos(angle) * ringDistance, radius, state.map.width - radius);
        const y = clamp(candidate.y + Math.sin(angle) * ringDistance, radius, state.map.height - radius);
        if (isSpawnFree(x, y, radius)) {
          return { x, y };
        }
      }
    }
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const x = radius + Math.random() * (state.map.width - radius * 2);
    const y = radius + Math.random() * (state.map.height - radius * 2);
    if (isSpawnFree(x, y, radius)) {
      return { x, y };
    }
  }

  return candidates[0];
}

function isSpawnFree(x: number, y: number, radius: number) {
  if (collides(x, y, radius)) {
    return false;
  }
  for (const other of state.players.values()) {
    if (other.observer || other.health <= 0) {
      continue;
    }
    const minDistance = radius + getTankRadius(other);
    if (distance(x, y, other.x, other.y) < minDistance) {
      return false;
    }
  }
  return true;
}

function resetWorld(resetPlayers = false) {
  state.projectiles.clear();
  state.score = { red: 0, blue: 0 };
  state.redFlag = { x: state.map.redFlag.x, y: state.map.redFlag.y, homeX: state.map.redFlag.x, homeY: state.map.redFlag.y, carriedBy: null };
  state.blueFlag = { x: state.map.blueFlag.x, y: state.map.blueFlag.y, homeX: state.map.blueFlag.x, homeY: state.map.blueFlag.y, carriedBy: null };
  if (resetPlayers) {
    const teamSlots: Record<ActiveTeam, number> = { red: 0, blue: 0, none: 0 };
    for (const player of state.players.values()) {
      if (!player.observer) {
        const team = state.phase === 'lobby' ? 'none' : (player.team as ActiveTeam);
        player.team = team;
        const spawn = findSpawnPosition(team, PLAYER_RADIUS, teamSlots[team]);
        teamSlots[team] += 1;
        player.x = spawn.x;
        player.y = spawn.y;
        player.health = BASE_HEALTH;
        player.maxHealth = BASE_HEALTH;
        player.isKing = false;
        player.carryingFlag = false;
        player.score = 0;
      }
    }
  }
}

function emitSnapshot() {
  io.to(lobbyRoom(state.id)).emit('snapshot', buildSnapshot());
}

function broadcast(message: string) {
  state.message = message;
  io.to(lobbyRoom(state.id)).emit('message', message);
}

function buildSnapshot(): GameSnapshot {
  const countdownRemainingMs = state.phase === 'countdown' && state.countdownEndsAt
    ? Math.max(0, state.countdownEndsAt - Date.now())
    : null;
  return {
    phase: state.phase,
    countdownRemainingMs,
    mode: state.mode,
    modeSettings: state.modeSettings,
    map: state.map,
    players: Array.from(state.players.values()).map((player) => ({
      id: player.id,
      name: player.name,
      isBot: player.isBot,
      team: player.team,
      x: player.x,
      y: player.y,
      bodyAngle: player.bodyAngle,
      turretAngle: player.turretAngle,
      health: player.health,
      maxHealth: player.maxHealth,
      score: player.score,
      ready: player.ready,
      observer: player.observer,
      admin: player.admin,
      carryingFlag: player.carryingFlag,
      isKing: player.isKing,
      shielded: Date.now() < player.shieldUntil,
    })),
    projectiles: Array.from(state.projectiles.values()).map((projectile) => ({
      id: projectile.id,
      ownerId: projectile.ownerId,
      x: projectile.x,
      y: projectile.y,
      team: projectile.team,
    })),
    flagsHome: { red: state.redFlag.carriedBy === null && near(state.redFlag.x, state.redFlag.homeX) && near(state.redFlag.y, state.redFlag.homeY), blue: state.blueFlag.carriedBy === null && near(state.blueFlag.x, state.blueFlag.homeX) && near(state.blueFlag.y, state.blueFlag.homeY) },
    kingHealth: { red: getTeamKingHealth('red'), blue: getTeamKingHealth('blue') },
    score: state.score,
    activePlayers: Array.from(state.players.values()).filter((player) => !player.observer).length,
    connectedClients: Array.from(state.players.values()).filter((player) => !player.isBot).length,
    adminId: state.adminId,
    message: state.message,
    roundResult: state.roundResult,
  };
}

function sanitizeModeSettings(settings: ModeSettings): ModeSettings {
  return {
    deathmatchTarget: clampInt(settings.deathmatchTarget, 1, 200),
    ctfTarget: clampInt(settings.ctfTarget, 1, 20),
    kingHealth: clampInt(settings.kingHealth, BASE_HEALTH, 5000),
  };
}

function clampInt(value: number, min: number, max: number) {
  const safe = Number.isFinite(value) ? Math.round(value) : min;
  return Math.max(min, Math.min(max, safe));
}

function near(value: number, target: number) {
  return Math.abs(value - target) < 0.5;
}

function gameLoop() {
  if (state.phase === 'countdown') {
    const remaining = state.countdownEndsAt ? state.countdownEndsAt - Date.now() : 0;
    if (remaining <= 0) {
      state.phase = 'running';
      state.countdownEndsAt = null;
      state.message = `${formatMode(state.mode)} started.`;
      emitLobbyList();
    }
    emitSnapshot();
    return;
  }

  if (state.phase === 'paused' || state.phase === 'finished') {
    emitSnapshot();
    return;
  }

  const now = Date.now();
  for (const bot of state.players.values()) {
    if (bot.isBot) {
      updateBotInput(bot);
    }
  }
  for (const player of state.players.values()) {
    if (player.observer) {
      continue;
    }

    if (player.health <= 0) {
      if (now >= player.respawnAt) {
        respawn(player);
      }
      continue;
    }

    if (player.shootCooldown > 0) {
      player.shootCooldown = Math.max(0, player.shootCooldown - TICK_MS);
    }

    const deltaSeconds = TICK_MS / 1000;

    const turnInput = (player.input.right ? 1 : 0) - (player.input.left ? 1 : 0);
    if (turnInput !== 0) {
      player.bodyAngle = wrapAngle(player.bodyAngle + turnInput * HULL_TURN_SPEED * deltaSeconds);
    }

    const desiredTurretAngle = Math.atan2(player.input.aimY - player.y, player.input.aimX - player.x);
    if (Number.isFinite(desiredTurretAngle)) {
      player.turretAngle = rotateTowards(player.turretAngle, desiredTurretAngle, TURRET_TURN_SPEED * deltaSeconds);
    }

    let speed = 0;
    if (player.input.up) {
      speed += PLAYER_SPEED;
    }
    if (player.input.down) {
      speed -= PLAYER_SPEED * REVERSE_SPEED_MULTIPLIER;
    }
    if (speed !== 0) {
      movePlayer(player, Math.cos(player.bodyAngle) * speed * deltaSeconds, Math.sin(player.bodyAngle) * speed * deltaSeconds);
    }

    if (player.input.fire) {
      fire(player);
    }

    if (updateFlags(player)) {
      emitSnapshot();
      return;
    }
  }

  updateProjectiles(TICK_MS / 1000);
  emitSnapshot();
}

function updateBotInput(bot: PlayerState) {
  if (bot.observer || bot.health <= 0) {
    bot.input = { ...bot.input, up: false, down: false, left: false, right: false, fire: false };
    return;
  }

  const movementTarget = getBotMovementTarget(bot);
  const combatTarget = pickBotCombatTarget(bot);
  if (!movementTarget && !combatTarget) {
    bot.input = { ...bot.input, up: false, down: false, left: false, right: false, fire: false, aimX: bot.x + Math.cos(bot.bodyAngle) * 120, aimY: bot.y + Math.sin(bot.bodyAngle) * 120 };
    return;
  }

  const desiredMoveTarget = movementTarget ?? (combatTarget ? { x: combatTarget.x, y: combatTarget.y, preferredDistance: 140 } : undefined);
  const moveTarget = desiredMoveTarget ? getNavigableTarget(bot, desiredMoveTarget) : { x: bot.x, y: bot.y };
  const moveTargetX = moveTarget.x;
  const moveTargetY = moveTarget.y;
  const aimX = combatTarget?.x ?? moveTargetX;
  const aimY = combatTarget?.y ?? moveTargetY;
  const targetAngle = Math.atan2(moveTargetY - bot.y, moveTargetX - bot.x);
  const distanceToTarget = distance(bot.x, bot.y, moveTargetX, moveTargetY);
  const hullDelta = wrapAngle(targetAngle - bot.bodyAngle);
  const turretDelta = wrapAngle(Math.atan2(aimY - bot.y, aimX - bot.x) - bot.turretAngle);

  const forwardProbeDistance = Math.max(28, Math.min(90, distanceToTarget * 0.35));
  const frontBlocked = isBlockedAhead(bot, bot.bodyAngle, forwardProbeDistance);
  const blockedByPlayers = isBlockedByPlayersAhead(bot, bot.bodyAngle, 56);
  const leftClearance = sampleClearance(bot, bot.bodyAngle - Math.PI / 3, 120);
  const rightClearance = sampleClearance(bot, bot.bodyAngle + Math.PI / 3, 120);
  const steerToRight = rightClearance > leftClearance;

  let turnDirection = 0;
  if (frontBlocked) {
    turnDirection = steerToRight ? 1 : -1;
  } else if (hullDelta > 0.1) {
    turnDirection = 1;
  } else if (hullDelta < -0.1) {
    turnDirection = -1;
  }

  const teammateAvoidance = getTeammateAvoidanceTurn(bot);
  if (blockedByPlayers && teammateAvoidance !== 0) {
    turnDirection = teammateAvoidance;
  }

  const botIndex = Number.parseInt(bot.id.replace('bot-', ''), 10) || 0;
  const reversePulse = blockedByPlayers && Math.sin(Date.now() / 180 + botIndex) > 0.35;
  const desiredStopDistance = desiredMoveTarget?.preferredDistance ?? 140;
  const up = distanceToTarget > desiredStopDistance && !frontBlocked && !blockedByPlayers;
  const down = distanceToTarget < Math.max(26, desiredStopDistance * 0.45) || reversePulse;
  const left = turnDirection < 0;
  const right = turnDirection > 0;
  const combatDistance = combatTarget ? distance(bot.x, bot.y, combatTarget.x, combatTarget.y) : Number.POSITIVE_INFINITY;
  const hasLineOfSight = Boolean(combatTarget) && !isPathBlocked(bot.x, bot.y, combatTarget!.x, combatTarget!.y, BULLET_RADIUS);
  const fire = hasLineOfSight && Math.abs(turretDelta) < 0.2 && combatDistance < 560;

  bot.input = { up, down, left, right, fire, aimX, aimY };
}

function isBlockedByPlayersAhead(bot: PlayerState, heading: number, distanceAhead: number) {
  const fx = Math.cos(heading);
  const fy = Math.sin(heading);
  const botRadius = getTankRadius(bot);

  for (const other of state.players.values()) {
    if (other.id === bot.id || other.observer || other.health <= 0) {
      continue;
    }
    const dx = other.x - bot.x;
    const dy = other.y - bot.y;
    const forwardProjection = dx * fx + dy * fy;
    if (forwardProjection <= 0 || forwardProjection > distanceAhead) {
      continue;
    }
    const lateralDistance = Math.abs(dx * fy - dy * fx);
    const clearance = botRadius + getTankRadius(other) + 4;
    if (lateralDistance < clearance) {
      return true;
    }
  }

  return false;
}

function getTeammateAvoidanceTurn(bot: PlayerState) {
  if (bot.team !== 'red' && bot.team !== 'blue') {
    return 0;
  }

  const fx = Math.cos(bot.bodyAngle);
  const fy = Math.sin(bot.bodyAngle);
  let steerRightScore = 0;
  let steerLeftScore = 0;

  for (const other of state.players.values()) {
    if (other.id === bot.id || other.observer || other.health <= 0 || other.team !== bot.team) {
      continue;
    }
    const dx = other.x - bot.x;
    const dy = other.y - bot.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.01 || dist > 88) {
      continue;
    }
    const forwardProjection = dx * fx + dy * fy;
    if (forwardProjection <= -12) {
      continue;
    }
    const side = fx * dy - fy * dx;
    const weight = 1 / Math.max(10, dist);
    if (side > 0) {
      steerRightScore += weight;
    } else {
      steerLeftScore += weight;
    }
  }

  if (Math.abs(steerRightScore - steerLeftScore) < 0.02) {
    return 0;
  }
  return steerRightScore > steerLeftScore ? 1 : -1;
}

function getBotMovementTarget(bot: PlayerState): BotMovementTarget | undefined {
  if (state.phase === 'running' && state.mode === 'protect-the-king' && (bot.team === 'red' || bot.team === 'blue')) {
    return getProtectKingBotMovementTarget(bot);
  }

  if (state.phase !== 'running' || state.mode !== 'capture-the-flag' || (bot.team !== 'red' && bot.team !== 'blue')) {
    const combatTarget = pickBotTarget(bot);
    if (!combatTarget) {
      return undefined;
    }
    return { x: combatTarget.x, y: combatTarget.y, preferredDistance: 140 };
  }

  const team = bot.team as Exclude<TeamId, 'observer' | 'none'>;
  const ownBase = team === 'red' ? state.map.redBase : state.map.blueBase;
  const ownFlag = team === 'red' ? state.redFlag : state.blueFlag;
  const enemyFlag = team === 'red' ? state.blueFlag : state.redFlag;
  const defender = isDefenderBot(bot);

  if (bot.carryingFlag) {
    return { x: ownBase.x, y: ownBase.y, preferredDistance: 28 };
  }

  if (defender) {
    if (ownFlag.carriedBy) {
      const carrier = state.players.get(ownFlag.carriedBy);
      if (carrier && !carrier.observer && carrier.health > 0) {
        return { x: carrier.x, y: carrier.y, preferredDistance: 80 };
      }
    }
    const intruder = findNearestEnemyNearPoint(bot, ownBase, 320);
    if (intruder) {
      return { x: intruder.x, y: intruder.y, preferredDistance: 80 };
    }
    const patrol = getDefenderPatrolPoint(bot, ownBase);
    return { x: patrol.x, y: patrol.y, preferredDistance: 20 };
  }

  // Highest priority for attackers: retrieve own flag if an enemy stole it.
  if (ownFlag.carriedBy) {
    const thief = state.players.get(ownFlag.carriedBy);
    if (thief && !thief.observer && thief.health > 0) {
      return { x: thief.x, y: thief.y, preferredDistance: 78 };
    }
  }

  if (enemyFlag.carriedBy) {
    if (enemyFlag.carriedBy === bot.id) {
      return { x: ownBase.x, y: ownBase.y, preferredDistance: 28 };
    }
    const allyCarrier = state.players.get(enemyFlag.carriedBy);
    if (allyCarrier && allyCarrier.team === team && allyCarrier.health > 0) {
      return { x: allyCarrier.x, y: allyCarrier.y, preferredDistance: 72 };
    }
  }

  const capturePoint = getAttackerCapturePoint(bot, enemyFlag);
  return { x: capturePoint.x, y: capturePoint.y, preferredDistance: 14 };
}

function getProtectKingBotMovementTarget(bot: PlayerState): BotMovementTarget | undefined {
  const team = bot.team as Exclude<TeamId, 'observer' | 'none'>;
  const enemyTeam: Exclude<TeamId, 'observer' | 'none'> = team === 'red' ? 'blue' : 'red';
  const ownKing = getTeamKing(team);
  const enemyKing = getTeamKing(enemyTeam);
  const defender = isDefenderBot(bot);

  if (bot.isKing) {
    const kingAnchor = team === 'red' ? state.map.redKing : state.map.blueKing;
    const phase = Date.now() / 1000;
    const radius = 46;
    return {
      x: clamp(kingAnchor.x + Math.cos(phase) * radius, PLAYER_RADIUS, state.map.width - PLAYER_RADIUS),
      y: clamp(kingAnchor.y + Math.sin(phase * 0.8) * radius, PLAYER_RADIUS, state.map.height - PLAYER_RADIUS),
      preferredDistance: 18,
    };
  }

  if (defender && ownKing && ownKing.health > 0) {
    const intruder = findNearestEnemyNearPoint(bot, { x: ownKing.x, y: ownKing.y }, 320);
    if (intruder) {
      return { x: intruder.x, y: intruder.y, preferredDistance: 82 };
    }
    const escortPoint = getEscortPointAroundKing(bot, ownKing);
    return { x: escortPoint.x, y: escortPoint.y, preferredDistance: 14 };
  }

  if (enemyKing && enemyKing.health > 0) {
    return { x: enemyKing.x, y: enemyKing.y, preferredDistance: 72 };
  }

  const fallbackCombat = pickBotTarget(bot);
  if (!fallbackCombat) {
    return undefined;
  }
  return { x: fallbackCombat.x, y: fallbackCombat.y, preferredDistance: 120 };
}

function getEscortPointAroundKing(bot: PlayerState, king: PlayerState) {
  const idNumber = Number.parseInt(bot.id.replace('bot-', ''), 10);
  const slot = Number.isFinite(idNumber) ? idNumber : 0;
  const angle = ((slot % 6) / 6) * Math.PI * 2 + Date.now() / 3000;
  const radius = 56;
  return {
    x: clamp(king.x + Math.cos(angle) * radius, PLAYER_RADIUS, state.map.width - PLAYER_RADIUS),
    y: clamp(king.y + Math.sin(angle) * radius, PLAYER_RADIUS, state.map.height - PLAYER_RADIUS),
  };
}

function pickBotCombatTarget(bot: PlayerState) {
  if (state.phase === 'running' && state.mode === 'protect-the-king' && (bot.team === 'red' || bot.team === 'blue')) {
    const enemyTeam: Exclude<TeamId, 'observer' | 'none'> = bot.team === 'red' ? 'blue' : 'red';
    const enemyKing = getTeamKing(enemyTeam);
    if (enemyKing && enemyKing.health > 0) {
      return enemyKing;
    }
  }
  return pickBotTarget(bot);
}

function getAttackerCapturePoint(bot: PlayerState, enemyFlag: FlagState) {
  const idNumber = Number.parseInt(bot.id.replace('bot-', ''), 10);
  const slot = Number.isFinite(idNumber) ? idNumber : 0;
  const angle = ((slot % 6) / 6) * Math.PI * 2;
  const radius = 10;
  return {
    x: clamp(enemyFlag.x + Math.cos(angle) * radius, PLAYER_RADIUS, state.map.width - PLAYER_RADIUS),
    y: clamp(enemyFlag.y + Math.sin(angle) * radius, PLAYER_RADIUS, state.map.height - PLAYER_RADIUS),
  };
}

function getDefenderPatrolPoint(bot: PlayerState, base: Point) {
  const idNumber = Number.parseInt(bot.id.replace('bot-', ''), 10);
  const slot = Number.isFinite(idNumber) ? idNumber : 0;
  const phase = Date.now() / 1000 + slot * 0.9;
  const radius = 70;
  return {
    x: clamp(base.x + Math.cos(phase) * radius, PLAYER_RADIUS, state.map.width - PLAYER_RADIUS),
    y: clamp(base.y + Math.sin(phase * 0.7) * radius, PLAYER_RADIUS, state.map.height - PLAYER_RADIUS),
  };
}

function findNearestEnemyNearPoint(bot: PlayerState, point: Point, maxDistance: number) {
  let nearest: PlayerState | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of state.players.values()) {
    if (candidate.id === bot.id || candidate.observer || candidate.health <= 0) {
      continue;
    }
    if (state.phase === 'running' && bot.team !== 'none' && candidate.team === bot.team) {
      continue;
    }
    const d = distance(point.x, point.y, candidate.x, candidate.y);
    if (d <= maxDistance && d < nearestDistance) {
      nearest = candidate;
      nearestDistance = d;
    }
  }
  return nearest;
}

function getNavigableTarget(bot: PlayerState, target: Point) {
  const radius = getTankRadius(bot);
  if (!isPathBlocked(bot.x, bot.y, target.x, target.y, radius)) {
    return target;
  }

  let bestWaypoint: Point | undefined;
  let bestCost = Number.POSITIVE_INFINITY;
  let bestReachableOnlyWaypoint: Point | undefined;
  let bestReachableOnlyCost = Number.POSITIVE_INFINITY;
  for (const waypoint of getNavigationWaypoints()) {
    if (isPathBlocked(bot.x, bot.y, waypoint.x, waypoint.y, radius)) {
      continue;
    }

    const distanceToTarget = distance(waypoint.x, waypoint.y, target.x, target.y);
    if (distanceToTarget < bestReachableOnlyCost) {
      bestReachableOnlyCost = distanceToTarget;
      bestReachableOnlyWaypoint = waypoint;
    }

    if (isPathBlocked(waypoint.x, waypoint.y, target.x, target.y, radius)) {
      continue;
    }
    const cost = distance(bot.x, bot.y, waypoint.x, waypoint.y) + distance(waypoint.x, waypoint.y, target.x, target.y);
    if (cost < bestCost) {
      bestCost = cost;
      bestWaypoint = waypoint;
    }
  }

  // If no one-hop waypoint reaches target directly, keep advancing to the best
  // reachable waypoint and recompute on subsequent ticks.
  return bestWaypoint ?? bestReachableOnlyWaypoint ?? target;
}

function getNavigationWaypoints() {
  const margin = PLAYER_RADIUS + 8;
  const points: Point[] = [
    { x: state.map.width / 2, y: state.map.height / 2 },
    state.map.redBase,
    state.map.blueBase,
    state.map.redFlag,
    state.map.blueFlag,
  ];

  for (const obstacle of state.map.obstacles) {
    points.push(
      { x: obstacle.x - margin, y: obstacle.y - margin },
      { x: obstacle.x + obstacle.width + margin, y: obstacle.y - margin },
      { x: obstacle.x - margin, y: obstacle.y + obstacle.height + margin },
      { x: obstacle.x + obstacle.width + margin, y: obstacle.y + obstacle.height + margin },
    );
  }

  return points
    .map((point) => ({
      x: clamp(point.x, PLAYER_RADIUS, state.map.width - PLAYER_RADIUS),
      y: clamp(point.y, PLAYER_RADIUS, state.map.height - PLAYER_RADIUS),
    }))
    .filter((point, index, all) => all.findIndex((other) => distance(other.x, other.y, point.x, point.y) < 1) === index);
}

function isPathBlocked(ax: number, ay: number, bx: number, by: number, radius: number) {
  const steps = Math.max(6, Math.ceil(distance(ax, ay, bx, by) / 24));
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    if (collides(x, y, radius)) {
      return true;
    }
  }
  return false;
}

function isDefenderBot(bot: PlayerState) {
  if (bot.team !== 'red' && bot.team !== 'blue') {
    return false;
  }

  const teamBots = Array.from(state.players.values())
    .filter((player) => player.isBot && !player.observer && player.team === bot.team)
    .sort((left, right) => getBotSortKey(left) - getBotSortKey(right));

  if (teamBots.length === 0) {
    return false;
  }

  // Keep approximately 70/30 attacker/defender split per team.
  const defenderCount = Math.floor(teamBots.length * 0.3);
  if (defenderCount <= 0) {
    return false;
  }

  const defenderIds = new Set(teamBots.slice(0, defenderCount).map((player) => player.id));
  return defenderIds.has(bot.id);
}

function getBotSortKey(bot: PlayerState) {
  const idNumber = Number.parseInt(bot.id.replace('bot-', ''), 10);
  if (Number.isFinite(idNumber)) {
    return idNumber;
  }
  return Number.MAX_SAFE_INTEGER;
}

function isBlockedAhead(bot: PlayerState, heading: number, distanceAhead: number) {
  const radius = getTankRadius(bot);
  const probeX = clamp(bot.x + Math.cos(heading) * distanceAhead, radius, state.map.width - radius);
  const probeY = clamp(bot.y + Math.sin(heading) * distanceAhead, radius, state.map.height - radius);
  return collides(probeX, probeY, radius);
}

function sampleClearance(bot: PlayerState, heading: number, maxDistance: number) {
  const radius = getTankRadius(bot);
  const step = 12;
  for (let distanceStep = step; distanceStep <= maxDistance; distanceStep += step) {
    const probeX = clamp(bot.x + Math.cos(heading) * distanceStep, radius, state.map.width - radius);
    const probeY = clamp(bot.y + Math.sin(heading) * distanceStep, radius, state.map.height - radius);
    if (collides(probeX, probeY, radius)) {
      return distanceStep;
    }
  }
  return maxDistance;
}

function pickBotTarget(bot: PlayerState) {
  let nearest: PlayerState | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of state.players.values()) {
    if (candidate.id === bot.id || candidate.observer || candidate.health <= 0) {
      continue;
    }
    const sameTeamDuringRound = state.phase === 'running' && bot.team !== 'none' && candidate.team === bot.team;
    if (sameTeamDuringRound) {
      continue;
    }
    const d = distance(bot.x, bot.y, candidate.x, candidate.y);
    if (d < nearestDistance) {
      nearestDistance = d;
      nearest = candidate;
    }
  }

  return nearest;
}

function movePlayer(player: PlayerState, deltaX: number, deltaY: number) {
  const radius = getTankRadius(player);
  const nextX = clamp(player.x + deltaX, radius, state.map.width - radius);
  if (!collides(nextX, player.y, radius) && !collidesWithOtherPlayers(player, nextX, player.y, radius)) {
    player.x = nextX;
  }
  const nextY = clamp(player.y + deltaY, radius, state.map.height - radius);
  if (!collides(player.x, nextY, radius) && !collidesWithOtherPlayers(player, player.x, nextY, radius)) {
    player.y = nextY;
  }
}

function collidesWithOtherPlayers(player: PlayerState, x: number, y: number, radius: number) {
  for (const other of state.players.values()) {
    if (other.id === player.id || other.observer || other.health <= 0) {
      continue;
    }
    const minDistance = radius + getTankRadius(other);
    if (distance(x, y, other.x, other.y) < minDistance) {
      return true;
    }
  }
  return false;
}

function collides(x: number, y: number, radius: number) {
  return state.map.obstacles.some((obstacle) => circleRectHit(x, y, radius, obstacle.x, obstacle.y, obstacle.width, obstacle.height));
}

function getTankRadius(player: PlayerState) {
  return player.isKing ? PLAYER_RADIUS * KING_RADIUS_MULTIPLIER : PLAYER_RADIUS;
}

function circleRectHit(cx: number, cy: number, radius: number, rx: number, ry: number, rw: number, rh: number) {
  const nearestX = clamp(cx, rx, rx + rw);
  const nearestY = clamp(cy, ry, ry + rh);
  const dx = cx - nearestX;
  const dy = cy - nearestY;
  return dx * dx + dy * dy < radius * radius;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function respawn(player: PlayerState) {
  const spawnTeam = state.phase === 'lobby' ? 'none' : (player.team as ActiveTeam);
  const spawn = findSpawnPosition(spawnTeam, getTankRadius(player));
  player.x = spawn.x;
  player.y = spawn.y;
  player.bodyAngle = player.team === 'blue' ? Math.PI : 0;
  player.turretAngle = player.bodyAngle;
  player.health = player.maxHealth;
  player.respawnAt = 0;
  player.carryingFlag = false;
  player.shieldUntil = Date.now() + RESPAWN_SHIELD_MS;
}

function fire(player: PlayerState) {
  if (player.shootCooldown > 0) {
    return;
  }
  player.shieldUntil = 0;
  const team = player.team as ActiveTeam;
  const id = `${player.id}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const projectile: ProjectileState = {
    id,
    ownerId: player.id,
    x: player.x + Math.cos(player.turretAngle) * 18,
    y: player.y + Math.sin(player.turretAngle) * 18,
    team,
    vx: Math.cos(player.turretAngle) * BULLET_SPEED,
    vy: Math.sin(player.turretAngle) * BULLET_SPEED,
    ttl: 2.2,
  };
  state.projectiles.set(projectile.id, projectile);
  player.shootCooldown = 280;
}

function updateProjectiles(deltaSeconds: number) {
  const next = new Map<string, ProjectileState>();
  for (const projectile of state.projectiles.values()) {
    projectile.x += projectile.vx * deltaSeconds;
    projectile.y += projectile.vy * deltaSeconds;
    projectile.ttl -= deltaSeconds;

    if (projectile.ttl <= 0 || projectile.x < 0 || projectile.y < 0 || projectile.x > state.map.width || projectile.y > state.map.height) {
      continue;
    }
    if (state.map.obstacles.some((obstacle) => circleRectHit(projectile.x, projectile.y, BULLET_RADIUS, obstacle.x, obstacle.y, obstacle.width, obstacle.height))) {
      continue;
    }

    let consumed = false;
    for (const player of state.players.values()) {
      const sameTeamDuringRound = state.phase === 'running' && player.team !== 'none' && player.team === projectile.team;
      if (player.observer || player.id === projectile.ownerId || sameTeamDuringRound || player.health <= 0) {
        continue;
      }
      if (distance(player.x, player.y, projectile.x, projectile.y) < getTankRadius(player) + BULLET_RADIUS) {
        if (Date.now() < player.shieldUntil) {
          consumed = true;
          break;
        }
        player.health -= 25;
        if (player.health <= 0) {
          if (state.mode === 'protect-the-king' && player.isKing) {
            const winnerTeam = projectile.team === 'red' ? 'Red Team' : 'Blue Team';
            finishRound(winnerTeam, `${winnerTeam} destroyed the enemy king.`);
            return;
          }

          player.respawnAt = Date.now() + 2200;
          if (player.carryingFlag) {
            const carriedFlag = player.team === 'red' ? state.blueFlag : state.redFlag;
            resetFlag(carriedFlag, carriedFlag.homeX, carriedFlag.homeY);
            player.carryingFlag = false;
          }
          const owner = state.players.get(projectile.ownerId);
          if (owner) {
            owner.score += 1;
            if (state.phase === 'running' && state.mode === 'deathmatch' && (owner.team === 'red' || owner.team === 'blue')) {
              state.score[owner.team] += 1;
              const target = state.modeSettings.deathmatchTarget;
              if (state.score[owner.team] >= target) {
                const winnerTeam = owner.team === 'red' ? 'Red Team' : 'Blue Team';
                finishRound(winnerTeam, `${winnerTeam} reached ${target} points.`);
                return;
              }
            }
          }
        }
        consumed = true;
        break;
      }
    }

    if (!consumed) {
      next.set(projectile.id, projectile);
    }
  }
  state.projectiles = next;
}

function updateFlags(player: PlayerState) {
  if (state.phase !== 'running' || state.mode !== 'capture-the-flag' || player.observer || player.health <= 0 || player.team === 'none') {
    return false;
  }
  const team = player.team as Exclude<TeamId, 'observer' | 'none'>;
  const enemyFlag: FlagState = team === 'red' ? state.blueFlag : state.redFlag;
  const ownBase = team === 'red' ? state.map.redBase : state.map.blueBase;

  if (!enemyFlag.carriedBy && distance(player.x, player.y, enemyFlag.x, enemyFlag.y) < PLAYER_RADIUS + 8) {
    enemyFlag.carriedBy = player.id;
    player.carryingFlag = true;
    state.message = `${player.name} grabbed the ${team === 'red' ? 'blue' : 'red'} flag.`;
  }

  if (player.carryingFlag && distance(player.x, player.y, ownBase.x, ownBase.y) < 48) {
    player.carryingFlag = false;
    state.score[team] += 1;
    resetFlag(team === 'red' ? state.blueFlag : state.redFlag, team === 'red' ? state.blueFlag.homeX : state.redFlag.homeX, team === 'red' ? state.blueFlag.homeY : state.redFlag.homeY);
    state.message = `${team === 'red' ? 'Red' : 'Blue'} scored a capture.`;
    const ctfTarget = state.modeSettings.ctfTarget;
    if (state.score[team] >= ctfTarget) {
      const winnerTeam = team === 'red' ? 'Red Team' : 'Blue Team';
      finishRound(winnerTeam, `${winnerTeam} captured ${ctfTarget} flags.`);
      return true;
    }
  }

  if (player.carryingFlag) {
    enemyFlag.x = player.x;
    enemyFlag.y = player.y;
  }

  if (!enemyFlag.carriedBy && !player.carryingFlag && distance(enemyFlag.x, enemyFlag.y, enemyFlag.homeX, enemyFlag.homeY) > 0.1) {
    enemyFlag.x = enemyFlag.homeX;
    enemyFlag.y = enemyFlag.homeY;
  }

  return false;
}

function resetFlag(flag: FlagState, homeX: number, homeY: number) {
  flag.carriedBy = null;
  flag.x = homeX;
  flag.y = homeY;
}

function distance(ax: number, ay: number, bx: number, by: number) {
  return Math.hypot(ax - bx, ay - by);
}

function wrapAngle(angle: number) {
  if (angle > Math.PI) {
    return angle - Math.PI * 2;
  }
  if (angle < -Math.PI) {
    return angle + Math.PI * 2;
  }
  return angle;
}

function rotateTowards(current: number, target: number, maxStep: number) {
  const delta = wrapAngle(target - current);
  if (Math.abs(delta) <= maxStep) {
    return target;
  }
  return wrapAngle(current + Math.sign(delta) * maxStep);
}

function resetFlagsAndKings() {
  resetFlag(state.redFlag, state.map.redFlag.x, state.map.redFlag.y);
  resetFlag(state.blueFlag, state.map.blueFlag.x, state.map.blueFlag.y);
  state.score = { red: 0, blue: 0 };
}

function resetRoundState(assignForRound = state.phase === 'running') {
  state.projectiles.clear();
  resetFlagsAndKings();
  state.roundResult = null;
  promoteObservers();
  if (assignForRound) {
    assignTeamsForRound();
  }
  const teamSlots: Record<ActiveTeam, number> = { red: 0, blue: 0, none: 0 };
  for (const player of state.players.values()) {
    player.ready = false;
    player.health = BASE_HEALTH;
    player.maxHealth = BASE_HEALTH;
    player.isKing = false;
    player.score = 0;
    player.carryingFlag = false;
    player.shieldUntil = 0;
    player.respawnAt = 0;
    player.shootCooldown = 0;
    const team = (assignForRound ? player.team : 'none') as ActiveTeam;
    player.team = team;
    const spawn = findSpawnPosition(team, PLAYER_RADIUS, teamSlots[team]);
    teamSlots[team] += 1;
    player.x = spawn.x;
    player.y = spawn.y;
  }

  if (assignForRound && state.mode === 'protect-the-king') {
    assignKingsForProtectMode();
  }
}

function finishRound(winner: string, reason: string) {
  state.phase = 'finished';
  state.countdownEndsAt = null;
  state.message = reason;
  state.projectiles.clear();
  state.roundResult = {
    winner,
    reason,
    mode: state.mode,
    entries: Array.from(state.players.values())
      .filter((player) => !player.observer)
      .map((player) => ({
        id: player.id,
        name: player.name,
        team: player.team,
        score: player.score,
        health: Math.max(0, player.health),
        isKing: player.isKing,
        observer: player.observer,
      }))
      .sort((a, b) => b.score - a.score),
  };
}

function promoteObservers() {
  for (const player of state.players.values()) {
    if (!player.observer) {
      continue;
    }
    player.observer = false;
    player.team = 'none';
    player.health = BASE_HEALTH;
    player.maxHealth = BASE_HEALTH;
    player.isKing = false;
    player.carryingFlag = false;
    player.ready = false;
  }
}

function assignTeamsForRound() {
  const activePlayers = Array.from(state.players.values()).filter((player) => !player.observer);
  shuffleInPlace(activePlayers);
  for (let index = 0; index < activePlayers.length; index += 1) {
    activePlayers[index].team = index % 2 === 0 ? 'red' : 'blue';
  }
}

function shuffleInPlace<T>(values: T[]) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const value = values[index];
    values[index] = values[swapIndex];
    values[swapIndex] = value;
  }
}

function assignKingsForProtectMode() {
  const redPlayers = Array.from(state.players.values()).filter((player) => !player.observer && player.team === 'red');
  const bluePlayers = Array.from(state.players.values()).filter((player) => !player.observer && player.team === 'blue');
  const redKing = pickRandomPlayer(redPlayers);
  const blueKing = pickRandomPlayer(bluePlayers);

  if (redKing) {
    redKing.isKing = true;
    redKing.maxHealth = state.modeSettings.kingHealth;
    redKing.health = state.modeSettings.kingHealth;
  }
  if (blueKing) {
    blueKing.isKing = true;
    blueKing.maxHealth = state.modeSettings.kingHealth;
    blueKing.health = state.modeSettings.kingHealth;
  }

  if (redKing && blueKing) {
    state.message = `Kings selected: ${redKing.name} (Red) and ${blueKing.name} (Blue).`;
  }
}

function pickRandomPlayer(players: PlayerState[]) {
  if (players.length === 0) {
    return undefined;
  }
  return players[Math.floor(Math.random() * players.length)];
}

function getTeamKingHealth(team: Exclude<TeamId, 'observer' | 'none'>) {
  const king = Array.from(state.players.values()).find((player) => !player.observer && player.team === team && player.isKing);
  return king ? Math.max(0, king.health) : 0;
}

function getTeamKing(team: Exclude<TeamId, 'observer' | 'none'>) {
  return Array.from(state.players.values()).find((player) => !player.observer && player.team === team && player.isKing && player.health > 0);
}

const productionClient = path.resolve(process.cwd(), 'dist/client');
if (fs.existsSync(productionClient)) {
  app.use(express.static(productionClient));
  app.get('*', (_request, response) => {
    response.sendFile(path.join(productionClient, 'index.html'));
  });
}

async function configureSocketAdapter() {
  if (!REDIS_URL) {
    return;
  }

  const pubClient = createClient({ url: REDIS_URL });
  const subClient = pubClient.duplicate();
  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));
  console.log(`Socket.IO Redis adapter enabled at ${REDIS_URL}`);
}

async function startServer() {
  try {
    await configureSocketAdapter();
  } catch (error) {
    console.error('Failed to configure Socket.IO adapter.', error);
    process.exit(1);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Tank Arena server listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
