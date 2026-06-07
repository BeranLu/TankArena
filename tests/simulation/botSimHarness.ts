export type Team = 'red' | 'blue';

export type BotAction = {
  throttle: number;
  turn: number;
  fire: boolean;
  targetId?: string;
};

export type BotSnapshot = {
  id: string;
  team: Team;
  x: number;
  y: number;
  heading: number;
  hp: number;
  alive: boolean;
  cooldown: number;
};

export type ScenarioContext = {
  time: number;
  width: number;
  height: number;
  bots: BotSnapshot[];
  obstacles: Obstacle[];
};

export type Obstacle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BotPolicy = {
  name: string;
  decide: (self: BotSnapshot, context: ScenarioContext, rng: () => number) => BotAction;
};

export type SimPolicyPack = {
  red: BotPolicy;
  blue: BotPolicy;
};

export type Spawn = {
  id: string;
  team: Team;
  x: number;
  y: number;
  heading: number;
};

export type ScenarioConfig = {
  id: string;
  label: string;
  width: number;
  height: number;
  maxTimeSec: number;
  scoreLimit: number;
  obstacles?: Obstacle[];
  controlPoint?: { x: number; y: number; radius: number };
  spawns: Spawn[];
};

export type TeamMetrics = {
  team: Team;
  alive: number;
  kills: number;
  deaths: number;
  damageDealt: number;
  shotsFired: number;
  shotsHit: number;
  accuracy: number;
  controlScore: number;
};

export type ScenarioRunResult = {
  scenarioId: string;
  scenarioLabel: string;
  winner: Team | 'draw';
  elapsedSec: number;
  red: TeamMetrics;
  blue: TeamMetrics;
  trace?: ScenarioTrace;
};

export type TraceBotState = {
  id: string;
  team: Team;
  x: number;
  y: number;
  heading: number;
  hp: number;
  alive: boolean;
  cooldown: number;
  action: BotAction;
};

export type TraceFrame = {
  step: number;
  time: number;
  redControlScore: number;
  blueControlScore: number;
  bots: TraceBotState[];
};

export type ScenarioTrace = {
  scenarioId: string;
  scenarioLabel: string;
  seed: number;
  dt: number;
  frames: TraceFrame[];
};

export type RunScenarioOptions = {
  captureTrace?: boolean;
  traceEverySteps?: number;
};

export type ScenarioAggregate = {
  scenarioId: string;
  scenarioLabel: string;
  runs: number;
  redWins: number;
  blueWins: number;
  draws: number;
  avgDurationSec: number;
  avgRedAccuracy: number;
  avgBlueAccuracy: number;
  avgRedDamage: number;
  avgBlueDamage: number;
};

type MutableBot = BotSnapshot;
type MutableTeamMetrics = Omit<TeamMetrics, 'accuracy'>;

const DT = 0.05;
const SPEED = 115;
const TURN_RATE = Math.PI * 1.4;
const FIRE_COOLDOWN = 0.45;
const FIRE_RANGE = 300;
const FIRE_ARC = 0.2;
const DAMAGE = 14;
const BOT_RADIUS = 12;
const CONTROL_GAIN_PER_SEC = 1;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function distance(aX: number, aY: number, bX: number, bY: number) {
  return Math.hypot(aX - bX, aY - bY);
}

function wrapAngle(angle: number) {
  let next = angle;
  while (next > Math.PI) {
    next -= Math.PI * 2;
  }
  while (next < -Math.PI) {
    next += Math.PI * 2;
  }
  return next;
}

function buildContext(bots: MutableBot[], scenario: ScenarioConfig, time: number): ScenarioContext {
  return {
    time,
    width: scenario.width,
    height: scenario.height,
    bots: bots.map((bot) => ({ ...bot })),
    obstacles: scenario.obstacles ?? [],
  };
}

function circleRectHit(x: number, y: number, radius: number, obstacle: Obstacle) {
  const nearestX = clamp(x, obstacle.x, obstacle.x + obstacle.width);
  const nearestY = clamp(y, obstacle.y, obstacle.y + obstacle.height);
  return distance(x, y, nearestX, nearestY) < radius;
}

function collidesObstacle(x: number, y: number, radius: number, obstacles: Obstacle[]) {
  return obstacles.some((obstacle) => circleRectHit(x, y, radius, obstacle));
}

function segmentIntersectsRect(x1: number, y1: number, x2: number, y2: number, obstacle: Obstacle) {
  const minX = obstacle.x;
  const maxX = obstacle.x + obstacle.width;
  const minY = obstacle.y;
  const maxY = obstacle.y + obstacle.height;

  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;

  const clip = (p: number, q: number) => {
    if (p === 0) {
      return q >= 0;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };

  return clip(-dx, x1 - minX)
    && clip(dx, maxX - x1)
    && clip(-dy, y1 - minY)
    && clip(dy, maxY - y1)
    && t0 <= t1;
}

function isLineBlocked(x1: number, y1: number, x2: number, y2: number, obstacles: Obstacle[]) {
  return obstacles.some((obstacle) => segmentIntersectsRect(x1, y1, x2, y2, obstacle));
}

function makeMetrics(team: Team): MutableTeamMetrics {
  return {
    team,
    alive: 0,
    kills: 0,
    deaths: 0,
    damageDealt: 0,
    shotsFired: 0,
    shotsHit: 0,
    controlScore: 0,
  };
}

function toPublicMetrics(metrics: MutableTeamMetrics): TeamMetrics {
  const attempts = Math.max(1, metrics.shotsFired);
  return {
    ...metrics,
    accuracy: metrics.shotsHit / attempts,
  };
}

function findNearestEnemy(self: BotSnapshot, context: ScenarioContext) {
  let best: BotSnapshot | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of context.bots) {
    if (!candidate.alive || candidate.team === self.team || candidate.id === self.id) {
      continue;
    }
    const d = distance(self.x, self.y, candidate.x, candidate.y);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return best;
}

function findNearestVisibleEnemy(self: BotSnapshot, context: ScenarioContext) {
  let best: BotSnapshot | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of context.bots) {
    if (!candidate.alive || candidate.team === self.team || candidate.id === self.id) {
      continue;
    }
    if (isLineBlocked(self.x, self.y, candidate.x, candidate.y, context.obstacles)) {
      continue;
    }
    const d = distance(self.x, self.y, candidate.x, candidate.y);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return best;
}

function findBlockingObstacle(x1: number, y1: number, x2: number, y2: number, obstacles: Obstacle[]) {
  return obstacles.find((obstacle) => segmentIntersectsRect(x1, y1, x2, y2, obstacle)) ?? null;
}

function getLineOfSightWaypoint(self: BotSnapshot, enemy: BotSnapshot, context: ScenarioContext) {
  const blocking = findBlockingObstacle(self.x, self.y, enemy.x, enemy.y, context.obstacles);
  if (!blocking) {
    return { x: enemy.x, y: enemy.y, blocked: false };
  }

  const margin = BOT_RADIUS * 4;
  const candidates = [
    { x: blocking.x - margin, y: blocking.y - margin },
    { x: blocking.x + blocking.width + margin, y: blocking.y - margin },
    { x: blocking.x - margin, y: blocking.y + blocking.height + margin },
    { x: blocking.x + blocking.width + margin, y: blocking.y + blocking.height + margin },
    { x: self.x < enemy.x ? blocking.x - margin : blocking.x + blocking.width + margin, y: blocking.y - margin },
    { x: self.x < enemy.x ? blocking.x - margin : blocking.x + blocking.width + margin, y: blocking.y + blocking.height + margin },
  ]
    .map((candidate) => ({
      ...candidate,
      x: clamp(candidate.x, BOT_RADIUS, context.width - BOT_RADIUS),
      y: clamp(candidate.y, BOT_RADIUS, context.height - BOT_RADIUS),
    }))
    .filter((candidate) => !collidesObstacle(candidate.x, candidate.y, BOT_RADIUS, context.obstacles))
    .map((candidate) => ({
      ...candidate,
      visibleToEnemy: !isLineBlocked(candidate.x, candidate.y, enemy.x, enemy.y, context.obstacles),
      visibleFromSelf: !isLineBlocked(self.x, self.y, candidate.x, candidate.y, context.obstacles),
    }));

  const visibleCandidates = candidates.filter((candidate) => candidate.visibleToEnemy);

  if (candidates.length === 0) {
    return { x: enemy.x, y: enemy.y, blocked: true };
  }

  const rankedCandidates = (visibleCandidates.length > 0 ? visibleCandidates : candidates).sort((a, b) => {
    const aPenalty = (a.visibleToEnemy ? 0 : 10000) + (a.visibleFromSelf ? 0 : 2500);
    const bPenalty = (b.visibleToEnemy ? 0 : 10000) + (b.visibleFromSelf ? 0 : 2500);
    const aScore = aPenalty + distance(self.x, self.y, a.x, a.y) + distance(a.x, a.y, enemy.x, enemy.y) * 0.8;
    const bScore = bPenalty + distance(self.x, self.y, b.x, b.y) + distance(b.x, b.y, enemy.x, enemy.y) * 0.8;
    return aScore - bScore;
  });

  return {
    x: rankedCandidates[0].x,
    y: rankedCandidates[0].y,
    blocked: true,
  };
}

export const chaserPolicy: BotPolicy = {
  name: 'chaser',
  decide(self, context) {
    const enemy = findNearestVisibleEnemy(self, context) ?? findNearestEnemy(self, context);
    if (!enemy) {
      return { throttle: 0, turn: 0.2, fire: false };
    }

    const waypoint = getLineOfSightWaypoint(self, enemy, context);
    const dx = waypoint.x - self.x;
    const dy = waypoint.y - self.y;
    const targetAngle = Math.atan2(dy, dx);
    const angleDelta = wrapAngle(targetAngle - self.heading);
    const turn = clamp(angleDelta * 2.2, -1, 1);
    const dist = Math.hypot(enemy.x - self.x, enemy.y - self.y);
    const throttle = waypoint.blocked
      ? (Math.abs(angleDelta) > 0.7 ? 0.35 : 0.9)
      : dist > 130 ? 1 : dist < 70 ? -0.45 : 0.25;
    const fireAngle = wrapAngle(Math.atan2(enemy.y - self.y, enemy.x - self.x) - self.heading);
    const hasLineOfSight = !isLineBlocked(self.x, self.y, enemy.x, enemy.y, context.obstacles);

    return {
      throttle,
      turn,
      fire: hasLineOfSight && Math.abs(fireAngle) < FIRE_ARC,
      targetId: enemy.id,
    };
  },
};

export const kiterPolicy: BotPolicy = {
  name: 'kiter',
  decide(self, context, rng) {
    const enemies = context.bots
      .filter((candidate) => candidate.alive && candidate.team !== self.team && candidate.id !== self.id)
      .sort((left, right) => distance(self.x, self.y, left.x, left.y) - distance(self.x, self.y, right.x, right.y));
    const enemy = findNearestVisibleEnemy(self, context) ?? enemies[0] ?? null;
    if (!enemy) {
      return { throttle: 0, turn: 0.25, fire: false };
    }

    const visibleEnemy = findNearestVisibleEnemy(self, context);
    const nearestEnemy = enemies[0];
    const nearestDistance = nearestEnemy ? distance(self.x, self.y, nearestEnemy.x, nearestEnemy.y) : Number.POSITIVE_INFINITY;
    const nearbyThreats = enemies.filter((candidate) => distance(self.x, self.y, candidate.x, candidate.y) < 260);
    const pressured = nearbyThreats.length >= 2 || (self.hp <= 42 && nearestDistance < 220);

    if (!visibleEnemy && nearestEnemy) {
      const waypoint = getLineOfSightWaypoint(self, nearestEnemy, context);
      const waypointAngle = Math.atan2(waypoint.y - self.y, waypoint.x - self.x);
      const waypointDelta = wrapAngle(waypointAngle - self.heading);
      return {
        throttle: Math.abs(waypointDelta) > 0.7 ? 0.35 : 0.75,
        turn: clamp(waypointDelta * 2, -1, 1),
        fire: false,
        targetId: nearestEnemy.id,
      };
    }

    const dx = enemy.x - self.x;
    const dy = enemy.y - self.y;
    const targetAngle = Math.atan2(dy, dx);
    const angleDelta = wrapAngle(targetAngle - self.heading);
    const dist = Math.hypot(dx, dy);

    if (pressured && nearestEnemy) {
      const primaryThreat = visibleEnemy ?? nearestEnemy;
      const primaryAngle = wrapAngle(Math.atan2(primaryThreat.y - self.y, primaryThreat.x - self.x) - self.heading);
      const edgeBiasX = self.x < context.width * 0.18 ? 0.35 : self.x > context.width * 0.82 ? -0.35 : 0;
      const edgeBiasY = self.y < context.height * 0.18 ? 0.35 : self.y > context.height * 0.82 ? -0.35 : 0;
      const centerAngle = Math.atan2(context.height / 2 - self.y + edgeBiasY * context.height, context.width / 2 - self.x + edgeBiasX * context.width);
      const centerDelta = wrapAngle(centerAngle - self.heading);
      const flankBias = nearbyThreats.length >= 2
        ? Math.sign((nearbyThreats[0].y + nearbyThreats[nearbyThreats.length - 1].y) / 2 - self.y) * 0.28
        : 0;

      return {
        throttle: nearestDistance < 210 ? -1 : -0.6,
        turn: clamp(primaryAngle * 2.4 + centerDelta * 0.35 + flankBias, -1, 1),
        fire: Boolean(visibleEnemy) && Math.abs(primaryAngle) < FIRE_ARC * 0.9,
        targetId: primaryThreat.id,
      };
    }

    const preferred = 180;
    const throttle = dist > preferred + 35 ? 1 : dist < preferred - 35 ? -1 : 0;

    const strafeBias = Math.sin(context.time * 1.6 + (self.id.length % 5)) * 0.55 + (rng() - 0.5) * 0.1;
    const turn = clamp(angleDelta * 2 + strafeBias, -1, 1);
    const hasLineOfSight = !isLineBlocked(self.x, self.y, enemy.x, enemy.y, context.obstacles);

    return {
      throttle,
      turn,
      fire: hasLineOfSight && Math.abs(angleDelta) < FIRE_ARC * 0.95,
      targetId: enemy.id,
    };
  },
};

export const defaultScenarios: ScenarioConfig[] = [
  {
    id: 'duel_open_field',
    label: 'Duel Open Field',
    width: 1100,
    height: 700,
    maxTimeSec: 90,
    scoreLimit: 999,
    spawns: [
      { id: 'r1', team: 'red', x: 220, y: 350, heading: 0 },
      { id: 'b1', team: 'blue', x: 880, y: 350, heading: Math.PI },
    ],
  },
  {
    id: 'skirmish_3v3',
    label: 'Skirmish 3v3',
    width: 1280,
    height: 760,
    maxTimeSec: 120,
    scoreLimit: 999,
    controlPoint: { x: 640, y: 380, radius: 130 },
    spawns: [
      { id: 'r1', team: 'red', x: 180, y: 180, heading: 0 },
      { id: 'r2', team: 'red', x: 180, y: 380, heading: 0 },
      { id: 'r3', team: 'red', x: 180, y: 580, heading: 0 },
      { id: 'b1', team: 'blue', x: 1100, y: 180, heading: Math.PI },
      { id: 'b2', team: 'blue', x: 1100, y: 380, heading: Math.PI },
      { id: 'b3', team: 'blue', x: 1100, y: 580, heading: Math.PI },
    ],
  },
  {
    id: 'pressure_1v2',
    label: 'Pressure 1v2',
    width: 1000,
    height: 620,
    maxTimeSec: 70,
    scoreLimit: 999,
    spawns: [
      { id: 'r1', team: 'red', x: 180, y: 310, heading: 0 },
      { id: 'b1', team: 'blue', x: 740, y: 230, heading: Math.PI },
      { id: 'b2', team: 'blue', x: 780, y: 390, heading: Math.PI },
    ],
  },
  {
    id: 'wall_blocked_duel',
    label: 'Wall Blocked Duel',
    width: 1000,
    height: 620,
    maxTimeSec: 20,
    scoreLimit: 999,
    obstacles: [
      { x: 470, y: 0, width: 60, height: 620 },
    ],
    spawns: [
      { id: 'r1', team: 'red', x: 220, y: 310, heading: 0 },
      { id: 'b1', team: 'blue', x: 780, y: 310, heading: Math.PI },
    ],
  },
  {
    id: 'wall_gap_duel',
    label: 'Wall Gap Duel',
    width: 1000,
    height: 620,
    maxTimeSec: 30,
    scoreLimit: 999,
    obstacles: [
      { x: 470, y: 0, width: 60, height: 220 },
      { x: 470, y: 360, width: 60, height: 260 },
    ],
    spawns: [
      { id: 'r1', team: 'red', x: 220, y: 310, heading: 0 },
      { id: 'b1', team: 'blue', x: 780, y: 310, heading: Math.PI },
    ],
  },
  {
    id: 'flank_cover_duel',
    label: 'Flank Cover Duel',
    width: 1000,
    height: 620,
    maxTimeSec: 30,
    scoreLimit: 999,
    obstacles: [
      { x: 450, y: 170, width: 100, height: 280 },
    ],
    spawns: [
      { id: 'r1', team: 'red', x: 220, y: 310, heading: 0 },
      { id: 'b1', team: 'blue', x: 780, y: 310, heading: Math.PI },
    ],
  },
];

export function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function runScenario(config: ScenarioConfig, policies: SimPolicyPack, seed: number, options?: RunScenarioOptions): ScenarioRunResult {
  const rng = mulberry32(seed);
  const captureTrace = options?.captureTrace ?? false;
  const traceEverySteps = Math.max(1, options?.traceEverySteps ?? 1);
  const bots: MutableBot[] = config.spawns.map((spawn) => ({
    id: spawn.id,
    team: spawn.team,
    x: spawn.x,
    y: spawn.y,
    heading: spawn.heading,
    hp: 100,
    alive: true,
    cooldown: 0,
  }));

  const metrics = {
    red: makeMetrics('red'),
    blue: makeMetrics('blue'),
  };
  const traceFrames: TraceFrame[] = [];

  const maxSteps = Math.ceil(config.maxTimeSec / DT);
  let elapsed = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    elapsed = step * DT;
    const context = buildContext(bots, config, elapsed);

    const actions = new Map<string, BotAction>();
    for (const bot of bots) {
      if (!bot.alive) {
        continue;
      }
      const policy = bot.team === 'red' ? policies.red : policies.blue;
      const action = policy.decide(bot, context, rng);
      actions.set(bot.id, {
        throttle: clamp(action.throttle, -1, 1),
        turn: clamp(action.turn, -1, 1),
        fire: action.fire,
        targetId: action.targetId,
      });
    }

    for (const bot of bots) {
      if (!bot.alive) {
        continue;
      }
      const action = actions.get(bot.id);
      if (!action) {
        continue;
      }

      bot.heading = wrapAngle(bot.heading + action.turn * TURN_RATE * DT);
      const vx = Math.cos(bot.heading) * action.throttle * SPEED * DT;
      const vy = Math.sin(bot.heading) * action.throttle * SPEED * DT;
      const nextX = clamp(bot.x + vx, BOT_RADIUS, config.width - BOT_RADIUS);
      if (!collidesObstacle(nextX, bot.y, BOT_RADIUS, config.obstacles ?? [])) {
        bot.x = nextX;
      }
      const nextY = clamp(bot.y + vy, BOT_RADIUS, config.height - BOT_RADIUS);
      if (!collidesObstacle(bot.x, nextY, BOT_RADIUS, config.obstacles ?? [])) {
        bot.y = nextY;
      }
      bot.cooldown = Math.max(0, bot.cooldown - DT);
    }

    for (const shooter of bots) {
      if (!shooter.alive) {
        continue;
      }
      const action = actions.get(shooter.id);
      if (!action || !action.fire || shooter.cooldown > 0) {
        continue;
      }

      const shooterMetrics = shooter.team === 'red' ? metrics.red : metrics.blue;
      shooterMetrics.shotsFired += 1;
      shooter.cooldown = FIRE_COOLDOWN;

      const enemies = bots.filter((candidate) => candidate.alive && candidate.team !== shooter.team);
      let target: MutableBot | undefined;
      if (action.targetId) {
        target = enemies.find((candidate) => candidate.id === action.targetId);
      }
      if (!target) {
        target = enemies.sort((a, b) => distance(shooter.x, shooter.y, a.x, a.y) - distance(shooter.x, shooter.y, b.x, b.y))[0];
      }
      if (!target) {
        continue;
      }

      const d = distance(shooter.x, shooter.y, target.x, target.y);
      if (d > FIRE_RANGE) {
        continue;
      }

      if (isLineBlocked(shooter.x, shooter.y, target.x, target.y, config.obstacles ?? [])) {
        continue;
      }

      const targetAngle = Math.atan2(target.y - shooter.y, target.x - shooter.x);
      const delta = Math.abs(wrapAngle(targetAngle - shooter.heading));
      if (delta > FIRE_ARC) {
        continue;
      }

      shooterMetrics.shotsHit += 1;
      shooterMetrics.damageDealt += DAMAGE;
      target.hp -= DAMAGE;
      if (target.hp <= 0 && target.alive) {
        target.alive = false;
        shooterMetrics.kills += 1;
        const targetMetrics = target.team === 'red' ? metrics.red : metrics.blue;
        targetMetrics.deaths += 1;
      }
    }

    if (config.controlPoint) {
      const { x, y, radius } = config.controlPoint;
      const redNearby = bots.filter((bot) => bot.alive && bot.team === 'red' && distance(bot.x, bot.y, x, y) <= radius).length;
      const blueNearby = bots.filter((bot) => bot.alive && bot.team === 'blue' && distance(bot.x, bot.y, x, y) <= radius).length;
      if (redNearby > 0 && blueNearby === 0) {
        metrics.red.controlScore += CONTROL_GAIN_PER_SEC * DT;
      } else if (blueNearby > 0 && redNearby === 0) {
        metrics.blue.controlScore += CONTROL_GAIN_PER_SEC * DT;
      }
    }

    if (captureTrace && step % traceEverySteps === 0) {
      traceFrames.push({
        step,
        time: elapsed,
        redControlScore: metrics.red.controlScore,
        blueControlScore: metrics.blue.controlScore,
        bots: bots.map((bot) => ({
          id: bot.id,
          team: bot.team,
          x: bot.x,
          y: bot.y,
          heading: bot.heading,
          hp: bot.hp,
          alive: bot.alive,
          cooldown: bot.cooldown,
          action: actions.get(bot.id) ?? { throttle: 0, turn: 0, fire: false },
        })),
      });
    }

    const redAlive = bots.some((bot) => bot.alive && bot.team === 'red');
    const blueAlive = bots.some((bot) => bot.alive && bot.team === 'blue');
    if (!redAlive || !blueAlive) {
      break;
    }
    if (metrics.red.controlScore >= config.scoreLimit || metrics.blue.controlScore >= config.scoreLimit) {
      break;
    }
  }

  metrics.red.alive = bots.filter((bot) => bot.alive && bot.team === 'red').length;
  metrics.blue.alive = bots.filter((bot) => bot.alive && bot.team === 'blue').length;

  let winner: Team | 'draw' = 'draw';
  if (metrics.red.alive > 0 && metrics.blue.alive === 0) {
    winner = 'red';
  } else if (metrics.blue.alive > 0 && metrics.red.alive === 0) {
    winner = 'blue';
  } else if (metrics.red.controlScore !== metrics.blue.controlScore) {
    winner = metrics.red.controlScore > metrics.blue.controlScore ? 'red' : 'blue';
  } else if (metrics.red.damageDealt !== metrics.blue.damageDealt) {
    winner = metrics.red.damageDealt > metrics.blue.damageDealt ? 'red' : 'blue';
  }

  const result: ScenarioRunResult = {
    scenarioId: config.id,
    scenarioLabel: config.label,
    winner,
    elapsedSec: elapsed,
    red: toPublicMetrics(metrics.red),
    blue: toPublicMetrics(metrics.blue),
  };

  if (captureTrace) {
    result.trace = {
      scenarioId: config.id,
      scenarioLabel: config.label,
      seed,
      dt: DT,
      frames: traceFrames,
    };
  }

  return result;
}

export function aggregateScenario(
  config: ScenarioConfig,
  policies: SimPolicyPack,
  options?: { runs?: number; seedBase?: number },
): ScenarioAggregate {
  const runs = options?.runs ?? 20;
  const seedBase = options?.seedBase ?? 1337;

  let redWins = 0;
  let blueWins = 0;
  let draws = 0;
  let durationSum = 0;
  let redAccuracySum = 0;
  let blueAccuracySum = 0;
  let redDamageSum = 0;
  let blueDamageSum = 0;

  for (let index = 0; index < runs; index += 1) {
    const result = runScenario(config, policies, seedBase + index * 97);
    durationSum += result.elapsedSec;
    redAccuracySum += result.red.accuracy;
    blueAccuracySum += result.blue.accuracy;
    redDamageSum += result.red.damageDealt;
    blueDamageSum += result.blue.damageDealt;
    if (result.winner === 'red') {
      redWins += 1;
    } else if (result.winner === 'blue') {
      blueWins += 1;
    } else {
      draws += 1;
    }
  }

  return {
    scenarioId: config.id,
    scenarioLabel: config.label,
    runs,
    redWins,
    blueWins,
    draws,
    avgDurationSec: durationSum / runs,
    avgRedAccuracy: redAccuracySum / runs,
    avgBlueAccuracy: blueAccuracySum / runs,
    avgRedDamage: redDamageSum / runs,
    avgBlueDamage: blueDamageSum / runs,
  };
}
