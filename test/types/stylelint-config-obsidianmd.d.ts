declare module 'stylelint-config-obsidianmd' {
  /**
   * stylelint-config-obsidianmd, which ships no types. Its browser rule is typed because the Store
   * review's configuration sets that rule's browsers.
   */
  const config: {
    readonly plugins: string[];
    readonly rules: Readonly<Record<string, unknown>> & {
      readonly 'plugin/no-unsupported-browser-features': readonly [
        true,
        Readonly<Record<string, unknown>>,
      ];
    };
  };
  export default config;
}
