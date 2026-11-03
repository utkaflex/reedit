import Dexie, { type Table } from 'dexie';
import type { Entities, EntityName, Id } from '../domain/model';

export const schemaV1 = {
  books: 'id, title',
  bookFiles: 'id, bookId',
  readings: 'id, bookId, status',
  positions: 'id, &readingId, bookFileId',
  annotations: 'id, readingId, bookFileId',
  bookmarks: 'id, readingId, bookFileId',
  sessions: 'id, readingId',
  collections: 'id, *bookIds',
  settings: 'id, &key',
};
export const schemaV2 = {
  ...schemaV1,
  books: 'id, title, createdAt',
  readings: 'id, bookId, status, createdAt',
};
export const schemaV3 = {
  ...schemaV2,
  bookFiles: 'id, bookId, &sha256',
  epubIndexes: 'id, &bookFileId',
};
export const schemaV4 = {
  ...schemaV3,
  positions: 'id, readingId, bookFileId, &[readingId+bookFileId]',
};
export const schemaV5 = {
  ...schemaV4,
  documentTextIndexes: 'id, bookFileId, &[bookFileId+sha256+algorithmVersion]',
};
export const schemaV6 = {
  ...schemaV5,
  annotations: 'id, readingId, bookFileId, bookId, createdAt',
  bookmarks: 'id, readingId, bookFileId, bookId, createdAt',
};
export const schemaV7 = {
  ...schemaV6,
  catalogSelections: 'id, bookId, source, &[bookId+source+editionId]',
};
export const schemaV8 = {
  ...schemaV7,
  sessions: 'id, readingId, &leaseKey',
  activities: 'id, readingId, sessionId, from',
  journal: 'id, readingId, bookId, day',
};
export const schemaV9 = { ...schemaV8, maintenance: 'key' };
export interface MaintenanceRecord {
  key: 'local';
  epoch: string;
  lastBackupAt?: number;
  includedFiles?: boolean;
}
export class ReeditDatabase extends Dexie {
  constructor(name = 'reedit') {
    super(name);
    this.version(1).stores(schemaV1);
    this.version(2)
      .stores(schemaV2)
      .upgrade(async (transaction) => {
        await transaction
          .table<Partial<Entities['books']>>('books')
          .toCollection()
          .modify((book) => {
            book.description ??= '';
            book.genres ??= [];
            book.cover ??= null;
          });
        await transaction
          .table<Partial<Entities['readings']>>('readings')
          .toCollection()
          .modify((reading) => {
            reading.rating ??= null;
            reading.review ??= '';
          });
      });
    this.version(3)
      .stores(schemaV3)
      .upgrade(async (transaction) => {
        await transaction
          .table<Partial<Entities['books']>>('books')
          .toCollection()
          .modify((book) => {
            book.language ??= null;
          });
        await transaction
          .table<Partial<Entities['bookFiles']>>('bookFiles')
          .toCollection()
          .modify((file) => {
            file.sha256 ??= null;
          });
      });
    // V3 had one position per Reading. V4 preserves it and allows a separate position per edition/file.
    this.version(4).stores(schemaV4);
    // Add derived indexes without rewriting EPUBs or legacy CFI positions.
    this.version(5).stores(schemaV5);
    this.version(6)
      .stores(schemaV6)
      .upgrade(async (transaction) => {
        const readings = await transaction
          .table<Entities['readings']>('readings')
          .toArray();
        const parents = new Map(
          readings.map((reading) => [reading.id, reading.bookId]),
        );
        for (const name of ['annotations', 'bookmarks'] as const) {
          await transaction
            .table<Entities[typeof name]>(name)
            .toCollection()
            .modify((record) => {
              const bookId = parents.get(record.readingId);
              if (bookId) record.bookId ??= bookId;
              if ('quote' in record) record.color ??= 'yellow';
            });
        }
      });
    // Add only catalog provenance; existing files, books and reading history remain untouched.
    this.version(7).stores(schemaV7);
    // Additive ledger: no inferred time or text for historical sessions.
    this.version(8).stores(schemaV8);
    this.version(9).stores(schemaV9);
    this.on('versionchange', () => {
      this.close();
    });
  }
  records<K extends EntityName>(name: K): Table<Entities[K], Id> {
    return this.table(name);
  }
}
