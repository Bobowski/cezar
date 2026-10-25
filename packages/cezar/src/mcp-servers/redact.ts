import { maskMcpValue } from '@open-mercato/cezar-contract';
import { REDACTED, redactSecrets, SECRET_NAME_RE } from '../core/secret-redaction.ts';

/**
 * What Settings serves of an MCP definition's command line and url when the caller may not see it
 * raw (spec 2026-10-24-easy-mcp §4): a credential-named flag's value, a URL's userinfo and its
 * credential-named query values, and every known token shape, masked. A `${{ secrets.X }}`
 * reference names a secret and is not one, so it is served as written.
 */

/** `--api-key` / `-t` / `token` → whether the name it carries reads as a credential. */
function credentialName(name: string): boolean {
  const upper = name.replace(/^-+/, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return upper !== '' && (SECRET_NAME_RE.test(upper) || /^(KEY|PAT|AUTH|PASS|PWD|SIG|SIGNATURE|CODE)$/.test(upper));
}

const masked = (value: string) => maskMcpValue(value) ?? REDACTED;

/** A URL with its userinfo and credential-named query values masked; any other text as it is. */
export function redactMcpUrl(text: string): string {
  const withoutUserinfo = text.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#@]*)@/, (whole, scheme: string, userinfo: string) =>
    `${scheme}${maskMcpValue(userinfo) ?? '***'}@`,
  );
  const query = withoutUserinfo.replace(/([?&])([^=&#]+)=([^&#]*)/g, (whole, sep: string, name: string, value: string) =>
    credentialName(name) && value !== '' ? `${sep}${name}=${masked(value)}` : whole,
  );
  return redactSecrets(query, []);
}

/** A stdio server's args, each credential-named flag's value masked (`--token X`, `--token=X`). */
export function redactMcpArgs(args: readonly string[]): string[] {
  return args.map((arg, index) => {
    const previous = index > 0 ? args[index - 1]! : '';
    if (previous.startsWith('-') && !previous.includes('=') && credentialName(previous) && !arg.startsWith('-')) return masked(arg);
    const inline = /^(-{1,2}[^=]+)=(.*)$/s.exec(arg);
    if (inline && credentialName(inline[1]!)) return inline[2] === '' ? arg : `${inline[1]}=${masked(inline[2]!)}`;
    return redactMcpUrl(arg);
  });
}
