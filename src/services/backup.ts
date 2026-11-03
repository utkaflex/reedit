import type { LocalStore } from '../domain/repositories';
import type { EpubAdapter } from '../domain/epub';
export async function exportLibrary(
  store: LocalStore,
  includeFiles: boolean,
  signal: AbortSignal,
  progress: (message: string) => void,
): Promise<Blob> {
  const { createArchive } = await import('../infrastructure/backup/archive');
  const snapshot = await store.readBackup();
  signal.throwIfAborted();
  return createArchive(snapshot.tables, includeFiles, signal, progress);
}
export async function inspectBackup(
  file: Blob,
  adapter: EpubAdapter,
  signal: AbortSignal,
  progress: (message: string) => void,
) {
  const { prepareArchive } = await import('../infrastructure/backup/archive');
  try {
    return await prepareArchive(file, adapter, signal, progress);
  } catch (error) {
    if (signal.aborted)
      throw new Error('Проверка отменена. Библиотека не изменена.', {
        cause: error,
      });
    throw new Error(
      `Резервная копия не прошла проверку: ${error instanceof Error ? error.message : 'повреждён архив'}`,
      { cause: error },
    );
  }
}
