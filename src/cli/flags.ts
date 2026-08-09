/**
 * The argv → tool-input mapper.
 *
 * Flags are derived from each tool's zod input shape, so the CLI surface cannot
 * drift from the MCP one: a field added to a tool grows its flag with no CLI
 * change. Parsing coerces a value only as far as the declared primitive; the
 * tool's own zod shape stays the sole validator, exactly as on the MCP path.
 */
import { z, type ZodRawShape } from 'zod';

export const OUTPUT_FORMATS = ['json', 'text', 'md'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export type FlagKind = 'string' | 'number' | 'boolean' | 'array';

export interface FlagSpec {
  /** Kebab-case name the shell sees, without the leading dashes. */
  readonly flag: string;
  /** camelCase field the tool's input shape declares. */
  readonly field: string;
  readonly kind: FlagKind;
  /** How each repeated value of an array flag is coerced. */
  readonly element: 'string' | 'number';
  readonly required: boolean;
  readonly description?: string;
  /** The closed value set, when the field is an enum. */
  readonly choices?: readonly string[];
}

export const kebabCase = (field: string): string =>
  field.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

interface Unwrapped {
  readonly schema: z.ZodTypeAny;
  readonly required: boolean;
  readonly description: string | undefined;
}

/**
 * Strips Optional/Nullable/Default/Effects wrappers down to the base type. The
 * outermost `describe` text found on the way in wins, because `.optional()`
 * after `.describe()` leaves the text on the inner schema.
 */
function unwrap(wrapped: z.ZodTypeAny): Unwrapped {
  let current: z.ZodTypeAny = wrapped;
  let required = true;
  let description = current.description;
  for (;;) {
    if (current instanceof z.ZodOptional) {
      required = false;
      current = current.unwrap();
    } else if (current instanceof z.ZodNullable) {
      current = current.unwrap();
    } else if (current instanceof z.ZodDefault) {
      required = false;
      current = current.removeDefault();
    } else if (current instanceof z.ZodEffects) {
      current = current.innerType();
    } else {
      break;
    }
    description ??= current.description;
  }
  return { schema: current, required, description };
}

export function flagSpecs(shape: ZodRawShape): readonly FlagSpec[] {
  return Object.entries(shape).map(([field, fieldSchema]) => {
    const { schema, required, description } = unwrap(fieldSchema);

    let kind: FlagKind = 'string';
    let element: 'string' | 'number' = 'string';
    let choices: readonly string[] | undefined;

    if (schema instanceof z.ZodBoolean) {
      kind = 'boolean';
    } else if (schema instanceof z.ZodNumber) {
      kind = 'number';
    } else if (schema instanceof z.ZodEnum) {
      choices = schema.options;
    } else if (schema instanceof z.ZodArray) {
      kind = 'array';
      element = unwrap(schema.element).schema instanceof z.ZodNumber ? 'number' : 'string';
    }

    return {
      flag: kebabCase(field),
      field,
      kind,
      element,
      required,
      ...(description !== undefined ? { description } : {}),
      ...(choices ? { choices } : {}),
    };
  });
}

export type ParsedFlags =
  | {
      readonly ok: true;
      readonly input: Record<string, unknown>;
      readonly format: OutputFormat;
    }
  | { readonly ok: false; readonly errors: readonly string[] };

const isFormat = (value: string): value is OutputFormat =>
  (OUTPUT_FORMATS as readonly string[]).includes(value);

/**
 * Assembles the raw input object from the tokens after the subcommand.
 *
 * Array flags accumulate one value per occurrence and are never comma-split —
 * address display names contain commas. A boolean flag is true when bare and
 * takes only `=true`/`=false` inline; it never consumes the next token. A
 * scalar flag given twice is an error rather than a silent last-one-wins.
 */
export function parseFlags(specs: readonly FlagSpec[], argv: readonly string[]): ParsedFlags {
  const byFlag = new Map(specs.map((spec) => [spec.flag, spec]));
  const input: Record<string, unknown> = {};
  const errors: string[] = [];
  let format: OutputFormat = 'json';

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) break;

    if (!token.startsWith('--')) {
      errors.push(`Unexpected argument "${token}" — flags look like --name value.`);
      continue;
    }

    const body = token.slice(2);
    const eq = body.indexOf('=');
    const name = eq >= 0 ? body.slice(0, eq) : body;
    const inline = eq >= 0 ? body.slice(eq + 1) : undefined;

    const takeValue = (): string | undefined => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined) {
        errors.push(`--${name} requires a value.`);
        return undefined;
      }
      i += 1;
      return next;
    };

    if (name === 'format') {
      const raw = takeValue();
      if (raw === undefined) continue;
      if (!isFormat(raw)) {
        errors.push(`--format must be one of ${OUTPUT_FORMATS.join(', ')}, got "${raw}".`);
        continue;
      }
      format = raw;
      continue;
    }

    const spec = byFlag.get(name);
    if (!spec) {
      errors.push(`Unknown flag --${name}.`);
      // Its value, if it looks like one, is skipped so it does not produce a
      // second, misleading "unexpected argument" error.
      const next = argv[i + 1];
      if (inline === undefined && next !== undefined && !next.startsWith('--')) i += 1;
      continue;
    }

    if (spec.kind === 'boolean') {
      if (inline === undefined) input[spec.field] = true;
      else if (inline === 'true' || inline === 'false') input[spec.field] = inline === 'true';
      else errors.push(`--${name} is a boolean: pass it bare for true, or --${name}=false.`);
      continue;
    }

    const raw = takeValue();
    if (raw === undefined) continue;

    const wantsNumber = spec.kind === 'number' || (spec.kind === 'array' && spec.element === 'number');
    const value: string | number = wantsNumber ? Number(raw) : raw;

    if (spec.kind === 'array') {
      const existing = input[spec.field];
      if (Array.isArray(existing)) existing.push(value);
      else input[spec.field] = [value];
    } else if (spec.field in input) {
      errors.push(`--${name} was given more than once, and it takes a single value.`);
    } else {
      input[spec.field] = value;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, input, format };
}

export type ValidatedInput =
  | { readonly ok: true; readonly args: Record<string, unknown> }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Validates the assembled input with the tool's own shape — the same schema the
 * MCP SDK enforces before a handler runs, so the two surfaces accept and reject
 * identically. Issues are reported against the flag name, not the field name.
 */
export function validateInput(shape: ZodRawShape, input: Record<string, unknown>): ValidatedInput {
  const parsed = z.object(shape).safeParse(input);
  if (parsed.success) return { ok: true, args: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => {
      const field = issue.path[0];
      const at = typeof field === 'string' ? `--${kebabCase(field)}` : 'input';
      return `${at}: ${issue.message}`;
    }),
  };
}
