#!/usr/bin/env sh
set -eu
editor_dir=$(cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$editor_dir/../scripts/abrir-editor.py" "$@"
