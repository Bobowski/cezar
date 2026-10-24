import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { AutomationWebhook } from '@open-mercato/cezar-api-client'
import { getAutomationWebhook, pingAutomationWebhook, registerAutomationWebhook } from '@/api/client'

import { WebhookCard } from './webhook-card'

vi.mock('@/api/client', () => ({
  getAutomationWebhook: vi.fn(),
  registerAutomationWebhook: vi.fn(),
  pingAutomationWebhook: vi.fn(),
  removeAutomationWebhook: vi.fn(),
}))
vi.mock('@/components/ui/toaster', () => ({ toast: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

const renderCard = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <WebhookCard timeZone="UTC" />
  </QueryClientProvider>,
)
const webhook = (over: Partial<AutomationWebhook>): { webhook: AutomationWebhook } => ({
  webhook: { available: true, route: '/api/v1/hooks/github/<hook-id>', registered: false, ...over },
})

it('explains a local cockpit and keeps Register disabled (spec 2026-10-23-github-events §4)', async () => {
  vi.mocked(getAutomationWebhook).mockResolvedValue(webhook({ available: false, reason: 'This cockpit runs locally.' }))
  renderCard()
  expect(await screen.findByText(/This cockpit runs locally\. Route: \/api\/v1\/hooks\/github\/<hook-id>/)).not.toBeNull()
  expect((screen.getByRole('button', { name: 'Register webhook' }) as HTMLButtonElement).disabled).toBe(true)
})

it('registers, then shows the last delivery and pings', async () => {
  vi.mocked(getAutomationWebhook).mockResolvedValue(webhook({}))
  vi.mocked(registerAutomationWebhook).mockResolvedValue(webhook({ registered: true, lastDeliveryAt: '2026-10-24T10:00:00.000Z', lastEvent: 'ping' }))
  vi.mocked(pingAutomationWebhook).mockResolvedValue(webhook({ registered: true, ping: { at: '2026-10-24T10:05:00.000Z', ok: false, error: 'HTTP 404' } }))
  renderCard()
  fireEvent.click(await screen.findByRole('button', { name: 'Register webhook' }))
  await waitFor(() => expect(screen.getByText(/last delivery .*\(ping\)/)).not.toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Ping' }))
  await waitFor(() => expect(screen.getByText(/ping failed: HTTP 404/)).not.toBeNull())
})
