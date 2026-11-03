import type { LocalStore } from '../domain/repositories';
export type StorageStatus =
  | { state: 'checking' }
  | { state: 'ready' }
  | { state: 'error'; message: string };
export async function checkStorage(store: LocalStore): Promise<StorageStatus> {
  try {
    await store.checkAvailability();
    return { state: 'ready' };
  } catch (error) {
    return {
      state: 'error',
      message: error instanceof Error ? error.message : 'Хранилище недоступно.',
    };
  }
}
