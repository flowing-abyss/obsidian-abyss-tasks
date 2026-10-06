// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { commentStructuralMarker, normalizeCommentText } from '../../src/tasks/domain/commentText';

describe('comment text policy', () => {
  it.each([
    ['  first  \r\n \t\rsecond\t\r\n', '  first  \nsecond\t'],
    ['first\n- [ ] literal\n> quote\n2. item', 'first\n\\- [ ] literal\n\\> quote\n2\\. item'],
    [
      'first\n  + item\n* item\n12) item\n# heading\n~~~js',
      'first\n  \\+ item\n\\* item\n12\\) item\n\\# heading\n\\~\\~\\~js',
    ],
    ['first\n````js', 'first\n\\`\\`\\`\\`js'],
    ['first\n\\- item\n2\\. item\n\\> quote', 'first\n\\- item\n2\\. item\n\\> quote'],
    ['\u00a0\n  hard break  \ntext `code`', '\u00a0\n  hard break  \ntext `code`'],
    ['`code\nordinary text`', '`code\nordinary text`'],
  ])('preserves payload and protects continuation markers: %j', (input, text) => {
    expect(normalizeCommentText(input)).toEqual({ type: 'ready', text });
    expect(normalizeCommentText(text)).toEqual({ type: 'ready', text });
  });
  it.each([
    ['first\n<span>\n- plain', 'first\n<span>\n\\- plain'],
    ['```bad`info\n- plain', '```bad`info\n\\- plain'],
    ['plain < comparison\n- text', 'plain < comparison\n\\- text'],
    ['\\%% ordinary\n- text', '\\%% ordinary\n\\- text'],
    ['\\$ordinary\n- text$', '\\$ordinary\n\\- text$'],
    ['<span>inline</span>\n- text', '<span>inline</span>\n\\- text'],
    ['%%raw\nordinary%%', '%%raw\nordinary%%'],
    ['$math\nordinary$', '$math\nordinary$'],
    ['<div>\nordinary', '<div>\nordinary'],
  ])('accepts ordinary text and raw without required escapes: %j', (input, text) => {
    expect(normalizeCommentText(input)).toEqual({ type: 'ready', text });
    expect(normalizeCommentText(text)).toEqual({ type: 'ready', text });
  });
  it.each([
    '%%raw\n- literal%%',
    '%%raw\n> literal',
    '$x\n2. literal$',
    '$$\n- literal\n$$',
    '$$\n# literal',
    '<span title="first\n- literal">text</span>',
    '<div>\n- literal\n</div>',
    '<pre>first\n> literal',
    '<!-- first\n- literal -->',
    '<!-- first\n- literal',
    '<?pi\n- literal?>',
    '<![CDATA[first\n- literal]]>',
    '<script>first\n- literal\n</script>',
    '<custom>\n- literal',
  ])('refuses required escapes inside recognized raw regions: %j', (input) => {
    expect(normalizeCommentText(input)).toEqual({
      type: 'invalid',
      reason: 'unsafe-raw-continuation',
    });
  });
  it.each([
    '~~~\n- literal\n~~~',
    '~~~\n> literal',
    '```js\n2. literal',
    'first\n```\nordinary\n```',
  ])('refuses structural escapes proven inside fenced/code text: %j', (input) => {
    expect(normalizeCommentText(input)).toEqual({
      type: 'invalid',
      reason: 'unsafe-raw-continuation',
    });
  });
  it.each([
    ['~~~\nordinary', '~~~\nordinary'],
    ['first\n~~~\nordinary\n~~~', 'first\n\\~\\~\\~\nordinary\n\\~\\~\\~'],
    ['first\n```js', 'first\n\\`\\`\\`js'],
  ])('accepts unproved fences or raw without required escapes: %j', (input, text) => {
    expect(normalizeCommentText(input)).toEqual({ type: 'ready', text });
    expect(normalizeCommentText(text)).toEqual({ type: 'ready', text });
  });
  it.each(['', ' \t\r\n\t'])('rejects empty %j', (input) => {
    expect(normalizeCommentText(input)).toEqual({ type: 'empty' });
  });
  it.each(['`code\n2. literal`', '``code\n> quote``', '```\n- code\n```'])(
    'rejects escapes in literal code: %j',
    (input) => {
      expect(normalizeCommentText(input)).toEqual({
        type: 'invalid',
        reason: 'unsafe-raw-continuation',
      });
    },
  );
  it.each(['ordinary', '-word', '1234567890. item', '####### nope', '`` code', '\\> quote'])(
    'does not invent a structural marker in %j',
    (line) => {
      expect(commentStructuralMarker(line)).toBeUndefined();
    },
  );
});

it('protects a large code-rich comment while rejecting a structural marker inside its final raw span', () => {
  const prefix = '`x` plain '.repeat(10000);
  expect(normalizeCommentText(`${prefix}\n- literal`)).toEqual({
    type: 'ready',
    text: `${prefix}\n\\- literal`,
  });
  expect(normalizeCommentText(`${prefix}\n\`raw\n- literal\``)).toEqual({
    type: 'invalid',
    reason: 'unsafe-raw-continuation',
  });
});
