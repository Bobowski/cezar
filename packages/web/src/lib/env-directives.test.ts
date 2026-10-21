import { describe, expect, it } from 'vitest'

import { parseEnv, serializeEnv } from '@/lib/dotenv-lines'
import { directiveFor, hasReference, isDirectiveLine, nextPortOffset, removeVariable, renameVariable, setSource } from './env-directives'

const FILE = '# api\n#cezar PORT=${{ task.port(0, 9000) }}\nPORT=9000\nNAME=app\n'
const indexOf = (text: string, key: string) => parseEnv(text).findIndex((l) => l.kind === 'var' && l.key === key)

describe('env directives in the variables view', () => {
  it('finds the directive owning a line, and only for the same key', () => {
    const lines = parseEnv(FILE)
    expect(directiveFor(lines, indexOf(FILE, 'PORT'))).toEqual({ index: 1, source: '${{ task.port(0, 9000) }}' })
    expect(directiveFor(lines, indexOf(FILE, 'NAME'))).toBeNull()
    expect(isDirectiveLine(lines[1]!)).toBe(true)
    expect(isDirectiveLine(lines[0]!)).toBe(false)
  })

  it('a reference typed into a plain value creates the directive above it', () => {
    const out = serializeEnv(setSource(parseEnv(FILE), indexOf(FILE, 'NAME'), 'NAME', 'app${{ task.suffix }}'))
    expect(out).toBe('# api\n#cezar PORT=${{ task.port(0, 9000) }}\nPORT=9000\n#cezar NAME=app${{ task.suffix }}\nNAME=app\n')
  })

  it('editing a reference rewrites the directive and keeps the rendered value for the server', () => {
    const out = serializeEnv(setSource(parseEnv(FILE), indexOf(FILE, 'PORT'), 'PORT', '${{ task.port(3, 9000) }}'))
    expect(out).toBe('# api\n#cezar PORT=${{ task.port(3, 9000) }}\nPORT=9000\nNAME=app\n')
  })

  it('a value without a reference drops the directive and becomes plain', () => {
    const out = serializeEnv(setSource(parseEnv(FILE), indexOf(FILE, 'PORT'), 'PORT', '8080'))
    expect(out).toBe('# api\nPORT=8080\nNAME=app\n')
  })

  it('an escaped \\${{ is not a reference', () => {
    expect(hasReference('\\${{ literal }}')).toBe(false)
    expect(hasReference('x${{ task.slot }}')).toBe(true)
  })

  it('removes a variable with its directive, and renames both', () => {
    expect(serializeEnv(removeVariable(parseEnv(FILE), indexOf(FILE, 'PORT')))).toBe('# api\nNAME=app\n')
    expect(serializeEnv(renameVariable(parseEnv(FILE), indexOf(FILE, 'PORT'), 'API_PORT')))
      .toBe('# api\n#cezar API_PORT=${{ task.port(0, 9000) }}\nAPI_PORT=9000\nNAME=app\n')
  })

  it('offers the next unused port offset', () => {
    expect(nextPortOffset(FILE)).toBe(1)
    expect(nextPortOffset('')).toBe(0)
  })
})
