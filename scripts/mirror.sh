#!/usr/bin/env bash
# Refresh the durable bare mirror that local installs point at.
#
# `git+file://` installs pin a commit inside a bare repository; if that
# repository disappears the profile's dependency spec becomes unfetchable.
# The mirror lives next to the working tree and is rebuilt from it after
# every publish, so `pnpm install` in the profile keeps working.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
mirror="${1:-$(dirname "$root")/dsh-market.git}"

rm -rf "$mirror"
git clone -q --bare "$root" "$mirror"
printf 'mirror: %s\ncommit: %s\n' "$mirror" "$(git -C "$mirror" rev-parse HEAD)"
