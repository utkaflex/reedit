import { newId, type Settings } from '../domain/model';
import type { Repository } from '../domain/repositories';

export type Theme = Settings['theme'];
export async function loadAppearance(
  repository: Repository<'settings'>,
): Promise<Settings | undefined> {
  return (await repository.list())[0];
}
export async function saveAppearance(
  repository: Repository<'settings'>,
  theme: Theme,
): Promise<Settings> {
  // Re-read before saving to preserve existing identity, timestamps and preferences.
  const existing = await loadAppearance(repository);
  const now = Date.now();
  const settings: Settings = existing
    ? { ...existing, theme, updatedAt: Math.max(now, existing.updatedAt) }
    : {
        id: newId(),
        createdAt: now,
        updatedAt: now,
        key: 'local',
        theme,
        locale: 'ru',
      };
  await repository.save(settings, {
    expectedUpdatedAt: existing?.updatedAt ?? null,
  });
  return settings;
}
