import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { readBackupState } from './state.ts';
import { BackupService, copyArchiveTo } from './service.ts';

/**
 * `cezar backup …` (spec `2026-10-23-backup-restore.md` §4): the same jobs as Settings → Backup,
 * with no server. A restore here does not restart anything — start cezar afterwards.
 */

export interface BackupCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
  /** The identity or passphrase: one line from a terminal, everything when piped. */
  secret: (prompt: string) => Promise<string>;
}

const USAGE = `cezar backup — an encrypted snapshot of what a rebuild cannot recreate

  cezar backup create [--out <file>]   write an archive to ~/.cezar/backups (and the remote target,
                                       when one is set); --out also copies it there
  cezar backup restore <file>          restore an archive here — reads the age identity
                                       (AGE-SECRET-KEY-1…) or the passphrase from stdin
  cezar backup list                    the archives kept on this machine

Set who archives are encrypted to in Settings → Backup first (an age1… public key, or a passphrase).`;

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    return await new Promise<string>((done) => rl.question(prompt, done));
  } finally {
    rl.close();
  }
}

const human = (bytes: number): string =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
  : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  : `${Math.max(1, Math.round(bytes / 1024))} KiB`;

export async function runBackupCommand(
  args: string[],
  options: { version: string; service?: BackupService; io?: BackupCliIo } = { version: '0.0.0' },
): Promise<number> {
  const io = options.io ?? { log: console.log, error: console.error, secret: readSecret };
  const service = options.service ?? new BackupService({ version: options.version });
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help') {
    io.log(USAGE);
    return command ? 0 : 2;
  }
  let values: { out?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: rest, options: { out: { type: 'string' } }, allowPositionals: true }));
  } catch (error) {
    io.error(`cezar backup: ${(error as Error).message}`);
    return 2;
  }
  try {
    switch (command) {
      case 'create': {
        const recipient = readBackupState().recipient;
        const passphrase = recipient?.kind === 'passphrase' ? (await io.secret('passphrase: ')).replace(/\r?\n$/, '') : undefined;
        const created = await service.createBackup({ passphrase, log: (line) => io.log(`  ${line}`) });
        if (values.out) {
          copyArchiveTo(created.path, resolve(values.out));
          io.log(`  copied to ${resolve(values.out)}`);
        }
        io.log(`\n  ${created.path} (${human(created.size)})${created.uploaded ? ' — uploaded' : ''}`);
        return 0;
      }
      case 'restore': {
        const file = positionals[0];
        if (!file || !existsSync(file)) {
          io.error('cezar backup restore: name the archive to restore');
          return 2;
        }
        io.log('  A restore replaces cezar\'s state, the owner account and the agents\' logins with the archive\'s.');
        io.log('  Stop any running cezar first.');
        const identity = await io.secret('age identity (AGE-SECRET-KEY-1…) or passphrase: ');
        const manifest = await service.restore({ archive: resolve(file), identity, log: (line) => io.log(`  ${line}`) });
        io.log(`\n  restored ${manifest.projects.length} project(s) from ${manifest.host} — start cezar to use them`);
        return 0;
      }
      case 'list': {
        const archives = service.listArchives();
        if (archives.length === 0) io.log('  no archives on this machine');
        for (const archive of archives) {
          io.log(`  ${archive.name}  ${human(archive.size)}  ${archive.createdAt}${archive.uploaded ? '  uploaded' : ''}`);
        }
        return 0;
      }
      default:
        io.error(`cezar backup: unknown command ${command}\n`);
        io.log(USAGE);
        return 2;
    }
  } catch (error) {
    io.error(`cezar backup: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
