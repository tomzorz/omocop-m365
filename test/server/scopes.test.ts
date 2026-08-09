import { describe, expect, test } from 'vitest';
import {
  expandGranted,
  missingScopes,
  normaliseScope,
  ungrantedMessage,
} from '../../src/server/scopes.js';

describe('normaliseScope', () => {
  test('lowercases and trims', () => {
    expect(normaliseScope('  Mail.ReadWrite ')).toBe('mail.readwrite');
  });

  test('strips the fully-qualified Graph prefix, which Graph sometimes returns', () => {
    expect(normaliseScope('https://graph.microsoft.com/Mail.Read')).toBe('mail.read');
    expect(normaliseScope('HTTPS://GRAPH.MICROSOFT.COM/Mail.Read')).toBe('mail.read');
  });
});

describe('expandGranted', () => {
  test('ReadWrite covers Read', () => {
    const covered = expandGranted(['Mail.ReadWrite']);
    expect(covered.has('mail.read')).toBe(true);
    expect(covered.has('mail.readwrite')).toBe(true);
  });

  test('ReadWrite.All covers the narrower forms', () => {
    const covered = expandGranted(['Files.ReadWrite.All']);
    expect([...covered].sort()).toEqual([
      'files.read',
      'files.read.all',
      'files.readwrite',
      'files.readwrite.all',
    ]);
  });

  test('Read.All covers Read', () => {
    const covered = expandGranted(['Directory.Read.All']);
    expect([...covered].sort()).toEqual(['directory.read', 'directory.read.all']);
  });

  test('Read does not confer ReadWrite', () => {
    expect(expandGranted(['Mail.Read']).has('mail.readwrite')).toBe(false);
  });

  test('Read.All does not confer ReadWrite or ReadWrite.All', () => {
    const covered = expandGranted(['Files.Read.All']);
    expect(covered.has('files.readwrite')).toBe(false);
    expect(covered.has('files.readwrite.all')).toBe(false);
  });

  test('ReadWrite does not confer the .All forms', () => {
    const covered = expandGranted(['Files.ReadWrite']);
    expect(covered.has('files.readwrite.all')).toBe(false);
    expect(covered.has('files.read.all')).toBe(false);
  });

  test('expansion adds nothing beyond the implication chain', () => {
    // Guards against double-expansion: each granted scope matches exactly one
    // suffix branch, so the covered set is exactly the chain, no more.
    expect([...expandGranted(['Mail.ReadWrite', 'Mail.ReadWrite'])].sort()).toEqual([
      'mail.read',
      'mail.readwrite',
    ]);
  });
});

describe('missingScopes', () => {
  test('nothing missing when the exact scope is granted', () => {
    expect(missingScopes(['Mail.Send'], ['Mail.Send'])).toEqual([]);
  });

  test('nothing missing when a wider scope is granted', () => {
    expect(missingScopes(['Calendars.Read'], ['Calendars.ReadWrite'])).toEqual([]);
  });

  test('reports what is absent, in its declared form', () => {
    expect(
      missingScopes(['Mail.Read', 'MailboxSettings.ReadWrite'], ['Mail.ReadWrite']),
    ).toEqual(['MailboxSettings.ReadWrite']);
  });

  /** Sending is a distinct Graph permission; read-write over a mailbox does not confer it. */
  test('Mail.ReadWrite does not imply Mail.Send', () => {
    expect(missingScopes(['Mail.Send'], ['Mail.ReadWrite'])).toEqual(['Mail.Send']);
  });

  test('is case- and prefix-insensitive on both sides', () => {
    expect(missingScopes(['mail.read'], ['https://graph.microsoft.com/Mail.ReadWrite']))
      .toEqual([]);
  });

  test('a tool needing nothing is always satisfied', () => {
    expect(missingScopes([], [])).toEqual([]);
  });
});

describe('ungrantedMessage', () => {
  test('names the tool, the scopes, and says nothing was sent', () => {
    const message = ungrantedMessage('list-rules', ['MailboxSettings.ReadWrite']);
    expect(message).toContain('list-rules');
    expect(message).toContain('"MailboxSettings.ReadWrite"');
    expect(message).toContain('Nothing was sent to Microsoft Graph');
  });

  test('pluralises', () => {
    expect(ungrantedMessage('t', ['A'])).toContain('needs a scope');
    expect(ungrantedMessage('t', ['A', 'B'])).toContain('needs scopes');
  });
});
