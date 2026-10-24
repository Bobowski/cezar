import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import type { AutomationEvent } from '@open-mercato/cezar-api-client'

import { DEFAULT_FILTERS, GITHUB_EVENTS, type DraftFilters } from './editor-draft'
import { EditorGithubFields } from './editor-github-fields'

afterEach(cleanup)

function Harness({ events: initial = ['issue.opened'] }: { events?: AutomationEvent[] }) {
  const [state, setState] = useState<{ events: AutomationEvent[]; intervalSeconds: number; filters: DraftFilters }>({
    events: initial,
    intervalSeconds: 300,
    filters: { ...DEFAULT_FILTERS },
  })
  return (
    <>
      <EditorGithubFields {...state} onChange={(patch) => setState((current) => ({ ...current, ...patch }))} />
      <output data-testid="events">{state.events.join(',')}</output>
      <output data-testid="own-pushes">{String(state.filters.includeOwnPushes)}</output>
    </>
  )
}

describe('EditorGithubFields', () => {
  it('offers the seven events as a multi-select, kept in contract order', () => {
    render(<Harness />)
    const chips = screen.getAllByRole('button', { pressed: true })
    expect(chips.map((chip) => chip.textContent)).toEqual(['issue.opened'])
    fireEvent.click(screen.getByRole('button', { name: 'pull_request.opened' }))
    expect(screen.getByTestId('events').textContent).toBe('pull_request.opened,issue.opened')
    fireEvent.click(screen.getByRole('button', { name: 'issue.opened' }))
    expect(screen.getByTestId('events').textContent).toBe('pull_request.opened')
    // Exactly the contract's events (spec 2026-10-23-github-events §3), nothing GitHub merely has.
    expect(screen.getAllByRole('group', { name: 'GitHub events' })[0]!.querySelectorAll('button')).toHaveLength(GITHUB_EVENTS.length)
    expect(screen.getByRole('button', { name: 'release.published' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'deployment_status' })).toBeNull()
  })

  it('shows each activity filter only once its event is picked', () => {
    render(<Harness events={['issue.opened']} />)
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }))
    expect(screen.queryByLabelText(/Mentions/)).toBeNull()
    expect(screen.queryByLabelText(/Branches/)).toBeNull()
    expect(screen.queryByLabelText('CI result')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'pull_request.commented' }))
    fireEvent.click(screen.getByRole('button', { name: 'push' }))
    fireEvent.click(screen.getByRole('button', { name: 'check_suite.completed' }))
    fireEvent.click(screen.getByRole('button', { name: 'release.published' }))
    expect(screen.getByLabelText(/Mentions/)).not.toBeNull()
    expect(screen.getByLabelText(/Branches/)).not.toBeNull()
    expect(screen.getByLabelText('CI result')).not.toBeNull()
    expect(screen.getByLabelText(/Release tags/)).not.toBeNull()
    fireEvent.click(screen.getByLabelText('Also react to CI on commits cezar pushed'))
    expect(screen.getByTestId('own-pushes').textContent).toBe('true')
  })

  it('offers delivery to the owning task only for pull request events', () => {
    render(<Harness events={['issue.opened']} />)
    expect(screen.queryByRole('combobox', { name: 'Deliver to' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'check_suite.completed' }))
    expect(screen.getByRole('combobox', { name: 'Deliver to' }).textContent).toContain('a new task')
  })

  it('shows the poll line from the filters', () => {
    render(<Harness />)
    expect(screen.getByText('· last 7 days · maximum 25 records')).not.toBeNull()
  })

  it('flags changed labels as required for a label event and opens the filters', () => {
    render(<Harness events={['issue.labeled']} />)
    expect(screen.getByText('· changed labels required')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }))
    const input = screen.getByLabelText('Changed labels (required)')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    fireEvent.change(input, { target: { value: 'bug' } })
    expect(screen.queryByText('· changed labels required')).toBeNull()
    fireEvent.change(screen.getByLabelText('Lookback days (1–90)'), { target: { value: '120' } })
    expect(screen.getByText('· last 90 days · maximum 25 records')).not.toBeNull()
  })
})
