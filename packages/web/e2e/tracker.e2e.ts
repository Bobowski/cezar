import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

let browser: AgentBrowser
let baseUrl: string
let project: string
let saved: string | null
const createdRuns: string[] = []
const stateFile = resolve(import.meta.dirname, '../../../.ai/cezar/tracker.json')
const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/tracker')
const clickText = (text: string) => browser.evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)});
  if (!button) throw new Error('Missing button: ' + ${JSON.stringify(text)});
  button.click();
})()`)
const page = (path: string) => baseUrl + '/p/' + project + path

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  project = await bootProjectId(baseUrl)
  saved = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : null
  await fetch(baseUrl + '/api/v1/tracker/association', { method: 'DELETE' })
  browser = AgentBrowser.open('tracker-' + process.pid)
  browser.setViewport(1440, 1000)
})
afterAll(async () => {
  browser?.close()
  for (const id of createdRuns) {
    await fetch(baseUrl + '/api/v1/runs/' + id + '/cancel', { method: 'POST' })
    for (let attempt = 0; attempt < 40; attempt++) {
      const removed = await fetch(baseUrl + '/api/v1/runs/' + id, { method: 'DELETE' })
      if (removed.ok || removed.status === 404) break
      if (removed.status !== 409 || attempt === 39) throw new Error('Could not remove tracker test run ' + id)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  await fetch(baseUrl + '/api/v1/tracker/association', { method: 'DELETE' })
  if (saved !== null) writeFileSync(stateFile, saved)
  else rmSync(stateFile, { force: true })
})

/** The issue surface (spec 2026-10-11-tracker-ticket-context): a full-width list or board, the
 *  open issue in a panel beside it with its comments, tasks and composer, and one vendor write —
 *  a status change made by hand. Everything runs against the demo tracker (`CEZ_DRY_RUN=1`). */
describe('tracker complete flow', () => {
  it('connects a Jira candidate beyond page one from Settings', async () => {
    browser.goto(page('/settings/tracker'))
    browser.waitForFunction("document.body.textContent.includes('No tracker connected')")
    browser.screenshot(artifacts + '/01-setup.png')
    clickText('Browse Jira')
    browser.waitForFunction("document.body.textContent.includes('Project 50')")
    clickText('Load more')
    browser.waitForFunction("document.body.textContent.includes('Project 51')")
    clickText('Project 51')
    clickText('Connect')
    browser.waitForFunction("document.body.textContent.includes('Disconnect')")
    expect(await fetch(baseUrl + '/api/v1/tracker/association').then(r => r.json()))
      .toMatchObject({ association: { kind: 'jira', externalId: '51' } })
    browser.screenshot(artifacts + '/02-connected.png')
  })
  it('browses, finds completed tickets outside page one and loads full handoff context', () => {
    browser.goto(page('/tracker'))
    browser.waitForFunction("document.body.textContent.includes('DEMO51-1')")
    // The list fills main, grouped under a heading per loaded status; nothing is opened by itself.
    browser.waitForFunction("document.querySelectorAll('[data-route=\"tracker\"] [data-slot=\"tracker-group\"]').length >= 2")
    expect(browser.count('[data-slot="tracker-panel"]')).toBe(0)
    expect(browser.evaluate("[...document.querySelectorAll('[data-slot=\"tracker-group\"]')].map(group => group.getAttribute('aria-label')).includes('In Progress')")).toBe(true)
    // Assignee and priority ride the list read.
    expect(browser.count('[data-slot="tracker-row"] [data-slot="tracker-assignee"]')).toBeGreaterThan(0)
    expect(browser.count('[data-slot="tracker-row"] [data-slot="tracker-priority"]')).toBeGreaterThan(0)
    browser.screenshot(artifacts + '/03-jira-list.png')
    // The same issues as a board: one column per loaded status.
    clickText('Board')
    browser.waitForFunction("document.querySelectorAll('[data-slot=\"tracker-column\"]').length >= 2")
    expect(browser.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true)
    browser.screenshot(artifacts + '/03b-jira-board.png')
    clickText('List')
    browser.waitForFunction("document.querySelector('[data-slot=\"tracker-group\"]') !== null")
    browser.fill('[aria-label="Search tracker"]', 'DEMO51-125')
    // Search is submitted rather than filtering the initial page.
    browser.evaluate("document.querySelector('[aria-label=\"Search tracker\"]').form?.requestSubmit()")
    browser.waitForFunction("document.body.textContent.includes('DEMO51-125')")
    browser.goto(page('/tracker/DEMO51-2'))
    browser.waitForFunction("document.body.textContent.includes('Acceptance: preserve all requirements.')")
    browser.waitForFunction("document.querySelector('[data-slot=\"tracker-handoff\"]') !== null")
    expect(browser.evaluate("document.body.textContent.includes('Custom instruction')")).toBe(true)
    // The issue opens in a panel beside the list, with its comment thread under the description.
    expect(browser.count('[data-slot="tracker-panel"]')).toBe(1)
    expect(browser.count('[data-slot="tracker-list"]')).toBe(1)
    browser.waitForFunction("document.querySelectorAll('[data-slot=\"tracker-comment\"]').length === 3")
    expect(browser.evaluate("document.querySelector('[data-slot=\"tracker-comments\"]').textContent.includes('Decision: keep the old endpoint')")).toBe(true)
    browser.screenshot(artifacts + '/04-full-detail.png')
    browser.evaluate("document.querySelector('[data-slot=\"tracker-handoff\"]').scrollIntoView()")
    browser.screenshot(artifacts + '/04b-handoff.png', { viewport: true })
  })
  it('launches a full description snapshot with the custom instruction last', async () => {
    browser.goto(page('/tracker/DEMO51-2'))
    browser.waitForFunction("document.querySelector('#tracker-instruction') !== null")
    browser.fill('#tracker-instruction', 'Tracker acceptance: preserve this instruction last.')
    clickText('Run agent on this issue')
    browser.waitForFunction("document.querySelector('[data-slot=\"tracker-handoff\"] a[href*=\"/tasks/\"]') !== null")
    const href = String(browser.evaluate("document.querySelector('[data-slot=\"tracker-handoff\"] a[href*=\"/tasks/\"]').getAttribute('href')"))
    const id = href.split('/').at(-1)!
    createdRuns.push(id)
    const run = await fetch(baseUrl + '/api/v1/runs/' + id).then(r => r.json()) as { task: string; trackerLinks?: Array<{ itemId: string; origin: string; url?: string; snapshot?: { status: string } }> }
    // The comments travel with the description, inside the untrusted-data envelope.
    expect(run.task).toContain('<tracker-ticket>')
    expect(run.task).toContain('Decision: keep the old endpoint, behind a deprecation warning.')
    // The task remembers its ticket as structured provenance, not as prompt text.
    expect(run.trackerLinks).toHaveLength(1)
    expect(run.trackerLinks![0]).toMatchObject({ itemId: 'DEMO51-2', origin: 'handoff', url: 'https://demo.atlassian.net/browse/DEMO51-2', snapshot: { status: 'To Do' } })
    // And the ticket shows its task: in the panel, and as a dot on its row.
    browser.waitForFunction("document.querySelector('[data-slot=\"tracker-tasks\"] a[href*=\"/tasks/\"]') !== null")
    browser.waitForFunction("[...document.querySelectorAll('[data-slot=\"tracker-row\"]')].some(row => row.textContent.includes('DEMO51-2') && row.querySelector('[data-slot=\"tracker-activity\"]'))")
    expect(run.task).toContain('Acceptance: preserve all requirements.')
    expect(run.task).toContain('https://demo.atlassian.net/browse/DEMO51-2')
    expect(run.task.length).toBeGreaterThan(8000)
    expect(run.task.endsWith('Tracker acceptance: preserve this instruction last.')).toBe(true)
    browser.evaluate("document.querySelector('[data-slot=\"tracker-handoff\"]').scrollIntoView()")
    browser.screenshot(artifacts + '/04c-queued-snapshot.png', { viewport: true })
  })
  it('changes the status from the issue panel and tells the linked task', async () => {
    browser.goto(page('/tracker/DEMO51-2'))
    browser.waitForFunction("document.querySelector('[data-slot=\"tracker-panel\"] [data-slot=\"tracker-move-trigger\"]') !== null")
    browser.waitForFunction("!document.querySelector('[data-slot=\"tracker-panel\"] [data-slot=\"tracker-move-trigger\"]').disabled")
    browser.click('[data-slot="tracker-panel"] [data-slot="tracker-move-trigger"]')
    browser.waitForFunction("[...document.querySelectorAll('[role=\"menuitem\"]')].some(item => item.textContent.includes('In Review'))")
    browser.screenshot(artifacts + '/04f-move-menu.png', { viewport: true })
    browser.evaluate("[...document.querySelectorAll('[role=\"menuitem\"]')].find(item => item.textContent.includes('In Review')).click()")
    browser.waitForFunction("document.querySelector('[data-slot=\"tracker-panel\"] [data-slot=\"tracker-move-trigger\"]').textContent.includes('In Review')")
    // The demo tracker took the move, and the row sits under its new heading.
    const detail = await fetch(baseUrl + '/api/v1/tracker/DEMO51-2').then(r => r.json()) as { item: { statusId: string } }
    expect(detail.item.statusId).toBe('dry-review')
    browser.waitForFunction("[...document.querySelectorAll('[data-slot=\"tracker-group\"][aria-label=\"In Review\"] [data-slot=\"tracker-row\"]')].some(row => row.textContent.includes('DEMO51-2'))")
    // The task started from "To Do" and now knows where its ticket stands.
    const linked = await fetch(baseUrl + '/api/v1/runs/' + createdRuns[0]).then(r => r.json()) as { trackerLinks: Array<{ snapshot: { status: string }; latest?: { status: string } }> }
    expect(linked.trackerLinks[0]).toMatchObject({ snapshot: { status: 'To Do' }, latest: { status: 'In Review' } })
    // A move the tracker needs more input for is offered, explained and not performed.
    const blocked = await fetch(baseUrl + '/api/v1/tracker/DEMO51-4/transitions').then(r => r.json()) as { targets: Array<{ statusId: string; available: boolean; reason?: string }> }
    expect(blocked.targets.find(target => target.statusId === 'dry-done')).toMatchObject({ available: false })
    // "Has task" keeps only the loaded issues with a task.
    clickText('Has task')
    browser.waitForFunction("document.querySelectorAll('[data-slot=\"tracker-list\"] [data-slot=\"tracker-row\"]').length === 1")
    expect(browser.evaluate("document.querySelector('[data-slot=\"tracker-list\"] [data-slot=\"tracker-row\"]').textContent.includes('DEMO51-2')")).toBe(true)
    clickText('Has task')
    browser.waitForFunction("document.querySelectorAll('[data-slot=\"tracker-list\"] [data-slot=\"tracker-row\"]').length > 1")
  })
  it('requires acknowledgement of incomplete context and supports mobile layout', () => {
    browser.goto(page('/tracker/DEMO51-4'))
    browser.waitForFunction("document.body.textContent.includes('This provider snapshot lost')")
    const disabled = () => browser.evaluate("([...document.querySelectorAll('button')].find(el => el.textContent.includes('Run agent on this issue'))).disabled")
    expect(disabled()).toBe(true)
    browser.fill('#tracker-supplemental', 'Additional acceptance context.')
    browser.evaluate("([...document.querySelectorAll('label')].find(el => el.textContent.includes('I understand'))).querySelector('input').click()")
    expect(disabled()).toBe(false)
    browser.evaluate("document.querySelector('[data-slot=\"tracker-handoff\"]').scrollIntoView()")
    browser.screenshot(artifacts + '/04d-context-acknowledgement.png', { viewport: true })
    browser.setViewport(390, 844)
    browser.goto(page('/tracker'))
    browser.waitForFunction("document.body.textContent.includes('DEMO51-1')")
    expect(browser.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true)
    browser.screenshot(artifacts + '/04e-mobile.png', { viewport: true })
    // A phone shows one pane at a time: the issue alone, with its way back to the list.
    browser.goto(page('/tracker/DEMO51-1'))
    browser.waitForFunction("document.querySelector('[data-slot=\"tracker-panel\"]') !== null")
    expect(browser.count('[data-slot="tracker-list"]')).toBe(0)
    expect(browser.evaluate("[...document.querySelectorAll('a')].some(link => link.textContent.includes('Back to the list'))")).toBe(true)
    expect(browser.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true)
    browser.screenshot(artifacts + '/04g-mobile-issue.png', { viewport: true })
    browser.setViewport(1440, 1000)
  })
  it('switches to Linear and disconnects through the UI', async () => {
    browser.goto(page('/settings/tracker'))
    browser.waitForFunction("document.body.textContent.includes('Browse Linear')")
    clickText('Browse Linear')
    browser.waitForFunction("document.body.textContent.includes('Team 1')")
    clickText('Team 1')
    clickText('Connect')
    browser.waitForFunction("document.body.textContent.includes('Disconnect')")
    browser.goto(page('/tracker'))
    browser.waitForFunction("document.body.textContent.includes('ENG1-1')")
    expect(browser.evaluate("document.querySelector('main').textContent.includes('DEMO51-')")).toBe(false)
    browser.screenshot(artifacts + '/05-linear-list.png')
    browser.goto(page('/settings/tracker'))
    browser.waitForFunction("document.body.textContent.includes('Disconnect')")
    clickText('Disconnect')
    browser.waitForFunction("document.body.textContent.includes('No tracker connected')")
    expect(await fetch(baseUrl + '/api/v1/tracker/association').then(r => r.json())).toEqual({ association: null })
  })
})
