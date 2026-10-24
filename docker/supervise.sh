# cezar's supervisor in the container (spec .ai/specs/2026-10-23-branch-channel-self-update.md
# §4.1–4.3). Sourced by entrypoint.sh, which defines `run_cezar` (exec the given entry as `node`)
# and then calls, in order:
#
#   supervise_boot <cezar home> <image dir>   link the image's own install into versions/ and
#                                             activate whichever of it and `current` is newer
#   supervise_loop <cezar home> <args>...     run cezar until it exits for good
#
# The loop is what makes an update a PROCESS restart instead of a container restart: exit 75
# (`RESTART_EXIT_CODE`, restart.ts) relaunches from the new `current`, so the container's Docker
# daemon and the projects' services never notice. A version that dies within 30 s of being
# activated is rolled back to `previous` once, and the rollback is recorded in rollback.json.
# Functions only, no side effects on source; every helper succeeds, so `set -e` callers survive.

SUPERVISE_PKG_ENTRY=node_modules/@open-mercato/cezar/dist/index.js
SUPERVISE_WINDOW=30
# 1 while the install `current` points at was activated moments ago (an update, or the boot
# choice): only then is a quick crash a bad version rather than a bad day.
SUPERVISE_FRESH=0

supervise_entry() { # <home> <id>
  printf '%s/versions/%s/%s' "$1" "$2" "$SUPERVISE_PKG_ENTRY"
}

supervise_link() { # <home> <current|previous> → the id it points at, or nothing
  target=$(readlink "$1/versions/$2" 2>/dev/null || true)
  if [ -n "$target" ]; then basename "$target"; fi
}

supervise_field() { # <install dir> <jq path> → the manifest field, or nothing
  jq -r "$2 // empty" "$1/.cezar-install.json" 2>/dev/null || true
}

supervise_epoch() { # <ISO date> → seconds, or nothing
  if [ -n "$1" ]; then date -u -d "$1" +%s 2>/dev/null || true; fi
}

# What `activate` in layout.ts does: `previous` first, then `current`.
supervise_activate() { # <home> <id>
  before=$(supervise_link "$1" current)
  if [ -n "$before" ] && [ "$before" != "$2" ] && [ -f "$(supervise_entry "$1" "$before")" ]; then
    ln -sfn "$before" "$1/versions/previous"
  fi
  ln -sfn "$2" "$1/versions/current"
}

supervise_boot() { # <home> <image dir>
  home=$1
  versions=$home/versions
  mkdir -p "$versions"
  # A rebuilt image leaves the previous image's link pointing at an /opt that is gone.
  for link in "$versions"/*+image*; do
    if [ -L "$link" ] && [ ! -e "$link" ]; then rm -f "$link"; fi
  done
  image_dir=$(ls -d "$2"/*+image 2>/dev/null | head -n 1)
  if [ -z "$image_dir" ]; then
    echo "cezar: the image carries no install under $2 — starting what versions/current points at" >&2
    return 0
  fi
  image_sha=$(supervise_field "$image_dir" .commit.sha | cut -c1-8)
  image_id=$(basename "$image_dir")${image_sha:+.$image_sha}
  ln -sfn "$image_dir" "$versions/$image_id"

  current=$(supervise_link "$home" current)
  if [ -z "$current" ] || [ ! -f "$(supervise_entry "$home" "$current")" ]; then
    supervise_activate "$home" "$image_id"
    echo "cezar: starting $image_id (the image's own install)"
    return 0
  fi
  if [ "$current" = "$image_id" ]; then
    echo "cezar: starting $image_id"
    return 0
  fi
  image_at=$(supervise_field "$image_dir" .commit.at)
  current_at=$(supervise_field "$versions/$current" .commit.at)
  current_source=$(supervise_field "$versions/$current" .source)
  if [ -z "$image_at" ]; then
    echo "cezar: starting $current — the image ($image_id) was built without its commit (docs/docker.md § Updating), so current stays"
    return 0
  fi
  image_s=$(supervise_epoch "$image_at")
  current_s=$(supervise_epoch "$current_at")
  if [ -z "$current_s" ]; then
    echo "cezar: starting $current (${current_source:-unknown}) — it carries no commit date to compare with the image's $image_id, so it stays"
    return 0
  fi
  if [ -n "$image_s" ] && [ "$current_s" -ge "$image_s" ]; then
    echo "cezar: starting $current (${current_source:-unknown}, $current_at) — newer than the image's $image_id"
    return 0
  fi
  supervise_activate "$home" "$image_id"
  SUPERVISE_FRESH=1
  echo "cezar: starting $image_id ($image_at) — the image is newer than $current"
}

supervise_loop() { # <home> <args for cezar>...
  home=$1
  shift
  rolled_back=0
  stopping=0
  child=
  # `docker stop` signals this shell; pass it on, or cezar would be killed without its shutdown.
  trap 'stopping=1; if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null; fi' TERM INT
  while :; do
    id=$(supervise_link "$home" current)
    started=$(date +%s)
    run_cezar "$(supervise_entry "$home" "${id:-current}")" "$@" &
    child=$!
    code=0
    wait "$child" || code=$?
    # A trapped signal interrupts `wait`; wait again for cezar's own exit status.
    while [ "$stopping" = 1 ] && kill -0 "$child" 2>/dev/null; do
      code=0
      wait "$child" || code=$?
    done
    child=
    if [ "$stopping" = 1 ]; then return "$code"; fi
    if [ "$code" = 75 ]; then
      # An update: relaunch from the `current` it just activated, which may now crash once.
      SUPERVISE_FRESH=1
      rolled_back=0
      continue
    fi
    elapsed=$(( $(date +%s) - started ))
    previous=$(supervise_link "$home" previous)
    if [ "$code" != 0 ] && [ "$SUPERVISE_FRESH" = 1 ] && [ "$rolled_back" = 0 ] && [ "$elapsed" -lt "$SUPERVISE_WINDOW" ] \
      && [ -n "$previous" ] && [ "$previous" != "$id" ] && [ -f "$(supervise_entry "$home" "$previous")" ]; then
      ln -sfn "$previous" "$home/versions/current"
      # Never back to the build that just crashed: one rollback, then Docker's restart policy.
      rm -f "$home/versions/previous"
      printf '{"from":"%s","to":"%s","exitCode":%s,"at":"%s"}\n' "$id" "$previous" "$code" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$home/rollback.json"
      echo "cezar: $id exited with $code within ${elapsed}s of starting — rolled back to $previous" >&2
      rolled_back=1
      SUPERVISE_FRESH=0
      continue
    fi
    return "$code"
  done
}
