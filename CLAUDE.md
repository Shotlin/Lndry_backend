# CLAUDE.md

**Active cross-repo initiative: POS mode for the LNDRY Vendor App.**
The master plan, phase checklists, progress tracker and slash commands live in the Flutter repo:

- `../Lndry_vendor_app/CLAUDE.md` — rules (read first)
- `../Lndry_vendor_app/PROGRESS.md` — current state
- `../Lndry_vendor_app/docs/pos-mode/` — Master Plan + PHASE-1…4

If you were asked to continue this work, open `../Lndry_vendor_app` and run **`/pos-next`** there.
Branch for all repos: `claude/laundry-vendor-pos-modes-bs0o61`. `../epic-laundry-desktop` is reference-only — do not modify it.

Backend/dashboard changes for this initiative are small and listed per phase (backend: offering/onboarding endpoints, counter-order delivery flags,
dashboard aggregates; dashboard: vendor offering/plan control). Do not change other behavior; existing Epic POS clients must keep working.
