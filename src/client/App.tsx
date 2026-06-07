import { useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, GameMode, GameSnapshot, LobbySummary, ModeSettings, PlayerInput, ServerToClientEvents, TeamId } from '../shared/types';

const MODES: Record<GameMode, string> = {
  deathmatch: 'Team Deathmatch',
  'capture-the-flag': 'Capture the Flag',
  'protect-the-king': 'Protect the King',
  'control-points': 'Control Points',
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
  controlPointsReinforcements: 300,
};

type AppEnv = {
  VITE_SUPPORT_URL?: string;
  VITE_BUYMEACOFFEE_URL?: string;
  VITE_STRIPE_DONATE_URL?: string;
  VITE_FEEDBACK_URL?: string;
  VITE_BUG_REPORT_URL?: string;
  VITE_GA_MEASUREMENT_ID?: string;
  VITE_ANALYTICS_SCRIPT_URL?: string;
  VITE_ANALYTICS_ATTR_NAME?: string;
  VITE_ANALYTICS_ATTR_VALUE?: string;
};

type UserReportSeverity = 'low' | 'medium' | 'high';

type UserReportPayload = {
  title: string;
  severity: UserReportSeverity;
  steps: string;
  expected: string;
  generatedAt: string;
  pageUrl: string;
  browser: string;
  language: string;
  timezone: string;
  joined: boolean;
  observer: boolean;
  lobbyId: string | null;
  lobbyName: string | null;
  mode: GameMode | 'none';
  mapId: string | null;
  mapName: string | null;
  phase: string;
  activePlayers: number | null;
  connectedClients: number | null;
  scoreboard: { red: number; blue: number } | null;
};

const appEnv = ((import.meta as { env?: AppEnv }).env ?? {}) as AppEnv;
const BUY_ME_A_COFFEE_URL = (appEnv.VITE_BUYMEACOFFEE_URL?.trim() ?? appEnv.VITE_SUPPORT_URL?.trim() ?? '');
const STRIPE_DONATE_URL = appEnv.VITE_STRIPE_DONATE_URL?.trim() ?? '';
const HAS_SUPPORT_LINKS = Boolean(BUY_ME_A_COFFEE_URL || STRIPE_DONATE_URL);
const FEEDBACK_URL = appEnv.VITE_FEEDBACK_URL?.trim() ?? '';
const BUG_REPORT_URL = appEnv.VITE_BUG_REPORT_URL?.trim() ?? '';
const GA_MEASUREMENT_ID = appEnv.VITE_GA_MEASUREMENT_ID?.trim() ?? '';
const ANALYTICS_SCRIPT_URL = appEnv.VITE_ANALYTICS_SCRIPT_URL?.trim() ?? '';
const ANALYTICS_ATTR_NAME = appEnv.VITE_ANALYTICS_ATTR_NAME?.trim() ?? '';
const ANALYTICS_ATTR_VALUE = appEnv.VITE_ANALYTICS_ATTR_VALUE?.trim() ?? '';
const UI_SNAPSHOT_INTERVAL_MS = 100;
const HAS_TOPBAR_ACTIONS = Boolean(HAS_SUPPORT_LINKS || FEEDBACK_URL || BUG_REPORT_URL);

function getOrCreateClientKey() {
  const storageKey = 'tankarena-client-key';
  const existing = window.localStorage.getItem(storageKey)?.trim();
  if (existing) {
    return existing;
  }
  const next = `client-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  window.localStorage.setItem(storageKey, next);
  return next;
}

export default function App() {
  const [socket, setSocket] = useState<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [name, setName] = useState('Tank Pilot');
  const [joined, setJoined] = useState(false);
  const [lobbies, setLobbies] = useState<LobbySummary[]>([]);
  const [selectedLobbyId, setSelectedLobbyId] = useState('');
  const [selectedLobbyPassword, setSelectedLobbyPassword] = useState('');
  const [newLobbyName, setNewLobbyName] = useState('');
  const [newLobbyPassword, setNewLobbyPassword] = useState('');
  const [currentLobby, setCurrentLobby] = useState<{ id: string; name: string } | null>(null);
  const [observer, setObserver] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [adminMode, setAdminMode] = useState<GameMode>('deathmatch');
  const [adminMap, setAdminMap] = useState('cargo-yard');
  const [adminTargetPlayerId, setAdminTargetPlayerId] = useState('');
  const [kickTargetPlayerId, setKickTargetPlayerId] = useState('');
  const [adminSettings, setAdminSettings] = useState<ModeSettings>(DEFAULT_MODE_SETTINGS);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportTitle, setReportTitle] = useState('');
  const [reportSteps, setReportSteps] = useState('');
  const [reportExpected, setReportExpected] = useState('');
  const [reportSeverity, setReportSeverity] = useState<UserReportSeverity>('medium');
  const [reportStatus, setReportStatus] = useState('');
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const clientKeyRef = useRef(getOrCreateClientKey());
  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const snapshotRef = useRef<GameSnapshot | null>(null);
  const latestSnapshotForUiRef = useRef<GameSnapshot | null>(null);
  const lastUiSnapshotPushAtRef = useRef(0);
  const uiSnapshotTimeoutRef = useRef<number | null>(null);
  const joinedRef = useRef(false);
  const observerRef = useRef(false);
  const inputRef = useRef<PlayerInput>({ ...DEFAULT_INPUT });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  useEffect(() => {
    joinedRef.current = joined;
  }, [joined]);

  useEffect(() => {
    observerRef.current = observer;
  }, [observer]);

  useEffect(() => {
    if (GA_MEASUREMENT_ID) {
      const externalScript = document.createElement('script');
      externalScript.async = true;
      externalScript.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_MEASUREMENT_ID)}`;

      const inlineScript = document.createElement('script');
      inlineScript.textContent = `
        window.dataLayer = window.dataLayer || [];
        function gtag(){window.dataLayer.push(arguments);}
        gtag('js', new Date());
        gtag('config', ${JSON.stringify(GA_MEASUREMENT_ID)});
      `;

      document.head.appendChild(externalScript);
      document.head.appendChild(inlineScript);

      return () => {
        externalScript.remove();
        inlineScript.remove();
      };
    }

    if (!ANALYTICS_SCRIPT_URL) {
      return;
    }

    const script = document.createElement('script');
    script.async = true;
    script.defer = true;
    script.src = ANALYTICS_SCRIPT_URL;
    if (ANALYTICS_ATTR_NAME && ANALYTICS_ATTR_VALUE) {
      script.setAttribute(ANALYTICS_ATTR_NAME, ANALYTICS_ATTR_VALUE);
    }
    document.head.appendChild(script);

    return () => {
      script.remove();
    };
  }, []);

  useEffect(() => {
    const nextSocket = io();
    setSocket(nextSocket);
    nextSocket.emit('listLobbies');

    const resetToLobbyBrowser = () => {
      setJoined(false);
      setObserver(false);
      setIsAdmin(false);
      setCurrentLobby(null);
      snapshotRef.current = null;
      latestSnapshotForUiRef.current = null;
      setSnapshot(null);
      nextSocket.emit('listLobbies');
    };

    nextSocket.on('snapshot', (nextSnapshot) => {
      snapshotRef.current = nextSnapshot;
      latestSnapshotForUiRef.current = nextSnapshot;

      const now = Date.now();
      const elapsed = now - lastUiSnapshotPushAtRef.current;
      if (elapsed >= UI_SNAPSHOT_INTERVAL_MS) {
        lastUiSnapshotPushAtRef.current = now;
        setSnapshot(nextSnapshot);
      } else if (uiSnapshotTimeoutRef.current === null) {
        const wait = UI_SNAPSHOT_INTERVAL_MS - elapsed;
        uiSnapshotTimeoutRef.current = window.setTimeout(() => {
          uiSnapshotTimeoutRef.current = null;
          lastUiSnapshotPushAtRef.current = Date.now();
          setSnapshot(latestSnapshotForUiRef.current);
        }, wait);
      }

      setIsAdmin(nextSnapshot.adminId === nextSocket.id);
    });
    nextSocket.on('lobbyList', (nextLobbies: LobbySummary[]) => {
      setLobbies(nextLobbies);
      setSelectedLobbyId((current) => {
        if (current && nextLobbies.some((lobby) => lobby.id === current)) {
          return current;
        }
        return nextLobbies[0]?.id ?? '';
      });
    });
    nextSocket.on('joined', (payload) => {
      setJoined(true);
      setObserver(payload.observer);
      setIsAdmin(payload.admin);
      setCurrentLobby({ id: payload.lobbyId, name: payload.lobbyName });
      setSelectedLobbyId(payload.lobbyId);
    });
    nextSocket.on('message', (text) => setAnnouncement(text));
    nextSocket.on('kicked', () => {
      resetToLobbyBrowser();
    });

    return () => {
      if (uiSnapshotTimeoutRef.current !== null) {
        window.clearTimeout(uiSnapshotTimeoutRef.current);
        uiSnapshotTimeoutRef.current = null;
      }
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
      if (event.repeat || !joinedRef.current || observerRef.current) {
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
      if (!joinedRef.current || observerRef.current) {
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
    const onMouseDown = (event: MouseEvent) => {
      if (joinedRef.current && !observerRef.current) {
        updateAim(event.clientX, event.clientY);
        inputRef.current.fire = true;
        pushInput();
      }
    };
    const onMouseUp = () => {
      if (joinedRef.current && !observerRef.current) {
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
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!joined || !canvas) {
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
    };

    let frameId = 0;
    const render = () => {
      const currentSnapshot = snapshotRef.current;
      if (currentSnapshot) {
        draw(context, currentSnapshot);
      } else {
        context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      }
      frameId = window.requestAnimationFrame(render);
    };

    resize();
    render();
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      window.cancelAnimationFrame(frameId);
    };
  }, [joined]);

  const sortedPlayers = useMemo(() => {
    return [...(snapshot?.players ?? [])].sort((left, right) => right.score - left.score);
  }, [snapshot]);
  const isLobby = snapshot?.phase === 'lobby';
  const isCountdown = snapshot?.phase === 'countdown';
  const isFinished = snapshot?.phase === 'finished';
  const canPause = snapshot?.phase === 'running' || snapshot?.phase === 'paused';
  const isDeathmatch = snapshot?.mode === 'deathmatch';
  const transferablePlayers = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return snapshot.players.filter((player) => !player.isBot && player.id !== snapshot.adminId);
  }, [snapshot]);
  const kickablePlayers = useMemo(() => {
    if (!snapshot || !socket) {
      return [];
    }
    return snapshot.players.filter((player) => !player.isBot && player.id !== socket.id);
  }, [snapshot, socket]);

  useEffect(() => {
    if (transferablePlayers.length === 0) {
      setAdminTargetPlayerId('');
      return;
    }
    setAdminTargetPlayerId((current) => {
      if (current && transferablePlayers.some((player) => player.id === current)) {
        return current;
      }
      return transferablePlayers[0].id;
    });
  }, [transferablePlayers]);

  useEffect(() => {
    if (kickablePlayers.length === 0) {
      setKickTargetPlayerId('');
      return;
    }
    setKickTargetPlayerId((current) => {
      if (current && kickablePlayers.some((player) => player.id === current)) {
        return current;
      }
      return kickablePlayers[0].id;
    });
  }, [kickablePlayers]);

  const join = () => {
    if (!selectedLobbyId) {
      return;
    }
    socket?.emit('joinLobby', { lobbyId: selectedLobbyId, name, password: selectedLobbyPassword, clientKey: clientKeyRef.current });
  };
  const createLobby = () => {
    socket?.emit('createLobby', { name: newLobbyName, playerName: name, password: newLobbyPassword, clientKey: clientKeyRef.current });
    setNewLobbyName('');
    setNewLobbyPassword('');
  };
  const leaveLobby = () => {
    socket?.emit('leaveLobby');
    setJoined(false);
    setObserver(false);
    setIsAdmin(false);
    setCurrentLobby(null);
    setSnapshot(null);
    socket?.emit('listLobbies');
  };
  const ready = (value: boolean) => socket?.emit('setReady', value);
  const startMatch = () => socket?.emit('startMatch');
  const togglePause = () => socket?.emit('togglePause');
  const resetLobby = () => socket?.emit('resetLobby');
  const applyModeSettings = () => socket?.emit('setModeSettings', adminSettings);

  const activeTargetLabel = isDeathmatch
    ? `Target ${snapshot?.modeSettings.deathmatchTarget ?? DEFAULT_MODE_SETTINGS.deathmatchTarget}`
    : snapshot?.mode === 'capture-the-flag'
      ? `Target ${snapshot?.modeSettings.ctfTarget ?? DEFAULT_MODE_SETTINGS.ctfTarget}`
      : snapshot?.mode === 'protect-the-king'
        ? `King HP ${snapshot?.modeSettings.kingHealth ?? DEFAULT_MODE_SETTINGS.kingHealth}`
        : `Reinforcements ${Math.ceil(snapshot?.score.red ?? 0)}-${Math.ceil(snapshot?.score.blue ?? 0)}`;

  const formatTeamScore = (value: number) => (snapshot?.mode === 'control-points' ? Math.ceil(value) : value);

  const roundObjectiveLabel = snapshot?.roundResult
    ? snapshot.roundResult.mode === 'deathmatch'
      ? `Team Deathmatch target: ${snapshot.modeSettings.deathmatchTarget} points`
      : snapshot.roundResult.mode === 'capture-the-flag'
        ? `Capture the Flag target: ${snapshot.modeSettings.ctfTarget} captures`
        : snapshot.roundResult.mode === 'protect-the-king'
          ? `Protect the King setting: ${snapshot.modeSettings.kingHealth} king HP`
          : `Control Points reinforcements: ${snapshot.modeSettings.controlPointsReinforcements}`
    : '';
  const countdownSeconds = snapshot?.countdownRemainingMs != null
    ? Math.max(1, Math.ceil(snapshot.countdownRemainingMs / 1000))
    : 0;

  function pushInput() {
    if (!socketRef.current || !joinedRef.current || observerRef.current) {
      return;
    }
    socketRef.current.emit('input', { ...inputRef.current });
  }

  function updateAim(clientX: number, clientY: number) {
    if (!socketRef.current || !canvasRef.current || !snapshotRef.current || !joinedRef.current || observerRef.current) {
      return;
    }
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const map = snapshotRef.current.map;
    // Use clientWidth/Height (same as draw()) to avoid CSS border scale mismatch.
    const vw = canvas.clientWidth;
    const vh = canvas.clientHeight;
    const viewport = getMapViewport(map.width, map.height, vw, vh);
    // Compensate for CSS border between getBoundingClientRect origin and inner canvas edge.
    const borderX = (rect.width - vw) / 2;
    const borderY = (rect.height - vh) / 2;
    const localX = clientX - rect.left - borderX - viewport.offsetX;
    const localY = clientY - rect.top - borderY - viewport.offsetY;
    inputRef.current.aimX = clamp(localX / viewport.scale, 0, map.width);
    inputRef.current.aimY = clamp(localY / viewport.scale, 0, map.height);
    pushInput();
  }

  function buildReportPayload(): UserReportPayload {
    return {
      title: reportTitle.trim(),
      severity: reportSeverity,
      steps: reportSteps.trim(),
      expected: reportExpected.trim(),
      generatedAt: new Date().toISOString(),
      pageUrl: window.location.href,
      browser: navigator.userAgent,
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      joined,
      observer,
      lobbyId: currentLobby?.id ?? null,
      lobbyName: currentLobby?.name ?? null,
      mode: snapshot?.mode ?? 'none',
      mapId: snapshot?.map.id ?? null,
      mapName: snapshot?.map.name ?? null,
      phase: snapshot?.phase ?? 'none',
      activePlayers: snapshot?.activePlayers ?? null,
      connectedClients: snapshot?.connectedClients ?? null,
      scoreboard: snapshot ? { red: snapshot.score.red, blue: snapshot.score.blue } : null,
    };
  }

  function toReportMarkdown(payload: UserReportPayload) {
    return [
      '## Summary',
      payload.title || '(no title provided)',
      '',
      '## Severity',
      payload.severity,
      '',
      '## Steps To Reproduce',
      payload.steps || '(not provided)',
      '',
      '## Expected Result',
      payload.expected || '(not provided)',
      '',
      '## Auto-Captured Context',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function buildIssueDraftUrl(payload: UserReportPayload) {
    if (!BUG_REPORT_URL) {
      return '';
    }
    const params = new URLSearchParams();
    params.set('title', `[User Report] ${payload.title || 'Untitled issue'}`);
    params.set('labels', 'bug,user-report');
    params.set('body', toReportMarkdown(payload));
    const separator = BUG_REPORT_URL.includes('?') ? '&' : '?';
    return `${BUG_REPORT_URL}${separator}${params.toString()}`;
  }

  async function copyReportJson() {
    const payload = buildReportPayload();
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setReportStatus('Report JSON copied to clipboard.');
    } catch {
      setReportStatus('Could not access clipboard.');
    }
  }

  async function submitReportDirectly() {
    if (!reportTitle.trim() || !reportSteps.trim()) {
      setReportStatus('Please fill at least title and steps to reproduce.');
      return;
    }

    const payload = buildReportPayload();
    setReportSubmitting(true);
    setReportStatus('');
    try {
      const response = await fetch('/api/report-bug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({} as { error?: string }));
        setReportStatus(body.error ?? 'Failed to submit report.');
        return;
      }

      const data = await response.json().catch(() => ({} as { issueUrl?: string }));
      if (data.issueUrl) {
        setReportStatus(`Report submitted. Issue created: ${data.issueUrl}`);
      } else {
        setReportStatus('Report submitted successfully.');
      }
      setReportTitle('');
      setReportSteps('');
      setReportExpected('');
      setReportSeverity('medium');
    } catch {
      setReportStatus('Could not reach report endpoint.');
    } finally {
      setReportSubmitting(false);
    }
  }

  function openIssueDraft() {
    if (!reportTitle.trim() || !reportSteps.trim()) {
      setReportStatus('Please fill at least title and steps to reproduce.');
      return;
    }
    const payload = buildReportPayload();
    const issueUrl = buildIssueDraftUrl(payload);
    if (!issueUrl) {
      setReportStatus('Bug report URL is not configured.');
      return;
    }
    window.open(issueUrl, '_blank', 'noopener,noreferrer');
    setReportStatus('Opened prefilled report draft in a new tab.');
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Tactical Arena Warfare</p>
          <h1>ShellStorm</h1>
        </div>
        {HAS_TOPBAR_ACTIONS ? (
          <div className="topbarSupport" aria-label="Support links">
            <span className="topbarSupportLabel">Support & feedback</span>
            {STRIPE_DONATE_URL ? (
              <a
                className="supportIconLink"
                href={STRIPE_DONATE_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Donate with Stripe"
                title="Donate with Stripe"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M10.7 7.2c1.8 0 2.6.5 3.4 1l1-3.4c-.9-.4-2.3-.8-4.4-.8-3.7 0-6.2 2-6.2 5.3 0 5 7 4.2 7 6.3 0 .8-.7 1-1.8 1-1.8 0-3.3-.7-4.5-1.3L4.2 19c1.3.6 3.5 1.2 5.8 1.2 3.8 0 6.5-1.9 6.5-5.3 0-5.4-7-4.4-7-6.4 0-.8.6-1.3 1.2-1.3Z" />
                </svg>
              </a>
            ) : null}
            {BUY_ME_A_COFFEE_URL ? (
              <a
                className="supportIconLink coffee"
                href={BUY_ME_A_COFFEE_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Support on Buy Me a Coffee"
                title="Support on Buy Me a Coffee"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M5 7h11a1 1 0 0 1 1 1v1h1.5a2.5 2.5 0 0 1 0 5H17v.5A3.5 3.5 0 0 1 13.5 18h-6A3.5 3.5 0 0 1 4 14.5V8a1 1 0 0 1 1-1Zm1 2v5.5c0 .8.7 1.5 1.5 1.5h6c.8 0 1.5-.7 1.5-1.5V9H6Zm11 3h1.5a.5.5 0 0 0 0-1H17v1Z" />
                  <path d="M7 20h8a1 1 0 1 1 0 2H7a1 1 0 1 1 0-2Z" />
                </svg>
              </a>
            ) : null}
            {FEEDBACK_URL ? (
              <a
                className="supportIconLink feedback"
                href={FEEDBACK_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Share feedback"
                title="Share feedback"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7A2.5 2.5 0 0 1 17.5 15H9l-4.7 4.3A.9.9 0 0 1 3 18.7V5.5Zm2-.5a.5.5 0 0 0-.5.5v11.2L8.2 14H17.5a.5.5 0 0 0 .5-.5v-8a.5.5 0 0 0-.5-.5H6Z" />
                  <path d="M8 8h8a1 1 0 1 1 0 2H8a1 1 0 0 1 0-2Zm0 4h5a1 1 0 1 1 0 2H8a1 1 0 0 1 0-2Z" />
                </svg>
              </a>
            ) : null}
            {BUG_REPORT_URL ? (
              <button
                type="button"
                className="supportIconLink report"
                onClick={() => {
                  setReportOpen(true);
                  setReportStatus('');
                }}
                aria-label="Report a bug"
                title="Report a bug"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M12 2a3 3 0 0 1 3 3v1h2a2 2 0 0 1 2 2v1h1a1 1 0 1 1 0 2h-1v2h1a1 1 0 1 1 0 2h-1v1a2 2 0 0 1-2 2h-2.2a4 4 0 0 1-5.6 0H7a2 2 0 0 1-2-2v-1H4a1 1 0 1 1 0-2h1v-2H4a1 1 0 1 1 0-2h1V8a2 2 0 0 1 2-2h2V5a3 3 0 0 1 3-3Zm0 2a1 1 0 0 0-1 1v1h2V5a1 1 0 0 0-1-1Zm-3 4H7v8h10V8H9Zm3 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z" />
                </svg>
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      {reportOpen ? (
        <div className="reportModalBackdrop" role="presentation" onClick={() => setReportOpen(false)}>
          <div className="reportModalCard" role="dialog" aria-modal="true" aria-label="Report a bug" onClick={(event) => event.stopPropagation()}>
            <h2>Report a bug</h2>
            <p className="reportIntro">Send a structured report with auto-captured game and browser context.</p>
            <label className="field">
              <span>Title</span>
              <input value={reportTitle} onChange={(event) => setReportTitle(event.target.value)} maxLength={120} placeholder="Short summary" />
            </label>
            <label className="field">
              <span>Severity</span>
              <select value={reportSeverity} onChange={(event) => setReportSeverity(event.target.value as UserReportSeverity)}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="field">
              <span>Steps to reproduce</span>
              <textarea
                value={reportSteps}
                onChange={(event) => setReportSteps(event.target.value)}
                maxLength={2000}
                rows={5}
                placeholder="1) ... 2) ... 3) ..."
              />
            </label>
            <label className="field">
              <span>Expected result</span>
              <textarea
                value={reportExpected}
                onChange={(event) => setReportExpected(event.target.value)}
                maxLength={1000}
                rows={3}
                placeholder="What should happen instead"
              />
            </label>
            <div className="reportActions">
              <button type="button" onClick={submitReportDirectly} disabled={reportSubmitting}>
                {reportSubmitting ? 'Submitting...' : 'Submit report'}
              </button>
              <button type="button" className="quietButton" onClick={openIssueDraft}>Open issue draft</button>
              <button type="button" className="quietButton" onClick={copyReportJson}>Copy report JSON</button>
              <button type="button" className="quietButton" onClick={() => setReportOpen(false)}>Close</button>
            </div>
            {reportStatus ? <p className="reportStatus">{reportStatus}</p> : null}
          </div>
        </div>
      ) : null}

      {announcement ? <div className="announcement">{announcement}</div> : null}

      {!joined ? <section className="panel lobbyBrowserPanel">
        <div className="panelHeader compact">
          <h2>Lobby Selection</h2>
          <button type="button" onClick={() => socket?.emit('listLobbies')}>Refresh list</button>
        </div>
        <div className="joinBox">
          <label className="field">
            <span>Call sign</span>
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={20} />
          </label>
          <label className="field">
            <span>Choose lobby</span>
            <select value={selectedLobbyId} onChange={(event) => setSelectedLobbyId(event.target.value)}>
              {lobbies.length === 0 ? <option value="">No lobbies available</option> : null}
              {lobbies.map((lobby) => (
                <option key={lobby.id} value={lobby.id}>
                  {lobby.requiresPassword ? 'Private' : 'Public'} · {lobby.name} · {lobby.players} players · {lobby.bots} bots · {MODES[lobby.mode]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Lobby password (if required)</span>
            <input type="password" value={selectedLobbyPassword} onChange={(event) => setSelectedLobbyPassword(event.target.value)} maxLength={48} />
          </label>
          <div className="controlsRow wrap">
            <button type="button" onClick={join} disabled={!selectedLobbyId}>Join selected lobby</button>
          </div>
          <label className="field">
            <span>Create lobby</span>
            <input value={newLobbyName} onChange={(event) => setNewLobbyName(event.target.value)} maxLength={28} placeholder="New lobby name" />
          </label>
          <label className="field">
            <span>Create lobby password (optional)</span>
            <input type="password" value={newLobbyPassword} onChange={(event) => setNewLobbyPassword(event.target.value)} maxLength={48} placeholder="Leave empty for public lobby" />
          </label>
          <button type="button" onClick={createLobby} disabled={!newLobbyName.trim()}>Create lobby</button>
        </div>
      </section> : null}

      {joined ? <main className="layout">
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

          {isCountdown ? (
            <div className="roundResultOverlay">
              <div className="roundResultCard">
                <h3>Round Starting</h3>
                <p className="resultWinner">{countdownSeconds}</p>
              </div>
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
            <div className="panelHeader compact">
              <h2>{currentLobby?.name ?? 'Lobby'}</h2>
              <button type="button" onClick={leaveLobby} disabled={!joined}>Leave</button>
            </div>
            <div className="statsGrid">
              <div><span>Players</span><strong>{snapshot?.activePlayers ?? 0}</strong></div>
              <div><span>Clients</span><strong>{snapshot?.connectedClients ?? 0}</strong></div>
              <div><span>Red</span><strong>{formatTeamScore(snapshot?.score.red ?? 0)}</strong></div>
              <div><span>Blue</span><strong>{formatTeamScore(snapshot?.score.blue ?? 0)}</strong></div>
              <div><span>Objective</span><strong>{activeTargetLabel}</strong></div>
            </div>
            <ul className="playerList">
              {sortedPlayers.map((player) => (
                <li key={player.id}>
                  <span className="dot" style={{ background: TEAM_COLORS[player.team] }} />
                  <span>{player.name}{player.isBot ? ' [BOT]' : ''}</span>
                  <span>{player.observer ? 'observer' : player.team === 'none' ? 'unassigned' : player.isKing ? 'KING' : isDeathmatch ? `${player.score} frags` : player.ready ? 'ready' : 'waiting'}</span>
                </li>
              ))}
            </ul>
          </section>

          {isAdmin ? <section className="panel adminPanel">
            <div className="panelHeader compact">
              <h2>Admin Console</h2>
            </div>
            <label className="field">
              <span>Transfer admin to</span>
              <select value={adminTargetPlayerId} onChange={(event) => setAdminTargetPlayerId(event.target.value)}>
                {transferablePlayers.length === 0 ? <option value="">No eligible players</option> : null}
                {transferablePlayers.map((player) => (
                  <option key={player.id} value={player.id}>{player.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Kick player</span>
              <select value={kickTargetPlayerId} onChange={(event) => setKickTargetPlayerId(event.target.value)}>
                {kickablePlayers.length === 0 ? <option value="">No players to kick</option> : null}
                {kickablePlayers.map((player) => (
                  <option key={player.id} value={player.id}>{player.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Game type</span>
              <select value={adminMode} onChange={(event) => setAdminMode(event.target.value as GameMode)}>
                <option value="deathmatch">Team Deathmatch</option>
                <option value="capture-the-flag">Capture the Flag</option>
                <option value="protect-the-king">Protect the King</option>
                <option value="control-points">Control Points</option>
              </select>
            </label>
            <label className="field">
              <span>Map</span>
              <select value={adminMap} onChange={(event) => setAdminMap(event.target.value)}>
                <option value="cargo-yard">Cargo Yard</option>
                <option value="iron-pass">Iron Pass</option>
                <option value="dune-stronghold">Dune Stronghold</option>
                <option value="frostline">Frostline</option>
                <option value="reactor-ridge">Reactor Ridge</option>
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
            <label className="field">
              <span>Control Points reinforcements</span>
              <input
                type="number"
                min={50}
                max={2000}
                step={10}
                value={adminSettings.controlPointsReinforcements}
                onChange={(event) => {
                  const next = Number.parseInt(event.target.value, 10);
                  setAdminSettings((current) => ({
                    ...current,
                    controlPointsReinforcements: Number.isFinite(next) ? next : current.controlPointsReinforcements,
                  }));
                }}
              />
            </label>
            <div className="controlsRow wrap">
              <button type="button" onClick={() => socket?.emit('setMode', adminMode)} disabled={!isLobby}>Apply mode</button>
              <button type="button" onClick={() => socket?.emit('setMap', adminMap)} disabled={!isLobby}>Apply map</button>
              <button type="button" onClick={applyModeSettings} disabled={!isLobby}>Apply settings</button>
              <button type="button" onClick={() => socket?.emit('transferAdmin', { playerId: adminTargetPlayerId })} disabled={!adminTargetPlayerId}>Pass admin</button>
              <button type="button" onClick={() => socket?.emit('kickPlayer', { playerId: kickTargetPlayerId })} disabled={!kickTargetPlayerId}>Kick player</button>
              <button type="button" onClick={() => socket?.emit('addBot')} disabled={!isLobby}>+ Bot</button>
              <button type="button" onClick={() => socket?.emit('removeBot')} disabled={!isLobby}>- Bot</button>
              <button type="button" onClick={startMatch} disabled={!isLobby}>Start</button>
              <button type="button" onClick={togglePause} disabled={!canPause}>{snapshot?.phase === 'paused' ? 'Resume' : 'Pause'}</button>
              <button type="button" onClick={resetLobby}>Stop to lobby</button>
            </div>
            <p className="adminTip">To change map or game type during a match: click Stop to lobby, apply mode/map, then Start.</p>
          </section> : null}
        </aside>
      </main> : null}
    </div>
  );
}

function draw(context: CanvasRenderingContext2D, snapshot: GameSnapshot) {
  const width = context.canvas.clientWidth;
  const height = context.canvas.clientHeight;
  const viewport = getMapViewport(snapshot.map.width, snapshot.map.height, width, height);

  context.clearRect(0, 0, width, height);
  context.save();
  context.translate(viewport.offsetX, viewport.offsetY);
  context.scale(viewport.scale, viewport.scale);

  context.beginPath();
  context.rect(0, 0, snapshot.map.width, snapshot.map.height);
  context.clip();

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

  if (snapshot.mode === 'control-points') {
    for (const point of snapshot.controlPoints) {
      const ownerColor = point.owner === 'red' ? '#ff6b6b' : point.owner === 'blue' ? '#66c7ff' : '#cbd5e1';
      context.strokeStyle = ownerColor;
      context.lineWidth = 3;
      context.beginPath();
      context.arc(point.x, point.y, 24, 0, Math.PI * 2);
      context.stroke();

      const normalizedProgress = Math.min(1, Math.abs(point.progress) / 100);
      context.fillStyle = ownerColor;
      context.globalAlpha = 0.18 + normalizedProgress * 0.32;
      context.beginPath();
      context.arc(point.x, point.y, 19, 0, Math.PI * 2);
      context.fill();
      context.globalAlpha = 1;

      context.fillStyle = '#f8fafc';
      context.font = 'bold 14px sans-serif';
      context.textAlign = 'center';
      context.fillText(point.label, point.x, point.y + 5);
    }
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

    // Team-colored nose marker to make hull forward direction obvious.
    const noseColor = player.team === 'red' ? '#ffd1d1' : player.team === 'blue' ? '#ccefff' : '#f8fafc';
    context.fillStyle = noseColor;
    context.beginPath();
    context.moveTo(bodyHalfWidth - 2 * bodyScale, 0);
    context.lineTo(bodyHalfWidth - 9 * bodyScale, -4.5 * bodyScale);
    context.lineTo(bodyHalfWidth - 9 * bodyScale, 4.5 * bodyScale);
    context.closePath();
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
    context.textAlign = 'left';
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

    if (player.shielded) {
      context.strokeStyle = 'rgba(125, 211, 252, 0.95)';
      context.lineWidth = 2;
      context.beginPath();
      context.arc(player.x, player.y, 22 * bodyScale, 0, Math.PI * 2);
      context.stroke();
      context.lineWidth = 1;
      context.fillStyle = '#7dd3fc';
      context.font = 'bold 10px sans-serif';
      context.fillText('SHIELD', player.x - 18, player.y - 50);
    }

    context.fillStyle = '#0f172a';
    context.fillRect(player.x - 16, player.y - 12, 32, 4);
    context.fillStyle = player.health > 50 ? '#22c55e' : '#f97316';
    context.fillRect(player.x - 16, player.y - 12, (32 * player.health) / player.maxHealth, 4);
  }

  context.restore();

  // Draw the arena boundary in CSS-pixel space after restore so it renders
  // on top of all game content and tanks can never visually cross it.
  context.strokeStyle = 'rgba(143, 210, 255, 0.75)';
  context.lineWidth = 2;
  context.strokeRect(
    viewport.offsetX + 1,
    viewport.offsetY + 1,
    viewport.pixelWidth - 2,
    viewport.pixelHeight - 2,
  );
}

function getMapViewport(mapWidth: number, mapHeight: number, viewportWidth: number, viewportHeight: number) {
  const scale = Math.min(viewportWidth / mapWidth, viewportHeight / mapHeight);
  const pixelWidth = mapWidth * scale;
  const pixelHeight = mapHeight * scale;
  return {
    scale,
    pixelWidth,
    pixelHeight,
    offsetX: (viewportWidth - pixelWidth) / 2,
    offsetY: (viewportHeight - pixelHeight) / 2,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
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

