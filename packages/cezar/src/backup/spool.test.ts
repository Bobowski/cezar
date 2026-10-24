import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cezarHomeDir } from '../paths.ts';
import { spool } from './routes.ts';

const uploads = () => (existsSync(cezarHomeDir()) ? readdirSync(cezarHomeDir()).filter((name) => name.startsWith('.restore-upload-')) : []);

describe('spool — a restore upload streamed to disk', () => {
  it('gives up on an upload that stops sending, and leaves no temp file', async () => {
    const before = uploads();
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
    });
    await expect(spool(stalled, 10, 50)).rejects.toThrow(/stalled/);
    expect(uploads()).toEqual(before);
  });

  it('keeps a slow upload that keeps sending', async () => {
    let sent = 0;
    const slow = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        controller.enqueue(new Uint8Array([sent]));
        if (++sent === 5) controller.close();
      },
    });
    const path = await spool(slow, 5, 80);
    try {
      expect([...readFileSync(path)]).toEqual([0, 1, 2, 3, 4]);
    } finally {
      rmSync(path, { force: true });
    }
  });
});
