import { APICallError, type TranscriptionModel } from 'ai';
import type { compatibleConnection } from '../providers/compatibleProfile';
import { ProviderFailure } from '../providers/providerFailure';

/** OpenAI-compatible servers can assign any model ID and return just { text }. */
export function compatibleTranscription(
  config: ReturnType<typeof compatibleConnection>,
): Extract<TranscriptionModel, { specificationVersion: 'v4' }> {
  const modelId = config.model;
  const url = `${config.baseURL}/audio/transcriptions`;
  return {
    modelId,
    provider: 'openai-compatible',
    specificationVersion: 'v4',
    async doGenerate({ audio, mediaType, abortSignal }) {
      if (typeof audio === 'string') throw new ProviderFailure('invalid-request');
      const body = new FormData();
      body.set('model', modelId);
      body.set(
        'file',
        new Blob([new Uint8Array(audio).buffer], { type: mediaType }),
        `audio.${mediaType.slice('audio/'.length)}`,
      );
      const response = await config.fetch(url, {
        method: 'POST',
        body,
        ...(abortSignal === undefined ? {} : { signal: abortSignal }),
      });
      if (!response.ok)
        throw new APICallError({
          message: 'Transcription request failed.',
          url,
          requestBodyValues: undefined,
          statusCode: response.status,
        });
      let result: unknown;
      try {
        result = await response.json();
      } catch {
        throw new ProviderFailure('invalid-response');
      }
      if (
        typeof result !== 'object' ||
        result === null ||
        !('text' in result) ||
        typeof result.text !== 'string'
      )
        throw new ProviderFailure('invalid-response');
      return {
        text: result.text,
        segments: [],
        durationInSeconds: undefined,
        language: undefined,
        warnings: [],
        response: { timestamp: new Date(), modelId },
      };
    },
  };
}
