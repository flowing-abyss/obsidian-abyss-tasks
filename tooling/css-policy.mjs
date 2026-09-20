import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import valueParser from 'postcss-value-parser';
import ts from 'typescript';

/** @typedef {{ruleId: string, file: string, line: number, column: number, message: string}} CssDiagnostic */
/** @typedef {{ruleId: string, selector: string, property: string, value: string, context: string[], reason: string}} CssException */
/** @typedef {{ core: Record<string, {source: string, minimum: boolean, fallback?: string}>, runtime: {produced: string[], consumed: string[]}, exceptions: CssException[], spacing: Record<string, string> }} CssContracts */

// CSS Color named colors (CSS Color 4); transparent/currentColor remain theme-compatible.
const namedColors = new Set(
  'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(
    ' ',
  ),
);
const colorFunctions = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
]);

/** @param {string} value @param {boolean} [context] @returns {string} */
function canonical(value, context = false) {
  const nodes = valueParser(value).nodes.filter(
    (node) => node.type !== 'space' && node.type !== 'comment',
  );
  return JSON.stringify(
    nodes.flatMap((node) => {
      if (node.type === 'function')
        return [['function', node.value, canonical(valueParser.stringify(node.nodes), context)]];
      if (node.type === 'word') {
        const words = context ? node.value.split(/([<>=]+)/).filter(Boolean) : [node.value];
        return words.map((word) => ['word', word === '0px' ? '0' : word]);
      }
      return [[node.type, node.value]];
    }),
  );
}

/** @param {string} value */
function canonicalContext(value) {
  return canonical(value, true);
}

/** @param {import('postcss').Node} node */
function contextOf(node) {
  const context = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent instanceof postcss.AtRule) context.unshift(`@${parent.name} ${parent.params}`);
  }
  return context;
}

/** @param {import('postcss-selector-parser').Selector} selector */
function scoped(selector) {
  let ancestor = false;
  let own = false;
  for (const node of selector.nodes) {
    if (node.type === 'combinator') {
      if (node.value.trim() === '' || node.value === '>') ancestor ||= own;
      own = false;
    } else if (node.type === 'class' && /^abyss-[a-z0-9_-]+$/i.test(node.value)) {
      own = true;
    } else if (node.type === 'pseudo' && [':is', ':where'].includes(node.value)) {
      own ||= node.nodes.length > 0 && node.nodes.every(scoped);
    }
  }
  return ancestor || own;
}

/** @param {ts.CallExpression} call @param {Set<string>} produced @param {Set<string>} consumed */
function collectLiteralCalls(call, produced, consumed) {
  if (!ts.isPropertyAccessExpression(call.expression)) return;
  const method = call.expression.name.text;
  const argument = call.arguments[0];
  if (!argument) return;
  if (ts.isStringLiteral(argument) && argument.text.startsWith('--')) {
    if (method === 'setProperty') produced.add(argument.text);
    if (method === 'getPropertyValue') consumed.add(argument.text);
  }
  if (method !== 'setCssProps' || !ts.isObjectLiteralExpression(argument)) return;
  for (const property of argument.properties) {
    if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name))
      produced.add(property.name.text);
  }
}

/** @param {ts.CallExpression} call @param {{helper: string, prefix: string}[]} families @param {Set<string>} produced */
function collectFamilyCalls(call, families, produced) {
  if (!ts.isIdentifier(call.expression)) return;
  const helper = call.expression.text;
  const family = families.find((item) => item.helper === helper);
  const argument = call.arguments[1];
  if (family && argument && ts.isStringLiteral(argument))
    produced.add(family.prefix + argument.text);
}

/** @param {string} source @param {{helper: string, prefix: string}[]} [families] @returns {{produced: string[], consumed: string[]}} */
export function discoverRuntimeVariables(source, families = []) {
  const produced = new Set();
  const consumed = new Set();
  const root = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  /** @param {ts.Node} node */
  function visit(node) {
    if (ts.isCallExpression(node)) {
      collectLiteralCalls(node, produced, consumed);
      collectFamilyCalls(node, families, produced);
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return {
    produced: [...produced].sort((a, b) => a.localeCompare(b)),
    consumed: [...consumed].sort((a, b) => a.localeCompare(b)),
  };
}

/** @param {import('postcss-value-parser').FunctionNode} node */
function fallbackOf(node) {
  const comma = node.nodes.findIndex((part) => part.type === 'div' && part.value === ',');
  return comma < 0 ? '' : valueParser.stringify(node.nodes.slice(comma + 1)).trim();
}

/** @param {import('postcss-value-parser').Node} node @param {string} property */
function literalColor(node, property) {
  if (node.type === 'word') {
    if (/^#[\da-f]{3,8}$/i.test(node.value)) return true;
    return (
      /^(--|.*color$|background|border|outline|.*shadow$|fill$|stroke$|text-decoration|column-rule|(?:-webkit-)?(?:backdrop-)?filter$)/.test(
        property.startsWith('--') ? property : property.toLowerCase(),
      ) && namedColors.has(node.value.toLowerCase())
    );
  }
  if (node.type !== 'function' || !colorFunctions.has(node.value.toLowerCase())) return false;
  // Legacy RGB/HSL channel tokens are valid on the declared minimum runtime.
  const channels = node.nodes.filter((part) => part.type !== 'space' && part.type !== 'comment');
  const slash = channels.findIndex((part) => part.type === 'div' && part.value === '/');
  if (slash >= 0)
    return !channels
      .slice(0, slash)
      .every((part) => part.type === 'function' && part.value === 'var');
  const comma = channels.map((part) => part.type === 'div' && part.value === ',').lastIndexOf(true);
  const beforeAlpha = comma < 0 ? channels : channels.slice(0, comma);
  return (
    beforeAlpha.length === 0 ||
    !beforeAlpha.every(
      (part) =>
        (part.type === 'function' && part.value === 'var') ||
        (part.type === 'div' && part.value === ','),
    )
  );
}

/** @param {CssContracts['core'][string] | undefined} core @param {import('postcss-value-parser').FunctionNode} node */
function incompatibleFallback(core, node) {
  return core && !core.minimum && canonical(fallbackOf(node)) !== canonical(core.fallback ?? '');
}

/** @param {import('postcss-value-parser').Node} node @param {string} property @param {CssContracts['spacing']} spacing */
function spacingToken(node, property, spacing) {
  if (node.type !== 'word' || !/^(padding|margin)(-|$)|^(row-|column-)?gap$/.test(property))
    return undefined;
  const dimension = valueParser.unit(node.value);
  return dimension && dimension.unit.toLowerCase() === 'px'
    ? spacing[`${Number(dimension.number)}px`]
    : undefined;
}

/** Pure stylesheet analysis. Runtime names are finite source-discovered contracts, not inheritance proof.
 * @param {string} css
 * @param {{file: string, contracts: CssContracts}} options
 * @returns {CssDiagnostic[]}
 */
export function analyzeCss(css, { file, contracts }) {
  /** @type {CssDiagnostic[]} */
  const diagnostics = [];
  const root = postcss.parse(css, { from: file });
  const owned = new Set();
  const used = new Set(contracts.runtime.consumed);
  const known = new Set([...Object.keys(contracts.core), ...contracts.runtime.produced]);
  const matched = new Set();
  /** @param {string} ruleId @param {import('postcss').Node} node @param {string} message @param {number} [offset] */
  function report(ruleId, node, message, offset = 0) {
    const position = node.positionInside(offset);
    diagnostics.push({ ruleId, file, line: position.line, column: position.column, message });
  }
  /** @param {string} ruleId @param {import('postcss').Declaration} declaration */
  function excepted(ruleId, declaration) {
    if (declaration.parent?.type !== 'rule') return false;
    const selectors = selectorParser()
      .astSync(declaration.parent.selector)
      .nodes.map((selector) =>
        selectorParser().processSync(selector.toString(), { lossless: false }).trim(),
      );
    const context = contextOf(declaration).map(canonicalContext).join('|');
    return selectors.every((selector) => {
      const index = contracts.exceptions.findIndex(
        (exception) =>
          exception.reason.trim() !== '' &&
          exception.ruleId === ruleId &&
          selectorParser().processSync(exception.selector, { lossless: false }).trim() ===
            selector &&
          exception.property === declaration.prop &&
          canonical(exception.value) === canonical(declaration.value) &&
          exception.context.map(canonicalContext).join('|') === context,
      );
      if (index < 0) return false;
      matched.add(index);
      return true;
    });
  }
  const exceptionKeys = new Set();
  for (const exception of contracts.exceptions) {
    const key = JSON.stringify([
      exception.ruleId,
      selectorParser().processSync(exception.selector, { lossless: false }).trim(),
      exception.property,
      canonical(exception.value),
      exception.context.map(canonicalContext),
    ]);
    if (exceptionKeys.has(key))
      report(
        'abyss/duplicate-exception',
        root,
        `Duplicate exception for ${exception.selector} / ${exception.property}`,
      );
    exceptionKeys.add(key);
  }
  root.walkDecls((declaration) => {
    if (declaration.prop.startsWith('--abyss-')) {
      owned.add(declaration.prop);
      known.add(declaration.prop);
    }
  });
  root.walkRules((rule) => {
    if (contextOf(rule).some((context) => /^@(?:-webkit-)?keyframes\b/.test(context))) return;
    const selectors = selectorParser().astSync(rule.selector);
    for (const selector of selectors.nodes) {
      if (!scoped(selector))
        report(
          'abyss/selector-scope',
          rule,
          `Selector must target an Abyss element or subtree: ${selector.toString()}`,
          selector.sourceIndex,
        );
    }
  });
  root.walkDecls((declaration) => {
    if (declaration.important && !excepted('abyss/important', declaration))
      report(
        'abyss/important',
        declaration,
        'Add an exact justified cascade exception or remove !important.',
      );
    const valueOffset = declaration.prop.length + (declaration.raws.between ?? ':').length;
    valueParser(declaration.value).walk((node) => {
      if (node.type === 'function' && node.value.toLowerCase() === 'url') return false;
      if (node.type === 'function' && node.value === 'var') {
        const name = node.nodes[0]?.value ?? '';
        used.add(name);
        if (!known.has(name))
          report(
            'abyss/known-variable',
            declaration,
            `Unknown variable ${name}; declare its core/source-owned contract.`,
            valueOffset + (node.nodes[0]?.sourceIndex ?? node.sourceIndex),
          );
        const core = contracts.core[name];
        if (incompatibleFallback(core, node))
          report(
            'abyss/compatible-variable',
            declaration,
            `${name} is unverified for Obsidian 1.7.2; use fallback ${core?.fallback ?? ''}.`,
            valueOffset + node.sourceIndex,
          );
      }
      if (literalColor(node, declaration.prop) && !excepted('abyss/token-color', declaration))
        report(
          'abyss/token-color',
          declaration,
          'Use a host/derived color token or an exact justified contrast exception.',
          valueOffset + node.sourceIndex,
        );
      const token = spacingToken(node, declaration.prop, contracts.spacing);
      if (token && !excepted('abyss/scale-spacing', declaration))
        report(
          'abyss/scale-spacing',
          declaration,
          `Replace ${node.value} with var(${token}).`,
          valueOffset + node.sourceIndex,
        );
      return undefined;
    });
  });
  root.walkDecls((declaration) => {
    if (owned.has(declaration.prop) && !used.has(declaration.prop))
      report(
        'abyss/unused-variable',
        declaration,
        `Unused owned variable ${declaration.prop}; remove it or register its actual runtime reader.`,
      );
  });
  contracts.exceptions.forEach((exception, index) => {
    if (!matched.has(index))
      report(
        'abyss/stale-exception',
        root,
        `Unused exception: ${exception.ruleId} ${exception.selector} / ${exception.property}`,
      );
  });
  return diagnostics;
}
