import type { ReadingPosition } from '../domain/model';
import type { LocalStore } from '../domain/repositories';
import type { ReaderLocation } from '../domain/reader';
import { cursorSection, type DocumentTextIndex } from '../domain/text-position';
import type { ReaderAddress } from './reader';

export type PersistenceState = 'saving' | 'saved' | 'error';
export class PositionPersistenceService {
  private pending: ReaderLocation | null = null;
  private running: Promise<void> | null = null;
  private lastSaved = '';
  constructor(
    private store: LocalStore,
    private address: ReaderAddress,
    private onState: (state: PersistenceState, message?: string) => void,
  ) {}
  /** An old CFI may be used for an algorithm upgrade, never for another file hash. */
  static restore(
    index: DocumentTextIndex,
    position: Pick<ReadingPosition, 'cfi' | 'cursor'> | undefined,
  ) {
    if (!position) return { cfi: null };
    if (position.cursor) {
      if (position.cursor.sha256 !== index.sha256)
        throw new Error('Сохранённая позиция относится к другому EPUB.');
      if (position.cursor.algorithmVersion === index.algorithmVersion) {
        cursorSection(index, position.cursor);
        return { cursor: position.cursor, cfi: position.cfi };
      }
    }
    return { cfi: position.cfi };
  }
  push(location: ReaderLocation) {
    this.pending = location;
    void this.flush().catch(() => undefined);
  }
  flush = (): Promise<void> => {
    if (this.running) return this.running;
    if (!this.pending) return Promise.resolve();
    const run = async () => {
      while (this.pending) {
        const location = this.pending;
        this.pending = null;
        const identity = JSON.stringify([
          location.cfi,
          location.cursor,
          location.progression,
        ]);
        if (this.lastSaved === identity) {
          this.onState('saved');
          continue;
        }
        this.onState('saving');
        try {
          await this.store.saveReaderPosition({
            readingId: this.address.readingId,
            bookFileId: this.address.fileId,
            cfi: location.cfi,
            progression: location.progression,
            ...(location.cursor ? { cursor: location.cursor } : {}),
          });
          this.lastSaved = identity;
          this.onState('saved');
        } catch (error) {
          this.pending ??= location;
          this.onState(
            'error',
            error instanceof Error
              ? error.message
              : 'Не удалось сохранить позицию.',
          );
          throw error;
        }
      }
    };
    this.running = run().finally(() => {
      this.running = null;
    });
    return this.running;
  };
}
export const createPositionWriter = (
  store: LocalStore,
  address: ReaderAddress,
  onState: (state: PersistenceState, message?: string) => void,
) => new PositionPersistenceService(store, address, onState);
