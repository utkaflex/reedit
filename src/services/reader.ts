import type { Id } from '../domain/model';
import type { LocalStore } from '../domain/repositories';
import {
  defaultReaderPreferences,
  validReaderPreferences,
  type ReaderPreferences,
} from '../domain/reader';
import { loadAppearance } from './appearance';
import { newId } from '../domain/model';
const supportedPolicy = (value: unknown) => value === 1;

export interface ReaderAddress {
  bookId: Id;
  fileId: Id;
  readingId: Id;
  savedId?: Id;
  savedKind?: 'annotations' | 'bookmarks';
}
export async function loadReader(store: LocalStore, address: ReaderAddress) {
  const [book, file, reading, index, position, settings] = await Promise.all([
    store.repositories.books.get(address.bookId),
    store.repositories.bookFiles.get(address.fileId),
    store.repositories.readings.get(address.readingId),
    store.getEpubIndex(address.fileId),
    store.getReadingPosition(address.readingId, address.fileId),
    loadAppearance(store.repositories.settings),
  ]);
  if (
    !book ||
    !reading ||
    reading.bookId !== book.id ||
    !file ||
    file.bookId !== book.id
  )
    throw new Error(
      'Книга, файл или прочтение недоступны. Возможно, они удалены в другой вкладке.',
    );
  if (
    !file.sha256 ||
    !index ||
    index.sha256 !== file.sha256 ||
    !supportedPolicy(index.safetyPolicyVersion)
  )
    throw new Error(
      'Для этого файла нет проверенного индекса. Повторно импортируйте исходный файл перед чтением.',
    );
  const preferences =
    settings?.reader && validReaderPreferences(settings.reader)
      ? settings.reader
      : { ...defaultReaderPreferences };
  const documentIndex = await store.getDocumentTextIndex(file.id, file.sha256);
  return { book, file, reading, index, position, preferences, documentIndex };
}
export async function saveReaderPreferences(
  store: LocalStore,
  reader: ReaderPreferences,
): Promise<void> {
  if (!validReaderPreferences(reader))
    throw new Error('Некорректные настройки чтения');
  const current = await loadAppearance(store.repositories.settings);
  const now = Math.max(Date.now(), (current?.updatedAt ?? 0) + 1);
  await store.repositories.settings.save(
    current
      ? { ...current, reader, updatedAt: now }
      : {
          id: newId(),
          createdAt: now,
          updatedAt: now,
          key: 'local',
          locale: 'ru',
          theme: 'system',
          reader,
        },
    { expectedUpdatedAt: current?.updatedAt ?? null },
  );
}
export { createPositionWriter } from './position-persistence';
