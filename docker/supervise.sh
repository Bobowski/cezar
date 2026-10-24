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
# daemon and the projects' services never notice. A version that dies within 30 s of its first
# launch after being activated is rolled back to `previous` once, recorded in rollback.json.
# "Just activated" is read from state, not from this loop: every `activate` (the server's,
# `cezar update` from the CLI, the boot choice) writes `versions/.fresh`, and the first launch of
# the id it names consumes it — so a CLI update followed by a container restart is guarded too.
# Functions only, no side effects on source; every helper succeeds, so `set -e` callers survive.

SUPERVISE_PKG_ENTRY=node_modules/@open-mercato/cezar/dist/index.js
SUPERVISE_WINDOW=30
# 1 while the install `current` points at was activated moments ago (an update, or the boot
# choice): only then is a quick crash a bad version rather than a bad day.
SUPERVISE_FRESH=0
# The id the last `activate` switched to, until its first launch (layout.ts `FRESH_MARKER`).
SUPERVISE_FRESH_MARKER=.fresh

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

# The id an image install is linked under: `<version>+image.<sha8>`, named by the commit that
# install was built from — its manifest's, else its root's source.json (a commit with no date).
supervise_image_id() { # <image install dir> → id
  sha=$(supervise_field "$1" .commit.sha)
  if [ -z "$sha" ]; then sha=$(jq -r '.commit // empty' "$(dirname "$1")/source.json" 2>/dev/null || true); fi
  sha=$(printf '%s' "$sha" | cut -c1-8)
  printf '%s%s' "$(basename "$1")" "${sha:+.$sha}"
}

# How old an install is, for the boot choice: its commit date, else its registry publish date, else
# when it was installed — the first that parses. A registry, local or link install has no commit,
# and counting it as always newer would stop image rebuilds from ever deploying code.
supervise_install_date() { # <install dir> → "<epoch> <committed|published|installed> <ISO date>", or nothing
  for field in .commit.at .publishedAt .installedAt; do
    at=$(supervise_field "$1" "$field")
    s=$(supervise_epoch "$at")
    if [ -n "$s" ]; then
      case $field in
        .commit.at) how=committed ;;
        .publishedAt) how=published ;;
        *) how=installed ;;
      esac
      printf '%s %s %s\n' "$s" "$how" "$at"
      return 0
    fi
  done
}

# What `activate` in layout.ts does: `previous` first, then `current`.
supervise_activate() { # <home> <id>
  before=$(supervise_link "$1" current)
  if [ -n "$before" ] && [ "$before" != "$2" ] && [ -f "$(supervise_entry "$1" "$before")" ]; then
    ln -sfn "$before" "$1/versions/previous"
  fi
  ln -sfn "$2" "$1/versions/current"
  if [ "$before" != "$2" ]; then printf '%s\n' "$2" >"$1/versions/$SUPERVISE_FRESH_MARKER" 2>/dev/null || true; fi
}

# The first launch of an install activated since the last launch arms the rollback guard, once.
supervise_consume_fresh() { # <home> <id>
  marker=$1/versions/$SUPERVISE_FRESH_MARKER
  fresh=$(cat "$marker" 2>/dev/null || true)
  if [ -z "$fresh" ]; then return 0; fi
  rm -f "$marker"
  if [ "$fresh" = "$2" ]; then
    SUPERVISE_FRESH=1
    rolled_back=0
  fi
}

supervise_boot() { # <home> <image dir>
  home=$1
  versions=$home/versions
  mkdir -p "$versions"
  # A rebuilt image leaves the previous image's link pointing at an /opt that is gone — or, rebuilt
  # at the same version, at the same path now holding another build: a link named for a sha the
  # install it points at no longer has would run the new build under the old one's name.
  for link in "$versions"/*+image*; do
    if [ ! -L "$link" ]; then continue; fi
    if [ ! -e "$link" ]; then
      rm -f "$link"
      continue
    fi
    target=$(readlink "$link")
    case $target in /*) ;; *) target=$versions/$target ;; esac
    if [ "$(basename "$link")" != "$(supervise_image_id "$target")" ]; then rm -f "$link"; fi
  done
  image_dir=$(ls -d "$2"/*+image 2>/dev/null | head -n 1)
  if [ -z "$image_dir" ]; then
    echo "cezar: the image carries no install under $2 — starting what versions/current points at" >&2
    return 0
  fi
  image_id=$(supervise_image_id "$image_dir")
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
  current_source=$(supervise_field "$versions/$current" .source)
  if [ -z "$image_at" ]; then
    echo "cezar: starting $current — the image ($image_id) was built without its commit (docs/docker.md § Updating), so current stays"
    return 0
  fi
  image_s=$(supervise_epoch "$image_at")
  if [ -z "$image_s" ]; then
    echo "cezar: starting $current — the image's ($image_id) commit date '$image_at' does not parse, so its age is unknown and current stays" >&2
    return 0
  fi
  dated=$(supervise_install_date "$versions/$current")
  if [ -z "$dated" ]; then
    echo "cezar: starting $current (${current_source:-unknown}) — it carries no date that parses to compare with the image's $image_id (committed $image_at), so it stays"
    return 0
  fi
  current_s=${dated%% *}
  current_when=${dated#* }
  if [ "$current_s" -ge "$image_s" ]; then
    echo "cezar: starting $current (${current_source:-unknown}, $current_when) — newer than the image's $image_id (committed $image_at)"
    return 0
  fi
  supervise_activate "$home" "$image_id"
  echo "cezar: starting $image_id (committed $image_at) — the image is newer than $current (${current_source:-unknown}, $current_when)"
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
    # A stop that landed while no cezar ran (between two launches) found nobody to pass it to.
    if [ "$stopping" = 1 ]; then return 0; fi
    supervise_consume_fresh "$home" "$id"
    run_cezar "$(supervise_entry "$home" "${id:-current}")" "$@" &
    child=$!
    # …and one between the spawn and `child=` reached the shell before it knew the pid.
    if [ "$stopping" = 1 ]; then kill -TERM "$child" 2>/dev/null; fi
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
      # An update: relaunch from the `current` it just activated, which may now crash once —
      # even when that activate came from a build too old to write the marker.
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
