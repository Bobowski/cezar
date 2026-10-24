# The image's branch seed (spec .ai/specs/2026-10-23-branch-channel-self-update.md §4.5), sourced by
# the entrypoint and the `cezar` launcher. An operator's own CEZ_UPDATE_* wins over it.

# isUpdateRemote (packages/contract/src/self-update.ts) in shell: a seed the service would drop
# leaves the channel on `branch` with nothing to follow.
update_remote_ok() {
  case $1 in '' | -* | *[[:space:]]*) return 1 ;; esac
  [ "${#1}" -le 512 ] || return 1
  printf '%s\n' "$1" | LC_ALL=C grep -Eq '^(git@[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9._~][A-Za-z0-9._~/-]*|https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?/[A-Za-z0-9._~/-]+|ssh://([A-Za-z0-9][A-Za-z0-9._~-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?/[A-Za-z0-9._~/-]+)$'
}

# seed_update_branch <source.json> [quiet]
seed_update_branch() {
  [ -f "$1" ] || return 0
  source_remote=$(jq -r '.remote // empty' "$1" 2>/dev/null || true)
  source_branch=$(jq -r '.branch // empty' "$1" 2>/dev/null || true)
  [ -n "$source_remote" ] && [ -n "$source_branch" ] || return 0
  if ! update_remote_ok "$source_remote"; then
    # Never the remote itself: it may carry a token.
    [ -n "${2:-}" ] || echo "cezar: $1 names a remote the branch channel cannot follow; not seeding CEZ_UPDATE_CHANNEL=branch." >&2
    return 0
  fi
  export CEZ_UPDATE_CHANNEL="${CEZ_UPDATE_CHANNEL:-branch}"
  export CEZ_UPDATE_BRANCH="${CEZ_UPDATE_BRANCH:-$source_remote#$source_branch}"
}
