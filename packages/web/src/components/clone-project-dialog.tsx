import { ChevronRightIcon, LockIcon, SettingsIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useGlobalSettings } from '@/components/global-settings'

import { onWorkspaceEvent } from '@/api/global-events'
import { useCheckoutProject, useGithubOwners, useGithubRepos, useProjects } from '@/api/queries'
import type { CheckoutProgressEvent, GithubRepo } from '@open-mercato/cezar-api-client'
import { GithubOwnerPicker, GithubOwnerPickerLoading } from '@/components/github-owner-picker'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { bareButton } from '@/components/bare-control'
import { cn } from '@/lib/utils'

/**
 * GitHub prints this URL when an otherwise-valid OAuth token still needs SAML
 * authorization for the repository's organization. The failed `gh` process
 * cannot resume after the browser flow, so the dialog turns the URL into a
 * trusted link and makes the required retry explicit.
 *
 * Keep this deliberately narrower than "find a URL": clone errors include
 * output influenced by the remote, and rendering arbitrary output as a link
 * would make the local cockpit an excellent phishing surface.
 *
 * Anchored at the END too, which matters as much as the `https://github.com/orgs/`
 * prefix: the token charset cannot spell `%2F` or `=` padding, and an unanchored
 * match would silently CUT such a token short and hand back a link
 * indistinguishable from a good one. Refusing is the better failure — the caller
 * then shows the raw error, which still contains the real URL to open by hand.
 */
export function githubSsoUrl(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  const match = error.message.match(
    /https:\/\/github\.com\/orgs\/[A-Za-z0-9._-]+\/sso\?authorization_request=[A-Za-z0-9._~-]+(?![^\s'"<>])/,
  )
  return match?.[0] ?? null
}

/** How long ago a repository was pushed to, in the fewest words that still order a list. */
export function pushedAgo(pushedAt: string | null, now = Date.now()): string {
  const then = pushedAt === null ? Number.NaN : Date.parse(pushedAt)
  if (Number.isNaN(then)) return ''
  const days = Math.floor((now - then) / 86_400_000)
  if (days < 1) return 'today'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

/** Rows shown at once: the list is a picker, and a longer one is a search away. */
const REPO_ROWS = 60

/**
 * The picker's rows for what is typed. An exact slug is a SELECTION, not a search — the whole
 * list stays, so picking a different repository does not start with clearing the field.
 */
export function matchRepos(repos: GithubRepo[], typed: string): GithubRepo[] {
  const needle = typed.trim().toLowerCase()
  if (needle === '' || repos.some((repo) => repo.slug.toLowerCase() === needle)) return repos.slice(0, REPO_ROWS)
  return repos
    .filter((repo) => repo.slug.toLowerCase().includes(needle) || (repo.description ?? '').toLowerCase().includes(needle))
    .slice(0, REPO_ROWS)
}

/**
 * "Add project → Clone from GitHub" (multi-project spec, "Add project" option B / step 4.3).
 *
 * The mockup's three parts, and what each one is faithful to:
 *
 * - **Organization, then repository** — the New project dialog's layout: the accounts `gh` is
 *   signed into on the left, the chosen one's repositories on the right, most recently pushed
 *   first. Picking a row writes its `owner/repo` into the input; typing narrows the list. When
 *   GitHub cannot be read the input alone remains, with the reason.
 * - **The repo input** takes `owner/repo` or any GitHub URL spelling. It is NOT validated here
 *   beyond "non-empty": the server parses it with the one parser that also decides what `gh`
 *   is handed, and a second, looser copy in the browser would only disagree with it.
 * - **The target preview** (`<projectsDir>/<name>`) is assembled from the registry response's
 *   `projectsDir` plus the editable name. It is a preview of the server's own composition rule,
 *   which is why the name defaults to the repo half of whatever was typed.
 * - **Progress** is the `checkout-progress` stream, filtered to THIS dialog's `checkoutId`.
 *   Without it a clone of a large repo is an indistinguishable-from-hung spinner for minutes.
 *
 * Errors are shown verbatim (`{ error }`): a clone fails for reasons — `gh` missing, not
 * authenticated, no such repo, target folder exists, DNS down — that only the server can name,
 * and paraphrasing them into "could not clone" is exactly the silent-spinner failure this
 * dialog exists to avoid. SAML errors add an authorization link and keep the original
 * message available under Error details.
 */
export function CloneProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const globalSettings = useGlobalSettings()
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [owner, setOwner] = useState('')
  const [progress, setProgress] = useState<string | null>(null)
  const [awaitingSso, setAwaitingSso] = useState(false)
  const ssoRetryArmed = useRef(false)
  const projects = useProjects()
  const checkout = useCheckoutProject()
  const owners = useGithubOwners()
  const { mutate, isPending } = checkout
  const navigate = useNavigate()
  const ssoUrl = githubSsoUrl(checkout.error)

  const ownersData = owners.data
  const ownerOptions = useMemo(
    () => (ownersData?.available && Array.isArray(ownersData.owners) ? ownersData.owners : []),
    [ownersData],
  )
  const githubAvailable = ownerOptions.length > 0
  // The personal account is first, so it is the default until the user picks an organisation.
  const effectiveOwner = ownerOptions.some((o) => o.login === owner) ? owner : (ownerOptions[0]?.login ?? '')
  const repos = useGithubRepos(
    githubAvailable ? effectiveOwner : null,
    ownerOptions.find((o) => o.login === effectiveOwner)?.personal === true,
  )
  const listed = repos.data?.available ? matchRepos(repos.data.repos, url) : []
  const picked = listed.find((repo) => repo.slug.toLowerCase() === url.trim().toLowerCase())?.slug ?? ''
  // Why there is no list, in the server's words — `gh` missing, signed out, offline.
  const unavailable =
    ownersData && !ownersData.available ? ownersData.reason : repos.data && !repos.data.available ? repos.data.reason : null

  // One id per mounted dialog. The dialog is mounted only while open (AddProjectMenu), so a
  // second clone attempt in a second opening is a second id — which is the point: a stale
  // event from an abandoned clone must never drive this one's progress line.
  const checkoutId = useMemo(() => `co-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`, [])

  // Kept in a ref, not state: the listener below must read the CURRENT id without re-subscribing
  // (a resubscribe per render would drop events between teardown and setup).
  const idRef = useRef(checkoutId)
  idRef.current = checkoutId

  useEffect(() => {
    return onWorkspaceEvent((eventName, payload) => {
      if (eventName !== 'checkout-progress') return
      const event = payload as CheckoutProgressEvent
      if (event?.checkoutId !== idRef.current) return
      // `error` is surfaced through the mutation's own rejection (the response carries it too),
      // so the terminal phases only stop the progress line rather than racing it.
      if (event.phase === 'cloning' && event.line) setProgress(event.line)
      else if (event.phase !== 'cloning') setProgress(null)
    })
  }, [])

  /** The repo half of whatever was typed, used as the default folder name. Deliberately naive —
   *  it mirrors the server's default, and the server re-derives it anyway when `name` is blank. */
  const derivedName = useMemo(() => {
    const cleaned = url.trim().replace(/\/+$/, '').replace(/\.git$/, '')
    const last = cleaned.split('/').pop() ?? ''
    return last.includes(':') ? (last.split(':').pop() ?? '') : last
  }, [url])
  const effectiveName = name.trim() === '' ? derivedName : name.trim()

  const projectsDir = projects.data?.projectsDir ?? ''
  const target = effectiveName === '' ? '' : `${projectsDir.replace(/\/+$/, '')}/${effectiveName}`

  const clone = useCallback(() => {
    if (url.trim() === '' || isPending) return
    ssoRetryArmed.current = false
    setAwaitingSso(false)
    setProgress(null)
    mutate(
      { url: url.trim(), checkoutId, ...(name.trim() === '' ? {} : { name: name.trim() }) },
      {
        onSuccess: ({ project }) => {
          onOpenChange(false)
          // Raw react-router `useNavigate`, not the scope-aware wrapper — a deliberate
          // cross-project jump, exactly as the folder-browser dialog does.
          navigate(`/p/${encodeURIComponent(project.id)}/`)
        },
      },
    )
  }, [mutate, isPending, checkoutId, name, navigate, onOpenChange, url])

  const pick = (slug: string) => {
    const repo = listed.find((entry) => entry.slug === slug)
    if (!repo) return
    // Already a project here: open it instead of cloning a second copy.
    if (repo.projectId !== null) {
      onOpenChange(false)
      navigate(`/p/${encodeURIComponent(repo.projectId)}/`)
      return
    }
    setUrl(repo.slug)
    setName('')
  }

  // Authorizing an existing OAuth token changes GitHub's server-side token
  // grant; it cannot wake the `gh repo clone` process that already exited.
  // Returning to this tab is the only browser signal available to the local
  // cockpit, so retry once on focus/visibility after the user follows the SSO
  // link. The ref prevents browsers that emit both events from cloning twice.
  useEffect(() => {
    if (!awaitingSso) return
    const retry = (): void => {
      if (!ssoRetryArmed.current) return
      ssoRetryArmed.current = false
      setAwaitingSso(false)
      clone()
    }
    const retryWhenVisible = (): void => {
      if (document.visibilityState === 'visible') retry()
    }
    window.addEventListener('focus', retry)
    document.addEventListener('visibilitychange', retryWhenVisible)
    return () => {
      window.removeEventListener('focus', retry)
      document.removeEventListener('visibilitychange', retryWhenVisible)
    }
  }, [awaitingSso, clone])

  // The New project dialog's shape: owners on the left, the form on the right, a fixed height
  // from `md` up so a long list never resizes the dialog. Without GitHub it is the form alone.
  const showOwners = owners.isPending || githubAvailable

  return (
    <Dialog open={open} onOpenChange={(next) => (checkout.isPending ? undefined : onOpenChange(next))}>
      <DialogContent
        data-slot="clone-project-dialog"
        className={cn(
          'min-w-0 max-h-[calc(100dvh-2rem)] overflow-x-hidden overflow-y-auto',
          showOwners
            ? 'md:h-[min(50rem,calc(100dvh-4rem))] md:max-w-3xl md:grid-rows-[auto_minmax(0,1fr)_auto] md:overflow-hidden'
            : 'sm:max-w-lg',
        )}
      >
        <DialogHeader>
          <DialogTitle>Clone from GitHub</DialogTitle>
          <DialogDescription>
            The service clones with <code className="font-mono text-[13px]">gh</code> into your checkout root and adds the result as a project.
          </DialogDescription>
        </DialogHeader>

        <div
          data-slot="clone-layout"
          className={cn('grid min-w-0 gap-6', showOwners ? 'md:min-h-0 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]' : undefined)}
        >
          {showOwners ? (
            <div data-slot="clone-owners-column" className="min-w-0 md:flex md:min-h-0 md:flex-col md:border-r md:border-border md:pr-6">
              {githubAvailable ? (
                <GithubOwnerPicker
                  slot="clone"
                  owners={ownerOptions}
                  value={effectiveOwner}
                  disabled={checkout.isPending}
                  onChange={(login) => {
                    setOwner(login)
                    // The typed text narrowed the PREVIOUS owner's list.
                    setUrl('')
                  }}
                />
              ) : (
                <GithubOwnerPickerLoading slot="clone" />
              )}
            </div>
          ) : null}

          <FieldGroup className={cn('min-w-0 gap-4', showOwners ? 'md:min-h-0' : undefined)}>
            <Field className={showOwners ? 'md:min-h-0 md:flex-1' : undefined}>
              <FieldLabel htmlFor="clone-url">Repository</FieldLabel>
              <Input
                id="clone-url"
                data-slot="clone-url"
                autoFocus
                placeholder={githubAvailable ? `Search ${effectiveOwner}, or paste owner/repo or a URL` : 'owner/repo or https://github.com/owner/repo'}
                value={url}
                disabled={checkout.isPending}
                onChange={(event) => setUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') clone()
                }}
              />
              {unavailable ? (
                <FieldDescription data-slot="clone-repos-unavailable">
                  Your repositories could not be listed ({unavailable}). Paste one instead.
                </FieldDescription>
              ) : null}
              {githubAvailable && repos.isPending ? (
                <div data-slot="clone-repos-loading" aria-hidden="true" className="grid gap-2 rounded-md border border-border p-3">
                  {[0, 1, 2].map((index) => <Skeleton key={index} className="h-4 w-2/3" />)}
                </div>
              ) : null}
              {repos.data?.available ? (
                <ToggleGroup
                  type="single"
                  orientation="vertical"
                  value={picked}
                  disabled={checkout.isPending}
                  onValueChange={(next) => (next ? pick(next) : undefined)}
                  aria-label={`Repositories of ${effectiveOwner}`}
                  data-slot="clone-repos"
                  className="max-h-60 w-full flex-col items-stretch overflow-y-auto rounded-md border border-border md:max-h-none md:min-h-0 md:flex-1"
                >
                  {listed.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">No repository matches. A full URL still works.</p>
                  ) : null}
                  {listed.map((repo: GithubRepo) => (
                    <ToggleGroupItem
                      key={repo.slug}
                      value={repo.slug}
                      data-slot="clone-repo"
                      className="h-auto w-full shrink-0 justify-start gap-2 rounded-none px-3 py-1.5 text-left font-normal first:rounded-none last:rounded-none"
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
                          <span className="truncate font-medium text-foreground">{repo.name}</span>
                          {repo.private ? <LockIcon aria-label="Private" className="size-3 shrink-0 text-muted-foreground" /> : null}
                        </span>
                        {repo.description ? <span className="truncate text-xs text-muted-foreground">{repo.description}</span> : null}
                      </span>
                      {repo.projectId !== null ? (
                        <Badge variant="secondary">Added</Badge>
                      ) : (
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{pushedAgo(repo.pushedAt)}</span>
                      )}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              ) : null}
            </Field>

            <Field>
              <FieldLabel htmlFor="clone-name">Folder name</FieldLabel>
              <Input
                id="clone-name"
                data-slot="clone-name"
                placeholder={derivedName === '' ? 'repo' : derivedName}
                value={name}
                disabled={checkout.isPending}
                onChange={(event) => setName(event.target.value)}
              />
              <div className="flex min-w-0 items-center gap-1 rounded-md bg-muted py-0.5 pr-0.5 pl-2.5">
                <p data-slot="clone-target" className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={target}>
                  {target}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7"
                  data-slot="clone-root-settings"
                  aria-label="Edit checkout root"
                  title="Edit checkout root"
                  disabled={checkout.isPending}
                  // One modal at a time: this dialog steps aside for the settings one.
                  onClick={() => {
                    onOpenChange(false)
                    globalSettings.open('projects')
                  }}
                >
                  <SettingsIcon className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            </Field>

            {/* One line, replaced in place: `git clone` emits a counter update every few hundred ms,
                and a growing log would scroll a dialog that is otherwise a form. */}
            {checkout.isPending ? (
              <p data-slot="clone-progress" className="flex min-w-0 items-center gap-2 font-mono text-xs text-muted-foreground">
                <Spinner className="size-3.5 shrink-0" />
                <span className="truncate">{progress ?? 'Starting the clone…'}</span>
              </p>
            ) : null}

            {checkout.isError ? (
              <Alert variant="destructive" data-slot="clone-error" className="min-w-0">
                {ssoUrl ? (
                  <>
                    <AlertTitle>GitHub requires SAML authorization for this organization.</AlertTitle>
                    <AlertDescription>
                      <p>
                        <a
                          data-slot="clone-sso-link"
                          className="font-medium underline underline-offset-2"
                          href={ssoUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={() => {
                            ssoRetryArmed.current = true
                            setAwaitingSso(true)
                          }}
                        >
                          Authorize this GitHub organization
                        </a>
                        {awaitingSso
                          ? ' — return here after authorizing, or choose Retry clone.'
                          : ' — return to this tab to retry, or choose Retry clone.'}
                      </p>
                      <Collapsible className="min-w-0">
                        <CollapsibleTrigger asChild>
                          <Button variant="ghost" className={cn(bareButton, 'gap-1 hover:underline [&[data-state=open]>svg]:rotate-90')}>
                            <ChevronRightIcon aria-hidden="true" className="size-3 transition-transform" />
                            Error details
                          </Button>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <p className="whitespace-pre-wrap break-all">
                            {checkout.error instanceof Error ? checkout.error.message : null}
                          </p>
                        </CollapsibleContent>
                      </Collapsible>
                    </AlertDescription>
                  </>
                ) : (
                  <AlertDescription className="whitespace-pre-wrap break-all">
                    {checkout.error instanceof Error ? checkout.error.message : 'could not clone that repository'}
                  </AlertDescription>
                )}
              </Alert>
            ) : null}
          </FieldGroup>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={checkout.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="default"
            data-slot="clone-confirm"
            disabled={url.trim() === '' || effectiveName === '' || checkout.isPending}
            onClick={clone}
          >
            {checkout.isPending ? 'Cloning…' : checkout.isError ? 'Retry clone' : 'Clone'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
