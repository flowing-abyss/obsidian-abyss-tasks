import type { Rule } from 'eslint';

const ownerGlobals = new Set([
  'window',
  'document',
  'self',
  'globalThis',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'queueMicrotask',
  'ResizeObserver',
]);
const pureGlobals = new Set([
  ...ownerGlobals,
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'localStorage',
  'sessionStorage',
  'navigator',
  'location',
  'performance',
  'MutationObserver',
  'IntersectionObserver',
  'Worker',
]);

type Identifier = Extract<Rule.Node, { type: 'Identifier' }>;

// Type queries resolve the value namespace, but do not read it at runtime.
const typeQueryNodes = new Set(['TSTypeQuery']);
function insideTypeQuery(node: Rule.Node): boolean {
  let parent = node.parent;
  while (parent !== null) {
    if (typeQueryNodes.has(parent.type)) return true;
    parent = parent.parent;
  }
  return false;
}

function isAmbientValue(context: Rule.RuleContext, node: Identifier): boolean {
  if (insideTypeQuery(node)) return false;
  const reference = context.sourceCode
    .getScope(node)
    .references.find((candidate) => candidate.identifier === node);
  if (reference === undefined) return false;
  if ('isValueReference' in reference && reference.isValueReference === false) return false;
  return reference.resolved === null || reference.resolved.defs.length === 0;
}

function explicitDateUse(node: Identifier): boolean {
  const parent = node.parent;
  if (parent.type === 'NewExpression' && parent.callee === node) return parent.arguments.length > 0;
  if (parent.type !== 'MemberExpression' || parent.object !== node) return false;
  if (parent.computed && parent.property.type === 'Literal') {
    return parent.property.value === 'UTC' || parent.property.value === 'parse';
  }
  return (
    !parent.computed &&
    parent.property.type === 'Identifier' &&
    (parent.property.name === 'UTC' || parent.property.name === 'parse')
  );
}

export const projectAmbientRule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    schema: [{ enum: ['pure', 'owner'] }],
    messages: {
      pure: 'Project projections receive explicit time and data; ambient capabilities are forbidden.',
      owner: 'Project surfaces use their owning document/window capabilities.',
    },
  },
  create(context) {
    const pure = context.options[0] === 'pure';
    return {
      Identifier(node) {
        if (!isAmbientValue(context, node)) return;
        if (pure && node.name === 'Date') {
          if (explicitDateUse(node)) return;
        } else if (!(pure ? pureGlobals : ownerGlobals).has(node.name)) return;
        context.report({ node, messageId: pure ? 'pure' : 'owner' });
      },
    };
  },
};
