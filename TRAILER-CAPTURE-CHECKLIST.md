# Trailer Capture Checklist

Use this before publishing any new gameplay trailer.

## Preflight

- [ ] Start from latest staging/main build.
- [ ] Ensure no unrelated overlays are visible (debug UI, browser prompts, extensions).
- [ ] Confirm target resolution and aspect ratio for trailer output.
- [ ] Confirm branding endcard asset is present (`ShellStorm2.png` or fallback image).

## Capture Quality

- [ ] Record each required mode clip:
  - [ ] Team Deathmatch
  - [ ] Capture the Flag
  - [ ] Protect the King
  - [ ] Control Points
- [ ] Verify each clip shows sustained action (no long idle tank periods).
- [ ] Verify countdown is not visible in final extracted segments.
- [ ] Verify arena framing shows full battlefield (not cropped key objectives).
- [ ] Verify observer/bots-only capture path is used when needed.

## Assembly Quality

- [ ] Verify mode labels are readable and not clipped on target resolution.
- [ ] Verify transitions are smooth and timing is consistent.
- [ ] Verify endcard appears and fades correctly.
- [ ] Verify no ffmpeg warnings/errors that indicate broken output.

## Final Validation

- [ ] Watch full trailer once on desktop.
- [ ] Watch full trailer once on mobile.
- [ ] Confirm no black frames, stutters, or timing glitches.
- [ ] Confirm final file name/path and timestamp are updated.

## Release Gate

Pass when all mode clips are action-heavy, no countdown appears, and endcard is present.

Block release if any clip is mostly static, incorrectly framed, or trailer assembly fails.
