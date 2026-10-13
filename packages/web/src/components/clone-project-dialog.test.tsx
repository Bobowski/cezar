import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { GithubRepo, GithubReposResponse, ProjectListEntry } from '@open-mercato/cezar-api-client'
import { CloneProjectDialog, githubSsoUrl, matchRepos, pushedAgo } from '@/components/clone-project-dialog'
import { useGlobalSettings } from '@/components/global-settings'
import { ShellProviders } from '@/test/shell-providers'

/**
 * The clone-from-GitHub dialog (multi-project spec, "Add project" option B / step 4.3).
 *
 * Driven through a stubbed `fetch`, like the folder-browser dialog's suite: the request the
 * dialog puts on the wire (the `{url, name, checkoutId}` body) is half of what this step is.
 * Progress is driven by dispatching real `checkout-progress` events at the module-level
 * workspace-event registry, which is the same path the live EventSource takes.
 */

const fetchMock = vi.fn<typeof fetch>()

/** The workspace-event fan-out, captured so a test can play the server's side of the stream. */
let emitWorkspaceEvent: ((name: string, payload: unknown) => void) | null = null

vi.mock('@/api/global-events', () => ({
  onWorkspaceEvent: (listener: (name: string, payload: unknown) => void) => {
    emitWorkspaceEvent = listener
    return () => {
      emitWorkspaceEvent = null
    }
  },
}))

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  fetchMock.mockReset()
  emitWorkspaceEvent = null
  vi.unstubAllGlobals()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const PROJECT: ProjectListEntry = {
  id: 'cezar-2',
  name: 'cezar',
  root: '/home/me/cezar/projects/cezar',
  addedAt: '2026-07-20T00:00:00.000Z',
  lastOpenedAt: '2026-07-20T00:00:00.000Z',
  source: 'checkout',
  status: 'ok',
}

const posted: Record<string, unknown>[] = []

/** `checkout` answers the POST; it may be a deferred promise so a test can inspect the pending
 *  state (the progress line) before the clone "finishes". */
function serve(checkout: () => Promise<Response> = async () => json({ project: PROJECT }), repos?: GithubReposResponse): void {
  posted.length = 0
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/v1/projects/checkout') {
      posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return checkout()
    }
    // The picker: owners first, then the chosen owner's repositories (`?owner=`).
    if (url.pathname === '/api/v1/projects/github-owners' && repos) {
      return json(repos.available
        ? { available: true, owners: [{ login: 'me', personal: true }, { login: 'acme', personal: false, description: 'Builds rockets' }] }
        : { available: false, reason: repos.reason })
    }
    if (url.pathname === '/api/v1/projects/github-repos' && repos) {
      const owner = url.searchParams.get('owner')
      return json({ ...repos, repos: repos.repos.filter((entry) => owner === null || entry.owner === owner) })
    }
    if (url.pathname === '/api/v1/projects') {
      return json({ projects: [], bootProject: 'cezar', projectsDir: '~/cezar/projects' })
    }
    return json({ error: `unexpected ${String(init?.method ?? 'GET')} ${url.pathname}` }, 404)
  })
}

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

/** Where the global-settings dialog stands: the checkout-root control opens it on Projects. */
function SettingsProbe() {
  const settings = useGlobalSettings()
  return <output data-testid="global-settings" data-open={String(settings.isOpen)} data-section={settings.section ?? ''} />
}
const settingsProbe = () => document.querySelector('[data-testid="global-settings"]') as HTMLElement

function renderDialog() {
  const onOpenChange = vi.fn()
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/p/cezar/']}>
        <ShellProviders>
          <CloneProjectDialog open onOpenChange={onOpenChange} />
          <LocationProbe />
          <SettingsProbe />
        </ShellProviders>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onOpenChange }
}

const slot = (name: string) => document.querySelector(`[data-slot="${name}"]`) as HTMLElement | null
const urlInput = () => slot('clone-url') as HTMLInputElement
const nameInput = () => slot('clone-name') as HTMLInputElement
const cloneButton = () => slot('clone-confirm') as HTMLButtonElement
const rootSettingsControl = () => slot('clone-root-settings') as HTMLButtonElement

describe('CloneProjectDialog', () => {
  it('previews <projectsDir>/<repo> from the typed url and posts the trimmed reference', async () => {
    serve()
    const { onOpenChange } = renderDialog()
    await waitFor(() => expect(slot('clone-target')).toBeTruthy())

    fireEvent.change(urlInput(), { target: { value: 'https://github.com/open-mercato/cezar.git' } })
    // The name defaults to the repo half — the same rule the server applies.
    await waitFor(() => expect(slot('clone-target')?.textContent).toBe('~/cezar/projects/cezar'))
    // Global settings are a dialog now, so this is a button that opens it — not a link away.
    expect(rootSettingsControl().tagName).toBe('BUTTON')
    expect(rootSettingsControl().disabled).toBe(false)
    expect(rootSettingsControl().closest('a')).toBeNull()
    expect(rootSettingsControl().getAttribute('aria-label')).toBe('Edit checkout root')
    expect(rootSettingsControl().getAttribute('title')).toBe('Edit checkout root')

    fireEvent.click(cloneButton())
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ url: 'https://github.com/open-mercato/cezar.git' })
    // No `name` when it was never edited: the server owns the default.
    expect(posted[0]).not.toHaveProperty('name')
    expect(typeof posted[0]?.checkoutId).toBe('string')

    // Success closes the dialog and jumps to the new project's scope.
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    await waitFor(() => expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/p/cezar-2/'))
  })

  it('the checkout-root control steps aside for global settings, opened on Projects', async () => {
    serve()
    const { onOpenChange } = renderDialog()
    await waitFor(() => expect(slot('clone-target')).toBeTruthy())
    expect(settingsProbe().getAttribute('data-open')).toBe('false')

    fireEvent.click(rootSettingsControl())

    // One modal at a time: this dialog closes itself before the settings one opens over it…
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(settingsProbe().getAttribute('data-open')).toBe('true')
    expect(settingsProbe().getAttribute('data-section')).toBe('projects')
    // …and nothing navigated: the user keeps the page they were cloning from.
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/p/cezar/')
  })

  it('an edited folder name is previewed and posted', async () => {
    serve()
    renderDialog()
    fireEvent.change(urlInput(), { target: { value: 'open-mercato/cezar' } })
    fireEvent.change(nameInput(), { target: { value: 'cezar-fork' } })
    await waitFor(() => expect(slot('clone-target')?.textContent).toBe('~/cezar/projects/cezar-fork'))
    fireEvent.click(cloneButton())
    await waitFor(() => expect(posted[0]).toMatchObject({ name: 'cezar-fork' }))
  })

  it('renders checkout-progress lines for ITS OWN checkoutId and ignores another dialog\'s', async () => {
    let release: (res: Response) => void = () => {}
    serve(() => new Promise<Response>((resolve) => (release = resolve)))
    renderDialog()
    fireEvent.change(urlInput(), { target: { value: 'open-mercato/cezar' } })
    fireEvent.click(cloneButton())

    await waitFor(() => expect(slot('clone-progress')).toBeTruthy())
    // Pending, before any event: an honest placeholder rather than a blank line.
    expect(slot('clone-progress')?.textContent).toBe('Starting the clone…')
    // A clone cannot be dismissed while pending; the settings affordance follows the same rule
    // and becomes a disabled button rather than an active global navigation link (#561).
    expect(rootSettingsControl().tagName).toBe('BUTTON')
    expect(rootSettingsControl().disabled).toBe(true)
    expect(rootSettingsControl().getAttribute('aria-label')).toBe('Edit checkout root')
    fireEvent.click(rootSettingsControl())
    expect(settingsProbe().getAttribute('data-open')).toBe('false')
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/p/cezar/')

    const checkoutId = String(posted[0]?.checkoutId)
    emitWorkspaceEvent?.('checkout-progress', {
      checkoutId,
      name: 'cezar',
      phase: 'cloning',
      line: 'Receiving objects:  42% (420/1000)',
    })
    await waitFor(() => expect(slot('clone-progress')?.textContent).toBe('Receiving objects:  42% (420/1000)'))

    // Another tab's clone must never drive this dialog's line.
    emitWorkspaceEvent?.('checkout-progress', {
      checkoutId: 'someone-else',
      name: 'other',
      phase: 'cloning',
      line: 'not mine',
    })
    // …and neither does an unrelated workspace event.
    emitWorkspaceEvent?.('project-added', { project: PROJECT })
    await waitFor(() => expect(slot('clone-progress')?.textContent).toBe('Receiving objects:  42% (420/1000)'))

    release(json({ project: PROJECT }))
    await waitFor(() => expect(slot('clone-progress')).toBeNull())
  })

  it('shows the server\'s error VERBATIM and stays open — never a silent spinner', async () => {
    serve(async () => json({ error: 'gh CLI not found — install it and run `gh auth login`' }, 503))
    const { onOpenChange } = renderDialog()
    fireEvent.change(urlInput(), { target: { value: 'open-mercato/cezar' } })
    fireEvent.click(cloneButton())

    await waitFor(() =>
      expect(slot('clone-error')?.textContent).toContain('gh CLI not found'),
    )
    // Not closed, not navigated: the reader can fix the input and try again.
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/p/cezar/')
    expect(cloneButton().disabled).toBe(false)
  })

  it.each(['focus', 'visibility', 'manual'])('keeps SAML details and retries once via %s', async (mode) => {
    const ssoUrl =
      'https://github.com/orgs/Bug-Bounty-Switzerland/sso?authorization_request=AHBV4IUOPSOOJDNNTYUU4ALKUCFKNA5P'
    let attempts = 0
    serve(async () => {
      attempts += 1
      return attempts === 1
        ? json(
            {
              error:
                `GraphQL: Resource protected by organization SAML enforcement. ` +
                `You must grant your OAuth token access to this organization. (repository) ` +
                `Authorize in your web browser: ${ssoUrl}`,
            },
            500,
          )
        : json({ project: PROJECT })
    })
    const { onOpenChange } = renderDialog()
    fireEvent.change(urlInput(), { target: { value: 'Bug-Bounty-Switzerland/private-repo' } })
    fireEvent.click(cloneButton())

    await waitFor(() => expect(slot('clone-sso-link')).toBeTruthy())
    const link = slot('clone-sso-link') as HTMLAnchorElement
    expect(link.textContent).toBe('Authorize this GitHub organization')
    expect(link.href).toBe(ssoUrl)
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noreferrer')
    expect(slot('clone-error')?.textContent).toContain('return to this tab to retry')
    // The server's own words stay one click away, collapsed until asked for (a shadcn
    // Collapsible now, where this was a native <details>).
    const details = within(slot('clone-error') as HTMLElement).getByRole('button', { name: 'Error details' })
    expect(details.getAttribute('aria-expanded')).toBe('false')
    expect(slot('clone-error')?.textContent).not.toContain('SAML enforcement')
    fireEvent.click(details)
    expect(details.getAttribute('aria-expanded')).toBe('true')
    expect(slot('clone-error')?.textContent).toContain(`Authorize in your web browser: ${ssoUrl}`)
    fireEvent.click(details)
    expect(details.getAttribute('aria-expanded')).toBe('false')
    expect(cloneButton().textContent).toBe('Retry clone')

    fireEvent.click(link, { ctrlKey: mode === 'manual' })
    expect(slot('clone-error')?.textContent).toContain('or choose Retry clone')
    if (mode === 'visibility') {
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      fireEvent(document, new Event('visibilitychange'))
      expect(posted).toHaveLength(1)
      visibility.mockReturnValue('visible')
      fireEvent(document, new Event('visibilitychange'))
      fireEvent.focus(window)
    } else if (mode === 'manual') {
      expect(posted).toHaveLength(1)
      fireEvent.click(cloneButton())
    } else {
      fireEvent.focus(window)
    }

    await waitFor(() => expect(posted).toHaveLength(2))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('does not turn an arbitrary URL in clone output into a link', async () => {
    serve(async () => json({ error: 'remote: visit https://evil.example/authorize' }, 500))
    renderDialog()
    fireEvent.change(urlInput(), { target: { value: 'open-mercato/cezar' } })
    fireEvent.click(cloneButton())

    await waitFor(() => expect(slot('clone-error')?.textContent).toContain('evil.example'))
    expect(slot('clone-sso-link')).toBeNull()
    expect(slot('clone-error')?.querySelector('[data-slot="alert-description"]')?.className).toContain('break-all')
    expect(cloneButton().textContent).toBe('Retry clone')
  })

  it('surfaces the existing-folder 409 as an error rather than navigating anywhere', async () => {
    serve(async () => json({ error: 'folder already exists: /home/me/cezar/projects/cezar' }, 409))
    renderDialog()
    fireEvent.change(urlInput(), { target: { value: 'open-mercato/cezar' } })
    fireEvent.click(cloneButton())
    await waitFor(() => expect(slot('clone-error')?.textContent).toContain('already exists'))
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/p/cezar/')
  })

  it('the confirm button is inert until there is something to clone', async () => {
    serve()
    renderDialog()
    expect(cloneButton().disabled).toBe(true)
    fireEvent.change(urlInput(), { target: { value: '   ' } })
    expect(cloneButton().disabled).toBe(true)
    fireEvent.change(urlInput(), { target: { value: 'open-mercato/cezar' } })
    await waitFor(() => expect(cloneButton().disabled).toBe(false))
  })
})

const repo = (over: Partial<GithubRepo>): GithubRepo => ({
  slug: 'acme/shop', owner: 'acme', name: 'shop', description: null, private: false, fork: false, pushedAt: null, projectId: null, ...over,
})
const REPOS: GithubReposResponse = {
  available: true,
  reason: null,
  repos: [
    repo({ private: true, description: 'Medusa backend' }),
    repo({ slug: 'acme/storefront', name: 'storefront' }),
    repo({ slug: 'me/cezar', owner: 'me', name: 'cezar', projectId: 'cezar-2' }),
  ],
}
const rows = () => [...document.querySelectorAll('[data-slot="clone-repo"]')] as HTMLButtonElement[]
const owners = () => [...document.querySelectorAll<HTMLButtonElement>('[data-slot="clone-owner-option"]')]
const pickedOwner = () => owners().find((card) => card.getAttribute('aria-checked') === 'true')?.dataset.owner

describe('CloneProjectDialog — organization, then repository', () => {
  it('lists the first account’s repositories and clones the one that is picked', async () => {
    serve(undefined, REPOS)
    renderDialog()
    // The personal account leads and is selected; its repositories are the ones listed.
    await waitFor(() => expect(owners().map((card) => card.dataset.owner)).toEqual(['me', 'acme']))
    expect(pickedOwner()).toBe('me')
    await waitFor(() => expect(rows().map((row) => row.textContent)).toEqual(['cezarAdded']))

    fireEvent.click(owners()[1]!)
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows()[0]?.textContent).toContain('shop')
    expect(rows()[0]?.querySelector('[aria-label="Private"]')).not.toBeNull()

    fireEvent.click(rows()[1]!)
    expect(urlInput().value).toBe('acme/storefront')
    await waitFor(() => expect(slot('clone-target')?.textContent).toBe('~/cezar/projects/storefront'))
    // A pick is a selection, not a search: the other rows stay within reach.
    expect(rows()).toHaveLength(2)
    expect(rows()[1]?.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(cloneButton())
    await waitFor(() => expect(posted[0]).toMatchObject({ url: 'acme/storefront' }))
  })

  it('narrows as you type, still takes a pasted URL, and starts over on another organization', async () => {
    serve(undefined, REPOS)
    renderDialog()
    await waitFor(() => expect(owners()).toHaveLength(2))
    fireEvent.click(owners()[1]!)
    await waitFor(() => expect(rows()).toHaveLength(2))
    fireEvent.change(urlInput(), { target: { value: 'medusa' } })
    expect(rows()).toHaveLength(1)
    fireEvent.change(urlInput(), { target: { value: 'https://github.com/other/thing' } })
    expect(rows()).toHaveLength(0)
    expect(cloneButton().disabled).toBe(false)
    fireEvent.click(owners()[0]!)
    expect(urlInput().value).toBe('')
  })

  it('opens a repository that is already a project instead of cloning it again', async () => {
    serve(undefined, REPOS)
    const { onOpenChange } = renderDialog()
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.click(rows()[0]!)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    await waitFor(() => expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/p/cezar-2/'))
    expect(posted).toHaveLength(0)
  })

  it('says why GitHub is missing and keeps the paste field working, in one column', async () => {
    serve(undefined, { available: false, reason: 'gh is not signed in — run `gh auth login`', repos: [] })
    renderDialog()
    await waitFor(() => expect(slot('clone-repos-unavailable')?.textContent).toContain('gh is not signed in'))
    expect(slot('clone-repos')).toBeNull()
    expect(slot('clone-owners-column')).toBeNull()
    fireEvent.change(urlInput(), { target: { value: 'open-mercato/cezar' } })
    await waitFor(() => expect(cloneButton().disabled).toBe(false))
  })

  it('orders nothing itself: it filters and it words the age', () => {
    expect(matchRepos(REPOS.repos, ' ACME/Shop ')).toHaveLength(3)
    expect(matchRepos(REPOS.repos, 'store').map((r) => r.slug)).toEqual(['acme/storefront'])
    const now = Date.parse('2026-10-13T12:00:00Z')
    expect(pushedAgo('2026-10-13T08:00:00Z', now)).toBe('today')
    expect(pushedAgo('2026-10-01T12:00:00Z', now)).toBe('12d ago')
    expect(pushedAgo('2026-06-01T12:00:00Z', now)).toBe('4mo ago')
    expect(pushedAgo('2024-06-01T12:00:00Z', now)).toBe('2y ago')
    expect(pushedAgo(null, now)).toBe('')
  })
})

describe('githubSsoUrl', () => {
  const url = 'https://github.com/orgs/Acme/sso?authorization_request=ABC'
  it.each(['==', '%2FDEF', '&extra=1', ')'])('rejects a partial token before %s', (suffix) => {
    expect(githubSsoUrl(new Error(url + suffix))).toBeNull()
  })
  it.each(['', '\nnext line', '"', "'"])('accepts a complete URL before %s', (suffix) => {
    expect(githubSsoUrl(new Error(url + suffix))).toBe(url)
  })
  it.each(['https://github.com.evil.example', 'http://github.com', 'https://evil.example@github.com'])('rejects %s', (host) => {
    expect(githubSsoUrl(new Error(url.replace('https://github.com', host)))).toBeNull()
  })
})
