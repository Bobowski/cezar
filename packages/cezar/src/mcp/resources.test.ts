import { describe, expect, it } from 'vitest';
import type { CallContext } from './execute.ts';
import { readResource, ResourceError } from './resources.ts';

describe('resource URIs', () => {
  it('refuse a segment that could change the route the read calls', async () => {
    const calls: string[] = [];
    const context: CallContext = {
      dispatch: async (request) => {
        calls.push(new URL(request.url).pathname);
        return new Response('{"workflows":[],"events":[]}', { headers: { 'content-type': 'application/json' } });
      },
      origin: 'http://127.0.0.1:4321',
      headers: new Headers(),
    };
    for (const uri of [
      'cezar://p/default/runs/..%2F..%2Fconfig/thread',
      'cezar://p/..%2Fworkspace/runs/r1/thread',
      'cezar://p/default/runs/%2E%2E/thread',
      'cezar://p/default/workflows/..',
      'cezar://p/default/workflows/a%5Cb',
      'cezar://p/default/workflows/%E0%A4%A',
    ]) {
      await expect(readResource(context, uri), uri).rejects.toBeInstanceOf(ResourceError);
    }
    expect(calls).toEqual([]);
  });
});
