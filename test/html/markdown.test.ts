import { describe, expect, test } from 'vitest';
import { bodyToMarkdown, htmlToMarkdown, textToMarkdown } from '../../src/html/markdown.js';

describe('structure', () => {
  test('keeps headings, lists and emphasis', () => {
    const { markdown } = htmlToMarkdown(
      '<h1>Title</h1><p>Some <strong>bold</strong> and <em>italic</em>.</p><ul><li>one</li><li>two</li></ul>',
    );
    expect(markdown).toContain('# Title');
    expect(markdown).toContain('**bold**');
    expect(markdown).toContain('*italic*');
    // Turndown pads list markers so nested content lines up; assert the item,
    // not the exact spacing.
    expect(markdown).toMatch(/^-\s+one$/m);
    expect(markdown).toMatch(/^-\s+two$/m);
  });

  /** The most useful thing Markdown preserves: where a link actually goes. */
  test('keeps links with their destination', () => {
    const { markdown } = htmlToMarkdown('<a href="https://contoso.example/x">click here</a>');
    expect(markdown).toBe('[click here](https://contoso.example/x)');
  });

  test('a link whose text differs from its destination shows both', () => {
    const { markdown } = htmlToMarkdown(
      '<a href="https://evil.example/phish">https://bank.example</a>',
    );
    expect(markdown).toContain('https://bank.example');
    expect(markdown).toContain('https://evil.example/phish');
  });

  test('decodes entities', () => {
    expect(htmlToMarkdown('<p>Caf&eacute; &amp; bar &mdash; 5 &lt; 10</p>').markdown)
      .toBe('Café & bar — 5 < 10');
  });
});

describe('noise', () => {
  test('drops stylesheet and script contents', () => {
    const { markdown } = htmlToMarkdown(
      '<style>.x{color:red}</style><script>alert(1)</script><p>Real text</p>',
    );
    expect(markdown).toBe('Real text');
  });

  test('flattens layout tables without emitting their markup', () => {
    const { markdown } = htmlToMarkdown(
      '<table><tr><td><p>Hello</p></td><td><p>World</p></td></tr></table>',
    );
    expect(markdown).toContain('Hello');
    expect(markdown).toContain('World');
    expect(markdown).not.toContain('<td');
  });

  test('strips preheader padding characters', () => {
    const padding = '​‌‍⁠﻿­​';
    expect(htmlToMarkdown(`<p>Preview text${padding} done</p>`).markdown)
      .toBe('Preview text done');
  });

  test('collapses runs of blank lines', () => {
    const { markdown } = htmlToMarkdown('<p>a</p><br><br><br><br><p>b</p>');
    expect(markdown).not.toMatch(/\n{3,}/);
  });

  test('trims surrounding whitespace', () => {
    expect(htmlToMarkdown('   <p>x</p>   ').markdown).toBe('x');
  });
});

describe('images', () => {
  test('keeps an image and records it', () => {
    const { markdown, images } = htmlToMarkdown(
      '<p>See:</p><img src="https://example.test/a.png" alt="a chart">',
    );
    expect(markdown).toContain('![a chart](https://example.test/a.png)');
    expect(images).toEqual([{ src: 'https://example.test/a.png', alt: 'a chart' }]);
  });

  /** Inline images are referenced by cid: and match an attachment's contentId. */
  test('extracts the content id from a cid reference', () => {
    const { images } = htmlToMarkdown('<img src="cid:logo@contoso" alt="logo">');
    expect(images).toEqual([{ src: 'cid:logo@contoso', alt: 'logo', contentId: 'logo@contoso' }]);
  });

  test('handles a missing alt', () => {
    const { markdown, images } = htmlToMarkdown('<img src="cid:x">');
    expect(markdown).toBe('![](cid:x)');
    expect(images[0]?.alt).toBe('');
  });

  test('records images in document order', () => {
    const { images } = htmlToMarkdown(
      '<img src="cid:one"><p>text</p><img src="cid:two"><img src="cid:three">',
    );
    expect(images.map((i) => i.contentId)).toEqual(['one', 'two', 'three']);
  });

  test('ignores an image with no src', () => {
    const { markdown, images } = htmlToMarkdown('<img alt="broken">');
    expect(markdown).toBe('');
    expect(images).toEqual([]);
  });

  test('keeps a data URI intact', () => {
    const uri = 'data:image/png;base64,iVBORw0KGgo=';
    const { images } = htmlToMarkdown(`<img src="${uri}">`);
    expect(images[0]?.src).toBe(uri);
    expect(images[0]?.contentId).toBeUndefined();
  });
});

describe('robustness', () => {
  test('an empty body converts to empty', () => {
    expect(htmlToMarkdown('').markdown).toBe('');
    expect(htmlToMarkdown('   ').markdown).toBe('');
  });

  test('malformed markup does not throw', () => {
    expect(() => htmlToMarkdown('<div><p>unclosed <b>bold</div></p>')).not.toThrow();
    expect(htmlToMarkdown('<div><p>unclosed <b>bold</div></p>').markdown).toContain('unclosed');
  });

  test('a real-world nested layout table survives', () => {
    const html = `
      <table cellpadding="0"><tbody><tr><td>
        <table><tbody><tr><td style="font-family:Arial">
          <h2>Your receipt</h2>
          <p>Total: <strong>&euro;42.00</strong></p>
          <a href="https://example.test/r/1">View online</a>
        </td></tr></tbody></table>
      </td></tr></tbody></table>`;
    const { markdown } = htmlToMarkdown(html);
    expect(markdown).toContain('## Your receipt');
    expect(markdown).toContain('**€42.00**');
    expect(markdown).toContain('[View online](https://example.test/r/1)');
  });
});

describe('plain text bodies', () => {
  test('pass through tidied', () => {
    expect(textToMarkdown('  hello\n\n\n\nworld  ').markdown).toBe('hello\n\nworld');
    expect(textToMarkdown('').images).toEqual([]);
  });
});

describe('bodyToMarkdown', () => {
  test('routes on the Graph content type', () => {
    expect(bodyToMarkdown('<b>x</b>', 'html').markdown).toBe('**x**');
    expect(bodyToMarkdown('<b>x</b>', 'text').markdown).toBe('<b>x</b>');
    expect(bodyToMarkdown('<b>x</b>', 'HTML').markdown).toBe('**x**');
  });

  test('tolerates a missing body or content type', () => {
    expect(bodyToMarkdown(undefined, undefined).markdown).toBe('');
    expect(bodyToMarkdown('plain', undefined).markdown).toBe('plain');
  });
});
