# Tank Arena Bandwidth Scaling Migration Plan

Purpose: evolve the current full-snapshot Socket.IO model into a delta replication model that supports higher player counts with predictable bandwidth.

## Objectives

- Keep server authoritative game logic.
- Reduce outbound WebSocket bytes per connected player.
- Preserve gameplay feel for movement, aiming, and firing.
- Roll out safely with feature flags and quick rollback.

## Success Targets

- 50% reduction in average outbound WebSocket bytes/minute versus current baseline.
- 70% reduction in idle/lobby-selection bandwidth versus baseline.
- No measurable increase in reconnect rate, jitter complaints, or control-lag reports.
- Stable operation at 2x target concurrent users in load test.

## Current State

- Server sim runs at 60Hz and emits frequent snapshots.
- Snapshot payload includes many fields for all players in a lobby.
- Compression and basic throttling are enabled.
- WebSocket metrics exist and can identify top outbound events.

## Target Architecture

- Simulation tick remains authoritative (60Hz).
- Networking tick is decoupled (10-20Hz).
- Protocol sends periodic keyframes plus compact deltas.
- Client interpolates remote entities and reconciles local prediction.

## Migration Strategy

Use a phased approach that keeps old and new protocols in parallel until validation is complete.

### Phase 0 - Baseline and Guardrails (2-3 days)

- Add explicit dashboards or log extraction for:
- outbound bytes/min by event type
- average snapshot payload size
- p95 payload size
- connected users over time
- Add feature flags:
- NET_PROTOCOL_V2_ENABLED
- NET_DELTA_ENABLED
- NET_BINARY_ENABLED
- Define rollback rule: disable flags and restart, no schema/data migration required.

Deliverable:
- Baseline report with 24h data and known peak-hour profile.

### Phase 1 - Split Fast vs Slow Channels (3-5 days)

- Keep existing snapshot event for compatibility.
- Create explicit event channels:
- stateFast: transforms, health, projectiles, critical objective state
- stateSlow: lobby metadata, admin state, mode settings, non-urgent UI state
- Reduce stateSlow frequency (for example 1-2Hz) while keeping stateFast higher.
- Update client to consume both channels and merge into render state.

Deliverable:
- 15-25% traffic reduction with zero gameplay changes.

### Phase 2 - Delta Replication (6-10 days)

- Add per-client replication cache (last acknowledged entity state/hash).
- Send keyframes periodically (for example every 2-5 seconds).
- Send delta frames in between:
- created entities
- changed fields
- removed entities
- Include sequence numbers and keyframe IDs for recovery.
- On sequence gap or decode mismatch, request/resend keyframe.

Deliverable:
- Significant drop in average bytes per update versus full relevant snapshot.

### Phase 3 - Client Interpolation and Prediction Hardening (4-6 days)

- Maintain interpolation buffer for remote entities.
- Predict local player movement client-side.
- Reconcile local state with authoritative corrections smoothly.
- Add correction smoothing thresholds to avoid visible snapping.

Deliverable:
- Smooth visual motion at lower network update rates.

### Phase 4 - Optional Binary Encoding (4-7 days)

- Keep JSON V2 as fallback protocol.
- Add binary transport for V2 frames:
- start with MessagePack or compact typed arrays
- optionally move to custom bit-packed schema for transforms
- Quantize high-frequency numbers before encode.
- Negotiate protocol at connect via capability handshake.

Deliverable:
- Additional 20-50% payload reduction over compressed JSON deltas.

### Phase 5 - Decommission Legacy Path (2-3 days)

- After two stable releases, disable legacy snapshot path.
- Keep emergency legacy toggle for one more release window.
- Remove dead compatibility code after final validation.

Deliverable:
- Simpler codebase with one primary scalable protocol.

## Data Model Evolution

V2 frame envelope:

- protocolVersion
- serverTick
- frameType (keyframe|delta)
- sequence
- keyframeId
- payload

Delta payload sections:

- playersCreated
- playersUpdated
- playersRemoved
- projectilesCreated
- projectilesUpdated
- projectilesRemoved
- objectivesUpdated

## Load and Validation Plan

- Build deterministic bot load scenarios at 10, 20, 40, 80 simulated clients.
- Measure:
- outbound bytes/min total and per client
- p95 server tick duration
- p95 network encode time
- packet size distribution
- Compare old protocol vs each phase gate.

Promotion gate for each phase:

- At least 20% gain or clear strategic necessity.
- No gameplay regression in smoke and bot scenarios.
- No new crash/reconnect pattern in staging soak (minimum 24h).

## Risks and Mitigations

- Risk: protocol complexity causes desync bugs.
- Mitigation: periodic keyframes + sequence checks + forced resync path.

- Risk: prediction/reconciliation feels jittery.
- Mitigation: interpolation buffer tuning and correction smoothing thresholds.

- Risk: migration stalls due to broad scope.
- Mitigation: phase gates with measurable wins and shippable increments.

## Team Execution Plan

- Week 1: Phase 0 and Phase 1.
- Week 2: Phase 2.
- Week 3: Phase 3.
- Week 4: Phase 4 and optional Phase 5 start.
- Week 5: Phase 5 completion.

## Immediate Next Steps

- Add this plan into sprint board with owners per phase.
- Implement protocol capability handshake scaffold.
- Start Phase 0 baseline capture and lock target thresholds using the automatic WS report sink and server-admin summary viewer.

## Next 3 Execution Tasks

1. Sequence-gap recovery path (Done)
- Detect split-channel sequence gaps on client and request targeted keyframe resync.
- Force targeted keyframe emit on server for requesting socket.

2. Baseline evidence pack (Next)
- Capture 24h WS baseline report with bytes/min, avg payload, p95 payload, top events by bytes.
- Use the automatic JSONL report sink at `reports/bandwidth-report.jsonl`.
- Review it through the server-admin HTML summary viewer.
- Publish thresholds for production promote gate.

3. Interpolation smoothing pass (Next)
- Add remote-entity interpolation buffer and correction smoothing thresholds.
- Validate with mobile and desktop responsiveness checks.
