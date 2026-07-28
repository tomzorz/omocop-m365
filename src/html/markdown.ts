/**
 * Email bodies as Markdown.
 *
 * Mail arrives as HTML built by mail clients and marketing tools: nested layout
 * tables, inline styles, tracking pixels, and preheader padding. Handing that to
 * a model raw is expensive and noisy; stripping it to a flat blob of text loses
 * the structure that makes an email readable — headings, lists, and above all
 * which text is a link and where the link goes.
 *
 * Markdown keeps that structure at a fraction of the tokens.
 *
 * The conversion is delegated to a maintained library rather than hand-rolled.
 * Entity decoding, whitespace collapsing, nesting and malformed-markup recovery
 * are all fiddly, and regular expressions over HTML fail at them in ways that
 * only show up on someone else's newsletter.
 */
import TurndownService from 'turndown';

/** An image referenced by the body. */
export interface EmailImage {
  /** The `src` as written: a `cid:` reference, an http(s) URL, or a data: URI. */
  readonly src: string;
  readonly alt: string;
  /**
   * Content-Id, when the src was a `cid:` reference. Matches the `contentId` of
   * an inline attachment on the same message, which is how the bytes are found.
   */
  readonly contentId?: string;
}

export interface ConvertedBody {
  readonly markdown: string;
  /** Images in document order, so a caller can attach them alongside the text. */
  readonly images: readonly EmailImage[];
}

/**
 * Padding characters mail clients use to stretch preview text: zero-width space,
 * non-joiner, joiner, word joiner, BOM, and soft hyphen.
 *
 * A marketing email routinely carries hundreds of these after its preheader.
 * They render as nothing, and removing them is about output that reads cleanly
 * rather than about safety.
 */
const INVISIBLE_PADDING_CODE_POINTS = [
  0x200b, // zero-width space
  0x200c, // zero-width non-joiner
  0x200d, // zero-width joiner
  0x2060, // word joiner
  0xfeff, // zero-width no-break space
  0x00ad, // soft hyphen
];

const INVISIBLE_PADDING = new RegExp(
  `[${INVISIBLE_PADDING_CODE_POINTS.map((c) => String.fromCodePoint(c)).join('')}]`,
  'g',
);

function buildService(images: EmailImage[]): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    linkStyle: 'inlined',
  });

  // Never emit stylesheet or script contents as body text.
  service.remove(['style', 'script', 'head', 'noscript']);

  service.addRule('image', {
    filter: 'img',
    replacement: (_content, node) => {
      const element = node as unknown as { getAttribute(name: string): string | null };
      const src = element.getAttribute('src') ?? '';
      const alt = element.getAttribute('alt') ?? '';
      if (!src) return '';

      const cid = src.toLowerCase().startsWith('cid:') ? src.slice(4) : undefined;
      images.push({ src, alt, ...(cid ? { contentId: cid } : {}) });

      return `![${alt}](${src})`;
    },
  });

  return service;
}

/** Collapses runs of blank lines, which layout tables produce in quantity. */
function tidy(markdown: string): string {
  return markdown
    .replace(INVISIBLE_PADDING, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Converts an HTML email body to Markdown.
 *
 * Never throws: a body that cannot be parsed at all comes back as its own text,
 * because failing to read one message must not fail the tool that read it.
 */
export function htmlToMarkdown(html: string): ConvertedBody {
  if (!html || !html.trim()) return { markdown: '', images: [] };

  const images: EmailImage[] = [];
  try {
    return { markdown: tidy(buildService(images).turndown(html)), images };
  } catch {
    // Fall back to the raw body rather than losing the message entirely.
    return { markdown: tidy(html), images };
  }
}

/** Wraps a plain-text body in the same shape, so callers have one path. */
export function textToMarkdown(text: string): ConvertedBody {
  return { markdown: tidy(text ?? ''), images: [] };
}

/**
 * Converts a Graph message body of either content type.
 *
 * @param contentType Graph reports 'html' or 'text'
 */
export function bodyToMarkdown(
  content: string | undefined,
  contentType: string | undefined,
): ConvertedBody {
  return contentType?.toLowerCase() === 'html'
    ? htmlToMarkdown(content ?? '')
    : textToMarkdown(content ?? '');
}
