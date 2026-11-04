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
  const parsed = parseMarkdownFrontmatter(content.split(/\r?\n/u));
  const frontmatter = parsed.type === 'valid' ? (parsed.value ?? {}) : {};
  return {
    filePath,
    tags: [
      ...new Set([...(getAllTags({ frontmatter }) ?? []), ...extractMarkdownBodyTags(content)]),
    ],
    frontmatter: { ...frontmatter },
  };
}
