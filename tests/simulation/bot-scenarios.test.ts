import { describe, expect, it } from 'vitest';
import {
  aggregateScenario,
  chaserPolicy,
  defaultScenarios,
  kiterPolicy,
  runScenario,
} from './botSimHarness';

describe('Bot simulation scenarios', () => {
  it('runs a deterministic duel with fixed seed', () => {
    const scenario = defaultScenarios.find((entry) => entry.id === 'duel_open_field');
    expect(scenario).toBeTruthy();

    const first = runScenario(scenario!, { red: chaserPolicy, blue: chaserPolicy }, 4242);
    const second = runScenario(scenario!, { red: chaserPolicy, blue: chaserPolicy }, 4242);

    expect(second.winner).toBe(first.winner);
    expect(second.elapsedSec).toBe(first.elapsedSec);
    expect(second.red.damageDealt).toBe(first.red.damageDealt);
    expect(second.blue.damageDealt).toBe(first.blue.damageDealt);
  });

  it('aggregates scenario metrics for monitoring dashboards', () => {
    const scenario = defaultScenarios.find((entry) => entry.id === 'skirmish_3v3');
    expect(scenario).toBeTruthy();

    const aggregate = aggregateScenario(scenario!, { red: chaserPolicy, blue: kiterPolicy }, { runs: 8, seedBase: 99 });

    expect(aggregate.runs).toBe(8);
    expect(aggregate.redWins + aggregate.blueWins + aggregate.draws).toBe(8);
    expect(aggregate.avgDurationSec).toBeGreaterThan(0);
    expect(aggregate.avgRedAccuracy).toBeGreaterThanOrEqual(0);
    expect(aggregate.avgRedAccuracy).toBeLessThanOrEqual(1);
    expect(aggregate.avgBlueAccuracy).toBeGreaterThanOrEqual(0);
    expect(aggregate.avgBlueAccuracy).toBeLessThanOrEqual(1);
  });

  it('supports asymmetric pressure scenario for stress-testing policy changes', () => {
    const scenario = defaultScenarios.find((entry) => entry.id === 'pressure_1v2');
    expect(scenario).toBeTruthy();

    const aggregate = aggregateScenario(scenario!, { red: kiterPolicy, blue: chaserPolicy }, { runs: 10, seedBase: 501 });

    expect(aggregate.runs).toBe(10);
    expect(aggregate.avgDurationSec).toBeGreaterThan(0);
    expect(aggregate.avgBlueDamage + aggregate.avgRedDamage).toBeGreaterThan(0);
  });

  it('keeps damage near zero when a solid wall separates tanks', () => {
    const scenario = defaultScenarios.find((entry) => entry.id === 'wall_blocked_duel');
    expect(scenario).toBeTruthy();

    const result = runScenario(scenario!, { red: chaserPolicy, blue: chaserPolicy }, 7001);

    expect(result.red.damageDealt).toBe(0);
    expect(result.blue.damageDealt).toBe(0);
    expect(result.winner).toBe('draw');
    expect(result.elapsedSec).toBeGreaterThanOrEqual(19.5);
  });

  it('can path through a wall opening to regain line of sight', () => {
    const scenario = defaultScenarios.find((entry) => entry.id === 'wall_gap_duel');
    expect(scenario).toBeTruthy();

    const result = runScenario(scenario!, { red: chaserPolicy, blue: chaserPolicy }, 7201);

    expect(result.red.damageDealt + result.blue.damageDealt).toBeGreaterThan(0);
    expect(result.elapsedSec).toBeLessThan(30);
  });

  it('can flank around cover to restore line of sight and deal damage', () => {
    const scenario = defaultScenarios.find((entry) => entry.id === 'flank_cover_duel');
    expect(scenario).toBeTruthy();

    const result = runScenario(scenario!, { red: chaserPolicy, blue: chaserPolicy }, 8101);

    expect(result.red.damageDealt + result.blue.damageDealt).toBeGreaterThan(0);
    expect(result.elapsedSec).toBeLessThan(30);
  });
});
