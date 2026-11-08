import { createOpenAI } from '@ai-sdk/openai';
import { transcribe } from 'ai';
import { CommandFailure } from '../commandTypes';
import type { NativeProviderTransport } from '../providers/NativeProviderTransport';
import { ProviderFailure, providerFailure } from '../providers/providerFailure';
import type { ProviderSecrets } from '../providers/ProviderSecrets';
import { parseProviderSettings } from '../providers/providerSettings';

export interface CommandTranscriptionPort {
  available(): void;
  transcribe(audio: Blob, signal: AbortSignal): Promise<string>;
}
/** The SDK owns speech recognition; only final text crosses into the command controller. */
export class ProviderTranscription implements CommandTranscriptionPort {
  constructor(
    private readonly secrets: ProviderSecrets,
    private readonly transport: NativeProviderTransport,
    private readonly settings: () => unknown,
  ) {}
  available(): void {
    if (parseProviderSettings(this.settings()).voice !== 'openai')
      throw new CommandFailure(
        'VOICE_UNAVAILABLE',
        'Select OpenAI voice in CommandMode settings to use the microphone.',
      );
    this.secrets.resolve('openai');
  }
  async transcribe(audio: Blob, signal: AbortSignal): Promise<string> {
    this.available();
    if (audio.size === 0 || audio.size > 4 * 1024 * 1024) throw new ProviderFailure('too-large');
    try {
      signal.throwIfAborted();
      const bytes = await audio.arrayBuffer();
      signal.throwIfAborted();
      const result = await transcribe({
        model: createOpenAI({
          apiKey: this.secrets.resolve('openai'),
          fetch: this.transport.fetchFor('openai'),
        }).transcription('gpt-transcribe'),
        audio: bytes,
        abortSignal: signal,
        maxRetries: 2,
      });
      signal.throwIfAborted();
      if (result.text.length > 16000) throw new ProviderFailure('too-large');
      return result.text.trim();
    } catch (cause) {
      throw providerFailure(cause);
    }
  }
}
