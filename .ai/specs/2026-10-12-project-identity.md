# Project identity — a name and an icon, for show

> Status: implemented (2026-10-12). Branch: `brutus`.
> Implementation: `packages/contract/src/projects.ts`, `packages/cezar/src/workspace/project-icons.ts`,
> the icon routes in `projectsRoutes` (`server/server.ts`), `packages/web/src/components/project-icon.tsx`,
> `packages/web/src/routes/settings/project-identity.tsx`.
> Builds on: `2026-07-20-multi-project-workspace.md` (the registry these two fields live in).

## 1. Problem

A project is listed under its folder's name — `WRAP-CREATORS`, `canso-wrap-creator-workspace` —
and every project wears the same folder glyph. With four of them the switcher is a list of
strings to read, not marks to recognise.

## 2. Behaviour

Settings → project → General → **Identity**:

- **Name.** What the cockpit shows: the switcher, the breadcrumb, the browser tab, the Tasks page.
  1–80 characters. "Use the folder's name" resets it.
- **Icon.** An uploaded image, or one click on a favicon or logo found in the repository. Without
  one the project shows the first letter of its name. Shown in the switcher (list and trigger) and
  on the global Tasks page.

Both are COSMETIC. The project's id — its URL segment, worktree namespace and key in every store —
is allocated once at registration and is not derived from the name again. Nothing saved, linked
or bookmarked changes on a rename.

## 3. Mechanism

- **The name is the registry's own `name`.** It was always display-only ("basename by default");
  registration sets it once and a later boot only touches `lastOpenedAt`, so a chosen name
  survives. `PATCH /projects/:id` takes it beside `maxParallel` and `tags`.
- **The icon is a file**, `~/.cezar/project-icons/<projectId>-<sha256[:12]>.<ext>`, and the
  registry entry holds that file name. The hash in the name is the version: the cockpit asks for
  `…/icon?v=<file>`, so a new icon is a new address and the old one can be cached forever.
- **Typed from its bytes** (PNG, JPEG, WebP, GIF, SVG, ICO; 512 KB), never from a name or a
  header, and served `nosniff` under a sandboxing CSP — an SVG is an image here, not a document.
- **Candidates** are files named like a favicon, an icon or a logo, up to four directories deep,
  outside dependency trees. `PUT {path}` copies one — and ONLY one discovery itself would list, so
  the route is not a way to read an arbitrary file of the checkout.

## 4. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| A separate `displayName`? | No — rename `name`. | One field every surface already reads; a second one is a fallback chain to get wrong in thirty places. |
| Icon in `config.json` as a data URL? | No — a file beside it. | The registry is re-written whole on every change; half a megabyte of base64 does not belong in it. |
| Auto-pick the repo's favicon? | No — offer it. | A guess shown as a fact is a wrong logo nobody chose. One click sets it. |
| Does a removed project keep its icon? | No. | Removal drops the file with the entry. |
| Single-project mode | Edits refused, like every registry edit. | `PATCH`/`DELETE /projects/:id` already answer 409 there. |

## 5. Not in this spec

Colours or emoji as a mark, per-user names on a shared host, renaming the folder or the id.
