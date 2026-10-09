import type { ListViewState } from '../../settings/types';
export interface SearchViewState {
  readonly list: ListViewState;
  readonly relevance: boolean;
}
