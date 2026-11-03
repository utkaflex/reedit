import { expect, test, type Page } from '@playwright/test';
import { makeEpubFixture } from '../fixtures/epub';
async function open(page: Page, long = false) {
  const fixture = await makeEpubFixture({
    title: 'Текст для скорочтения',
    chapters: [
      {
        name: 'a.xhtml',
        text: 'Первое второе третье. Четвёртое пятое.',
        ...(long
          ? {
              markup: `<p>${'Спокойный русский текст без пропусков. '.repeat(12)}</p>`,
            }
          : {}),
      },
      { name: 'b.xhtml', text: 'Шестое седьмое восьмое.' },
    ],
    toc: [0],
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Импорт EPUB', exact: true }).click();
  await page.getByLabel('Файл EPUB', { exact: true }).setInputFiles({
    name: 'speed.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(fixture.bytes),
  });
  await page
    .getByRole('button', { name: 'Создать книгу и сохранить EPUB' })
    .click();
  await page.getByRole('button', { name: 'Читать файл speed.epub' }).click();
  await expect(
    page.getByRole('button', { name: 'Скорочтение', exact: true }),
  ).toBeEnabled({ timeout: 20000 });
}
async function mode(page: Page, name: 'RSVP' | 'Guided') {
  await page.getByRole('button', { name: 'Скорочтение', exact: true }).click();
  await page
    .getByRole('button', {
      name:
        name === 'RSVP'
          ? 'RSVP — по одному слову'
          : 'Guided Reading — в тексте',
    })
    .click();
  await expect(
    page.getByRole('button', { name: 'Продолжить', exact: true }),
  ).toBeEnabled({ timeout: 20000 });
}
async function saved(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/infrastructure/local-store.ts';
    const loaded: unknown = await import(path);
    const { createLocalStore } =
      loaded as typeof import('../../src/infrastructure/local-store');
    const store = createLocalStore();
    try {
      return (await store.repositories.positions.list())[0]?.cursor ?? null;
    } finally {
      store.close();
    }
  });
}
test('RSVP: точная передача, шаги, конец spine, возврат и перезапуск', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page);
  const entry = await saved(page);
  await mode(page, 'RSVP');
  await expect(page.getByLabel('Текущее слово', { exact: true })).toHaveText(
    'Первое',
  );
  await page.getByRole('button', { name: 'Вперёд по словам' }).click();
  await expect(page.getByLabel('Текущее слово', { exact: true })).toHaveText(
    'второе',
  );
  await page.getByRole('button', { name: 'Назад по словам' }).click();
  await expect(page.getByLabel('Текущее слово', { exact: true })).toHaveText(
    'Первое',
  );
  expect(await saved(page)).toMatchObject({ ...entry, anchor: 'word' });
  await page.getByRole('button', { name: /WPM · Настройки/ }).click();
  const slider = page.getByRole('slider');
  await slider.focus();
  await slider.press('End');
  await page
    .getByRole('button', { name: 'Применить настройки', exact: true })
    .click();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(
    page.getByText('Книга закончилась', { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('speed-ordinal')).toHaveText('8 / 8');
  await expect(page.getByLabel('Текущее слово', { exact: true })).toHaveText(
    'восьмое.',
  );
  await page.screenshot({
    path: test.info().outputPath('rsvp-end.png'),
    scale: 'css',
  });
  const end = await saved(page);
  expect(end?.spineIndex).toBe(1);
  await page
    .getByRole('button', { name: 'Обычное чтение', exact: true })
    .click();
  await expect(page.locator('.speed-word-highlight').first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Скорочтение', exact: true }),
  ).toBeVisible();
  expect(await saved(page)).toEqual(end);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Скорочтение' })).toBeEnabled({
    timeout: 20000,
  });
  expect(await saved(page)).toEqual(end);
  expect(errors).toEqual([]);
});
test('Guided: окно слов, видимая подсветка, касание и сворачивание сохраняют позицию', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await open(page, true);
  await mode(page, 'Guided');
  await expect(page.locator('.speed-word-highlight').first()).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('guided-paused.png'),
    scale: 'css',
  });
  const start = await saved(page);
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect.poll(() => saved(page)).not.toEqual(start);
  await page
    .frameLocator('iframe')
    .locator('p')
    .first()
    .click({ position: { x: 40, y: 20 } });
  await expect(
    page.getByRole('button', { name: 'Продолжить', exact: true }),
  ).toBeVisible();
  const paused = await saved(page);
  await page.waitForTimeout(600);
  expect(await saved(page)).toEqual(paused);
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(
    page.getByRole('button', { name: 'Продолжить', exact: true }),
  ).toBeVisible();
  const hidden = await saved(page);
  await page.waitForTimeout(600);
  expect(await saved(page)).toEqual(hidden);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page
    .getByRole('button', { name: 'Обычное чтение', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Скорочтение', exact: true }),
  ).toBeVisible();
  expect(await saved(page)).toEqual(hidden);
  await mode(page, 'Guided');
  await page.getByRole('button', { name: /WPM · Настройки/ }).click();
  const slider = page.getByRole('slider');
  await slider.focus();
  await slider.press('End');
  await page
    .getByRole('spinbutton', { name: 'Слов в подсветке', exact: true })
    .fill('12');
  await page
    .getByRole('button', { name: 'Применить настройки', exact: true })
    .click();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(
    page.getByText('Книга закончилась', { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('speed-ordinal')).toHaveText('63 / 63');
  expect((await saved(page))?.spineIndex).toBe(1);
  await expect(page.locator('.speed-word-highlight').first()).toBeVisible();
  await page
    .getByRole('button', { name: 'Обычное чтение', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Скорочтение', exact: true }),
  ).toBeVisible();

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
