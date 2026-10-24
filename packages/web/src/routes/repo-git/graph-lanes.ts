/**
 * Lane assignment for the Git page's commit graph (spec 2026-10-24-git-view §3.1): commits come
 * newest first with children before parents (`git log --date-order`), and each row says where its
 * node sits and which line segments cross its top and bottom halves. Pure, so a fixture can pin it.
 *
 * A lane keeps its column for as long as it lives, so a line passing a row is always vertical;
 * a node's first parent continues its lane, other parents open (or join) lanes to the right.
 */

export interface LaneCommit {
  sha: string
  parents: readonly string[]
}

/** One segment inside a row: `top` runs from the row's top edge to its middle, `bottom` from the
 *  middle to the bottom edge. Columns are lane indexes. */
export interface LaneEdge {
  from: number
  to: number
  half: 'top' | 'bottom'
  color: number
}

export interface LaneRow {
  sha: string
  /** The node's column. */
  col: number
  /** The node's lane color (an index into the palette). */
  color: number
  edges: LaneEdge[]
  /** Columns this row spans (for the SVG width). */
  width: number
}

interface Lane {
  sha: string
  color: number
}

export function assignLanes(commits: readonly LaneCommit[]): LaneRow[] {
  const lanes: Array<Lane | null> = []
  let nextColor = 0
  const free = (): number => {
    const at = lanes.indexOf(null)
    return at < 0 ? lanes.length : at
  }
  const rows: LaneRow[] = []
  for (const commit of commits) {
    const hits: number[] = []
    lanes.forEach((lane, index) => {
      if (lane?.sha === commit.sha) hits.push(index)
    })
    const edges: LaneEdge[] = []
    // The top half: every lane alive above this row, either passing or ending in this node.
    lanes.forEach((lane, index) => {
      if (!lane) return
      edges.push({ from: index, to: lane.sha === commit.sha ? (hits[0] as number) : index, half: 'top', color: lane.color })
    })
    let col: number
    let color: number
    if (hits.length > 0) {
      col = hits[0] as number
      color = (lanes[col] as Lane).color
      for (const extra of hits.slice(1)) lanes[extra] = null
    } else {
      col = free()
      color = nextColor++
      lanes[col] = { sha: commit.sha, color }
    }
    const passing = new Set<number>()
    lanes.forEach((lane, index) => {
      if (lane && index !== col) passing.add(index)
    })

    // The first parent always continues this lane, even when another lane expects it too: the
    // two meet at the parent's row, in the leftmost of them.
    const [first, ...rest] = commit.parents
    if (first === undefined) {
      lanes[col] = null
    } else {
      lanes[col] = { sha: first, color }
      edges.push({ from: col, to: col, half: 'bottom', color })
    }
    for (const parent of rest) {
      const existing = lanes.findIndex((lane) => lane?.sha === parent)
      if (existing >= 0) {
        edges.push({ from: col, to: existing, half: 'bottom', color: (lanes[existing] as Lane).color })
        continue
      }
      const slot = free()
      const opened = { sha: parent, color: nextColor++ }
      lanes[slot] = opened
      edges.push({ from: col, to: slot, half: 'bottom', color: opened.color })
    }
    for (const index of passing) {
      const lane = lanes[index]
      if (lane) edges.push({ from: index, to: index, half: 'bottom', color: lane.color })
    }
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
    const width = Math.max(col + 1, ...edges.map((edge) => Math.max(edge.from, edge.to) + 1))
    rows.push({ sha: commit.sha, col, color, edges, width })
  }
  return rows
}
