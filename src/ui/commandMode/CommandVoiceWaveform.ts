const viewWidth = 1000;
const quietFadeMs = 85;
const normalMotion = { attackMs: 38, releaseMs: 62, height: 9 };
const reducedMotion = { attackMs: 100, releaseMs: 135, height: 6 };

/** A single SVG path follows local peaks in the microphone frame while each bar stays in place. */
export class CommandVoiceWaveform {
  private readonly element: SVGSVGElement;
  private readonly path: SVGPathElement;
  private readonly reduced: MediaQueryList | undefined;
  private bars = 24;
  private heights = new Float32Array(0);
  private targets = new Float32Array(0);
  private frame: number | undefined;
  private lastPaint = 0;
  private fadeUntil: number | undefined;

  constructor(
    shell: HTMLElement,
    private readonly input: HTMLInputElement | HTMLTextAreaElement,
  ) {
    this.element = shell.createSvg('svg', {
      cls: 'abyss-command-waveform',
      attr: {
        viewBox: `0 0 ${viewWidth} 20`,
        height: '20',
        preserveAspectRatio: 'none',
        'pointer-events': 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      },
    });
    this.path = this.element.createSvg('path', {
      attr: {
        stroke: 'currentColor',
        'stroke-width': '2',
        'stroke-linecap': 'round',
        'vector-effect': 'non-scaling-stroke',
      },
    });
    const win = input.win;
    this.reduced =
      typeof win.matchMedia === 'function'
        ? win.matchMedia('(prefers-reduced-motion: reduce)')
        : undefined;
  }

  resize(): void {
    const width = this.element.clientWidth;
    if (width > 0) this.bars = Math.max(1, Math.round(width / 5));
  }

  draw(samples: Float32Array | undefined): void {
    if (this.input.value !== '') {
      this.clear();
      return;
    }
    if (samples === undefined) {
      if (!this.path.hasAttribute('d')) {
        this.clear();
        return;
      }
      if (this.fadeUntil !== undefined) return;
      this.fadeUntil = this.input.win.performance.now() + quietFadeMs;
      this.targets.fill(0);
      this.schedule();
      return;
    }
    this.fadeUntil = undefined;
    const count = Math.min(samples.length, this.bars);
    const resized = this.targets.length !== count;
    if (resized) {
      const previous = this.heights;
      this.heights = Float32Array.from(
        { length: count },
        (_, i) => previous[Math.floor(((i + 0.5) * previous.length) / count)] ?? 0,
      );
      this.targets = new Float32Array(count);
    }
    measurePeaks(samples, this.targets, this.motion().height);
    if (resized || this.heights.some((height, i) => height !== this.targets[i])) this.schedule();
  }

  private schedule(): void {
    if (this.frame !== undefined) return;
    this.lastPaint = this.input.win.performance.now();
    this.frame = this.input.win.requestAnimationFrame(this.advance);
  }

  private motion(): typeof normalMotion {
    return this.reduced?.matches === true ? reducedMotion : normalMotion;
  }

  private readonly advance = (now: number): void => {
    this.frame = undefined;
    const dt = Math.max(0, now - this.lastPaint);
    if (this.fadeUntil !== undefined && now >= this.fadeUntil) {
      this.clear();
      return;
    }
    const { attackMs, releaseMs } = this.motion();
    const attack = 1 - Math.exp(-dt / attackMs);
    const release =
      this.fadeUntil === undefined
        ? 1 - Math.exp(-dt / releaseMs)
        : dt / Math.max(1, this.fadeUntil - this.lastPaint);
    this.lastPaint = now;
    const moving = this.approachTargets(attack, release);
    const path = waveformPath(this.heights);
    if (path !== this.path.getAttribute('d')) this.path.setAttribute('d', path);
    if (moving) this.frame = this.input.win.requestAnimationFrame(this.advance);
    else if (this.fadeUntil !== undefined) this.clear();
  };

  private approachTargets(attack: number, release: number): boolean {
    let moving = false;
    for (let i = 0; i < this.heights.length; i++) {
      const height = this.heights[i] ?? 0,
        target = this.targets[i] ?? 0;
      const next = height + (target - height) * (target > height ? attack : release);
      this.heights[i] = Math.abs(target - next) < 0.035 ? target : next;
      if (this.heights[i] !== target) moving = true;
    }
    return moving;
  }

  clear(): void {
    if (this.frame === undefined && !this.path.hasAttribute('d')) return;
    if (this.frame !== undefined) this.input.win.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.fadeUntil = undefined;
    this.heights.fill(0);
    this.targets.fill(0);
    if (this.path.hasAttribute('d')) this.path.removeAttribute('d');
  }

  destroy(): void {
    this.clear();
    this.element.remove();
  }
}

function measurePeaks(samples: Float32Array, targets: Float32Array, scale: number): void {
  let index = 0;
  for (let bar = 0; bar < targets.length; bar++) {
    const end = Math.floor(((bar + 1) * samples.length) / targets.length);
    let peak = 0;
    for (; index < end; index++) peak = Math.max(peak, Math.abs(samples[index] ?? 0));
    // Compress measured peaks so quiet vowels remain visible beside louder syllables.
    targets[bar] = Math.max(0.5, scale * Math.min(1, Math.sqrt(3 * peak)));
  }
}

function waveformPath(heights: Float32Array): string {
  let path = '';
  for (let i = 0; i < heights.length; i++) {
    const height = Math.round((heights[i] ?? 0) * 10);
    const x = Math.round(((i + 0.5) * viewWidth) / heights.length);
    path += `M${x} ${(100 - height) / 10}v${height / 5}`;
  }
  return path;
}
