# Medic Tradeboard

A Chrome extension that overlays a WhenToWork monthly tradeboard and scores
every posted shift against your own Google Calendar — so you can see, at a
glance, which open shifts you could actually take and which ones conflict
with something you're already committed to.

It is **read-only** in both directions:

- Toward WhenToWork: it only reads the tradeboard page you're already logged
  into. It has no login code of its own and never picks up, requests, or
  accepts a shift for you — you still do that in W2W yourself.
- Toward Google: it requests the `calendar.readonly` scope and only ever
  issues `GET` requests. It never creates, edits, or deletes a calendar event.

See [`PRIVACY.md`](PRIVACY.md) for the full data-handling policy.

## What it does

On a supported tradeboard page, the extension:

1. Reads the posted shifts directly from the page DOM.
2. Fetches your connected Google Calendar(s) (cached locally, refreshed
   periodically).
3. Scores each open shift: does it overlap something you're already
   committed to? Is it too close to another commitment to leave a realistic
   gap to work it?
4. Renders a ranked drawer over the page — eligible shifts sorted by score,
   rejected shifts collapsed with their reason, and a compose tool that
   builds a plain-text "Available Medic Shifts" message from the ones you
   check off (date-sorted lines like `* Th Jul 23, D 7am-7pm`). There's no
   `sms:` link and no recipient — it's copy-to-clipboard only, so nothing is
   ever auto-sent.

Shifts are classified Day when their start time falls in `[07:00, 19:00)` and
Night otherwise; that split drives the drawer's pills, filters, and the
compose tool.

Nothing here is specific to one person's schedule. Every user signs in with
their own Google account and points the extension at their own calendars.

## How calendar roles work

You decide what each of your calendars means to the scorer. Conceptually,
every calendar you connect plays one of four roles:

| Role | Effect |
|------|--------|
| **OFF** | Never fetched. The extension ignores it completely. |
| **FLAG** | Soft signal only. Events on this calendar annotate a shift (e.g. "you also have X that day") but never block it. |
| **REJECT** | Hard commitment. Any shift overlapping an event here is rejected outright. |
| **RULE** | A pattern you supply splits this calendar's events between REJECT and FLAG — for example, "events starting with 'On-Duty' are hard commitments; everything else on this calendar is just a flag." |

Today, the options page exposes the RULE role's split as two pattern fields —
an include regex and a comma-separated exclude list — plus the label shown on
a rejected shift ("Commitment" by default; set it to whatever you call the
thing that blocks you). A full per-calendar picker in the UI is planned; the
role concept above is the target design and the mental model to use when
configuring what's there now.

The include pattern can never be left blank: an empty regex matches every
event title, which would turn a RULE calendar into a blanket block on every
shift, so a blank value is reset to the default at both save and read time.

## Install (from source)

There is no Chrome Web Store listing yet. To run it locally:

1. Clone this repository.
2. Go to `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select the repository's root directory (the one with
   `manifest.json` in it).
4. Note the extension ID Chrome assigns. Because `manifest.json` pins a
   signing key (`key.pub.txt`), this ID is deterministic — the same for
   everyone who loads this exact code — and you'll need it for the OAuth
   setup below.

## Connect a Google Calendar

Calendar access uses OAuth, not a bundled secret, so it needs a one-time setup
per deployment:

- **Once published to the Chrome Web Store**, the extension will ship with a
  verified OAuth client ID and this step goes away — you'll just click
  **Connect calendar** in the drawer and approve the consent screen.
- **Running from source today**, `manifest.json`'s `oauth2.client_id` is a
  placeholder (see the `TODO` in that file) and calendar access won't work
  until you supply your own:
  1. In [Google Cloud Console](https://console.cloud.google.com), create or
     select a project, then enable the **Google Calendar API**.
  2. Under **APIs & Services → OAuth consent screen**, configure an External
     app in Testing mode, add the `calendar.readonly` scope, and add your own
     Google account as a test user.
  3. Under **Credentials**, create an OAuth client of type **Chrome
     Extension**, using the extension ID from the install step above as the
     Application ID.
  4. Paste the resulting client ID into `manifest.json`'s `oauth2.client_id`,
     reload the extension, then click **Connect calendar** in the drawer and
     approve the consent screen once.

Once connected, open the extension's **Options** page to tune which calendar
events count as commitments vs. soft flags (see "How calendar roles work"
above).

## Layout

    core/       pure scoring/parsing logic — no DOM, no chrome.* — unit tested
    content/    content scripts injected into the tradeboard page
    ui/         the drawer (shadow DOM) + its stylesheet
    sw.js       service worker — owns all Google OAuth and calendar fetching
    options/    the extension's settings page
    test/       node:test suites + an offline drawer harness

Only `sw.js` touches `chrome.identity` or the Google Calendar API. The drawer
receives everything through a plain `state` object and never reads
`chrome.storage` directly.

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
