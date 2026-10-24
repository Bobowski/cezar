/**
 * Completion while typing in a Code terminal (spec `.ai/specs/2026-10-24-code-page-terminal.md`
 * §3.3) — the cockpit's, never the shell's: nothing reaches the shell but the text the user
 * accepts. Pure: the pane owns the keys and the popover, this owns what is offered.
 */

export type CompletionSource = 'command' | 'history' | 'path'

export interface CompletionItem {
  /** The whole line the item would leave, shown in the list. */
  line: string
  /** What accepting writes into the pty: the rest of the line, as if typed. */
  insert: string
  source: CompletionSource
}

export interface CompletionSources {
  /** Discovered commands (§3.1), in their own order. */
  commands: readonly string[]
  /** This project's history, newest first. */
  history: readonly string[]
  /** The checkout's file paths, relative to its root. */
  paths: readonly string[]
}

/** Shown at most. */
export const COMPLETION_LIMIT = 8
/** Typed characters before the popover shows by itself (§3.3); `Tab` shows it at any length. */
export const AUTO_MIN_CHARS = 2

/** The direct children of `dir` (`''` = the root, else ending in `/`): files as they are,
 *  directories with a trailing `/`. One level, as §3.3 says. */
export function childrenOf(paths: readonly string[], dir: string): string[] {
  const seen = new Set<string>()
  for (const path of paths) {
    if (!path.startsWith(dir)) continue
    const rest = path.slice(dir.length)
    if (rest === '') continue
    const slash = rest.indexOf('/')
    seen.add(slash === -1 ? rest : rest.slice(0, slash + 1))
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

/** `rel` (a token's directory part) inside `base`; null above the checkout's root. */
function resolveDir(base: string, rel: string): string | null {
  const parts: string[] = []
  for (const part of `${base}${rel}`.split('/')) {
    if (part === '' || part === '.') continue
    if (part !== '..') parts.push(part)
    else if (parts.pop() === undefined) return null
  }
  return parts.length === 0 ? '' : `${parts.join('/')}/`
}

/**
 * The path completions of the last token of `line`, read from `dir` — the shell's directory
 * relative to the checkout (`''` its root). `null`: the shell left the checkout, so the tree has
 * nothing for it. `undefined`: the host cannot say where it is, so the checkout root stands in.
 */
function pathItems(line: string, paths: readonly string[], dir: string | null | undefined): CompletionItem[] {
  if (dir === null) return []
  const token = /(\S*)$/.exec(line)?.[1] ?? ''
  // A flag is not a path; an absolute or home path is outside the checkout the tree describes.
  if (token.startsWith('-') || token.startsWith('/') || token.startsWith('~')) return []
  // An empty token would offer the whole root after every space.
  if (token === '') return []
  const relative = token.startsWith('./') ? token.slice(2) : token
  const slash = relative.lastIndexOf('/')
  const listed = resolveDir(dir ?? '', slash === -1 ? '' : relative.slice(0, slash + 1))
  if (listed === null) return []
  const base = relative.slice(slash + 1)
  return childrenOf(paths, listed)
    .filter((child) => child.startsWith(base) && child !== base)
    .map((child) => {
      const insert = child.slice(base.length)
      return { line: line + insert, insert, source: 'path' as const }
    })
}

/**
 * What to offer for `line`: discovered commands first, then history, then paths — each by prefix,
 * a line offered once (its first source wins), the line itself never.
 */
export function rankCompletions(
  line: string,
  sources: CompletionSources,
  { explicit = false, limit = COMPLETION_LIMIT, dir }: { explicit?: boolean; limit?: number; dir?: string | null } = {},
): CompletionItem[] {
  const out: CompletionItem[] = []
  const seen = new Set<string>([line])
  const offer = (item: CompletionItem) => {
    if (seen.has(item.line) || item.insert === '') return
    seen.add(item.line)
    out.push(item)
  }
  if (line.trim() !== '' || explicit) {
    for (const command of sources.commands) {
      if (command.startsWith(line)) offer({ line: command, insert: command.slice(line.length), source: 'command' })
    }
    for (const entry of sources.history) {
      if (entry.startsWith(line)) offer({ line: entry, insert: entry.slice(line.length), source: 'history' })
    }
  }
  for (const item of pathItems(line, sources.paths, dir)) offer(item)
  return out.slice(0, limit)
}

/** The `Ctrl+R` list: history containing `filter`, any case, newest first. */
export function filterHistory(history: readonly string[], filter: string, limit = 50): string[] {
  const needle = filter.toLowerCase()
  return history.filter((line) => line.toLowerCase().includes(needle)).slice(0, limit)
}

/**
 * The line being typed, as far as the cockpit can know it: plain typing, backspace and paste keep
 * it; an arrow, a Tab the shell completes or a Ctrl chord make it unknown until the next Enter.
 * The server keeps the same account for the history file (`server/terminal/history.ts`).
 */
export class LineTracker {
  private text = ''
  private known = true
  /** Counts the lines begun: a new line — submitted or abandoned — is a new one. */
  generation = 0

  get line(): string | null {
    return this.known ? this.text : null
  }

  /** Feed what was written to the pty. Returns true when a known, non-blank line was submitted. */
  feed(data: string): boolean {
    let submitted = false
    // eslint-disable-next-line no-control-regex
    const input = data.replace(/\x1b\[20[01]~/g, '')
    for (let index = 0; index < input.length; index += 1) {
      const char = input[index]!
      if (char === '\r' || char === '\n') {
        if (this.known && this.text.trim() !== '') submitted = true
        this.reset()
      } else if (char === '\x7f' || char === '\b') {
        this.text = [...this.text].slice(0, -1).join('')
      } else if (char === '\x03' || char === '\x15') {
        this.reset()
      } else if (char === '\x1b') {
        this.known = false
        const next = input[index + 1]
        if (next === '[') {
          index += 2
          while (index < input.length && !/[@-~]/.test(input[index]!)) index += 1
        } else {
          index += next === 'O' ? 2 : 1
        }
      } else if (char < ' ') {
        this.known = false
      } else if (this.known) {
        this.text += char
      }
    }
    return submitted
  }

  reset(): void {
    this.text = ''
    this.known = true
    this.generation += 1
  }
}

/** What the popover shows. */
export type CompletionView =
  | { mode: 'complete'; items: CompletionItem[]; selected: number }
  | { mode: 'history'; filter: string; items: string[]; selected: number }
  | null

/** The pause after typing before the popover shows by itself (§3.3). */
export const AUTO_DELAY_MS = 300
/** After an Enter (or Ctrl+C/D/Z) the prompt is asked about again this much later — past the
 *  server's one-second process-table reuse, so the answer describes the shell AFTER the key. */
export const PROMPT_RECHECK_MS = 1_100
/** While the shell is still busy, it is asked again every `PROMPT_RECHECK_MS` for this long, so a
 *  command that ends on its own gives completion back. */
export const PROMPT_RECHECK_LIMIT_MS = 10_000
/** Past that window, a keystroke asks once more this long after typing pauses (spec §9). */
export const KEY_RECHECK_MS = 1_000

/** A prompt check's answer: whether the shell sits at its prompt, and where (`pathItems`). */
export interface PromptState {
  atPrompt: boolean
  dir?: string | null
}

/** A terminal session's process-table word as a prompt check's answer. `busy: null` is a host
 *  that cannot read its table (Windows): completion treats it as a prompt there — the server
 *  still keeps no history for it. An unknown session is not one. */
export function promptStateOf(session: { busy: boolean | null; workdir?: string | null } | undefined): PromptState {
  return { atPrompt: session !== undefined && session.busy !== true, dir: session?.workdir }
}

export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * The keys and the popover's state, apart from xterm so it can be tested without one. `typed` is
 * fed everything the user sends the pty; `key` sees each keydown first and answers whether xterm
 * should still handle it — `false` is a key the popover took, which the shell never sees.
 *
 * It takes keys only at the shell's own prompt: never on the alternate screen (vim, less), and
 * only while the last prompt check — run at mount and again after each Enter, then every
 * `PROMPT_RECHECK_MS` while busy for up to `PROMPT_RECHECK_LIMIT_MS`, then `KEY_RECHECK_MS` after typing pauses — found the shell with
 * nothing running. A REPL or a program's prompt keeps its Tab, Esc and Ctrl+R.
 */
export class CompletionController {
  private readonly tracker = new LineTracker()
  private view: CompletionView = null
  /** `Esc` hid the popover for this line: it stays hidden, and `Tab` is the shell's, until the
   *  line is submitted or abandoned. */
  private dismissed = false
  private cancelAuto: (() => void) | null = null
  private cancelRecheck: (() => void) | null = null
  private cancelKeyCheck: (() => void) | null = null
  /** The last prompt check's answer; a check still running counts as no. */
  private atPrompt: boolean
  /** Where the shell is, from the same check; unknown until one says. */
  private dir: string | null | undefined = undefined
  private checkSeq = 0
  /** Checks still owed while the shell answers busy. */
  private rechecksLeft = 0

  constructor(
    private readonly options: {
      write: (data: string) => void
      sources: () => CompletionSources
      onView: (view: CompletionView) => void
      /** A known line was submitted — the history has something new. */
      onSubmitted?: () => void
      schedule?: (run: () => void, ms: number) => () => void
      /** The terminal shows the alternate screen — a full-screen program owns every key. */
      alternateScreen?: () => boolean
      /** Whether the shell sits at its prompt (has nothing running), and in which directory.
       *  Absent: always, at the checkout root. */
      promptCheck?: () => Promise<PromptState>
    },
  ) {
    this.atPrompt = options.promptCheck === undefined
    this.rechecksLeft = Math.floor(PROMPT_RECHECK_LIMIT_MS / PROMPT_RECHECK_MS)
    this.checkPrompt()
  }

  get current(): CompletionView {
    return this.view
  }

  /** Completion may take keys now. */
  private get enabled(): boolean {
    return this.atPrompt && !(this.options.alternateScreen?.() ?? false)
  }

  typed(data: string): void {
    const generation = this.tracker.generation
    if (this.tracker.feed(data)) this.options.onSubmitted?.()
    if (this.tracker.generation !== generation) this.dismissed = false
    // A key that may start or end a program: off until the shell is asked again.
    if (this.options.promptCheck && /[\r\n\x03\x04\x1a]/.test(data)) {
      this.atPrompt = false
      this.close()
      this.cancelRecheck?.()
      this.cancelKeyCheck?.()
      this.cancelKeyCheck = null
      // An answer still in flight describes the shell before this key.
      this.checkSeq += 1
      this.rechecksLeft = Math.floor(PROMPT_RECHECK_LIMIT_MS / PROMPT_RECHECK_MS) - 1
      this.scheduleRecheck()
      return
    }
    if (!this.atPrompt) this.scheduleKeyCheck()
    if (this.view?.mode === 'complete') {
      this.refresh(false)
      return
    }
    this.scheduleAuto()
  }

  key(event: KeyLike): boolean {
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
    if (this.view === null && !this.enabled) return true
    if (event.key.toLowerCase() === 'r' && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      this.openHistory()
      return false
    }
    if (this.view?.mode === 'complete') {
      if (event.key === 'Tab' && plain) {
        this.accept(this.view.selected)
        return false
      }
      if (event.key === 'Escape') {
        this.dismiss()
        return false
      }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && plain) {
        const count = this.view.items.length
        const step = event.key === 'ArrowDown' ? 1 : count - 1
        this.show({ ...this.view, selected: (this.view.selected + step) % count })
        return false
      }
      if (event.key === 'Enter') this.close()
      return true
    }
    // Offered only when there is something to offer; otherwise the shell completes as ever.
    if (event.key === 'Tab' && plain && !this.dismissed) return !this.refresh(true)
    return true
  }

  accept(index: number): void {
    if (this.view?.mode !== 'complete') return
    const item = this.view.items[index]
    this.close()
    if (item) this.send(item.insert)
  }

  openHistory(): void {
    this.cancelAuto?.()
    this.cancelAuto = null
    this.show({ mode: 'history', filter: '', items: filterHistory(this.options.sources().history, ''), selected: 0 })
  }

  setHistoryFilter(filter: string): void {
    if (this.view?.mode !== 'history') return
    this.show({ mode: 'history', filter, items: filterHistory(this.options.sources().history, filter), selected: 0 })
  }

  /** Replace the line being typed with a history line — not submitted: Enter stays the user's. */
  pickHistory(line: string): void {
    const current = this.tracker.line
    this.close()
    // Backspaces over a line the cockpit knows; Ctrl+U over one it does not.
    this.send(current !== null ? '\x7f'.repeat([...current].length) + line : `\x15${line}`)
  }

  dismiss(): void {
    this.dismissed = true
    this.close()
  }

  close(): void {
    this.cancelAuto?.()
    this.cancelAuto = null
    if (this.view !== null) this.show(null)
  }

  dispose(): void {
    this.cancelAuto?.()
    this.cancelAuto = null
    this.cancelKeyCheck?.()
    this.cancelKeyCheck = null
    this.cancelRecheck?.()
    this.cancelRecheck = null
    // An answer still in flight lands on nothing.
    this.checkSeq += 1
  }

  private checkPrompt(): void {
    const check = this.options.promptCheck
    if (!check) return
    const seq = ++this.checkSeq
    void check()
      .catch((): PromptState => ({ atPrompt: false }))
      .then((state) => {
        if (seq !== this.checkSeq) return
        this.atPrompt = state.atPrompt
        this.dir = state.dir
        if (!state.atPrompt && this.rechecksLeft > 0 && this.cancelRecheck === null) {
          this.rechecksLeft -= 1
          this.scheduleRecheck()
        }
      })
  }

  /** Past the recheck window, a command that ended on its own is noticed once typing pauses. */
  private scheduleKeyCheck(): void {
    if (!this.options.promptCheck || this.rechecksLeft > 0 || this.cancelRecheck !== null) return
    this.cancelKeyCheck?.()
    this.cancelKeyCheck = this.scheduler()(() => {
      this.cancelKeyCheck = null
      this.checkPrompt()
    }, KEY_RECHECK_MS)
  }

  private scheduleRecheck(): void {
    this.cancelRecheck = this.scheduler()(() => {
      this.cancelRecheck = null
      this.checkPrompt()
    }, PROMPT_RECHECK_MS)
  }

  private scheduler(): (run: () => void, ms: number) => () => void {
    return this.options.schedule ?? ((run, ms) => {
      const timer = setTimeout(run, ms)
      return () => clearTimeout(timer)
    })
  }

  private send(data: string): void {
    if (data === '') return
    this.tracker.feed(data)
    this.options.write(data)
  }

  /** Recompute the list; returns whether the popover is open afterwards. */
  private refresh(explicit: boolean): boolean {
    const line = this.tracker.line
    const items = line === null ? [] : rankCompletions(line, this.options.sources(), { explicit, dir: this.dir })
    if (items.length === 0) {
      this.close()
      return false
    }
    const previous = this.view?.mode === 'complete' ? this.view.items[this.view.selected]?.line : undefined
    const selected = Math.max(0, items.findIndex((item) => item.line === previous))
    this.show({ mode: 'complete', items, selected })
    return true
  }

  private scheduleAuto(): void {
    this.cancelAuto?.()
    this.cancelAuto = null
    const line = this.tracker.line
    if (!this.enabled || this.dismissed || this.view !== null || line === null || line.trim().length < AUTO_MIN_CHARS) return
    this.cancelAuto = this.scheduler()(() => {
      this.cancelAuto = null
      if (this.enabled && !this.dismissed && this.view === null) this.refresh(false)
    }, AUTO_DELAY_MS)
  }

  private show(view: CompletionView): void {
    this.view = view
    this.options.onView(view)
  }
}
