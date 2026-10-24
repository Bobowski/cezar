import { describe, expect, it } from 'vitest';
import {
  collectSecretValues, heldSecretStart, lineSafeCut, redactDeep, redactionSafeCut, redactSecrets, redactSecretsFrom, REDACTED,
} from './secret-redaction.ts';

/**
 * #427: credentials must never be persisted to a run's NDJSON transcript.
 * Value-based redaction scrubs the host's own secret env values; pattern-based
 * redaction catches well-known token shapes from anywhere.
 */
describe('collectSecretValues', () => {
  it('collects values of secret-named vars, skips short and non-secret names', () => {
    const values = collectSecretValues({
      GITHUB_TOKEN: 'gho_averylongtokenvalue',
      AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMIabcdefghij',
      PATH: '/usr/bin:/bin',
      SSH_AUTH_SOCK: '/tmp/ssh-abc/agent.1', // AUTH but allow-listed
      SHORT_TOKEN: 'abc', // too short
    });
    expect(values).toContain('gho_averylongtokenvalue');
    expect(values).toContain('wJalrXUtnFEMIabcdefghij');
    expect(values).not.toContain('/usr/bin:/bin');
    expect(values).not.toContain('/tmp/ssh-abc/agent.1');
    expect(values).not.toContain('abc');
  });

  /** #427 review: the shared SECRET_NAME_RE means a var stripped from the
   *  child env is also collected for redaction — the two used to diverge. */
  it('collects the name shapes agent-env strips, so the lists cannot drift', () => {
    const values = collectSecretValues({
      SIGNING_KEY: 'signingkeyvalue123',
      MY_KEY_MATERIAL: 'keymaterialvalue123',
      SESSION_SECRET: 'sessionsecretvalue123',
      COOKIE_SIGNING: 'cookiesigningvalue123',
    });
    expect(values).toEqual(
      expect.arrayContaining([
        'signingkeyvalue123',
        'keymaterialvalue123',
        'sessionsecretvalue123',
        'cookiesigningvalue123',
      ]),
    );
  });

  it('skips session/desktop bookkeeping whose value is a path, not a credential', () => {
    const values = collectSecretValues({
      SESSION_MANAGER: 'local/host:@/tmp/.ICE-unix/1234',
      XDG_SESSION_TYPE: 'wayland-session-type',
    });
    expect(values).toEqual([]);
  });
});

describe('redactSecrets', () => {
  it('scrubs concrete host secret values found in text', () => {
    const secrets = collectSecretValues({ GITHUB_TOKEN: 'gho_myrealsecrettoken1234' });
    const out = redactSecrets('run: gh auth uses gho_myrealsecrettoken1234 here', secrets);
    expect(out).not.toContain('gho_myrealsecrettoken1234');
    expect(out).toContain(REDACTED);
  });

  it('scrubs well-known token shapes even without knowing the env', () => {
    const line = [
      'gh: ghp_0123456789abcdefghijABCDEFGHIJ0123',
      'anthropic: sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'aws: AKIAIOSFODNN7EXAMPLE',
      'google: AIzaSyA0123456789abcdefghijklmnopqrstuv',
    ].join('\n');
    const out = redactSecrets(line, []);
    expect(out).not.toMatch(/ghp_|sk-ant|AKIA|AIza/);
    expect(out.match(new RegExp(REDACTED.replace(/[[\]]/g, '\\$&'), 'g'))?.length).toBe(4);
  });

  it('leaves non-secret text untouched', () => {
    expect(redactSecrets('the quick brown fox', [])).toBe('the quick brown fox');
  });

  /** A word ending in "sk" is not a key: `task-…` used to come out as `ta[REDACTED]`. */
  it('leaves hyphenated words that merely end in "sk" alone', () => {
    const line = [
      'fix task-scheduling-and-priority-queue',
      'refactor desk-booking-calendar-widget-v2',
      'risk-assessment-matrix-for-payments',
      'e2e fixture task-columns-workflow-folded',
      'task-ant-colony-optimisation-heuristics',
    ].join('\n');
    expect(redactSecrets(line, [])).toBe(line);
  });

  it('still redacts OpenAI and Anthropic key shapes wherever a key can stand', () => {
    const keys = [
      `sk-${'A1b2C3d4'.repeat(6)}`, // legacy: sk- + 48
      `sk-proj-${'Ab3_Cd4-'.repeat(8)}`,
      `sk-svcacct-${'Zz9Yy8Xx'.repeat(4)}`,
      `sk-ant-api03-${'Q7r_S8t-'.repeat(6)}AA`,
    ];
    for (const key of keys) {
      for (const text of [key, `OPENAI_API_KEY=${key}`, `{"key":"${key}"}`, `Authorization: Bearer ${key}`, `x-api-key:${key}`, `--key=${key}`]) {
        expect(redactSecrets(text, [])).toBe(text.replace(key, REDACTED));
      }
    }
  });

  /**
   * #427 review: the old 8-char floor mangled ordinary output — a dev box with
   * `POSTGRES_PASSWORD=postgres` turned `apt install postgresql-16` into
   * `apt install [REDACTED]ql-16`. Short dictionary words are not redactable.
   */
  it('does not redact short dictionary-word "secrets" out of ordinary output', () => {
    const secrets = collectSecretValues({ POSTGRES_PASSWORD: 'postgres', DB_PASSWORD: 'root' });
    expect(secrets).toEqual([]);
    const line = 'apt install postgresql-16 && psql -U postgres -c "select 1"';
    expect(redactSecrets(line, secrets)).toBe(line);
  });

  it('still redacts a real credential value at the raised floor', () => {
    const secrets = collectSecretValues({ POSTGRES_PASSWORD: 'S3cr3t-Pr0d-Passw0rd' });
    const out = redactSecrets('psql://app:S3cr3t-Pr0d-Passw0rd@db/prod', secrets);
    expect(out).not.toContain('S3cr3t-Pr0d-Passw0rd');
    expect(out).toContain(REDACTED);
  });
});

describe('a multi-line secret, whatever the line ends', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
  const crlf = pem.replace(/\n/g, '\r\n');

  it('is redacted from CRLF output when stored with LF, and the other way round, keeping the text’s own line ends', () => {
    expect(redactSecrets(`key:\r\n${crlf}\r\nok\r\n`, [pem])).toBe(`key:\r\n${REDACTED}\r\nok\r\n`);
    expect(redactSecrets(`key:\n${pem}\nok\n`, [crlf])).toBe(`key:\n${REDACTED}\nok\n`);
  });

  it('is held while a CRLF tail may still be its start — a read split between CR and LF included', () => {
    const lines = crlf.split('\r\n');
    const text = `boot\r\n${lines[0]}\r\n${lines[1]}\r\n`;
    expect(heldSecretStart(text, [pem])).toBe('boot\r\n'.length);
    expect(heldSecretStart(`boot\r\n${lines[0]}\r`, [pem])).toBe('boot\r\n'.length);
    // Complete, it is not held: it can be redacted now.
    expect(heldSecretStart(`boot\r\n${crlf}\r\n`, [pem])).toBe(`boot\r\n${crlf}\r\n`.length);
    expect(heldSecretStart(`boot\r\n${lines[0]}\r\nnot it\r\n`, [pem])).toBe(`boot\r\n${lines[0]}\r\nnot it\r\n`.length);
  });

  it('is never cut across by a stream, CRLF or not', () => {
    const text = `${'x'.repeat(10)}${crlf}${'y'.repeat(200)}`;
    expect(redactionSafeCut(text, [pem], 30)).toBe(10);
    // A line cut inside a complete one moves to its start; one outside it stays.
    expect(lineSafeCut(`boot\n${pem}`, [pem], `boot\n${pem}`.lastIndexOf('\n') + 1)).toBe(5);
    expect(lineSafeCut(`boot\n${pem}\nok`, [pem], `boot\n${pem}\n`.length)).toBe(`boot\n${pem}\n`.length);
  });

  it('is redacted from a hidden prefix on: what reaches past it goes out as one mark', () => {
    expect(redactSecretsFrom(`${pem}\nok`, [pem], 10)).toBe(`${REDACTED}\nok`);
    expect(redactSecretsFrom(`-----BEGIN PRIVATE KEY-----\nnot it\n`, [pem], 28)).toBe('not it\n');
    expect(redactSecretsFrom(pem, [pem], 0)).toBe(REDACTED);
  });
});

describe('a multi-line secret seen only in part (a stream picked up mid-key)', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nSECRETBODYLINE2abcdefghijklmnop\nshort==\n-----END PRIVATE KEY-----';
  const [, body1, body2] = pem.split('\n') as [string, string, string];

  it('redacts each of its body lines standing as a line, LF or CRLF, and leaves its armor and short lines', () => {
    expect(redactSecrets(`${body1}\n${body2}\nshort==\n-----END PRIVATE KEY-----\napp up\n`, [pem]))
      .toBe(`${REDACTED}\n${REDACTED}\nshort==\n-----END PRIVATE KEY-----\napp up\n`);
    expect(redactSecrets(`boot\r\n${body2}\r\nok`, [pem])).toBe(`boot\r\n${REDACTED}\r\nok`);
    // A body line inside a longer line is not the line itself.
    expect(redactSecrets(`x${body2}\n`, [pem])).toBe(`x${body2}\n`);
  });

  it('redacts the rest of a body line a text starts inside, and the start of one it ends inside', () => {
    expect(redactSecrets(`${body1.slice(20)}\n${body2}\nok\n`, [pem])).toBe(`${REDACTED}\n${REDACTED}\nok\n`);
    expect(redactSecrets(`ok\n${body1.slice(0, 30)}`, [pem])).toBe(`ok\n${REDACTED}`);
    // Under 16 chars a piece is too common to be the key's.
    expect(redactSecrets(`${body1.slice(-10)}\nok\n`, [pem])).toBe(`${body1.slice(-10)}\nok\n`);
  });

  it('still redacts the whole value as one mark, and a stream never cuts inside a body line', () => {
    expect(redactSecrets(`a\n${pem}\nb`, [pem])).toBe(`a\n${REDACTED}\nb`);
    expect(redactSecretsFrom(`${body1}\n${body2}\nok\n`, [pem], 5)).toBe(`${REDACTED}\n${REDACTED}\nok\n`);
  });
});

describe('redactDeep', () => {
  it('scrubs string leaves in nested event structures', () => {
    const event = {
      type: 'tool-result',
      result: 'export GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ0123',
      item: { output: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', nested: [{ text: 'safe' }] },
      seq: 3,
    };
    const out = redactDeep(event, []);
    expect(out.result).not.toContain('ghp_');
    expect((out.item as { output: string }).output).not.toContain('sk-ant');
    expect(out.seq).toBe(3); // non-strings preserved
    expect((out.item as { nested: Array<{ text: string }> }).nested[0]?.text).toBe('safe');
  });
});

it('redacts raw tracker key values from persisted task text', () => {
  const secrets = collectSecretValues({ JIRA_API_TOKEN: 'jira-token-value', LINEAR_API_KEY: 'linear-key-value' });
  expect(redactSecrets('jira-token-value linear-key-value', secrets)).toBe(REDACTED + ' ' + REDACTED);
});
