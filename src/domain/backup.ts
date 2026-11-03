import type { Entities, EntityName } from './model';
export const backupTables = [
  'books',
  'bookFiles',
  'readings',
  'positions',
  'annotations',
  'bookmarks',
  'sessions',
  'collections',
  'settings',
  'epubIndexes',
  'documentTextIndexes',
  'catalogSelections',
  'activities',
  'journal',
] as const satisfies readonly EntityName[];
export const backupLabels: Record<EntityName, string> = {
  books: 'книги',
  bookFiles: 'файлы книг',
  readings: 'история прочтений',
  positions: 'сохранённые позиции',
  annotations: 'цитаты и заметки',
  bookmarks: 'закладки',
  sessions: 'сеансы чтения',
  collections: 'коллекции',
  settings: 'настройки',
  epubIndexes: 'содержимое книг',
  documentTextIndexes: 'текстовые указатели',
  catalogSelections: 'сведения об изданиях',
  activities: 'статистика',
  journal: 'книжный дневник',
};
export type BackupTables = { [K in EntityName]: Entities[K][] };
export interface BackupSnapshot {
  tables: BackupTables;
  revision: string;
}
export interface BackupStatus {
  lastBackupAt: number | null;
  includedFiles: boolean;
  epoch: string;
}
export interface BackupManifest {
  format: 'reedit-backup';
  version: 1;
  databaseVersion: 9;
  createdAt: number;
  includesFiles: boolean;
  entries: { path: string; size: number; sha256: string; mediaType: string }[];
}
export interface PreparedBackup {
  manifest: BackupManifest;
  tables: BackupTables;
}
export const BACKUP_LIMITS = {
  compressed: 128 * 1024 * 1024,
  unpacked: 192 * 1024 * 1024,
  entry: 64 * 1024 * 1024,
  json: 32 * 1024 * 1024,
  entries: 4096,
  records: 250000,
};
export class BackupError extends Error {}
export function backupRevision(tables: BackupTables): string {
  return JSON.stringify(
    backupTables.map((name) => [name, tables[name]]),
    (_key, value: unknown) =>
      value instanceof Blob
        ? { blobSize: value.size, blobType: value.type }
        : value,
  );
}
