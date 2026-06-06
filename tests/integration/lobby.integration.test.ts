import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, LobbySummary, GameSnapshot } from '../../src/shared/types';

type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

type ServerHandle = {
  port: number;
  child: ChildProcess;
  stop: () => Promise<void>;
};

const activeSockets: TestSocket[] = [];
const activeServers: ServerHandle[] = [];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAngle(angle: number) {
  let next = angle;
  while (next > Math.PI) {
    next -= Math.PI * 2;
  }
  while (next < -Math.PI) {
    next += Math.PI * 2;
  }
  return next;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to acquire free port.'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function onceEvent<T = unknown>(socket: TestSocket, event: keyof ServerToClientEvents, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, onEvent as (...args: unknown[]) => void);
      reject(new Error(`Timed out waiting for event: ${String(event)}`));
    }, timeoutMs);

    const onEvent = (payload: T) => {
      clearTimeout(timeout);
      socket.off(event, onEvent as (...args: unknown[]) => void);
      resolve(payload);
    };

    socket.on(event, onEvent as (...args: unknown[]) => void);
  });
}

async function expectNoEvent(socket: TestSocket, event: keyof ServerToClientEvents, waitMs = 800) {
  let seen = false;
  const onEvent = () => {
    seen = true;
  };
  socket.on(event, onEvent as (...args: unknown[]) => void);
  await sleep(waitMs);
  socket.off(event, onEvent as (...args: unknown[]) => void);
  expect(seen).toBe(false);
}

async function connectClient(port: number): Promise<TestSocket> {
  const socket: TestSocket = io(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000,
    forceNew: true,
  });

  activeSockets.push(socket);

  await new Promise<void>((resolve, reject) => {
    const onConnect = () => {
      socket.off('connect_error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      socket.off('connect', onConnect);
      reject(error);
    };
    socket.once('connect', onConnect);
    socket.once('connect_error', onError);
  });

  return socket;
}

async function startServer(extraEnv: Record<string, string> = {}): Promise<ServerHandle> {
  const port = await getFreePort();
  const cliPath = path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  const child = spawn(process.execPath, [cliPath, 'src/server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Server failed to start in time.'));
    }, 15000);

    const onData = (chunk: Buffer) => {
      const output = chunk.toString('utf8');
      if (output.includes('Tank Arena server listening')) {
        clearTimeout(timeout);
        child.stdout?.off('data', onData);
        child.stderr?.off('data', onData);
        resolve();
      }
    };

    const onExit = () => {
      clearTimeout(timeout);
      reject(new Error('Server exited before startup.'));
    };

    child.once('exit', onExit);
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
  });

  const handle: ServerHandle = {
    port,
    child,
    stop: async () => {
      if (child.killed) {
        return;
      }
      child.kill();
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 4000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  };

  activeServers.push(handle);
  return handle;
}

async function waitForLobbyList(socket: TestSocket, predicate: (lobbies: LobbySummary[]) => boolean, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    socket.emit('listLobbies');
    const lobbies = await onceEvent<LobbySummary[]>(socket, 'lobbyList', 1500);
    if (predicate(lobbies)) {
      return lobbies;
    }
  }
  throw new Error('Lobby list condition not met in time.');
}

async function waitForSnapshot(socket: TestSocket, predicate: (snapshot: GameSnapshot) => boolean, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await onceEvent<GameSnapshot>(socket, 'snapshot', 1500);
    if (predicate(snapshot)) {
      return snapshot;
    }
  }
  throw new Error('Snapshot condition not met in time.');
}

async function syncLobbyList(socket: TestSocket) {
  socket.emit('listLobbies');
  return onceEvent<LobbySummary[]>(socket, 'lobbyList', 2500);
}

function createSnapshotTracker(socket: TestSocket) {
  let latest: GameSnapshot | null = null;
  const handler = (snapshot: GameSnapshot) => {
    latest = snapshot;
  };
  socket.on('snapshot', handler);
  return {
    getLatest: () => latest,
    dispose: () => socket.off('snapshot', handler),
  };
}

function getSocketById(sockets: TestSocket[], socketId: string) {
  const found = sockets.find((socket) => socket.id === socketId);
  if (!found) {
    throw new Error(`Socket not found: ${socketId}`);
  }
  return found;
}

async function moveSocketToPoint(socket: TestSocket, tracker: ReturnType<typeof createSnapshotTracker>, target: { x: number; y: number }, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = tracker.getLatest();
    if (!snapshot) {
      await sleep(80);
      continue;
    }
    const player = snapshot.players.find((entry) => entry.id === socket.id);
    if (!player || player.observer) {
      await sleep(80);
      continue;
    }

    const dx = target.x - player.x;
    const dy = target.y - player.y;
    const dist = Math.hypot(dx, dy);
    const desired = Math.atan2(dy, dx);
    const turnDelta = normalizeAngle(desired - player.bodyAngle);

    socket.emit('input', {
      up: dist > 30 && Math.abs(turnDelta) < 0.95,
      down: false,
      left: turnDelta < -0.12,
      right: turnDelta > 0.12,
      fire: false,
      aimX: target.x,
      aimY: target.y,
    });

    if (dist <= 45) {
      socket.emit('input', {
        up: false,
        down: false,
        left: false,
        right: false,
        fire: false,
        aimX: target.x,
        aimY: target.y,
      });
      return;
    }

    await sleep(80);
  }

  throw new Error('Failed to move socket to target point in time.');
}

afterEach(async () => {
  while (activeSockets.length > 0) {
    const socket = activeSockets.pop();
    socket?.disconnect();
  }
  while (activeServers.length > 0) {
    const handle = activeServers.pop();
    if (handle) {
      await handle.stop();
    }
  }
});

describe('Lobby integration', () => {
  it('auto-joins lobby creator as admin and emits initial lobby snapshot', async () => {
    const server = await startServer();
    const creator = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(creator, 'lobbyList');

    creator.emit('createLobby', { name: 'Creator Flow', playerName: 'Creator', clientKey: 'creator-flow' });
    const joined = await onceEvent<{ lobbyId: string; lobbyName: string; admin: boolean; observer: boolean }>(creator, 'joined');
    expect(joined.admin).toBe(true);
    expect(joined.observer).toBe(false);
    expect(joined.lobbyName).toBe('Creator Flow');

    const snapshot = await waitForSnapshot(creator, (next) => next.phase === 'lobby' && next.players.some((player) => player.id === creator.id));
    expect(snapshot.adminId).toBe(creator.id);
    expect(snapshot.players.some((player) => player.id === creator.id)).toBe(true);
    expect(snapshot.map.width).toBeGreaterThan(0);
    expect(snapshot.map.height).toBeGreaterThan(0);
  });

  it('ignores startMatch from non-admin players', async () => {
    const server = await startServer();
    const admin = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(admin, 'lobbyList');

    admin.emit('createLobby', { name: 'Start Guard', playerName: 'Admin', clientKey: 'start-guard-admin' });
    const joined = await onceEvent<{ lobbyId: string }>(admin, 'joined');

    const guest = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(guest, 'lobbyList');
    guest.emit('joinLobby', { lobbyId: joined.lobbyId, name: 'Guest', clientKey: 'start-guard-guest' });
    await onceEvent(guest, 'joined');

    guest.emit('startMatch');
    const snapshot = await waitForSnapshot(admin, (next) => next.players.some((player) => player.id === guest.id));
    expect(snapshot.phase).toBe('lobby');
  });

  it('rejects joins when lobby reaches max players', async () => {
    const server = await startServer({ MAX_PLAYERS_PER_LOBBY: '1' });
    const admin = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(admin, 'lobbyList');

    admin.emit('createLobby', { name: 'Capacity Test', playerName: 'Admin', clientKey: 'capacity-admin' });
    const joined = await onceEvent<{ lobbyId: string }>(admin, 'joined');

    const guest = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(guest, 'lobbyList');
    guest.emit('joinLobby', { lobbyId: joined.lobbyId, name: 'Guest', clientKey: 'capacity-guest' });

    const message = await onceEvent<string>(guest, 'message');
    expect(message.toLowerCase()).toContain('full');
    await expectNoEvent(guest, 'joined');
  });

  it('requires password for private lobbies', async () => {
    const server = await startServer();
    const admin = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(admin, 'lobbyList');

    admin.emit('createLobby', { name: 'Secret Room', playerName: 'Admin', password: '1234', clientKey: 'admin-key' });
    const joined = await onceEvent<{ lobbyId: string }>(admin, 'joined');

    const guest = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(guest, 'lobbyList');

    guest.emit('joinLobby', { lobbyId: joined.lobbyId, name: 'Guest', password: 'wrong', clientKey: 'guest-key' });
    const message = await onceEvent<string>(guest, 'message');
    expect(message.toLowerCase()).toContain('password');
    await expectNoEvent(guest, 'joined');
  });

  it('emits kicked and removes player from lobby snapshot', async () => {
    const server = await startServer();
    const admin = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(admin, 'lobbyList');

    admin.emit('createLobby', { name: 'Kick Test', playerName: 'Admin', clientKey: 'admin-kick' });
    await onceEvent(admin, 'joined');

    const guest = await connectClient(server.port);
    await syncLobbyList(guest);

    const list = await waitForLobbyList(guest, (lobbies) => lobbies.some((lobby) => lobby.name === 'Kick Test'));
    const lobby = list.find((entry) => entry.name === 'Kick Test');
    expect(lobby).toBeTruthy();

    guest.emit('joinLobby', { lobbyId: lobby!.id, name: 'Guest', clientKey: 'guest-kick' });
    await onceEvent(guest, 'joined');

    admin.emit('kickPlayer', { playerId: guest.id! });
    const kicked = await onceEvent<{ reason: string }>(guest, 'kicked');
    expect(kicked.reason).toContain('removed');

    const snapshot = await onceEvent<GameSnapshot>(admin, 'snapshot');
    expect(snapshot.players.some((player) => player.id === guest.id)).toBe(false);
  });

  it('starts match with countdown phase', async () => {
    const server = await startServer();
    const admin = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(admin, 'lobbyList');

    admin.emit('createLobby', { name: 'Countdown Test', playerName: 'Admin', clientKey: 'admin-countdown' });
    await onceEvent(admin, 'joined');

    admin.emit('startMatch');

    const snapshot = await waitForSnapshot(admin, (next) => next.phase === 'countdown' && next.countdownRemainingMs !== null);
    expect(snapshot.phase).toBe('countdown');
    expect(snapshot.countdownRemainingMs).not.toBeNull();
    expect((snapshot.countdownRemainingMs ?? 0) > 0).toBe(true);

    const runningSnapshot = await waitForSnapshot(admin, (next) => next.phase === 'running', 9000);
    expect(runningSnapshot.phase).toBe('running');
    const activePlayers = runningSnapshot.players.filter((player) => !player.observer);
    expect(activePlayers.length).toBeGreaterThan(0);
    expect(activePlayers.every((player) => player.team !== 'none')).toBe(true);
  });

  it('removes empty non-main lobbies after grace period', async () => {
    const server = await startServer({ EMPTY_LOBBY_GRACE_MS: '300' });
    const client = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(client, 'lobbyList');

    client.emit('createLobby', { name: 'Temp Lobby', playerName: 'Owner', clientKey: 'owner-temp' });
    await onceEvent(client, 'joined');

    client.emit('leaveLobby');
    await sleep(900);

    const lobbies = await waitForLobbyList(client, (list) => !list.some((lobby) => lobby.name === 'Temp Lobby'));
    expect(lobbies.some((lobby) => lobby.name === 'Temp Lobby')).toBe(false);
  });

  it('reassigns admin to next joined human when admin leaves', async () => {
    const server = await startServer();
    const admin = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(admin, 'lobbyList');

    admin.emit('createLobby', { name: 'Admin Leave', playerName: 'Admin', clientKey: 'admin-leave' });
    const joined = await onceEvent<{ lobbyId: string }>(admin, 'joined');

    const guestA = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(guestA, 'lobbyList');
    guestA.emit('joinLobby', { lobbyId: joined.lobbyId, name: 'GuestA', clientKey: 'guest-a' });
    await onceEvent(guestA, 'joined');

    const guestB = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(guestB, 'lobbyList');
    guestB.emit('joinLobby', { lobbyId: joined.lobbyId, name: 'GuestB', clientKey: 'guest-b' });
    await onceEvent(guestB, 'joined');

    admin.emit('leaveLobby');

    const snapshot = await waitForSnapshot(guestA, (next) => next.adminId !== admin.id && next.adminId !== null);
    expect(snapshot.adminId).toBe(guestA.id);
  });

  it('enforces transferAdmin permissions and allows valid admin transfer', async () => {
    const server = await startServer();
    const admin = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(admin, 'lobbyList');

    admin.emit('createLobby', { name: 'Transfer Rules', playerName: 'Admin', clientKey: 'admin-transfer' });
    const joined = await onceEvent<{ lobbyId: string }>(admin, 'joined');

    const guest = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(guest, 'lobbyList');
    guest.emit('joinLobby', { lobbyId: joined.lobbyId, name: 'Guest', clientKey: 'guest-transfer' });
    await onceEvent(guest, 'joined');

    guest.emit('transferAdmin', { playerId: guest.id! });
    const unchanged = await waitForSnapshot(admin, (next) => next.players.some((p) => p.id === guest.id));
    expect(unchanged.adminId).toBe(admin.id);

    admin.emit('transferAdmin', { playerId: guest.id! });
    const changed = await waitForSnapshot(guest, (next) => next.adminId === guest.id);
    expect(changed.adminId).toBe(guest.id);
  });

  it('applies kick edge-case rules (no self-kick, no bot-kick, no non-admin kick)', async () => {
    const server = await startServer();
    const admin = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(admin, 'lobbyList');

    admin.emit('createLobby', { name: 'Kick Edge', playerName: 'Admin', clientKey: 'admin-kick-edge' });
    const joined = await onceEvent<{ lobbyId: string }>(admin, 'joined');

    const guest = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(guest, 'lobbyList');
    guest.emit('joinLobby', { lobbyId: joined.lobbyId, name: 'Guest', clientKey: 'guest-kick-edge' });
    await onceEvent(guest, 'joined');

    admin.emit('addBot');
    const withBot = await waitForSnapshot(admin, (next) => next.players.some((p) => p.isBot));
    const bot = withBot.players.find((p) => p.isBot);
    expect(bot).toBeTruthy();

    admin.emit('kickPlayer', { playerId: admin.id! });
    await expectNoEvent(admin, 'kicked');
    const afterSelfKick = await waitForSnapshot(admin, (next) => next.players.some((p) => p.id === admin.id));
    expect(afterSelfKick.players.some((p) => p.id === admin.id)).toBe(true);

    admin.emit('kickPlayer', { playerId: bot!.id });
    const afterBotKickAttempt = await waitForSnapshot(admin, (next) => next.players.some((p) => p.id === bot!.id));
    expect(afterBotKickAttempt.players.some((p) => p.id === bot!.id)).toBe(true);

    guest.emit('kickPlayer', { playerId: admin.id! });
    await expectNoEvent(admin, 'kicked');
    const afterGuestKickAttempt = await waitForSnapshot(admin, (next) => next.players.some((p) => p.id === admin.id));
    expect(afterGuestKickAttempt.players.some((p) => p.id === admin.id)).toBe(true);
  });

  it('ignores pause during countdown and allows resetLobby to return to lobby', async () => {
    const server = await startServer();
    const admin = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(admin, 'lobbyList');

    admin.emit('createLobby', { name: 'Countdown Controls', playerName: 'Admin', clientKey: 'admin-countdown-controls' });
    await onceEvent(admin, 'joined');

    admin.emit('startMatch');
    await waitForSnapshot(admin, (next) => next.phase === 'countdown');

    admin.emit('togglePause');
    const stillCountdown = await waitForSnapshot(admin, (next) => next.phase === 'countdown');
    expect(stillCountdown.phase).toBe('countdown');

    admin.emit('resetLobby');
    const backToLobby = await waitForSnapshot(admin, (next) => next.phase === 'lobby');
    expect(backToLobby.phase).toBe('lobby');
  });

  it('recovers player identity on reconnect within grace and expires after grace', async () => {
    const server = await startServer({ RECONNECT_GRACE_MS: '500' });
    const admin = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(admin, 'lobbyList');

    admin.emit('createLobby', { name: 'Reconnect Test', playerName: 'Admin', clientKey: 'admin-reconnect' });
    const joined = await onceEvent<{ lobbyId: string }>(admin, 'joined');

    let guest = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(guest, 'lobbyList');
    guest.emit('joinLobby', { lobbyId: joined.lobbyId, name: 'OriginalName', clientKey: 'guest-reconnect' });
    await onceEvent(guest, 'joined');

    guest.disconnect();
    guest = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(guest, 'lobbyList');
    guest.emit('joinLobby', { lobbyId: joined.lobbyId, name: 'DifferentName', clientKey: 'guest-reconnect' });
    await onceEvent(guest, 'joined');

    const restored = await waitForSnapshot(admin, (next) => next.players.some((p) => p.name === 'OriginalName'));
    expect(restored.players.some((p) => p.name === 'OriginalName')).toBe(true);

    guest.disconnect();
    await sleep(900);
    guest = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(guest, 'lobbyList');
    guest.emit('joinLobby', { lobbyId: joined.lobbyId, name: 'NewAfterExpiry', clientKey: 'guest-reconnect' });
    await onceEvent(guest, 'joined');

    const expired = await waitForSnapshot(admin, (next) => next.players.some((p) => p.name === 'NewAfterExpiry'));
    expect(expired.players.some((p) => p.name === 'NewAfterExpiry')).toBe(true);
  });

  it('allows joining private lobby with correct password and marks it as protected', async () => {
    const server = await startServer();
    const admin = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(admin, 'lobbyList');

    admin.emit('createLobby', { name: 'Private Success', playerName: 'Admin', password: 'pw-ok', clientKey: 'admin-private-success' });
    const joined = await onceEvent<{ lobbyId: string }>(admin, 'joined');

    const browser = await connectClient(server.port);
    const lobbies = await waitForLobbyList(browser, (list) => list.some((lobby) => lobby.id === joined.lobbyId));
    const lobby = lobbies.find((entry) => entry.id === joined.lobbyId);
    expect(lobby?.requiresPassword).toBe(true);

    const guest = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(guest, 'lobbyList');
    guest.emit('joinLobby', { lobbyId: joined.lobbyId, name: 'Guest', password: 'pw-ok', clientKey: 'guest-private-success' });
    const guestJoined = await onceEvent<{ lobbyId: string }>(guest, 'joined');
    expect(guestJoined.lobbyId).toBe(joined.lobbyId);
  });

  it('cancels empty-lobby cleanup when a player rejoins before grace expires', async () => {
    const server = await startServer({ EMPTY_LOBBY_GRACE_MS: '1000' });
    const owner = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(owner, 'lobbyList');

    owner.emit('createLobby', { name: 'Cancel Cleanup', playerName: 'Owner', clientKey: 'owner-cancel-cleanup' });
    const joined = await onceEvent<{ lobbyId: string }>(owner, 'joined');

    const rejoiner = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(rejoiner, 'lobbyList');

    owner.emit('leaveLobby');
    await sleep(250);
    rejoiner.emit('joinLobby', { lobbyId: joined.lobbyId, name: 'Rejoiner', clientKey: 'rejoiner-cancel-cleanup' });
    await onceEvent(rejoiner, 'joined');

    await sleep(1200);
    const lobbies = await waitForLobbyList(rejoiner, (list) => list.some((lobby) => lobby.id === joined.lobbyId));
    expect(lobbies.some((lobby) => lobby.id === joined.lobbyId)).toBe(true);
  });

  it('isolates lobby state and events across two lobbies', async () => {
    const server = await startServer();

    const adminA = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(adminA, 'lobbyList');
    adminA.emit('createLobby', { name: 'Iso A', playerName: 'AdminA', clientKey: 'admin-iso-a' });
    const joinedA = await onceEvent<{ lobbyId: string }>(adminA, 'joined');

    const adminB = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(adminB, 'lobbyList');
    adminB.emit('createLobby', { name: 'Iso B', playerName: 'AdminB', clientKey: 'admin-iso-b' });
    const joinedB = await onceEvent<{ lobbyId: string }>(adminB, 'joined');

    const guestA = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(guestA, 'lobbyList');
    guestA.emit('joinLobby', { lobbyId: joinedA.lobbyId, name: 'GuestA', clientKey: 'guest-iso-a' });
    await onceEvent(guestA, 'joined');

    const guestB = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(guestB, 'lobbyList');
    guestB.emit('joinLobby', { lobbyId: joinedB.lobbyId, name: 'GuestB', clientKey: 'guest-iso-b' });
    await onceEvent(guestB, 'joined');

    adminA.emit('addBot');

    const snapshotA = await waitForSnapshot(adminA, (next) => next.players.some((p) => p.isBot));
    expect(snapshotA.players.some((p) => p.isBot)).toBe(true);

    const snapshotB = await waitForSnapshot(adminB, (next) => next.players.length >= 2);
    expect(snapshotB.players.some((p) => p.isBot)).toBe(false);
  });

  it('control-points captures a point by staying near it', async () => {
    const server = await startServer();
    const admin = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(admin, 'lobbyList');
    admin.emit('createLobby', { name: 'CP Capture', playerName: 'Admin', clientKey: 'cp-capture-admin' });
    await onceEvent(admin, 'joined');

    const guest = await connectClient(server.port);
    await syncLobbyList(guest);
    const lobbies = await waitForLobbyList(guest, (list) => list.some((lobby) => lobby.name === 'CP Capture'));
    const lobby = lobbies.find((entry) => entry.name === 'CP Capture');
    guest.emit('joinLobby', { lobbyId: lobby!.id, name: 'Guest', clientKey: 'cp-capture-guest' });
    await onceEvent(guest, 'joined');

    const tracker = createSnapshotTracker(admin);
    admin.emit('setMode', 'control-points');
    admin.emit('setModeSettings', { deathmatchTarget: 10, ctfTarget: 3, kingHealth: 500, controlPointsReinforcements: 100 });
    admin.emit('startMatch');

    const running = await waitForSnapshot(admin, (next) => next.phase === 'running', 9000);
    const own = running.players.find((p) => p.id === admin.id)!;
    const targetPoint = [...running.controlPoints].sort((a, b) => {
      const distA = Math.hypot(a.x - own.x, a.y - own.y);
      const distB = Math.hypot(b.x - own.x, b.y - own.y);
      return distA - distB;
    })[0];
    const ownerTeam = own.team === 'red' ? 'red' : 'blue';

    await moveSocketToPoint(admin, tracker, { x: targetPoint.x, y: targetPoint.y });
    const captured = await waitForSnapshot(admin, (next) => next.controlPoints.some((point) => point.id === targetPoint.id && point.owner === ownerTeam), 8000);
    expect(captured.controlPoints.find((point) => point.id === targetPoint.id)?.owner).toBe(ownerTeam);
    tracker.dispose();
  }, 60000);

  it('control-points contested point does not progress meaningfully', async () => {
    const server = await startServer();
    const admin = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(admin, 'lobbyList');
    admin.emit('createLobby', { name: 'CP Contest', playerName: 'Admin', clientKey: 'cp-contest-admin' });
    await onceEvent(admin, 'joined');

    const guest = await connectClient(server.port);
    await syncLobbyList(guest);
    const lobbies = await waitForLobbyList(guest, (list) => list.some((lobby) => lobby.name === 'CP Contest'));
    const lobby = lobbies.find((entry) => entry.name === 'CP Contest');
    guest.emit('joinLobby', { lobbyId: lobby!.id, name: 'Guest', clientKey: 'cp-contest-guest' });
    await onceEvent(guest, 'joined');

    const tracker = createSnapshotTracker(admin);
    admin.emit('setMode', 'control-points');
    admin.emit('setModeSettings', { deathmatchTarget: 10, ctfTarget: 3, kingHealth: 500, controlPointsReinforcements: 100 });
    admin.emit('startMatch');

    const running = await waitForSnapshot(admin, (next) => next.phase === 'running', 9000);
    const center = running.controlPoints[1] ?? running.controlPoints[0];

    await Promise.all([
      moveSocketToPoint(admin, tracker, { x: center.x, y: center.y }),
      moveSocketToPoint(guest, tracker, { x: center.x, y: center.y }),
    ]);

    const before = (tracker.getLatest()?.controlPoints.find((point) => point.id === center.id)?.progress) ?? 0;
    await sleep(1800);
    const after = (tracker.getLatest()?.controlPoints.find((point) => point.id === center.id)?.progress) ?? 0;
    expect(Math.abs(after - before)).toBeLessThan(15);
    tracker.dispose();
  });

  it('control-points bleeds reinforcements for team with fewer points', async () => {
    const server = await startServer();
    const admin = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(admin, 'lobbyList');
    admin.emit('createLobby', { name: 'CP Bleed', playerName: 'Admin', clientKey: 'cp-bleed-admin' });
    await onceEvent(admin, 'joined');

    const clients = [admin];
    for (let index = 0; index < 3; index += 1) {
      const client = await connectClient(server.port);
      await syncLobbyList(client);
      const lobbies = await waitForLobbyList(client, (list) => list.some((lobby) => lobby.name === 'CP Bleed'));
      const lobby = lobbies.find((entry) => entry.name === 'CP Bleed');
      client.emit('joinLobby', { lobbyId: lobby!.id, name: `P${index}`, clientKey: `cp-bleed-${index}` });
      await onceEvent(client, 'joined');
      clients.push(client);
    }

    const tracker = createSnapshotTracker(admin);
    admin.emit('setMode', 'control-points');
    admin.emit('setModeSettings', { deathmatchTarget: 10, ctfTarget: 3, kingHealth: 500, controlPointsReinforcements: 60 });
    admin.emit('startMatch');

    const running = await waitForSnapshot(admin, (next) => next.phase === 'running', 9000);
    const byTeam = {
      red: running.players.filter((p) => !p.observer && p.team === 'red').map((p) => getSocketById(clients, p.id)),
      blue: running.players.filter((p) => !p.observer && p.team === 'blue').map((p) => getSocketById(clients, p.id)),
    };
    const winningTeam = byTeam.red.length >= byTeam.blue.length ? 'red' : 'blue';
    const losingTeam = winningTeam === 'red' ? 'blue' : 'red';
    const winners = winningTeam === 'red' ? byTeam.red : byTeam.blue;

    await moveSocketToPoint(winners[0], tracker, { x: running.controlPoints[0].x, y: running.controlPoints[0].y });
    await moveSocketToPoint(winners[1], tracker, { x: running.controlPoints[2].x, y: running.controlPoints[2].y });

    await waitForSnapshot(admin, (next) => next.controlPoints.filter((p) => p.owner === winningTeam).length >= 2, 12000);
    const before = (tracker.getLatest()?.score[losingTeam]) ?? 0;
    const bled = await waitForSnapshot(admin, (next) => next.score[losingTeam] <= before - 1, 10000);
    expect(bled.score[losingTeam]).toBeLessThan(before - 0.9);
    tracker.dispose();
  }, 60000);

  it('control-points ends round when reinforcements reach zero', async () => {
    const server = await startServer();
    const admin = await connectClient(server.port);
    await onceEvent<LobbySummary[]>(admin, 'lobbyList');
    admin.emit('createLobby', { name: 'CP Finish', playerName: 'Admin', clientKey: 'cp-finish-admin' });
    await onceEvent(admin, 'joined');

    const clients = [admin];
    for (let index = 0; index < 3; index += 1) {
      const client = await connectClient(server.port);
      await syncLobbyList(client);
      const lobbies = await waitForLobbyList(client, (list) => list.some((lobby) => lobby.name === 'CP Finish'));
      const lobby = lobbies.find((entry) => entry.name === 'CP Finish');
      client.emit('joinLobby', { lobbyId: lobby!.id, name: `F${index}`, clientKey: `cp-finish-${index}` });
      await onceEvent(client, 'joined');
      clients.push(client);
    }

    const tracker = createSnapshotTracker(admin);
    admin.emit('setMode', 'control-points');
    admin.emit('setModeSettings', { deathmatchTarget: 10, ctfTarget: 3, kingHealth: 500, controlPointsReinforcements: 50 });
    admin.emit('startMatch');

    const running = await waitForSnapshot(admin, (next) => next.phase === 'running', 9000);
    const byTeam = {
      red: running.players.filter((p) => !p.observer && p.team === 'red').map((p) => getSocketById(clients, p.id)),
      blue: running.players.filter((p) => !p.observer && p.team === 'blue').map((p) => getSocketById(clients, p.id)),
    };
    const winningTeam = byTeam.red.length >= byTeam.blue.length ? 'red' : 'blue';
    const winners = winningTeam === 'red' ? byTeam.red : byTeam.blue;

    await moveSocketToPoint(winners[0], tracker, { x: running.controlPoints[0].x, y: running.controlPoints[0].y });
    await moveSocketToPoint(winners[1], tracker, { x: running.controlPoints[2].x, y: running.controlPoints[2].y });
    await waitForSnapshot(admin, (next) => next.controlPoints.filter((p) => p.owner === winningTeam).length >= 2, 12000);

    const finished = await waitForSnapshot(admin, (next) => next.phase === 'finished' && next.roundResult?.mode === 'control-points', 45000);
    expect(finished.roundResult?.mode).toBe('control-points');
    expect(finished.roundResult?.winner).toBe(winningTeam === 'red' ? 'Red Team' : 'Blue Team');
    tracker.dispose();
  }, 60000);
});
