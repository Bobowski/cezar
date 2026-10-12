import { parseArgs } from 'node:util';
import { hasCredentials, issueSetupCode, readAuthStore } from './store.ts';

/**
 * `cezar auth …` — the host-side half of cockpit authentication (spec
 * `2026-10-12-cockpit-authentication.md` §5.1). Files only, no server: the box is the root of
 * trust, so whoever can run this is already the user cezar runs as.
 */
export interface AuthCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

const USAGE = `cezar auth — the cockpit's accounts, from the host

  cezar auth setup [--url <https://host>]         mint a one-time link that creates the owner account
  cezar auth reset <user> [--url <https://host>]  clear a user's password, second factor and sessions,
                                                  and mint a link to set them again
  cezar auth status                               who exists, and whether setup is pending

The link is valid for 15 minutes and works once.`;

/** The cockpit's public address when `server-install` recorded one; the caller prints a hint otherwise. */
async function installedUrl(): Promise<string | undefined> {
  try {
    const { listServerInstances } = await import('../server-install/state.ts');
    const domains = listServerInstances().flatMap(({ state }) => (state.domain ? [state.domain] : []));
    return domains.length === 1 ? `https://${domains[0]}` : undefined;
  } catch {
    return undefined;
  }
}

async function printLink(code: string, expiresAt: number, url: string | undefined, io: AuthCliIo): Promise<void> {
  const base = (url ?? (await installedUrl()))?.replace(/\/+$/, '');
  // In the fragment, so the code never reaches a proxy's access log.
  io.log(base ? `  ${base}/setup#code=${code}` : `  <your cockpit address>/setup#code=${code}`);
  io.log(`\n  Valid until ${new Date(expiresAt).toLocaleTimeString()} and usable once.`);
}

export async function runAuthCommand(
  args: string[],
  io: AuthCliIo = { log: console.log, error: console.error },
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help') {
    io.log(USAGE);
    return command ? 0 : 2;
  }
  let values: { url?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: rest, options: { url: { type: 'string' } }, allowPositionals: true }));
  } catch (error) {
    io.error(`cezar auth: ${(error as Error).message}`);
    return 2;
  }
  switch (command) {
    case 'status': {
      const store = readAuthStore();
      if (store.users.length === 0) io.log('No account yet. Run `cezar auth setup`.');
      for (const user of store.users) {
        io.log(`${user.name}  ${user.role}  ${hasCredentials(user) ? 'active' : 'reset — awaiting setup'}`);
      }
      if (store.setup && store.setup.expiresAt > Date.now()) io.log('A setup link is pending.');
      return 0;
    }
    case 'setup': {
      const result = issueSetupCode();
      if (!result.ok) {
        io.error('cezar auth setup: an account already exists. To set its credentials again: cezar auth reset <user>');
        return 1;
      }
      io.log('\n  Open this link to create the owner account:\n');
      await printLink(result.setup.code, result.setup.expiresAt, values.url, io);
      return 0;
    }
    case 'reset': {
      const name = positionals[0];
      if (!name) {
        io.error('cezar auth reset: a username is required (`cezar auth status` lists them)');
        return 2;
      }
      const result = issueSetupCode({ resetUser: name });
      if (!result.ok) {
        io.error(`cezar auth reset: no user named "${name}"`);
        return 1;
      }
      io.log(`\n  ${name} is signed out everywhere. Open this link to set a new password and second factor:\n`);
      await printLink(result.setup.code, result.setup.expiresAt, values.url, io);
      return 0;
    }
    default:
      io.error(`cezar auth: unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}
