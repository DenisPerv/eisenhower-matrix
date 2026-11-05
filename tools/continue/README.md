# Continue in Claude: session scripts

The task window's **Continue in Claude** button (web only) links to `homeos-claude://continue?sid=<uuid>&ref=<slug>%23<num>`. These scripts handle that link on a person's own Windows PC: they open a copy of the task's latest Do, else Plan, Claude Code session in the Claude app. The original session stays as it was. Nothing here is published to the hosts.

| File | What |
|---|---|
| `continue-handler.ps1` | what Windows runs for the link. Matches the whole link against one strict pattern, then passes the id and the reference on as separate arguments |
| `continue-handler.mjs` | checks, then the copy. Dependency-free Node; `cli/lib.mjs` only for the optional lease check |
| `install-continue-handler.ps1` | registers the link for this Windows user: one key, `HKCU\Software\Classes\homeos-claude`. `-Show` writes nothing, `-Uninstall` removes it |

## Install

Needs Node, the Claude app and the Claude Code CLI. `-ProjectDir` is the folder the sessions ran in: Claude Code finds a session's transcript by that folder.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/continue/install-continue-handler.ps1 -ProjectDir "D:\path\to\project" [-EnvFile "D:\path\to\.env"] [-As homeos-agent]
```

With `-EnvFile` (the login env file of `cli/`), the handler also refuses a task that a session still holds. Without it, that check is skipped. A browser may ask before it opens the link. Without the handler a click does nothing, and the icon beside the button copies `claude --resume <sid> --fork-session`: run it in the project folder, then type `/desktop`.

Where the sessions come from: `items.ai.sessions`, written by whatever runs agents on the board, as `{ session_id, role, name, at }`.

## How the copy is made

`claude --desktop` refuses `--fork-session` (tested on CLI 2.1.311), so two steps: `claude -p --resume <sid> --fork-session` makes the copy with one first message, which costs one Claude request at that session's context, then `claude --desktop --resume <new id>` opens it. If the first step fails, the window gives the plain command.

## Refusals, shown in the handler's window

| Exit | Means |
|---|---|
| 0 | opened |
| 2 | the link or the arguments are not valid; nothing ran |
| 3 | the session is still running (a `Runs/*/spawn-*.json` record in the project folder, if it has any), or a session holds the task |
| 4 | a second click on one session within 30 seconds |
| 5 | the transcript is not on this machine: start fresh from the task |
| 6 | the copy or the opening failed; the window gives the command |

## Troubleshooting

- **A click does nothing:** the handler is not installed, or the browser's prompt was refused.
- **Exit 5 for a session you know exists:** `-ProjectDir` is not the folder it ran in. Install again with the right one.
- **Tests:** `test/continue-handler.test.js` (no network, no Claude session).
