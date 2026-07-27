# Medic Tradeboard

A Chrome extension that overlays a WhenToWork monthly tradeboard and scores
every posted shift against calendar feeds you subscribe — so you can see, at a
glance, which open shifts you could actually take and which ones conflict
with something you're already committed to.

It is **read-only** in both directions:

- Toward WhenToWork: it only reads the tradeboard page you're already logged
  into. It has no login code of its own and never picks up, requests, or
  accepts a shift for you — you still do that in W2W yourself.
- Toward your calendars: there is no sign-in at all. It reads only the
  read-only `.ics` feeds you paste in (or files you upload) and only ever
  issues `GET` requests. It never creates, edits, or deletes a calendar event.

See [`PRIVACY.md`](PRIVACY.md) for the full data-handling policy.

## What it does

On a supported tradeboard page, the extension:

1. Reads the posted shifts directly from the page DOM.
2. Fetches the calendar feeds you added and caches them locally. There is no
   background timer: a feed is read when you open the tradeboard, when you
   change a feed's settings, or when you click **Resync** — and a page load
   reuses a recent cache rather than re-fetching, so a feed host is never
   polled more than it needs to be.
3. Scores each open shift: does it overlap something you're already
   committed to? Is it too close to another commitment to leave a realistic
   gap to work it?
4. Renders a ranked drawer over the page — eligible shifts sorted by score,
   rejected shifts collapsed with their reason, and a compose tool that
   builds a plain-text "Available Medic Shifts" message from the ones you
   check off (date-sorted lines like `* Th Jul 23, D 7am-7pm`). There's no
   `sms:` link and no recipient — it's copy-to-clipboard only, so nothing is
   ever auto-sent.

If a feed fails to refresh, the drawer never silently pretends every shift is
free. It keeps scoring against the last good sync and shows an amber "showing
last sync" banner with a **Resync** button; only when there is no usable cached
data at all does it stop scoring and say so in red. A feed that answers with a
rate-limit is retried with backoff rather than treated as broken.

Shifts are classified Day when their start time falls in `[07:00, 19:00)` and
Night otherwise; that split drives the drawer's pills, filters, and the
compose tool.

Nothing here is specific to one person's schedule. Every user adds their own
feeds and decides what each one means.

## How calendar roles work

You decide what each of your feeds means to the scorer. Conceptually,
every feed you add plays one of four roles:

| Role | Effect |
|------|--------|
| **OFF** | Never fetched. The extension ignores it completely. |
| **FLAG** | Soft signal only. Events on this calendar annotate a shift (e.g. "you also have X that day") but never block it. |
| **REJECT** | Hard commitment. Any shift overlapping an event here is rejected outright. |
| **RULE** ("only some events") | You hand-pick, per event title, what each one means: **Block** (a hard commitment), **Note** (a soft flag), or **Ignore**. Everything you don't mark is ignored, so the calendar stays quiet by default. |

For a RULE feed, the options page shows a **title picker**: every event title on
that calendar, grouped into **Recurring** and **One-time** sections and sorted
alphabetically, each with a Block / Note / Ignore control and an optional "show
as" label. When a sync surfaces a title you have never reviewed, the drawer
raises a "new calendar events" nudge and the picker highlights it with a **NEW**
badge, so a new kind of commitment can't be silently scored as free. The picker
only lists titles with an upcoming instance, so stale one-off events from the
past don't clutter it.

An advanced regex hatch (an include pattern plus a comma-separated exclude list)
is still available for a RULE feed that has nothing ticked, but the picker is the
primary, recommended way to configure one. That legacy include pattern can never
be left blank — an empty regex matches every event title, which would turn a
RULE calendar into a blanket block on every shift, so a blank value is reset to
the default at both save and read time.

## Install (from source)

There is no Chrome Web Store listing yet. To run it locally:

1. Clone this repository.
2. Go to `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select the repository's root directory (the one with
   `manifest.json` in it).
4. Open the extension's **Options** page and add a feed.

## Add a calendar feed

No sign-in, no OAuth, no Google Cloud project — you paste a read-only calendar
link. Open the extension's **Options** page and either:

- **Paste a link.** In Google Calendar: Settings › the calendar › **Secret
  address in iCal format**. In Apple Calendar: share the calendar as public and
  copy its `webcal://` link. Any other `.ics` URL works too. Chrome will ask you
  to grant access to that one site.
- **Upload an `.ics` file.** No site permission and no network — useful when a
  provider gives you an export but no link. It is a snapshot, so re-upload it
  when your schedule changes.

Name the feed, choose what it means (see "How calendar roles work" above), and
add it. The feed is fetched and parsed immediately, so a bad link fails right
there rather than silently leaving the board unscored.

> Treat a subscription link like a password: anyone holding it can read that
> calendar. It is stored on this machine only, never synced, and never shown
> again — see [`PRIVACY.md`](PRIVACY.md), including how to revoke one.

## Layout

    core/       pure scoring/parsing logic — no DOM, no chrome.* — unit tested
    content/    content scripts injected into the tradeboard page
    ui/         the drawer (shadow DOM) + its stylesheet
    sw.js       service worker — owns feed fetching and .ics parsing
    options/    the extension's settings page
    test/       node:test suites + an offline drawer harness

Only `sw.js` fetches a feed; `core/ics.js` is the pure parser it hands the
bytes to. The drawer receives everything through a plain `state` object and
never reads `chrome.storage` directly.

## Tests

    node --test 'test/*.test.js'

This is the full offline suite — no network, no browser, no W2W session
required.

There's also a standalone drawer-fidelity harness with no extension APIs
beyond a `chrome.runtime.getURL` shim: serve the repository root over HTTP
(e.g. `python3 -m http.server 8123`) and open
`http://localhost:8123/test/harness/drawer-harness.html`. It feeds the drawer
synthetic rows and rejects covering the Day/Night boundary cases (07:00,
07:30, 19:00, 23:00, 00:00), and has buttons to replay scan-progress repaints
and to simulate a shift dropping off the board. It needs an HTTP server
because it loads ES modules — `file://` won't work.

## Contributing

This project descends from a private, single-user prototype. If you're
porting logic in from somewhere else, make sure it's genuinely general — no
hardcoded calendar IDs, employer names, coworker names, or one person's
station/shift-code vocabulary. Test fixtures must be synthetic.
