# syntax=docker/dockerfile:1
#
# cezar in a container (spec .ai/specs/2026-10-10-cezar-in-a-container.md).
#
# One image that holds cezar AND what a project needs to be built in it: git, a compiler
# toolchain, Node, Python, the coding-agent CLI, and a Docker daemon of its own for the
# project's services. The host needs Docker and nothing else.
#
# Build context is the repository root:  docker build -f docker/Dockerfile -t cezar:local .

# ---- build: the same tarball `npm publish` would ship ---------------------------------------
FROM node:22-bookworm AS build
WORKDIR /src
COPY . .
RUN npm ci --no-audit --no-fund \
 && npm run build:server && npm run build:web \
 && mkdir /out && npm pack -w @open-mercato/cezar --pack-destination /out

# ---- runtime ---------------------------------------------------------------------------------
FROM node:22-bookworm

# The toolchain a project's own scripts reach for, plus what cezar itself shells out to:
# git and gh for the repository, procps for the terminal's process names.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git make build-essential python3 python3-venv python-is-python3 \
      curl ca-certificates gnupg openssh-client procps jq unzip less iptables \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg \
 && chmod a+r /etc/apt/keyrings/githubcli.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends \
      docker-ce docker-ce-cli containerd.io docker-compose-plugin gh \
 && rm -rf /var/lib/apt/lists/*

# yarn and pnpm at whatever version a project pins; `n` for a project that pins its Node
# (`n auto` reads .nvmrc); the agent cezar drives by default.
RUN corepack enable \
 && npm install -g --no-audit --no-fund n @anthropic-ai/claude-code @openai/codex

# Tools installed from the cockpit's terminal land in the /data volume and survive a rebuild
# (spec 2026-10-23 §4.6): `npm i -g` goes to /data/npm, a release binary to /data/bin. They come
# first on PATH, so a /data install shadows an image one of the same name.
ENV PATH=/data/bin:/data/npm/bin:$PATH \
    NPM_CONFIG_PREFIX=/data/npm

# Everything a container must not lose lives under /data: cezar's registry, the agents' logins,
# git identity and SSH keys. /projects holds the repositories. Both are volumes.
ENV CEZ_HOME=/data/cezar \
    CEZ_PROJECTS_DIR=/projects \
    CLAUDE_CONFIG_DIR=/data/claude \
    CODEX_HOME=/data/codex \
    GH_CONFIG_DIR=/data/gh \
    GIT_CONFIG_GLOBAL=/data/gitconfig \
    # The cockpit is published on the host's loopback only (docker/compose.yml), so the
    # host-machine affordances a hosted cockpit withholds are safe to hand back here.
    CEZ_TERMINAL=1 \
    CEZ_FILE_EDIT=1 \
    # A task's app listens inside this container. The gateway re-serves it on these ports,
    # which compose publishes, so the Browser column can frame it.
    CEZ_PREVIEW_PORTS=8500-8519

# cezar and its agents run as `node`, not root: an agent is arbitrary commands, and the Docker
# daemon beside it is root. The group lets them use that daemon. ~/.gitconfig points at the
# volume too: an agent gets HOME but not GIT_CONFIG_GLOBAL (core/agent-env.ts allowlist), and
# without it commits lose the identity and signing configured there.
RUN usermod -aG docker node \
 && mkdir -p /data /projects && chown node:node /data /projects \
 && ln -s /data/ssh /home/node/.ssh \
 && ln -s /data/gitconfig /home/node/.gitconfig

# Projects live in the /projects volume, not in ~ — the hosted default browse root.
ENV CEZ_BROWSE_ROOT=/projects

COPY docker/entrypoint.sh /usr/local/bin/cezar-entrypoint
COPY docker/supervise.sh docker/image-install.sh docker/update-seed.sh /usr/local/lib/cezar/
COPY docker/cezar-launcher.sh /usr/local/bin/cezar
RUN chmod +x /usr/local/bin/cezar-entrypoint /usr/local/bin/cezar \
 && ln -s cezar /usr/local/bin/cez

# The supervisor loop in the entrypoint relaunches cezar after an update: it exits 75 instead of
# re-exec'ing itself (restart.ts), and the container — its Docker daemon, the projects' services — stays up.
ENV CEZ_SUPERVISED=1

# What this image was built from (docs/docker.md § Updating): compose passes them from the
# environment. Empty, the image is "a build of unknown age" and the cockpit's updater keeps
# whatever it installed since. Last on purpose — they change on every commit.
ARG CEZ_SOURCE_COMMIT=
ARG CEZ_SOURCE_BRANCH=
ARG CEZ_SOURCE_REMOTE=
ARG CEZ_SOURCE_COMMITTED_AT=

# The image's own cezar, in the managed layout's shape (spec 2026-10-23 §4.1): the entrypoint
# links /opt/cezar/<version>+image into /data/cezar/versions, so the cockpit can update past it
# and roll back to it. The `cezar` on PATH is a launcher of whatever `current` points at.
COPY --from=build /out/*.tgz /tmp/cezar.tgz
RUN sh /usr/local/lib/cezar/image-install.sh /tmp/cezar.tgz /opt/cezar && rm /tmp/cezar.tgz

WORKDIR /projects
EXPOSE 4321 8500-8519
VOLUME ["/data", "/projects", "/var/lib/docker"]
ENTRYPOINT ["cezar-entrypoint"]
CMD ["cezar", "serve", "--bind-host", "0.0.0.0", "--port", "4321", "--no-open"]
