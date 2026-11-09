import { expect, test } from '@playwright/test';
import { makeEpubFixture } from '../fixtures/epub';

for (const width of [320, 390, 1440]) {
  test(`полка и читалка · ${String(width)} px`, async ({
    page,
    context,
    browserName,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: width === 1440 ? 960 : 780 });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    const shot = (name: string) =>
      page.screenshot({
        path: test.info().outputPath(name + '.png'),
        scale: 'css',
      });
    const compare = async (screen: 'reader' | 'shelf') => {
      if (!process.env.REEDIT_VISUAL_DIRECTIONS || width === 1440) return;
      for (const [name, colors] of [
        [
          'paper',
          '#f7f3eb;--color-surface:#fffdf7;--color-text:#27251f;--color-muted:#655e50;--color-accent:#8f3c2c;--color-accent-soft:#f3e3d9;--color-subtle:#eee8db;--color-border:#ddd3c3',
        ],
        [
          'ink',
          '#ecf3f3;--color-surface:#f9fdfd;--color-text:#172d34;--color-muted:#48616a;--color-accent:#16656b;--color-accent-soft:#d9edeb;--color-subtle:#e0eeee;--color-border:#bed3d3',
        ],
      ] as const) {
        const style = await page.addStyleTag({
          content:
            ':root,.reader-screen[data-reader-theme="light"]{--color-bg:' +
            colors +
            ';--color-on-accent:#fff} .reader-top,.reader-bottom{background:var(--color-bg)} .page-header h1{font-family:' +
            (name === 'paper'
              ? 'var(--font-editorial);font-weight:500'
              : 'var(--font-ui);font-weight:750') +
            '} .continue-reading{border:1px solid var(--color-border);background:var(--color-surface)} .library-status-tabs{flex-wrap:wrap;overflow:visible} .library-status-tabs .button{white-space:normal}',
        });
        await shot(name + '-' + screen);
        await style.evaluate((element) =>
          element.parentNode?.removeChild(element),
        );
      }
    };
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Ваша первая книга' }),
    ).toBeVisible();
    await shot('empty');
    const fixture = await makeEpubFixture({
      title: 'Атлас тихих городов и путеводитель по забытым берегам',
      chapters: [
        {
          name: 'coast.xhtml',
          text: 'Утром море было тихим. Письма лежали на подоконнике, где их согревало солнце. '.repeat(
            85,
          ),
        },
      ],
    });
    await page
      .getByRole('button', { name: 'Загрузить книгу', exact: true })
      .click();
    await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
      name: 'atlas.epub',
      mimeType: 'application/epub+zip',
      buffer: Buffer.from(fixture.bytes),
    });
    const importAndRead = page.getByRole('button', {
      name: 'Добавить и читать',
      exact: true,
    });
    await expect(importAndRead).toBeVisible();
    if (width === 390) await shot('import');
    await importAndRead.click();
    await expect(
      page.getByRole('button', { name: 'Оформление чтения' }),
    ).toBeEnabled({ timeout: 20000 });
    await expect(page.frameLocator('iframe').locator('body')).toContainText(
      'Утром море было тихим',
    );
    await page
      .getByRole('button', { name: 'Следующая страница', exact: true })
      .click();
    await expect(
      page.getByText('Позиция сохранена', { exact: true }),
    ).toBeVisible();
    await shot('reader');
    await compare('reader');
    const footer = page.locator('.reader-bottom');
    await footer.screenshot({
      path: test.info().outputPath('reader-footer.png'),
      scale: 'css',
    });
    const location = page.getByRole('progressbar', {
      name: 'Прогресс по читаемому тексту',
    });
    const progress = await location.getAttribute('value');
    const frame = page.locator('.reader-host iframe');
    const geometry = await frame.boundingBox();
    await page
      .getByRole('button', { name: 'Скрыть панели', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Показать панели' }),
    ).toBeVisible();
    expect(await frame.boundingBox()).toEqual(geometry);
    await page.getByRole('button', { name: 'Показать панели' }).click();
    await expect(location).toHaveAttribute('value', progress ?? '');
    if (width === 390) {
      await page
        .getByRole('button', { name: 'Оглавление', exact: true })
        .click();
      await shot('contents');
      await page.keyboard.press('Escape');
      await page
        .getByRole('button', { name: 'Оформление чтения', exact: true })
        .click();
      await shot('appearance');
      await page.getByRole('radio', { name: 'Сепия' }).check();
      await page
        .getByRole('button', { name: 'Применить оформление', exact: true })
        .click();
      await expect(page.locator('.reader-screen')).toHaveAttribute(
        'data-reader-theme',
        'sepia',
      );
      await shot('reader-sepia');
      for (const [mode, name] of [
        ['По одному слову', 'reader-words'],
        ['С подсветкой текста', 'reader-guided'],
      ] as const) {
        await page
          .getByRole('button', { name: 'Режимы чтения', exact: true })
          .click();
        await page.getByRole('button', { name: mode, exact: true }).click();
        const play = page.getByRole('button', {
          name: 'Продолжить',
          exact: true,
        });
        await expect(play).toBeEnabled();
        await play.click();
        await page.getByRole('button', { name: 'Пауза', exact: true }).click();
        await shot(name);
        await page
          .getByRole('button', { name: 'Вернуться к тексту', exact: true })
          .click();
        await expect(
          page.getByRole('button', { name: 'Оформление чтения' }),
        ).toBeEnabled();
      }

      await page
        .frameLocator('iframe')
        .locator('p')
        .first()
        .evaluate((p) => {
          const node = p.firstChild;
          if (!node) throw new Error('Missing text');
          const doc = p.ownerDocument;
          const range = doc.createRange();
          range.setStart(node, 0);
          range.setEnd(node, 21);
          const selection = doc.defaultView?.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        });
      const save = page.getByRole('button', {
        name: 'Сохранить цитату',
        exact: true,
      });
      await expect(save).toBeVisible();
      await shot('reader-selection');
      await save.click();
      await expect(
        page.getByText('Цитата сохранена', { exact: true }),
      ).toBeVisible();
    }
    await page
      .getByRole('button', { name: 'Закрыть книгу', exact: true })
      .click();
    await expect(page.locator('.book-grid > li')).toHaveCount(1);
    await shot('one');
    await page.evaluate(async () => {
      const storePath = '/src/infrastructure/local-store.ts';
      const booksPath = '/src/services/library.ts';
      const { createLocalStore } = (await import(
        storePath
      )) as typeof import('../../src/infrastructure/local-store');
      const { makeBook, initialReading } = (await import(
        booksPath
      )) as typeof import('../../src/services/library');
      const store = createLocalStore();
      try {
        const titles = [
          'Сад за закрытой дверью',
          'Письма к морю',
          'Избранные рассказы о путешествиях на край света',
          'Зимняя тетрадь',
          'Время яблок',
          'Полночные разговоры в поезде',
          'История маленького маяка',
          'Города, которые мы оставили',
        ];
        for (const [index, title] of titles.entries()) {
          let cover: Blob | null = null;
          if (index % 3 !== 2) {
            const canvas = document.createElement('canvas');
            canvas.width = 300;
            canvas.height = 450;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw Error('No canvas');
            ctx.fillStyle =
              ['#234b44', '#a34635', '#35375f', '#734449'][index % 4] ?? '#333';
            ctx.fillRect(0, 0, 300, 450);
            ctx.strokeStyle = '#f0d9a0';
            ctx.strokeRect(15, 15, 270, 420);
            ctx.beginPath();
            ctx.arc(150, 280, 45 + index * 4, 0, 2 * Math.PI);
            ctx.stroke();
            ctx.fillStyle = '#f8e7c1';
            ctx.textAlign = 'center';
            ctx.font = '26px Georgia';
            title.split(' ').forEach((word, n) => {
              ctx.fillText(word, 150, 85 + n * 27);
            });
            cover = await new Promise<Blob | null>((resolve) => {
              canvas.toBlob(resolve);
            });
          }
          const book = makeBook({
            title,
            authors: 'Автор тестового издания',
            description: '',
            isbn: '',
            genres: 'Проза',
            cover,
          });
          await store.saveLibraryBook(book, {
            expectedUpdatedAt: null,
            allowDuplicate: false,
            initialReading: initialReading(book),
          });
        }
      } finally {
        store.close();
      }
    });
    await page.reload();
    await expect(page.locator('.book-grid > li')).toHaveCount(9);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
    await shot('shelf');
    await compare('shelf');
    const continueReading = page.getByRole('button', {
      name: 'Продолжить чтение',
      exact: true,
    });
    await expect(continueReading).toBeVisible();
    await continueReading.click();
    await expect(
      page.getByRole('button', { name: 'Оформление чтения' }),
    ).toBeEnabled();
    await expect(page.frameLocator('iframe').locator('body')).toContainText(
      'Утром море было тихим',
    );
    await page
      .getByRole('button', { name: 'Закрыть книгу', exact: true })
      .click();
    if (width === 320 && browserName === 'chromium') {
      const devtools = await context.newCDPSession(page);
      await devtools.send('Emulation.setSafeAreaInsetsOverride', {
        insets: { top: 0, right: 0, bottom: 34, left: 0 },
      });
      await expect(page.getByRole('navigation')).toHaveCSS(
        'padding-bottom',
        '38px',
      );
      await continueReading.click();
      await expect(
        page.getByRole('button', { name: 'Оформление чтения' }),
      ).toBeEnabled();
      await expect(page.locator('.reader-screen')).toHaveCSS(
        'padding-bottom',
        '34px',
      );
      await shot('safe-area-reader');
      await page
        .getByRole('button', { name: 'Закрыть книгу', exact: true })
        .click();
      await devtools.send('Emulation.setSafeAreaInsetsOverride', {
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
      });
      await devtools.detach();
    }
    if (width === 320) {
      await page.getByRole('button', { name: /Фильтры и сортировка/ }).click();
      await page
        .getByLabel('Статус книги', { exact: true })
        .selectOption('planned');
      await page
        .getByRole('button', { name: 'Показать книги', exact: true })
        .click();
      const filter = page.getByRole('button', {
        name: /Фильтры и сортировка · Хочу прочитать/,
      });
      await expect(filter).toBeVisible();
      await filter.screenshot({
        path: test.info().outputPath('filter.png'),
        scale: 'css',
      });
      const bounds = await filter.boundingBox();
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width);
      await page.mouse.move(0, 0);
      await shot('large-text');
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '';
      });
      const fixturePath = '/tests/fixtures/icon-gallery.ts';
      await page.evaluate(async (path) => {
        const { showIconSample } = (await import(
          path
        )) as typeof import('../fixtures/icon-gallery');
        showIconSample();
      }, fixturePath);
      await expect(page.locator('#icon-sample svg')).toHaveCount(10);
      await page.locator('#icon-sample').screenshot({
        path: test.info().outputPath('icons.png'),
        scale: 'css',
      });
    }
    if (width === 390) {
      await page.goto('/#/quotes');
      await expect(page.locator('.saved-fragment blockquote')).toHaveText(
        'Утром море было тихим',
      );
      await shot('quotes');
      await page
        .getByRole('button', { name: 'К месту в книге', exact: true })
        .click();
      await expect(
        page.getByRole('button', { name: 'Оформление чтения' }),
      ).toBeEnabled();

      await page.getByRole('button', { name: 'Оформление чтения' }).click();
      await page.getByRole('radio', { name: 'Тёмная', exact: true }).check();
      await page
        .getByRole('button', { name: 'Применить оформление', exact: true })
        .click();
      await expect(page.locator('.reader-screen')).toHaveAttribute(
        'data-reader-theme',
        'dark',
      );
      await shot('reader-dark');
      await page
        .getByRole('button', { name: 'Закрыть книгу', exact: true })
        .click();
      await page.goto('/#/statistics');
      await expect(
        page.getByRole('heading', { name: 'Статистика', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Цель на год', exact: true }),
      ).toBeVisible();
      await shot('statistics');
      await page.goto('/#/settings');
      await expect(
        page.getByRole('heading', { name: 'Данные и приложение', exact: true }),
      ).toBeVisible();
      await shot('settings');
      await page.getByText('Тёмная', { exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.goto('/#/library');
      await expect(page.locator('.book-grid > li')).toHaveCount(9);
      await shot('shelf-dark');
    }
  });
}
