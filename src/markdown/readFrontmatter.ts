import { getFrontMatterInfo, parseYaml } from 'obsidian';
import { frontmatterRange, type FrontmatterRange } from './frontmatterRange';

type MarkdownFrontmatter =
  | { readonly type: 'none'; readonly contentStart: 0 }
  | {
      readonly type: 'valid';
      readonly contentStart: number;
      readonly range: FrontmatterRange;
      readonly verified: boolean;
      readonly value: Record<string, unknown> | undefined;
    }
  | { readonly type: 'invalid' };

const NO_HEADER = { type: 'none', contentStart: 0 } as const;
const INVALID_HEADER = { type: 'invalid' } as const;
const HEADER_CANDIDATE = /^[^\S\n]*---[^\S\n]*(?:\n|$)/u;

/** Resolves exact YAML and body boundaries before passing metadata to source policy or a writer. */
export function parseMarkdownFrontmatter(input: string | readonly string[]): MarkdownFrontmatter {
  const first = typeof input === 'string' ? input : (input[0] ?? '');
  if (!HEADER_CANDIDATE.test(first)) return NO_HEADER;
  const source = typeof input === 'string' ? input : input.join('\n');
  const range = frontmatterRange(source, 'source');
  if (range !== null) return readMapping(source, range, agreesWithHost(source, range));
  // Older task exclusion rules can still depend on a property in a malformed header.
  const legacy = frontmatterRange(source, 'legacy');
  return legacy === null ? INVALID_HEADER : readMapping(source, legacy, false);
}

function readMapping(
  source: string,
  range: FrontmatterRange,
  verified: boolean,
): MarkdownFrontmatter {
  try {
    const yaml = source.slice(range.yamlFrom, range.yamlTo);
    const value: unknown = parseYaml(yaml);
    if (value == null)
      return {
        type: 'valid',
        contentStart: range.bodyLine,
        range,
        verified: verified && emptyMapping(yaml),
        value: undefined,
      };
    if (typeof value !== 'object' || Array.isArray(value)) return INVALID_HEADER;
    return {
      type: 'valid',
      contentStart: range.bodyLine,
      range,
      verified: verified && plainMapping(value),
      value: value as Record<string, unknown>,
    };
  } catch {
    return INVALID_HEADER;
  }
}

/** A BOM is an encoding signature. Compare offsets in the host's BOM-free coordinate system. */
function agreesWithHost(source: string, range: FrontmatterRange): boolean {
  const bom = source.startsWith('\uFEFF') ? 1 : 0;
  const host = getFrontMatterInfo(source.slice(bom));
  return (
    host.exists &&
    host.from + bom === range.yamlFrom &&
    host.to + bom === range.yamlTo &&
    host.contentStart + bom === range.bodyFrom
  );
}

function plainMapping(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function emptyMapping(yaml: string): boolean {
  return yaml.split('\n').every((line) => /^\s*(?:#.*)?$/u.test(line.trimEnd()));
}
