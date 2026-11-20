import { expect, test } from '@playwright/test';
import { makeEpubFixture } from '../fixtures/epub';

for (const width of [320, 390, 1440]) {
  test(`полка и поиск · ${String(width)} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 740 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const book = await makeEpubFixture({
      title: 'Сад вечерних историй',
      chapters: [
        {
          name: 'garden.xhtml',
          text: '',
          markup: `<h1>Вечерний сад</h1><p>${'Тихий сад хранит истории, которые возвращаются вместе с весной. '.repeat(160)}</p>`,
        },
      ],
    });
    await page
      .getByRole('button', { name: 'Загрузить EPUB или FB2', exact: true })
      .click();
    await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
      name: 'garden.epub',
      mimeType: 'application/epub+zip',
      buffer: Buffer.from(book.bytes),
    });
    await page.getByRole('button', { name: 'Добавить и читать' }).click();
    await expect(
      page.getByRole('button', { name: 'Оформление чтения' }),
    ).toBeEnabled({ timeout: 20000 });
    await page.locator('.reader-screen').press('ArrowRight');
    await expect
      .poll(async () =>
        Number(await page.getByRole('progressbar').getAttribute('value')),
      )
      .toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Закрыть книгу' }).click();
    await page.evaluate(async () => {
      const local = '/src/infrastructure/local-store.ts',
        library = '/src/services/library.ts';
      const { createLocalStore } = (await import(
        local
      )) as typeof import('../../src/infrastructure/local-store');
      const { makeBook, initialReading } = (await import(
        library
      )) as typeof import('../../src/services/library');
      const store = createLocalStore();
      try {
        const second = makeBook({
          title: 'Письма к морю',
          authors: 'Ирина Волкова',
          description: '',
          genres: 'Проза',
          isbn: '',
          cover: null,
        });
        await store.saveLibraryBook(second, {
          expectedUpdatedAt: null,
          allowDuplicate: false,
          initialReading: initialReading(second),
        });
      } finally {
        store.close();
      }
    });
    await page.reload();
    const cards = page.getByRole('list', { name: 'Книги библиотеки' });
    await expect(cards.getByRole('listitem')).toHaveCount(2);
    const resume = page.getByRole('region', { name: 'Продолжить чтение' });
    await expect(
      resume.getByRole('button', { name: 'Продолжить чтение' }),
    ).toBeVisible();
    await expect(resume).toContainText('Вечерний сад');
    if (width === 1440) {
      const block = await resume.boundingBox();
      const shelf = await cards.boundingBox();
      expect(block && shelf && block.width < shelf.width / 2).toBeTruthy();
    } else {
      const nav = await page.getByRole('navigation').boundingBox();
      for (const item of await cards.getByRole('listitem').all()) {
        for (const selector of ['.book-card__cover', '.book-card__title']) {
          const box = await item.locator(selector).boundingBox();
          expect(
            box && nav && box.y >= 0 && box.y + box.height <= nav.y,
          ).toBeTruthy();
        }
      }
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    }
    await page.screenshot({
      path: test.info().outputPath('shelf.png'),
      scale: 'css',
    });
    const search = page.getByRole('searchbox', { name: 'Поиск по библиотеке' });
    await search.fill('Северный маяк');
    await expect(
      page.getByText('Ничего не найдено', { exact: true }),
    ).toBeVisible();
    await expect(resume).toBeHidden();
    await page
      .getByRole('button', { name: 'Добавить', exact: true })
      .click({ trial: true });
    await page.screenshot({
      path: test.info().outputPath('no-results.png'),
      scale: 'css',
    });
    await page.getByRole('button', { name: 'Очистить поиск' }).click();
    await expect(search).toHaveValue('');
    await expect(resume).toBeVisible();

    await page.evaluate(async () => {
      const local = '/src/infrastructure/local-store.ts',
        models = '/src/domain/model.ts';
      const { createLocalStore } = (await import(
        local
      )) as typeof import('../../src/infrastructure/local-store');
      const { newId } = (await import(
        models
      )) as typeof import('../../src/domain/model');
      const store = createLocalStore();
      try {
        const { books } = await store.readLibrary();
        const original = books.find(
          (entry) => entry.title === 'Сад вечерних историй',
        );
        if (!original) throw Error('Нет исходной книги');
        const now = Date.now();
        await store.repositories.collections.save(
          {
            id: newId(),
            name: 'На вечер',
            bookIds: [original.id],
            createdAt: now,
            updatedAt: now,
          },
          { expectedUpdatedAt: null },
        );
      } finally {
        store.close();
      }
    });
    await page.reload();
    await search.fill('Письма');
    await expect(resume).toBeHidden();
    await expect(cards.getByRole('listitem')).toHaveCount(1);
    await expect(cards).toContainText('Письма к морю');
    const openFilters = page.getByRole('button', {
      name: 'Фильтры и сортировка',
    });
    const dialog = page.getByRole('dialog', { name: 'Фильтры и сортировка' });
    const active = page.getByRole('group', { name: 'Активные фильтры' });
    const status = dialog.getByLabel('Статус книги');
    const collection = dialog.getByLabel('Коллекция');
    const sort = dialog.getByLabel('Сортировка');
    const editFilters = async () => {
      await status.selectOption('finished');
      await collection.selectOption({ label: 'На вечер' });
      await sort.selectOption('title');
    };
    await openFilters.click();
    await editFilters();
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(cards).toContainText('Письма к морю');
    await expect(active).toHaveCount(0);
    await openFilters.click();
    await expect(status).toHaveValue('all');
    await expect(collection).toHaveValue('all');
    await expect(sort).toHaveValue('newest');
    await editFilters();
    await dialog.getByRole('button', { name: 'Показать книги' }).click();
    await expect(
      page.getByText('Ничего не найдено', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'На вечер' })).toBeVisible();
    await expect(active).toContainText('Прочитано · По названию');
    await active.getByRole('button', { name: 'Сбросить фильтры' }).click();
    await expect(search).toHaveValue('Письма');
    await expect(active).toHaveCount(0);
    await expect(cards).toContainText('Письма к морю');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  });
}
