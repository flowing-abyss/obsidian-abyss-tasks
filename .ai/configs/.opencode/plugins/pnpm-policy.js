import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives under `.ai/configs/.opencode/plugins/` and is symlinked
// into `.opencode/plugins/`. Walk up from its real (symlink-resolved) location
// to find the `.ai` root, so this keeps working no matter how deep it's nested.
const hooksDir = path.join(findAiRoot(fileURLToPath(import.meta.url)), 'hooks');

function findAiRoot(fromPath) {
  let dir = path.dirname(fromPath);

  while (path.basename(dir) !== '.ai') {
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not find an ".ai" ancestor directory above ${fromPath}`);
    }
    dir = parent;
  }

  return dir;
}

export const PnpmPolicy = async () => ({
  'tool.execute.before': async (input, output) => {
    if (input.tool !== 'bash') {
      return;
    }

    const result = runHook('block-npm-commands.mjs', {
      tool_input: { command: output.args?.command },
    });

    if (result?.hookSpecificOutput?.permissionDecision === 'deny') {
      throw new Error(result.hookSpecificOutput.permissionDecisionReason);
    }
  },
});

function runHook(scriptName, payload) {
  const child = spawnSync('node', [path.join(hooksDir, scriptName)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });

  if (!child.stdout?.trim()) {
    return null;
  }

  try {
    return JSON.parse(child.stdout);
  } catch {
    return null;
  }
}
