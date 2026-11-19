import { describe, expect, it } from 'vitest';
import {
  ReaderDiagnostics,
  readReaderDiagnostics,
} from '../src/services/reader-diagnostics';

describe('local reader diagnostics', () => {
  it('records monotonic stage results without content or error messages', async () => {
    let now = 10;
    const log = new ReaderDiagnostics(() => now);
    await log.measure('read-blob', () => {
      now = 25;
      return Promise.resolve('private book text');
    });
    const result = readReaderDiagnostics().slice(-2);
    expect(result).toMatchObject([
      { stage: 'read-blob', elapsed: 0, outcome: 'started' },
      { stage: 'read-blob', elapsed: 15, outcome: 'success' },
    ]);
    await expect(
      log.measure('display', () => Promise.reject(new Error('private path'))),
    ).rejects.toThrow('private path');
    expect(readReaderDiagnostics().at(-1)?.outcome).toBe('failure');
    expect(JSON.stringify(readReaderDiagnostics())).not.toMatch(/private/);
  });

  it('bounds memory, isolates runs and returns defensive snapshots', () => {
    const a = new ReaderDiagnostics();
    a.mark('ready', 'cancelled');
    const before = readReaderDiagnostics().at(-1)?.runId;
    const b = new ReaderDiagnostics();
    for (let index = 0; index < 300; index++) b.mark('display', 'started');
    const snapshot = readReaderDiagnostics();
    expect(snapshot).toHaveLength(256);
    expect(snapshot[0]?.runId).not.toBe(before);
    const first = snapshot[0];
    if (!first) throw new Error('Missing diagnostic');
    first.stage = 'ready';
    expect(readReaderDiagnostics()[0]?.stage).toBe('display');
  });
});
