#!/bin/sh
# cezar in a container — start-up (spec .ai/specs/2026-10-10-cezar-in-a-container.md).
#
# Runs as root for three things: making the volumes writable by `node`, starting the container's
# own Docker daemon, and supervising cezar (docker/supervise.sh — an update restarts the cezar
# process, never the container). Everything it starts — cezar, its agents, every terminal — is `node`.
set -eu

mkdir -p /data/cezar/versions /data/claude /data/codex /data/gh /data/ssh /data/bin /data/npm /projects
chmod 700 /data/ssh
# Top level only: a volume that already holds a hundred thousand files is not re-owned on boot.
# /data/bin and /data/npm are where tools installed from the terminal live (spec 2026-10-23 §4.6).
chown node:node /data /data/cezar /data/cezar/versions /data/claude /data/codex /data/gh /data/ssh /data/bin /data/npm /projects

# A project's services (its docker-compose.yml) run on a daemon INSIDE this container, so
# `localhost:5432` means the same thing to the app as it does on a developer's machine, and a
# bind mount in the compose file names a path that exists. That needs `privileged: true`.
# Without it the daemon cannot start; cezar still runs, and says here what is missing.
if [ "${CEZ_DOCKER:-1}" != "0" ]; then
  rm -f /var/run/docker.pid
  dockerd >/var/log/dockerd.log 2>&1 &
  tries=0
  until docker info >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 30 ]; then
      echo "cezar: the container's Docker daemon did not start — project services (docker compose) will not run." >&2
      echo "cezar: run the container with 'privileged: true' (docker/compose.yml does), or set CEZ_DOCKER=0 to silence this." >&2
      tail -n 5 /var/log/dockerd.log >&2 || true
      break
    fi
    sleep 1
  done
fi

# Volumes are owned by whoever created them, and git refuses a repository it thinks belongs to
# someone else. Everything under /projects is this container's.
export HOME=/home/node
setpriv --reuid=node --regid=node --init-groups \
  git config --global --get-all safe.directory >/dev/null 2>&1 \
  || setpriv --reuid=node --regid=node --init-groups git config --global --add safe.directory '*'

# The image follows the branch it was built from (spec 2026-10-23 §4.5). An operator's own
# CEZ_UPDATE_* wins over this seed, and a channel saved in the cockpit wins over both.
if [ -f /opt/cezar/source.json ]; then
  source_remote=$(jq -r '.remote // empty' /opt/cezar/source.json 2>/dev/null || true)
  source_branch=$(jq -r '.branch // empty' /opt/cezar/source.json 2>/dev/null || true)
  if [ -n "$source_remote" ] && [ -n "$source_branch" ]; then
    export CEZ_UPDATE_CHANNEL="${CEZ_UPDATE_CHANNEL:-branch}"
    export CEZ_UPDATE_BRANCH="${CEZ_UPDATE_BRANCH:-$source_remote#$source_branch}"
  fi
fi

if [ "${1:-}" = "cezar" ] && [ "${2:-}" = "serve" ]; then
  shift
  . /usr/local/lib/cezar/supervise.sh
  # `exec`: the background job IS cezar, so the loop's signals reach it, not a wrapper shell.
  run_cezar() { exec setpriv --reuid=node --regid=node --init-groups node "$@"; }
  set +e
  supervise_boot /data/cezar /opt/cezar
  supervise_loop /data/cezar "$@"
  exit $?
fi

exec setpriv --reuid=node --regid=node --init-groups "$@"
