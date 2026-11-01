import { parse, serialize } from 'parse5';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';

const HTML_ATTRIBUTES = new Set(['href', 'src', 'action', 'poster', 'cite', 'formaction', 'srcset']);

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
    const walk = (node) => {
      if (node.attrs) {
        for (const attr of node.attrs) {
          if (HTML_ATTRIBUTES.has(attr.name)) attr.value = this.rewrite(attr.value, baseUrl);
          if (attr.name === 'srcset') attr.value = attr.value.split(',').map((item) => {
            const parts = item.trim().split(/\s+/);
            if (parts[0]) parts[0] = this.rewrite(parts[0], baseUrl);
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
    root.walk((node) => {
      if (typeof node.value !== 'string') return;
      const parsed = valueParser(node.value);
      parsed.walk((item) => {
        if (item.type === 'function' && item.value.toLowerCase() === 'url') {
          const first = item.nodes?.find((part) => part.type === 'word' || part.type === 'string');
          if (first) first.value = this.rewrite(first.value, baseUrl);
        }
      });
      node.value = parsed.toString();
    });
    return root.toString();
  }

  rewriteJson(source, baseUrl) {
    const walk = (value) => {
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]));
      if (typeof value === 'string') return this.rewrite(value, baseUrl);
      return value;
    };
    try {
      return JSON.stringify(walk(JSON.parse(source)));
    } catch {
      return source;
    }
  }
}
