/** Docker's own units (decimal, as `docker system df` prints them): `41 GB`, `120 MB`, `0 B`. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`
  return `${bytes} B`
}

/**
 * What Exec types into the cockpit terminal (spec 2026-10-23-docker-management §3.5): `bash` when
 * the image has one, else `sh`. Double quotes only, so bash, zsh, PowerShell and cmd all pass it whole.
 */
export function dockerExecCommand(id: string): string {
  return `docker exec -it ${id} sh -c "command -v bash >/dev/null 2>&1 && exec bash || exec sh"`
}
