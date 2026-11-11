import { MockLanguageModelV4 } from 'ai/test';
import { object } from './safety';
function call(name: string, input: unknown) {
  return {
    content: [
      {
        type: 'tool-call' as const,
        toolCallId: `control-${name}`,
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
export function canonicalModel() {
  let step = 0;
  return new MockLanguageModelV4({
    doGenerate: async (params) => {
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
