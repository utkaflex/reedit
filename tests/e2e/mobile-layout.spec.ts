import { libraryAction } from '../fixtures/library-actions';
import { expect, test } from '@playwright/test';
import { makeEpubFixture } from '../fixtures/epub';

test('зависший движок показывает ошибку с повтором, а книга остаётся в библиотеке', async ({
  page,
}) => {
  const fixture = await makeEpubFixture({ title: 'Проверка зависания' });
  await page.goto('/');
  await libraryAction(page, 'upload');
  await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
    name: 'deadline.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(fixture.bytes),
  });
  await page
    .getByRole('button', { name: 'Создать книгу и сохранить EPUB' })
    .click();
  await page.screenshot({
    path: test.info().outputPath('book-details.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.evaluate(async () => {
    const path = '/src/infrastructure/DocumentAdapter.ts';
    const module: unknown = await import(path);
    (
      module as typeof import('../../src/infrastructure/DocumentAdapter')
    ).DocumentAdapter.prototype.openReader = () =>
      new Promise<never>(() => undefined);
  });
  await page.clock.install();
  await page
    .getByRole('button', { name: 'Читать файл deadline.epub', exact: true })
    .click();
  await expect(page.locator('.reader-message')).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        root: getComputedStyle(document.documentElement).backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
        theme: document
          .querySelector('meta[name="theme-color"]')
          ?.getAttribute('content'),
      })),
    )
    .toEqual({
      root: 'rgb(255, 254, 250)',
      body: 'rgb(255, 254, 250)',
      theme: '#fffefa',
    });
  await page.clock.fastForward(61000);
  await expect(page.getByRole('alert')).toContainText('слишком много времени');
  await expect(
    page.getByRole('button', { name: 'Повторить открытие' }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('opening-error.png'),
    scale: 'css',
  });
  await page.getByRole('link', { name: 'К библиотеке', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.style.backgroundColor),
    )
    .toBe('');
  await expect(
    page.getByRole('list', { name: 'Книги библиотеки' }),
  ).toContainText('Проверка зависания');
});
for (const width of [320, 390]) {
  test(`мобильные действия и фильтры не разрывают слова и не растягивают страницу: ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'Добавить', exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole('button', { name: 'Загрузить книгу', exact: true }),
    ).toBeVisible();
    for (const route of ['quotes', 'statistics']) {
      await page.goto(`/#/${route}`);
      await expect(page.locator(`.page--${route}`)).toBeVisible();
      if (route === 'statistics')
        await expect(page.getByLabel('Год', { exact: true })).toBeVisible();
      else
        await expect(
          page.getByRole('heading', {
            name: 'Слова, к которым хочется вернуться',
          }),
        ).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
      const fields = await page
        .locator('.field__input')
        .evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.width === 0 || (rect.left >= 0 && rect.right <= innerWidth)
            );
          }),
        );
      if (route === 'statistics') expect(fields.length).toBeGreaterThan(0);
      expect(fields.every(Boolean)).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`${route}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
    await page.screenshot({
      path: test.info().outputPath('statistics.png'),
      fullPage: true,
      animations: 'disabled',
    });
  });
}
