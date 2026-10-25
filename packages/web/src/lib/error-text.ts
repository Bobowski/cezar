/**
 * What a failure says (spec 2026-10-24-cockpit-polish §3.4 item 4): the error's own message —
 * for an `ApiError`, the server's `{ error }` verbatim — never a generic "something went wrong".
 * Only a thrown non-Error (a string, an object) is stringified.
 */
export function errorText(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  if (typeof error === 'string' && error !== '') return error
  return String(error)
}
