import fs from 'node:fs';
import path from 'node:path';

type Team = 'red' | 'blue';

type BotAction = {
  throttle: number;
  turn: number;
  fire: boolean;
  targetId?: string;
};

type TraceBotState = {
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

type TraceFrame = {
  step: number;
  time: number;
  redControlScore: number;
  blueControlScore: number;
  bots: TraceBotState[];
};

type ScenarioTrace = {
  scenarioId: string;
  scenarioLabel: string;
  seed: number;
  dt: number;
  frames: TraceFrame[];
};

type TraceDocument = {
  generatedAt: string;
  traces: ScenarioTrace[];
};

type TeamRates = {
  avgFirePct: number;
  avgIdlePct: number;
  avgTurnMagnitude: number;
  avgThrottleMagnitude: number;
};

type TraceSummary = {
  scenarioLabel: string;
  presetLabel: string;
  matchupLabel: string;
  runLabel: string;
  winner: Team | 'draw';
  durationSec: number;
  frames: number;
  finalRedControl: number;
  finalBlueControl: number;
  redRates: TeamRates;
  blueRates: TeamRates;
};

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function findLatestTraceFile(outputDir: string) {
  const files = fs.readdirSync(outputDir)
    .filter((name) => name.startsWith('bot-traces-') && name.endsWith('.json'))
    .map((name) => ({
      name,
      fullPath: path.join(outputDir, name),
      mtime: fs.statSync(path.join(outputDir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return files[0]?.fullPath;
}

function parseTraceDocument(filePath: string): TraceDocument {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as TraceDocument;
}

function extractScenarioParts(label: string) {
  const parts = label.split(' / ');
  const presetLabel = parts[0] ?? label;
  const matchupLabel = parts[1] ?? label;
  const runLabel = parts[2] ?? 'run 1';
  return { presetLabel, matchupLabel, runLabel };
}

function summarizeTrace(trace: ScenarioTrace): TraceSummary {
  const frames = trace.frames;
  const finalFrame = frames[frames.length - 1];
  const durationSec = finalFrame?.time ?? 0;

  const teamRates = (team: Team): TeamRates => {
    const perBotFire: number[] = [];
    const perBotIdle: number[] = [];
    const perBotTurnMag: number[] = [];
    const perBotThrottleMag: number[] = [];

    const firstFrameBots = (frames[0]?.bots ?? []).filter((bot) => bot.team === team).map((bot) => bot.id);

    for (const botId of firstFrameBots) {
      const states = frames.map((frame) => frame.bots.find((bot) => bot.id === botId)).filter((bot): bot is TraceBotState => Boolean(bot));
      if (states.length === 0) {
        continue;
      }
      const fireRatio = states.filter((bot) => bot.action.fire).length / states.length;
      const idleRatio = states.filter((bot) => Math.abs(bot.action.throttle) < 0.05).length / states.length;
      const turnMagnitude = average(states.map((bot) => Math.abs(bot.action.turn)));
      const throttleMagnitude = average(states.map((bot) => Math.abs(bot.action.throttle)));
      perBotFire.push(fireRatio);
      perBotIdle.push(idleRatio);
      perBotTurnMag.push(turnMagnitude);
      perBotThrottleMag.push(throttleMagnitude);
    }

    return {
      avgFirePct: average(perBotFire),
      avgIdlePct: average(perBotIdle),
      avgTurnMagnitude: average(perBotTurnMag),
      avgThrottleMagnitude: average(perBotThrottleMag),
    };
  };

  const winner: Team | 'draw' = (() => {
    const bots = finalFrame?.bots ?? [];
    const redAlive = bots.some((bot) => bot.team === 'red' && bot.alive);
    const blueAlive = bots.some((bot) => bot.team === 'blue' && bot.alive);
    if (redAlive && !blueAlive) return 'red';
    if (blueAlive && !redAlive) return 'blue';

    const redControl = finalFrame?.redControlScore ?? 0;
    const blueControl = finalFrame?.blueControlScore ?? 0;
    if (redControl > blueControl) return 'red';
    if (blueControl > redControl) return 'blue';
    return 'draw';
  })();

  const parts = extractScenarioParts(trace.scenarioLabel);

  return {
    scenarioLabel: trace.scenarioLabel,
    presetLabel: parts.presetLabel,
    matchupLabel: parts.matchupLabel,
    runLabel: parts.runLabel,
    winner,
    durationSec,
    frames: frames.length,
    finalRedControl: finalFrame?.redControlScore ?? 0,
    finalBlueControl: finalFrame?.blueControlScore ?? 0,
    redRates: teamRates('red'),
    blueRates: teamRates('blue'),
  };
}

function pointsToPolyline(points: Array<{ x: number; y: number }>, width: number, height: number) {
  return points
    .map((point) => `${(point.x / Math.max(1, width) * 360).toFixed(1)},${(point.y / Math.max(1, height) * 240).toFixed(1)}`)
    .join(' ');
}

function createTrajectorySvg(trace: ScenarioTrace) {
  const width = 360;
  const height = 240;
  const bounds = (() => {
    const xs = trace.frames.flatMap((frame) => frame.bots.map((bot) => bot.x));
    const ys = trace.frames.flatMap((frame) => frame.bots.map((bot) => bot.y));
    return {
      minX: Math.min(...xs, 0),
      maxX: Math.max(...xs, 1),
      minY: Math.min(...ys, 0),
      maxY: Math.max(...ys, 1),
    };
  })();

  const rangeX = Math.max(1, bounds.maxX - bounds.minX);
  const rangeY = Math.max(1, bounds.maxY - bounds.minY);

  const ids = Array.from(new Set((trace.frames[0]?.bots ?? []).map((bot) => bot.id))).slice(0, 8);
  const lines = ids.map((id) => {
    const points = trace.frames
      .map((frame) => frame.bots.find((bot) => bot.id === id))
      .filter((bot): bot is TraceBotState => Boolean(bot))
      .map((bot) => ({ x: bot.x - bounds.minX, y: bot.y - bounds.minY, team: bot.team }));

    const team = points[0]?.team ?? 'red';
    const color = team === 'red' ? '#ef4444' : '#3b82f6';
    const polyline = pointsToPolyline(points, rangeX, rangeY);
    return `<polyline points=\"${polyline}\" fill=\"none\" stroke=\"${color}\" stroke-width=\"1.8\" opacity=\"0.9\" />`;
  }).join('');

  return `<svg viewBox=\"0 0 ${width} ${height}\" class=\"traj\">${lines}</svg>`;
}

function createControlSvg(trace: ScenarioTrace) {
  const width = 360;
  const height = 140;
  const times = trace.frames.map((frame) => frame.time);
  const redScores = trace.frames.map((frame) => frame.redControlScore);
  const blueScores = trace.frames.map((frame) => frame.blueControlScore);
  const maxTime = Math.max(1, ...times);
  const maxScore = Math.max(1, ...redScores, ...blueScores);

  const toPath = (values: number[]) => values.map((value, index) => {
    const x = (times[index] / maxTime) * width;
    const y = height - (value / maxScore) * height;
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');

  return `<svg viewBox=\"0 0 ${width} ${height}\" class=\"control\">
    <path d=\"${toPath(redScores)}\" stroke=\"#ef4444\" fill=\"none\" stroke-width=\"2\" />
    <path d=\"${toPath(blueScores)}\" stroke=\"#3b82f6\" fill=\"none\" stroke-width=\"2\" />
  </svg>`;
}

function buildHtmlReport(traceFile: string, traces: ScenarioTrace[], summaries: TraceSummary[]) {
  const perPreset = new Map<string, { redWins: number; blueWins: number; draws: number; runs: number }>();
  for (const summary of summaries) {
    const current = perPreset.get(summary.presetLabel) ?? { redWins: 0, blueWins: 0, draws: 0, runs: 0 };
    current.runs += 1;
    if (summary.winner === 'red') current.redWins += 1;
    else if (summary.winner === 'blue') current.blueWins += 1;
    else current.draws += 1;
    perPreset.set(summary.presetLabel, current);
  }

  const presetRows = Array.from(perPreset.entries()).map(([name, metrics]) => {
    return `<tr><td>${name}</td><td>${metrics.runs}</td><td>${metrics.redWins}</td><td>${metrics.blueWins}</td><td>${metrics.draws}</td></tr>`;
  }).join('');

  const traceCards = traces.map((trace, index) => {
    const summary = summaries[index];
    const trajectorySvg = createTrajectorySvg(trace);
    const controlSvg = createControlSvg(trace);
    return `<section class=\"card\">\n`
      + `<h3>${summary.scenarioLabel}</h3>\n`
      + `<p><strong>Winner:</strong> ${summary.winner.toUpperCase()} | <strong>Duration:</strong> ${summary.durationSec.toFixed(1)}s | <strong>Frames:</strong> ${summary.frames}</p>\n`
      + `<p>Red fire ${formatPercent(summary.redRates.avgFirePct)} | Blue fire ${formatPercent(summary.blueRates.avgFirePct)} | Red idle ${formatPercent(summary.redRates.avgIdlePct)} | Blue idle ${formatPercent(summary.blueRates.avgIdlePct)}</p>\n`
      + `<div class=\"viz\">\n`
      + `<div><h4>Trajectories</h4>${trajectorySvg}</div>\n`
      + `<div><h4>Control Over Time</h4>${controlSvg}</div>\n`
      + `</div>\n`
      + `</section>`;
  }).join('\n');

  return `<!doctype html>
<html>
<head>
  <meta charset=\"utf-8\" />
  <title>Bot Trace Analysis</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 24px; color: #0f172a; background: #f8fafc; }
    h1, h2, h3 { margin: 0 0 10px 0; }
    .muted { color: #64748b; margin-bottom: 16px; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 18px; background: white; }
    th, td { border: 1px solid #e2e8f0; padding: 8px 10px; text-align: left; }
    th { background: #f1f5f9; }
    .card { background: white; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px; margin-bottom: 14px; }
    .viz { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .traj, .control { width: 100%; border: 1px solid #cbd5e1; background: #ffffff; }
  </style>
</head>
<body>
  <h1>Bot Trace Analysis</h1>
  <p class=\"muted\">Source: ${traceFile}</p>

  <h2>Preset Summary</h2>
  <table>
    <thead><tr><th>Preset</th><th>Runs</th><th>Red Wins</th><th>Blue Wins</th><th>Draws</th></tr></thead>
    <tbody>${presetRows}</tbody>
  </table>

  <h2>Run Details</h2>
  ${traceCards}
</body>
</html>`;
}

function main() {
  const outputDir = path.resolve(process.cwd(), 'tests/simulation/output');
  const inputArg = process.argv[2];
  const traceFile = inputArg ? path.resolve(process.cwd(), inputArg) : findLatestTraceFile(outputDir);

  if (!traceFile || !fs.existsSync(traceFile)) {
    console.error('No trace file found. Run BOT_SIM_TRACE=1 npm run bot:sim first.');
    process.exit(1);
  }

  const document = parseTraceDocument(traceFile);
  if (!document.traces || document.traces.length === 0) {
    console.error(`Trace file has no traces: ${traceFile}`);
    process.exit(1);
  }

  const summaries = document.traces.map(summarizeTrace);

  console.log(`Analyzing trace file: ${traceFile}`);
  for (const summary of summaries) {
    console.log(
      `${summary.scenarioLabel}: winner=${summary.winner} duration=${summary.durationSec.toFixed(1)}s `
      + `redFire=${formatPercent(summary.redRates.avgFirePct)} blueFire=${formatPercent(summary.blueRates.avgFirePct)} `
      + `redIdle=${formatPercent(summary.redRates.avgIdlePct)} blueIdle=${formatPercent(summary.blueRates.avgIdlePct)}`,
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(outputDir, `bot-analysis-${stamp}.html`);
  const summaryPath = path.join(outputDir, `bot-analysis-${stamp}.json`);

  const html = buildHtmlReport(traceFile, document.traces, summaries);
  fs.writeFileSync(reportPath, html, 'utf8');
  fs.writeFileSync(summaryPath, JSON.stringify({ source: traceFile, summaries }, null, 2), 'utf8');

  console.log(`Report written: ${reportPath}`);
  console.log(`Summary written: ${summaryPath}`);
}

main();
