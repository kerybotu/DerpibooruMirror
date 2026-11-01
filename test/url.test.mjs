import test from 'node:test';
import assert from 'node:assert/strict';
import { UrlRewriter } from '../src/url-rewriter.mjs';

const rewriter = new UrlRewriter({ publicOrigin: 'https://mirror.test', upstreamOrigins: [
  { upstreamOrigin: 'https://upstream.test', mirrorOrigin: 'https://mirror.test' },
  { upstreamOrigin: 'https://media.test', mirrorOrigin: 'https://media.mirror.test' },
] });

test('URL mapping parses absolute, relative, protocol-relative and websocket URLs', () => {
  assert.equal(rewriter.rewrite('/a?q=x%20y#h', 'https://upstream.test/base'), 'https://mirror.test/a?q=x%20y#h');
  assert.equal(rewriter.rewrite('//media.test/video.mp4', 'https://upstream.test/'), 'https://media.mirror.test/video.mp4');
  assert.equal(rewriter.rewrite('wss://upstream.test/ws', 'https://upstream.test/'), 'wss://mirror.test/ws');
  assert.equal(rewriter.rewrite('https://external.test/', 'https://upstream.test/'), 'https://external.test/');
  assert.equal(rewriter.rewrite('https://mirror.test/a', 'https://upstream.test/'), 'https://mirror.test/a');
});

test('HTML and JSON rewrite only known upstream URLs', () => {
  const html = rewriter.rewriteHtml('<a href="/a">a</a><img src="https://media.test/x.png"><form action="/submit"></form>', 'https://upstream.test/');
  assert.ok(html.includes('https://mirror.test/a'));
  assert.ok(html.includes('https://media.mirror.test/x.png'));
  assert.ok(html.includes('https://mirror.test/submit'));
  const json = JSON.parse(rewriter.rewriteJson('{"url":"https://media.test/x","text":"hello"}', 'https://upstream.test/'));
  assert.equal(json.url, 'https://media.mirror.test/x');
  assert.equal(json.text, 'https://mirror.test/hello');
});

test('CSS url functions are parsed and rewritten', () => {
  const css = rewriter.rewriteCss('a{background:url("https://media.test/x.png")}', 'https://upstream.test/style.css');
  assert.ok(css.includes('https://media.mirror.test/x.png'));
});
