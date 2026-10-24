#!/bin/sh
# `cezar` and `cez` on PATH in the container (spec .ai/specs/2026-10-23-branch-channel-self-update.md
# §4.1): runs whatever the managed layout's `current` points at — the version the cockpit updated
# to — else the image's own install, so `docker compose exec -u node cezar cezar auth setup` keeps working.
home=${CEZ_HOME:-/data/cezar}
# As root these would leave a root-owned /data/cezar/source or versions/ entry that the server
# (node) can never write again — `serve` (also the bare command) its run markers. The entrypoint
# (CEZ_ENTRYPOINT=1) drops to node itself. Other commands are left alone.
case ${1:-} in
  update | install | use | link | serve | '')
    if [ "$(id -u)" = 0 ] && [ "${CEZ_ENTRYPOINT:-}" != 1 ]; then
      echo "cezar: run 'cezar ${1:-serve}' as node, not root: docker compose exec -u node cezar cezar ${*:-serve}" >&2
      exit 1
    fi
    ;;
esac
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
