import { describe, expect, test } from 'vitest';
import { buildQuery, gpath, graphUrl } from '../../src/graph/path.js';

describe('gpath', () => {
  test('leaves the literal structure alone', () => {
    expect(gpath`me/messages`).toBe('me/messages');
  });

  test('encodes an interpolated id exactly once', () => {
    expect(gpath`me/messages/${'abc123'}`).toBe('me/messages/abc123');
  });

  /**
   * The whole reason this exists. Outlook ids are base64-ish and contain `/` and
   * `+`; splitting a path on `/` tears one id into two segments and Graph 404s an
   * item that plainly exists.
   */
  test('encodes a slash inside an id rather than treating it as a separator', () => {
    const id = 'AAMkAD/gg+h=';
    const path = gpath`me/messages/${id}/attachments`;
    expect(path).toBe('me/messages/AAMkAD%2Fgg%2Bh%3D/attachments');
    // Exactly three separators — the id did not become two segments.
    expect(path.split('/')).toHaveLength(4);
  });

  test('handles every character that needs escaping', () => {
    expect(gpath`x/${'a b&c?d#e'}`).toBe('x/a%20b%26c%3Fd%23e');
  });

  test('does not double-encode across repeated interpolations', () => {
    const decoded = gpath`a/${'p/q'}/b/${'r+s'}`;
    expect(decoded).toBe('a/p%2Fq/b/r%2Bs');
  });

  test('coerces non-strings', () => {
    expect(gpath`top/${42}`).toBe('top/42');
  });
});

describe('buildQuery', () => {
  test('returns empty string for no params', () => {
    expect(buildQuery({})).toBe('');
  });

  test('drops undefined values', () => {
    expect(buildQuery({ a: 'x', b: undefined })).toBe('?a=x');
  });

  test('escapes OData filter values, which routinely contain spaces and quotes', () => {
    const q = buildQuery({ $filter: "from/emailAddress/address eq 'a@b.com'" });
    expect(q).toContain('%27a%40b.com%27');
    expect(q).not.toContain(' ');
  });

  test('serialises numbers and booleans', () => {
    expect(buildQuery({ $top: 50, $count: true })).toBe('?%24top=50&%24count=true');
  });
});

describe('graphUrl', () => {
  test('joins endpoint and path without doubling the slash', () => {
    expect(graphUrl('https://graph.microsoft.com/v1.0/', 'me/messages')).toBe(
      'https://graph.microsoft.com/v1.0/me/messages',
    );
    expect(graphUrl('https://graph.microsoft.com/v1.0', '/me/messages')).toBe(
      'https://graph.microsoft.com/v1.0/me/messages',
    );
  });

  test('appends the query', () => {
    expect(graphUrl('https://g/', 'me', { $top: 5 })).toBe('https://g/me?%24top=5');
  });
});
