import { CatalogError } from '../../domain/catalog';

export interface CatalogTransport {
  json(
    path: string,
    signal: AbortSignal,
  ): Promise<{ value: unknown; cached: boolean; expiresAt: number }>;
}
function offline(): boolean {
  const state: unknown =
    typeof navigator === 'undefined'
      ? undefined
      : Reflect.get(navigator, 'onLine');
  return state === false;
}
/** Bounded memory cache, no persisted search history. Each consumer owns cancellation. */
export class HttpCatalogTransport implements CatalogTransport {
  private cache = new Map<string, { value: unknown; expiresAt: number }>();
  private blocked = new Map<string, number>();
  constructor(
    private fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private now = () => Date.now(),
  ) {}
  async json(path: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const previous = this.cache.get(path);
    if (previous && previous.expiresAt > this.now())
      return { ...previous, cached: true };
    if (offline())
      throw new CatalogError(
        'offline',
        'Нет интернета. Локальная библиотека и ручное добавление доступны.',
      );
    const source = path.split('/')[0] ?? 'catalog';
    const blockedUntil = this.blocked.get(source) ?? 0;
    if (blockedUntil > this.now())
      throw new CatalogError(
        'rate-limit',
        'Каталог просит подождать перед повторным запросом.',
        blockedUntil,
      );
    let response: Response;
    try {
      response = await this.fetcher(`/api/catalog/${path}`, {
        signal,
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new CatalogError(
        'network',
        error instanceof Error && error.name === 'TimeoutError'
          ? 'Каталог не ответил вовремя.'
          : 'Не удалось связаться с каталогом. Проверьте интернет и доступность сервиса каталогов.',
      );
    }
    if (!response.ok) {
      const seconds = Number(response.headers.get('Retry-After'));
      if (response.status === 429) {
        const retryAt =
          this.now() +
          (Number.isFinite(seconds) && seconds > 0
            ? Math.min(seconds, 3600)
            : 60) *
            1000;
        this.blocked.set(source, retryAt);
        throw new CatalogError(
          'rate-limit',
          'Достигнут лимит запросов каталога. Повторите позже.',
          retryAt,
        );
      }
      throw new CatalogError(
        'unavailable',
        response.status === 503
          ? 'Источник не настроен или временно недоступен. Попробуйте другой каталог.'
          : 'Каталог не смог выполнить запрос. Повторите позже.',
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new CatalogError('invalid', 'Каталог вернул некорректный ответ.');
    }
    signal.throwIfAborted();
    const match = /(?:^|,)\s*max-age=(\d+)/i.exec(
      response.headers.get('Cache-Control') ?? '',
    );
    const ttl = Math.min(600, Number(match?.[1] ?? 0));
    const expiresAt = this.now() + ttl * 1000;
    if (ttl > 0) {
      this.cache.delete(path);
      this.cache.set(path, { value, expiresAt });
      while (this.cache.size > 60) {
        const first = this.cache.keys().next().value;
        if (first) this.cache.delete(first);
        else break;
      }
    }
    return {
      value,
      expiresAt,
      cached: response.headers.get('X-Catalog-Cache') === 'hit',
    };
  }
}
