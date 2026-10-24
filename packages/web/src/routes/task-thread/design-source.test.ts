import { describe, expect, it } from 'vitest'

import { formatSource, parsePickSource, relativeSource } from './design-source'

describe('a picked element’s source location (spec 2026-10-24-design-mode-third-cut §3.3)', () => {
  it('reads the picker’s object and the file:line string an older draft stored', () => {
    expect(parsePickSource({ file: '/w/src/a.tsx', line: 14 })).toEqual({ file: '/w/src/a.tsx', line: 14 })
    expect(parsePickSource({ file: '/w/src/A.vue' })).toEqual({ file: '/w/src/A.vue' })
    expect(parsePickSource('src/ui/button.tsx:14')).toEqual({ file: 'src/ui/button.tsx', line: 14 })
    expect(parsePickSource('src/ui/button.tsx:14:7')).toEqual({ file: 'src/ui/button.tsx', line: 14 })
    expect(parsePickSource('C:\\w\\a.tsx:3')).toEqual({ file: 'C:\\w\\a.tsx', line: 3 })
    expect(parsePickSource('C:\\w\\A.vue')).toEqual({ file: 'C:\\w\\A.vue' })
  })

  it('refuses what is not a location, and drops a line that is not one', () => {
    for (const raw of [null, 5, '', {}, { file: 3 }, { file: 'x'.repeat(501) }]) expect(parsePickSource(raw)).toBeNull()
    expect(parsePickSource({ file: 'a.tsx', line: -1 })).toEqual({ file: 'a.tsx' })
    expect(parsePickSource({ file: 'a.tsx', line: 1.5 })).toEqual({ file: 'a.tsx' })
  })

  it('keeps a path under the worktree, relative to it', () => {
    expect(relativeSource({ file: '/srv/wt/src/a.tsx', line: 4 }, ['/srv/wt'])).toEqual({ file: 'src/a.tsx', line: 4 })
    expect(relativeSource({ file: '/srv/wt/src/a.tsx' }, ['/srv/wt/'])).toEqual({ file: 'src/a.tsx' })
    // The first root it lies under wins; a project checkout is a second chance.
    expect(relativeSource({ file: '/srv/repo/src/a.tsx', line: 1 }, ['/srv/wt', '/srv/repo'])).toEqual({ file: 'src/a.tsx', line: 1 })
  })

  it('reads Windows paths, Vite queries and file URLs', () => {
    expect(relativeSource({ file: 'C:\\Users\\me\\wt\\src\\a.tsx', line: 2 }, ['c:\\users\\me\\wt'])).toEqual({ file: 'src/a.tsx', line: 2 })
    expect(relativeSource({ file: '/srv/wt/src/A.vue?vue&type=template' }, ['/srv/wt'])).toEqual({ file: 'src/A.vue' })
    expect(relativeSource({ file: 'file:///C:/wt/src/a.tsx' }, ['C:\\wt'])).toEqual({ file: 'src/a.tsx' })
  })

  it('never hands out an absolute path that is outside every root', () => {
    expect(relativeSource({ file: '/etc/passwd', line: 1 }, ['/srv/wt'])).toBeNull()
    // A prefix is not a parent: `/srv/wt2` is not under `/srv/wt`.
    expect(relativeSource({ file: '/srv/wt2/a.tsx' }, ['/srv/wt'])).toBeNull()
    expect(relativeSource({ file: '/srv/wt/../etc/passwd' }, ['/srv/wt'])).toBeNull()
    expect(relativeSource({ file: '/srv/wt/a.tsx' }, [])).toBeNull()
    expect(relativeSource({ file: '/srv/wt/a.tsx' }, [undefined, null, ''])).toBeNull()
  })

  it('keeps a relative path the framework already gave, when it stays inside', () => {
    expect(relativeSource({ file: 'src/routes/+page.svelte', line: 9 }, [])).toEqual({ file: 'src/routes/+page.svelte', line: 9 })
    expect(relativeSource({ file: './src/a.tsx' }, [])).toEqual({ file: 'src/a.tsx' })
    expect(relativeSource({ file: '../outside/a.tsx' }, ['/srv/wt'])).toBeNull()
  })

  it('formats as file:line, or the file alone', () => {
    expect(formatSource({ file: 'src/a.tsx', line: 14 })).toBe('src/a.tsx:14')
    expect(formatSource({ file: 'src/A.vue' })).toBe('src/A.vue')
  })
})
