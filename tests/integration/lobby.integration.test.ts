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
    await onceEvent<LobbySummary[]>(guest, 'lobbyList');

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
});
