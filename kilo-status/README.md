# Kilo Status for Herdr

Kilo Code (`kilo`) terminals report their status to the [Herdr](https://herdr.dev) desktop app, so they show in its Agents panel as working, done, blocked or idle, with Kilo's name and icon.

Herdr only lists a terminal as an agent when its program reports a status with OSC 7501, and Kilo doesn't ([Kilo-Org/kilocode#14973](https://github.com/Kilo-Org/kilocode/issues/14973)). This add-on fills the gap with a small Kilo server plugin that writes the report to the terminal itself.

## Install

Needs Node 20 or later on your `PATH`, macOS or Linux, and Kilo 7.8 or later.

```
cp -R mods/kilo-status ~/.config/herdr-app/mods/
node ~/.config/herdr-app/mods/kilo-status/status.mjs install
```

Restart Kilo, or start a new `kilo` in a Herdr terminal. Check it with:

```
node ~/.config/herdr-app/mods/kilo-status/status.mjs doctor
```

`doctor` prints JSON: whether the plugin is installed, whether it matches this package, where Kilo's config folder is, and whether the current shell is inside Herdr.

## Uninstall

```
node ~/.config/herdr-app/mods/kilo-status/status.mjs uninstall
rm -rf ~/.config/herdr-app/mods/kilo-status
```

`uninstall` removes only a file carrying this package's marker. A file you edited is left alone unless you pass `--force`.

## What it does

| Kilo event | Report to Herdr |
| --- | --- |
| plugin loads | `idle` (the terminal becomes an agent before the first turn) |
| `chat.message`, `tool.execute.before/after`, `command.execute.before` | `working` |
| `session.status` `busy` / `retry` | `working` (`retry` adds the attempt and message) |
| `permission.asked` | `blocked` with `kind=permission` and the permission plus its patterns |
| `question.asked` | `blocked` with `kind=question` and the question |
| `session.error` `ProviderAuthError` | `blocked` with `kind=auth` and the message |
| other `session.error` | `error` with the message |
| `session.idle` | `done` |
| `session.deleted` | `clear` (the terminal stops being an agent) |
| plugin `dispose` / process exit | `clear` |

Each report is `ESC ]7501;state=<state>:app=kilocode[:kind=<kind>][:title=<base64>][:msg=<base64>] ESC \`, written to the terminal (`/dev/tty`, else a tty of this process, else the tty of the nearest parent process that has one). `title` is the Kilo session title, or the project folder before the first session; `msg` is the short reason for a blocked or failed turn. Both are single-line, control-character-free, and capped at the protocol's 192 and 2048 bytes.

Herdr shows an `idle` after `working` as **done** until you look at that terminal. A late `idle` from Kilo does not erase a `done` or `error`, and a sub-agent's `idle` does not finish its parent's turn.

## What it touches

- `~/.config/kilo/plugin/herdr-agent-state.ts` — the only file `install` writes. It also works with `$KILO_CONFIG_DIR` and `$XDG_CONFIG_HOME`; `status.mjs path` prints the exact path. If a different file is already there, it is copied to `herdr-agent-state.ts.kilo-status-backup` once before the plugin replaces it. Running `install` again changes nothing.
- Nothing else. The plugin reads no files, makes no network requests, and does nothing outside a Herdr terminal (no `HC_TERMINAL_ID`).

## Turn it off

Set `KILO_HERDR_STATUS=0` (also `false`, `off`, `no`, `disabled`) in the environment Kilo starts with. The plugin stays installed and does nothing.

## Limits

- Kilo loads server plugins at start: restart running sessions after installing or uninstalling.
- macOS and Linux only (it writes to a Unix tty).
- No progress percentage: Kilo doesn't expose one.
- `msg` and `title` are informative only; Herdr's status is the `state` word.
- If Kilo runs where no tty can be found (some CI or daemon setups), the plugin silently does nothing.

## Development

```
npm test                 # node --test, no dependencies
herdr-app check "$PWD/mods/kilo-status"
```

The tests import the TypeScript plugin directly (Node 22.18 or later) and use an injected writer, so they never touch a real terminal or your Kilo config.

The `mods/kilo-status/main.js` is an empty Herdr mod: it exists so the folder can be shared in the Herdr mod gallery, where the real work is the plugin that `status.mjs` installs.

## License

MIT
