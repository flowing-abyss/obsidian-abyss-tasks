export interface Sample {
  scenario: string;
  iteration: number;
  durationMs: number;
  longTasks: number | null;
  longTaskMs: number | null;
  maxFrameGapMs: number;
  domNodes: number;
  facts: Record<string, string | number | boolean>;
}

export interface ProfileRun {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  status: 'complete' | 'failed';
  restored: boolean;
  identity: Record<string, string | number | boolean>;
  build: { commit: string; dirty: boolean; sha256: string };
  expectedScenarios: string[];
  samples: Sample[];
  diagnostics: string[];
  errors: string[];
}

export interface Distribution {
  n: number;
  median: number;
  p95: number;
  mad: number;
  min: number;
  max: number;
  lowSampleCount: boolean;
}

interface ScenarioComparison {
  scenario: string;
  before: Distribution;
  after: Distribution;
  deltaMs: number;
  deltaPercent: number | null;
  intervalMs: [number, number];
  practicalMarginMs: number;
  verdict: 'regression' | 'improvement' | 'no-material-difference' | 'inconclusive';
}

export interface Comparison {
  compatible: boolean;
  reasons: string[];
  scenarios: ScenarioComparison[];
}
