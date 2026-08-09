#!/usr/bin/env sh
# Thin wrapper: the installer logic lives once, in install-skills.mjs.
# Accepts the same flags: --force, --config <path>.
dir="$(cd "$(dirname "$0")" && pwd)"
exec node "$dir/install-skills.mjs" "$@"
