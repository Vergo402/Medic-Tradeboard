# Chrome Web Store — submission kit

Everything to paste into the Web Store developer dashboard for **Medic Tradeboard**.
Target visibility: **Unlisted** (link-only). This file is a dev doc — the packaging
script excludes all `*.md`, so it is never shipped in the extension.

Build the upload with:

    bash scripts/pack-extension.sh
    # → dist/medic-tradeboard-v<version>.zip  (keyless manifest, runtime files only)

---

## Store listing

**Name:** Medic Tradeboard

**Category:** Productivity

**Summary** (max 132 chars):
> See which open WhenToWork shifts you're free to take — each scored against your own read-only calendar feeds. No sign-in.

**Description:**
> Medic Tradeboard adds a read-only overlay to your WhenToWork monthly tradeboard. It reads the shifts already on the page, scores each one against the calendar feeds you subscribe, and shows a ranked drawer: which open shifts you're free to take, and which conflict with something you already have.
>
> How it works
> • It reads the tradeboard page you're already logged into. It has no login of its own and never picks up, requests, or accepts a shift for you — you still do that in WhenToWork yourself.
> • It reads only the read-only .ics calendar links you paste, or files you upload, with GET requests only. No sign-in, no OAuth, no Google Cloud project. It never creates, edits, or deletes a calendar event.
> • Everything is processed on your own machine. There is no account and no server, and nothing is transmitted to the developer.
>
> You decide what each feed means — block, note, or ignore, per event title — and a compose tool builds a plain-text list of the shifts you select. That list is copy-to-clipboard only; no message is ever sent for you.
>
> If a feed can't be refreshed, the drawer keeps scoring against your last sync and says so, rather than pretending every shift is free.
>
> Not affiliated with, or endorsed by, WhenToWork.

**Single-purpose statement** (Chrome requires one):
> Overlay a WhenToWork tradeboard with a read-only ranking of which open shifts fit the user's existing commitments, scored against calendar feeds the user adds.

---

## Permission justifications

Paste one per permission in the dashboard's "Privacy practices" tab.

**`storage`:**
> Saves your feed list and settings, and caches your calendars locally so the board scores instantly and keeps working if a feed is briefly unavailable. This data never leaves your device.

**Host access — `https://*.whentowork.com/*`:**
> Required to read the WhenToWork tradeboard page you are viewing and draw the ranking overlay on it. The extension only runs on WhenToWork tradeboard pages.

**Optional host access — `https://*/*` (requested one site at a time):**
> Calendar feeds can be hosted anywhere — Google, iCloud, Aladtec, an employer's own system — so the extension requests read access to a feed's site only at the moment you add that feed, and only to issue a read-only GET for its .ics file. It requests nothing until you paste a link, and each grant is a single origin you approve.

**Remote code:** None. All code is packaged; nothing is loaded or evaluated from a remote source.

---

## Data safety / privacy disclosures

**Privacy policy URL:** https://github.com/Vergo402/Medic-Tradeboard/blob/main/PRIVACY.md

**Does this item collect or use user data?**
> The extension accesses your calendar/schedule data (from the .ics feeds you add) and the WhenToWork page you are on, and processes them entirely on your device. It does **not** transmit this data to the developer or any third party, does **not** sell it, and has no analytics, tracking, or backend server.

**Data "collected" (sent off the device to the developer or a third party):** None.

**Data used locally:** Personal/schedule information — used only on-device to score shifts; stored in `chrome.storage.local`; never sent anywhere. The only network requests the extension makes are read-only GETs to the feed URLs you supply and to the WhenToWork pages you are already using.

---

## Assets checklist

- [ ] **Icon 128×128** — real icon (current is a placeholder). Pending design approval.
- [ ] Icons 48 and 16 (derived from the 128).
- [ ] **Screenshots** — 1280×800 (or 640×400), 1–5 images: the ranked drawer over a board, and the options/title-picker page. (Use synthetic/anonymized data — no real coworker names.)
- [ ] Small promo tile 440×280 — optional for Unlisted; skip unless wanted.

---

## Steps that are yours (account / payment / submit)

1. Register/verify a Chrome Web Store **developer account** and pay the one-time **$5** fee (I can't create accounts or pay).
2. In the dashboard: **New item** → upload `dist/medic-tradeboard-v0.1.0.zip`.
3. Paste the listing copy, permission justifications, and privacy disclosures above.
4. Upload the icon + screenshots.
5. Set visibility to **Unlisted**.
6. **Submit for review.** (Review is typically a few days.)

---

## Review-friction notes

- The **`https://*/*` optional host permission is broad** and reviewers commonly ask about it. The justification above is the answer (user-initiated, per-origin, read-only GET). We keep it broad so any `.ics` host works; narrowing it to a fixed list (Google/iCloud/…) would break less common providers. If review pushes back, the fallback is to enumerate the common calendar hosts and accept that niche hosts require the file-upload path instead.
- Keep **"WhenToWork"** out of the item *name* (it's a third-party trademark) — used only descriptively in the summary/description, with the "not affiliated" line. Already handled.
