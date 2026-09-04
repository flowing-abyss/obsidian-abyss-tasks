#!/usr/bin/env node

// Best-effort guardrail against npm/npx commands in this pnpm-only project.
// Not a security boundary — an agent isn't trying to evade this — just a
// catch for the ordinary "typed npm instead of pnpm" mistake. Catches the
// common forms (npm ..., npx ..., sudo npm ..., env FOO=bar npm ...,
// command1 && npm ..., command1; npx ...) with a few small functions, not
// a full shell parser — nested subshells, quoting, and every possible
// wrapper combination are out of scope on purpose.

const input = await readStdinJson();
const command = input?.tool_input?.command;

if (typeof command !== 'string' || command.trim() === '') {
  process.exit(0);
}

const blocked = findBlockedExecutable(command);

if (!blocked) {
  process.exit(0);
}

const replacement =
  blocked === 'npx'
    ? 'Use `pnpm exec <binary>` for local dependencies or `pnpm dlx <package>` for one-off packages.'
    : 'Use the equivalent `pnpm` command.';

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `This project uses pnpm. Direct execution of \`${blocked}\` is blocked. ${replacement}`,
    },
  }),
);

async function readStdinJson() {
  let raw = '';

  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    // Fail open when the hook payload is malformed so the guard does not break the agent.
    return {};
  }
}

// Splits on common shell command separators (&&, ||, ;, |). Deliberately
// NOT splitting on newlines: a multi-line heredoc or commit message passed
// as a single quoted argument (e.g. `git commit -m "$(cat <<'EOF' ... )"`)
// contains real newlines that aren't command separators — splitting on
// them turned prose mentioning "npm"/"npx" on its own line into a false
// positive. Not quote-aware otherwise either — a separator inside a quoted
// string would still split — good enough for an ordinary chained command,
// not a shell-accurate parse.
function findBlockedExecutable(commandText) {
  for (const segment of commandText.split(/&&|\|\||[;|]/)) {
    const blocked = checkSegment(segment.trim());
    if (blocked) {
      return blocked;
    }
  }
  return null;
}

function checkSegment(segment) {
  let words = segment.split(/\s+/).filter(Boolean);

  words = dropWhile(words, isEnvironmentAssignment);

  // Unwrap sudo/env (plus any flags or assignments they take) once.
  if (words[0] === 'sudo' || words[0] === 'env') {
    words = words.slice(1);
    words = dropWhile(words, (w) => w.startsWith('-') || isEnvironmentAssignment(w));
  }

  const executable = words[0]?.split('/').pop();
  return executable === 'npm' || executable === 'npx' ? executable : null;
}

function dropWhile(words, predicate) {
  let index = 0;
  while (index < words.length && predicate(words[index])) {
    index += 1;
  }
  return words.slice(index);
}

function isEnvironmentAssignment(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}
