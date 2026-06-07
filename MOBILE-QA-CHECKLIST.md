# Mobile QA Checklist

Run this before each staging and production release.

## Test Setup

- [x] Use latest mobile browser versions (Chrome Android, Safari iOS).
- [x] Test on at least 1 small phone viewport and 1 large phone viewport.
- [x] Clear browser cache or use private/incognito session.
- [x] Confirm server is reachable from mobile device on the same network.

## Critical Player Flow

- [x] Open game page and confirm first render is stable (no layout jumps).
- [x] Create or join a lobby.
- [x] Start a match.
- [x] Move tank with touch controls.
- [x] Fire weapon reliably.
- [ ] Survive until finish state or observe a full round end.
- [ ] Return to lobby and start next round.

## UI and Readability

- [x] Lobby screen text is readable without zooming.
- [x] Buttons are tappable (no accidental taps on neighbors).
- [x] Admin panel sections do not overflow or clip text.
- [ ] Score/announcements remain readable during action.
- [x] No important controls are hidden behind browser UI bars.

## Controls and Input

- [x] Touch controls respond without noticeable delay.
- [x] Multi-touch interactions do not break movement/fire.
- [x] No stuck input after tab switch, rotate, or brief app backgrounding.
- [x] Orientation changes (portrait/landscape) do not break layout.

## Multiplayer and Networking

- [ ] Join existing lobby from mobile while another player is active.
- [ ] Observer mode works when joining an already running match.
- [ ] Reconnect after temporary network drop restores expected state.
- [ ] No repeated disconnect/reconnect loop.

## Performance and Stability

- [ ] Match runs without severe stutter for at least 3 minutes.
- [ ] No browser crash or tab reload during normal gameplay.
- [ ] Battery/thermal behavior stays reasonable during short session.

## Release Gate

Pass if all Critical Player Flow items pass and no blocker defects exist.

Block release if any of these fail:
- Cannot join or start match on mobile.
- Cannot move/fire reliably with touch.
- Core HUD/admin text unreadable or major controls inaccessible.
- Frequent disconnect loop or crash.

## Defect Log Template

Use this format for each issue:

- Device:
- OS + Browser version:
- Build/Commit:
- Steps to reproduce:
- Expected:
- Actual:
- Severity (Blocker/High/Medium/Low):
- Screenshot/Video:
