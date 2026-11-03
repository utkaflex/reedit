import { expect, test, type Page } from '@playwright/test';
import { makeEpubFixture } from '../fixtures/epub';

async function totals(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/infrastructure/local-store.ts';
    const loaded: unknown = await import(path);
    const { createLocalStore } =
      loaded as typeof import('../../src/infrastructure/local-store');
    const store = createLocalStore();
    try {
      const data = await store.readStatistics();
      return {
        events: data.activities.length,
        milliseconds: data.activities.reduce((n, e) => n + e.milliseconds, 0),
        words: data.activities.reduce(
          (n, e) => n + e.intervals.reduce((v, i) => v + i.end - i.start, 0),
          0,
        ),
        modes: [
          ...new Set(
            data.activities
              .filter((e) => e.intervals.length)
              .map((e) => e.mode),
          ),
        ],
        sessions: data.sessions.length,
        activeSessions: data.sessions.filter((s) => s.leaseKey === 'active')
          .length,
        entries: data.journal.map((e) => e.body),
        goal: data.settings[0]?.readingGoals,
      };
    } finally {
      store.close();
    }
  });
}
async function backgroundPause(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(async () => (await totals(page)).activeSessions).toBe(0);
  const hidden = await totals(page);
  await page.waitForTimeout(1100);
  expect(await totals(page)).toEqual(hidden);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
test('бумажная книга, годовая цель и дневник сохраняются без придуманного времени', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/#/statistics');
  await page.getByRole('button', { name: 'Добавить бумажную книгу' }).click();
  await page.getByLabel('Название', { exact: true }).fill('Бумажный дневник');
  await page.getByLabel('Автор', { exact: true }).fill('Синтетический автор');
  await page.getByLabel('Жанры', { exact: true }).fill('Роман');
  await page.getByRole('button', { name: 'Добавить в библиотеку' }).click();
  await page.getByLabel('Статус', { exact: true }).selectOption('finished');
  await page.getByLabel('Дата начала', { exact: true }).fill('2026-01-02');
  await page.getByLabel('Дата завершения', { exact: true }).fill('2026-01-10');
  await page.getByLabel('Оценка', { exact: true }).selectOption('4.5');
  await page
    .getByLabel('Личный отзыв', { exact: true })
    .fill('Личный отзыв о бумажной книге.');
  await page.getByRole('button', { name: 'Сохранить прочтение' }).click();
  await page.getByLabel('Год', { exact: true }).selectOption('2026');
  await page.getByLabel('Книг за год', { exact: true }).fill('12');
  await page.getByRole('button', { name: 'Сохранить цель' }).click();
  await expect(page.getByText('1 из 12 книг', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Записать впечатление' }).click();
  await page
    .getByLabel('Впечатление', { exact: true })
    .fill('Мысль по ходу чтения.');
  await page.getByRole('button', { name: 'Сохранить запись' }).click();
  await expect(
    page.getByText('Мысль по ходу чтения.', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Редактировать запись', exact: true })
    .click();
  await page
    .getByLabel('Впечатление', { exact: true })
    .fill('Исправленная мысль.');
  await page.getByRole('button', { name: 'Сохранить запись' }).click();
  await page.reload();
  await expect(
    page.getByText('Исправленная мысль.', { exact: true }),
  ).toBeVisible();
  const saved = await totals(page);
  expect(saved).toMatchObject({
    events: 0,
    milliseconds: 0,
    words: 0,
    sessions: 0,
    entries: ['Исправленная мысль.'],
    goal: { '2026': 12 },
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('statistics-mobile.png'),
    fullPage: true,
    scale: 'css',
  });
  await page
    .getByRole('button', { name: 'Удалить запись', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Удалить запись дневника?' });
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect((await totals(page)).entries).toEqual(['Исправленная мысль.']);
  await page
    .getByRole('button', { name: 'Удалить запись', exact: true })
    .click();
  await dialog
    .getByRole('button', { name: 'Удалить запись', exact: true })
    .click();
  await expect.poll(async () => (await totals(page)).entries).toEqual([]);
});

test('время и слова трёх режимов сохраняются; навигация и повторная загрузка не удваивают текст', async ({
  page,
}) => {
  const fixture = await makeEpubFixture({
    title: 'Синтетическая книга для статистики',
    chapters: [
      { name: 'a.xhtml', text: 'Первое второе третье. Четвёртое пятое.' },
      { name: 'b.xhtml', text: 'Шестое седьмое восьмое.' },
    ],
    toc: [0],
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Импорт EPUB', exact: true }).click();
  await page.getByLabel('Файл EPUB', { exact: true }).setInputFiles({
    name: 'stats.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(fixture.bytes),
  });
  await page
    .getByRole('button', { name: 'Создать книгу и сохранить EPUB' })
    .click();
  await page.getByRole('button', { name: 'Читать файл stats.epub' }).click();
  const speedButton = page.getByRole('button', {
    name: 'Скорочтение',
    exact: true,
  });
  await expect(speedButton).toBeEnabled({ timeout: 20000 });
  expect((await totals(page)).words).toBe(0);
  await backgroundPause(page);
  await page
    .getByRole('button', { name: 'Следующая страница', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Предыдущая страница', exact: true })
    .click();
  expect((await totals(page)).words).toBe(0);
  const confirm = page.getByRole('button', {
    name: 'Фрагмент прочитан',
    exact: true,
  });
  await expect(confirm).toBeEnabled({ timeout: 15000 });
  await confirm.click();
  await expect(confirm).toBeDisabled();
  await expect
    .poll(async () => (await totals(page)).words, { timeout: 10000 })
    .toBeGreaterThan(0);
  const normal = (await totals(page)).words;
  await speedButton.click();
  await page.getByRole('button', { name: 'RSVP — по одному слову' }).click();
  await expect(
    page.getByRole('button', { name: 'Продолжить', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Вперёд по словам' }).click();
  expect((await totals(page)).words).toBe(normal);
  await page.getByRole('button', { name: /WPM · Настройки/ }).click();
  await page.getByRole('slider').focus();
  await page.getByRole('slider').press('End');
  await page
    .getByRole('button', { name: 'Применить настройки', exact: true })
    .click();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await backgroundPause(page);
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(
    page.getByText('Книга закончилась', { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await page
    .getByRole('button', { name: 'Обычное чтение', exact: true })
    .click();
  await speedButton.click();
  await page.getByRole('button', { name: 'Guided Reading — в тексте' }).click();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(
    page.getByText('Книга закончилась', { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await page
    .getByRole('button', { name: 'Обычное чтение', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Закрыть книгу', exact: true })
    .click();
  await expect(page).toHaveURL(/#\/library$/);
  await page.goto('/#/statistics');
  await page.getByText('Подробная статистика', { exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Ритм чтения', exact: true }),
  ).toBeVisible();
  const before = await totals(page);
  expect([...before.modes].sort()).toEqual(['guided', 'ordinary', 'rsvp']);
  expect(before.milliseconds).toBeGreaterThan(0);
  await page.reload();
  await page.getByText('Подробная статистика', { exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Ритм чтения', exact: true }),
  ).toBeVisible();
  expect(await totals(page)).toEqual(before);
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
});
