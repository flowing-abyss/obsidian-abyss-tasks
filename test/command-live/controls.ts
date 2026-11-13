import { MockLanguageModelV4 } from 'ai/test';
import { object } from './safety';
function call(name: string, input: unknown, toolCallId = `control-${name}`) {
  return {
    content: [
      {
        type: 'tool-call' as const,
        toolCallId,
        toolName: name,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 },
    },
    warnings: [],
  };
}
export function submittedMessage(
  prompt: Parameters<MockLanguageModelV4['doGenerate']>[0]['prompt'],
): string {
  const message = prompt.find((entry) => entry.role === 'user');
  const text = message?.content.find((part) => part.type === 'text');
  const request = text?.type === 'text' ? object(JSON.parse(text.text))['userMessage'] : undefined;
  if (typeof request !== 'string') throw Error('Missing user command in scripted control');
  return request;
}
function append(prompt: Parameters<MockLanguageModelV4['doGenerate']>[0]['prompt']) {
  const message = prompt.find((entry) => entry.role === 'user');
  if (message?.role !== 'user') throw new Error('canonical-prompt-missing');
  const text = message.content.find((part) => part.type === 'text');
  if (text?.type !== 'text') throw new Error('canonical-prompt-missing');
  const visible = object(object(JSON.parse(text.text))['visibleSession']);
  const changes = object(visible['proposal'])['changes'];
  const change = object(Array.isArray(changes) ? changes[0] : undefined),
    basis = object(change['planBasis']);
  return call('task', {
    input: {
      kind: 'append',
      plan: basis['plan'],
      expectedPlanRevision: basis['expectedPlanRevision'],
      operation: {
        type: 'patch',
        target: object(object(change['plan'])['after'])['target'],
        patch: { recurrence: { type: 'set', value: 'every week on Wednesday' } },
      },
    },
  });
}
type GenerationParams = Parameters<MockLanguageModelV4['doGenerate']>[0];
function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right));
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function hasCanonicalReviewState(context: Record<string, unknown>, mainStep: number): boolean {
  return (
    hasExactKeys(context, [
      'displayed',
      'pendingQuestion',
      'pendingTransition',
      'proposedScope',
      'selections',
      'userMessage',
    ]) &&
    context['userMessage'] === 'Сохрани.' &&
    context['proposedScope'] === 'all' &&
    context['pendingQuestion'] === null &&
    context['pendingTransition'] === false &&
    Array.isArray(context['selections']) &&
    context['selections'].length === 0 &&
    mainStep === 7
  );
}
function hasCanonicalDisplayedSubject(context: Record<string, unknown>): boolean {
  const displayed = context['displayed'];
  if (!Array.isArray(displayed) || displayed.length !== 1) return false;
  const item = displayed[0] as unknown;
  if (!hasExactKeys(item, ['index', 'kind', 'owner'])) return false;
  const owner = item['owner'];
  return (
    item['index'] === 0 &&
    item['kind'] === 'create' &&
    hasExactKeys(owner, ['path', 'title']) &&
    owner['title'] === 'Root' &&
    owner['path'] === 'a.md'
  );
}
function isCanonicalAssessmentContext(context: Record<string, unknown>, mainStep: number): boolean {
  return hasCanonicalReviewState(context, mainStep) && hasCanonicalDisplayedSubject(context);
}
export function canonicalWriteAssessment(
  params: GenerationParams,
  assessmentStep: number,
  mainStep: number,
): ReturnType<typeof call> | undefined {
  if (
    params.tools?.some((tool) => tool.type === 'function' && tool.name === 'assess_write') !== true
  )
    return undefined;
  const message = params.prompt.find((entry) => entry.role === 'user');
  const text = message?.content.find((part) => part.type === 'text');
  if (text?.type !== 'text') throw Error('canonical-assessment-prompt-missing');
  const context = object(JSON.parse(text.text) as unknown);
  if (!isCanonicalAssessmentContext(context, mainStep))
    throw Error('canonical-assessment-subject-mismatch');
  return call(
    'assess_write',
    { effect: 'save-reviewed', scope: 'all', scopeMatches: true, authorization: 'Сохрани.' },
    `control-assess-write-${assessmentStep}`,
  );
}
export function canonicalModel() {
  let step = 0;
  let assessmentStep = 0;
  return new MockLanguageModelV4({
    doGenerate: async (params) => {
      const assessment = canonicalWriteAssessment(params, assessmentStep + 1, step);
      if (assessment !== undefined) {
        assessmentStep++;
        return assessment;
      }
      step++;
      if (step === 1 || step === 4)
        return call('expand', {
          capabilities: [
            'read',
            'task',
            'status',
            'note',
            'project',
            'link',
            'cleanup',
            'research',
          ],
        });
      if (step === 2)
        return call('task', {
          input: {
            kind: 'create',
            destination: { type: 'configured-default' },
            tree: {
              markdownTitle: 'Root',
              initial: {
                scheduled: { type: 'set', value: '2026-11-11' },
                time: { type: 'set', value: '10:00' },
              },
            },
          },
        });
      if (step === 5) return append(params.prompt);
      if (step === 3 || step === 6) return call('finish', { state: 'ready', message: 'Ready.' });
      if (step === 7)
        return call('interpret', {
          intent: 'confirm',
          approval: submittedMessage(params.prompt),
          research: false,
        });
      throw new Error('canonical-sequence-exhausted');
    },
  });
}
