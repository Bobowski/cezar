/**
 * Fixed age ciphertexts of REFERENCE_PLAINTEXT, kept so a future `age-encryption` (or a change to
 * codec.ts) cannot silently stop opening archives written today. Made once, on 2026-10-24:
 *
 * - LIBRARY_X25519: `new Encrypter()`, `addRecipient(TEST_RECIPIENT)`, `encrypt(plaintext)` with
 *   age-encryption@0.3.1. The reference CLI (FiloSottile age v1.3.2, `age -d -i <key file>`)
 *   decrypted it to the same bytes.
 * - CLI_X25519: `age -r <TEST_RECIPIENT> -o cli.age plain.txt` with age v1.3.2, the Go
 *   implementation, so a restore opens what the reference tool writes.
 * - LIBRARY_SCRYPT: age-encryption@0.3.1, `setScryptWorkFactor(10)` and
 *   `setPassphrase(REFERENCE_PASSPHRASE)`.
 *
 * Base64, split for diffs. Never regenerate them to make a test pass: a mismatch IS the regression.
 */
export const REFERENCE_PLAINTEXT = 'cezar age reference vector\n';
export const REFERENCE_PASSPHRASE = 'correct horse battery staple';
const join = (parts: string[]): Buffer => Buffer.from(parts.join(''), 'base64');
export const LIBRARY_X25519 = join([
  "YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSAzYUtPVzJwWjg2dXIwZTZTeGM4WWJISm5ML3l1TzZYaVJLUGczUlZI",
  "ODJzCjFkd3lDTUtCcGd6bW15TStHRWR2YURnL3pJaXlHTkNqTjVJMUhHV2tVd1UKLS0tIGVrd0tvcm5GNUpxWm5nU3RrWFZz",
  "S2pyUWh3M1pEekh3UFpWY3NNRHd6c0UKhSQRK+J2mCZdj4VkCYDxxZ+bjSOW26i3UbFTXRNwj+W+QXR+fLdY73Sayas/N1oT",
  "HeQuyE2Ha8Z9ojc=",
]);
export const CLI_X25519 = join([
  "YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBROExYdlNxeTFzUEgvS0F0NXpYQjFXalZOK1dGMEpwQWhUNEpRbG9x",
  "UW5rClpVaXFqcGVDVmljUlRpN2swb2t1QWZjd3NPMWR5VXRtclZXaUVCUnJYUW8KLS0tIFRIMzVvbFJsZEZKMUtaTGVvUHJP",
  "TytHWTNTR28zdGpSYlBJZ2FFcHlweWcK8NY3a/qKR0L7Pehzjg8Y5+w0uiqYyfs/sSeqEDJFdFU3/S44NaMuMZ4b7MESpLMz",
  "n2GV+IkNJXaPe/w=",
]);
export const LIBRARY_SCRYPT = join([
  "YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IHNjcnlwdCB3WGpESUNWR3Y1czNoLzlZSExHajR3IDEwClFLbktGY1o5VFR6eEsz",
  "YjZmdDUyUjVNQmZjeGtSY3V6VVRZZkVHbnR1Zm8KLS0tIHA3djVHWWFOWGRJTVVhU1FQVEpPSE82TFVNU1dpdW1FWXFOSzJ4",
  "ZTFYM2sK8dlyCs+zWBS6Jq+noJ9H9AMYrzhU9E55ypanNEP68m6Agmwpdvkr0/2cshZO6wa42V/xKE00cdr140U=",
]);
