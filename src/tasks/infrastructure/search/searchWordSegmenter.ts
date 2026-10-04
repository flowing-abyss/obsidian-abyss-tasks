import { fallbackSearchWords, type SearchWordSegmenter } from '../../domain/searchMatchPolicy';
export function createSearchWordSegmenter(): SearchWordSegmenter {
  if (typeof Intl.Segmenter !== 'function') return fallbackSearchWords;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  return (text) => {
    const words = [];
    for (const part of segmenter.segment(text))
      if (part.isWordLike === true)
        words.push({
          text: part.segment,
          start: part.index,
          end: part.index + part.segment.length,
        });
    return words;
  };
}
