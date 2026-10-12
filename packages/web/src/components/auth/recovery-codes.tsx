import { CheckIcon, CopyIcon, DownloadIcon } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'

/**
 * The recovery codes, shown the one time the server will ever send them. Copy and download are
 * both offered because "write these down" is the step people skip.
 */
export function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false)
  const text = codes.join('\n')

  const copy = () => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 2000)
      })
      .catch(() => toast('Could not copy — select the codes and copy them by hand.', { tone: 'danger' }))
  }

  const download = () => {
    const url = URL.createObjectURL(new Blob([`cezar recovery codes\n\n${text}\n`], { type: 'text/plain' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'cezar-recovery-codes.txt'
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div data-slot="recovery-codes" className="flex flex-col gap-3">
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md border border-border bg-muted/40 px-4 py-3 font-mono text-[13px] text-foreground">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" className="flex-1" onClick={copy}>
          {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button type="button" variant="outline" size="sm" className="flex-1" onClick={download}>
          <DownloadIcon aria-hidden="true" />
          Download
        </Button>
      </div>
    </div>
  )
}
