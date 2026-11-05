import { getAllTags } from 'obsidian';
import { extractMarkdownBodyTags } from '../../markdown/markdownTagRename';
import { parseMarkdownFrontmatter } from './markdown/taskBlockSyntax';

/** Authored note metadata used by the composition-root source exclusion policy. */
export interface TaskSourceMetadata {
  readonly filePath: string;
  readonly tags: readonly string[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
}

export function taskSourceMetadata(filePath: string, content: string): TaskSourceMetadata {
  return inspectTaskSourceMetadata(filePath, content).metadata;
}

export function inspectTaskSourceMetadata(
  filePath: string,
  content: string,
): {
  readonly metadata: TaskSourceMetadata;
  readonly validFrontmatter: boolean;
} {
  const parsed = parseMarkdownFrontmatter(content);
  const frontmatter = parsed.type === 'valid' ? (parsed.value ?? {}) : {};
  return {
    validFrontmatter: parsed.type === 'none' || (parsed.type === 'valid' && parsed.verified),
    metadata: {
      filePath,
      tags: [
        ...new Set([...(getAllTags({ frontmatter }) ?? []), ...extractMarkdownBodyTags(content)]),
      ],
      frontmatter: { ...frontmatter },
    },
  };
}
