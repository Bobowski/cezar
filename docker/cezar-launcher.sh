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
# The entrypoint's branch seed (§4.5) reaches only the supervised server; `docker compose exec`
# starts from the container's env, so seed it here too. The operator's own CEZ_UPDATE_* still win.
if [ -f /opt/cezar/source.json ]; then
  source_remote=$(jq -r '.remote // empty' /opt/cezar/source.json 2>/dev/null || true)
  source_branch=$(jq -r '.branch // empty' /opt/cezar/source.json 2>/dev/null || true)
  if [ -n "$source_remote" ] && [ -n "$source_branch" ]; then
    export CEZ_UPDATE_CHANNEL="${CEZ_UPDATE_CHANNEL:-branch}"
    export CEZ_UPDATE_BRANCH="${CEZ_UPDATE_BRANCH:-$source_remote#$source_branch}"
  fi
fi
exec node "$entry" "$@"
