export function isTaskBlockBlankLine(line: string): boolean {
  return /^[\s>]*$/u.test(line);
}
