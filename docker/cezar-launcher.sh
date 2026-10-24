#!/bin/sh
# `cezar` and `cez` on PATH in the container (spec .ai/specs/2026-10-23-branch-channel-self-update.md
# §4.1): runs whatever the managed layout's `current` points at — the version the cockpit updated
# to — else the image's own install, so `docker compose exec cezar cezar auth setup` keeps working.
home=${CEZ_HOME:-/data/cezar}
entry=$home/versions/current/node_modules/@open-mercato/cezar/dist/index.js
if [ ! -f "$entry" ]; then
  for dir in /opt/cezar/*+image; do
    entry=$dir/node_modules/@open-mercato/cezar/dist/index.js
  done
fi
exec node "$entry" "$@"
