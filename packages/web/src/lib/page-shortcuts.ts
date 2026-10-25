/**
 * Every page's fixed shortcuts, for Settings → Keyboard (spec 2026-10-24-cockpit-polish §3.4
 * item 5). The rebindable task commands live in `keybindings.ts`; these are the keys each screen
 * handles itself. A chord is spelled as `formatChord` reads it (`Mod` = ⌘ on a Mac, Ctrl
 * elsewhere); `desktop` is the variant the desktop shell gets, where the browser does not keep
 * the chord for itself (⌘T, ⌘W).
 */
export interface PageShortcut {
  label: string
  chords: readonly string[]
  /** In the desktop shell, instead of `chords`. */
  desktop?: readonly string[]
}

export interface PageShortcutGroup {
  page: string
  shortcuts: readonly PageShortcut[]
}

/** Closing a tab is `Alt+W` on every surface: a browser keeps Ctrl/⌘+W for its own tab, and the
 *  desktop shell's window menu closes the WINDOW on it — so no page may claim it (it is RESERVED
 *  in `keybindings.ts` too). A new page differs: only the browser keeps ⌘T. */
export const CODE_CLOSE_TAB: PageShortcut = { label: 'Close editor', chords: ['Alt+W'] }
export const CODE_NEW_PAGE: PageShortcut = { label: 'New browser page', chords: ['Alt+T'], desktop: ['Mod+T', 'Alt+T'] }

export const PAGE_SHORTCUTS: readonly PageShortcutGroup[] = [
  {
    page: 'Everywhere',
    shortcuts: [
      { label: 'New task', chords: ['C'], desktop: ['C', 'Mod+N'] },
      { label: 'Command palette', chords: ['Mod+K'] },
      { label: 'Toggle the sidebar', chords: ['Mod+B'] },
      { label: 'Full screen for the focused window', chords: ['F11'] },
      { label: 'Leave full screen', chords: ['Esc'] },
    ],
  },
  {
    page: 'Task',
    shortcuts: [
      { label: 'Task palette', chords: ['Mod+P'] },
      { label: 'Go to tab 1–9', chords: ['1', 'Mod+1'] },
      { label: 'Previous / next tab', chords: ['[', ']'] },
      { label: 'Split the view', chords: ['\\'] },
      { label: 'Full view of the layout', chords: ['F'] },
      { label: 'Write a message', chords: ['/'] },
      { label: 'Toggle the terminal drawer', chords: ['`'] },
      { label: 'New terminal tab', chords: ['Mod+Shift+`'] },
    ],
  },
  {
    page: 'Code',
    shortcuts: [
      { label: 'Command palette', chords: ['F1', 'Mod+Shift+P'] },
      { label: 'Go to file', chords: ['Mod+P'] },
      { label: 'Go to line', chords: ['Ctrl+G'] },
      { label: 'Save', chords: ['Mod+S'] },
      { label: 'Find in files', chords: ['Mod+Shift+F'] },
      { label: 'Explorer', chords: ['Mod+Shift+E'] },
      { label: 'Source control', chords: ['Ctrl+Shift+G'] },
      { label: 'Toggle the panel', chords: ['Mod+J'] },
      { label: 'Toggle the terminal', chords: ['Ctrl+`'] },
      { label: 'Split editor right', chords: ['Mod+\\'] },
      { label: 'Focus editor group 1–4', chords: ['Mod+1'] },
      { label: 'Previous / next editor', chords: ['Alt+←', 'Alt+→'] },
      CODE_CLOSE_TAB,
      CODE_NEW_PAGE,
      { label: 'Open an agent tab', chords: ['Mod+L'] },
      { label: 'Toggle word wrap', chords: ['Alt+Z'] },
      { label: 'Markdown preview', chords: ['Mod+Shift+V'] },
    ],
  },
  {
    page: 'Git',
    shortcuts: [{ label: 'Fold the sidebar to icons', chords: ['Mod+B'] }],
  },
]

/** The chords a shortcut answers to on this surface. `F11` is `Ctrl+Cmd+F` on a Mac. */
export function chordsFor(shortcut: PageShortcut, surface: 'desktop' | 'browser', apple: boolean): readonly string[] {
  const chords = surface === 'desktop' && shortcut.desktop ? shortcut.desktop : shortcut.chords
  return apple ? chords.map((chord) => (chord === 'F11' ? 'Ctrl+Mod+F' : chord)) : chords
}
