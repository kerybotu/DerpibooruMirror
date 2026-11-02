# Mirror Engine PoC

This is an isolated development module for the Derpibooru mirror. It has no production configuration and does not expose an arbitrary upstream target.

The engine uses `http-proxy@1.18.1` for low-level HTTP/HTTPS and WebSocket transport because the response lifecycle must be controlled to store upstream cookies server-side. `tough-cookie@6.0.0` provides the upstream CookieJar implementation. `parse5`, `postcss`, and `postcss-value-parser` are used only for bounded HTML/CSS/JSON rewriting.

## Gateway boundary

`ClientGateway` and `UpstreamGateway` are the application boundary. `ClientGateway` fixes the browser-facing origin and route; it never accepts a target URL from the request. `UpstreamGateway` owns the fixed upstream origin and delegates transport to `ProxyEngine`, which keeps TLS verification enabled. Both receive the same `createRequestContext()` object. The context records client and upstream origins, both status codes, redirect observations, cookie processing counts, response stage, and whether the path is an Anubis/edge challenge path.

Challenge paths (`/.within.website/` and `/cdn-cgi/challenge-platform/`) must be configured as `preservePaths`/`passthroughPaths` when the upstream protocol requires browser-visible challenge cookies or redirects. The engine does not manufacture a challenge result or rewrite a challenge token. The gateway test only checks complete, opaque forwarding against a local test upstream; it is not a claim of Derpibooru or Cloudflare compatibility.

Attach `upstreamGateway.engine.on('upstream-response', logger.upstreamResponse)` and `clientGateway.on('client-response', logger.response)` to record the two statuses separately. The corresponding request event is `client-request`; sensitive headers and Cookie values are never included in these diagnostic event payloads.

## Boundaries

- A validated `RoutePolicy` supplies the fixed upstream target. User input never chooses a target URL.
- Browser cookies contain only an opaque, random mirror session ID.
- Each session has a separate `CookieJar` per upstream origin.
- Upstream `Set-Cookie` headers are consumed by the session manager and are not forwarded to the browser.
- Media, Range, WebSocket, and responses over the rewrite limit stay streaming.
- The engine keeps upstream status and headers in `engine.getContext(req).upstreamResponse` for response modules; diagnostic events expose status and header names only.
- Upstream TLS verification remains enabled (`secure: true`).

## Local verification

```powershell
npm ci
npm test
npm run test:coverage
```

The tests use only a local self-built upstream. They do not simulate or bypass Anubis, Cloudflare, or any third-party authentication challenge.

Attach `createDiagnosticLogger()` to the `request`, `response`, and `error-classified` events at the application boundary. The logger redacts sensitive query fields and never serializes Cookie or Authorization headers. Do not write `getContext(req).upstreamResponse.headers` to ordinary logs.
