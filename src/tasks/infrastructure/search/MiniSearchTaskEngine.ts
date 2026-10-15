/*!
 * MiniSearch 7.2.0 — bundled dependency notice.
 * Copyright 2022 Luca Ongaro
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import MiniSearch, { type SearchResult } from 'minisearch';
import type { TaskSearchEngine, TaskSearchEngineRequest } from '../../application/TaskSearchEngine';
import type {
  TaskSearchDocument,
  TaskSearchEngineHit,
  TaskSearchField,
  TaskSearchSourceNode,
} from '../../application/TaskSearchSource';
import {
  matchesSearchTerm,
  normalizeSearchWord,
  type SearchToken,
  type SearchWordSegmenter,
} from '../../domain/searchMatchPolicy';
import { TaskSearchError } from '../../domain/taskSearchTypes';
const fields: TaskSearchField[] = [
  'title',
  'description',
  'comments',
  'tags',
  'metadata',
  'links',
  'sourcePath',
];
const boosts = {
  title: 5,
  description: 2,
  comments: 1,
  tags: 2,
  metadata: 1,
  links: 1,
  sourcePath: 1,
};
interface IndexedNode extends TaskSearchSourceNode {
  readonly astralFields: number;
  readonly coordinate: string;
  readonly parentCoordinate: string | undefined;
}
function hasAstralWordPoint(term: string): boolean {
  return /[\u{10000}-\u{10ffff}]/u.test(term);
}
interface NodeScore {
  readonly tokens: Map<number, number>;
  readonly exactTitle: Set<number>;
}
interface Aggregate {
  readonly node: TaskSearchSourceNode;
  readonly covered: Set<number>;
  readonly scores: number[];
  readonly exactTitle: Set<number>;
}
function compareOrder(a: TaskSearchSourceNode, b: TaskSearchSourceNode): number {
  if (a.order.filePath !== b.order.filePath) return a.order.filePath < b.order.filePath ? -1 : 1;
  if (a.order.line !== b.order.line) return a.order.line - b.order.line;
  for (let i = 0; i < Math.min(a.order.childLines.length, b.order.childLines.length); i++) {
    const delta = (a.order.childLines[i] ?? 0) - (b.order.childLines[i] ?? 0);
    if (delta !== 0) return delta;
  }
  const depth = a.order.childLines.length - b.order.childLines.length;
  return depth === 0 ? a.id - b.id : depth;
}
function searchFields(request: TaskSearchEngineRequest): TaskSearchField[] {
  const selected: TaskSearchField[] =
    request.kind === 'nodes' && request.matchScope !== 'subtree'
      ? ['title', 'tags']
      : fields.filter((field) => field !== 'sourcePath');
  if (request.includeSourcePath) selected.push('sourcePath');
  return selected;
}
function aggregateScores(
  nodes: ReadonlyMap<number, TaskSearchSourceNode>,
  scores: ReadonlyMap<number, NodeScore>,
  request: TaskSearchEngineRequest,
): readonly TaskSearchEngineHit[] {
  const groups = new Map<number, Aggregate>();
  for (const [id, score] of scores) {
    const node = nodes.get(id);
    if (node === undefined) continue;
    const identity = request.kind === 'roots' ? node.rootId : node.id;
    const group = groups.get(identity) ?? {
      node: nodes.get(identity) ?? node,
      covered: new Set<number>(),
      scores: [],
      exactTitle: new Set<number>(),
    };
    addNodeScore(group, score, request.kind === 'roots' && node.id !== node.rootId);
    groups.set(identity, group);
  }
  return [...groups]
    .filter(([, group]) => group.covered.size === request.query.tokens.length)
    .map(([id, group]) => {
      const strongest = group.scores.reduce((max, value) => Math.max(max, value), 0),
        remaining = group.scores.reduce((a, b) => a + b, 0) - strongest;
      return { id, score: strongest + Math.min(strongest, 0.15 * remaining), group };
    })
    .sort((a, b) => compareRelevance(a, b, request.preferFilePath))
    .map(({ id, score }) => ({ id, score }));
}
function addNodeScore(group: Aggregate, score: NodeScore, child: boolean): void {
  for (const token of score.tokens.keys()) group.covered.add(token);
  for (const token of score.exactTitle) group.exactTitle.add(token);
  const total = [...score.tokens.values()].reduce((sum, value) => sum + value, 0);
  group.scores.push(total * (child ? 0.8 : 1));
}
interface SubtreeAggregate {
  readonly node: IndexedNode;
  readonly covered: Set<number>;
  readonly exactTitle: Set<number>;
  readonly own: number;
  descendantSum: number;
  descendantMax: number;
}
function coordinate(rootId: number, childLines: readonly number[]): string {
  return `${rootId}:${childLines.join(',')}`;
}
function indexedParent<T>(
  node: IndexedNode,
  coordinates: ReadonlyMap<string, number>,
  values: ReadonlyMap<number, T>,
): T | undefined {
  const id =
    node.parentCoordinate === undefined ? undefined : coordinates.get(node.parentCoordinate);
  return id === undefined ? undefined : values.get(id);
}
function touchedSubtrees(
  nodes: ReadonlyMap<number, IndexedNode>,
  coordinates: ReadonlyMap<string, number>,
  scores: ReadonlyMap<number, NodeScore>,
): Map<number, SubtreeAggregate> {
  const groups = new Map<number, SubtreeAggregate>();
  // Resolve parents at query time: source batches need not arrive in tree order.
  // Stop at the first touched ancestor so every closure node is initialized once.
  for (const id of scores.keys()) {
    let node = nodes.get(id);
    while (node !== undefined && !groups.has(node.id)) {
      const own = scores.get(node.id);
      groups.set(node.id, {
        node,
        covered: new Set(own?.tokens.keys()),
        exactTitle: new Set(own?.exactTitle),
        own:
          own === undefined ? 0 : [...own.tokens.values()].reduce((sum, value) => sum + value, 0),
        descendantSum: 0,
        descendantMax: 0,
      });
      node = indexedParent(node, coordinates, nodes);
    }
  }
  return groups;
}
function aggregateSubtrees(
  nodes: ReadonlyMap<number, IndexedNode>,
  coordinates: ReadonlyMap<string, number>,
  scores: ReadonlyMap<number, NodeScore>,
  request: TaskSearchEngineRequest,
): readonly TaskSearchEngineHit[] {
  const groups = touchedSubtrees(nodes, coordinates, scores);
  const ordered = [...groups.values()].sort(
    (a, b) => b.node.order.childLines.length - a.node.order.childLines.length,
  );
  for (const group of ordered) {
    const parent = indexedParent(group.node, coordinates, groups);
    if (parent === undefined) continue;
    for (const token of group.covered) parent.covered.add(token);
    for (const token of group.exactTitle) parent.exactTitle.add(token);
    // Pass raw statistics upward; the descendant discount applies once per candidate.
    parent.descendantSum += group.own + group.descendantSum;
    parent.descendantMax = Math.max(parent.descendantMax, group.own, group.descendantMax);
  }
  return ordered
    .filter((group) => group.covered.size === request.query.tokens.length)
    .map((group) => {
      const strongest = Math.max(group.own, 0.8 * group.descendantMax);
      const remaining = group.own + 0.8 * group.descendantSum - strongest;
      return { id: group.node.id, score: strongest + Math.min(strongest, 0.15 * remaining), group };
    })
    .sort((a, b) => compareRelevance(a, b, request.preferFilePath))
    .map(({ id, score }) => ({ id, score }));
}
function comparePreferred(
  a: TaskSearchSourceNode,
  b: TaskSearchSourceNode,
  preferred?: string,
): number {
  const delta = Number(b.order.filePath === preferred) - Number(a.order.filePath === preferred);
  return delta === 0 ? compareOrder(a, b) : delta;
}
function compareRelevance(
  a: { score: number; group: Pick<Aggregate, 'node' | 'exactTitle'> },
  b: { score: number; group: Pick<Aggregate, 'node' | 'exactTitle'> },
  preferred?: string,
): number {
  const exact = b.group.exactTitle.size - a.group.exactTitle.size;
  if (exact !== 0) return exact;
  const score = b.score - a.score;
  return score === 0 ? comparePreferred(a.group.node, b.group.node, preferred) : score;
}
function recordResult(
  scores: Map<number, NodeScore>,
  result: SearchResult,
  token: SearchToken,
  tokenIndex: number,
): void {
  const id = Number(result.id);
  const score = scores.get(id) ?? {
    tokens: new Map<number, number>(),
    exactTitle: new Set<number>(),
  };
  score.tokens.set(tokenIndex, Math.max(score.tokens.get(tokenIndex) ?? 0, result.score));
  if (
    Object.prototype.hasOwnProperty.call(result.match, token.term) &&
    result.match[token.term]?.includes('title') === true
  ) {
    score.exactTitle.add(tokenIndex);
  }
  scores.set(id, score);
}
class MiniSearchTaskEngine implements TaskSearchEngine {
  private readonly mini_abyssPrivate: MiniSearch<TaskSearchDocument>;
  private readonly nodes_abyssPrivate = new Map<number, IndexedNode>();
  private readonly coordinates_abyssPrivate = new Map<string, number>();
  private readonly files_abyssPrivate = new Map<string, Set<number>>();
  private readonly replacing_abyssPrivate = new Set<string>();
  private readonly astralFieldCounts_abyssPrivate = fields.map(() => 0);
  private indexingAstralFields_abyssPrivate = 0;
  private disposed_abyssPrivate = false;
  constructor(segment: SearchWordSegmenter) {
    this.mini_abyssPrivate = new MiniSearch({
      fields,
      storeFields: [],
      autoVacuum: false,
      tokenize: (text) => segment(text).map((word) => word.text),
      processTerm: (term, field) => {
        const normalized = normalizeSearchWord(term);
        if (field !== undefined && hasAstralWordPoint(normalized)) {
          const index = fields.indexOf(field as TaskSearchField);
          if (index >= 0) this.indexingAstralFields_abyssPrivate |= 1 << index;
        }
        return normalized;
      },
    });
  }
  private check_abyssPrivate(): void {
    if (this.disposed_abyssPrivate) throw new TaskSearchError('disposed', 'Search engine disposed');
  }
  replaceBegin(path: string): void {
    this.remove(path);
    this.replacing_abyssPrivate.add(path);
  }
  add(documents: readonly TaskSearchDocument[]): void {
    this.check_abyssPrivate();
    for (const document of documents) {
      this.indexingAstralFields_abyssPrivate = 0;
      this.mini_abyssPrivate.add(document);
      const astralFields = this.indexingAstralFields_abyssPrivate;
      this.indexingAstralFields_abyssPrivate = 0;
      this.adjustAstralFields_abyssPrivate(astralFields, 1);
      const key = coordinate(document.rootId, document.order.childLines);
      this.coordinates_abyssPrivate.set(key, document.id);
      this.nodes_abyssPrivate.set(document.id, {
        id: document.id,
        rootId: document.rootId,
        astralFields,
        coordinate: key,
        parentCoordinate:
          document.order.childLines.length === 0
            ? undefined
            : coordinate(document.rootId, document.order.childLines.slice(0, -1)),
        order: { ...document.order, childLines: [...document.order.childLines] },
      });
      const ids = this.files_abyssPrivate.get(document.order.filePath) ?? new Set<number>();
      ids.add(document.id);
      this.files_abyssPrivate.set(document.order.filePath, ids);
    }
  }
  replaceCommit(path: string): void {
    this.check_abyssPrivate();
    this.replacing_abyssPrivate.delete(path);
  }
  remove(path: string): void {
    this.check_abyssPrivate();
    for (const id of this.files_abyssPrivate.get(path) ?? []) {
      this.mini_abyssPrivate.discard(id);
      this.adjustAstralFields_abyssPrivate(this.nodes_abyssPrivate.get(id)?.astralFields ?? 0, -1);
      const node = this.nodes_abyssPrivate.get(id);
      if (node !== undefined) this.coordinates_abyssPrivate.delete(node.coordinate);
      this.nodes_abyssPrivate.delete(id);
    }
    this.files_abyssPrivate.delete(path);
    this.replacing_abyssPrivate.delete(path);
  }
  private adjustAstralFields_abyssPrivate(mask: number, delta: 1 | -1): void {
    for (let index = 0; index < fields.length; index++) {
      if ((mask & (1 << index)) !== 0)
        this.astralFieldCounts_abyssPrivate[index] =
          (this.astralFieldCounts_abyssPrivate[index] ?? 0) + delta;
    }
  }
  search(request: TaskSearchEngineRequest): readonly TaskSearchEngineHit[] {
    this.check_abyssPrivate();
    if (this.replacing_abyssPrivate.size > 0)
      throw new TaskSearchError('unavailable', 'Search replacement incomplete');
    if (request.query.tokens.length === 0)
      return request.query.original.trim() === '' ? this.blank_abyssPrivate(request) : [];
    const scores = new Map<number, NodeScore>();
    for (const [tokenIndex, token] of request.query.tokens.entries()) {
      for (const result of this.tokenResults_abyssPrivate(token, request))
        recordResult(scores, result, token, tokenIndex);
    }
    return request.kind === 'nodes' && request.matchScope === 'subtree'
      ? aggregateSubtrees(this.nodes_abyssPrivate, this.coordinates_abyssPrivate, scores, request)
      : aggregateScores(this.nodes_abyssPrivate, scores, request);
  }
  private *tokenResults_abyssPrivate(
    token: SearchToken,
    request: TaskSearchEngineRequest,
  ): Iterable<SearchResult> {
    const selectedFields = searchFields(request);
    const needsCodePointCandidates =
      hasAstralWordPoint(token.term) ||
      selectedFields.some(
        (field) => (this.astralFieldCounts_abyssPrivate[fields.indexOf(field)] ?? 0) > 0,
      );
    const normalToken = { ...token, swaps: [] };
    const acceptedTerms = new Map<string, number>();
    const acceptTerm = (_id: unknown, term: string): number => {
      const cached = acceptedTerms.get(term);
      if (cached !== undefined) return cached;
      const accepted = Number(matchesSearchTerm(term, normalToken));
      acceptedTerms.set(term, accepted);
      return accepted;
    };
    const branches = [
      {
        text: token.term,
        fuzzy: token.edits * (needsCodePointCandidates ? 2 : 1),
        prefix: token.prefix,
      },
      ...token.swaps.map((text) => ({ text, fuzzy: 0, prefix: false })),
    ];
    for (const branch of branches) {
      const results = this.mini_abyssPrivate.search(branch.text, {
        fields: selectedFields,
        boost: boosts,
        fuzzy: branch.fuzzy,
        prefix: branch.prefix,
        combineWith: 'OR',
        tokenize: (text) => [text],
        // MiniSearch 7.2.0 measures UTF-16 edits; its derived-term hook excludes
        // broader candidates before they enter either BM25 scores or match evidence.
        // https://github.com/lucaong/minisearch/blob/v7.2.0/src/MiniSearch.ts#L1903
        ...(branch.text === token.term ? { boostDocument: acceptTerm } : {}),
      });
      for (const result of results) {
        const node = this.nodes_abyssPrivate.get(Number(result.id));
        if (
          node !== undefined &&
          (request.filePath === undefined || node.order.filePath === request.filePath)
        )
          yield result;
      }
    }
  }
  private blank_abyssPrivate(request: TaskSearchEngineRequest): readonly TaskSearchEngineHit[] {
    return [...this.nodes_abyssPrivate.values()]
      .filter(
        (node) =>
          (request.kind === 'nodes' || node.id === node.rootId) &&
          (request.filePath === undefined || node.order.filePath === request.filePath),
      )
      .sort((a, b) => comparePreferred(a, b, request.preferFilePath))
      .map((node) => ({ id: node.id, score: 0 }));
  }
  async vacuum(): Promise<void> {
    this.check_abyssPrivate();
    await this.mini_abyssPrivate.vacuum();
  }
  dispose(): void {
    if (this.disposed_abyssPrivate) return;
    this.disposed_abyssPrivate = true;
    this.mini_abyssPrivate.removeAll();
    this.nodes_abyssPrivate.clear();
    this.coordinates_abyssPrivate.clear();
    this.files_abyssPrivate.clear();
    this.replacing_abyssPrivate.clear();
    this.astralFieldCounts_abyssPrivate.fill(0);
    this.indexingAstralFields_abyssPrivate = 0;
  }
}
export function createMiniSearchTaskEngine(segment: SearchWordSegmenter): TaskSearchEngine {
  return new MiniSearchTaskEngine(segment);
}
