# Project env files — a service's `.env`, edited from the cockpit

> Status: implemented (2026-10-12). Branch: `brutus`.
> Implementation: `packages/contract/src/env-files.ts`, `packages/cezar/src/env-files.ts`, the
> `envFilesRoutes` family in `server/server.ts`, `packages/web/src/routes/settings/env-files-section.tsx`.
> Builds on: `2026-10-10-worktree-env-seeding.md` (how a file here reaches a task).
> Not the vault: `2026-10-10-project-secrets-vault-options.md` holds values for CHECK steps and
> never hands one to an agent or a dev server. This is the project's own configuration.

## 1. Problem

A project is cloned onto a new machine — a VPS most of all — and nothing in it starts, because its
env files are gitignored and live on another computer. The worktree seeding copies them into each
task, but only once they exist in the main checkout, and the only way to put them there was a
shell: `scp`, or a terminal and an editor. On a hosted cockpit that is the one step of bringing a
project up that cannot be done from cezar.

A real project has several: one per service (`packages/api/.env`, `apps/storefront/.env`,
`apps/cms/.env`). Which ones is the project's layout, not something a user should have to list.

## 2. Behaviour

Settings → project → **Environment** lists the project's env files and edits them as text.

- **What is listed.** Every `.env` / `.env.<name>` in the main checkout that **git ignores** (the
  seeding's own rule and walk), plus the file each tracked example asks for: `apps/api/.env.example`
  (or `.sample`, `.template`, `.dist`) lists `apps/api/.env` as "not created". A row shows the
  variable NAMES and which of the example's names are still missing. Never a value.
- **Suggestions.** A directory holding a manifest (`package.json`, `pyproject.toml`, `go.mod`,
  `Cargo.toml`, `composer.json`, `Gemfile`) is a service; `<service>/.env` is offered when git would
  ignore it and nothing above listed it. Any other path can be typed.
- **Editing.** The file's text in a textarea; a new file can start from its example. Saving writes
  the main checkout, `0600`, tmp + rename. The editor sends the version it loaded and a file that
  changed since is refused, not merged.
- **Reaching a task.** Unchanged: `seedWorktreeEnvFiles` copies ignored env files into every NEW
  worktree and never overwrites. A task that already has a worktree keeps its copy — the cockpit
  says so on save.

## 3. What it will not write

A path is refused unless all of these hold, checked on every read, write and delete:

- it names `.env` or `.env.<name>`, relative, without `..`, `.git` or `node_modules`;
- every directory on the way exists and is a real directory of THIS checkout — not a symlink, and
  not a directory with its own `.git` (a nested repository, a task worktree);
- **git ignores it.** A tracked `.env.test` is the branch's file, and a save there would be a
  secret in the next `git add -A`. The refusal names the fix (`.gitignore`), cezar does not make it.

## 4. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Where do values live? | In the project's own files. No cezar store. | The project's tooling reads those paths; a second copy would be state a user has to keep in sync. Delete `.ai/cezar` and nothing is lost. |
| Who may read or write contents? | A trusted operator (`trustedOperator`): local, or hosted with cezar's sign-in. | The same line as the terminal, which already reads these files. Under `CEZ_AUTH=0` the listing still answers names; content routes are 409. |
| Default | On, no flag. | It opens nothing and runs nothing; the gate above is the existing one. |
| Values in the listing, masked? | No. | A name says what is configured; a mask says nothing more and is one bug from a leak. |
| Contents in the query cache? | No. | Fetched when a file is opened, held in the editor's state, dropped on close. |
| Push a save into existing worktrees? | No. | The seeding's rule: a task may have rewritten its env on purpose. |
| Structured key/value form? | No — text. | Comments, ordering and quoting survive; pasting a whole file from another machine is the main use. |

## 5. Not in this spec

Per-task env overrides, syncing a vault into env files, `.dev.vars`/`.envrc` and other untracked
config, a `cez env` CLI.
