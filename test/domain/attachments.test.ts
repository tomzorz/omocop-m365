import { describe, expect, test } from 'vitest';
import { basename, isAbsolute } from 'node:path';
import {
  checkDownloadSize,
  checkTotalSize,
  chooseTargetPath,
  chunkRanges,
  classifyAttachment,
  contentTypeFor,
  formatSize,
  isImageType,
  MAX_DOWNLOAD_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  needsUploadSession,
  sanitiseFilename,
  SIMPLE_ATTACH_LIMIT,
  UPLOAD_CHUNK_SIZE,
} from '../../src/domain/attachments.js';

describe('classifyAttachment', () => {
  test.each([
    ['#microsoft.graph.fileAttachment', 'file'],
    ['#microsoft.graph.itemAttachment', 'item'],
    ['#microsoft.graph.referenceAttachment', 'reference'],
  ])('%s -> %s', (odata, kind) => {
    expect(classifyAttachment(odata)).toBe(kind);
  });

  test('defaults to file for an absent or unknown type', () => {
    expect(classifyAttachment(undefined)).toBe('file');
    expect(classifyAttachment('#microsoft.graph.somethingNew')).toBe('file');
  });
});

describe('formatSize', () => {
  test('scales units', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatSize(3 * 1024 * 1024 * 1024)).toBe('3.00 GB');
  });

  test('handles absent sizes', () => {
    expect(formatSize(undefined)).toBe('unknown size');
    expect(formatSize(null)).toBe('unknown size');
    expect(formatSize(NaN)).toBe('unknown size');
  });
});

describe('upload routing', () => {
  test('the 3MB boundary is exclusive', () => {
    expect(needsUploadSession(SIMPLE_ATTACH_LIMIT)).toBe(false);
    expect(needsUploadSession(SIMPLE_ATTACH_LIMIT + 1)).toBe(true);
    expect(needsUploadSession(0)).toBe(false);
  });

  test('chunk ranges cover the file exactly, without overlap or gap', () => {
    const total = UPLOAD_CHUNK_SIZE * 2 + 1234;
    const ranges = chunkRanges(total);

    expect(ranges[0]?.start).toBe(0);
    expect(ranges.at(-1)?.end).toBe(total);
    for (let i = 1; i < ranges.length; i += 1) {
      expect(ranges[i]?.start).toBe(ranges[i - 1]?.end);
    }
  });

  test('chunk size is a multiple of 320 KiB, as Graph requires', () => {
    expect(UPLOAD_CHUNK_SIZE % (320 * 1024)).toBe(0);
  });

  test('a file smaller than one chunk is a single range', () => {
    expect(chunkRanges(100)).toEqual([{ start: 0, end: 100 }]);
  });

  test('an empty file produces no ranges', () => {
    expect(chunkRanges(0)).toEqual([]);
  });
});

describe('total size ceiling', () => {
  const file = (size: number) => ({ name: 'f.bin', size });

  test('accepts a set under the ceiling', () => {
    expect(checkTotalSize([file(1024)])).toBeUndefined();
    expect(checkTotalSize([file(MAX_TOTAL_ATTACHMENT_BYTES)])).toBeUndefined();
  });

  test('rejects a set over it, with sizes named', () => {
    const message = checkTotalSize([file(MAX_TOTAL_ATTACHMENT_BYTES + 1)]);
    expect(message).toContain('over the 25.0 MB');
  });

  test('counts what is already attached', () => {
    const half = Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / 2);
    expect(checkTotalSize([file(half)])).toBeUndefined();

    const message = checkTotalSize([file(half)], half + 4096);
    expect(message).toContain('already attached');
    expect(message).toContain('being added');
  });

  test('sums several files', () => {
    const third = Math.ceil(MAX_TOTAL_ATTACHMENT_BYTES / 3) + 1;
    expect(checkTotalSize([file(third), file(third), file(third)])).toBeDefined();
  });
});

describe('download ceiling', () => {
  test('permits an unknown or reasonable size', () => {
    expect(checkDownloadSize('a.pdf', undefined)).toBeUndefined();
    expect(checkDownloadSize('a.pdf', 1024)).toBeUndefined();
  });

  test('refuses something that would not fit in memory', () => {
    const message = checkDownloadSize('huge.iso', MAX_DOWNLOAD_BYTES + 1);
    expect(message).toContain('huge.iso');
    expect(message).toContain('150.0 MB');
  });
});

describe('content types', () => {
  test('maps known extensions, case-insensitively', () => {
    expect(contentTypeFor('/tmp/a.pdf')).toBe('application/pdf');
    expect(contentTypeFor('C:/x/PHOTO.JPG')).toBe('image/jpeg');
    expect(contentTypeFor('sheet.xlsx'))
      .toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  test('falls back for anything unrecognised', () => {
    expect(contentTypeFor('a.qqq')).toBe('application/octet-stream');
    expect(contentTypeFor('noextension')).toBe('application/octet-stream');
  });

  test('identifies image types', () => {
    expect(isImageType('image/png')).toBe(true);
    expect(isImageType('IMAGE/JPEG')).toBe(true);
    expect(isImageType('application/pdf')).toBe(false);
    expect(isImageType(undefined)).toBe(false);
  });
});

describe('sanitiseFilename', () => {
  /** The name comes from whoever sent the message. */
  test('discards any directory part, defeating traversal', () => {
    expect(sanitiseFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitiseFilename('..\\..\\windows\\system32\\x.dll')).toBe('x.dll');
    expect(sanitiseFilename('/absolute/path/report.pdf')).toBe('report.pdf');
  });

  test('replaces characters Windows rejects', () => {
    expect(sanitiseFilename('in<va>lid:name?.txt')).toBe('in_va_lid_name_.txt');
  });

  test('keeps spaces and hyphens, which are ordinary', () => {
    expect(sanitiseFilename('Q3 report - final.pdf')).toBe('Q3 report - final.pdf');
  });

  test('falls back for names that reduce to nothing', () => {
    expect(sanitiseFilename('..')).toBe('attachment');
    expect(sanitiseFilename('/')).toBe('attachment');
    expect(sanitiseFilename('   ')).toBe('attachment');
  });
});

describe('chooseTargetPath', () => {
  test('an explicit file path is used as given', () => {
    const { path } = chooseTargetPath('/downloads/renamed.pdf', 'original.pdf', false);
    expect(basename(path)).toBe('renamed.pdf');
    expect(isAbsolute(path)).toBe(true);
  });

  test('an existing directory takes the attachment name', () => {
    const { path } = chooseTargetPath('/downloads', 'invoice.pdf', true);
    expect(basename(path)).toBe('invoice.pdf');
  });

  test('a trailing separator means a directory even if it does not exist yet', () => {
    expect(basename(chooseTargetPath('/downloads/new/', 'a.pdf', false).path)).toBe('a.pdf');
  });

  test('the attachment name is sanitised before being joined', () => {
    const { path } = chooseTargetPath('/downloads', '../../escape.pdf', true);
    expect(basename(path)).toBe('escape.pdf');
    expect(path).not.toContain('..');
  });

  test('reports the parent so it can be created', () => {
    const { path, parent } = chooseTargetPath('/a/b/c.pdf', 'x.pdf', false);
    expect(path.startsWith(parent)).toBe(true);
    expect(basename(parent)).toBe('b');
  });
});
