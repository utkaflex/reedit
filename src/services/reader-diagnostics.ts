export type ReaderStage =
  | 'validate-file'
  | 'read-blob'
  | 'open-package'
  | 'package-ready'
  | 'resources-ready'
  | 'prepare-document'
  | 'restore-anchor'
  | 'renderer-started'
  | 'display'
  | 'layout'
  | 'fonts-ready'
  | 'images-ready'
  | 'iframe-content'
  | 'relocation'
  | 'ready';

export interface ReaderDiagnostic {
  runId: string;
  stage: ReaderStage;
  elapsed: number;
  outcome: 'started' | 'success' | 'failure' | 'cancelled';
}

const events: ReaderDiagnostic[] = [];
const limit = 256;

/** Memory only. Deliberately accepts no messages, paths, book IDs or errors. */
export class ReaderDiagnostics {
  private readonly runId = crypto.randomUUID();
  private readonly started: number;
  constructor(private readonly clock: () => number = () => performance.now()) {
    this.started = clock();
  }
  mark(stage: ReaderStage, outcome: ReaderDiagnostic['outcome']) {
    events.push({
      runId: this.runId,
      stage,
      elapsed: Math.max(0, this.clock() - this.started),
      outcome,
    });
    if (events.length > limit) events.splice(0, events.length - limit);
  }
  async measure<T>(stage: ReaderStage, work: () => Promise<T>): Promise<T> {
    this.mark(stage, 'started');
    try {
      const result = await work();
      this.mark(stage, 'success');
      return result;
    } catch (error) {
      this.mark(stage, 'failure');
      throw error;
    }
  }
}

export function readReaderDiagnostics(): ReaderDiagnostic[] {
  return events.map((event) => ({ ...event }));
}

// Read-only debugging entry point, also available in production without telemetry.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'reeditReaderDiagnostics', {
    value: readReaderDiagnostics,
    configurable: true,
  });
}
