# Cockpit branding — your own name, logo, favicon, app icons and colours for a hosted cezar

> Status: built (2026-10-25) except the desktop window icon (§9). Branch: `brutus`.
> Builds on: the `branding` block of the workspace config (`workspace.ts`: `name`, `logoUrl`;
> `PUT /workspace/branding-logo`), `components/brand-mark.tsx` (the lockup), `brand-asset.test.ts`
> (icon.svg and the mark must not drift), `2026-10-24-mobile-cockpit.md` (the manifest).
> Backlog item: "better custom favicon / apple icon".

## 1. Problem

A hosted cezar can already be renamed and given a logo (the VPS runs as "Agents" with its own
mark in the sidebar). The browser tab still shows cezar's favicon, the home-screen icon on a
phone is cezar's or a letter, and the desktop shell's window icon is cezar's. The rename stops
at the sidebar.

## 2. Decision

**One branding set, applied everywhere the cockpit shows itself**: sidebar lockup, browser
favicon, PWA icons and manifest, apple-touch-icon, Open Graph image for the sign-in page, the
`<title>` prefix, and the accent colour. Uploads are files under `CEZ_HOME`, like the logo today.

## 3. Behaviour

**Settings → Global → Appearance → Branding** (trusted operator):

| Field | Today | Proposed |
| --- | --- | --- |
| Name | ✓ | unchanged; also the `<title>` prefix and the manifest `name`/`short_name` |
| Logo (sidebar lockup) | ✓ | unchanged |
| Favicon | — | upload SVG or PNG; cezar derives 16/32/48 PNG and keeps the SVG for browsers that take it |
| App icon | — | upload one square PNG ≥ 512 px; cezar derives 192, 512, maskable 512 and apple-touch 180 |
| Accent colour | — | one colour; applied to the theme token the shell already exposes, light and dark variants derived (the dataviz palette rules for contrast) |
| Reset | — | back to cezar's own mark and name in one click |

Every derived file lives in `<CEZ_HOME>/branding/<kind>-<sha256[:12]>.<ext>`, served at
`/api/v1/workspace/branding/<kind>?v=<hash>` (content-addressed, cacheable forever, the project
icons' scheme). `index.html`'s `<link rel="icon">` and the manifest are rendered by the server
with the current addresses, so a change is a reload away and nothing is rebuilt.

The desktop shell (Tauri) reads the same manifest for its window icon on the next launch.

## 4. API

```
GET  /workspace/branding                      → { name, logoUrl, faviconUrl, appIconUrl, accent, custom: boolean }
PUT  /workspace/branding                      { name?, accent? }
PUT  /workspace/branding/favicon | app-icon   image upload (≤ 2 MB; SVG sanitised, PNG re-encoded)
DELETE /workspace/branding/favicon | app-icon | logo
GET  /manifest.webmanifest                    rendered from branding
```

`branding-logo` keeps working and becomes one of the kinds. Contract in `workspace.ts`.

## 5. Security

- Uploaded SVG is sanitised (scripts, foreign objects and external references stripped) before
  it is served, because a favicon is loaded on every page. PNG is decoded and re-encoded.
- Only the signed-in operator can change branding; the files are served to anyone who can
  reach the sign-in page, as the name and logo already are — so the sign-in page shows the
  brand, which is the point.
- The `brand-asset.test.ts` invariant is scoped to cezar's own mark; a custom mark is never
  compared to it.

## 6. Zero config

Default is cezar's own branding; everything is state under `CEZ_HOME/branding/`.

## 7. Not done here

- Per-project branding (projects have their own icon already).
- Custom fonts or full theme editing.
- White-labelling the CLI banner.

## 8. Verification

- Unit: derivation sizes from a fixture PNG and SVG; sanitiser on an SVG with a script and an
  external image; content-addressed naming; manifest rendering; reset restores defaults.
- Cockpit: favicon and title update without a rebuild; the sign-in page shows the custom mark.
- VPS: upload the "Agents" mark as favicon and app icon; add to the home screen on a phone;
  the tab and the icon match the sidebar.

## 9. As built (2026-10-25)

Where the build settled a question the sections above left open, or deliberately stopped short:

- **Files.** `src/workspace/branding.ts` (storage, derivation, links), `branding-png.ts`
  (`pngjs`: decode, an integer area-average resize from a working copy of at most 1024² —
  derivation yields the event loop a turn between sizes — and re-encode; IHDR is read first; anything over
  2048² or interlaced is refused unopened, and IDAT inflates under the byte budget the header
  allows before pngjs sees it; bytes after IEND are dropped), `branding-svg.ts` (`@xmldom/xmldom`:
  parse, keep allowlisted SVG elements, drop `on*`, foreign namespaces, every `href` that is
  not `#id` and every `url()` that is not `url(#id)`; a DOCTYPE is refused), `branding-accent.ts`.
  Both libraries are pure JS, dependency-free and pinned; CODE_REVIEW.md's budget names them.
- **Uploads are JSON** `{ data: base64 }`, the project icon's body, so the contract carries the
  request and the MCP catalog can call it (`workspace_branding_upload`). `DELETE /workspace/branding`
  is the one-click Reset (`workspace_branding_reset`).
- **The logo keeps its file.** It stays `<CEZ_HOME>/branding-logo` with its multipart `POST
  /workspace/branding-logo`, so an existing logo needs no migration; it is a kind only for
  `DELETE /workspace/branding/logo` and Reset. Until a favicon is uploaded it stays the tab icon
  (order: favicon → logo → app icon → `/icon.svg`, the same in `brandingLinks` and the cockpit's
  `tabIconOf`).
- **An SVG favicon has no PNG sizes.** Rasterising SVG needs a renderer (resvg-wasm is ~2.5 MB);
  a browser without SVG favicons shows its own default. Upload a PNG favicon when that matters.
- **Opaque derivatives** (maskable 512 with the mark in the 80% safe zone, apple-touch 180) stand
  on the source's top-left pixel when it is opaque, else white.
- **Accent** is stored as `branding.accent` (`#rrggbb`) in `~/.cezar/config.json`. It replaces the
  DEFAULT accent only — a viewer who chose violet keeps violet — through `index.css`'s
  `[data-brand-accent]` rules reading `--brand-{dark,light}-*` custom properties the server stamps
  on `<html>` (`renderShellHtml`) and the cockpit updates live (`lib/brand-accent.ts`). Dark fill
  and ring reach 3:1 against `#131316`, ink 4.5:1; light ink 4.5:1 and ring 3:1 against white;
  text on a fill is near-black or white, whichever reads better. It also sets `theme-color`.
- **Public reads.** `GET /workspace/branding`, `/workspace/branding/:kind` and the old
  `/workspace/branding-logo` pass the sign-in guard (`isPublicBrandingRequest`); any API token
  may read them, but none of them is a `read`-scope route (the name is operator text). Every
  write — the old logo upload and removal included — answers 409 unless `trustedOperator()`.
- **Shell.** The catch-all renders `index.html` per request: `<title>`, every icon link, the
  apple-touch-icon, `<link rel="manifest">`, `og:title` and (with an app icon) an absolute
  `og:image` from `Host`/`X-Forwarded-*`. The manifest is `GET /manifest.webmanifest`, outside
  `/api` like `/icon.svg`.
- **Not built: the desktop window icon.** The Tauri shell's icon is compiled in; reading the
  brand at launch is a Rust follow-up — on start, after the sidecar answers, fetch
  `/manifest.webmanifest`, take the 512 `any` icon and `WebviewWindow::set_icon` it (needs
  Tauri's `image-png` feature; the dock/taskbar icon on macOS needs `app.set_icon` separately).
  Left undone rather than written blind, without a desktop build to verify it on.
