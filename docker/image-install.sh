#!/bin/sh
# Build time only (docker/Dockerfile): install the image's cezar into the managed layout's shape at
# /opt/cezar/<version>+image, and record the commit it was built from (spec
# .ai/specs/2026-10-23-branch-channel-self-update.md §4.1, §4.4). The entrypoint links the install
# into /data/cezar/versions on every boot; source.json seeds the branch channel.
#
#   image-install.sh <tarball> <root>      reads CEZ_SOURCE_{COMMIT,BRANCH,REMOTE,COMMITTED_AT}
set -eu

tarball=$1
root=$2
version=$(tar -xOzf "$tarball" package/package.json | jq -r .version)
dir=$root/$version+image
mkdir -p "$root"
npm install --prefix "$dir" --omit=dev --no-audit --no-fund --no-package-lock --loglevel=error "$tarball"
test -f "$dir/node_modules/@open-mercato/cezar/dist/index.js"

iso() { date -u -d "$1" +%Y-%m-%dT%H:%M:%S.000Z; }
commit=${CEZ_SOURCE_COMMIT:-}
committed_at=
if [ -n "${CEZ_SOURCE_COMMITTED_AT:-}" ]; then committed_at=$(iso "$CEZ_SOURCE_COMMITTED_AT"); fi

# Without a commit AND its date the image is "a build of unknown age" (§4.2): no commit field.
jq -n \
  --arg version "$version" \
  --arg now "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
  --arg sha "$commit" \
  --arg at "$committed_at" \
  --arg branch "${CEZ_SOURCE_BRANCH:-}" \
  '{version: $version, source: "image", installedAt: $now}
   + (if $sha != "" and $at != "" then {commit: {sha: $sha, subject: "", at: $at, branch: $branch}} else {} end)' \
  >"$dir/.cezar-install.json"

if [ -n "$commit" ]; then
  jq -n \
    --arg commit "$commit" \
    --arg branch "${CEZ_SOURCE_BRANCH:-}" \
    --arg remote "${CEZ_SOURCE_REMOTE:-}" \
    --arg at "$committed_at" \
    '{commit: $commit, branch: $branch, remote: $remote, committedAt: $at}' >"$root/source.json"
fi
echo "image install: $dir${commit:+ (commit $commit)}"
