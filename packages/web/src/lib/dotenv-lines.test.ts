import { describe, expect, it } from 'vitest'

import { addVariable, duplicateKeys, formatAssignment, parseEnv, removeLine, serializeEnv, setVariable } from './dotenv-lines'

const FILE = [
  '# Database',
  'DATABASE_URL=postgres://ffp:ffp@localhost:5432/ffp_medusa',
  '',
  'export REDIS_URL=redis://:ffp@localhost:6379  # local',
  "SINGLE='a # not a comment'",
  'DOUBLE="line one\\nline two"',
  'MULTI="first',
  'second"',
  'EMPTY=',
  'not an assignment',
].join('\n') + '\n'

describe('parseEnv / serializeEnv', () => {
  it('round-trips a file byte for byte when nothing is edited', () => {
    expect(serializeEnv(parseEnv(FILE))).toBe(FILE)
  })

  it('reads values the way a dotenv loader would', () => {
    const vars = Object.fromEntries(parseEnv(FILE).flatMap((l) => (l.kind === 'var' ? [[l.key, l.value]] : [])))
    expect(vars).toEqual({
      DATABASE_URL: 'postgres://ffp:ffp@localhost:5432/ffp_medusa',
      REDIS_URL: 'redis://:ffp@localhost:6379',
      SINGLE: 'a # not a comment',
      DOUBLE: 'line one\nline two',
      MULTI: 'first\nsecond',
      EMPTY: '',
    })
  })

  it('keeps comments, blank and unparseable lines as they are', () => {
    const others = parseEnv(FILE).filter((l) => l.kind === 'other').map((l) => l.raw)
    expect(others).toEqual(['# Database', '', 'not an assignment'])
  })

  it('reads CRLF files and writes LF', () => {
    expect(serializeEnv(parseEnv('A=1\r\nB=2\r\n'))).toBe('A=1\nB=2\n')
  })

  it('an empty file is empty', () => {
    expect(parseEnv('')).toEqual([])
    expect(serializeEnv([])).toBe('')
  })
})

describe('editing', () => {
  it('changes only the edited line and keeps its export prefix', () => {
    const lines = parseEnv(FILE)
    const index = lines.findIndex((l) => l.kind === 'var' && l.key === 'REDIS_URL')
    const out = serializeEnv(setVariable(lines, index, 'REDIS_URL', 'redis://other:6380'))
    expect(out).toBe(FILE.replace('export REDIS_URL=redis://:ffp@localhost:6379  # local', 'export REDIS_URL=redis://other:6380'))
  })

  it('leaves the text alone when a value is set to what it already is', () => {
    const lines = parseEnv(FILE)
    const index = lines.findIndex((l) => l.kind === 'var' && l.key === 'SINGLE')
    expect(serializeEnv(setVariable(lines, index, 'SINGLE', 'a # not a comment'))).toBe(FILE)
  })

  it('quotes a value only when it needs it, and the result reads back the same', () => {
    for (const value of ['plain', '', 'with space', 'has#hash', 'quote"inside', 'multi\nline', 'back\\slash', '$HOME', 'sk_live_123/abc=']) {
      const line = formatAssignment('K', value)
      const back = parseEnv(`${line}\n`)[0]
      expect(back).toMatchObject({ kind: 'var', key: 'K', value })
    }
    expect(formatAssignment('K', 'plain')).toBe('K=plain')
    expect(formatAssignment('K', 'with space')).toBe('K="with space"')
  })

  it('adds at the end and removes a whole multi-line variable', () => {
    let lines = addVariable(parseEnv(FILE), 'NEW_ONE', 'x')
    expect(serializeEnv(lines).endsWith('NEW_ONE=x\n')).toBe(true)
    const multi = lines.findIndex((l) => l.kind === 'var' && l.key === 'MULTI')
    lines = removeLine(lines, multi)
    expect(serializeEnv(lines)).not.toContain('second"')
  })

  it('flags duplicate keys', () => {
    expect([...duplicateKeys(parseEnv('A=1\nB=2\nA=3\n'))]).toEqual(['A'])
  })
})
