# Release Checklist (Staging -> Production)

Use this checklist for every production promotion.

## Pre-Merge (Staging)

- [ ] `staging` branch is up to date and green.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] Core smoke flow passes from `POST-DEPLOY-SMOKE-CHECKLIST.md`.
- [ ] Mobile validation pass completed from `MOBILE-QA-CHECKLIST.md` (if mobile controls changed).
- [ ] Trailer/media validation pass completed (if media changed).
- [ ] No blocker/high-severity bugs open for this release.
- [ ] WebSocket metrics review completed for this release window:
	- [ ] Outbound WS KB/min reviewed versus baseline.
	- [ ] Top outbound events by bytes reviewed.
	- [ ] Peak-hour traffic checked for regressions.

## Release Notes

- [ ] Add/update `CHANGELOG.md` entries for this release.
- [ ] Confirm known limitations are reflected in README Known Issues.

## Promotion

- [ ] Commit any final docs/checklist updates on `staging`.
- [ ] Merge `staging` into `main` (fast-forward preferred).
- [ ] Push `main` to origin.
- [ ] Verify pushed commit hash/tag for audit trail.

## Post-Publish Verification

- [ ] Open production URL and verify app loads.
- [ ] Create lobby, add bot, start round.
- [ ] Verify controls and round transitions.
- [ ] Verify observer flow by rejoining active match.
- [ ] Verify support/feedback/report actions render as expected.

## Rollback Preparedness

- [ ] Identify previous known-good commit on `main`.
- [ ] Confirm rollback command/process is ready if a blocker appears.

## Release Gate

Only publish when all required checks pass and no blocker defects remain.
