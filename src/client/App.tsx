import { useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, GameMode, GameSnapshot, ModeSettings, PlayerInput, ServerToClientEvents, TeamId } from '../shared/types';

const MODES: Record<GameMode, string> = {
  deathmatch: 'Team Deathmatch',
  'capture-the-flag': 'Capture the Flag',
  'protect-the-king': 'Protect the King',
};

const TEAM_COLORS: Record<TeamId, string> = {
  red: '#ff6b6b',
  blue: '#66c7ff',
  none: '#d4d9e4',
  observer: '#a8b3c7',
};

const DEFAULT_INPUT: PlayerInput = {
  up: false,
  down: false,
  left: false,
  right: false,
  fire: false,
  aimX: 0,
  aimY: 0,
};

const DEFAULT_MODE_SETTINGS: ModeSettings = {
  deathmatchTarget: 10,
  ctfTarget: 3,
  kingHealth: 500,
};

export default function App() {
  const [socket, setSocket] = useState<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [name, setName] = useState('Tank Pilot');
  const [joined, setJoined] = useState(false);
  const [observer, setObserver] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [adminMode, setAdminMode] = useState<GameMode>('deathmatch');
  const [adminMap, setAdminMap] = useState('cargo-yard');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminSettings, setAdminSettings] = useState<ModeSettings>(DEFAULT_MODE_SETTINGS);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const inputRef = useRef<PlayerInput>({ ...DEFAULT_INPUT });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const nextSocket = io();
    setSocket(nextSocket);

    nextSocket.on('snapshot', (nextSnapshot) => {
      setSnapshot(nextSnapshot);
      if (nextSnapshot.adminId === nextSocket.id) {
        setIsAdmin(true);
      }
    });
    nextSocket.on('joined', (payload) => {
      setJoined(true);
      setObserver(payload.observer);
      setIsAdmin(payload.admin);
    });
    nextSocket.on('message', (text) => setAnnouncement(text));

    return () => {
      nextSocket.close();
    };
  }, []);

  useEffect(() => {
    if (!snapshot || settingsHydrated) {
      return;
    }
    setAdminSettings(snapshot.modeSettings);
    setSettingsHydrated(true);
  }, [snapshot, settingsHydrated]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || !joined || observer) {
        return;
      }
      if (event.code === 'KeyW' || event.code === 'ArrowUp') inputRef.current.up = true;
      if (event.code === 'KeyS' || event.code === 'ArrowDown') inputRef.current.down = true;
      if (event.code === 'KeyA' || event.code === 'ArrowLeft') inputRef.current.left = true;
      if (event.code === 'KeyD' || event.code === 'ArrowRight') inputRef.current.right = true;
      if (event.code === 'Space') inputRef.current.fire = true;
      pushInput();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!joined || observer) {
        return;
      }
      if (event.code === 'KeyW' || event.code === 'ArrowUp') inputRef.current.up = false;
      if (event.code === 'KeyS' || event.code === 'ArrowDown') inputRef.current.down = false;
      if (event.code === 'KeyA' || event.code === 'ArrowLeft') inputRef.current.left = false;
      if (event.code === 'KeyD' || event.code === 'ArrowRight') inputRef.current.right = false;
      if (event.code === 'Space') inputRef.current.fire = false;
      pushInput();
    };

    const onMouseMove = (event: MouseEvent) => updateAim(event.clientX, event.clientY);
    const onMouseDown = () => {
      if (joined && !observer) {
        inputRef.current.fire = true;
        pushInput();
      }
    };
    const onMouseUp = () => {
      if (joined && !observer) {
        inputRef.current.fire = false;
        pushInput();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [joined, observer]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !snapshot) {
      return;
    }
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }
    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw(context, snapshot);
    };

    resize();
    const frame = requestAnimationFrame(resize);
    return () => cancelAnimationFrame(frame);
  }, [snapshot]);

  const sortedPlayers = useMemo(() => {
    return [...(snapshot?.players ?? [])].sort((left, right) => right.score - left.score);
  }, [snapshot]);
  const isLobby = snapshot?.phase === 'lobby';
  const isFinished = snapshot?.phase === 'finished';
  const canPause = snapshot?.phase === 'running' || snapshot?.phase === 'paused';
  const isDeathmatch = snapshot?.mode === 'deathmatch';

  const join = () => socket?.emit('join', { name });
  const claimAdmin = () => socket?.emit('claimAdmin', { password: adminPassword });
  const ready = (value: boolean) => socket?.emit('setReady', value);
  const startMatch = () => socket?.emit('startMatch');
  const togglePause = () => socket?.emit('togglePause');
  const resetLobby = () => socket?.emit('resetLobby');
  const applyModeSettings = () => socket?.emit('setModeSettings', adminSettings);

  const activeTargetLabel = isDeathmatch
    ? `Target ${snapshot?.modeSettings.deathmatchTarget ?? DEFAULT_MODE_SETTINGS.deathmatchTarget}`
    : snapshot?.mode === 'capture-the-flag'
      ? `Target ${snapshot?.modeSettings.ctfTarget ?? DEFAULT_MODE_SETTINGS.ctfTarget}`
      : `King HP ${snapshot?.modeSettings.kingHealth ?? DEFAULT_MODE_SETTINGS.kingHealth}`;

  const roundObjectiveLabel = snapshot?.roundResult
    ? snapshot.roundResult.mode === 'deathmatch'
      ? `Team Deathmatch target: ${snapshot.modeSettings.deathmatchTarget} points`
      : snapshot.roundResult.mode === 'capture-the-flag'
        ? `Capture the Flag target: ${snapshot.modeSettings.ctfTarget} captures`
        : `Protect the King setting: ${snapshot.modeSettings.kingHealth} king HP`
    : '';

  function pushInput() {
    if (!socket || !joined || observer) {
      return;
    }
    socket.emit('input', { ...inputRef.current });
  }

  function updateAim(clientX: number, clientY: number) {
    if (!socket || !canvasRef.current || !snapshot || !joined || observer) {
      return;
    }
    const rect = canvasRef.current.getBoundingClientRect();
    const normalizedX = (clientX - rect.left) / rect.width;
    const normalizedY = (clientY - rect.top) / rect.height;
    inputRef.current.aimX = normalizedX * snapshot.map.width;
    inputRef.current.aimY = normalizedY * snapshot.map.height;
    pushInput();
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Local network tank arena</p>
          <h1>Tank Arena</h1>
        </div>
        <div className="statusPill">{snapshot ? snapshot.phase : 'connecting'}</div>
      </header>

      {announcement ? <div className="announcement">{announcement}</div> : null}

      <main className="layout">
        <section className="panel gamePanel">
          <div className="panelHeader">
            <div>
              <h2>{snapshot?.map.name ?? 'Arena'}</h2>
              <p>{snapshot ? MODES[snapshot.mode] : 'Waiting for the server...'}</p>
            </div>
            <div className="controlsRow wrap">
              <button type="button" onClick={() => ready(true)} disabled={!joined || observer}>
                Ready
              </button>
              <button type="button" onClick={() => ready(false)} disabled={!joined || observer}>
                Unready
              </button>
            </div>
          </div>

          <canvas ref={canvasRef} className="arenaCanvas" width={960} height={640} />

          {isFinished && snapshot?.roundResult ? (
            <div className="roundResultOverlay">
              <div className="roundResultCard">
                <h3>Round Over</h3>
                <p className="resultWinner">Winner: {snapshot.roundResult.winner}</p>
                <p className="resultReason">{snapshot.roundResult.reason}</p>
                <p className="resultReason">{roundObjectiveLabel}</p>
                <ul className="resultList">
                  {snapshot.roundResult.entries.map((entry, index) => (
                    <li key={entry.id}>
                      <span>{index + 1}. {entry.name}</span>
                      <span>{entry.team}{entry.isKing ? ' KING' : ''}</span>
                      <span>{entry.score} pts</span>
                    </li>
                  ))}
                </ul>
                <p className="resultHint">Admin: click Stop to lobby, then Start for the next round.</p>
              </div>
            </div>
          ) : null}

          {!joined ? (
            <div className="joinBox">
              <label className="field">
                <span>Call sign</span>
                <input value={name} onChange={(event) => setName(event.target.value)} maxLength={20} />
              </label>
              <button type="button" onClick={join}>Join lobby</button>
            </div>
          ) : null}

          <div className="hintRow">
            <span>W/S move forward and backward</span>
            <span>A/D turn hull, mouse steers turret</span>
            <span>Space or mouse to shoot</span>
            <span>{observer ? 'Observer mode' : 'Playing'}{isAdmin ? ' · admin' : ''}</span>
          </div>
        </section>

        <aside className="sidebar">
          <section className="panel">
            <h2>Lobby</h2>
            <div className="statsGrid">
              <div><span>Players</span><strong>{snapshot?.activePlayers ?? 0}</strong></div>
              <div><span>Clients</span><strong>{snapshot?.connectedClients ?? 0}</strong></div>
              <div><span>Red</span><strong>{snapshot?.score.red ?? 0}</strong></div>
              <div><span>Blue</span><strong>{snapshot?.score.blue ?? 0}</strong></div>
              <div><span>Objective</span><strong>{activeTargetLabel}</strong></div>
            </div>
            <ul className="playerList">
              {sortedPlayers.map((player) => (
                <li key={player.id}>
                  <span className="dot" style={{ background: TEAM_COLORS[player.team] }} />
                  <span>{player.name}</span>
                  <span>{player.observer ? 'observer' : player.team === 'none' ? 'unassigned' : player.isKing ? 'KING' : isDeathmatch ? `${player.score} frags` : player.ready ? 'ready' : 'waiting'}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel adminPanel">
            <div className="panelHeader compact">
              <h2>Admin Console</h2>
              <button type="button" onClick={claimAdmin}>Claim admin</button>
            </div>
            <label className="field">
              <span>Admin password</span>
              <input
                type="password"
                value={adminPassword}
                onChange={(event) => setAdminPassword(event.target.value)}
                placeholder="Required when ADMIN_PASSWORD is set"
              />
            </label>
            <label className="field">
              <span>Game type</span>
              <select value={adminMode} onChange={(event) => setAdminMode(event.target.value as GameMode)}>
                <option value="deathmatch">Team Deathmatch</option>
                <option value="capture-the-flag">Capture the Flag</option>
                <option value="protect-the-king">Protect the King</option>
              </select>
            </label>
            <label className="field">
              <span>Map</span>
              <select value={adminMap} onChange={(event) => setAdminMap(event.target.value)}>
                <option value="cargo-yard">Cargo Yard</option>
                <option value="iron-pass">Iron Pass</option>
              </select>
            </label>
            <label className="field">
              <span>Team Deathmatch target points</span>
              <input
                type="number"
                min={1}
                max={200}
                step={1}
                value={adminSettings.deathmatchTarget}
                onChange={(event) => {
                  const next = Number.parseInt(event.target.value, 10);
                  setAdminSettings((current) => ({
                    ...current,
                    deathmatchTarget: Number.isFinite(next) ? next : current.deathmatchTarget,
                  }));
                }}
              />
            </label>
            <label className="field">
              <span>Capture the Flag target captures</span>
              <input
                type="number"
                min={1}
                max={20}
                step={1}
                value={adminSettings.ctfTarget}
                onChange={(event) => {
                  const next = Number.parseInt(event.target.value, 10);
                  setAdminSettings((current) => ({
                    ...current,
                    ctfTarget: Number.isFinite(next) ? next : current.ctfTarget,
                  }));
                }}
              />
            </label>
            <label className="field">
              <span>Protect the King king health</span>
              <input
                type="number"
                min={100}
                max={5000}
                step={10}
                value={adminSettings.kingHealth}
                onChange={(event) => {
                  const next = Number.parseInt(event.target.value, 10);
                  setAdminSettings((current) => ({
                    ...current,
                    kingHealth: Number.isFinite(next) ? next : current.kingHealth,
                  }));
                }}
              />
            </label>
            <div className="controlsRow wrap">
              <button type="button" onClick={() => socket?.emit('setMode', adminMode)} disabled={!isAdmin || !isLobby}>Apply mode</button>
              <button type="button" onClick={() => socket?.emit('setMap', adminMap)} disabled={!isAdmin || !isLobby}>Apply map</button>
              <button type="button" onClick={applyModeSettings} disabled={!isAdmin || !isLobby}>Apply settings</button>
              <button type="button" onClick={startMatch} disabled={!isAdmin || !isLobby}>Start</button>
              <button type="button" onClick={togglePause} disabled={!isAdmin || !canPause}>{snapshot?.phase === 'paused' ? 'Resume' : 'Pause'}</button>
              <button type="button" onClick={resetLobby} disabled={!isAdmin}>Stop to lobby</button>
            </div>
            <p className="adminTip">To change map or game type during a match: click Stop to lobby, apply mode/map, then Start.</p>
          </section>
        </aside>
      </main>
    </div>
  );
}

function draw(context: CanvasRenderingContext2D, snapshot: GameSnapshot) {
  const width = context.canvas.clientWidth;
  const height = context.canvas.clientHeight;
  const scale = Math.min(width / snapshot.map.width, height / snapshot.map.height);

  context.clearRect(0, 0, width, height);
  context.save();
  context.scale(scale, scale);

  context.fillStyle = '#111827';
  context.fillRect(0, 0, snapshot.map.width, snapshot.map.height);

  context.fillStyle = '#0f172a';
  context.fillRect(0, 0, snapshot.map.width, snapshot.map.height);

  for (let x = 0; x < snapshot.map.width; x += 40) {
    context.fillStyle = 'rgba(255,255,255,0.03)';
    context.fillRect(x, 0, 1, snapshot.map.height);
  }
  for (let y = 0; y < snapshot.map.height; y += 40) {
    context.fillStyle = 'rgba(255,255,255,0.03)';
    context.fillRect(0, y, snapshot.map.width, 1);
  }

  for (const obstacle of snapshot.map.obstacles) {
    context.fillStyle = '#243447';
    context.fillRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
  }

  if (snapshot.mode === 'capture-the-flag') {
    drawMarker(context, snapshot.map.redBase.x, snapshot.map.redBase.y, '#ff6b6b', 'R');
    drawMarker(context, snapshot.map.blueBase.x, snapshot.map.blueBase.y, '#66c7ff', 'B');
    drawFlag(context, snapshot.map.redFlag.x, snapshot.map.redFlag.y, '#ff6b6b', snapshot.flagsHome.red);
    drawFlag(context, snapshot.map.blueFlag.x, snapshot.map.blueFlag.y, '#66c7ff', snapshot.flagsHome.blue);
  }

  for (const projectile of snapshot.projectiles) {
    context.fillStyle = projectile.team === 'red' ? '#ff9b9b' : projectile.team === 'blue' ? '#a7e3ff' : '#f5f7fb';
    context.beginPath();
    context.arc(projectile.x, projectile.y, 4, 0, Math.PI * 2);
    context.fill();
  }

  for (const player of snapshot.players) {
    const bodyScale = player.isKing ? 1.2 : 1;
    const bodyHalfWidth = 14 * bodyScale;
    const bodyHalfHeight = 10 * bodyScale;
    context.save();
    context.translate(player.x, player.y);
    context.rotate(player.bodyAngle);
    context.fillStyle = player.observer ? '#64748b' : TEAM_COLORS[player.team];
    context.beginPath();
    context.rect(-bodyHalfWidth, -bodyHalfHeight, bodyHalfWidth * 2, bodyHalfHeight * 2);
    context.fill();
    context.fillStyle = 'rgba(0, 0, 0, 0.25)';
    context.fillRect(-8 * bodyScale, (-14) * bodyScale, 16 * bodyScale, 4 * bodyScale);
    context.fillRect(-8 * bodyScale, 10 * bodyScale, 16 * bodyScale, 4 * bodyScale);
    context.restore();

    context.save();
    context.translate(player.x, player.y);
    context.rotate(player.turretAngle);
    context.fillStyle = '#e2e8f0';
    context.fillRect(-5 * bodyScale, -5 * bodyScale, 10 * bodyScale, 10 * bodyScale);
    context.fillRect(0, -3 * bodyScale, 20 * bodyScale, 6 * bodyScale);
    context.restore();

    context.fillStyle = '#e2e8f0';
    context.font = '12px sans-serif';
    context.fillText(player.name, player.x - 18, player.y - 18);

    if (player.carryingFlag) {
      context.fillStyle = '#f8fafc';
      context.font = 'bold 11px sans-serif';
      context.fillText('FLAG', player.x - 15, player.y - 30);
      context.strokeStyle = '#f8fafc';
      context.beginPath();
      context.moveTo(player.x + 12, player.y - 33);
      context.lineTo(player.x + 20, player.y - 28);
      context.lineTo(player.x + 12, player.y - 23);
      context.closePath();
      context.stroke();
    }

    if (player.isKing) {
      context.fillStyle = '#ffd166';
      context.font = 'bold 12px sans-serif';
      context.fillText('KING', player.x - 15, player.y - 42);
      context.strokeStyle = '#ffd166';
      context.beginPath();
      context.arc(player.x, player.y, 18 * bodyScale, 0, Math.PI * 2);
      context.stroke();
    }

    context.fillStyle = '#0f172a';
    context.fillRect(player.x - 16, player.y - 12, 32, 4);
    context.fillStyle = player.health > 50 ? '#22c55e' : '#f97316';
    context.fillRect(player.x - 16, player.y - 12, (32 * player.health) / player.maxHealth, 4);
  }

  context.restore();
}

function drawMarker(context: CanvasRenderingContext2D, x: number, y: number, color: string, label: string) {
  context.fillStyle = color;
  context.beginPath();
  context.arc(x, y, 16, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#0f172a';
  context.font = 'bold 14px sans-serif';
  context.textAlign = 'center';
  context.fillText(label, x, y + 5);
}

function drawFlag(context: CanvasRenderingContext2D, x: number, y: number, color: string, home: boolean) {
  context.fillStyle = home ? color : '#f8fafc';
  context.fillRect(x - 5, y - 16, 4, 32);
  context.beginPath();
  context.moveTo(x - 1, y - 14);
  context.lineTo(x + 18, y - 6);
  context.lineTo(x - 1, y + 2);
  context.closePath();
  context.fill();
}

