# Cockpit polish — the Git sidebar, live preview in a task, full screen everywhere, and the small things

> Status: proposed (2026-10-24), not built. Branch: `brutus`.
> Builds on: `2026-10-13-unified-settings.md` (one frame, one nav), `2026-10-11-code-page.md`
> (F11 full screen, `code.tsx`), `2026-10-07-task-workspace.md` (the Browser column),
> `2026-10-10-preview-gateway.md`, `2026-10-24-git-view.md` (`repo-sidebar.tsx` grows there).
> Backlog item: "UI fixes — sidebar on the Git page, live preview, full screens etc."

## 1. Problem

Four things the owner named, each small and each daily:

- The **Git page sidebar** does not behave like the app's other sidebars: its width is not
  remembered, it does not collapse, and its selection is lost on refresh.
- **Live preview in a task** goes stale: the Browser column does not notice the agent's
  changes (no HMR through the gateway on the VPS; a non-HMR app never reloads), and the column
  is too narrow for a real page without a manual resize.
- **Full screen** exists on the Code page only (F11). The task thread, a diff, the Browser
  column and the terminal cannot take the whole window.
- **Consistency**: spacing, focus rings, empty states, error wording, shortcuts that differ
  between pages.

## 2. Decisions

All four are in scope; this is one spec with a checklist, shipped as a series of small commits.

## 3. Behaviour

### 3.1 Git sidebar

`repo-sidebar.tsx` adopts the shell's `Sidebar` primitives (`ui/sidebar.tsx`): resizable with
the same handle, collapsible to icons, width and collapsed state in the per-project layout
state (the Code page's `workspace-layouts` entry gains a `repo` block), the selected
tab/branch/file restored from the URL (`?tab=branches&ref=…`) so a refresh and a shared link
land on the same view. Keyboard: `Ctrl/Cmd+B` toggles it, as in Code.

### 3.2 Live preview

- **Reload on change.** The task workspace already watches the worktree (`checkout-watch.ts`
  for Code). The Browser column subscribes to the run's worktree-change signal and, when the
  page has no HMR connection (detected: no open WebSocket from the frame to its origin within
  2 s of load, reported by the gateway), reloads the frame after changes settle for 1.5 s. A
  toggle in the column header, **Auto-reload**, on by default for non-HMR pages, off when HMR
  is detected.
- **HMR through the gateway.** The gateway already proxies WebSocket upgrades; Vite's HMR
  client connects to the page's own origin and port, which through the gateway is the gateway
  port — it works today when the app uses relative HMR settings and fails when `server.hmr.port`
  is pinned. The Preview shows a one-line hint with the `server.hmr` snippet when it sees a
  failed upgrade to a loopback port other than the proxied one.
- **Width.** The Browser column's default width becomes 45 % of the workspace (was a fixed
  minimum), remembered per project; **Expand** (the full-screen control of §3.3) gives it
  everything.

### 3.3 Full screen everywhere

One component, `FullscreenRegion`, used by the Code page today, applied to: the task thread,
the Changes diff, the Browser column, the terminal drawer, and the Docker/Services views.
Entering: the control on the region's strip, `F11` (`Ctrl+Cmd+F` on macOS) on the focused
region. Leaving: `Esc`, the control, or browser exit. The shell hides its chrome; the region
keeps its own toolbar. State is not persisted (a reload returns to the layout). The desktop
shell maps its native full-screen to the same signal.

### 3.4 Consistency checklist

A living list in this spec's § 7, worked top to bottom; each line is a commit of its own and
is struck through when done. Starting set:

1. One spacing scale for page headers (Settings, Git, Services, Tasks).
2. Focus rings on every clickable row (task list, branches, files) and `Enter` to open.
3. Empty states with a verb ("No tasks yet — press N to start one") on Tasks, Git, Docker,
   Automations, Integrations.
4. Error toasts carry the server's `{ error }` text verbatim, never "Something went wrong".
5. Shortcut table in Settings → Keyboard lists every page's shortcuts; pages that differ
   (`Alt+W` vs `Ctrl+W`) are reconciled.
6. Loading skeletons instead of spinners on the four list pages.
7. The sidebar's project switcher and the Settings nav use the same item height.

## 4. API

`workspace-layouts` gains `repo: { width, collapsed }` per project. No other routes; the
reload signal reuses the run's checkout-watch topic.

## 5. Security

Nothing new crosses a boundary; the reload signal carries no file contents.

## 6. Zero config

Auto-reload defaults on for non-HMR pages and off for HMR pages; both are a toggle on the
column, not a setting.

## 7. Checklist state

Behaviour (§3):

- ~~3.1 Git sidebar~~ — the shell's contextual column takes an optional frame from the screen
  (`ContextSidebar frame=…`: width, bounds, fold to icons, the `#788` resize handle); the Git page
  keeps it per project in ui-state `repo`. Selection: Branches and Graph `?ref=`, Changes
  `?file=` (Commits and Files were already paths). `Ctrl/Cmd+B` folds it.
- ~~3.2 Live preview~~ — Auto-reload in the Browser bar; the change signal is the run's
  checkout bell (`code:<project>:<run>`), which on Linux now rings from a demand-driven
  `git status` poll, and — for a cockpit without the socket (remote) — `GET /repo/watch?stamp=1`
  compared every 3 s while auto-reload is on. HMR detection is the gateway's upgrade log, read at
  `/__cez_preview/hmr` on the gateway's own port. A page framed directly (a local cockpit) cannot
  be observed, so there Auto-reload starts off and is one click away. New Browser columns open at
  the project's `browserColumn.width` (45 %), kept from the last divider drag.
- ~~3.3 Full screen~~ — `FullscreenRegion` (`components/fullscreen-region.tsx`) on every
  workspace window (thread, Changes, Browser, …), the terminal drawer, Scripts, Docker and the
  Code page. `Esc` is left to a shell or an editor (`.xterm`, `.cm-editor`) and to open
  overlays. Not built: the desktop shell's native full-screen mapping (Tauri side).

Consistency (§3.4):

1. ~~One spacing scale for page headers~~ — `PageHeader` (whole page) / `PageTitle` (a
   master–detail main area, `pt-4`) / `PageItemTitle` (the one item shown), in `page.tsx`.
2. ~~Focus rings on every clickable row, `Enter` to open~~ — `lib/row-focus.ts`: a row whose link
   carries the keyboard lights up with it (task table and cards, Graph rows); a row with no link
   (Automations) is a focus stop that opens on `Enter`; the Files tree's rows ring on focus. The
   sidebar lists (branches, changed files) were already `SidebarMenuButton`s.
3. ~~Empty states with a verb~~ — Tasks and All tasks: "Press C to start one" (C is the rail's
   New task key, not N); Git's clean tree: "Edit a file … ready to stage"; Docker: "Start a
   stack …"; the Automations sidebar: "create one with New" (its page already had one);
   Integrations (Settings → tracker): "No tracker connected — connect one below."
4. ~~Error toasts carry the server's text~~ — they already did (`ApiError` is the server's
   `{ error }`, and no "Something went wrong" was left); the seventeen hand-rolled
   `error instanceof Error ? … : String(error)` sites now share `lib/error-text.ts`, and a test
   pins a 409's words reaching the toast verbatim. Remaining literal danger toasts are client-side
   refusals (a full note list, a copy the browser refused), not server failures.
5. ~~Shortcut table in Settings → Keyboard~~ — a read-only "Page shortcuts" table under the
   rebindable task commands, from one catalog (`lib/page-shortcuts.ts`): Everywhere, Task, Code,
   Git, as this surface spells them (⌃⌘F for F11 on a Mac, ⌘T only in the desktop shell).
   Reconciled: closing a tab is `Alt+W` on every surface — a browser keeps Ctrl/⌘+W and the
   desktop shell's window menu closes the window on it, so `Mod+W` stays reserved.

## 8. Verification

- Unit: layout-state persistence for `repo`; HMR detection from the gateway's upgrade log;
  debounce of reload; `FullscreenRegion` enter/leave on each host; URL state on the Git page.
- e2e: F11 on the thread hides the shell and `Esc` restores; a change in the worktree reloads
  a static preview once.
- VPS: a Next.js storefront through the gateway hot-reloads; a static site auto-reloads after
  an agent edit; the Git sidebar keeps its width after a refresh.
