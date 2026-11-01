import { parse, serialize } from 'parse5';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';

const HTML_ATTRIBUTES = new Set(['href', 'src', 'action', 'poster', 'cite', 'formaction', 'srcset']);
const JSON_URL_KEYS = /(?:^|[_-])(url|uri|href|src|link|location|redirect|poster|image|video|action|endpoint)s?$/i;

function pathWithQuery(url) {
  return `${url.pathname}${url.search}${url.hash}`;
}

export class UrlRewriter {
  #maps;
  #publicOrigin;

  constructor({ publicOrigin, upstreamOrigins }) {
    this.#publicOrigin = new URL(publicOrigin).origin;
    this.#maps = new Map();
    for (const entry of upstreamOrigins) {
      const upstream = new URL(entry.upstreamOrigin).origin;
      const mirror = new URL(entry.mirrorOrigin).origin;
      this.#maps.set(upstream, mirror);
      this.#maps.set(upstream.replace(/^http:/, 'ws:'), mirror.replace(/^http:/, 'ws:'));
      this.#maps.set(upstream.replace(/^https:/, 'wss:'), mirror.replace(/^https:/, 'wss:'));
    }
  }

  rewrite(value, baseUrl) {
    if (!value || value.startsWith('#') || value.startsWith('data:') || value.startsWith('mailto:') || value.startsWith('javascript:')) return value;
    let parsed;
    try {
      parsed = new URL(value, baseUrl);
    } catch {
      return value;
    }
    const mirrorOrigin = this.#maps.get(parsed.origin);
    if (!mirrorOrigin) return value;
    const mirror = new URL(pathWithQuery(parsed), mirrorOrigin);
    return mirror.href;
  }

  rewriteLocation(value, upstreamBase) {
    return this.rewrite(value, upstreamBase);
  }

  rewriteHtml(source, baseUrl) {
    const document = parse(source);
    let effectiveBase = baseUrl;
    const walk = (node) => {
      if (node.attrs) {
        const baseAttr = node.nodeName === 'base' ? node.attrs.find((attr) => attr.name === 'href') : null;
        if (baseAttr) {
          try { effectiveBase = new URL(baseAttr.value, baseUrl).href; } catch { /* retain response URL */ }
        }
        for (const attr of node.attrs) {
          if (HTML_ATTRIBUTES.has(attr.name)) attr.value = this.rewrite(attr.value, effectiveBase);
          if (attr.name === 'srcset') attr.value = attr.value.split(',').map((item) => {
            const parts = item.trim().split(/\s+/);
            if (parts[0]) parts[0] = this.rewrite(parts[0], effectiveBase);
            return parts.join(' ');
          }).join(', ');
        }
      }
      for (const child of node.childNodes || []) walk(child);
    };
    walk(document);
    return serialize(document);
  }

  rewriteCss(source, baseUrl) {
    const root = postcss.parse(source);
    const rewriteValue = (value) => {
      const parsed = valueParser(value);
      parsed.walk((item) => {
        if (item.type === 'function' && item.value.toLowerCase() === 'url') {
          const first = item.nodes?.find((part) => part.type === 'word' || part.type === 'string');
          if (first) first.value = this.rewrite(first.value, baseUrl);
        }
      });
      return parsed.toString();
    };
    root.walk((node) => {
      if (typeof node.value === 'string') node.value = rewriteValue(node.value);
      if (node.type === 'atrule' && typeof node.params === 'string') node.params = rewriteValue(node.params);
    });
    return root.toString();
  }

  rewriteJson(source, baseUrl) {
    const walk = (value, key = '') => {
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, walk(child, childKey)]));
      if (typeof value === 'string' && (JSON_URL_KEYS.test(key) || /^https?:\/\//i.test(value) || /^\/\//.test(value))) return this.rewrite(value, baseUrl);
      return value;
    };
    try {
      return JSON.stringify(walk(JSON.parse(source)));
    } catch {
      return source;
    }
  }
}
