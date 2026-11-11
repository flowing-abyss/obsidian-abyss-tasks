import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { transcribe, type TranscriptionModel } from 'ai';
import { CommandFailure } from '../commandTypes';
import { compatibleConnection } from '../providers/compatibleProfile';
import type { NativeProviderTransport } from '../providers/NativeProviderTransport';
import { ProviderFailure, providerFailure } from '../providers/providerFailure';
import type { ProviderSecrets } from '../providers/ProviderSecrets';
import { parseVoiceSettings } from '../providers/providerSettings';
import { compatibleTranscription } from './compatibleTranscription';

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
    this.model();
  }
  private model(): Exclude<TranscriptionModel, string> {
    const selected = parseVoiceSettings(this.settings()),
      { voice } = selected;
    if (voice === 'disabled')
      throw new CommandFailure(
        'VOICE_UNAVAILABLE',
        'Select a voice provider in Command mode settings to use the microphone.',
      );
    if (voice === 'openai-compatible') {
      const config = compatibleConnection(
        'voice',
        selected.compatibleVoice,
        this.secrets,
        this.transport,
      );
      return compatibleTranscription(config);
    }
    const model = selected.voiceModel;
    const connection = {
      apiKey: this.secrets.resolve(voice, 'voice'),
      fetch: this.transport.fetchFor(voice),
    };
    return voice === 'groq'
      ? createGroq(connection).transcription(model)
      : createOpenAI(connection).transcription(model);
  }
  async transcribe(audio: Blob, signal: AbortSignal): Promise<string> {
    const model = this.model();
    if (audio.size === 0 || audio.size > 4 * 1024 * 1024) throw new ProviderFailure('too-large');
    try {
      signal.throwIfAborted();
      const bytes = await audio.arrayBuffer();
      signal.throwIfAborted();
      const result = await transcribe({
        model,
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
