export type GameMode = 'deathmatch' | 'capture-the-flag' | 'protect-the-king';
export type MatchPhase = 'lobby' | 'running' | 'paused' | 'finished';
export type TeamId = 'red' | 'blue' | 'none' | 'observer';

export interface ModeSettings {
  deathmatchTarget: number;
  ctfTarget: number;
  kingHealth: number;
}

export interface RoundResultEntry {
  id: string;
  name: string;
  team: TeamId;
  score: number;
  health: number;
  isKing: boolean;
  observer: boolean;
}

export interface RoundResult {
  winner: string;
  reason: string;
  mode: GameMode;
  entries: RoundResultEntry[];
}

export interface ArenaMap {
  id: string;
  name: string;
  width: number;
  height: number;
  obstacles: Array<{ x: number; y: number; width: number; height: number }>;
  spawns: { red: Array<{ x: number; y: number }>; blue: Array<{ x: number; y: number }> };
  redBase: { x: number; y: number };
  blueBase: { x: number; y: number };
  redFlag: { x: number; y: number };
  blueFlag: { x: number; y: number };
  redKing: { x: number; y: number };
  blueKing: { x: number; y: number };
}

export interface PlayerInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  fire: boolean;
  aimX: number;
  aimY: number;
}

export interface PlayerSnapshot {
  id: string;
  name: string;
  isBot: boolean;
  team: TeamId;
  x: number;
  y: number;
  bodyAngle: number;
  turretAngle: number;
  health: number;
  maxHealth: number;
  score: number;
  ready: boolean;
  observer: boolean;
  admin: boolean;
  carryingFlag: boolean;
  isKing: boolean;
  shielded: boolean;
}

export interface ProjectileSnapshot {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  team: Exclude<TeamId, 'observer'>;
}

export interface GameSnapshot {
  phase: MatchPhase;
  mode: GameMode;
  modeSettings: ModeSettings;
  map: ArenaMap;
  players: PlayerSnapshot[];
  projectiles: ProjectileSnapshot[];
  flagsHome: { red: boolean; blue: boolean };
  kingHealth: { red: number; blue: number };
  score: { red: number; blue: number };
  activePlayers: number;
  connectedClients: number;
  adminId: string | null;
  message: string;
  roundResult: RoundResult | null;
}

export interface LobbySummary {
  id: string;
  name: string;
  phase: MatchPhase;
  mode: GameMode;
  mapName: string;
  players: number;
  bots: number;
}

export interface ClientToServerEvents {
  listLobbies: () => void;
  createLobby: (payload: { name: string; playerName: string }) => void;
  joinLobby: (payload: { lobbyId: string; name: string }) => void;
  leaveLobby: () => void;
  claimAdmin: (payload?: { password?: string }) => void;
  transferAdmin: (payload: { playerId: string }) => void;
  addBot: () => void;
  removeBot: () => void;
  setReady: (ready: boolean) => void;
  setMap: (mapId: string) => void;
  setMode: (mode: GameMode) => void;
  setModeSettings: (settings: ModeSettings) => void;
  startMatch: () => void;
  togglePause: () => void;
  resetLobby: () => void;
  input: (input: PlayerInput) => void;
}

export interface ServerToClientEvents {
  snapshot: (snapshot: GameSnapshot) => void;
  joined: (payload: { observer: boolean; admin: boolean; team: TeamId; lobbyId: string; lobbyName: string }) => void;
  lobbyList: (lobbies: LobbySummary[]) => void;
  message: (text: string) => void;
}
