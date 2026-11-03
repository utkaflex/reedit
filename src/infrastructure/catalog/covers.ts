import { copyCover } from '../cover';
import { coverUrl } from './providers';

export async function copyCatalogCover(
  url: string,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await fetch(coverUrl(url), { signal, credentials: 'omit' });
  if (!response.ok)
    throw new Error(
      'Обложка недоступна. Выберите другую или сохраните книгу без обложки.',
    );
  const blob = await response.blob();
  signal.throwIfAborted();
  return copyCover(new File([blob], 'catalog-cover', { type: blob.type }));
}
