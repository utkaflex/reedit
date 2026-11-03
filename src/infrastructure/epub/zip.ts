import JSZip from 'jszip';
import { checkImportCancelled, EpubImportError } from '../../domain/epub';
import { hasControlCharacters } from './characters';

export const EPUB_LIMITS = {
  compressed: 32 * 1024 * 1024,
  unpacked: 64 * 1024 * 1024,
  entry: 8 * 1024 * 1024,
  entries: 2048,
  textCharacters: 16 * 1024 * 1024,
};
export interface ZipEntry {
  name: string;
  rawName: string;
  size: number;
  crc: number;
}
const fail = (message: string): never => {
  throw new EpubImportError('corrupt', message);
};
export function safeArchivePath(value: string): string {
  if (
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes(':') ||
    hasControlCharacters(value)
  )
    throw new EpubImportError('unsafe', 'Небезопасный путь внутри EPUB.');
  const parts = value.normalize('NFC').split('/');
  if (parts.some((part) => part === '..' || part === '.'))
    throw new EpubImportError('unsafe', 'Путь в ZIP выходит за границы книги.');
  return parts.join('/');
}
/** Narrow header preflight only: JSZip owns ZIP/DEFLATE decoding. Rejects bombs and aliasing before decoding. */
export function inspectZip(
  buffer: ArrayBuffer,
  options: {
    limits: Pick<typeof EPUB_LIMITS, 'entry' | 'entries' | 'unpacked'>;
    requireEpubMimetype: boolean;
  } = { limits: EPUB_LIMITS, requireEpubMimetype: true },
): ZipEntry[] {
  const limits = options.limits;
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 22 || view.getUint32(0, true) !== 0x04034b50)
    return fail('Файл не является ZIP-контейнером EPUB.');
  let end = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 65557);
    offset--
  )
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.length
    ) {
      end = offset;
      break;
    }
  if (end < 0) return fail('Повреждён ZIP: не найден каталог архива.');
  const count = view.getUint16(end + 10, true);
  const directory = view.getUint32(end + 16, true);
  const directorySize = view.getUint32(end + 12, true);
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    count !== view.getUint16(end + 8, true) ||
    directory === 0xffffffff ||
    count === 65535
  )
    throw new EpubImportError(
      'format',
      'Многотомный ZIP и ZIP64 пока не поддерживаются.',
    );
  if (count === 0 || count > limits.entries)
    throw new EpubImportError(
      'limit',
      'Слишком много ресурсов в EPUB (максимум 2048).',
    );
  if (directory + directorySize !== end) return fail('Повреждён каталог ZIP.');
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  const ranges: [number, number][] = [];
  let offset = directory;
  let total = 0;
  let hasMimetype = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
      return fail('Повреждена запись каталога ZIP.');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressed = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const length = view.getUint16(offset + 28, true);
    const extra = view.getUint16(offset + 30, true);
    const comment = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    if (flags & 1 || flags & 64)
      throw new EpubImportError(
        'drm',
        'Зашифрованный ZIP/DRM не поддерживается. Нужен EPUB без защиты.',
      );
    if (![0, 8].includes(method))
      throw new EpubImportError(
        'format',
        'Неподдерживаемый способ сжатия ZIP.',
      );
    if (offset + 46 + length + extra + comment > end || local + 30 > directory)
      return fail('Повреждены границы ресурсов ZIP.');
    const rawName = decoder.decode(
      bytes.subarray(offset + 46, offset + 46 + length),
    );
    const name = safeArchivePath(rawName);
    if (names.has(name))
      return fail('В ZIP повторяются пути ресурсов. Импорт неоднозначен.');
    names.add(name);
    if (
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 6, true) !== flags ||
      view.getUint16(local + 8, true) !== method
    )
      return fail('Локальный заголовок ZIP не совпадает с каталогом.');
    const localNameLength = view.getUint16(local + 26, true);
    const localExtra = view.getUint16(local + 28, true);
    const dataStart = local + 30 + localNameLength + localExtra;
    if (
      view.getUint16(offset + 34, true) !== 0 ||
      (!(flags & 8) &&
        (view.getUint32(local + 14, true) !== crc ||
          view.getUint32(local + 18, true) !== compressed ||
          view.getUint32(local + 22, true) !== size))
    )
      return fail(
        'ZIP: локальные размеры/CRC или номер тома не совпадают с каталогом.',
      );
    if (
      dataStart + compressed > directory ||
      decoder.decode(
        bytes.subarray(local + 30, local + 30 + localNameLength),
      ) !== rawName
    )
      return fail('Некорректная ссылка на данные ZIP.');
    const unixMode = view.getUint32(offset + 38, true) >>> 16;
    if ((unixMode & 0xf000) === 0xa000)
      throw new EpubImportError(
        'unsafe',
        'Символические ссылки в EPUB не поддерживаются.',
      );
    if (size > limits.entry || compressed === 0xffffffff || size === 0xffffffff)
      throw new EpubImportError(
        'limit',
        'Один ресурс EPUB превышает лимит 8 МБ или использует ZIP64.',
      );
    total += size;
    if (total > limits.unpacked)
      throw new EpubImportError(
        'limit',
        'Распакованный EPUB превышает лимит 64 МБ.',
      );
    ranges.push([local, dataStart + compressed]);
    if (name === 'mimetype' && options.requireEpubMimetype) {
      if (
        local !== 0 ||
        method !== 0 ||
        flags & 8 ||
        localExtra !== 0 ||
        decoder.decode(bytes.subarray(dataStart, dataStart + compressed)) !==
          'application/epub+zip'
      )
        return fail(
          'Некорректный mimetype EPUB: он должен быть первым несжатым ресурсом.',
        );
      hasMimetype = true;
    }
    if (!name.endsWith('/')) entries.push({ name, rawName, size, crc });
    offset += 46 + length + extra + comment;
  }
  if (offset !== end || (options.requireEpubMimetype && !hasMimetype))
    return fail('В архиве нет обязательного mimetype EPUB.');
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) {
    const previous = ranges[i - 1];
    const current = ranges[i];
    if (previous && current && previous[1] > current[0])
      return fail('Ресурсы ZIP перекрываются.');
  }
  return entries;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++)
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
export async function boundedRead(
  file: JSZip.JSZipObject,
  entry: ZipEntry,
  signal: AbortSignal,
  limit = EPUB_LIMITS.entry,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const stream = file.internalStream('uint8array');
    const chunks: Uint8Array[] = [];
    let size = 0;
    let crc = 0xffffffff;
    let settled = false;
    const stop = (error: unknown) => {
      if (settled) return;
      settled = true;
      stream.pause();
      signal.removeEventListener('abort', cancel);
      reject(
        error instanceof Error
          ? error
          : new EpubImportError(
              'corrupt',
              'Не удалось распаковать ресурс EPUB.',
            ),
      );
    };
    const cancel = () => {
      stop(
        new EpubImportError(
          'cancelled',
          'Импорт отменён. Ничего не сохранено.',
        ),
      );
    };
    signal.addEventListener('abort', cancel, { once: true });
    stream
      .on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (signal.aborted) {
          cancel();
          return;
        }
        if (size > entry.size || size > limit) {
          stop(
            new EpubImportError(
              'limit',
              `Ресурс ${entry.name} распаковывается за пределами объявленного размера.`,
            ),
          );
          return;
        }
        for (const value of chunk)
          crc = (crcTable[(crc ^ value) & 255] ?? 0) ^ (crc >>> 8);
        chunks.push(chunk);
      })
      .on('error', stop)
      .on('end', () => {
        if (settled) return;
        if (size !== entry.size || (crc ^ 0xffffffff) >>> 0 !== entry.crc) {
          stop(
            new EpubImportError(
              'corrupt',
              `Повреждён ресурс ${entry.name}: размер или CRC не совпадает.`,
            ),
          );
          return;
        }
        settled = true;
        signal.removeEventListener('abort', cancel);
        const result = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        resolve(result);
      });
    if (signal.aborted) cancel();
    else stream.resume();
  });
}
export async function readZip(
  buffer: ArrayBuffer,
  signal: AbortSignal,
  progress: (message: string) => void,
): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  const entries = inspectZip(buffer);
  checkImportCancelled(signal);
  const zip = await JSZip.loadAsync(buffer, {
    createFolders: false,
    checkCRC32: false,
  });
  const result = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const [index, entry] of entries.entries()) {
    checkImportCancelled(signal);
    progress(
      `Проверяем ресурсы: ${String(index + 1)} из ${String(entries.length)}`,
    );
    const file = zip.file(entry.rawName);
    if (!file) return fail(`Ресурс ${entry.name} не найден в ZIP.`);
    result.set(entry.name, await boundedRead(file, entry, signal));
  }
  return result;
}
