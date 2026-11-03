import { id, type Entities, type EntityName } from './model';
import { validReaderPreferences } from './reader';
import { validateDocumentTextIndex } from './text-position';
import { highlightColors } from './annotations';
import { validSpeedPreferences } from './speed-reading';
import { mergeIntervals, validDay } from './statistics';

export class IntegrityError extends Error {}
function requireRule(valid: boolean, message: string): void {
  if (!valid) throw new IntegrityError(message);
}
function timestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
function equals(value: unknown, expected: unknown): boolean {
  return value === expected;
}
export function validate<K extends EntityName>(
  table: K,
  entity: Entities[K],
): void {
  id(entity.id);
  requireRule(
    timestamp(entity.createdAt) &&
      timestamp(entity.updatedAt) &&
      entity.updatedAt >= entity.createdAt,
    'Некорректные временные метки',
  );
  if ('bookId' in entity) id(entity.bookId);
  if ('readingId' in entity) id(entity.readingId);
  if ('body' in entity)
    requireRule(
      validDay(entity.day) &&
        entity.body.trim().length > 0 &&
        entity.body.length <= 20000,
      'Нужны корректная дата и текст дневника (до 20 000 символов).',
    );
  if ('readingGoals' in entity)
    requireRule(
      Object.entries(entity.readingGoals).every(
        ([year, goal]) =>
          /^\d{4}$/.test(year) &&
          Number(year) >= 1900 &&
          Number(year) <= 9999 &&
          Number.isInteger(goal) &&
          goal >= 0 &&
          goal <= 1000,
      ),
      'Цель: от 0 до 1000 книг.',
    );
  if ('mode' in entity && 'activeSeconds' in entity)
    requireRule(
      ['ordinary', 'rsvp', 'guided'].includes(entity.mode ?? '') &&
        /^[a-f0-9]{64}:[a-f0-9]{64}$/.test(entity.contentId ?? '') &&
        Number.isSafeInteger(entity.wordCount) &&
        (entity.wordCount ?? -1) >= 0,
      'Некорректная сессия чтения.',
    );
  if ('intervals' in entity) {
    id(entity.sessionId);
    mergeIntervals(entity.intervals);
    requireRule(
      ['ordinary', 'rsvp', 'guided'].includes(entity.mode) &&
        timestamp(entity.from) &&
        timestamp(entity.to) &&
        entity.to >= entity.from &&
        entity.to - entity.from <= 10000 &&
        Number.isFinite(entity.milliseconds) &&
        entity.milliseconds >= 0 &&
        entity.milliseconds <= entity.to - entity.from &&
        /^[a-f0-9]{64}:[a-f0-9]{64}$/.test(entity.contentId) &&
        Number.isSafeInteger(entity.textVersion) &&
        entity.textVersion > 0,
      'Некорректное событие чтения.',
    );
  }
  if ('bookFileId' in entity && entity.bookFileId !== null)
    id(entity.bookFileId);
  if ('title' in entity)
    requireRule(entity.title.trim().length > 0, 'Название обязательно');
  if ('editionId' in entity) {
    const pattern =
      entity.source === 'open-library' ? /^OL\d{1,12}M$/ : /^[\w-]{1,100}$/;
    requireRule(
      ['open-library', 'google-books'].includes(entity.source) &&
        pattern.test(entity.editionId) &&
        entity.edition.id === entity.editionId &&
        entity.edition.source === entity.source &&
        entity.record.source === entity.source,
      'Некорректная ссылка на каталожное издание',
    );
    requireRule(
      entity.source !== 'google-books' || entity.snapshot === null,
      'Постоянная копия Google Books не сохраняется',
    );
  }
  if ('cover' in entity) {
    requireRule(
      entity.cover === null ||
        (entity.cover instanceof Blob &&
          entity.cover.size > 0 &&
          entity.cover.size <= 10 * 1024 * 1024 &&
          ['image/jpeg', 'image/png', 'image/webp'].includes(
            entity.cover.type,
          )),
      'Обложка: JPG, PNG или WebP, до 10 МБ',
    );
    requireRule(
      entity.genres.every((genre) => genre.trim().length > 0),
      'Жанры не должны быть пустыми',
    );
  }
  if ('cfi' in entity)
    requireRule(entity.cfi.trim().length > 0, 'Позиция обязательна');
  if ('quote' in entity) {
    requireRule(entity.quote.trim().length > 0, 'Цитата не должна быть пустой');
    requireRule(
      !entity.color || Object.hasOwn(highlightColors, entity.color),
      'Неизвестный цвет',
    );
  }
  if ('anchor' in entity) {
    requireRule('bookId' in entity, 'Для текстовой привязки нужна книга');
    const a = entity.anchor;
    requireRule(
      /^[a-f0-9]{64}:[a-f0-9]{64}$/.test(a.contentId) &&
        a.contentId.split(':')[0] === a.start.sha256 &&
        a.start.sha256 === a.end.sha256 &&
        a.start.algorithmVersion === a.end.algorithmVersion &&
        a.start.spineIndex === a.end.spineIndex &&
        Number.isSafeInteger(a.start.offset) &&
        Number.isSafeInteger(a.end.offset) &&
        a.start.offset >= 0 &&
        a.end.offset >= a.start.offset &&
        a.before.length <= 48 &&
        a.after.length <= 48,
      'Некорректная текстовая привязка',
    );
    if ('quote' in entity)
      requireRule(a.end.offset > a.start.offset, 'Пустое выделение');
  }
  if ('progression' in entity)
    requireRule(
      Number.isFinite(entity.progression) &&
        entity.progression >= 0 &&
        entity.progression <= 1,
      'Прогресс должен быть от 0 до 1',
    );
  if ('data' in entity)
    requireRule(
      entity.data instanceof Blob &&
        entity.data.size > 0 &&
        ['application/epub+zip', 'application/x-fictionbook+xml'].includes(
          entity.mediaType,
        ) &&
        entity.name.trim().length > 0,
      'Необходим непустой файл EPUB или FB2',
    );
  if (
    'data' in entity &&
    entity.mediaType === 'application/x-fictionbook+xml'
  ) {
    const representation = entity.representation;
    requireRule(
      Boolean(
        representation &&
        entity.sha256 !== null &&
        equals(representation.format, 'epub') &&
        equals(representation.converterVersion, 1) &&
        representation.sourceSha256 === entity.sha256 &&
        /^[a-f0-9]{64}$/.test(representation.sha256) &&
        representation.data instanceof Blob &&
        representation.data.size > 0 &&
        representation.data.type === 'application/epub+zip',
      ),
      'Для FB2 нужен проверенный локальный EPUB, связанный с оригиналом.',
    );
  }
  if ('data' in entity && entity.mediaType === 'application/epub+zip')
    requireRule(
      !entity.representation,
      'У исходного EPUB не должно быть FB2-представления.',
    );
  if ('sha256' in entity && entity.sha256 !== null)
    requireRule(/^[0-9a-f]{64}$/.test(entity.sha256), 'Некорректный SHA-256');
  if ('algorithmVersion' in entity) validateDocumentTextIndex(entity);
  if ('spine' in entity) {
    const linear = entity.spine
      .map((item, index) => ({ ...item, index }))
      .filter((item) => item.linear);
    requireRule(
      entity.sections.length === linear.length &&
        linear.length > 0 &&
        entity.sections.every(
          (section, index) =>
            section.path === linear[index]?.path &&
            section.spineIndex === linear[index].index,
        ),
      'Индекс должен включать каждый линейный ресурс spine в исходном порядке',
    );
    requireRule(
      entity.totalCharacters ===
        entity.sections.reduce(
          (sum, section) => sum + section.text.length,
          0,
        ) &&
        entity.totalWords ===
          entity.sections.reduce((sum, section) => sum + section.wordCount, 0),
      'Итоги текстового индекса не совпадают с ресурсами',
    );
  }
  if ('status' in entity) {
    requireRule(
      ['planned', 'active', 'finished', 'paused', 'abandoned'].includes(
        entity.status,
      ),
      'Неизвестный статус',
    );
    requireRule(
      entity.startedAt === null || timestamp(entity.startedAt),
      'Некорректное начало',
    );
    requireRule(
      entity.finishedAt === null || timestamp(entity.finishedAt),
      'Некорректное завершение',
    );
    requireRule(
      (entity.finishedAt === null ||
        (entity.startedAt !== null && entity.finishedAt >= entity.startedAt)) &&
        (entity.status === 'planned'
          ? entity.startedAt === null && entity.finishedAt === null
          : entity.status === 'active'
            ? entity.startedAt !== null && entity.finishedAt === null
            : entity.status === 'finished'
              ? entity.startedAt !== null && entity.finishedAt !== null
              : entity.status === 'paused'
                ? entity.finishedAt === null
                : true),
      'Статус и даты прочтения не согласованы',
    );
    requireRule(
      entity.rating === null ||
        (Number.isFinite(entity.rating) &&
          entity.rating >= 0.5 &&
          entity.rating <= 5 &&
          Number.isInteger(entity.rating * 2)),
      'Оценка должна быть от 0,5 до 5 с шагом 0,5',
    );
  }
  if ('activeSeconds' in entity)
    requireRule(
      timestamp(entity.startedAt) &&
        timestamp(entity.endedAt) &&
        entity.endedAt >= entity.startedAt &&
        Number.isFinite(entity.activeSeconds) &&
        entity.activeSeconds >= 0 &&
        entity.activeSeconds <= (entity.endedAt - entity.startedAt) / 1000,
      'Некорректная сессия',
    );
  if ('bookIds' in entity) {
    entity.bookIds.forEach(id);
    requireRule(
      entity.name.trim().length > 0 &&
        new Set(entity.bookIds).size === entity.bookIds.length,
      'Некорректная коллекция',
    );
  }
  if (table === 'settings' && 'key' in entity)
    requireRule(
      equals(entity.key, 'local') &&
        equals(entity.locale, 'ru') &&
        ['system', 'light', 'dark'].includes(entity.theme),
      'Некорректные настройки',
    );
  if ('reader' in entity)
    requireRule(
      validReaderPreferences(entity.reader),
      'Некорректные настройки чтения',
    );
  if ('speed' in entity)
    requireRule(
      validSpeedPreferences(entity.speed),
      'Некорректные настройки скорочтения',
    );
}
