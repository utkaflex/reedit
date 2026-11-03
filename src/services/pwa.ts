export interface PwaState {
  phase:
    'development' | 'unsupported' | 'preparing' | 'ready' | 'update' | 'error';
  message: string;
  updating: boolean;
}
let state: PwaState = {
  phase: import.meta.env.PROD ? 'preparing' : 'development',
  message: '',
  updating: false,
};
const listeners = new Set<() => void>();
let registration: ServiceWorkerRegistration | null = null;
let started = false;
let reloadRequested = false;
const publish = (next: Partial<PwaState>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};
export const pwaSnapshot = () => state;
export const subscribePwa = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function send(worker: ServiceWorker, message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error('Приложение не ответило. Повторите попытку.'));
    }, 10000);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(event.data);
    };
    worker.postMessage(message, [channel.port2]);
  });
}
export function startPwa(): void {
  if (started || !import.meta.env.PROD) return;
  started = true;
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    publish({
      phase: 'unsupported',
      message: 'Офлайн-оболочка требует HTTPS и поддержки Service Worker.',
    });
    return;
  }
  const inspect = () => {
    if (registration?.waiting)
      publish({
        phase: 'update',
        message: 'Доступна новая версия. Открытая книга не будет прервана.',
      });
    else if (registration?.active)
      publish({
        phase: 'ready',
        message:
          'Интерфейс и все разделы доступны без интернета. Книги хранятся на устройстве.',
      });
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const requested = reloadRequested;
    reloadRequested = false;
    if (requested && !window.location.hash.startsWith('#/reading'))
      window.location.reload();
    else {
      publish({ updating: false });
      inspect();
    }
  });
  void navigator.serviceWorker
    .register('/sw.js', { scope: '/', updateViaCache: 'none' })
    .then((value) => {
      registration = value;
      inspect();
      value.addEventListener('updatefound', () => {
        const installing = value.installing;
        installing?.addEventListener('statechange', () => {
          if (
            installing.state === 'installed' ||
            installing.state === 'activated'
          )
            inspect();
          if (installing.state === 'redundant' && !value.active)
            publish({
              phase: 'error',
              message:
                'Не удалось подготовить интерфейс для офлайн-работы. Проверьте подключение и свободное место.',
            });
        });
      });
      return navigator.serviceWorker.ready;
    })
    .then(() => {
      inspect();
      const controller = navigator.serviceWorker.controller;
      if (controller)
        void send(controller, { type: 'CLEAN', build: __REEDIT_BUILD__ }).catch(
          () => undefined,
        );
    })
    .catch(() => {
      publish({
        phase: 'error',
        message:
          'Офлайн-оболочка не подготовлена. Проверьте подключение и свободное место, затем повторите загрузку.',
      });
    });
}
export async function checkPwaUpdate(): Promise<void> {
  try {
    await registration?.update();
    publish({
      message: registration?.waiting
        ? 'Обновление готово к установке.'
        : 'Проверка завершена. Новая версия не обнаружена.',
    });
  } catch {
    publish({
      message:
        'Не удалось проверить обновление. Попробуйте при подключении к интернету.',
    });
  }
}
export async function activateUpdate(): Promise<void> {
  if (
    !registration?.waiting ||
    window.location.hash.startsWith('#/reading') ||
    document.querySelector('dialog[open]')
  )
    return;
  publish({
    updating: true,
    message: 'Проверяем, можно ли безопасно обновиться…',
  });
  try {
    reloadRequested = true;
    const response = await send(registration.waiting, {
      type: 'ACTIVATE_IF_IDLE',
    });
    if (
      !response ||
      typeof response !== 'object' ||
      !('ok' in response) ||
      response.ok !== true
    ) {
      reloadRequested = false;
      publish({
        updating: false,
        message:
          response &&
          typeof response === 'object' &&
          'reason' in response &&
          typeof response.reason === 'string'
            ? response.reason
            : 'Обновление отложено. Закройте другие окна Reedit.',
      });
    } else publish({ message: 'Применяем обновление…' });
  } catch (error) {
    reloadRequested = false;
    publish({
      updating: false,
      message:
        error instanceof Error ? error.message : 'Не удалось обновиться.',
    });
  }
}
export interface StorageCapacity {
  usage: number | null;
  quota: number | null;
  persistent: boolean | null;
}
function storageApi(): Partial<StorageManager> | undefined {
  const value: unknown = Reflect.get(navigator, 'storage');
  return value && typeof value === 'object' ? value : undefined;
}
export async function storageCapacity(): Promise<StorageCapacity> {
  const result: StorageCapacity = {
    usage: null,
    quota: null,
    persistent: null,
  };
  try {
    const estimate = await storageApi()?.estimate?.();
    if (Number.isFinite(estimate?.usage))
      result.usage = estimate?.usage ?? null;
    if (Number.isFinite(estimate?.quota))
      result.quota = estimate?.quota ?? null;
  } catch {
    /* The application still works if estimates are withheld. */
  }
  try {
    result.persistent = (await storageApi()?.persisted?.()) ?? null;
  } catch {
    /* Feature is optional. */
  }
  return result;
}
export async function requestPersistence(): Promise<boolean | null> {
  const storage = storageApi();
  if (!storage?.persist) return null;
  return storage.persist();
}
