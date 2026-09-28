# Mi Note · PI-Desktop Plugin

Turn your Xiaomi Cloud notes into a graphical work panel inside PI-Desktop,
and let AI read and write them directly.

**Everything is built in — no MCP server to configure.**

[中文](README.md) · [Developer docs](CONTRIBUTING.md)

---

## Install

Download [`dist/pi.mi-note-0.1.1.piplug`](dist/pi.mi-note-0.1.1.piplug) from this repo
and install it from the PI-Desktop plugins page. Also available under [Releases](../../releases).

## Getting started

1. Search "Mi Note" in the command palette and open the panel.
2. The panel shows a QR code — scan it with your phone
   (Settings → Xiaomi Account → Scan) and confirm.
3. Sign-in and the first sync complete automatically.

**No password required**, and it is unaffected by captcha or two-step verification.

---

## Features

**QR sign-in** — confirm on your phone. The code is valid for 5 minutes; refresh it if it expires.

**One-click sign-out** — "Sign out" in the top-right clears local credentials and cache after
confirmation, and drops you straight back to the QR screen. Cloud notes are untouched and sync
back after signing in again. The current version number is shown in the same corner.

**Two-pane layout** — note list on the left, body on the right. Folders live in a dropdown
at the top of the list pane, leaving vertical space for notes. Light/dark follows the host theme.

**Note management** — browse, search (title and body), create, edit (Markdown with preview), delete.

**Autosave** — no need to hit save; changes are stored 1.5 s after you stop typing.
Switching notes flushes the draft first, so **nothing is lost**. IME composition is never
saved mid-input, so pinyin never reaches the cloud.

**Undoable delete** — the note disappears immediately and a 6-second "Undo" window appears.

**AI Q&A** — answers from your notes using the model already signed in to PI-Desktop.
The plugin never sees any API key, and only retrieved snippets are sent as context.

**Auto sync** — incremental sync every 5 minutes, re-fetching only changed bodies.
Expired credentials are refreshed silently, so no manual cookie copying.

### Sidebar

A compact note list in the right-hand work panel:

- Click a title to read the full note inline
- The button on each row opens it in the main panel and scrolls to it
- "Copy full text" at the top of the reader, handy for pasting into a chat

### AI can operate your notes

Ten built-in tools let the AI read, search, create, update and delete notes — no setup needed.

---

## FAQ

**Does this leak my notes?**
No. The plugin only talks to `i.mi.com` / `account.xiaomi.com`. Locally it writes only to its
own data directory and never touches your workspace files. AI Q&A sends only retrieved
snippets to the model already signed in to the host.

**Is my password safe?**
The plugin never sees it. Sign-in is confirmed on your phone, and credentials are stored
with 0600 permissions in the plugin's private directory.

**Which platforms are supported?**
Whatever PI-Desktop supports: desktop (Windows / macOS / Linux).

---

## Developers

Want to modify the code or build it yourself? See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

The login protocol and API behaviour were informed by these projects:

- [`ceynri/mi-note-cli`](https://github.com/ceynri/mi-note-cli)
- [`ceynri/mi-note-export`](https://github.com/ceynri/mi-note-export)
