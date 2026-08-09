/**
 * The fake must reject the query shapes live Graph rejects, or a green suite
 * proves nothing about live acceptance — a 400 InefficientFilter shipped behind
 * 405 green tests exactly because the fake accepted everything. These tests pin
 * that strictness so it cannot be quietly relaxed.
 */
import { describe, expect, test } from 'vitest';
import { fakeGraph, on } from './fake-graph.js';

describe('messages query-combination rules', () => {
  test('rejects $search with $orderby', async () => {
    const { graph } = fakeGraph(on('COLLECT', 'messages', { items: [], truncated: false }));
    await expect(
      graph.collect('me/messages', { $search: '"x"', $orderby: 'receivedDateTime desc' }),
    ).rejects.toThrow(/\$search combined with \$orderby/);
  });

  test('rejects $search with $filter', async () => {
    const { graph } = fakeGraph(on('COLLECT', 'messages', { items: [], truncated: false }));
    await expect(
      graph.collect('me/messages', { $search: '"x"', $filter: 'isRead eq false' }),
    ).rejects.toThrow(/\$search combined with \$filter/);
  });

  test('rejects orderby property not at start of filter', async () => {
    const { graph } = fakeGraph(on('COLLECT', 'messages', { items: [], truncated: false }));
    await expect(
      graph.collect('me/messages', { $filter: 'isRead eq false', $orderby: 'receivedDateTime desc' }),
    ).rejects.toThrow(/InefficientFilter/);
  });

  test('accepts orderby property leading the filter', async () => {
    const { graph } = fakeGraph(on('COLLECT', 'messages', { items: [], truncated: false }));
    await expect(
      graph.collect('me/messages', {
        $filter: 'receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false',
        $orderby: 'receivedDateTime desc',
      }),
    ).resolves.toEqual({ items: [], truncated: false });
  });

  test('unmatched COLLECT throws', async () => {
    const { graph } = fakeGraph();
    await expect(graph.collect('me/calendars')).rejects.toThrow(
      /no responder matched COLLECT me\/calendars/,
    );
  });
});
