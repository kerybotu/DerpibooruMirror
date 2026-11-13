import { AnubisCompatibilityBridge } from '../../anubis-bridge.mjs';
import { validatePassChallenge } from './challenge.mjs';
import { validateCookieName } from './cookie-policy.mjs';
import { validateRedirectText } from './redirect-policy.mjs';

export class Anubis127Adapter {
  #transport;
  #clientOrigin;
  #cookiePrefix;

  constructor(options) {
    if (options?.supportedVersion !== '1.27.0') throw new Error('unsupported Anubis version for v1.27.0 adapter');
    // Reuse only the contract-tested transformations. Leave the validated
    // v1.28.2 class byte-for-byte intact; version policy lives in this wrapper.
    this.#transport = new AnubisCompatibilityBridge(options);
    this.#clientOrigin = new URL(options.clientOrigin).origin;
    this.#cookiePrefix = options.cookiePrefix || 'techaro.lol-anubis';
  }

  observeChallengeHtml(session, contentType, body) {
    return this.#transport.observeChallengeHtml(session, contentType, body);
  }

  isPassChallengeRequest(url) {
    return this.#transport.isPassChallengeRequest(url);
  }

  mapClientRequest(url, session, method = 'GET') {
    if (!this.isPassChallengeRequest(url)) return url;
    if (session?.anubisVersion !== '1.27.0') throw new Error('unsupported Anubis version for PassChallenge mapping');
    const parameters = new URL(url, this.#clientOrigin).searchParams;
    validatePassChallenge(parameters, method);
    validateRedirectText(parameters.get('redir'), 'redir');
    return this.#transport.mapClientRequest(url, session);
  }

  mapUpstreamLocation(location, url, statusCode) {
    if (this.isPassChallengeRequest(url) && statusCode >= 300 && statusCode < 400 && location) {
      if (statusCode !== 302) throw new Error('v1.27.0 PassChallenge expected HTTP 302');
      validateRedirectText(location, 'Location redirect');
    }
    return this.#transport.mapUpstreamLocation(location, url, statusCode);
  }

  processSetCookie(value, session) {
    validateCookieName(value, this.#cookiePrefix);
    return this.#transport.processSetCookie(value, session);
  }
}
