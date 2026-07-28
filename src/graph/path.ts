/**
 * Graph resource paths.
 *
 * The obvious implementation — take a path string and `encodeURIComponent` each
 * `/`-separated segment — is wrong, and wrong in a way that is invisible until a
 * particular id shows up. Outlook ids are base64-ish and can contain `/`, so
 * splitting on `/` tears one id into two path segments and Graph answers 404 for
 * an item that plainly exists.
 *
 * Rather than fix that carefully, make it unrepresentable: paths are built with a
 * tagged template where the literal parts are trusted structure and every
 * interpolated value is encoded exactly once. The same shape as a parameterised
 * SQL query, for the same reason.
 *
 *     gpath`me/messages/${messageId}/attachments`
 *
 * A caller cannot accidentally pass an unencoded id, because the only way to get
 * a value in is through an interpolation.
 */

/** Builds a Graph path, encoding every interpolated value. */
export function gpath(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = '';
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i] ?? '';
    if (i < values.length) {
      out += encodeURIComponent(String(values[i]));
    }
  }
  return out;
}

/** Query parameter values Graph accepts. */
export type QueryValue = string | number | boolean | undefined;

/**
 * Serialises OData query parameters.
 *
 * `URLSearchParams` is correct here and the hand-rolled alternative is not:
 * `$filter` values routinely contain spaces, quotes and slashes, and building
 * the string by concatenation is how those end up unescaped.
 */
export function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.append(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

/** Joins the endpoint, path and query into an absolute URL. */
export function graphUrl(
  endpoint: string,
  path: string,
  params: Record<string, QueryValue> = {},
): string {
  const base = endpoint.endsWith('/') ? endpoint : `${endpoint}/`;
  const relative = path.startsWith('/') ? path.slice(1) : path;
  return `${base}${relative}${buildQuery(params)}`;
}
