import { expect, test } from '@playwright/test';
import { makeEpubFixture } from '../fixtures/epub';

for (const width of [320, 390]) {
  test(`полка и карточка книги · ${String(width)} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const title = 'Путешествие по старым городам на берегах северного моря';
    const fixture = await makeEpubFixture({
      title,
      chapters: [
        {
          name: 'chapter.xhtml',
          text: 'Длинная дорога к морю продолжалась. '.repeat(250),
        },
      ],
    });
    await page
      .getByRole('button', { name: 'Загрузить EPUB или FB2', exact: true })
      .click();
    await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
      name: 'journey.epub',
      mimeType: 'application/epub+zip',
      buffer: Buffer.from(fixture.bytes),
    });
    await page.getByRole('button', { name: 'Добавить и читать' }).click();
    const ready = page.getByRole('button', { name: 'Оформление чтения' });
    const close = page.getByRole('button', { name: 'Закрыть книгу' });
    await expect(ready).toBeEnabled({ timeout: 20000 });
    await page.locator('.reader-screen').press('ArrowRight');
    await expect
      .poll(async () =>
        Number(await page.getByRole('progressbar').getAttribute('value')),
      )
      .toBeGreaterThan(0);
    await close.click();
    await expect(page).toHaveURL(/#\/library$/);
    const authors = [
      'Александра Александровна Лебедева',
      'Константин Сергеевич Виноградов',
      'Елизавета Михайловна Орлова',
    ];
    await page.evaluate(
      async ({ title, authors }) => {
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
          const imported = (await store.readLibrary()).books.find(
            (book) => book.title === title,
          );
          if (!imported) throw Error('Нет импортированной книги');
          const canvas = document.createElement('canvas');
          canvas.width = 480;
          canvas.height = 340;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw Error('Нет холста');
          ctx.fillStyle = '#23483f';
          ctx.fillRect(0, 0, 480, 340);
          ctx.fillStyle = '#e9d7ac';
          ctx.fillRect(15, 15, 450, 310);
          ctx.fillStyle = '#23483f';
          ctx.textAlign = 'center';
          ctx.font = '38px Georgia';
          ctx.fillText('Тихий берег', 240, 110);
          ctx.beginPath();
          ctx.arc(240, 207, 66, 0, Math.PI * 2);
          ctx.fill();
          const cover = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((blob) => {
              if (blob) resolve(blob);
              else reject(Error('Нет изображения'));
            });
          });
          const planned = {
            ...makeBook({
              title: 'Маяк',
              authors: 'Ирина Волкова',
              description: '',
              genres: 'Проза',
              isbn: '',
              cover: null,
            }),
            createdAt: imported.createdAt - 2000,
          };
          await store.saveLibraryBook(planned, {
            expectedUpdatedAt: null,
            allowDuplicate: false,
            initialReading: initialReading(planned),
          });
          const finished = {
            ...makeBook({
              title: 'Тихий берег',
              authors: 'Андрей Сорокин',
              description: '',
              genres: 'Проза',
              isbn: '',
              cover,
            }),
            createdAt: imported.createdAt - 1000,
          };
          const finishedReading = initialReading(finished);
          await store.saveLibraryBook(finished, {
            expectedUpdatedAt: null,
            allowDuplicate: false,
            initialReading: {
              ...finishedReading,
              status: 'finished',
              startedAt: Date.UTC(2025, 0, 1),
              finishedAt: Date.UTC(2025, 0, 2),
            },
          });
          await store.repositories.books.save(
            { ...imported, authors, updatedAt: imported.updatedAt + 1 },
            { expectedUpdatedAt: imported.updatedAt },
          );
        } finally {
          store.close();
        }
      },
      { title, authors },
    );
    await page.reload();
    const shelf = page.getByRole('list', { name: 'Книги библиотеки' });
    await expect(shelf.getByRole('listitem')).toHaveCount(3);
    await expect(shelf.locator('img')).toHaveJSProperty('complete', true);
    const longCard = shelf.locator('li').filter({ hasText: title });
    const coverCard = shelf.locator('li').filter({ hasText: 'Тихий берег' });
    const plannedCard = shelf.locator('li').filter({ hasText: 'Маяк' });
    await expect(longCard.locator('.cover-initial')).toHaveText('П');
    await expect(plannedCard.locator('.cover-short-title')).toHaveText('Маяк');
    await expect(longCard.locator('.book-card__title')).toHaveCSS(
      '-webkit-line-clamp',
      '2',
    );
    await expect(longCard.locator('.book-card__authors')).toHaveCSS(
      'white-space',
      'nowrap',
    );
    await expect(coverCard.locator('img')).toHaveCSS('object-fit', 'contain');
    await expect(coverCard.locator('img')).toHaveJSProperty(
      'naturalWidth',
      480,
    );
    await expect(coverCard.locator('img')).toHaveJSProperty(
      'naturalHeight',
      340,
    );
    await expect(coverCard.locator('.book-status')).toHaveText('Прочитано');
    await expect(longCard.locator('.book-status')).toHaveText('Читаю');
    await expect(plannedCard.locator('.book-status')).toHaveText(
      'Хочу прочитать',
    );
    await page.screenshot({
      path: test.info().outputPath('shelf.png'),
      scale: 'css',
    });
    const saved = await page
      .getByRole('progressbar', { name: 'Сохранённая позиция' })
      .getAttribute('value');
    await shelf
      .getByRole('button', { name: new RegExp(title, 'u') })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: title });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.book-detail-hero p').first()).toHaveText(
      authors.join(', '),
    );
    await expect(dialog.locator('.book-detail .button--primary')).toHaveCount(
      1,
    );
    await expect(
      dialog.getByRole('button', { name: 'Продолжить', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath('book.png'),
      scale: 'css',
    });
    const closeDialog = async () => {
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Закрыть', exact: true })
        .click();
    };
    await dialog.getByText('Файлы и издания', { exact: true }).click();
    await dialog
      .getByRole('button', { name: 'Прикрепить другое издание' })
      .click();
    const alternate = await makeEpubFixture({
      title,
      chapters: [{ name: 'different.xhtml', text: 'Текст другого издания.' }],
    });
    await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
      name: 'second.epub',
      mimeType: 'application/epub+zip',
      buffer: Buffer.from(alternate.bytes),
    });
    await page
      .getByRole('button', { name: 'Прикрепить EPUB', exact: true })
      .click();
    await expect(dialog.locator('.book-primary-action')).toContainText(
      'journey.epub',
    );
    await dialog
      .getByRole('button', { name: 'Продолжить', exact: true })
      .click();
    await expect(ready).toBeEnabled({ timeout: 20000 });
    await expect(page.frameLocator('iframe').locator('body')).toContainText(
      'Длинная дорога к морю',
    );
    await expect(page.getByRole('progressbar')).toHaveAttribute(
      'value',
      saved ?? '',
    );
    await close.click();
    await expect(longCard.locator('.book-status')).toHaveText('Читаю');

    await longCard
      .getByRole('button', { name: new RegExp(`^${title}`, 'u') })
      .click();
    await expect(
      dialog.getByRole('region', { name: 'История чтения' }),
    ).toContainText('1 прочтение');
    await expect(dialog.getByText(/Прочтение \d+ · Прочитано/u)).toHaveCount(0);
    await dialog.getByText('Файлы и издания', { exact: true }).click();
    await dialog
      .getByRole('button', { name: 'Читать файл second.epub' })
      .click();
    await expect(ready).toBeEnabled({ timeout: 20000 });
    await expect(page.frameLocator('iframe').locator('body')).toContainText(
      'Текст другого издания.',
    );
    await close.click();
    await expect(longCard.locator('.book-status')).toHaveText('Читаю');
    const savedReading = await page.evaluate(async (title) => {
      const local = '/src/infrastructure/local-store.ts';
      const { createLocalStore } = (await import(
        local
      )) as typeof import('../../src/infrastructure/local-store');
      const store = createLocalStore();
      try {
        const { books, readings } = await store.readLibrary();
        const book = books.find((entry) => entry.title === title);
        return readings.filter((reading) => reading.bookId === book?.id);
      } finally {
        store.close();
      }
    }, title);
    expect(savedReading).toMatchObject([
      { status: 'planned', startedAt: null, finishedAt: null },
    ]);
    await page.getByRole('button', { name: 'Фильтры и сортировка' }).click();
    await page.getByLabel('Статус книги').selectOption('active');
    await page.getByRole('button', { name: 'Показать книги' }).click();
    await expect(shelf.getByRole('listitem')).toHaveCount(1);
    await expect(shelf).toContainText(title);
    await page.getByRole('button', { name: 'Сбросить фильтры' }).click();

    await plannedCard.getByRole('button', { name: /^Маяк/u }).click();
    const plannedDialog = page.getByRole('dialog', { name: 'Маяк' });
    await expect(plannedDialog.locator('.status-chip')).toHaveText(
      'Хочу прочитать',
    );
    await expect(
      plannedDialog.getByRole('region', { name: 'История чтения' }),
    ).toContainText('0 прочтений');
    await expect(
      plannedDialog.getByRole('button', { name: 'Изменить план чтения' }),
    ).toBeVisible();
    await plannedDialog
      .getByRole('button', { name: 'Прикрепить файл' })
      .click();
    await expect(
      page.getByRole('dialog', { name: 'Импорт EPUB или FB2' }),
    ).toBeVisible();
    await expect(
      page.getByLabel('Файл книги', { exact: true }),
    ).toHaveAttribute('accept', /\.epub.*\.fb2/u);
    await page.getByRole('button', { name: 'Закрыть импорт' }).click();
    await closeDialog();
    await coverCard.getByRole('button', { name: /^Тихий берег/u }).click();
    const finishedDialog = page.getByRole('dialog', { name: 'Тихий берег' });
    await expect(finishedDialog.locator('.status-chip')).toHaveText(
      'Прочитано',
    );
    await expect(
      finishedDialog.getByRole('region', { name: 'История чтения' }),
    ).toContainText('1 прочтение');
  });
}
