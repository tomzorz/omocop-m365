import { describe, expect, test } from 'vitest';
import { describeGraphError, GraphError, parseGraphError } from '../../src/graph/errors.js';

describe('describeGraphError', () => {
  /**
   * A bare 500 or 502 can arrive with an empty body — a proxy timeout, say.
   * The tool must still return something naming the failed request, not an
   * empty string.
   */
  test('an empty-body error still produces text naming the request', () => {
    const error = parseGraphError(502, '', 'GET', 'me/messages');
    const text = describeGraphError(error);
    expect(text.trim()).not.toBe('');
    expect(text).toContain('GET me/messages');
    expect(text).toContain('502');
  });

  test('a whitespace-only Graph message falls back the same way', () => {
    const error = new GraphError(500, '', '   ', undefined, 'POST', 'me/sendMail');
    const text = describeGraphError(error);
    expect(text.trim()).not.toBe('');
    expect(text).toContain('POST me/sendMail');
  });

  test("Graph's own message is preferred when it exists", () => {
    const error = new GraphError(400, 'ErrorX', 'Graph said this.', undefined, 'GET', 'me/messages');
    expect(describeGraphError(error)).toContain('Graph said this.');
  });

  /**
   * Graph delivers MailboxNotEnabledForRESTAPI with HTTP 404, so the code
   * check has to answer before the generic 404 guidance about id containers.
   */
  test('a 404 with MailboxNotEnabledForRESTAPI gets the mailbox guidance', () => {
    const error = new GraphError(
      404,
      'MailboxNotEnabledForRESTAPI',
      'The mailbox is either inactive, soft-deleted, or is hosted on-premise.',
      undefined,
      'GET',
      'me/messages',
    );
    const text = describeGraphError(error);
    expect(text).toContain('not a mailbox-enabled');
    expect(text).not.toContain('same container it was listed from');
  });

  test('a plain 404 keeps the id-container guidance', () => {
    const error = new GraphError(404, 'ErrorItemNotFound', 'Not found.', undefined, 'GET', 'me/events/1');
    expect(describeGraphError(error)).toContain('same container it was listed from');
  });

  test('the request id is appended when Graph supplied one', () => {
    const error = new GraphError(404, '', 'Not found.', 'req-42', 'GET', 'me/events/1');
    expect(describeGraphError(error)).toContain('Graph request id: req-42');
  });

  test('no request id, no correlation line', () => {
    const error = new GraphError(404, '', 'Not found.', undefined, 'GET', 'me/events/1');
    expect(describeGraphError(error)).not.toContain('Graph request id');
  });
});
