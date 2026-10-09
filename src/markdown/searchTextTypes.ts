import type { SourceRange } from './inlineCode';
export interface SearchTextMapRun {
  readonly visible: SourceRange;
  readonly source: readonly SourceRange[];
}
export interface SearchTextValue {
  readonly text: string;
  readonly map: readonly SearchTextMapRun[];
}
export interface SearchTextProjection {
  readonly visible: SearchTextValue;
  readonly destinations: readonly SearchTextValue[];
}
export interface SearchLinkSpan {
  readonly source: SourceRange;
  readonly kind: 'wiki' | 'markdown' | 'embed';
  readonly label: SearchTextValue;
  readonly destination: SearchTextValue;
}
