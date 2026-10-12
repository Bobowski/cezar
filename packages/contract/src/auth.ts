import { z } from 'zod';

/**
 * Cockpit authentication (spec `2026-10-12-cockpit-authentication.md`). Workspace-level routes
 * under `/api/v1/auth/*`; every one of them answers 409 on a cockpit where auth is not enforced,
 * except `GET /auth/session`, which is how a cockpit learns that.
 */

/** v1 has one role. The field exists so RBAC is a policy table later, not a migration. */
export const authRoleSchema = z.enum(['owner']);
export type AuthRole = z.infer<typeof authRoleSchema>;

export const AUTH_USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const AUTH_PASSWORD_MIN = 12;

export const authUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: authRoleSchema,
});
export type AuthUser = z.infer<typeof authUserSchema>;

/** The one auth read that needs no session: what a cockpit shows before anything else. */
export const authSessionResponseSchema = z.object({
  /** False on a local cockpit — there is no login and nothing below applies. */
  enforced: z.boolean(),
  authenticated: z.boolean(),
  /** No account exists yet: only the setup flow is served (`cezar auth setup` on the host). */
  setupRequired: z.boolean(),
  user: authUserSchema.optional(),
});
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;

export const authLoginBodySchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
});
export type AuthLoginBody = z.infer<typeof authLoginBodySchema>;

/** Step one only proves the password; the session is issued by `/auth/login/verify`. */
export const authLoginResponseSchema = z.object({ ticket: z.string() });
export type AuthLoginResponse = z.infer<typeof authLoginResponseSchema>;

export const authVerifyBodySchema = z.object({
  ticket: z.string().min(1).max(200),
  /** A 6-digit TOTP code, or a recovery code. */
  code: z.string().min(1).max(64),
});
export type AuthVerifyBody = z.infer<typeof authVerifyBodySchema>;

export const authVerifyResponseSchema = z.object({ user: authUserSchema });
export type AuthVerifyResponse = z.infer<typeof authVerifyResponseSchema>;

export const authSetupBeginBodySchema = z.object({
  /** The one-time code `cezar auth setup` printed on the host. */
  code: z.string().min(1).max(200),
  username: z.string().regex(AUTH_USERNAME_RE, 'lowercase letters, digits, ".", "_" or "-" (max 64)'),
  password: z.string().min(AUTH_PASSWORD_MIN, `at least ${AUTH_PASSWORD_MIN} characters`).max(1024),
});
export type AuthSetupBeginBody = z.infer<typeof authSetupBeginBodySchema>;

export const authSetupBeginResponseSchema = z.object({
  ticket: z.string(),
  /** Base32 TOTP seed, for manual entry. */
  secret: z.string(),
  /** The same seed as an `otpauth://` URI, for a QR code. */
  otpauthUri: z.string(),
});
export type AuthSetupBeginResponse = z.infer<typeof authSetupBeginResponseSchema>;

export const authSetupCompleteBodySchema = z.object({
  ticket: z.string().min(1).max(200),
  code: z.string().min(1).max(16),
});
export type AuthSetupCompleteBody = z.infer<typeof authSetupCompleteBodySchema>;

export const authSetupCompleteResponseSchema = z.object({
  user: authUserSchema,
  /** Shown once. Stored hashed. */
  recoveryCodes: z.array(z.string()),
});
export type AuthSetupCompleteResponse = z.infer<typeof authSetupCompleteResponseSchema>;

export const authDeviceSchema = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  /** The session this request arrived on. */
  current: z.boolean(),
});
export type AuthDevice = z.infer<typeof authDeviceSchema>;

export const authDevicesResponseSchema = z.object({ sessions: z.array(authDeviceSchema) });
export type AuthDevicesResponse = z.infer<typeof authDevicesResponseSchema>;

/** Changing the password needs BOTH current factors, and signs every other device out. */
export const authPasswordBodySchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  code: z.string().min(1).max(16),
  newPassword: z.string().min(AUTH_PASSWORD_MIN, `at least ${AUTH_PASSWORD_MIN} characters`).max(1024),
});
export type AuthPasswordBody = z.infer<typeof authPasswordBodySchema>;

/** A fresh authenticator code, for an action that must not ride on an unattended session. */
export const authConfirmBodySchema = z.object({ code: z.string().min(1).max(16) });
export type AuthConfirmBody = z.infer<typeof authConfirmBodySchema>;

export const authRecoveryCodesResponseSchema = z.object({ recoveryCodes: z.array(z.string()) });
export type AuthRecoveryCodesResponse = z.infer<typeof authRecoveryCodesResponseSchema>;

export const authRevokeOthersResponseSchema = z.object({ revoked: z.number() });
export type AuthRevokeOthersResponse = z.infer<typeof authRevokeOthersResponseSchema>;

export const authOkResponseSchema = z.object({ ok: z.literal(true) });
export type AuthOkResponse = z.infer<typeof authOkResponseSchema>;
