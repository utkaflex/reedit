import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { newId } from '../src/domain/model';
import { ReeditDatabase } from '../src/infrastructure/database';
import { createLocalStore } from '../src/infrastructure/local-store';
import { loadAppearance, saveAppearance } from '../src/services/appearance';
import { parseRoute } from '../src/features/shell/navigation';

let db: ReeditDatabase;
let store: ReturnType<typeof createLocalStore>;
beforeEach(() => {
  db = new ReeditDatabase(`appearance-${newId()}`);
  store = createLocalStore(db);
});
afterEach(async () => {
  vi.restoreAllMocks();
  store.close();
  await db.delete();
});
it('чтение темы не создаёт настройки', async () => {
  expect(await loadAppearance(store.repositories.settings)).toBeUndefined();
  expect(await store.repositories.settings.list()).toEqual([]);
});
it('сохраняет тему без замены UUID и createdAt, переживает повторное открытие', async () => {
  const first = await saveAppearance(store.repositories.settings, 'dark');
  const second = await saveAppearance(store.repositories.settings, 'light');
  expect(second).toMatchObject({
    id: first.id,
    createdAt: first.createdAt,
    theme: 'light',
    locale: 'ru',
  });
  expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  store.close();
  db = new ReeditDatabase(db.name);
  store = createLocalStore(db);
  expect(await loadAppearance(store.repositories.settings)).toEqual(second);
  expect(await store.repositories.settings.list()).toHaveLength(1);
});
it('ошибка записи не меняет сохранённую тему', async () => {
  const first = await saveAppearance(store.repositories.settings, 'dark');
  vi.spyOn(store.repositories.settings, 'save').mockRejectedValueOnce(
    new Error('write failed'),
  );
  await expect(
    saveAppearance(store.repositories.settings, 'light'),
  ).rejects.toThrow('write failed');
  expect(await loadAppearance(store.repositories.settings)).toEqual(first);
});
it('разбирает только предусмотренные маршруты', () => {
  for (const hash of ['', '#', '#/', '#/library'])
    expect(parseRoute(hash)).toBe('library');
  expect(parseRoute('#/statistics')).toBe('statistics');
  expect(parseRoute('#/settings')).toBe('settings');
  expect(parseRoute('#/reading')).toBe('reading');
  for (const hash of [
    '#/unknown',
    '#/settings/extra',
    '#settings',
    '#/<script>',
  ])
    expect(parseRoute(hash)).toBe('not-found');
});
