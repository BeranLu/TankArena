# Post-Deploy Smoke Checklist

Run this after each staging or production deploy.

## Core Flow

- [ ] Open app URL and confirm shell loads without console errors.
- [ ] Create a new public lobby.
- [ ] Add at least 1 bot.
- [ ] Start a round.
- [ ] Verify countdown -> running transition.
- [ ] Move and shoot as a player.
- [ ] Leave and rejoin during running phase.
- [ ] Confirm rejoin is observer mode for active match.
- [ ] Stop to lobby as admin.

## Multiplayer Basics

- [ ] Join same lobby from second client.
- [ ] Confirm both clients receive live updates.
- [ ] Confirm admin actions (mode/map/apply/start/stop) replicate.

## Mode Sanity

- [ ] Team Deathmatch starts and score increments on eliminations.
- [ ] Capture the Flag starts and flags are visible on map.
- [ ] Protect the King starts and kings are assigned.
- [ ] Control Points starts and points are visible/capturable.

## Quick Integrity

- [ ] Support/feedback/report actions render as expected for current env config.
- [ ] No obvious UI clipping in current target device/browser.
- [ ] No disconnect loop during a 2-3 minute session.

## Release Gate

Pass when all Core Flow items pass and no blocker bugs appear.

If any Core Flow item fails, block release and open a bug with repro steps.
