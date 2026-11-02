// A tiny router for the API: method + path pattern → handler(ctx, req, res, params, body). No framework.
//
// Patterns are literal paths with two extras:
//   :name  one path segment of [\w-]+ (project ids, approval ids), passed in `params.name`
//   *      at the very end: any rest of the path, including none (a prefix route)
// Routes are tried in the order they were added; the first match wins.
//
// The router only dispatches. Every security decision (Host/Origin, token, laptop-only paths, the WiFi
// read-only allowlist) is made in server.js before a request gets here.

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compiles a pattern into an anchored RegExp with named groups. */
function compile(pattern) {
  const prefix = pattern.endsWith('*');
  const body = prefix ? pattern.slice(0, -1) : pattern;
  const source = body
    .split(/(:[A-Za-z_]\w*)/)
    .map((part) => (part.startsWith(':') ? `(?<${part.slice(1)}>[\\w-]+)` : escapeRegExp(part)))
    .join('');
  return new RegExp(`^${source}${prefix ? '.*' : ''}$`);
}

export class Router {
  /** @type {{ method: string, pattern: string, regex: RegExp, handler: Function, rawBody: boolean }[]} */
  routes = [];

  /**
   * @param {string} method HTTP method
   * @param {string} pattern see the top of this file
   * @param {Function} handler (ctx, req, res, params, body) => any
   * @param {{ rawBody?: boolean }} [options] rawBody: the handler reads the request body itself (not JSON)
   */
  add(method, pattern, handler, { rawBody = false } = {}) {
    this.routes.push({ method, pattern, regex: compile(pattern), handler, rawBody });
    return this;
  }

  post(pattern, handler, options) {
    return this.add('POST', pattern, handler, options);
  }

  /** The first route for this method and path, with its params; null when none matches. */
  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (m) return { route, params: { ...m.groups } };
    }
    return null;
  }
}

/** A concrete path for a pattern (`:name` → `sample`, a trailing `*` → nothing), e.g. for tests. */
export const samplePath = (pattern, sample = 'x') => pattern.replace(/:[A-Za-z_]\w*/g, sample).replace(/\*$/, '');
