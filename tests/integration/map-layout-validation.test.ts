import { describe, expect, it } from 'vitest';
import { MAPS } from '../../src/server/maps';

type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

function isPointInsideRect(point: Point, rect: Rect) {
  return point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height;
}

function assertPointIsValid(
  mapId: string,
  mode: string,
  label: string,
  point: Point,
  width: number,
  height: number,
  obstacles: Rect[],
  failures: string[],
) {
  if (point.x < 0 || point.x > width || point.y < 0 || point.y > height) {
    failures.push(`[${mapId}] ${mode}: ${label} is out of bounds at (${point.x}, ${point.y}).`);
  }

  for (const obstacle of obstacles) {
    if (isPointInsideRect(point, obstacle)) {
      failures.push(
        `[${mapId}] ${mode}: ${label} overlaps obstacle at (${obstacle.x}, ${obstacle.y}, ${obstacle.width}, ${obstacle.height}).`,
      );
      return;
    }
  }
}

describe('Map layout validation', () => {
  it('keeps objectives clear of obstacles across all game modes', () => {
    const failures: string[] = [];

    for (const map of Object.values(MAPS)) {
      for (const [team, spawns] of Object.entries(map.spawns)) {
        spawns.forEach((spawn, index) => {
          assertPointIsValid(
            map.id,
            'all-modes',
            `${team} spawn #${index + 1}`,
            spawn,
            map.width,
            map.height,
            map.obstacles,
            failures,
          );
        });
      }

      assertPointIsValid(map.id, 'capture-the-flag', 'red base', map.redBase, map.width, map.height, map.obstacles, failures);
      assertPointIsValid(map.id, 'capture-the-flag', 'blue base', map.blueBase, map.width, map.height, map.obstacles, failures);
      assertPointIsValid(map.id, 'capture-the-flag', 'red flag', map.redFlag, map.width, map.height, map.obstacles, failures);
      assertPointIsValid(map.id, 'capture-the-flag', 'blue flag', map.blueFlag, map.width, map.height, map.obstacles, failures);

      assertPointIsValid(map.id, 'protect-the-king', 'red king', map.redKing, map.width, map.height, map.obstacles, failures);
      assertPointIsValid(map.id, 'protect-the-king', 'blue king', map.blueKing, map.width, map.height, map.obstacles, failures);

      map.controlPoints.forEach((point) => {
        assertPointIsValid(
          map.id,
          'control-points',
          `control point ${point.id}`,
          point,
          map.width,
          map.height,
          map.obstacles,
          failures,
        );
      });
    }

    expect(failures).toEqual([]);
  });
});
