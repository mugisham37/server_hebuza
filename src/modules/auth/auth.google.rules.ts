// Google sign-in decision logic, kept free of Nest/DB so it is unit-tested with a local jose keypair (auth.google.test.ts).
import { jwtVerify, type JWTVerifyGetKey } from "jose";
import { normalizeRoles } from "@/domain/auth/roles";

export const OAUTH_ERRORS = [
  "cancelled",
  "state_invalid",
  "email_unverified",
  "not_allowed",
  "disabled",
  "already_linked",
  "failed",
] as const;
export type OAuthCode = (typeof OAUTH_ERRORS)[number];
export class OAuthErr extends Error {
  constructor(
    readonly code: OAuthCode,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

export type Intent = "login" | "signup" | "link";
export type OAuthState = {
  codeVerifier: string;
  nonce: string;
  intent: Intent;
  next: string | null;
  lang: string;
  linkUserId?: string;
};
export type GoogleClaims = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
};

export const GOOGLE_ISSUERS = [
  "accounts.google.com",
  "https://accounts.google.com",
];

/** Same-site path only: "/x" yes, "//evil" / "/\\evil" / absolute URLs no. */
export const safeNext = (n: unknown) =>
  typeof n === "string" &&
  n.startsWith("/") &&
  !n.startsWith("//") &&
  !n.startsWith("/\\") &&
  n.length <= 512
    ? n
    : null;

/** One-time state: GETDEL, so a replayed callback finds nothing. */
export async function consumeState(
  redis: { getdel(k: string): Promise<string | null> },
  key: string | null,
) {
  const raw = key ? await redis.getdel(key) : null;
  if (!raw) throw new OAuthErr("state_invalid");
  return JSON.parse(raw) as OAuthState;
}

export async function verifyIdToken(
  token: string,
  keys: JWTVerifyGetKey,
  clientId: string,
  nonce: string,
): Promise<GoogleClaims> {
  let p;
  try {
    ({ payload: p } = await jwtVerify(token, keys, {
      issuer: GOOGLE_ISSUERS,
      audience: clientId,
      clockTolerance: 30,
    }));
  } catch (e) {
    throw new OAuthErr("failed", (e as Error).message);
  }
  if (p.nonce !== nonce) throw new OAuthErr("failed", "nonce mismatch");
  if (typeof p.sub !== "string" || typeof p.email !== "string")
    throw new OAuthErr("failed", "missing claims");
  const verified = p.email_verified === true || p.email_verified === "true";
  if (!verified) throw new OAuthErr("email_unverified");
  return {
    sub: p.sub,
    email: p.email.toLowerCase(),
    emailVerified: true,
    name: typeof p.name === "string" ? p.name : undefined,
  };
}

type Cand = { userId: string; role: string; isEmailVerified: boolean };
export type Decision =
  | { kind: "user"; userId: string; link: boolean }
  | { kind: "create" }
  | { kind: "link_required"; userId: string };

/** identity hit → that user; one same-email account → link (verified) or link_required; none → create. */
export function decide(
  identityUserId: string | null,
  sameEmail: Cand[],
): Decision {
  if (identityUserId)
    return { kind: "user", userId: identityUserId, link: false };
  const open = sameEmail.filter(
    (u) => u.role === "client" || u.role === "partner",
  );
  const pool = open.length ? open : sameEmail;
  // shortcut: an email on several accounts (client + partner) is refused, not chosen; add an account picker if it happens.
  if (pool.length > 1) throw new OAuthErr("not_allowed", "ambiguous email");
  const u = pool[0];
  if (!u) return { kind: "create" };
  return u.isEmailVerified
    ? { kind: "user", userId: u.userId, link: true }
    : { kind: "link_required", userId: u.userId };
}

/** auth.google_roles = comma-separated roles (empty = nobody). */
export const parseRoles = (v: unknown) =>
  String(v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export function gate(
  u: { isActive: boolean; role: string },
  allowed: string[],
): OAuthCode | null {
  if (!u.isActive) return "disabled";
  return allowed.includes(u.role) ||
    normalizeRoles({ role: u.role }).some((r) => allowed.includes(r))
    ? null
    : "not_allowed";
}

/** Where a successful Google sign-in lands: the 2FA step (pre_2fa cookie set) or the target page. */
export const landing = (web: string, lang: string, next: string, mfaRequired?: boolean) =>
  `${web}/${lang}${mfaRequired ? `/login/2fa?next=${encodeURIComponent(next)}` : next}`;
