import { createHmac, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

export const SESSION_COOKIE = 'rf_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000; // 7 дней

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  googleId: string;
  name?: string;
}

let oauthClient: OAuth2Client | undefined;

/** Проверяет Google ID-token (из кнопки «Sign in with Google»). null, если невалиден. */
export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string,
): Promise<GoogleIdentity | null> {
  if (!oauthClient) oauthClient = new OAuth2Client();
  try {
    const ticket = await oauthClient.verifyIdToken({ idToken, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload || !payload.email || !payload.sub) return null;
    return {
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified === true,
      googleId: payload.sub,
      name: payload.name,
    };
  } catch {
    return null;
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Подписанный сессионный токен: base64url(payload).base64url(hmac). */
export function signSession(userId: string, secret: string): string {
  const payload = JSON.stringify({ uid: userId, exp: Date.now() + SESSION_TTL_MS });
  const body = b64url(payload);
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(token: string, secret: string): { uid: string } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = b64url(createHmac('sha256', secret).update(body).digest());
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      uid?: unknown;
      exp?: unknown;
    };
    if (typeof payload.uid !== 'string') return null;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return { uid: payload.uid };
  } catch {
    return null;
  }
}

/** Достаёт значение cookie по имени из заголовка Cookie. */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}
