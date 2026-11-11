/** Synthesize a soft chime at the owning output device’s sample rate. */
export function chimeBuffer(
  context: AudioContext,
  notes: ReadonlyArray<{
    start: number;
    frequency: number;
    duration: number;
    level: number;
    decay: number;
  }>,
  seconds: number,
  decibels: number,
): AudioBuffer {
  const rate = context.sampleRate;
  const buffer = context.createBuffer(1, Math.round(rate * seconds), rate);
  const samples = buffer.getChannelData(0);
  for (const note of notes) {
    const offset = Math.round(note.start * rate);
    for (let index = 0; index < Math.round(note.duration * rate); index++) {
      const time = index / rate;
      const phase = 2 * Math.PI * note.frequency * time;
      const attack = (1 - Math.exp(-time / 0.008)) ** 2;
      const release = Math.min(1, Math.max(0, (note.duration - time) / 0.075));
      const fade = 0.5 - 0.5 * Math.cos(Math.PI * release);
      const tone =
        Math.sin(phase) * Math.exp(-time / note.decay) +
        0.16 * Math.sin(2 * phase) * Math.exp(-time / 0.08) +
        0.035 * Math.sin(3 * phase) * Math.exp(-time / 0.05);
      const position = offset + index;
      samples[position] = (samples[position] ?? 0) + note.level * attack * fade * tone;
    }
  }
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const gain = 10 ** (decibels / 20) / peak;
  for (let index = 0; index < samples.length; index++)
    samples[index] = (samples[index] ?? 0) * gain;
  return buffer;
}
