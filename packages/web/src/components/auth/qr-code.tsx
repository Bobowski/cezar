import { encode } from 'uqr'
import { useMemo } from 'react'

/**
 * A QR code as one SVG path, with a quiet zone. Its two colours are the `--qr-*` tokens, which do
 * not follow the theme (see `styles/index.css`).
 */
export function QrCode({ value, size = 176, label }: { value: string; size?: number; label: string }) {
  const { path, cells } = useMemo(() => {
    const { data, size: count } = encode(value, { border: 2 })
    let d = ''
    for (let y = 0; y < count; y += 1) {
      for (let x = 0; x < count; x += 1) {
        if (data[y]?.[x]) d += `M${x} ${y}h1v1h-1z`
      }
    }
    return { path: d, cells: count }
  }, [value])

  return (
    <svg
      data-slot="qr-code"
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${cells} ${cells}`}
      shapeRendering="crispEdges"
      className="rounded-md border border-border bg-(--qr-paper)"
    >
      <path d={path} fill="var(--qr-ink)" />
    </svg>
  )
}
