import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyWsUpgrade } from './server.ts';

/**
 * Spec `2026-10-12-cockpit-authentication.md` §6: the `/api/v1/ws` origin check compares
 * authorities, and `http://host` and `https://host` share one. Behind TLS the plain-HTTP origin of
 * the cockpit's own hostname is forgeable on-path and must not pass as the cockpit itself.
 */
describe('verifyWsUpgrade — scheme of a same-authority Origin', () => {
  const req = (headers: Record<string, string | undefined>) => ({ headers }) as IncomingMessage;
  const HOST = 'agents.example.dev';
  const saved = { remote: process.env.CEZ_REMOTE, auth: process.env.CEZ_AUTH };

  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
  });
  afterEach(() => {
    for (const [key, value] of [['CEZ_REMOTE', saved.remote], ['CEZ_AUTH', saved.auth]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('refuses a plain-HTTP Origin on a handshake the proxy received over TLS', () => {
    process.env.CEZ_REMOTE = '1';
    expect(verifyWsUpgrade(req({ host: HOST, origin: `http://${HOST}`, 'x-forwarded-proto': 'https' }))).toBe(false);
    expect(verifyWsUpgrade(req({ host: HOST, origin: `http://${HOST}`, 'x-forwarded-proto': 'HTTPS, http' }))).toBe(false);
  });

  it('refuses a same-authority Origin the browser itself calls cross-site', () => {
    process.env.CEZ_REMOTE = '1';
    expect(verifyWsUpgrade(req({ host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  // Guards: pass with and without the fix — every legitimate cockpit keeps its socket.
  it('still trusts the hosted cockpit behind TLS', () => {
    process.env.CEZ_REMOTE = '1';
    const trusted = { trusted: true };
    expect(verifyWsUpgrade(req({ host: HOST, origin: `https://${HOST}`, 'x-forwarded-proto': 'https' }))).toEqual(trusted);
    expect(verifyWsUpgrade(req({ host: HOST, origin: `https://${HOST}`, 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' }))).toEqual(trusted);
    // A second TLS terminator in front (the inner proxy saw plain HTTP): not this check's business.
    expect(verifyWsUpgrade(req({ host: HOST, origin: `https://${HOST}`, 'x-forwarded-proto': 'http' }))).toEqual(trusted);
    // A plain-HTTP hosted cockpit (a tailnet, a LAN box).
    expect(verifyWsUpgrade(req({ host: `${HOST}:4321`, origin: `http://${HOST}:4321`, 'x-forwarded-proto': 'http' }))).toEqual(trusted);
    expect(verifyWsUpgrade(req({ host: `${HOST}:4321`, origin: `http://${HOST}:4321` }))).toEqual(trusted);
    expect(verifyWsUpgrade(req({ host: HOST }))).toEqual(trusted);
  });

  it('still trusts the local cockpit, the desktop shell and the Vite dev proxy', () => {
    const local = '127.0.0.1:4321';
    expect(verifyWsUpgrade(req({ host: local, origin: `http://${local}` }))).toEqual({ trusted: true });
    expect(verifyWsUpgrade(req({ host: local, origin: `http://${local}`, 'sec-fetch-site': 'same-origin' }))).toEqual({ trusted: true });
    expect(verifyWsUpgrade(req({ host: local }))).toEqual({ trusted: true });
    expect(verifyWsUpgrade(req({ host: local, origin: 'http://localhost:5197', 'sec-fetch-site': 'same-origin' }))).toEqual({ trusted: true });
    expect(verifyWsUpgrade(req({ host: local, origin: 'http://localhost:5197' }))).toEqual({ trusted: false });
    // A dev proxy that adds forwarding headers says `http`, matching its Origin.
    expect(verifyWsUpgrade(req({ host: local, origin: 'http://localhost:5197', 'sec-fetch-site': 'same-origin', 'x-forwarded-proto': 'http' }))).toEqual({ trusted: true });
  });
});
