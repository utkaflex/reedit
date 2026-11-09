import { expect, test, type Page } from '@playwright/test';
import { makeEpubFixture } from '../fixtures/epub';

async function fits(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
}
async function aboveNavigation(
  page: Page,
  locator: ReturnType<Page['locator']>,
  scroll = false,
) {
  await expect
    .poll(async () => {
      if (scroll)
        await page.evaluate(() => {
          window.scrollTo(0, document.documentElement.scrollHeight);
        });
      const content = await locator.boundingBox();
      const navigation = await page.getByRole('navigation').boundingBox();
      return Boolean(
        content && navigation && content.y + content.height <= navigation.y + 1,
      );
    })
    .toBe(true);
}
for (const width of [320, 390]) {
  test(`композиция: пять состояний и основные действия, ${String(width)} px`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 740 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Ваша первая книга' }),
    ).toBeVisible();
    await expect(page.getByLabel('Поиск по библиотеке')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Коллекции', exact: true }),
    ).toHaveCount(0);
    await aboveNavigation(
      page,
      page.getByRole('button', { name: 'Добавить вручную', exact: true }),
    );
    await fits(page);
    await page.screenshot({
      path: test.info().outputPath('library-empty.png'),
      scale: 'css',
    });
    await page.goto('/#/statistics');
    await expect(
      page.getByRole('link', { name: 'Выбрать книгу', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Годовая сводка' }),
    ).toHaveCount(0);
    await expect(
      page.getByText('Скорость пока не определена').filter({ visible: true }),
    ).toHaveCount(0);
    await expect(
      page.getByLabel('Книг за год', { exact: true }),
    ).not.toBeVisible();
    await page.screenshot({
      path: test.info().outputPath('statistics-empty.png'),
      scale: 'css',
    });
    await page.getByLabel('Установить цель', { exact: true }).click();
    await page.getByLabel('Книг за год', { exact: true }).fill('15');
    await page
      .getByRole('button', { name: 'Сохранить цель', exact: true })
      .click();
    await expect(page.getByText('0 из 15 книг', { exact: true })).toBeVisible();
    await page.goto('/#/settings');
    await expect(
      page.getByRole('group', { name: 'Тема приложения' }),
    ).toBeVisible();
    await expect(page.locator('.disclosure-row')).toHaveCount(5);
    await expect(page.locator('.disclosure-row[open]')).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath('settings.png'),
      scale: 'css',
    });
    await page.getByText('Резервная копия', { exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Создать ZIP резервной копии' }),
    ).toBeVisible();
    await page.getByText('Резервная копия', { exact: true }).click();
    await page.getByText('Установка', { exact: true }).click();
    await expect(
      page.getByText(/Откройте Reedit в Safari по HTTPS/),
    ).toBeVisible();
    await page.getByText('Установка', { exact: true }).click();
    await page.getByText('Тёмная', { exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({
      path: test.info().outputPath('settings-dark.png'),
      scale: 'css',
    });
    await page.getByText('Светлая', { exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.goto('/#/library');
    const fixture = await makeEpubFixture({
      title: 'Сад вечерних историй',
      chapters: [
        {
          name: 'garden.xhtml',
          text: 'Тихий сад хранит истории, которые возвращаются вместе с весной. '.repeat(
            160,
          ),
        },
      ],
    });
    await page
      .getByRole('button', { name: 'Загрузить книгу', exact: true })
      .click();
    await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
      name: 'garden.epub',
      mimeType: 'application/epub+zip',
      buffer: Buffer.from(fixture.bytes),
    });
    await page
      .getByRole('button', { name: 'Создать книгу и сохранить EPUB' })
      .click();
    await page
      .getByRole('button', { name: 'Читать файл garden.epub', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Оформление чтения' }),
    ).toBeEnabled({ timeout: 20000 });
    await page
      .getByRole('button', { name: 'Следующая страница', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Закрыть книгу', exact: true })
      .click();
    await expect(page).toHaveURL(/#\/library$/);
    // Synthetic artwork and records exist only in this isolated test database.
    await page.evaluate(async () => {
      const storePath = '/src/infrastructure/local-store.ts',
        modelPath = '/src/services/library.ts',
        idsPath = '/src/domain/model.ts';
      const { createLocalStore } = (await import(
        storePath
      )) as typeof import('../../src/infrastructure/local-store');
      const { makeBook, initialReading } = (await import(
        modelPath
      )) as typeof import('../../src/services/library');
      const { newId } = (await import(
        idsPath
      )) as typeof import('../../src/domain/model');
      const store = createLocalStore();
      const cover = async (title: string, background: string) => {
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 600;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw Error('No canvas');
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, 400, 600);
        ctx.strokeStyle = '#f6e6b4';
        ctx.lineWidth = 2;
        ctx.strokeRect(24, 24, 352, 552);
        ctx.beginPath();
        ctx.arc(200, 365, 96, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#f6e6b4';
        ctx.textAlign = 'center';
        ctx.font = '22px sans-serif';
        ctx.fillText('ТЕСТОВОЕ ИЗДАНИЕ', 200, 68);
        ctx.font = '34px Georgia';
        title.split('|').forEach((line, n) => {
          ctx.fillText(line, 200, 152 + n * 42);
        });
        ctx.font = '20px sans-serif';
        ctx.fillText('Синтетическая книга · CC0', 200, 548);
        return new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(Error('No cover'));
          }, 'image/png');
        });
      };
      try {
        const data = await store.readLibrary(),
          first = data.books[0],
          file = data.files[0],
          reading = data.readings[0];
        if (!first || !file || !reading) throw Error('Missing imported book');
        await store.repositories.books.save(
          {
            ...first,
            cover: await cover('Сад вечерних|историй', '#3c476f'),
            updatedAt: first.updatedAt + 1,
          },
          { expectedUpdatedAt: first.updatedAt },
        );
        await store.repositories.readings.save(
          {
            ...reading,
            status: 'active',
            startedAt: Date.now(),
            updatedAt: reading.updatedAt + 1,
          },
          { expectedUpdatedAt: reading.updatedAt },
        );
        const second = makeBook({
          title: 'Письма к морю',
          authors: 'Тестовый автор',
          description: 'Синтетическая книга только для проверки интерфейса.',
          genres: 'Проза',
          isbn: '',
          cover: await cover('Письма|к морю', '#895b65'),
        });
        await store.saveLibraryBook(second, {
          expectedUpdatedAt: null,
          allowDuplicate: false,
          initialReading: initialReading(second),
        });
        const ownerId = newId(),
          from = Date.now() - 600000;
        const session = await store.claimActivity({
          readingId: reading.id,
          fileId: file.id,
          ownerId,
          mode: 'ordinary',
          now: from,
        });
        if (!session?.contentId || !session.textVersion)
          throw Error('No activity session');
        for (let n = 0; n < 60; n++) {
          const to = from + (n + 1) * 10000;
          await store.commitActivity(
            {
              id: newId(),
              createdAt: to,
              updatedAt: to,
              readingId: reading.id,
              sessionId: session.id,
              contentId: session.contentId,
              textVersion: session.textVersion,
              mode: 'ordinary',
              from: from + n * 10000,
              to,
              milliseconds: 10000,
              intervals: [{ start: n * 10, end: (n + 1) * 10 }],
            },
            ownerId,
          );
        }
        await store.releaseActivity(session.id, ownerId);
      } finally {
        store.close();
      }
    });
    await page.reload();
    await expect(page.locator('.book-grid > li')).toHaveCount(2);
    await expect(
      page.getByRole('button', { name: 'Продолжить чтение', exact: true }),
    ).toBeVisible();
    await fits(page);
    const first = await page.locator('.book-card__cover').nth(1).boundingBox();
    const nav = await page.getByRole('navigation').boundingBox();
    expect(
      first && nav && first.y + Math.min(first.height, 160) < nav.y,
    ).toBeTruthy();
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    await test.info().attach('library-layout', {
      body: JSON.stringify(
        await page.evaluate(() => {
          const rect = (element: Element | null) => {
            const value = element?.getBoundingClientRect();
            return value
              ? {
                  x: value.x,
                  y: value.y,
                  width: value.width,
                  height: value.height,
                  bottom: value.bottom,
                }
              : null;
          };
          return {
            scrollY,
            heading: rect(document.querySelector('.page-header')),
            search: rect(document.querySelector('.library-actions')),
            hero: rect(document.querySelector('.continue-reading')),
            books: [...document.querySelectorAll('.book-card__title')].map(
              rect,
            ),
            nav: rect(document.querySelector('.navigation')),
          };
        }),
        null,
        2,
      ),
      contentType: 'application/json',
    });
    await page.screenshot({
      path: test.info().outputPath('library-filled.png'),
      scale: 'css',
    });
    await page.getByRole('button', { name: /Фильтры и сортировка/ }).click();
    await page.getByRole('radio', { name: 'Список', exact: true }).check();
    await page
      .getByRole('button', { name: 'Показать книги', exact: true })
      .click();
    await expect(page.locator('.book-list')).toBeVisible();
    await page.goto('/#/statistics');
    await expect(
      page.getByRole('region', { name: 'Активность за год' }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Годовая сводка' }),
    ).toBeVisible();
    const activity = page.getByRole('region', { name: 'Активность за год' });
    await expect(activity.getByRole('status')).toHaveText('10 мин');
    await activity
      .getByLabel('Месяц', { exact: true })
      .selectOption(String((new Date().getMonth() + 1) % 12));
    await expect(activity.getByRole('status')).toHaveText('0 мин');
    await activity
      .getByLabel('Месяц', { exact: true })
      .selectOption(String(new Date().getMonth()));
    await page.screenshot({
      path: test.info().outputPath('statistics-filled.png'),
      scale: 'css',
    });
    await page.reload();
    await expect(page.getByText('0 из 15 книг', { exact: true })).toBeVisible();
    await page.goto('/#/settings');
    await expect(page.locator('.disclosure-row')).toHaveCount(5);
    for (const height of [650, 844]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      await aboveNavigation(
        page,
        page.locator('.settings-stack > section').last(),
        true,
      );
      await fits(page);
    }
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await fits(page);
    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await aboveNavigation(
      page,
      page.locator('.settings-stack > section').last(),
      true,
    );
    await page.screenshot({
      path: test.info().outputPath('settings-large-text.png'),
      scale: 'css',
    });
    for (const section of ['Библиотека', 'Статистика']) {
      await page
        .getByRole('navigation')
        .getByRole('link', { name: section, exact: true })
        .click();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await fits(page);
      if (section === 'Статистика') {
        await expect(page.getByLabel('Год', { exact: true })).toBeVisible();
        expect(
          await page.getByLabel('Год', { exact: true }).evaluate((element) => {
            if (!(element instanceof HTMLSelectElement)) return false;
            const style = getComputedStyle(element),
              ctx = document.createElement('canvas').getContext('2d');
            if (!ctx) return false;
            ctx.font = style.fontSize + ' ' + style.fontFamily;
            return (
              ctx.measureText(element.selectedOptions[0]?.text ?? '').width <=
              element.clientWidth -
                parseFloat(style.paddingLeft) -
                parseFloat(style.paddingRight)
            );
          }),
        ).toBe(true);
      }
    }
  });
}
