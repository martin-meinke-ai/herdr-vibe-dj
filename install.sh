#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="all"
for arg in "$@"; do
  case "$arg" in
    --cli-only) MODE="cli" ;;
    --ui-only)  MODE="ui" ;;
    -h|--help)
      cat <<EOF
Usage: ./install.sh [--cli-only | --ui-only]

  (default)   Install both the CLI (~/.local/bin/herdr-spotify) and Herdr mods (~/.config/herdr-app/mods/)
  --cli-only  Install only ~/.local/bin/herdr-spotify (use on a remote Linux workstation)
  --ui-only   Install only Herdr UI mods + keybindings (use on a Mac running Herdr UI)
EOF
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ "$MODE" == "all" || "$MODE" == "cli" ]]; then
  mkdir -p "$HOME/.local/bin"
  install -m 755 "$REPO_DIR/bin/herdr-spotify" "$HOME/.local/bin/herdr-spotify"
  echo "✓ Installed CLI: $HOME/.local/bin/herdr-spotify"
fi

if [[ "$MODE" == "all" || "$MODE" == "ui" ]]; then
  HERDR_DIR="$HOME/.config/herdr-app"
  mkdir -p "$HERDR_DIR/mods/vibe-dj" "$HERDR_DIR/mods/vibe-dj-status"
  cp -f "$REPO_DIR/mods/vibe-dj/mod.json" "$REPO_DIR/mods/vibe-dj/main.js" "$HERDR_DIR/mods/vibe-dj/"
  cp -f "$REPO_DIR/mods/vibe-dj-status/mod.json" "$REPO_DIR/mods/vibe-dj-status/main.js" "$HERDR_DIR/mods/vibe-dj-status/"
  echo "✓ Installed Herdr mods: vibe-dj, vibe-dj-status"

  # Wire keybindings (cmd-shift-m / ctrl-alt-m) without clobbering existing bindings
  KEYS_FILE="$HERDR_DIR/keys.json"
  python3 - "$KEYS_FILE" <<'PY'
import json, shutil, sys
from pathlib import Path

keys_path = Path(sys.argv[1])
if keys_path.exists():
    shutil.copy2(keys_path, keys_path.with_suffix(".json.bak"))
    data = json.loads(keys_path.read_text(encoding="utf-8"))
else:
    data = {}

if not isinstance(data, dict):
    sys.exit(0)

# Support both flat {"global": {...}} and top-level binding dicts
target = data.get("global") if isinstance(data.get("global"), dict) else data
changed = False
for k in ("cmd-shift-m", "ctrl-alt-m"):
    if k not in target:
        target[k] = "mod.open:vibe-dj"
        changed = True

if changed:
    keys_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"✓ Added keybindings (cmd-shift-m, ctrl-alt-m -> mod.open:vibe-dj) to {keys_path}")
else:
    print(f"• Keybindings already present in {keys_path} (left untouched)")
PY

  if command -v herdr-app >/dev/null 2>&1; then
    herdr-app check "$HERDR_DIR/mods/vibe-dj" >/dev/null && echo "✓ herdr-app check passed: vibe-dj"
    herdr-app check "$HERDR_DIR/mods/vibe-dj-status" >/dev/null && echo "✓ herdr-app check passed: vibe-dj-status"
  fi
fi

cat <<'EOF'

Next steps:
  1. Reload or restart Herdr.
  2. Press Cmd+Shift+M (macOS) or Ctrl+Alt+M (Linux) to open Vibe DJ.
  3. Follow the README "Connect Spotify" steps to paste your Spotify Client ID & sign in.
  4. Optional: add the status bar pill + background Auto-DJ runner ("mod": "vibe-dj-status")
     to your Herdr layout JSON (see README.md).
EOF
