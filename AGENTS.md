# Medic Tradeboard — Chrome extension (public)

Read-only Chrome MV3 overlay for a WhenToWork monthly tradeboard. Scores each posted
medic shift against the user's own Google Calendar commitments and renders a ranked
drawer. Every user signs in with their own Google account and picks their own calendars.

> This is the canonical agent doc (the [AGENTS.md](https://agents.md) standard).
> `CLAUDE.md` is a symlink to this file, so Claude Code and every other tool read the
> same source. Edit this file, never a copy.

**This repository is public.** It is built to be published to GitHub and the Chrome Web
Store. That inverts the most important rule from its private predecessor — read the Hard
rules before adding any file.

## Hard rules

- **NEVER commit real board data.** No live WhenToWork HTML captures, no real coworker
  names, no real shift postings, no screenshots showing them. Test fixtures must be
  synthetic or run through the scrubber. Git history is permanent — a leak cannot be
  fixed by deleting the file later.
- **NEVER commit personal calendar identity.** No real calendar IDs, no email addresses,
  no family or coworker names, no employer-specific defaults. Everything user-specific is
  runtime config.
- **NEVER pick up, request, or accept a shift.** The extension is read-only toward W2W and
  has no login code — it reads the page the user is already authenticated on. The user
  acts in W2W themselves.
- **NEVER commit `key.pem`.** It is the extension signing key. Gitignored; keep it that way.
- **Read-only toward Google.** Scope is `calendar.readonly`. Only ever GET from
  `https://www.googleapis.com/calendar/v3/*`; never write to any Google API.
- **Any UI change needs a mockup approved before building** (standing rule). Build must
  then match the approved mockup.

## Layout

    core/       pure logic, no DOM and no chrome.* — unit tested
    content/    content scripts injected into the W2W page
    ui/         the drawer (shadow DOM) + its stylesheet
    sw.js       service worker: owns ALL Google OAuth and calendar fetching
    test/       node:test suites + the offline drawer harness

Only `sw.js` touches `chrome.identity` or the Google API. The drawer receives everything
through `state` and must never read `chrome.storage` directly.

## Commands

    node --test 'test/*.test.js'     # offline test suite (365 tests)
    bash scripts/ci/gate.sh          # full gate (lint + slop + guards + tests)
    bash scripts/ci/gate.sh --fast   # instant checks only (pre-commit)

Enable the git hooks once per clone: `git config core.hooksPath .githooks`
(pre-commit runs the fast gate + the staged-manifest key guard; pre-push runs the full gate).

## Gates

Deterministic guardrails around the code, run locally by the hooks and in CI by
`.github/workflows/ci.yml` (on every PR and push to `main`):

- **eslint** — a cyclomatic-`complexity` ceiling (≤20) on `core/*.js`; behaviour is pinned
  by the node tests, not by lint. Run via `npx` (no `node_modules` committed).
- **slopcheck** — `scripts/ci/slopcheck.js` scans this repo's prose/source for LLM-"slop"
  tells (`scripts/ci/banned-words.txt`).
- **manifest key guard** — the committed `manifest.json` must carry no `key` field (it
  pins the extension id; `tools/check-no-key.sh` guards the staged copy at commit time).
- **capture guard** — no raw board capture (`tb_*`, `drop_*`, …) may be tracked; scrubbed
  fixtures are `board-*.anon.html`.
- **node --test** — the 365-case offline suite.

## Notes

- Calendar roles are per-user config: each calendar is OFF (never fetched), FLAG (annotates
  a shift), REJECT (blocks a shift), or RULE (a user regex splits it into reject vs flag).
- The scoring rules (buffer, tour, Day/Night boundary) are shared by every user of the
  board and stay in code. Calendar *identity* is the only thing that is per-user.
- This project descends from a private single-user repo that also contains a Python
  pipeline and real board fixtures. That repo stays private and is not a dependency — do
  not add references to it, and do not copy fixtures from it unscrubbed.
