import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Node's `requestTimeout` (300 s by default) is server-wide, and a 1 GiB restore upload outlives
 * it (spec 2026-10-23-backup-restore §10). The server runs with it off and this puts the same
 * bound back on every request but the exempt ones, which police themselves (an idle timeout on
 * the streaming reader, `backup/routes.ts`).
 */
export const REQUEST_TIMEOUT_MS = 300_000;

type RequestServer = {
  requestTimeout: number;
  on(event: 'request', listener: (req: IncomingMessage, res: ServerResponse) => void): unknown;
};

export function applyRequestTimeout(server: object, exempt: (pathname: string) => boolean, ms = REQUEST_TIMEOUT_MS): void {
  // An HTTP/2 server has no `requestTimeout` and is left alone.
  if (!('requestTimeout' in server)) return;
  const http = server as RequestServer;
  http.requestTimeout = 0;
  http.on('request', (req, res) => {
    if (req.complete || exempt((req.url ?? '').split('?')[0] ?? '')) return;
    const timer = setTimeout(() => {
      if (req.complete) return;
      if (!res.headersSent) res.writeHead(408, { connection: 'close' }).end();
      req.socket.destroy();
    }, ms);
    timer.unref?.();
    const clear = () => clearTimeout(timer);
    req.once('end', clear);
    req.once('close', clear);
    res.once('close', clear);
  });
}
