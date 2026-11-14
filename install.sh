#!/usr/bin/env bash
# Install a mod from this repo into ~/.config/herdr-app/mods/
#
# Usage: ./install.sh <mod-name>
#
# Example:
#   ./install.sh kilo-status      # installs kilo-status/mods/kilo-status/
#
# Each <name>/mods/<name>/ folder is copied (not linked) because Herdr does not
# hot reload a mod whose folder is a symlink.
set -euo pipefail

MODS_DIR="$HOME/.config/herdr-app/mods"
mkdir -p "$MODS_DIR"

NAME="${1:-kilo-status}"
DIR="./$NAME/mods/$NAME"

if [ ! -d "$DIR" ]; then
  echo "No mod found at $DIR" >&2
  echo "Usage: $0 <mod-name>" >&2
  exit 1
fi

echo "Installing $NAME -> $MODS_DIR/$NAME"
cp -R "$DIR" "$MODS_DIR/$NAME"

if command -v herdr-app >/dev/null 2>&1; then
  herdr-app check "$MODS_DIR/$NAME" || true
fi

echo "Done. Restart the agent terminals so their plugins load."
