# Tank Arena Milestone Board

Purpose: post-launch execution plan with practical scope and rough effort.

Effort scale:
- S: 0.5 to 1 day
- M: 2 to 3 days
- L: 4 to 6 days

## M1 - Launch Stability and Ops (Week 1)

Goal: keep public build stable and remove the most visible rough edges.

- [ ] (M) Verify all game modes show active bot behavior in real matches, not only simulation.
- [ ] (M) Tune Team Deathmatch bot aggression/pathing to reduce idle periods.
- [ ] (M) UI tidying pass for lobby and match HUD:
  - [ ] Fix element positions/alignment across desktop and mobile.
  - [ ] Standardize text spacing and visual hierarchy.
  - [ ] Improve readability (contrast, label clarity, and dense panel spacing).
- [ ] (M) Mobile compatibility baseline:
  - [x] Responsive lobby layout for common phone sizes.
  - [x] Touch-friendly controls and button hit areas.
  - [x] Prevent text clipping/overflow in key HUD and admin panels.
  - [x] Validate baseline on staging with MOBILE-QA-CHECKLIST.md.
- [x] (S) Add a post-deploy smoke checklist (create lobby, add bot, start round, join observer).
- [x] (S) Add trailer capture checklist and lock safer capture defaults (no countdown/static starts).
- [x] (S) Add Known Issues section to README for player-facing transparency.

Milestone exit criteria:
- One pass of smoke checks succeeds on staging and production.
- New deathmatch clips show sustained movement.
- Core screens pass a UI readability check on desktop and mobile.
- Core player flow works on mobile browser (join lobby, move, shoot, finish round).
- README reflects known limitations clearly.

## M2 - Gameplay Depth and Replayability (Weeks 2 to 3)

Goal: improve match quality and make each mode feel more distinct.

- [ ] (L) Mode balance pass:
  - [ ] Team Deathmatch pacing and spawn pressure.
  - [ ] Capture the Flag return/steal flow and score pacing.
  - [ ] Protect the King survivability and role clarity.
  - [ ] Control Points capture/bleed pacing and comeback potential.
- [ ] (L) Add at least one additional map per mode profile (open, corridor, objective-heavy).
- [ ] (M) Add admin mode presets for quick match setup.
- [ ] (M) Add rematch flow from finished screen.
- [ ] (L) Add new mode: Power-Ups.
  - [ ] Define power-up spawn logic, timing, and pickup rules.
  - [ ] Add at least 4 power-up types with clear visuals and short descriptions.
  - [ ] Add mode-specific win condition and admin configuration controls.

Milestone exit criteria:
- Each mode has one documented tuning pass and validation notes.
- At least 3 new map layouts added and validated.
- Rematch flow works end-to-end in multiplayer session.
- Power-Ups mode is playable with bots and included in admin mode selection.

## M3 - Multiplayer Hardening and Tooling (Weeks 4 to 5)

Goal: reduce regressions and improve release confidence.

- [ ] (M) Add reconnect handling tests (admin leaves during countdown, reconnect on phase transitions).
- [ ] (M) Add basic anti-spam/rate limits for sensitive admin socket actions.
- [ ] (L) Add player registration and progression baseline:
  - [ ] Account registration/login flow (minimal friction).
  - [ ] Player ranks and progression points.
  - [ ] Cosmetic skins unlock/equip flow.
  - [ ] Tank type selection/loadout system.
- [ ] (M) Add server metrics logging (match duration, joins/leaves, mode usage).
- [ ] (S) Add end-of-round telemetry payload for balancing review.
- [ ] (M) Add CI workflow for typecheck + tests on push and PR.
- [ ] (M) Split tests into fast and full suites.
- [x] (S) Add release checklist for staging -> production flow.
- [x] (S) Add CHANGELOG baseline and future release template.

Milestone exit criteria:
- CI blocks merges on failing checks.
- Reconnect regressions covered by tests.
- Registration and profile data persist correctly across reconnects.
- Release checklist used at least once successfully.

## Test Coverage Gaps (Add to execution queue)

Goal: close the highest-risk functionality gaps that are currently under-tested.

- [ ] (M) Add Deathmatch integration tests:
  - [ ] score progression from eliminations.
  - [ ] win condition at configured target.
  - [ ] round result payload correctness.
- [ ] (L) Add Capture the Flag integration tests:
  - [ ] flag pickup/return/capture flow.
  - [ ] contested interactions and reset behavior.
  - [ ] score and win condition validation.
- [ ] (L) Add Protect the King integration tests:
  - [ ] king damage handling and protection flow.
  - [ ] king defeat condition and round end.
  - [ ] mode-specific round result validation.
- [ ] (M) Add browser E2E smoke tests for client-facing features:
  - [ ] donation panel visibility by env configuration.
  - [ ] feedback/bug-report UI visibility and basic open/close flow.
  - [ ] join/start/play basic flow in browser.
- [ ] (S) Add mobile browser smoke automation for one critical path (join -> move -> fire).

Coverage exit criteria:
- All primary game modes have at least one end-to-end integration test for win conditions.
- Client feature toggles driven by env vars are covered by browser tests.
- One mobile smoke path is automated and green in CI or release validation.

## Bandwidth Optimization Plan (WebSocket Focus)

Goal: reduce outbound WebSocket traffic while preserving gameplay feel in active matches.

- [ ] (S) Use [BANDWIDTH-MIGRATION-PLAN.md](BANDWIDTH-MIGRATION-PLAN.md) as the implementation source of truth and assign an owner per phase.

### Phase 0 - Live Monitoring Baseline (Immediate)

- [x] (S) Add per-event outbound WS metrics logs (bytes and event counts).
- [x] (S) Add automatic WS JSONL report sink for baseline capture and forecasting.
- [x] (S) Add admin console access to the bandwidth report from the browser.
- [ ] (S) Record 24h baseline after deploy:
  - [ ] Capture total outbound WS KB per minute.
  - [ ] Capture top events by bytes (`snapshot`, `message`, `lobbyList`, `joined`).
  - [ ] Compare peak hour vs off-peak hour traffic.

### Phase 1 - Low-Risk Traffic Cuts (Immediate to Week 1)

- [x] (S) Throttle snapshot broadcast rate below simulation tick.
- [x] (S) Stop resending static map payload in every snapshot.
- [x] (S) Enable WebSocket compression.
- [x] (S) Keep full-rate snapshots for playable phases (`running`, `lobby`) and throttle only non-play phases.
- [ ] (S) Tune default env rates after baseline review:
  - [ ] `SNAPSHOT_RATE_RUNNING_HZ`
  - [ ] `SNAPSHOT_RATE_IDLE_HZ`
  - [ ] `WS_METRICS_LOG_INTERVAL_MS`

### Phase 2 - Payload Size Reduction (Week 1 to Week 2)

- [x] (M) Quantize high-frequency numeric fields in snapshots:
  - [x] position/angle precision clamp.
  - [x] score/timer precision clamp.
- [x] (M) Split snapshot schema into fast lane and slow lane events:
  - [x] Fast lane: player/projectile transforms and health.
  - [x] Slow lane: settings/admin metadata/round summaries.
- [x] (S) Add payload-size debug output for `snapshot` shape revisions.

### Phase 3 - Structural Wins (Week 2 to Week 3)

- [ ] (L) Delta snapshots per client:
  - [x] Add per-socket replication cursor scaffold (sequence/keyframe metadata hooks).
  - [x] Track last acknowledged state per socket.
  - [x] Send changed entities only.
  - [x] Add periodic full snapshot resync safety.
- [x] (S) Defer interest management for now (arena scale is small, low practical gain currently).

### Validation and Exit Criteria

- [x] (S) Add a release checkpoint requiring WS metrics review before production promote.
- [ ] (S) Confirm no visible gameplay degradation (movement smoothness/shooting responsiveness) on desktop and mobile.
- [ ] (S) Target measurable reductions:
  - [ ] At least 40% reduction in average outbound WS bytes/min from baseline.
  - [ ] At least 50% reduction in idle-phase outbound WS bytes/min from baseline.
  - [ ] No increase in reconnect/jitter player reports during peak hour.

## Parking Lot (Nice to Have)

- [ ] (M) Observer minimap or tactical overlay.
- [ ] (S) Additional cosmetic tank variants/colors.
- [ ] (S) In-game quick tips panel per mode.
- [ ] (M) Optional mobile-specific control presets (left-handed/right-handed).

## Suggested Weekly Sequence

- Week 1: complete M1 only, ship stabilization patch.
- Week 2: start M2 balance and first map batch.
- Week 3: finish M2 rematch + presets + Power-Ups prototype, run playtest.
- Week 4: implement M3 reconnect tests + anti-spam + registration foundation.
- Week 5: ranks/skins/tank types + telemetry cleanup + CI hardening.
- Week 6: release checklist dry run, changelog discipline, and progression polish.
