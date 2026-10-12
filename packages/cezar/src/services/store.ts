import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { servicePinSchema, type ServicePin } from '@open-mercato/cezar-contract';

/**
 * A project's pinned services and which of them were running (spec
 * `2026-10-11-project-services` §3.2): `<repo>/.ai/cezar/services.json`, cezar-written, outside
 * git. Absent or corrupt means no pins — never an error — and one bad row never evicts the rest.
 */

export const SERVICES_FILE = 'services.json';

const fileSchema = z.object({
  services: z.array(z.unknown()).catch([]),
  lastRunning: z.array(z.string()).catch([]),
}).passthrough();

export interface ServicesFile {
  services: ServicePin[];
  lastRunning: string[];
}

export async function loadServices(dataDir: string): Promise<ServicesFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dataDir, SERVICES_FILE), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`cezar: ${SERVICES_FILE} could not be read — starting with no pinned services`);
    return { services: [], lastRunning: [] };
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) return { services: [], lastRunning: [] };
  const services: ServicePin[] = [];
  for (const row of parsed.data.services) {
    const pin = servicePinSchema.safeParse(row);
    if (pin.success && !services.some((other) => other.id === pin.data.id)) services.push(pin.data);
  }
  return { services, lastRunning: parsed.data.lastRunning.filter((id) => services.some((pin) => pin.id === id)) };
}

/** Writes are serialized per file: two saves racing would otherwise interleave tmp and rename. */
const queues = new Map<string, Promise<unknown>>();

export function saveServices(dataDir: string, update: (current: ServicesFile) => ServicesFile): Promise<ServicesFile> {
  const file = join(dataDir, SERVICES_FILE);
  const next = (queues.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const updated = update(await loadServices(dataDir));
    await mkdir(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
    return updated;
  });
  queues.set(file, next);
  return next;
}

/** `storefront: dev` → `storefront-dev-3fa9`: readable in a URL, unique among the pins. */
export function newServiceId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${slug || 'service'}-${randomBytes(2).toString('hex')}`;
}

/** Whether the project has any pin — a synchronous peek for the session-start path, which must
 *  not wait on disk to decide one sentence of a prompt. Unreadable means no. */
export function hasPinnedServices(dataDir: string): boolean {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(join(dataDir, SERVICES_FILE), 'utf8')));
    return parsed.success && parsed.data.services.some((row) => servicePinSchema.safeParse(row).success);
  } catch {
    return false;
  }
}
