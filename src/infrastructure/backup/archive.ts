import JSZip from 'jszip';
import {
  BACKUP_LIMITS,
  BackupError,
  backupTables,
  backupLabels,
  type BackupManifest,
  type BackupTables,
  type PreparedBackup,
} from '../../domain/backup';
import {
  decodeBackupRecord,
  object,
  validateBackupGraph,
} from '../../domain/backup-validation';
import type { EpubAdapter } from '../../domain/epub';
import { inspectZip, boundedRead } from '../epub/zip';
import { sha256 } from '../fb2/Fb2Adapter';
import { rasterCover } from '../epub/raster-cover';

const json = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
function parse(data: Uint8Array): unknown {
  if (data.length > BACKUP_LIMITS.json)
    throw new BackupError('JSON резервной копии превышает лимит 32 МБ.');
  const result: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(data),
  );
  let nodes = 0;
  const visit = (value: unknown, depth: number) => {
    if (++nodes > 3000000 || depth > 40)
      throw new BackupError('Слишком сложная структура резервной копии.');
    if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
    else if (object(value))
      for (const [key, item] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key))
          throw new BackupError('Недопустимый ключ резервной копии.');
        visit(item, depth + 1);
      }
  };
  visit(result, 0);
  return result;
}
function manifestOf(value: unknown): BackupManifest {
  if (
    !object(value) ||
    value.format !== 'reedit-backup' ||
    value.version !== 1 ||
    value.databaseVersion !== 9
  )
    throw new BackupError(
      'Версия резервной копии не поддерживается. Нужна копия Reedit v1 / схема 9.',
    );
  if (
    !Number.isSafeInteger(value.createdAt) ||
    typeof value.createdAt !== 'number' ||
    value.createdAt < 0 ||
    value.createdAt > 8640000000000000 ||
    typeof value.includesFiles !== 'boolean' ||
    !Array.isArray(value.entries) ||
    value.entries.length > BACKUP_LIMITS.entries
  )
    throw new BackupError('Повреждён manifest резервной копии.');
  for (const item of value.entries)
    if (
      !object(item) ||
      typeof item.path !== 'string' ||
      !/^(?:tables\/[a-zA-Z]+\.json|blobs\/[a-f0-9]{64}\.bin)$/.test(
        item.path,
      ) ||
      !Number.isSafeInteger(item.size) ||
      typeof item.size !== 'number' ||
      item.size < 0 ||
      item.size > BACKUP_LIMITS.entry ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      typeof item.mediaType !== 'string' ||
      item.mediaType.length > 100
    )
      throw new BackupError('Некорректный список файлов резервной копии.');
  return value as unknown as BackupManifest;
}
export async function createArchive(
  input: BackupTables,
  includeFiles: boolean,
  signal: AbortSignal,
  progress: (message: string) => void,
): Promise<Blob> {
  const tables = structuredClone(input);
  for (const session of tables.sessions) {
    delete session.leaseKey;
    delete session.leaseUntil;
    delete session.ownerId;
    if (session.mode) session.state = 'paused';
  }
  if (!includeFiles) {
    tables.bookFiles = [];
    tables.epubIndexes = [];
    tables.documentTextIndexes = [];
    for (const record of [
      ...tables.positions,
      ...tables.annotations,
      ...tables.bookmarks,
    ])
      record.bookFileId = null;
  }
  validateBackupGraph(tables);
  if (
    backupTables.reduce((sum, name) => sum + tables[name].length, 0) >
    BACKUP_LIMITS.records
  )
    throw new BackupError('Слишком много записей для одной резервной копии.');
  const zip = new JSZip();
  const manifest: BackupManifest = {
    format: 'reedit-backup',
    version: 1,
    databaseVersion: 9,
    createdAt: Date.now(),
    includesFiles: includeFiles,
    entries: [],
  };
  let total = 0;
  const add = async (
    path: string,
    bytes: Uint8Array<ArrayBuffer>,
    mediaType: string,
  ) => {
    signal.throwIfAborted();
    if (
      bytes.length > BACKUP_LIMITS.entry ||
      (path.endsWith('.json') && bytes.length > BACKUP_LIMITS.json) ||
      total + bytes.length > BACKUP_LIMITS.compressed - 1024 * 1024 ||
      manifest.entries.length >= BACKUP_LIMITS.entries - 1
    )
      throw new BackupError(
        'Библиотека превышает безопасный лимит копии 128 МБ. Попробуйте копию без файлов книг.',
      );
    total += bytes.length;
    manifest.entries.push({
      path,
      size: bytes.length,
      sha256: await sha256(bytes.buffer),
      mediaType,
    });
    zip.file(path, bytes, { createFolders: false });
  };
  const blobs = new Set<string>();
  let nodes = 0;
  const encode = async (value: unknown, depth = 0): Promise<unknown> => {
    signal.throwIfAborted();
    if (++nodes > 3000000 || depth > 40)
      throw new BackupError(
        'Структура библиотеки превышает безопасный лимит одной копии.',
      );
    if (nodes % 2000 === 0)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (value instanceof Blob) {
      const bytes = new Uint8Array(await value.arrayBuffer()),
        hash = await sha256(bytes.buffer),
        path = `blobs/${hash}.bin`;
      if (!blobs.has(path)) {
        await add(path, bytes, 'application/octet-stream');
        blobs.add(path);
      }
      return { $blob: path, type: value.type };
    }
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) result.push(await encode(item, depth + 1));
      return result;
    }
    if (object(value)) {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value))
        if (item !== undefined) result[key] = await encode(item, depth + 1);
      return result;
    }
    return value;
  };
  for (const name of backupTables) {
    progress(`Подготавливаем: ${backupLabels[name]}…`);
    await add(
      `tables/${name}.json`,
      json(await encode(tables[name])),
      'application/json',
    );
  }
  zip.file('manifest.json', json(manifest), { createFolders: false });
  signal.throwIfAborted();
  const bytes = await zip.generateAsync(
    { type: 'uint8array', compression: 'STORE', streamFiles: true },
    () => {
      signal.throwIfAborted();
    },
  );
  if (bytes.byteLength > BACKUP_LIMITS.compressed)
    throw new BackupError('Архив превышает 128 МБ.');
  return new Blob([new Uint8Array(bytes)], { type: 'application/zip' });
}
export async function prepareArchive(
  file: Blob,
  adapter: EpubAdapter,
  signal: AbortSignal,
  progress: (message: string) => void,
): Promise<PreparedBackup> {
  if (file.size === 0 || file.size > BACKUP_LIMITS.compressed)
    throw new BackupError('Нужен ZIP резервной копии до 128 МБ.');
  const buffer = await file.arrayBuffer();
  signal.throwIfAborted();
  const entries = inspectZip(buffer, {
    limits: BACKUP_LIMITS,
    requireEpubMimetype: false,
  });
  const zip = await JSZip.loadAsync(buffer, {
    checkCRC32: false,
    createFolders: false,
  });
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  if (
    !manifestEntry ||
    manifestEntry.size > 1024 * 1024 ||
    entries.some((e) => e.name !== e.rawName)
  )
    throw new BackupError('Нет корректного manifest.json.');
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) throw new BackupError('Manifest не найден.');
  const manifest = manifestOf(
    parse(await boundedRead(manifestFile, manifestEntry, signal, 1024 * 1024)),
  );
  const declared = new Map(manifest.entries.map((e) => [e.path, e]));
  if (
    declared.size !== manifest.entries.length ||
    entries.length !== manifest.entries.length + 1 ||
    Object.values(zip.files).some((e) => e.dir)
  )
    throw new BackupError('Повторные или лишние файлы в архиве.');
  const data = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const entry of entries) {
    signal.throwIfAborted();
    if (entry.name === 'manifest.json') continue;
    const expected = declared.get(entry.name),
      item = zip.file(entry.rawName);
    if (
      !expected ||
      !item ||
      expected.size !== entry.size ||
      (entry.name.endsWith('.json') && entry.size > BACKUP_LIMITS.json)
    )
      throw new BackupError(
        'Размеры или список файлов не совпадают с manifest.',
      );
    progress(
      `Проверяем ${String(data.size + 1)} из ${String(manifest.entries.length)}…`,
    );
    const bytes = await boundedRead(item, entry, signal, BACKUP_LIMITS.entry);
    if ((await sha256(bytes.buffer)) !== expected.sha256)
      throw new BackupError(`Контрольная сумма не совпадает: ${entry.name}.`);
    if (
      entry.name.startsWith('blobs/') &&
      entry.name !== `blobs/${expected.sha256}.bin`
    )
      throw new BackupError('Имя Blob не соответствует контрольной сумме.');
    data.set(entry.name, bytes);
  }
  const usedBlobs = new Set<string>();
  const hydrate = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(hydrate);
    if (object(value)) {
      if ('$blob' in value) {
        if (
          Object.keys(value).length !== 2 ||
          typeof value.$blob !== 'string' ||
          !/^blobs\/[a-f0-9]{64}\.bin$/.test(value.$blob) ||
          typeof value.type !== 'string' ||
          value.type.length > 100
        )
          throw new BackupError('Некорректная ссылка на Blob.');
        const bytes = data.get(value.$blob);
        if (!bytes) throw new BackupError('В архиве отсутствует Blob.');
        usedBlobs.add(value.$blob);
        return new Blob([bytes], { type: value.type });
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, hydrate(item)]),
      );
    }
    return value;
  };
  const tables = {} as BackupTables;
  let recordCount = 0;
  for (const name of backupTables) {
    const bytes = data.get(`tables/${name}.json`);
    if (!bytes) throw new BackupError(`Нет таблицы ${name}.`);
    const records = hydrate(parse(bytes));
    if (
      !Array.isArray(records) ||
      (recordCount += records.length) > BACKUP_LIMITS.records
    )
      throw new BackupError('Слишком много записей в копии.');
    // The mapped assignment is constructed table-by-table only after full runtime validation.
    Object.assign(tables, {
      [name]: records.map((record: unknown) =>
        decodeBackupRecord(name, record),
      ),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  if (
    data.size !== backupTables.length + usedBlobs.size ||
    (!manifest.includesFiles &&
      (tables.bookFiles.length ||
        tables.epubIndexes.length ||
        tables.documentTextIndexes.length))
  )
    throw new BackupError('Содержимое архива не соответствует его типу.');
  validateBackupGraph(tables);
  for (const book of tables.books)
    if (book.cover) {
      const bytes = new Uint8Array(await book.cover.arrayBuffer());
      const valid =
        book.cover.type === 'image/png'
          ? bytes[0] === 137 &&
            bytes[1] === 80 &&
            bytes[2] === 78 &&
            bytes[3] === 71
          : book.cover.type === 'image/jpeg'
            ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            : new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
              new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
      if (!valid) throw new BackupError('Повреждена обложка книги.');
      rasterCover(bytes, book.cover.type);
    }
  for (const source of tables.bookFiles) {
    signal.throwIfAborted();
    progress(`Проверяем безопасность книги «${source.name}»…`);
    const analysis = await adapter.analyze(
      {
        name:
          source.mediaType === 'application/x-fictionbook+xml'
            ? 'backup.fb2'
            : 'backup.epub',
        size: source.data.size,
        type: source.mediaType,
        arrayBuffer: () => source.data.arrayBuffer(),
      },
      signal,
      progress,
    );
    if (source.sha256 && analysis.sha256 !== source.sha256)
      throw new BackupError('SHA-256 книги не совпадает с записью.');
    if (
      source.representation &&
      (analysis.representation?.sha256 !== source.representation.sha256 ||
        (await sha256(await source.representation.data.arrayBuffer())) !==
          source.representation.sha256)
    )
      throw new BackupError('Повреждено представление FB2.');
    const index = tables.epubIndexes.find((i) => i.bookFileId === source.id);
    if (
      index &&
      JSON.stringify([
        index.packagePath,
        index.epubVersion,
        index.manifest,
        index.spine,
        index.navigation,
        index.sections,
      ]) !==
        JSON.stringify([
          analysis.packagePath,
          analysis.version,
          analysis.manifest,
          analysis.spine,
          analysis.navigation,
          analysis.sections,
        ])
    )
      throw new BackupError(
        'Индекс книги не соответствует оригинальному файлу.',
      );
  }
  signal.throwIfAborted();
  for (const session of tables.sessions) {
    delete session.leaseKey;
    delete session.leaseUntil;
    delete session.ownerId;
    if (session.mode) session.state = 'paused';
  }
  return { manifest, tables };
}
