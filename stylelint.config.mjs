/** @type {import('stylelint').Config} */
const config = {
  extends: ['stylelint-config-standard'],
  rules: {
    // The legacy code-block calendar renders semantic HTML elements under a
    // scoped host. A small type-selector allowance keeps those rules scoped
    // without requiring extra presentation-only classes in generated markup.
    'selector-max-type': 3,
    'custom-property-pattern': null,
    // Existing plugin selectors use BEM-style modifiers and must coexist with
    // Obsidian's generated DOM classes. Keep naming strict for our own CSS
    // without forcing a public selector migration during the tooling change.
    'selector-class-pattern': ['^[a-z][A-Za-z0-9_-]*$', { resolveNestedSelectors: true }],
    'selector-id-pattern': '^[a-z][A-Za-z0-9_-]*$',
    // Theme and responsive overrides intentionally repeat selectors in a
    // later cascade layer; source order is the contract in this stylesheet.
    'no-descending-specificity': null,
    // The stylesheet is organized by feature and responsive override rather
    // than one monolithic selector block; later duplicate selectors are
    // deliberate cascade extensions.
    'no-duplicate-selectors': null,
  },
};

export default config;
