#!/bin/sh
# `cezar` and `cez` on PATH in the container (spec .ai/specs/2026-10-23-branch-channel-self-update.md
# §4.1): runs whatever the managed layout's `current` points at — the version the cockpit updated
# to — else the image's own install, so `docker compose exec -u node cezar cezar auth setup` keeps working.
home=${CEZ_HOME:-/data/cezar}
# As root these would leave a root-owned /data/cezar/source or versions/ entry that the server
# (node) can never write again — `serve` (also the bare command) its run markers. No env var
# exempts root: the entrypoint never comes through here as root (it runs the entry as node itself).
# Other commands are left alone. The command is the first positional as index.ts's parseArgs sees
# it (`cezar --port 4322` is `serve`), so a flag that takes a value skips that value.
command= skip= rest=
for arg in "$@"; do
  if [ -n "$skip" ]; then skip=; continue; fi
  if [ -n "$rest" ]; then command=$arg; break; fi
  case $arg in
    --) rest=1 ;;
    -h | --help) command=help; break ;;
    -p | --port | --repo | --workflow | --model | --platform | --domain | --bind-host | --reconfigure | --channel | --version) skip=1 ;;
    -*) ;;
    *) command=$arg; break ;;
  esac
done
case $command in
  update | install | use | link | serve | '')
    if [ "$(id -u)" = 0 ]; then
      echo "cezar: run 'cezar ${command:-serve}' as node, not root: docker compose exec -u node cezar cezar ${*:-serve}" >&2
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
# starts from the container's env, so seed it here too — quietly: the entrypoint already said why not.
if [ -f /opt/cezar/source.json ]; then
  . /usr/local/lib/cezar/update-seed.sh
  seed_update_branch /opt/cezar/source.json quiet
fi
exec node "$entry" "$@"
