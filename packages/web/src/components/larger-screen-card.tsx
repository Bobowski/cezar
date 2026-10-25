import { MonitorIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'
import { useIsDesktop } from '@/lib/use-desktop'

/** Under `md` (768 px, the `use-mobile` breakpoint) the cockpit is a phone. Synchronous, so a
 *  gated page never mounts first and is swapped out after. */
export function useIsPhone(): boolean {
  return !useIsDesktop()
}

/**
 * The one-line card a page with no phone version shows on a phone (spec 2026-10-24-mobile-cockpit
 * §3.1) — the page's name and where to go instead, never a broken layout.
 */
export function LargerScreenCard({ page, back = true }: { page: string; back?: boolean }) {
  return (
    <div data-slot="larger-screen-card" className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-xl border border-border bg-card px-5 py-6 text-center">
        <MonitorIcon aria-hidden="true" className="size-6 text-muted-foreground" />
        <p className="text-sm text-foreground">
          <span className="font-medium">{page}</span> needs a larger screen — open this on a computer or tablet.
        </p>
        {back ? (
          <Button asChild variant="outline" size="sm">
            <Link to="/">Back to Tasks</Link>
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/** Render `children` everywhere but a phone, where the page's {@link LargerScreenCard} stands in. */
export function PhoneGate({ page, children, back }: { page: string; children: ReactNode; back?: boolean }) {
  return useIsPhone() ? <LargerScreenCard page={page} back={back} /> : <>{children}</>
}
