# Browser tabs on the Code page — several pages, one page per tab, remembered per project

> Status: proposed (2026-10-24), not built. Branch: `brutus`.
> Builds on: `2026-10-11-code-page.md` (the owner's decision: "a browser tab is one page";
> `BrowserView`'s `singleTab`), `2026-10-13-unified-settings.md` (layout state per project on
> the server: `workspace-layouts.ts`), `2026-10-24-code-page-terminal.md` (what opens a tab).
> Backlog item: "several browser tabs — the Code page".

## 1. Problem

Comparing the storefront with the admin, or a page before and after a change, means two
browser tabs. The Code page allows that in principle (a second Browser editor tab, possibly in
another group) but makes it slow: there is no shortcut, no "open beside", the open pages are
not listed anywhere, and a reload of the cockpit forgets them.

## 2. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Tab strip inside a Browser tab? | **No — one page per editor tab stays** (owner, 2026-10-24) | The editor's own tabs and groups are the tab strip; a second strip inside a tab is two tab models. |
| What is remembered | **Addresses and order, per project**, on the server | Survives reload and a device switch; navigation history does not. |
| External sites | **No — the project's own app only** | A Browser tab is a preview, not a browser. Most sites refuse framing anyway. |

## 3. Behaviour

- **`Ctrl/Cmd+T`** in the Code page opens a new Browser tab in the active group, address bar
  focused, with the project's detected addresses as suggestions (the terminal spec's list).
  **`Ctrl/Cmd+Shift+T`** opens it in a new group to the right ("open beside").
- A Browser tab's title is its address's host:port and path (the page title is unreachable
  across the iframe boundary — code-page §"as built"); the tab shows the gateway port on a
  hosted cockpit.
- The **palette** (`Ctrl/Cmd+L` family, task-palette spec) lists open Browser tabs under
  "Pages" and every detected address under "Open page".
- **Persistence.** The Code layout state already saved per project gains, for each Browser
  tab, `{ url }`. On load, a tab is restored to its address (a fresh gateway ticket is asked
  for on a hosted cockpit); back/forward history is not restored. A saved address that no
  longer answers shows the Browser tab's existing "nothing is listening" state with the
  address kept, so **Run app** (design-mode §7b) can bring it back.
- **Scope.** The address bar accepts loopback and gateway addresses only; anything else is
  rejected inline with "open it in your browser" and a copy button — the same rule the task
  Preview column applies.

## 4. API

No new routes. `workspaceLayoutsSchema`'s Code layout gets the optional `url` on Browser
tab entries (additive; old layouts parse).

## 5. Security

Unchanged: the same address allowlist and ticket rules as the task Preview. A persisted
address is a loopback or gateway address and nothing else.

## 6. Zero config

Nothing to set. Layout state is state.

## 7. Not done here

- A tab strip inside a Browser tab (`singleTab` stays on in Code).
- Page thumbnails.
- External browsing.

## 8. Verification

- Unit: `code-state.ts` — open/open-beside/close keep order; serialization of `url`;
  restore drops a non-loopback address.
- Cockpit: `Ctrl+T` focuses the address bar; palette lists pages; reload restores tabs.
- VPS: two gateway pages side by side; reload of the cockpit brings both back with new tickets.
