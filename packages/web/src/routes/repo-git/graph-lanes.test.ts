import { describe, expect, it } from 'vitest'

import { assignLanes, type LaneCommit } from './graph-lanes'

const c = (sha: string, ...parents: string[]): LaneCommit => ({ sha, parents })
const cols = (commits: LaneCommit[]) => assignLanes(commits).map((row) => row.col)

describe('assignLanes', () => {
  it('keeps a linear history in one lane', () => {
    const rows = assignLanes([c('c', 'b'), c('b', 'a'), c('a')])
    expect(rows.map((row) => row.col)).toEqual([0, 0, 0])
    expect(rows.every((row) => row.width === 1)).toBe(true)
    // No line above the newest commit, none below the root.
    expect(rows[0]!.edges.filter((e) => e.half === 'top')).toEqual([])
    expect(rows[2]!.edges.filter((e) => e.half === 'bottom')).toEqual([])
  })

  it('opens a lane for a merge’s second parent and closes it at the fork', () => {
    // m merges f into main; f and b both come from a.
    const rows = assignLanes([c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a')])
    expect(rows.map((row) => row.col)).toEqual([0, 1, 0, 0])
    expect(rows[0]!.edges).toEqual(
      expect.arrayContaining([
        { from: 0, to: 0, half: 'bottom', color: rows[0]!.color },
        { from: 0, to: 1, half: 'bottom', color: rows[1]!.color },
      ]),
    )
    // The side lane meets main's lane at `a`: both lines end in its node, in column 0.
    const intoA = rows[3]!.edges.filter((e) => e.half === 'top')
    expect(intoA.map((e) => [e.from, e.to])).toEqual([[0, 0], [1, 0]])
    // `f` runs straight down its own lane until then.
    expect(rows[1]!.edges).toContainEqual({ from: 1, to: 1, half: 'bottom', color: rows[1]!.color })
  })

  it('gives three task branches forked from main a column each, passing lines vertical', () => {
    const rows = assignLanes([
      c('t1', 'base'),
      c('t2', 'base'),
      c('main2', 'base'),
      c('t3', 'base'),
      c('base', 'root'),
      c('root'),
    ])
    expect(rows.map((row) => row.col)).toEqual([0, 1, 2, 3, 0, 0])
    // On t3's row, the lanes of t1, t2 and main2 pass straight down.
    const t3 = rows[3]!
    for (const lane of [0, 1, 2]) {
      expect(t3.edges).toContainEqual(expect.objectContaining({ from: lane, to: lane, half: 'top' }))
    }
    // Every task lane ends in `base`.
    expect(rows[4]!.edges.filter((e) => e.half === 'top').map((e) => e.to)).toEqual([0, 0, 0, 0])
    expect(rows[4]!.width).toBe(4)
    expect(rows[5]!.width).toBe(1)
  })

  it('draws a merged task branch into main’s lane and frees its column', () => {
    // `task` was merged (m), then main moved on (n); a new branch reuses the freed column.
    const rows = assignLanes([c('x', 'n'), c('n', 'm'), c('m', 'a', 'task'), c('task', 'a'), c('a')])
    expect(cols([c('x', 'n'), c('n', 'm'), c('m', 'a', 'task'), c('task', 'a'), c('a')])).toEqual([0, 0, 0, 1, 0])
    expect(rows[4]!.width).toBe(2)
    const reused = assignLanes([c('m', 'a', 'task'), c('task', 'a'), c('a', 'z'), c('later', 'z'), c('z')])
    expect(reused.map((row) => row.col)).toEqual([0, 1, 0, 1, 0])
  })

  it('leaves a lane open below the page when its parent is not loaded yet', () => {
    const rows = assignLanes([c('b', 'a')])
    expect(rows[0]!.edges).toEqual([{ from: 0, to: 0, half: 'bottom', color: 0 }])
  })
})
