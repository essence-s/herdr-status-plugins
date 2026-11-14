#!/usr/bin/env bash
# Copy mods from this repo into ~/.config/herdr-app/mods/
#
# Usage:
#   ./install.sh                       copy every mod
#   ./install.sh kilo-status           copy one mod
#   ./install.sh kilo-status freebuff-status
#
# Copying the folder is only the first step for a mod that installs something
# inside the agent. The script prints the exact `status.mjs install` command
# for those mods; run it afterwards.
set -euo pipefail

MODS_DIR="${HERDR_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app}/mods"
mkdir -p "$MODS_DIR"

names=("$@")
if [ ${#names[@]} -eq 0 ]; then
  for dir in */mods/*/; do
    [ -d "$dir" ] || continue
    names+=("$(basename "$dir")")
  done
fi

if [ ${#names[@]} -eq 0 ]; then
  echo "No mods found (expected <name>/mods/<name>/)." >&2
  exit 1
fi

for name in "${names[@]}"; do
  src="./$name/mods/$name"
  if [ ! -d "$src" ]; then
    echo "No mod found at $src" >&2
    echo "Usage: $0 [mod-name...]" >&2
    exit 1
  fi

  dest="$MODS_DIR/$name"
  rm -rf "$dest"
  mkdir -p "$dest"
  cp -R "$src/." "$dest/"
  echo "Installed $name -> $dest"

  if command -v herdr-app >/dev/null 2>&1; then
    herdr-app check "$dest" || true
  fi

  if [ -f "$dest/status.mjs" ]; then
    echo "  Next: node \"$dest/status.mjs\" install"
  fi
done

echo "Done. Restart the agent terminals so their mods load."
