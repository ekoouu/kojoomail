<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark-en.jpg">
  <img alt="Kojoo Mail: all your mailboxes, one inbox" src="docs/images/hero-light-en.jpg">
</picture>

<p align="center">
  <a href="README.md">简体中文</a> · <b>English</b>
</p>

<p align="center">
  <a href="https://github.com/ekoouu/kojoomail/releases/latest"><b>Download</b></a> ·
  <a href="#features">Features</a> ·
  <a href="#privacy">Privacy</a> ·
  <a href="#build-from-source">Build from source</a>
</p>

<p align="center">
  <img alt="Windows 10/11" src="https://img.shields.io/badge/Windows-10%20%2F%2011-1B4A80?style=flat-square">
  <img alt="macOS 11+" src="https://img.shields.io/badge/macOS-11%2B%20·%20Apple%20silicon%20%2F%20Intel-1B1712?style=flat-square">
  <img alt="License AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-C63E1F?style=flat-square">
  <img alt="Tauri 2 + Rust" src="https://img.shields.io/badge/Tauri%202-Rust%20%2B%20React-6B5F4E?style=flat-square">
</p>

---

You switch between a personal inbox, a work account, Gmail and Outlook all day. Important inquiries get buried under notifications and newsletters, and every reply in another language means translating first and polishing after. **Kojoo Mail puts all of that in one window**: mail from every account in one timeline, and an AI that reads each message first and tells you which ones matter, what needs doing, and how you might reply.

It is a desktop app, and your mail stays on your own computer. The AI uses your own API key and never goes through our servers.

> **Language:** the interface is available in English and Simplified Chinese. It follows your system language, and you can switch it in Settings → General. With the English interface, AI summaries, key facts, to-dos and the daily digest are written in English; suggested replies follow the language of the incoming email.

## Features

### One inbox for every mailbox

Gmail, Outlook, iCloud, QQ Mail, NetEase 163/126, company mail and any account that supports IMAP. All accounts share one timeline, each with its own color. Replies go out from the address the email was sent to, so you never answer from the wrong account.

Gmail and Outlook support **one-click sign-in** (you authorize in the browser; no password to type). The app follows your system proxy when it connects to mail servers by default; if the system proxy is unreliable, you can enter your own proxy address or turn the proxy off in Settings → General → Proxy.

### AI notes: know what an email wants before you open it

<img alt="AI notes" src="docs/images/feature-ai-en.jpg">

The AI reads every new email and writes a note at the top:

- **A one-line summary** and a category: inquiry, to-do, bill, notification, newsletter, personal
- **Key facts as cards**: quantity, price, trade terms, payment terms, deadlines, all in one view instead of buried in a long email
- **To-dos**: anything the email asks you to do, listed with its due date
- **A suggested reply**, drafted in the sender's language (English in, English out); click "填入回复" (Use reply) to edit it
- **Translation**: click "Translate to English" above the body; the original layout and links are kept and you can switch back any time. It only runs when you click, and translations are cached

Notifications and newsletters are sorted by local rules without calling the model, so they cost you nothing.

### Daily digest: one page in the morning

<img alt="Daily digest" src="docs/images/feature-digest-en.jpg">

What to reply to, what to pay and what to follow up on today, plus a short AI-written overview. Back from a trip to hundreds of unread emails? Read this page first and you'll know where to start.

### Compose: the AI drafts, you decide

<img alt="Compose with AI" src="docs/images/feature-compose-en.jpg">

- Rewrite in a different tone (professional, friendly, concise), polish, translate, or cut it in half
- **Fact check**: compares your reply with the key facts of the incoming email and flags any quantity, term or date you missed
- Write in Markdown and it is formatted when sent; you can undo for a few seconds after clicking Send
- **The AI only drafts. It never sends anything for you.**

### To-dos: from your mail, back to your mail

<img alt="To-dos" src="docs/images/feature-todo-en.jpg">

To-dos the AI pulls out of your emails sit next to the ones you add yourself, grouped into today, this week and later. One click takes you back to the email they came from.

### And also

| | |
|---|---|
| **Important** | Emails you starred, plus the ones the AI thinks need attention soon |
| **Follow up** | Emails you sent more than 3 days ago that haven't had a reply |
| **Bills & invoices** | Bills, invoices and payment notices from every account in one place |
| **Snooze** | Put an email away and have it come back at the time you choose |
| **Conversation view** | Emails from the same thread collapse into one row; open it to read the whole thread in order. Reply, archive and delete still act on a single email (off by default; turn it on in Settings → General) |
| **Mail rules** | When new mail arrives in the inbox, move it to a folder, archive it, move it to spam, or mark it read or important, based on sender, recipient, subject or attachments. Rules run on your computer; they never delete mail or send anything |
| **Verification codes** | The notification shows the code directly, and you can copy it with one click when you open the email. Detected locally, never sent to AI |
| **Ask your mailbox** | Type a question in the search box, such as "What price did I quote Marco last time?", and the AI answers from your mail with sources |
| **Dark mode** | Follows the system or set it yourself; frosted-glass effect on Windows 11 |
| **Keyboard** | `J` `K` to move, `E` to archive, `R` to reply, `C` to compose, `Ctrl K` to search |

<img alt="Dark mode" src="docs/images/feature-dark-en.jpg">

### Light on resources

Installer size: about 3 MB on Windows and about 10 MB on macOS. The interface is drawn by the web view built into the operating system, so the installer doesn't carry a browser of its own.

Each account keeps a single connection, and the server pushes new mail to it, so the app doesn't keep checking. CPU use is close to zero when idle. Closing the window sends the app to the tray, where it keeps receiving mail and hands the interface's memory back to the system.

Memory in Windows Task Manager (the author's daily setup, Windows 11, measured November 2026):

| | Memory |
|---|---|
| Main process `kojoomail.exe` (mail sync, AI, local database) | 20–30 MB (about 20 MB after launch, about 30 MB after a full day) |
| Plus the interface processes (shown as Microsoft Edge WebView2), window open | about 110 MB |
| Plus the interface processes, minimized to the tray | about 40 MB |

## Privacy

- Mail, settings and to-dos are **stored only on your computer**. Passwords, sign-in tokens and AI keys go into the system credential store (Windows Credential Manager / macOS Keychain).
- The app only connects to: your mail servers, Google's or Microsoft's sign-in service when you use one-click sign-in, **the AI endpoint you configure**, and the update server.
- No accounts, no analytics, no ads.
- AI can be switched off per account; no email from that account is ever sent to a model.
- Full details: [privacy policy](https://mail.songxxai.com/kojoomail/privacy) (in Chinese)

## Setting up AI

Open Settings → AI & Models (设置 → AI 与模型), pick a provider and paste your own API key. Any OpenAI-compatible service works. DeepSeek, Qwen, Kimi and OpenAI are built-in presets; for any other compatible endpoint, including a model you host yourself, just enter its URL. There is a daily analysis limit that you can adjust.

Under "Custom instructions" you can describe your preferences, such as the tone of replies, how to address people and what to pay attention to. The AI takes them into account when it writes notes, drafts replies and follow-ups.

Kojoo Mail works fine without AI, too: then it's simply a clean, lightweight multi-account mail client.

### Use it from your own AI agent (MCP)

Turn on the switch in Settings → AI & models → External AI agents (MCP), then copy the config snippet shown there into the MCP settings of an agent such as Claude Desktop or Cursor. The agent can then search and read the mail and AI notes already synced to this computer.

- **Read-only**: it cannot send, delete or move email
- **Off by default**; mailboxes with "Allow AI" turned off stay invisible to the agent

## Download

Get the latest version from **[Releases](https://github.com/ekoouu/kojoomail/releases/latest)**:

| System | File |
|---|---|
| Windows 10/11 (64-bit) | `KojooMail_<version>_x64-setup.exe` |
| macOS 11 or later (Apple silicon and Intel) | `KojooMail_<version>_universal.dmg` |

The app tells you when a new version is available, and one click updates it.

> The macOS build isn't signed with an Apple Developer ID yet. The first time you open it, go to System Settings → Privacy & Security and click "Open Anyway".
> The Windows build isn't code-signed yet. If "Windows protected your PC" appears during installation, click "More info → Run anyway".

## Build from source

You need Node.js 20+, Rust (stable) and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm ci
npm run tauri dev                  # development mode
bash scripts/build-installer.sh    # Windows installer
bash scripts/build-mac.sh          # macOS (run on a Mac)
```

- One-click sign-in for Gmail and Outlook needs your own OAuth client IDs; see [docs/oauth-setup.md](docs/oauth-setup.md). It builds without them, and Gmail then signs in with an app password.
- **If you redistribute a modified build**: replace `pubkey` and `endpoints` under `plugins.updater` in `src-tauri/tauri.conf.json` with your own (generate a key with `tauri signer generate`), or remove that section. Otherwise your build will prompt users to update to the official version.
- The README screenshots are generated from demo data: `scripts/screenshots/`

| Directory | Contents |
|---|---|
| `src/` | Interface (React + TypeScript) |
| `src-tauri/` | Backend (Rust): IMAP/SMTP, sync, AI queue, local database |
| `design/` | Icon source files |
| `docs/` | Documentation and README images |
| `tests/` | Unit and end-to-end tests |
| `scripts/` | Build, icon and screenshot scripts |

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting.

See the [roadmap](https://github.com/ekoouu/kojoomail/issues/6) for what's planned and in progress, and [Releases](https://github.com/ekoouu/kojoomail/releases) for what changed in each version.

## Acknowledgements

Thanks to the [LINUX DO](https://linux.do) community, where this project was first shared and got its early feedback.

Thanks to everyone who has contributed code: [@Birdy0109](https://github.com/Birdy0109).

## License

[GNU AGPL-3.0](LICENSE). You are free to use, modify and distribute it. If you distribute a modified version, including running it as a network service for others, you must also publish its source under the AGPL. For closed-source use or a commercial license, contact eko@kojoo.co.
