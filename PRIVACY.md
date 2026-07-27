# Privacy Policy — Medic Tradeboard

This is a Chrome extension you load into your own browser. It has no company,
no account system, and no server of its own. This page explains exactly what
it accesses and what it does with it.

## What the extension reads

**The tradeboard page.** On a WhenToWork tradeboard page, the extension's
content scripts read the shift-listing HTML that is already rendered in your
browser tab, using the session you are already logged into. It never handles
your WhenToWork username or password, and it never submits, claims, or
modifies anything on that page — it only reads.

**Calendar feeds you add yourself, read-only.** There is no sign-in. The
extension does not connect to a Google account, does not use OAuth, and cannot
browse your calendars. It reads exactly the feeds you paste in, and nothing
else. A feed is one of two things:

- **A subscription link** — the iCalendar (`.ics`) address your calendar
  provider gives you: Google's "secret address in iCal format", an Apple
  public-calendar or `webcal://` link, a department scheduling feed, or any
  other `.ics` URL. The extension fetches that one address over HTTPS with
  credentials omitted; nothing is sent with the request but the URL itself.

- **An uploaded `.ics` file** — a snapshot you export and hand over. This
  touches the network not at all. It stays exactly as uploaded until you
  replace it.

From either kind, the extension parses each event's **title, start time, end
time, and cancellation status**, plus the calendar's own display name and
timezone. It ignores descriptions, locations, attendees, attachments,
organizers, and reminders. It only ever issues `GET` requests, and contains no
code path that writes, creates, updates, or deletes anything on any calendar.

**A feed you have not switched on is never fetched at all.** Every feed starts
switched off, and the refresh loop skips an off feed before it makes any
request, so its contents never reach the extension.

## Your feed link is a password

Treat a subscription link like a credential, because that is what it is: anyone
holding that URL can read that calendar, indefinitely, without signing in.
The extension is built accordingly.

- The URL is stored only in `chrome.storage.local` — Chrome's local, on-device
  storage for this extension. It is **never** put in `chrome.storage.sync`, so
  it does not travel to your other machines through your Chrome profile.
- It is **never displayed again** after you add it. The settings page shows only
  the host it points at (for example `calendar.google.com/…`), so the secret
  cannot end up in a screenshot, a screen share, or a support message.
- It is never sent anywhere except to the calendar host itself, when fetching.

Because a link like this is a standing capability, **uninstalling the extension
does not revoke it.** See "Revoking access" below.

## Site permissions

The extension ships with access to WhenToWork only. When you add a URL feed,
Chrome asks you to grant access to that one site, at that moment, and the
extension holds nothing broader. Declining simply means that feed cannot be
read. An uploaded file needs no site permission whatsoever.

## Where that data goes

Nowhere but your own browser. Parsed calendar data (event titles, times, and
which feed they came from) is cached in `chrome.storage.local` so the
tradeboard overlay can score shifts without refetching on every page paint.
Your feed settings — which feed blocks, which event titles count as a
commitment, how many hours of rest each one needs — are stored the same way.

None of this is transmitted to any third party or to any server operated by
this project's authors. The extension has no backend: there is no analytics
SDK, no crash reporting, no telemetry, and no remote logging of any kind. The
only network destinations it ever talks to are the WhenToWork domain you're
already on and the feed hosts you added yourself — both initiated directly from
your browser.

The extension does not read this data out loud, either: its optional debug
logging is disabled by default, and even when a developer enables it locally,
it is written to prevent event titles or other calendar content from ever
reaching the console — only counts and status codes are logged.

## Revoking access

Removing a feed on the settings page deletes it and everything configured about
it, immediately and locally. Uninstalling the extension
(`chrome://extensions`) stops all fetching and clears its local storage,
including the stored links.

**If you want to be certain a link can never be used again — by this extension
or by anyone who obtained it — reset it at the calendar provider.** In Google
Calendar that is Settings › your calendar › "Reset" next to the secret address;
other providers have an equivalent. This is the only true revocation for a
subscription URL, because the link grants access on its own and does not depend
on the extension still being installed.

## Changes to this policy

If what the extension accesses or how it stores data changes, this file will
be updated in the same commit as the code change, so its history in this
repository's version control is the changelog.
