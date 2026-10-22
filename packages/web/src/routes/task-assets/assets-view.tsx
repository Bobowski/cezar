import {
  ChevronDownIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileIcon,
  LayersIcon,
  LoaderCircleIcon,
  RotateCwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useCallback, useState } from 'react'
import { useParams } from 'react-router'

import { runArtifactRawUrl } from '@/api/client'
import { useRunArtifacts, useRunArtifactText } from '@/api/queries'
import type { RunArtifact } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { useResolvedTheme } from '@/components/theme-provider'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { shortAge } from '@/lib/format'
import { useNavigate } from '@/lib/project-router'

import { CodeLines } from '../task-git/file-preview'
import { Markdown } from '../task-thread/markdown'
import {
  ARTIFACT_IFRAME_SANDBOX,
  artifactLabel,
  byNewest,
  KIND_LABELS,
  pickArtifact,
} from './assets-model'

export const ASSETS_EMPTY_TITLE = 'No assets yet'
export const ASSETS_EMPTY_SUBTITLE =
  "Agents publish pages here when they write to the run's artifacts folder."

/**
 * The task's Assets view (spec 2026-10-22-html-artifacts-and-impact § UI/UX, R2): ONE toolbar row —
 * the asset switcher, Open, Download, Reload — and the asset at full width below it.
 *
 * `routed`: the view fills its layout on its own (the Assets tab), so the selection lives in the
 * URL (`tasks/:id/assets/:name`). In a split layout it stays local — navigating there would swap
 * the user's arrangement for the Assets tab.
 */
export function AssetsView({ runId, routed }: { runId: string; routed: boolean }) {
  const listing = useRunArtifacts(runId)
  const params = useParams<{ name?: string }>()
  const navigate = useNavigate()
  const [localName, setLocalName] = useState<string | undefined>(undefined)
  const wanted = routed ? params.name : localName
  const artifacts = listing.data?.artifacts ?? []
  const current = pickArtifact(artifacts, wanted)

  const select = useCallback(
    (name: string) => {
      if (routed) navigate(`/tasks/${runId}/assets/${encodeURIComponent(name)}`, { replace: true })
      else setLocalName(name)
    },
    [navigate, routed, runId],
  )

  const [reloads, setReloads] = useState(0)

  if (listing.isPending) {
    return (
      <CenteredState
        icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
        tone="neutral"
        heading="h2"
        title="Loading assets…"
      />
    )
  }
  if (listing.isError) {
    return (
      <CenteredState
        icon={<TriangleAlertIcon />}
        tone="danger"
        heading="h2"
        title="Could not load this task's assets"
        subtitle={listing.error.message}
      />
    )
  }

  return (
    <section data-slot="assets-view" className="flex min-h-0 flex-1 flex-col bg-background">
      <div
        data-slot="assets-toolbar"
        role="toolbar"
        aria-label="Assets"
        className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2 sm:px-3"
      >
        {current ? (
          <AssetSwitcher artifacts={artifacts} current={current} onSelect={select} />
        ) : (
          <span className="px-1 text-xs text-muted-foreground">Assets</span>
        )}
        {current?.kind === 'html' ? (
          <span
            data-slot="assets-sandboxed"
            title="Runs in a sandbox: no access to cezar, your cookies or the network beyond pinned CDN scripts"
            className="hidden items-center gap-1 rounded-sm border border-border px-1.5 py-px text-[11px] text-muted-foreground sm:inline-flex"
          >
            <ShieldCheckIcon aria-hidden="true" className="size-3" />
            sandboxed
          </span>
        ) : null}
        {listing.data.truncated ? (
          <span className="hidden text-[11px] text-muted-foreground md:inline">Showing the first 64 files</span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {current ? (
            <>
              <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground">
                <a
                  data-action="assets-open"
                  href={runArtifactRawUrl(runId, current.name)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open in new tab"
                  title="Open in new tab (still sandboxed)"
                >
                  <ExternalLinkIcon aria-hidden="true" />
                </a>
              </Button>
              <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground">
                <a
                  data-action="assets-download"
                  href={runArtifactRawUrl(runId, current.name)}
                  download={current.name}
                  aria-label="Download"
                  title="Download"
                >
                  <DownloadIcon aria-hidden="true" />
                </a>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-action="assets-reload"
                aria-label="Reload"
                title="Reload"
                className="text-muted-foreground"
                onClick={() => setReloads((count) => count + 1)}
              >
                <RotateCwIcon aria-hidden="true" />
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {current ? (
        <AssetBody key={`${current.name}@${current.updatedAt}#${reloads}`} runId={runId} artifact={current} />
      ) : (
        <CenteredState
          icon={<LayersIcon />}
          tone="neutral"
          heading="h2"
          title={ASSETS_EMPTY_TITLE}
          subtitle={ASSETS_EMPTY_SUBTITLE}
        />
      )}
    </section>
  )
}

function AssetSwitcher({
  artifacts,
  current,
  onSelect,
}: {
  artifacts: readonly RunArtifact[]
  current: RunArtifact
  onSelect: (name: string) => void
}) {
  const sorted = byNewest(artifacts)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-action="assets-switcher"
          aria-label={`Asset: ${artifactLabel(current)} — switch asset`}
          className="h-7 min-w-0 max-w-[min(28rem,60vw)] gap-1.5 px-2 text-[13px] font-medium"
        >
          <span className="truncate">{artifactLabel(current)}</span>
          <span className="shrink-0 text-[11px] font-normal text-muted-foreground">{KIND_LABELS[current.kind]}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-80 overflow-y-auto">
        <DropdownMenuLabel>
          {artifacts.length} {artifacts.length === 1 ? 'asset' : 'assets'}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={current.name} onValueChange={onSelect}>
          {sorted.map((artifact) => (
            <DropdownMenuRadioItem key={artifact.name} value={artifact.name} data-asset={artifact.name}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{artifactLabel(artifact)}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {artifact.name} · {KIND_LABELS[artifact.kind]} · {shortAge(artifact.updatedAt)}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** One asset, by kind. Keyed by name + `updatedAt` + reloads above, so a rewrite or Reload
 *  remounts it — the frame re-requests the page. */
function AssetBody({ runId, artifact }: { runId: string; artifact: RunArtifact }) {
  const theme = useResolvedTheme()
  const raw = runArtifactRawUrl(runId, artifact.name)
  switch (artifact.kind) {
    case 'html':
      // Never `srcdoc`, never `allow-same-origin`: the served page carries its own CSP sandbox too
      // (spec Q3), and `#theme=` lets the page match the cockpit without reaching into it.
      return (
        <iframe
          data-slot="assets-frame"
          title={artifactLabel(artifact)}
          src={`${raw}#theme=${theme}`}
          sandbox={ARTIFACT_IFRAME_SANDBOX}
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0 bg-background"
        />
      )
    case 'image':
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
          <img data-slot="assets-image" src={raw} alt={artifactLabel(artifact)} className="max-w-full rounded-sm" />
        </div>
      )
    case 'markdown':
    case 'json':
      return <TextAsset runId={runId} artifact={artifact} />
    case 'other':
      return (
        <CenteredState
          icon={<FileIcon />}
          tone="neutral"
          heading="h2"
          title="No preview for this file"
          subtitle={`${artifact.name} — download it to open it locally.`}
          actions={
            <Button asChild variant="outline">
              <a data-action="assets-download-file" href={raw} download={artifact.name}>
                <DownloadIcon aria-hidden="true" />
                Download
              </a>
            </Button>
          }
        />
      )
  }
}

function TextAsset({ runId, artifact }: { runId: string; artifact: RunArtifact }) {
  const text = useRunArtifactText(runId, artifact.name, artifact.updatedAt)
  if (text.isPending) {
    return <p className="px-4 py-6 text-center text-xs text-soft-foreground">Loading {artifact.name}…</p>
  }
  if (text.isError) {
    return (
      <CenteredState
        icon={<TriangleAlertIcon />}
        tone="danger"
        heading="h2"
        title="Could not load this asset"
        subtitle={text.error.message}
      />
    )
  }
  return (
    <div data-slot={`assets-${artifact.kind}`} className="min-h-0 flex-1 overflow-auto">
      {artifact.kind === 'markdown' ? (
        <div className="mx-auto max-w-3xl px-4 py-4">
          <Markdown>{text.data}</Markdown>
        </div>
      ) : (
        <CodeLines path={artifact.name} text={text.data} />
      )}
    </div>
  )
}
