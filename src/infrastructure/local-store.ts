import { catalogMatches } from '../domain/catalog';
import {
  anchorText,
  annotationKey,
  contentIdentity,
} from '../domain/annotations';
import {
  newId,
  type Entities,
  type EntityName,
  type BookFile,
  type BookFileSummary,
} from '../domain/model';
import type { LocalStore, Repository } from '../domain/repositories';
import { IntegrityError, validate } from '../domain/rules';
import { ReeditDatabase, type MaintenanceRecord } from './database';
import {
  backupRevision,
  backupTables,
  type BackupTables,
} from '../domain/backup';
import { duplicateBooks, DuplicateBookError } from '../domain/library';
import { checkImportCancelled, EpubImportError } from '../domain/epub';
import type { Transaction } from 'dexie';
import { TEXT_INDEX_VERSION, cursorSection } from '../domain/text-position';

export class StorageError extends Error {
  constructor(
    public readonly code: 'quota' | 'unavailable' | 'write' | 'read',
    options: ErrorOptions,
  ) {
    super(
      {
        quota: 'Недостаточно места для сохранения.',
        unavailable: 'Локальное хранилище недоступно.',
        write: 'Не удалось сохранить данные.',
        read: 'Не удалось прочитать данные.',
      }[code],
      options,
    );
  }
}
function storageError(
  error: unknown,
  fallback: 'write' | 'read' | 'unavailable',
): never {
  if (
    error instanceof IntegrityError ||
    error instanceof EpubImportError ||
    error instanceof StorageError
  )
    throw error;
  const quota =
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'QuotaExceededError';
  throw new StorageError(quota ? 'quota' : fallback, { cause: error });
}
export function createLocalStore(db = new ReeditDatabase()): LocalStore {
  const summarizeFile = (file: BookFile): BookFileSummary => ({
    id: file.id,
    bookId: file.bookId,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    name: file.name,
    mediaType: file.mediaType,
    sha256: file.sha256,
    size: file.data.size,
    ...(file.representation
      ? {
          representation: {
            format: file.representation.format,
            converterVersion: file.representation.converterVersion,
            sourceSha256: file.representation.sourceSha256,
            sha256: file.representation.sha256,
          },
        }
      : {}),
  });
  const listBookFiles = async () => {
    const files: BookFileSummary[] = [];
    // Cursor iteration retains no collection of original Blob handles and never reads their bytes.
    await db.records('bookFiles').each((file) => {
      files.push(summarizeFile(file));
    });
    return files;
  };
  let epoch: string | undefined;
  const maintenance = () => db.table<MaintenanceRecord, string>('maintenance');
  db.on(
    'ready',
    async () => {
      epoch ??= (await maintenance().get('local'))?.epoch ?? 'initial';
    },
    true,
  );
  const guard = async () => {
    const current = (await maintenance().get('local'))?.epoch ?? 'initial';
    epoch ??= current;
    if (epoch !== current)
      throw new IntegrityError(
        'Библиотека восстановлена в другой вкладке. Перезагрузите приложение перед изменениями.',
      );
  };
  const snapshot = async () => {
    const tables = {} as BackupTables;
    for (const name of backupTables)
      Object.assign(tables, { [name]: await db.records(name).toArray() });
    return { tables, revision: backupRevision(tables) };
  };
  const repository = <K extends EntityName>(name: K): Repository<K> => ({
    async get(id) {
      try {
        return await db.records(name).get(id);
      } catch (error) {
        return storageError(error, 'read');
      }
    },
    async list() {
      try {
        return await db.records(name).toArray();
      } catch (error) {
        return storageError(error, 'read');
      }
    },
    async save(entity: Entities[K], options) {
      if (name === 'activities' || (name === 'sessions' && 'mode' in entity))
        throw new IntegrityError(
          'Учёт чтения сохраняется только атомарным контрольным событием.',
        );
      validate(name, entity);
      try {
        await db.transaction('rw', db.tables, async () => {
          await guard();
          const previous = await db.records(name).get(entity.id);
          if (name === 'sessions' && previous && 'mode' in previous)
            throw new IntegrityError(
              'История отслеживаемой сессии неизменяема через общий репозиторий.',
            );
          if (previous && name === 'bookFiles')
            throw new IntegrityError(
              'Оригинальные файлы книг неизменяемы. Прикрепите новый файл с отдельным UUID.',
            );
          if (
            options &&
            (previous?.updatedAt ?? null) !== options.expectedUpdatedAt
          )
            throw new IntegrityError(
              'Запись изменена или удалена в другой вкладке. Закройте форму и обновите библиотеку.',
            );
          if (
            previous &&
            (previous.createdAt !== entity.createdAt ||
              entity.updatedAt < previous.updatedAt)
          )
            throw new IntegrityError(
              'Временные метки записи неизменяемы или монотонны',
            );
          if (
            previous &&
            'bookId' in previous &&
            'bookId' in entity &&
            previous.bookId !== entity.bookId
          )
            throw new IntegrityError('Перенос между книгами запрещён');
          if (
            previous &&
            'readingId' in previous &&
            'readingId' in entity &&
            previous.readingId !== entity.readingId
          )
            throw new IntegrityError('Перенос между прочтениями запрещён');
          if (
            'bookId' in entity &&
            !(await db.records('books').get(entity.bookId))
          )
            throw new IntegrityError('Книга не существует');
          const reading =
            'readingId' in entity
              ? await db.records('readings').get(entity.readingId)
              : undefined;
          if ('readingId' in entity && !reading)
            throw new IntegrityError('Прочтение не существует');
          if ('bookId' in entity && reading && reading.bookId !== entity.bookId)
            throw new IntegrityError('Книга и прочтение не согласованы');
          if (
            previous &&
            ('anchor' in entity || 'anchor' in previous) &&
            JSON.stringify('anchor' in entity ? entity.anchor : null) !==
              JSON.stringify('anchor' in previous ? previous.anchor : null)
          )
            throw new IntegrityError(
              'Привязка сохранённого фрагмента неизменяема.',
            );
          if ('bookFileId' in entity && entity.bookFileId !== null) {
            const file = await db.records('bookFiles').get(entity.bookFileId);
            if (
              !file ||
              (name !== 'epubIndexes' &&
                name !== 'documentTextIndexes' &&
                file.bookId !== reading?.bookId)
            )
              throw new IntegrityError('Файл не принадлежит книге прочтения');
            if ('anchor' in entity) {
              if (contentIdentity(file) !== entity.anchor.contentId)
                throw new IntegrityError(
                  'Заметка относится к другому содержимому.',
                );
              const index = await db
                .records('documentTextIndexes')
                .where('[bookFileId+sha256+algorithmVersion]')
                .equals([
                  file.id,
                  entity.anchor.start.sha256,
                  entity.anchor.start.algorithmVersion,
                ])
                .first();
              if (!index && (!previous || !('anchor' in previous)))
                throw new IntegrityError(
                  'Текстовый индекс заметки отсутствует.',
                );
              const text = index ? anchorText(index, entity.anchor) : undefined;
              if (index && 'quote' in entity && text !== entity.quote)
                throw new IntegrityError(
                  'Цитата не совпадает с текстом книги.',
                );
            }
            if ('sections' in entity && file.sha256 !== entity.sha256)
              throw new IntegrityError('Индекс не соответствует SHA-256 файла');
            if ('cursor' in entity) {
              const index = await db
                .records('documentTextIndexes')
                .where('[bookFileId+sha256+algorithmVersion]')
                .equals([
                  file.id,
                  entity.cursor.sha256,
                  entity.cursor.algorithmVersion,
                ])
                .first();
              if (!index || file.sha256 !== entity.cursor.sha256)
                throw new IntegrityError(
                  'Индекс текстовой позиции отсутствует или относится к другому EPUB.',
                );
              const section = cursorSection(index, entity.cursor);
              const progress = index.totalCharacters
                ? (section.start + entity.cursor.offset) / index.totalCharacters
                : 0;
              if (Math.abs(progress - entity.progression) > 1e-9)
                throw new IntegrityError(
                  'Прогресс не соответствует текстовой позиции.',
                );
            }
            if ('algorithmVersion' in entity) {
              const source = await db
                .records('epubIndexes')
                .where('bookFileId')
                .equals(file.id)
                .first();
              const linear = source?.spine
                .map((entry, spineIndex) => ({ ...entry, spineIndex }))
                .filter((entry) => entry.linear);
              if (
                !linear ||
                linear.length !== entity.sections.length ||
                !entity.sections.every(
                  (section, i) =>
                    section.spineIndex === linear[i]?.spineIndex &&
                    section.path === linear[i].path,
                )
              )
                throw new IntegrityError(
                  'Текстовый индекс не соответствует линейному spine EPUB.',
                );
            }
          }
          if ('bookIds' in entity)
            for (const bookId of entity.bookIds) {
              if (!(await db.records('books').get(bookId)))
                throw new IntegrityError('Книга коллекции не существует');
            }
          if (name === 'annotations' && 'quote' in entity) {
            if (
              previous &&
              'quote' in previous &&
              previous.quote !== entity.quote
            )
              throw new IntegrityError('Текст сохранённой цитаты неизменяем.');
            const entries = await db
              .records('annotations')
              .where('readingId')
              .equals(entity.readingId)
              .toArray();
            if (
              entries.some(
                (item) =>
                  item.id !== entity.id &&
                  annotationKey(item) === annotationKey(entity),
              )
            )
              throw new IntegrityError('Этот фрагмент уже сохранён.');
          }
          await db.records(name).put(entity);
        });
      } catch (error) {
        storageError(error, 'write');
      }
    },
  });
  return {
    async listBookFiles() {
      try {
        return await listBookFiles();
      } catch (error) {
        return storageError(error, 'read');
      }
    },
    async getEpubIndex(fileId) {
      try {
        return await db
          .records('epubIndexes')
          .where('bookFileId')
          .equals(fileId)
          .first();
      } catch (error) {
        return storageError(error, 'read');
      }
    },
    async getReadingPosition(readingId, fileId) {
      try {
        return await db
          .records('positions')
          .where('[readingId+bookFileId]')
          .equals([readingId, fileId])
          .first();
      } catch (error) {
        return storageError(error, 'read');
      }
    },
    async readBackup() {
      try {
        return await db.transaction('r', db.tables, snapshot);
      } catch (error) {
        return storageError(error, 'read');
      }
    },
    async backupStatus() {
      try {
        const record = await maintenance().get('local');
        return {
          epoch: record?.epoch ?? 'initial',
          lastBackupAt: record?.lastBackupAt ?? null,
          includedFiles: record?.includedFiles ?? false,
        };
      } catch (error) {
        return storageError(error, 'read');
      }
    },
    async confirmBackup(at, includedFiles) {
      if (!Number.isSafeInteger(at) || at < 0 || at > Date.now() + 60000)
        throw new IntegrityError('Некорректная дата резервной копии.');
      try {
        await db.transaction('rw', db.tables, async () => {
          await guard();
          const current = await maintenance().get('local');
          await maintenance().put({
            ...current,
            key: 'local',
            epoch: current?.epoch ?? 'initial',
            lastBackupAt: at,
            includedFiles,
          });
        });
      } catch (error) {
        storageError(error, 'write');
      }
    },
    async restoreBackup(backup, expectedRevision, confirmation, signal) {
      if (!confirmation.confirmed)
        throw new IntegrityError('Требуется подтверждение замены библиотеки.');
      const { validateBackupGraph } =
        await import('../domain/backup-validation');
      validateBackupGraph(backup.tables);
      signal.throwIfAborted();
      const nextEpoch = newId();
      try {
        await db.transaction('rw', db.tables, async (transaction) => {
          await guard();
          const active = await db
            .records('sessions')
            .where('leaseKey')
            .equals('active')
            .first();
          if (active && (active.leaseUntil ?? 0) > Date.now())
            throw new IntegrityError(
              'Сначала закройте книги во всех вкладках Reedit.',
            );
          if ((await snapshot()).revision !== expectedRevision)
            throw new IntegrityError(
              'Библиотека изменилась после предварительной проверки. Проверьте копию ещё раз.',
            );
          const abort = () => {
            transaction.abort();
          };
          signal.addEventListener('abort', abort, { once: true });
          try {
            signal.throwIfAborted();
            for (const name of backupTables) {
              await db.records(name).clear();
              signal.throwIfAborted();
            }
            for (const name of backupTables) {
              await db
                .table<Entities[typeof name]>(name)
                .bulkAdd(backup.tables[name]);
              signal.throwIfAborted();
            }
            await maintenance().put({ key: 'local', epoch: nextEpoch });
          } finally {
            signal.removeEventListener('abort', abort);
          }
        });
        epoch = nextEpoch;
      } catch (error) {
        storageError(error, 'write');
      }
    },
    async readStatistics() {
      try {
        return await db.transaction('r', db.tables, async () => ({
          books: await db.records('books').toArray(),
          readings: await db.records('readings').toArray(),
          positions: await db.records('positions').toArray(),
          sessions: await db.records('sessions').toArray(),
          activities: await db.records('activities').toArray(),
          journal: await db.records('journal').toArray(),
          settings: await db.records('settings').toArray(),
        }));
      } catch (error) {
        return storageError(error, 'read');
      }
    },
    async claimActivity(input) {
      try {
        return await db.transaction('rw', db.tables, async () => {
          await guard();
          const now = input.now;
          if (
            !Number.isSafeInteger(now) ||
            now < 0 ||
            !['ordinary', 'rsvp', 'guided'].includes(input.mode)
          )
            throw new IntegrityError('Некорректная сессия.');
          const active = await db
            .records('sessions')
            .where('leaseKey')
            .equals('active')
            .first();
          if (
            active &&
            (active.leaseUntil ?? 0) > now &&
            (active.leaseUntil ?? 0) <= now + 20000
          )
            return null;
          if (active) {
            const paused = { ...active, state: 'paused' as const };
            delete paused.leaseKey;
            await db.records('sessions').put(paused);
          }
          const reading = await db.records('readings').get(input.readingId);
          const file = await db.records('bookFiles').get(input.fileId);
          if (!reading || !file || reading.bookId !== file.bookId)
            throw new IntegrityError('Исходный файл прочтения отсутствует.');
          const index = await db
            .records('documentTextIndexes')
            .where('bookFileId')
            .equals(file.id)
            .first();
          if (!index)
            throw new IntegrityError('Для учёта слов нужен текстовый индекс.');
          const identity = contentIdentity(file);
          if (!identity)
            throw new IntegrityError('Идентификатор содержимого отсутствует.');
          const session: Entities['sessions'] = {
            id: newId(),
            createdAt: now,
            updatedAt: now,
            readingId: reading.id,
            startedAt: now,
            endedAt: now,
            activeSeconds: 0,
            mode: input.mode,
            ownerId: input.ownerId,
            leaseKey: 'active',
            leaseUntil: now + 15000,
            contentId: identity,
            textVersion: index.algorithmVersion,
            wordCount: index.sections.reduce(
              (n, s) => n + s.tokens.filter((t) => t.kind === 'word').length,
              0,
            ),
            state: 'active',
          };
          validate('sessions', session);
          await db.records('sessions').add(session);
          return session;
        });
      } catch (error) {
        return storageError(error, 'write');
      }
    },
    async commitActivity(event, ownerId) {
      validate('activities', event);
      try {
        await db.transaction('rw', db.tables, async () => {
          await guard();
          const previous = await db.records('activities').get(event.id);
          if (previous) {
            if (JSON.stringify(previous) !== JSON.stringify(event))
              throw new IntegrityError('UUID события уже использован.');
            return;
          }
          const session = await db.records('sessions').get(event.sessionId);
          if (
            !session ||
            session.ownerId !== ownerId ||
            session.leaseKey !== 'active' ||
            session.readingId !== event.readingId ||
            session.mode !== event.mode ||
            session.contentId !== event.contentId ||
            session.textVersion !== event.textVersion ||
            event.from < session.endedAt ||
            event.to > (session.leaseUntil ?? 0) ||
            event.intervals.some((i) => i.end > (session.wordCount ?? 0))
          )
            throw new IntegrityError(
              'Сессия устарела или интервал не принадлежит книге. Откройте книгу снова.',
            );
          const next = {
            ...session,
            endedAt: event.to,
            updatedAt: Math.max(event.updatedAt, session.updatedAt),
            activeSeconds: Math.min(
              (event.to - session.startedAt) / 1000,
              session.activeSeconds + event.milliseconds / 1000,
            ),
            leaseUntil: event.to + 15000,
          };
          validate('sessions', next);
          await db.records('activities').add(event);
          await db.records('sessions').put(next);
        });
      } catch (error) {
        storageError(error, 'write');
      }
    },
    async releaseActivity(sessionId, ownerId) {
      try {
        await db.transaction('rw', db.tables, async () => {
          await guard();
          const session = await db.records('sessions').get(sessionId);
          if (!session || session.ownerId !== ownerId) return;
          const paused = { ...session, state: 'paused' as const };
          delete paused.leaseKey;
          await db.records('sessions').put(paused);
        });
      } catch (error) {
        storageError(error, 'write');
      }
    },
    async removeJournal(id, expectedUpdatedAt) {
      try {
        await db.transaction('rw', db.tables, async () => {
          await guard();
          const entry = await db.records('journal').get(id);
          if (entry?.updatedAt !== expectedUpdatedAt)
            throw new IntegrityError('Запись изменилась. Обновите дневник.');
          await db.records('journal').delete(id);
        });
      } catch (error) {
        storageError(error, 'write');
      }
    },
    async saveCatalogBook(input) {
      try {
        await db.transaction('rw', db.tables, async () => {
          await guard();
          if (input.selection.bookId !== input.book.id)
            throw new IntegrityError('Книга и источник не согласованы.');
          const edition = input.selection.snapshot?.edition ?? {
            ...input.selection.edition,
            title: input.book.title,
            authors: input.book.authors,
            year: input.book.publishedDate ?? '',
            publisher: input.book.publisher ?? '',
            description: '',
            isbn: input.book.isbn,
            language: input.book.language,
            covers: [],
          };
          const books = await db.records('books').toArray();
          const matches = books.filter(
            (book) =>
              book.id !== input.book.id && catalogMatches(book, edition),
          );
          if (matches.length && !input.allowDuplicate)
            throw new DuplicateBookError(matches.map((book) => book.id));
          await repository('books').save(input.book, {
            expectedUpdatedAt: input.expectedUpdatedAt,
          });
          if (input.initialReading) {
            if (
              input.expectedUpdatedAt !== null ||
              input.initialReading.bookId !== input.book.id
            )
              throw new IntegrityError('Некорректное начальное прочтение.');
            await repository('readings').save(input.initialReading, {
              expectedUpdatedAt: null,
            });
          }
          const previous = await db
            .records('catalogSelections')
            .where('[bookId+source+editionId]')
            .equals([
              input.book.id,
              input.selection.source,
              input.selection.editionId,
            ])
            .first();
          await repository('catalogSelections').save({
            ...input.selection,
            id: previous?.id ?? input.selection.id,
            createdAt: previous?.createdAt ?? input.selection.createdAt,
            updatedAt: Math.max(
              input.selection.updatedAt,
              (previous?.updatedAt ?? 0) + 1,
            ),
          });
        });
      } catch (error) {
        storageError(error, 'write');
      }
    },
    async saveAnnotation(annotation) {
      validate('annotations', annotation);
      try {
        return await db.transaction('rw', db.tables, async () => {
          await guard();
          const matches = await db
            .records('annotations')
            .where('readingId')
            .equals(annotation.readingId)
            .toArray();
          const existing = matches.find(
            (item) => annotationKey(item) === annotationKey(annotation),
          );
          if (existing) {
            if (
              existing.quote !== annotation.quote ||
              existing.bookId !== annotation.bookId ||
              existing.bookFileId !== annotation.bookFileId
            )
              throw new IntegrityError(
                'Сохранённый фрагмент не соответствует запросу.',
              );
            if (annotation.note && existing.note !== annotation.note)
              throw new IntegrityError(
                'Этот фрагмент уже сохранён. Измените комментарий в списке цитат.',
              );
            return existing;
          }
          if (!annotation.bookId || !annotation.anchor)
            throw new IntegrityError('Нужна точная привязка цитаты.');
          await repository('annotations').save(annotation, {
            expectedUpdatedAt: null,
          });
          return annotation;
        });
      } catch (error) {
        return storageError(error, 'write');
      }
    },
    async removeSaved(kind, id, expectedUpdatedAt) {
      try {
        await db.transaction('rw', db.tables, async () => {
          await guard();
          const previous = await db.records(kind).get(id);
          if (!previous || previous.updatedAt !== expectedUpdatedAt)
            throw new IntegrityError(
              'Запись изменена или удалена. Обновите список.',
            );
          await db.records(kind).delete(id);
        });
      } catch (error) {
        storageError(error, 'write');
      }
    },
    async getDocumentTextIndex(fileId, sha256) {
      try {
        return await db
          .records('documentTextIndexes')
          .where('[bookFileId+sha256+algorithmVersion]')
          .equals([fileId, sha256, TEXT_INDEX_VERSION])
          .first();
      } catch (error) {
        return storageError(error, 'read');
      }
    },
    async cacheDocumentTextIndex(index) {
      try {
        return await db.transaction('rw', db.tables, async () => {
          await guard();
          const previous = await db
            .records('documentTextIndexes')
            .where('[bookFileId+sha256+algorithmVersion]')
            .equals([index.bookFileId, index.sha256, index.algorithmVersion])
            .first();
          if (previous) return previous;
          await repository('documentTextIndexes').save(index);
          return index;
        });
      } catch (error) {
        return storageError(error, 'write');
      }
    },
    async saveReaderPosition(input) {
      if (input.bookFileId === null)
        throw new IntegrityError('Для позиции чтения нужен прикреплённый EPUB');
      try {
        await db.transaction('rw', db.tables, async () => {
          await guard();
          const previous = await db
            .records('positions')
            .where('[readingId+bookFileId]')
            .equals([input.readingId, input.bookFileId ?? ''])
            .first();
          const now = Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1);
          await repository('positions').save({
            ...input,
            id: previous?.id ?? newId(),
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
          });
        });
      } catch (error) {
        storageError(error, 'write');
      }
    },
    async findEpubByHash(hash) {
      try {
        const file = await db
          .records('bookFiles')
          .where('sha256')
          .equals(hash)
          .first();
        return file ? summarizeFile(file) : undefined;
      } catch (error) {
        return storageError(error, 'read');
      }
    },
    async commitEpubImport(input, signal) {
      checkImportCancelled(signal);
      let active: Transaction | undefined;
      const cancel = () => {
        active?.abort();
      };
      signal.addEventListener('abort', cancel);
      try {
        return await db.transaction('rw', db.tables, async (transaction) => {
          await guard();
          active = transaction;
          checkImportCancelled(signal);
          if (
            !input.file.sha256 ||
            input.file.sha256 !== input.index.sha256 ||
            input.index.bookFileId !== input.file.id
          )
            throw new IntegrityError('Файл и индекс импорта не согласованы');
          const existing = await db
            .records('bookFiles')
            .where('sha256')
            .equals(input.file.sha256)
            .first();
          if (existing)
            return {
              bookId: existing.bookId,
              fileId: existing.id,
              duplicate: true,
            };
          if (input.newBook) {
            if (
              input.newBook.id !== input.file.bookId ||
              input.initialReading?.bookId !== input.newBook.id
            )
              throw new IntegrityError('Не согласована новая книга импорта');
            const matches = duplicateBooks(
              input.newBook,
              await db.records('books').toArray(),
            );
            if (matches.length && !input.allowDuplicateBook)
              throw new DuplicateBookError(matches.map((book) => book.id));
            await repository('books').save(input.newBook, {
              expectedUpdatedAt: null,
            });
            await repository('readings').save(input.initialReading, {
              expectedUpdatedAt: null,
            });
          } else if (input.initialReading)
            throw new IntegrityError('Прикрепление файла не создаёт прочтение');
          checkImportCancelled(signal);
          await repository('bookFiles').save(input.file, {
            expectedUpdatedAt: null,
          });
          await repository('epubIndexes').save(input.index, {
            expectedUpdatedAt: null,
          });
          if (input.coverIfMissing && !input.newBook) {
            const book = await db.records('books').get(input.file.bookId);
            if (book && !book.cover)
              await repository('books').save(
                {
                  ...book,
                  cover: input.coverIfMissing,
                  updatedAt: Math.max(Date.now(), book.updatedAt + 1),
                },
                { expectedUpdatedAt: book.updatedAt },
              );
          }
          // Reattach only the same original AND the same rendered representation, within this Book.
          for (const name of ['annotations', 'bookmarks'] as const) {
            await db
              .records(name)
              .where('bookId')
              .equals(input.file.bookId)
              .modify((record) => {
                if (
                  record.bookFileId === null &&
                  record.anchor?.contentId === contentIdentity(input.file)
                ) {
                  record.bookFileId = input.file.id;
                  record.updatedAt = Math.max(Date.now(), record.updatedAt + 1);
                }
              });
          }
          checkImportCancelled(signal);
          return {
            bookId: input.file.bookId,
            fileId: input.file.id,
            duplicate: false,
          };
        });
      } catch (error) {
        if (signal.aborted) checkImportCancelled(signal);
        return storageError(error, 'write');
      } finally {
        active = undefined;
        signal.removeEventListener('abort', cancel);
      }
    },
    async readLibrary() {
      try {
        return await db.transaction('r', db.tables, async () => ({
          books: await db.records('books').toArray(),
          readings: await db.records('readings').toArray(),
          files: await listBookFiles(),
          collections: await db.records('collections').toArray(),
        }));
      } catch (error) {
        return storageError(error, 'read');
      }
    },
    async saveLibraryBook(book, options) {
      try {
        await db.transaction('rw', db.tables, async () => {
          await guard();
          const matches = duplicateBooks(
            book,
            await db.records('books').toArray(),
          );
          if (matches.length && !options.allowDuplicate)
            throw new DuplicateBookError(matches.map((match) => match.id));
          await repository('books').save(book, {
            expectedUpdatedAt: options.expectedUpdatedAt,
          });
          if (options.initialReading) {
            if (
              options.expectedUpdatedAt !== null ||
              options.initialReading.bookId !== book.id
            )
              throw new IntegrityError('Некорректное начальное прочтение');
            await repository('readings').save(options.initialReading, {
              expectedUpdatedAt: null,
            });
          }
        });
      } catch (error) {
        storageError(error, 'write');
      }
    },
    async addReading(bookId) {
      try {
        return await db.transaction('rw', db.tables, async () => {
          await guard();
          const history = await db
            .records('readings')
            .where('bookId')
            .equals(bookId)
            .toArray();
          const now = Math.max(
            Date.now(),
            ...history.map((reading) => reading.createdAt + 1),
          );
          const reading: Entities['readings'] = {
            id: newId(),
            createdAt: now,
            updatedAt: now,
            bookId,
            status: 'planned',
            startedAt: null,
            finishedAt: null,
            rating: null,
            review: '',
          };
          await repository('readings').save(reading, {
            expectedUpdatedAt: null,
          });
          return reading;
        });
      } catch (error) {
        return storageError(error, 'write');
      }
    },
    async removeCollection(id, confirmation) {
      if (!confirmation.confirmed)
        throw new IntegrityError('Требуется подтверждение удаления коллекции');
      try {
        await db.transaction('rw', db.tables, async () => {
          await guard();
          await db.records('collections').delete(id);
        });
      } catch (error) {
        storageError(error, 'write');
      }
    },
    repositories: {
      activities: repository('activities'),
      journal: repository('journal'),
      catalogSelections: repository('catalogSelections'),
      books: repository('books'),
      bookFiles: repository('bookFiles'),
      readings: repository('readings'),
      positions: repository('positions'),
      annotations: repository('annotations'),
      bookmarks: repository('bookmarks'),
      sessions: repository('sessions'),
      collections: repository('collections'),
      settings: repository('settings'),
      epubIndexes: repository('epubIndexes'),
      documentTextIndexes: repository('documentTextIndexes'),
    },
    async checkAvailability() {
      try {
        await db.open();
        // Probe a real write, then abort: no synthetic user records remain.
        const probeRollback = new Error('probe-rollback');
        await db
          .transaction('rw', db.tables, async () => {
            await guard();
            const now = Date.now();
            const existing = await db
              .records('settings')
              .where('key')
              .equals('local')
              .first();
            await db.records('settings').put(
              existing ?? {
                id: newId(),
                createdAt: now,
                updatedAt: now,
                key: 'local',
                theme: 'system',
                locale: 'ru',
              },
            );
            throw probeRollback;
          })
          .catch((error: unknown) => {
            if (error !== probeRollback) throw error;
          });
      } catch (error) {
        storageError(error, 'unavailable');
      }
    },
    async removeBookFile(id) {
      try {
        await db.transaction('rw', db.tables, async () => {
          await guard();
          for (const name of [
            'positions',
            'annotations',
            'bookmarks',
          ] as const) {
            await db
              .records(name)
              .where('bookFileId')
              .equals(id)
              .modify((record) => {
                record.bookFileId = null;
                record.updatedAt = Math.max(Date.now(), record.updatedAt + 1);
              });
          }
          await db
            .records('epubIndexes')
            .where('bookFileId')
            .equals(id)
            .delete();
          await db
            .records('documentTextIndexes')
            .where('bookFileId')
            .equals(id)
            .delete();
          await db.records('bookFiles').delete(id);
        });
      } catch (error) {
        storageError(error, 'write');
      }
    },
    async removeBook(id, confirmation) {
      if (!confirmation.confirmed)
        throw new IntegrityError('Требуется подтверждение удаления');
      try {
        await db.transaction('rw', db.tables, async () => {
          await guard();
          const readingIds = await db
            .records('readings')
            .where('bookId')
            .equals(id)
            .primaryKeys();
          for (const name of [
            'positions',
            'annotations',
            'bookmarks',
            'sessions',
            'activities',
            'journal',
          ] as const)
            await db
              .records(name)
              .where('readingId')
              .anyOf(readingIds)
              .delete();
          await db.records('readings').bulkDelete(readingIds);
          const fileIds = await db
            .records('bookFiles')
            .where('bookId')
            .equals(id)
            .primaryKeys();
          await db
            .records('epubIndexes')
            .where('bookFileId')
            .anyOf(fileIds)
            .delete();
          await db
            .records('documentTextIndexes')
            .where('bookFileId')
            .anyOf(fileIds)
            .delete();
          await db.records('bookFiles').bulkDelete(fileIds);
          await db
            .records('collections')
            .where('bookIds')
            .equals(id)
            .modify((collection) => {
              collection.bookIds = collection.bookIds.filter(
                (bookId) => bookId !== id,
              );
              collection.updatedAt = Math.max(
                Date.now(),
                collection.updatedAt + 1,
              );
            });
          await db
            .records('catalogSelections')
            .where('bookId')
            .equals(id)
            .delete();
          await db.records('books').delete(id);
        });
      } catch (error) {
        storageError(error, 'write');
      }
    },
    close() {
      db.close();
    },
  };
}
