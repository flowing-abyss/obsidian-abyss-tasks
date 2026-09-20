import type { TaskIndentUnit } from '../markdown/TaskBlockEditor';

interface NativeConfigReader {
  getConfig(key: 'useTab'): unknown;
}

function hasNativeConfigReader(value: unknown): value is NativeConfigReader {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getConfig' in value &&
    typeof value.getConfig === 'function'
  );
}

/** Narrow compatibility seam: native getConfig is not exposed by Obsidian's public Vault type. */
export function nativeTaskIndentUnit(vault: unknown): TaskIndentUnit {
  if (!hasNativeConfigReader(vault)) return '\t';
  return vault.getConfig('useTab') === false ? '    ' : '\t';
}
