import { readdir, readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { accessSync, constants } from 'node:fs';
import type { ServiceCandidate } from '@open-mercato/cezar-contract';
import { parseMakefileTargets } from '../server/terminal/commands.ts';
import { ENV_WALK_SKIP_DIRS, isDependencyVendorDir } from '../worktree-env.ts';

/**
 * Service candidates (spec `.ai/specs/2026-10-11-project-services.md` §3.1): commands the
 * repository already defines that look like part of its stack. Read on demand, never cached,
 * every source optional — a repo with none of them offers nothing and the "Add a command" form.
 * Discovery runs nothing.
 */

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const LOCKFILES: Array<[file: string, run: string, bin: string]> = [
  ['pnpm-lock.yaml', 'pnpm run', 'pnpm'],
  ['yarn.lock', 'yarn run', 'yarn'],
  ['bun.lockb', 'bun run', 'bun'],
  ['bun.lock', 'bun run', 'bun'],
  ['package-lock.json', 'npm run', 'npm'],
];
/** A monorepo keeps its apps two or three levels down (`app/apps/web`). */
const MAX_DEPTH = 3;
const MAX_DIRS = 600;
const MAX_CANDIDATES = 200;
const PRIMARY = /^(dev|start|serve|watch|worker)([:._-].*)?$/;

async function readText(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8');
    return text.length > 512_000 ? null : text;
  } catch {
    return null;
  }
}

/** Whether `bin` is on PATH. Injectable so a test does not depend on the host's tools. */
export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      try {
        accessSync(join(dir, bin + extension), constants.X_OK);
        return true;
      } catch {
        // Not here.
      }
    }
  }
  return false;
}

const inDir = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`);

export async function discoverServiceCandidates(
  root: string,
  has: (bin: string) => boolean = onPath,
): Promise<ServiceCandidate[]> {
  const out: ServiceCandidate[] = [];
  const missing = (bin: string): string | null => (has(bin) ? null : `${bin} is not on PATH`);
  let opened = 0;

  const visit = async (rel: string, depth: number, runner: [run: string, bin: string]): Promise<void> => {
    if (opened >= MAX_DIRS || out.length >= MAX_CANDIDATES) return;
    opened += 1;
    let entries;
    try {
      entries = await readdir(rel === '' ? root : join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    if (rel !== '' && entries.some((entry) => entry.name === '.git')) return;
    if (isDependencyVendorDir(rel, [...names])) return;
    // The nearest lockfile at or above a package decides how its scripts are run.
    const lock = LOCKFILES.find(([file]) => names.has(file));
    const run: [string, string] = lock ? [lock[1], lock[2]] : runner;
    const label = rel === '' ? '' : `${rel.split('/').pop()}: `;

    if (names.has('package.json')) {
      const scripts = packageScripts(await readText(join(root, inDir(rel, 'package.json'))));
      for (const [name, detail] of scripts) {
        out.push({
          name: `${label}${name}`, command: `${run[0]} ${name}`, cwd: rel, source: inDir(rel, 'package.json'),
          detail, primary: PRIMARY.test(name), unavailable: missing(run[1]),
        });
      }
    }
    for (const file of COMPOSE_FILES) {
      if (!names.has(file)) continue;
      // Attached on purpose: logs stream into the same view and stopping it stops the containers.
      out.push({
        name: `${label}compose`, command: `docker compose -f ${file} up`, cwd: rel, source: inDir(rel, file),
        detail: null, primary: true, unavailable: missing('docker'),
      });
    }
    if (names.has('Procfile')) {
      for (const line of ((await readText(join(root, inDir(rel, 'Procfile')))) ?? '').split('\n')) {
        const match = /^([A-Za-z][\w-]*)\s*:\s*(\S.*)$/.exec(line);
        if (match) out.push({ name: `${label}${match[1]}`, command: match[2]!.trim(), cwd: rel, source: inDir(rel, 'Procfile'), detail: null, primary: true, unavailable: null });
      }
    }
    const makefile = ['Makefile', 'makefile', 'GNUmakefile'].find((file) => names.has(file));
    if (makefile) {
      for (const target of parseMakefileTargets((await readText(join(root, inDir(rel, makefile)))) ?? '')) {
        const name = target.command.replace(/^make /, '');
        out.push({ name: `${label}make ${name}`, command: target.command, cwd: rel, source: inDir(rel, makefile), detail: null, primary: PRIMARY.test(name), unavailable: missing('make') });
      }
    }
    if (depth >= MAX_DEPTH) return;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || ENV_WALK_SKIP_DIRS.has(entry.name)) continue;
      await visit(inDir(rel, entry.name), depth + 1, run);
    }
  };
  await visit('', 0, ['npm run', 'npm']);
  // Long-lived scripts first, each group in walk order.
  return [...out.filter((c) => c.primary), ...out.filter((c) => !c.primary)].slice(0, MAX_CANDIDATES);
}

function packageScripts(text: string | null): Array<[name: string, detail: string | null]> {
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const scripts = (parsed as { scripts?: unknown } | null)?.scripts;
  if (typeof scripts !== 'object' || scripts === null) return [];
  return Object.entries(scripts as Record<string, unknown>)
    // A name with shell metacharacters is not one a package manager accepts; never quote it in.
    .filter(([name]) => /^[\w.:@-]+$/.test(name))
    .slice(0, 40)
    .map(([name, body]) => [name, typeof body === 'string' && body.trim() !== '' ? body.trim() : null]);
}
