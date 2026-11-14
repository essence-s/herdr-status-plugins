# herdr-status-plugins

Mods for the [Herdr app](https://herdr.dev): terminal status bridges for coding agents via OSC 7501.

Each folder is one mod, in the form that [herdr.dev/mods](https://herdr.dev/mods) lists: `<name>/mods/<name>/` is the mod, `<name>/README.md` tells how to install and use it, `RECIPE.md` (when there is one) is the brief an agent can rebuild it from, and `preview.png` shows it.

## Mods in this repo

| Mod | What it does | Needs |
| --- | --- | --- |
| [kilo-status](./kilo-status) | Kilo Code terminals report their status (working, done, blocked, idle) to Herdr's Agents panel via OSC 7501 | — |

![kilo-status](./kilo-status/preview.png)

## Install

```
./install.sh kilo-status
```

Or copy a mod folder by hand:

```
cp -R kilo-status/mods/kilo-status ~/.config/herdr-app/mods/
node ~/.config/herdr-app/mods/kilo-status/status.mjs install
```

The mods are copied, not linked, because Herdr does not load icons or hot reload a mod whose folder is a symlink. Each mod's README says how to use it.

## Add a mod

1. Make the folder `<name>/mods/<name>/` with `main.js` and `mod.json`.
2. Add `<name>/README.md`, and a `preview.png` and `RECIPE.md` when you can.
3. Add a row to the table above. If the mod imports another mod, write that mod under "Needs".

`install.sh <name>` finds the new mod with no change. A mod cannot import a file from another mod (`herdr-app check` refuses it), so a mod that needs code from another one keeps its own copy.

## Development

```
npm test                 # node --test, tests every plugin in the repo
herdr-app check kilo-status/mods/kilo-status
```

## Licence

MIT (`LICENSE`).
