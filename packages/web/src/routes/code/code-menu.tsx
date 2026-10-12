import { Fragment } from 'react'

import { ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut } from '@/components/ui/context-menu'

/** One row of a context menu, or a rule between groups of them. */
export type MenuItem =
  | { label: string; shortcut?: string; danger?: boolean; disabled?: boolean; run: () => void }
  | 'separator'

/** A menu's rows, for a `<ContextMenuContent>` — the explorer's and the tabs' share the shape. */
export function MenuItems({ items }: { items: readonly MenuItem[] }) {
  return (
    <>
      {items.map((item, index) =>
        item === 'separator' ? (
          <ContextMenuSeparator key={`rule-${index}`} />
        ) : (
          <Fragment key={item.label}>
            <ContextMenuItem variant={item.danger ? 'destructive' : 'default'} disabled={item.disabled} onSelect={item.run}>
              {item.label}
              {item.shortcut ? <ContextMenuShortcut>{item.shortcut}</ContextMenuShortcut> : null}
            </ContextMenuItem>
          </Fragment>
        ),
      )}
    </>
  )
}
