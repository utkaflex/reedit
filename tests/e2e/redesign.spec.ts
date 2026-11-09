import { expect, test, type Page } from '@playwright/test';
import { libraryAction } from '../fixtures/library-actions';
import { makeEpubFixture } from '../fixtures/epub';

async function fits(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
}
test('пустая коллекция остаётся доступна и импорт виден над виртуальной клавиатурой', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Коллекции/ })
    .click();
  await page
    .getByRole('button', { name: 'Создать коллекцию', exact: true })
    .click();
  await page
    .getByLabel('Название коллекции', { exact: true })
    .fill('Пустая тестовая коллекция');
  await page
    .getByRole('button', { name: 'Сохранить коллекцию', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Пустая тестовая коллекция',
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.reload();
  await libraryAction(page, 'upload');
  const fixture = await makeEpubFixture();
  await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
    name: 'keyboard.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(fixture.bytes),
  });
  await expect(
    page.getByLabel('Название новой книги', { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) throw Error('No visual viewport');
    Object.defineProperty(viewport, 'height', {
      value: 360,
      configurable: true,
    });
    viewport.dispatchEvent(new Event('resize'));
  });
  const footer = page.getByRole('dialog').locator('.dialog__footer');
  await expect
    .poll(async () => (await footer.boundingBox())?.y)
    .toBeLessThan(360);
  const box = await footer.boundingBox();
  expect(box && box.y + box.height).toBeLessThanOrEqual(361);
  await expect(
    page.getByRole('button', { name: 'Создать книгу и сохранить EPUB' }),
  ).toBeVisible();
});
for (const width of [320, 390, 768, 1024, 1440]) {
  test(`полка и темы: ${String(width)} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'Добавить', exact: true }),
    ).toBeEnabled();
    await expect(page.getByLabel('Поиск по библиотеке')).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath('library-empty.png'),
      scale: 'css',
    });
    await page.evaluate(
      async (count) => {
        const storePath = '/src/infrastructure/local-store.ts',
          modelPath = '/src/services/library.ts';
        const { createLocalStore } = (await import(
          storePath
        )) as typeof import('../../src/infrastructure/local-store');
        const { makeBook, initialReading } = (await import(
          modelPath
        )) as typeof import('../../src/services/library');
        const store = createLocalStore();
        try {
          for (let n = 0; n < count; n++) {
            const book = makeBook({
              title:
                ([
                  'Тестовая книга: тихие страницы',
                  'Тестовый сборник длинных русских названий и наблюдений',
                  'Тестовая книга без обложки',
                ][n % 3] ?? 'Тестовая книга') +
                ' ' +
                String(n + 1),
              authors: 'Тестовый автор; Второй автор',
              description:
                'Синтетическая запись только для проверки интерфейса.',
              genres: 'Тест',
              isbn: '',
              cover: null,
            });
            await store.saveLibraryBook(book, {
              expectedUpdatedAt: null,
              allowDuplicate: true,
              initialReading: initialReading(book),
            });
          }
        } finally {
          store.close();
        }
      },
      width === 1440 ? 40 : 5,
    );
    await page.reload();
    await expect(page.locator('.book-card').first()).toBeVisible();
    const cover = await page.locator('.book-card__cover').first().boundingBox();
    expect(cover?.y).toBeLessThan(430);
    await fits(page);
    await page.screenshot({
      path: test.info().outputPath('library-light.png'),
      scale: 'css',
    });
    await page.goto('/#/settings');
    await page.getByText('Тёмная', { exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.goto('/#/library');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await fits(page);
    await page.screenshot({
      path: test.info().outputPath('library-dark.png'),
      scale: 'css',
    });
    await page.locator('.book-card').first().click();
    await page.screenshot({
      path: test.info().outputPath('book-details.png'),
      scale: 'css',
    });
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '24px';
    });
    await fits(page);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe(
      'BODY',
    );
  });
}
for (const width of [390, 1440]) {
  test(`чтение и сохранённые фрагменты: ${String(width)} px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const fixture = await makeEpubFixture({
      title: 'Тестовая книга: прогулки и заметки',
      chapters: [
        {
          name: 'a.xhtml',
          text: 'У каждой истории свой ритм. Спокойное чтение помогает замечать детали. '.repeat(
            40,
          ),
        },
      ],
    });
    await page.goto('/');
    await libraryAction(page, 'upload');
    await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
      name: 'studio.epub',
      mimeType: 'application/epub+zip',
      buffer: Buffer.from(fixture.bytes),
    });
    await expect(
      page.getByText('Выбрать другой файл', { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath('import.png'),
      scale: 'css',
    });
    await page
      .getByRole('button', { name: 'Создать книгу и сохранить EPUB' })
      .click();
    await page.screenshot({
      path: test.info().outputPath('details.png'),
      scale: 'css',
    });
    await page.getByRole('button', { name: 'Читать файл studio.epub' }).click();
    await expect(
      page.getByRole('button', { name: 'Оглавление', exact: true }),
    ).toBeEnabled({ timeout: 20000 });
    await expect(page.frameLocator('iframe').locator('body')).toContainText(
      'У каждой истории',
    );
    await expect(page.frameLocator('iframe').locator('body')).toHaveCSS(
      'font-size',
      width >= 900 ? '22px' : '20px',
    );
    await page.screenshot({
      path: test.info().outputPath('reading.png'),
      scale: 'css',
    });
    await page
      .getByRole('button', { name: 'Режимы чтения', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'По одному слову', exact: true })
      .click();
    await expect(
      page.getByLabel('Текущее слово', { exact: true }),
    ).toContainText('У');
    await page.screenshot({
      path: test.info().outputPath('rsvp.png'),
      scale: 'css',
    });
    await page
      .getByRole('button', { name: 'Вернуться к тексту', exact: true })
      .click();
    await expect(page.locator('.speed-word-highlight')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Оформление чтения', exact: true }),
    ).toBeEnabled();
    // Native selection belongs to a focused, live iframe; reflow may replace it.
    await expect(async () => {
      if (await page.getByLabel('Комментарий', { exact: true }).isVisible())
        return;
      await page
        .frameLocator('iframe')
        .locator('p')
        .first()
        .evaluate((p) => {
          p.ownerDocument.defaultView?.focus();
          const node = p.firstChild;
          if (!node) throw Error('Missing text');
          const range = p.ownerDocument.createRange();
          range.setStart(node, 0);
          range.setEnd(node, 26);
          const selection = p.ownerDocument.defaultView?.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        });
      await page
        .getByRole('button', { name: 'Заметка', exact: true })
        .click({ timeout: 1000 });
      await expect(page.getByLabel('Комментарий', { exact: true })).toBeVisible(
        { timeout: 1000 },
      );
    }).toPass({ timeout: 10000 });
    await page
      .getByLabel('Комментарий', { exact: true })
      .fill('Тестовая заметка: вернуться к этому фрагменту.');
    await page
      .getByRole('button', { name: 'Сохранить заметку', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Закрыть книгу', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Продолжить чтение', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath('library-continue.png'),
      scale: 'css',
    });
    await page.goto('/#/quotes');
    await expect(page.locator('.saved-fragment')).toHaveCount(1);
    await page.screenshot({
      path: test.info().outputPath('quotes.png'),
      scale: 'css',
    });
    await page.goto('/#/statistics');
    await expect(page.getByLabel('Год', { exact: true })).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath('statistics.png'),
      scale: 'css',
    });
    await page.goto('/#/settings');
    await expect(
      page.getByRole('group', { name: 'Тема приложения' }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath('settings.png'),
      scale: 'css',
    });
  });
}
