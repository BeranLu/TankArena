import fs from 'node:fs';
import path from 'node:path';
import {
  aggregateScenario,
  chaserPolicy,
  defaultScenarios,
  kiterPolicy,
  runScenario,
  type ScenarioTrace,
  type SimPolicyPack,
} from './botSimHarness';

type PolicyPreset = {
  id: string;
  label: string;
  policies: SimPolicyPack;
};

const presets: PolicyPreset[] = [
  {
    id: 'mirror_chaser',
    label: 'Mirror Chaser',
    policies: { red: chaserPolicy, blue: chaserPolicy },
  },
  {
    id: 'kiter_vs_chaser',
    label: 'Kiter (Red) vs Chaser (Blue)',
    policies: { red: kiterPolicy, blue: chaserPolicy },
  },
  {
    id: 'chaser_vs_kiter',
    label: 'Chaser (Red) vs Kiter (Blue)',
    policies: { red: chaserPolicy, blue: kiterPolicy },
  },
];

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function printAggregate() {
  const runs = Number.parseInt(process.env.BOT_SIM_RUNS ?? '20', 10) || 20;
  const shouldTrace = process.env.BOT_SIM_TRACE === '1';
  const traceRuns = Math.max(1, Number.parseInt(process.env.BOT_SIM_TRACE_RUNS ?? '1', 10) || 1);
  const traceEverySteps = Math.max(1, Number.parseInt(process.env.BOT_SIM_TRACE_EVERY_STEPS ?? '1', 10) || 1);
  const traces: ScenarioTrace[] = [];

  for (const preset of presets) {
    console.log(`\n=== ${preset.label} (${runs} runs per scenario) ===`);
    for (const scenario of defaultScenarios) {
      const aggregate = aggregateScenario(scenario, preset.policies, { runs });
      console.log(
        `${aggregate.scenarioLabel}: redW=${aggregate.redWins} blueW=${aggregate.blueWins} draw=${aggregate.draws} `
        + `avgT=${aggregate.avgDurationSec.toFixed(1)}s `
        + `accR=${formatPercent(aggregate.avgRedAccuracy)} accB=${formatPercent(aggregate.avgBlueAccuracy)} `
        + `dmgR=${aggregate.avgRedDamage.toFixed(1)} dmgB=${aggregate.avgBlueDamage.toFixed(1)}`,
      );

      if (shouldTrace) {
        for (let run = 0; run < traceRuns; run += 1) {
          const seed = 9001 + run * 97;
          const traced = runScenario(scenario, preset.policies, seed, {
            captureTrace: true,
            traceEverySteps,
          });
          if (traced.trace) {
            traces.push({
              ...traced.trace,
              scenarioId: `${preset.id}:${traced.trace.scenarioId}:run-${run + 1}`,
              scenarioLabel: `${preset.label} / ${traced.trace.scenarioLabel} / run ${run + 1}`,
            });
          }
        }
      }
    }
  }

  if (shouldTrace) {
    const outputDir = path.resolve(process.cwd(), process.env.BOT_SIM_TRACE_DIR ?? 'tests/simulation/output');
    fs.mkdirSync(outputDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = path.join(outputDir, `bot-traces-${stamp}.json`);
    fs.writeFileSync(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), traces }, null, 2), 'utf8');
    console.log(`\nTrace written: ${outputPath}`);
  }
}

printAggregate();
