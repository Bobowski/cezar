import type { ReactNode } from 'react'

import { BrandLockup } from '@/components/brand-mark'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Toaster } from '@/components/ui/toaster'

/**
 * The one surface the signed-out cockpit has: the wordmark, one card, one line of small print.
 * Sign-in and setup both render through it, so the two read as the same door.
 */
export function AuthFrame({
  title,
  description,
  footer,
  aside,
  children,
  ...props
}: {
  title: ReactNode
  description?: ReactNode
  footer?: ReactNode
  /** A second card under the first — setup's Restore from a backup. */
  aside?: ReactNode
  children: ReactNode
  'data-screen': string
}) {
  return (
    <main
      data-slot="auth-screen"
      className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))]"
      {...props}
    >
      <div className="flex w-full max-w-sm flex-col gap-6">
        <BrandLockup className="justify-center text-foreground" />
        <Card>
          <CardHeader>
            <CardTitle>
              <h1 className="text-base">{title}</h1>
            </CardTitle>
            {description ? <CardDescription className="text-pretty">{description}</CardDescription> : null}
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
        {aside}
        {footer ? <p className="text-center text-xs text-pretty text-muted-foreground">{footer}</p> : null}
      </div>
      {/* The app's own outlet is mounted below the gate, so this screen brings one. */}
      <Toaster />
    </main>
  )
}

/** What a form says when the server refused it — its own words, never a guess. */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // The API speaks in lowercase fragments; on a form it is a sentence.
  return message.charAt(0).toUpperCase() + message.slice(1)
}
