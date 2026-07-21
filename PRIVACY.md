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

**Your Google Calendar, read-only.** When you connect a Google account, the
extension requests the `https://www.googleapis.com/auth/calendar.readonly`
OAuth scope and nothing else. With that scope it fetches, directly from your
browser to Google's servers:

- Your calendar list — for each calendar: its ID, its name, the name you
  renamed it to if you did, whether it is your primary calendar, your access
  level to it, whether it is currently checked in Google Calendar, and whether
  it is hidden or deleted. This is the list you choose from, so the extension
  has to read the names of calendars you never switch on. It does not read
  their contents.

  Access level is read because a calendar shared with you as free/busy only
  returns events with no titles at all — the extension needs to know that in
  order to tell you, rather than showing you an empty list.

  The calendar list is requested including calendars you have hidden from your
  Google Calendar sidebar. Hiding a calendar there is a display preference, not
  an unsubscribe: if the extension could not see it, a calendar you had switched
  on here would quietly stop counting, and it would vanish from the settings page
  so you could not switch it back off either. A hidden calendar is still only
  read if you switched it on, and it is labelled as hidden on the settings page.
  Deleted calendars are read only so they can be discarded.

- Events, only on the calendars you switch on — each event's title, start time,
  end time, and cancellation status. Switching a calendar on is what causes it
  to be read; switching it off means it is never opened.

It does not request event descriptions, locations, attendees, attachments,
reminders, or any calendar outside the ones you've pointed it at. The
extension's code only ever issues `GET` requests to
`https://www.googleapis.com/calendar/v3/*`; it contains no code path that
writes, creates, updates, or deletes anything on your Google Calendar.

## Where that data goes

Nowhere but your own browser. Fetched calendar data (event titles, times, and
which calendar they came from) is cached in `chrome.storage.local` — Chrome's
local, on-device storage for this extension — so the tradeboard overlay can
score shifts without refetching on every page paint. Your calendar-matching
settings (which patterns identify a commitment vs. a soft conflict) are stored
the same way.

None of this is transmitted to any third party or to any server operated by
this project's authors. The extension has no backend: there is no analytics
SDK, no crash reporting, no telemetry, and no remote logging of any kind. The
only two network destinations the extension ever talks to are the
WhenToWork domain you're already on and Google's Calendar API — both
initiated directly from your browser.

The extension does not read this data out loud, either: its optional debug
logging is disabled by default, and even when a developer enables it locally,
it is written to prevent event titles or other calendar content from ever
reaching the console — only counts and status codes are logged.

## Revoking access

Uninstalling the extension (`chrome://extensions`) stops all fetching
immediately. To fully revoke the Google account access it was granted —
recommended if you no longer want it able to read your calendar even in
principle — remove it from your Google Account's third-party access list at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).
Uninstalling alone clears Chrome's local copy of the access token but does not
by itself revoke the grant on Google's side; the account permissions page is
the authoritative way to cut access.

## Changes to this policy

If what the extension accesses or how it stores data changes, this file will
be updated in the same commit as the code change, so its history in this
repository's version control is the changelog.
