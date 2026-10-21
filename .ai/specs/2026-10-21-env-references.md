# Env references — `${{ … }}` values that cezar fills per task

> Status: **draft for owner review (2026-10-21).** Not implemented. Branch: `brutus`.
> Builds on: `2026-10-12-project-env-files.md` (Settings → Environment, the variables view),
> `2026-10-10-worktree-env-seeding.md` (how env files reach a task), `2026-10-10-task-slots.md`
> (`CEZ_TASK_SLOT`, `CEZ_TASK_PORT_BASE`), `2026-10-10-worktree-lifecycle-events.md` (seeding runs
> before setup scripts since 652d64a0).
> Not this spec: secrets from the vault inside env files (`2026-10-10-project-secrets-vault-options.md`
> keeps them away from agents and dev servers on purpose — a separate owner decision).

## 1. Problem

Every task worktree gets a copy of the main checkout's env files. Those files hold the **main
station's** addresses: `PORT=9000`, `DATABASE_URL=…:5432/…`, `STORE_CORS=http://localhost:3000`.
In a task they are wrong — two tasks running the app at once collide on the same ports, and a task
silently writes into the main checkout's database.

cezar already gives each task what it needs to be different: a **slot** (`CEZ_TASK_SLOT`, 1–99) and
a **port block** (`CEZ_TASK_PORT_BASE`, `20000 + slot × 100`). But it hands them only to the
processes cezar itself starts, as shell variables. An app reads its `.env` itself, and no `.env`
loader evaluates `$(( ${CEZ_TASK_PORT_BASE:-3000} + 1 ))`. So every project re-derives its ports in
its own script — fancy-fence-panels has a bootstrap that hashes the worktree path into a port
offset and rewrites eleven keys (`alignStation`, a4a4819). A project without such a script runs
its tasks on the main station's ports.

Railway's answer is a value that refers to something instead of holding it: `${{ Postgres.DATABASE_URL }}`.
This spec brings that to the env files cezar already edits, with the **task** as the thing most
references point at.

## 2. What the user writes

In Settings → Environment, a value may contain references:

```
PORT=${{ task.port(0, 9000) }}
STOREFRONT_PORT=${{ task.port(1, 3000) }}
DATABASE_URL=postgres://ffp:ffp@localhost:${{ task.port(2, 5432) }}/ffp_medusa
STORE_CORS=http://localhost:${{ STOREFRONT_PORT }}
MEDUSA_BACKEND_URL=http://localhost:${{ apps/backend/.env:PORT }}
DB_NAME=app${{ task.suffix }}
```

In the main checkout that renders to `PORT=9000`, `DATABASE_URL=…:5432/…`, `DB_NAME=app`. In the
task holding slot 3 it renders to `PORT=20300`, `DATABASE_URL=…:20302/…`, `DB_NAME=app_3` — and
every reference to `PORT` follows.

### 2.1 References (the closed set — v1)

| Reference | Main checkout | Task with slot *n* | Why it exists |
| --- | --- | --- | --- |
| `task.port(k, default)` | `default` | `20000 + n×100 + k` (k = 0…99) | The whole point: a port per service per task, from the block the slot already reserves. |
| `task.slot` | empty | `n` | Names, logs. |
| `task.suffix` | empty | `_n` | `app${{ task.suffix }}` → `app`, `app_3` — a database or bucket per task. |
| `task.id` | empty | the run id | Correlation, never a port. |
| `worktree.path` | the project root | the worktree directory | Absolute paths (uploads dir, sqlite file). Same meaning as the lifecycle `{{ worktree_path }}`. |
| `project.root` | the project root | the project root | Shared caches the main checkout owns. |
| `VAR` | that variable of the same file, rendered | same | `STORE_CORS=http://localhost:${{ STOREFRONT_PORT }}` — one source for a value used twice. |
| `path/to/.env:VAR` | that variable of another env file of this project, rendered | same, from that task's copy | The backend's port where the storefront needs it. Any file Settings → Environment lists. |

A task with **no slot** (no worktree, every slot taken, a read-only home) renders exactly like the
main checkout — the same "degrade to before slots existed" rule the slots spec has.

Deliberately not in v1, each with its reason:

- **The preview gateway's public address** (`https://agents.example.dev:8513`). A gateway port is
  chosen when a preview is opened, not when the worktree is created; rendering it would mean
  re-rendering on every preview. The gateway would need a stable port per (task, app) first.
- **Secrets from the vault** (`${{ secrets.STRIPE_KEY }}`). The vault never hands a value to an
  agent or a dev server; a rendered `.env` sits in the worktree the agent reads. Owner decision.
- **Arithmetic, defaults by expression, string functions.** `task.port(k, default)` covers the
  case that motivated this; a template language is a second programming language to support.
- **Process environment** (`${{ env.HOME }}`). It would make a file's meaning depend on the shell
  cezar was started from — the opposite of reproducible.

## 3. Where the reference lives — the annotated `.env`

The owner's rule for env files is that **values live in the project's own files, no cezar store**:
delete `.ai/cezar` and nothing is lost (`2026-10-12-project-env-files.md` §4). A file an app reads
cannot hold `${{ … }}` either: Next.js, docker compose and `dotenv-expand` all interpret `${…}`
themselves. So the reference is kept **in the same file, as a directive comment above the line it
renders**:

```
# Database
#cezar DATABASE_URL=postgres://ffp:ffp@localhost:${{ task.port(2, 5432) }}/ffp_medusa
DATABASE_URL=postgres://ffp:ffp@localhost:5432/ffp_medusa
```

- An app sees a comment and a plain value. Nothing to install, nothing to teach a loader.
- The file is self-describing: a person reading it on the box sees both what it is and what it
  means. Copied by hand to another machine it still works, with the main checkout's values.
- No new state: delete `.ai/cezar`, reinstall cezar — the references are still in the file.
- The variables view shows one row: name, the **reference** as the value, the rendered value under
  it. Raw text shows both lines, as they are.

A `#cezar` line whose next line is not an assignment of the same key is shown as a warning and
left alone — never guessed at.

### 3.1 Rejected alternatives

| Option | Why not |
| --- | --- |
| Template store in `.ai/cezar/env-templates/` | A cezar-owned store of user-authored values: breaks "delete `.ai/cezar`, lose nothing" and the owner rule above. |
| Sidecar `apps/api/.env.cezar` | Two files to keep in sync and to gitignore; tools and humans editing `.env` never see the reference. |
| `${{ … }}` written straight into `.env` | Apps would read the raw reference in the main checkout; loaders mangle `${`. |

## 4. When cezar renders

Rendering = for every `#cezar` directive, compute the value for a context (main checkout or one
task), and replace **only the assignment line under it**. Every other byte of the file is kept, as
the variables view already guarantees (`lib/dotenv-lines.ts`, moved to the api-client so the server
and cockpit share one parser).

| Moment | Context | Notes |
| --- | --- | --- |
| Save in Settings → Environment | main checkout | The saved file is already rendered; the editor shows the result before saving. |
| Worktree creation (`seedWorktreeEnvFiles`) | that task | Replaces today's byte copy for files that carry directives; a file without directives is copied as today. Runs before setup scripts (652d64a0), so a project bootstrap sees task values. |
| Recreation after reclamation | that task | Same path; the slot may differ, so values may differ. |
| Explicit **Re-render in this task** (task menu) | that task | For a task created before the reference was added. Never automatic: the seeding rule that a task may have changed its env on purpose stands. |

Cross-file references render in dependency order; a cycle (`A` → `B` → `A`, or a file referring to
itself through another file) is refused on save with the chain named, and at seed time leaves the
assignment as it is in the main checkout, with a note on the task.

## 5. Contract and code (sketch)

- `packages/contract/src/env-files.ts`: `EnvFileContent` gains `directives: { key, source }[]` and
  `rendered: string` (the file as this checkout's context renders it). `PUT /env-files` is
  unchanged in shape — the content sent is the annotated text; the server validates directives,
  renders the main-checkout values into it and answers the stored file.
- `POST /env-files/render` `{ path, content, worktreeId? }` → `{ rendered, values: {key, value}[] }`
  for the editor's live preview, "what would task X get". Same trusted-operator gate as the content
  routes. Never logs values.
- `packages/cezar/src/env-references.ts`: parse directives, resolve the closed reference set,
  topological order across files, render. Pure apart from reading sibling env files; unit-tested
  without a server.
- `seedWorktreeEnvFiles`: render instead of copy when a file has directives; the slot comes from
  `acquireTaskSlot(runId, worktree)`, which is idempotent for the pair, so the agent's
  `CEZ_TASK_PORT_BASE` and the file always agree.
- Cockpit: in the variables view, an **Add reference** menu beside the value (as Railway's): task
  values, this file's variables, other files' variables. A value holding a reference shows the
  rendered main-checkout value beneath it, and a "for a task" preview picks one.

## 6. Edge cases

- **The directive and the line drift apart** — someone edits `DATABASE_URL=` by hand in the main
  checkout. The next render overwrites the assignment from the directive; the variables view shows
  "edited by hand — will be replaced on save" before that happens. The directive is the source.
- **A project bootstrap rewrites the same key** (fancy-fence-panels' `alignStation`). Both agree if
  both derive from the slot; if they do not, the bootstrap runs after seeding and wins. A project
  adopting references can drop its own rewriting — not required.
- **No slot.** Main-checkout values. The task's agent gets empty `CEZ_TASK_*` too, so they agree.
- **Unknown reference / bad syntax.** Refused on save with the position, like a lifecycle template.
  At seed time (a file edited outside the cockpit): left at the main-checkout value, note on the task.
- **`task.port(k, …)` with the same `k` twice in a project.** Allowed (it may be deliberate) but
  flagged in the editor: two services asking for one port.
- **Port block size.** k ranges 0…99, the block the slot already reserves; nothing new is reserved.
- **Multi-line values and quoting.** The rendered value is written with the same quoting rule as the
  variables view (`formatAssignment`); a directive may not produce a multi-line value in v1.

## 7. Security

- Rendered values are the user's own: no reference reaches a secret store, the network, or process
  environment. `path:VAR` reads only env files this project's Environment page already lists, with
  the same path rules (gitignored, inside the checkout, no symlinks, no nested repositories).
- The preview route answers values to a trusted operator only — the same gate as reading the file.
- A rendered file is written `0600`, tmp + rename, like a save today.

## 8. Tests that make this hold

- Parser: directive + assignment pairs, orphan directives, comments and `export` kept byte for byte.
- Resolver: every reference in the table, main vs slot vs no-slot; cross-file order; cycle refused
  with the chain named; unknown reference refused with its position.
- Seeding: a file with directives is rendered for the task (port block matches `taskSlotEnv`), a file
  without is copied byte for byte (today's behaviour pinned); runs before setup scripts.
- Route parity and contract parity for `POST /env-files/render`; `trustedOperator` gate.
- Cockpit: Add reference inserts at the cursor; rendered preview; drift warning; the Raw text view
  shows both lines.

## 9. Phasing

1. Resolver + annotated format + seeding renders (no UI beyond Raw text). fancy-fence-panels can
   adopt it by hand and the value of the idea is visible.
2. Variables view: reference rows, Add reference menu, main/task preview.
3. "Re-render in this task" action.

## 10. Open questions for the owner

1. **Syntax.** `${{ … }}` (Railway) for env values, while lifecycle commands keep `{{ … }}`? Or one
   syntax for both? Recommendation: `${{ … }}` here — it reads as "a value", and the two never
   share a file.
2. **The annotated `.env`** (§3) over a cezar-side store — agree?
3. **Re-render existing tasks** only on an explicit action (§4) — or offer it on save for tasks
   that have not started their app yet?
4. **fancy-fence-panels**: keep its `alignStation`, or move it to references once phase 1 lands?
