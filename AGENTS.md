# Medic Tradeboard — Chrome extension (public)

Read-only Chrome MV3 overlay for a WhenToWork monthly tradeboard. Scores each posted
medic shift against calendar feeds the user subscribes and renders a ranked drawer.
There is NO sign-in: the source is read-only iCal (`.ics`) links the user pastes, or
`.ics` files they upload. Every user adds their own feeds and decides what each means.

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
- **NEVER commit personal calendar identity.** No real feed URLs, no calendar IDs, no
  email addresses, no family or coworker names, no employer-specific defaults. Everything
  user-specific is runtime config. A feed URL is a CREDENTIAL — it grants standing read
  access to a whole calendar, so it must never appear in a fixture, a test, a log, or a
  commit.
- **NEVER pick up, request, or accept a shift.** The extension is read-only toward W2W and
  has no login code — it reads the page the user is already authenticated on. The user
  acts in W2W themselves.
- **NEVER commit `key.pem`.** It is the extension signing key. Gitignored; keep it that way.
- **Read-only toward calendars.** Only ever GET a feed the user added, with credentials
  omitted; never write to any calendar. An OFF feed is never fetched at all.
- **Feed failure is LOUD, never silent.** A blocking-capable feed (REJECT/RULE) that does
  not load fails the whole refresh — scoring is withheld rather than run without it,
  because a missing commitment renders every shift as free. Notes-only (FLAG) feeds may
  degrade to a warning. Per-event parse failures skip that event and name it.
- **Any UI change needs a mockup approved before building** (standing rule). Build must
  then match the approved mockup.

## Layout

    core/       pure logic, no DOM and no chrome.* — unit tested
    content/    content scripts injected into the W2W page
    ui/         the drawer (shadow DOM) + its stylesheet
    sw.js       service worker: owns feed fetching, config, and the message API
    test/       node:test suites + the offline drawer harness

`core/ics.js` is the RFC 5545 parser — the safety-critical piece: it emits the same event
shape the old Google REST path did, so everything below `buildTriplet` is untouched. Only
`sw.js` fetches. The drawer receives everything through `state` and must never read
`chrome.storage` directly.

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

- Feed roles are per-user config: each feed is OFF (never fetched), FLAG (annotates a
  shift), REJECT (blocks a shift), or RULE (the ticked-title picker splits it into block
  vs note). Roles and every per-feed map are keyed by the feed's own id under `calRoles`
  and friends — the key names predate feeds and were re-keyed, not rebuilt.
- The scoring rules (buffer, tour, Day/Night boundary) are shared by every user of the
  board and stay in code. Feed *identity* is the only thing that is per-user.
- This project descends from a private single-user repo that also contains a Python
  pipeline and real board fixtures. That repo stays private and is not a dependency — do
  not add references to it, and do not copy fixtures from it unscrubbed.
