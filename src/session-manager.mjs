import crypto from 'node:crypto';
import { CookieJar } from 'tough-cookie';

function parseMirrorSession(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    const key = pair.slice(0, index).trim();
    if (key === name) return pair.slice(index + 1).trim();
  }
  return null;
}

function createId() {
  return crypto.randomBytes(32).toString('base64url');
}

export class SessionManager {
  #sessions = new Map();
  #cookieName;
  #ttlMs;
  #secure;

  constructor({ cookieName = 'mirror_sid', ttlMs = 24 * 60 * 60 * 1000, secure = true } = {}) {
    this.#cookieName = cookieName;
    this.#ttlMs = ttlMs;
    this.#secure = secure;
  }

  get cookieName() {
    return this.#cookieName;
  }

  #newSession() {
    const id = createId();
    const session = { id, jars: new Map(), createdAt: Date.now(), touchedAt: Date.now() };
    this.#sessions.set(id, session);
    return session;
  }

  #live(id) {
    const session = id && this.#sessions.get(id);
    if (!session) return null;
    if (Date.now() - session.touchedAt > this.#ttlMs) {
      this.#sessions.delete(id);
      return null;
    }
    session.touchedAt = Date.now();
    return session;
  }

  getOrCreate(cookieHeader) {
    const suppliedId = parseMirrorSession(cookieHeader, this.#cookieName);
    const existing = this.#live(suppliedId);
    return { session: existing || this.#newSession(), isNew: !existing };
  }

  #jar(session, upstreamOrigin) {
    let jar = session.jars.get(upstreamOrigin);
    if (!jar) {
      jar = new CookieJar();
      session.jars.set(upstreamOrigin, jar);
    }
    return jar;
  }

  async getUpstreamCookie(session, upstreamUrl) {
    const origin = new URL(upstreamUrl).origin;
    return this.#jar(session, origin).getCookieString(upstreamUrl);
  }

  browserCookiesForPassthrough(cookieHeader) {
    if (!cookieHeader) return '';
    return cookieHeader.split(';').map(part => part.trim()).filter(part => {
      const key = part.split('=', 1)[0].trim();
      return key && key !== this.#cookieName;
    }).join('; ');
  }

  async receiveSetCookies(session, upstreamUrl, setCookies) {
    const summary = { received: Array.isArray(setCookies) ? setCookies.length : 0, stored: 0, rejected: 0, forwarded: false };
    if (!Array.isArray(setCookies) || setCookies.length === 0) return summary;
    const origin = new URL(upstreamUrl).origin;
    const jar = this.#jar(session, origin);
    for (const value of setCookies) {
      try {
        await jar.setCookie(value, upstreamUrl);
        summary.stored++;
      } catch {
        // Invalid or cross-domain upstream cookies are rejected by design.
        summary.rejected++;
      }
    }
    return summary;
  }

  destroy(id) {
    if (id) this.#sessions.delete(id);
  }

  clearCookieHeader() {
    const secure = this.#secure ? '; Secure' : '';
    return `${this.#cookieName}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`;
  }

  browserCookie(session) {
    const secure = this.#secure ? '; Secure' : '';
    return `${this.#cookieName}=${session.id}; Max-Age=${Math.floor(this.#ttlMs / 1000)}; Path=/; HttpOnly; SameSite=Lax${secure}`;
  }

  size() {
    return this.#sessions.size;
  }

  inspect(id) {
    const session = this.#live(id);
    if (!session) return null;
    return { createdAt: session.createdAt, touchedAt: session.touchedAt, upstreamOrigins: [...session.jars.keys()] };
  }
}
