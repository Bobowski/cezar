/**
 * `8500-8519`, `8500,8501`, or a mix → the ports, in order, without duplicates. Anything that is
 * not a port above the privileged range is dropped: a typo must not make cezar try to bind :80.
 *
 * A leaf module: `capabilities.ts` asks it whether a hosted cockpit has a gateway at all, and the
 * gateway itself imports `capabilities.ts` (through the auth guard).
 */
export function parsePreviewPorts(raw: string | undefined): number[] {
  const ports: number[] = [];
  for (const part of (raw ?? '').split(',')) {
    const range = /^\s*(\d{1,5})\s*(?:-\s*(\d{1,5})\s*)?$/.exec(part);
    if (!range) continue;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    for (let port = from; port <= to && ports.length < 256; port += 1) {
      if (port >= 1024 && port <= 65535 && !ports.includes(port)) ports.push(port);
    }
  }
  return ports;
}
