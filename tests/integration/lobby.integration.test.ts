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
});
