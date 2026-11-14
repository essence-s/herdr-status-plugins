# Freebuff Status for Herdr

Freebuff (`freebuff`) terminals report their status to the [Herdr](https://herdr.dev) desktop app, so they show in its Agents panel as working, done, blocked or idle, with Freebuff's name and the conversation's first prompt.

Herdr only lists a terminal as an agent when its program reports a status with OSC 7501, and Freebuff doesn't ([CodebuffAI/freebuff#947](https://github.com/CodebuffAI/freebuff/issues/947)). Freebuff also has no plugin or hook API, so there is nothing to install inside it. This add-on fills the gap from the outside: a `freebuff` wrapper starts a small watcher that reads the chat log Freebuff already writes and reports the turn state to the terminal.

## Install

Needs Node 20 or later on your `PATH`, bash, macOS or Linux, and Freebuff.

First clone the repo and enter the mod folder:

```
git clone https://github.com/essence-s/herdr-status-plugins.git
cd herdr-status-plugins/freebuff-status
```

From that folder, copy the mod to Herdr and install the wrapper:

```
cp -R mods/freebuff-status ~/.config/herdr-app/mods/
node ~/.config/herdr-app/mods/freebuff-status/status.mjs install
```

`install` does two things:

- writes `~/.local/bin/freebuff`, a wrapper that finds the real `freebuff`, starts the watcher only inside a Herdr terminal, and then `exec`s the real binary;
- adds `freebuff` to `~/.config/herdr-app/programs.json` so Herdr's launcher knows it, with the robot glyph from `mods/freebuff-status/robot.svg` (the same icon Herdr uses for agents) and the name `Freebuff`.

If a different `~/.local/bin/freebuff` already exists, it is copied once to `freebuff.freebuff-status-backup` before the wrapper replaces it. Running `install` again changes nothing.

Restart Freebuff, or start a new `freebuff` in a Herdr terminal. Check it with:

```
node ~/.config/herdr-app/mods/freebuff-status/status.mjs doctor
```

`doctor` prints JSON: whether the mod and wrapper are installed, whether the wrapper matches this package, whether the program is registered, whether `~/.local/bin` is in `PATH`, where the real Freebuff is, and whether the current shell is inside Herdr.

## Uninstall

```
node ~/.config/herdr-app/mods/freebuff-status/status.mjs uninstall
rm -rf ~/.config/herdr-app/mods/freebuff-status
```

`uninstall` removes only a wrapper carrying this package's marker, and only a `freebuff` entry that still matches the one it wrote. A wrapper or program entry you edited is left alone unless you pass `--force`.

## What it does

| Freebuff event | Report to Herdr |
| --- | --- |
| the wrapper starts inside Herdr | `idle` (the terminal becomes an agent before the first turn) |
| `[send-message] Sending message with sdk run config` | `working` |
| `[message-queue] Processing next message from queue` | `working` |
| `Main prompt finished` | `done` |
| `Agent run cancelled by user (abort error)` | `done` with `msg=cancelled` |
| `ask_user` without an answer yet | `blocked` with `kind=question` and the question |
| `No authentication token found` / `Please run the login flow` | `blocked` with `kind=auth` and the message |
| `Error in AI SDK stream`, `startAgentRun error`, `finishAgentRun error` | `error` with the message |
| `Network error, retrying` / `Health check failed` during a turn | `working` with the retry message |
| Freebuff exits, or the wrapper is removed | `clear` (the terminal stops being an agent) |

Each report is `ESC ]7501;state=<state>:app=freebuff[:kind=<kind>][:title=<base64>][:msg=<base64>] ESC \`, written to the terminal the wrapper and Freebuff share (`/dev/tty`). `title` is the conversation's `firstPrompt` from `chat-meta.json`, or the project folder before the first message; `msg` is the short reason for a blocked, failed or cancelled turn. Both are single-line, control-character-free, and capped at the protocol's 192 and 2048 bytes.

Herdr shows an `idle` after `working` as **done** until you look at that terminal. A late `idle` does not erase a `done` or `error`.

### How it finds the right conversation

Freebuff writes one log per conversation under `~/.config/manicode/projects/<project>/chats/<timestamp>/log.jsonl`, and every line carries the process id. That id is not the TUI's: Freebuff spawns `~/.config/manicode/freebuff`, a child process, and that child writes the log. The wrapper passes its own pid (which `exec` hands to the TUI) to the watcher, and the watcher resolves the pid tree (`ps -eo pid=,ppid=`) and follows the chat whose log was written by any of them. That is exact even with several Freebuff panes open at once, and it keeps working when a session is resumed.

If no pid in the tree appears (an older log, or the first message has not been sent yet), the watcher waits 5 seconds and then falls back to the newest chat in the project. It keeps reading only new bytes of that log, so the cost does not grow with the conversation. The terminal becomes an agent immediately, before the chat exists: the watcher reports `idle` with the project name as soon as it starts.

## What it touches

- `~/.local/bin/freebuff` — the wrapper `install` writes.
- `~/.config/herdr-app/programs.json` — the `freebuff` program entry.
- `~/.config/manicode/projects/*/chats/*/log.jsonl` and `chat-meta.json` — read only.
- `~/.local/state/freebuff-status/watcher.log` — the watcher's stderr, so a crash never prints over the Freebuff UI.
- The old `~/.config/herdr-app/freebuff-watcher.js` from the first version of this mod, if it is still there and carries this package's marker.

Nothing else. The watcher reads no other files, makes no network requests, and does nothing outside a Herdr terminal (no `HC_TERMINAL_ID`).

## Turn it off

Set `FREEBUFF_HERDR_STATUS=0` (also `false`, `off`, `no`, `disabled`) in the environment Freebuff starts with. The wrapper and the watcher stay installed and do nothing.

## Limits

- It reads Freebuff's internal log messages, not a public API. A Freebuff update that renames them can break the mapping; `npm test` pins the ones this version knows.
- The login prompt and the `.agents` trust prompt only exist on screen, not in the log. They show as `idle` until the first message starts a turn.
- `done` means a turn finished. It is not a notification that the whole session ended.
- macOS and Linux only (it writes to a Unix tty, and the wrapper is bash).
- If `~/.local/bin` comes after the real Freebuff in `PATH`, the wrapper is never used. `doctor` reports `wrapperInPath: false`.
- No progress percentage or token count: the log does not expose a reliable one per turn.

## Development

```
npm test                 # node --test, no dependencies
herdr-app check mods/freebuff-status
```

The tests import the `.mjs` modules directly and use temporary folders, so they never touch a real terminal, a real log, or your Herdr config. `test/report.test.js` covers the OSC bytes and the dedupe, `test/log.test.js` covers the state machine and the incremental reader, and `test/status.test.js` covers install, uninstall and doctor against a temporary `HOME`.

`mods/freebuff-status/main.js` is an empty Herdr mod: it exists so the folder can be shared in the Herdr mod gallery, where the real work is the wrapper and the watcher that `status.mjs` installs.

## License

MIT
