import { expect, test, type Page } from '@playwright/test';
import { makeEpubFixture, type FixtureOptions } from '../fixtures/epub';
import type { RoundtripResult } from '../fixtures/position-harness';

async function openBook(page: Page, options: FixtureOptions = {}) {
  const sentence =
    'Длинный русский абзац сохраняет порядок слов, курсив и спокойный ритм чтения. ';
  const fixture = await makeEpubFixture({
    title: 'Длинная книга для чтения',
    chapters: [
      { name: 'first.xhtml', text: `Начало. ${sentence.repeat(50)}` },
      {
        name: 'middle.xhtml',
        text: `Середина без оглавления. ${sentence.repeat(45)}`,
      },
      {
        name: 'last.xhtml',
        text: `Последний раздел. ${sentence.repeat(40)} Конец всей книги.`,
      },
    ],
    toc: [0, 2],
    ...options,
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Импорт EPUB', exact: true }).click();
  await page.getByLabel('Файл EPUB', { exact: true }).setInputFiles({
    name: 'reader.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(fixture.bytes),
  });
  await page
    .getByRole('button', { name: 'Создать книгу и сохранить EPUB' })
    .click();
  await page
    .getByRole('button', { name: 'Читать файл reader.epub', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Оформление чтения', exact: true }),
  ).toBeEnabled({ timeout: 20000 });
  return fixture;
}
async function position(page: Page) {
  return page.evaluate(
    async () =>
      new Promise<string>((resolve, reject) => {
        const request = indexedDB.open('reedit');
        request.onerror = () => {
          reject(request.error ?? new Error('Open failed'));
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('positions', 'readonly');
          const query = tx.objectStore('positions').openCursor();
          query.onsuccess = () => {
            const value: unknown = query.result?.value;
            db.close();
            resolve(
              typeof value === 'object' &&
                value !== null &&
                'cfi' in value &&
                typeof value.cfi === 'string'
                ? value.cfi
                : '',
            );
          };
          query.onerror = () => {
            db.close();
            reject(query.error ?? new Error('Read failed'));
          };
        };
      }),
  );
}
test('точное слово: CFI, выделение, оформление, сохранение и передача общего курсора', async ({
  page,
}) => {
  await openBook(page);
  await page.getByRole('button', { name: 'Закрыть книгу' }).click();
  await expect(
    page.getByRole('heading', { name: 'Библиотека', exact: true }),
  ).toBeVisible();
  const result = await page.evaluate<RoundtripResult>(async () => {
    const path = '/tests/fixtures/position-harness.ts';
    const loaded: unknown = await import(path);
    const harness = loaded as typeof import('../fixtures/position-harness');
    return await harness.runPositionRoundtrip();
  });
  expect(result.selected).toEqual(result.target);
  expect(result.afterStyle).toEqual(result.target);
  expect(result.restored).toEqual(result.target);
  expect(result.handoff).toEqual(result.target);
  expect(result.progressAfter).toBe(result.progressBefore);
  expect(result.framesAfterClose).toBe(0);
  expect(result.errors).toEqual([]);
  expect(result.visibleBefore).toBe(true);
  expect(result.visibleAfterStyle).toBe(true);
  expect(result.visibleAfterRestore).toBe(true);
});
test('старый CFI из HTML-таблицы переносится в XHTML без потери позиции', async ({
  page,
}) => {
  await openBook(page, {
    cover: true,
    chapters: [
      {
        name: 'table.xhtml',
        text: 'До. Восстановить нужное слово. После.',
        markup:
          '<table><tr><td>До. Восстановить нужное слово. После.</td></tr></table>',
      },
    ],
    toc: [0],
  });
  const url = page.url();
  await expect(page.frameLocator('iframe').locator('tbody')).toHaveCount(0);
  await page.getByRole('button', { name: 'Закрыть книгу' }).click();
  await expect(
    page.getByRole('heading', { name: 'Библиотека', exact: true }),
  ).toBeVisible();
  const expected = await page.evaluate(async () => {
    const path = '/tests/fixtures/position-harness.ts';
    const loaded: unknown = await import(path);
    return await (
      loaded as typeof import('../fixtures/position-harness')
    ).seedLegacyTablePosition();
  });
  await page.goto(url);
  await expect(
    page.getByRole('button', { name: 'Оформление чтения' }),
  ).toBeEnabled({ timeout: 20000 });
  const saved = await page.evaluate(async () => {
    const path = '/src/infrastructure/local-store.ts';
    const loaded: unknown = await import(path);
    const store = (
      loaded as typeof import('../../src/infrastructure/local-store')
    ).createLocalStore();
    try {
      return (await store.repositories.positions.list())[0]?.cursor;
    } finally {
      store.close();
    }
  });
  expect(saved).toEqual(expected);
});
test('CDATA остаётся читаемым текстом в отображении и текстовом индексе', async ({
  page,
}) => {
  await openBook(page, {
    chapters: [
      {
        name: 'cdata.xhtml',
        text: 'До. Текст <внутри> & после. Конец.',
        markup: '<p>До. <![CDATA[Текст <внутри> & после.]]> Конец.</p>',
      },
    ],
    toc: [0],
  });
  await expect(page.frameLocator('iframe').locator('body')).toContainText(
    'Текст <внутри> & после.',
  );
  const text = await page.evaluate(async () => {
    const path = '/src/infrastructure/local-store.ts';
    const loaded: unknown = await import(path);
    const store = (
      loaded as typeof import('../../src/infrastructure/local-store')
    ).createLocalStore();
    try {
      return (await store.repositories.documentTextIndexes.list())[0]
        ?.sections[0]?.text;
    } finally {
      store.close();
    }
  });
  expect(text).toBe('До. Текст <внутри> & после. Конец.');
});
test('страницы: мобильное открытие, перелистывание, закрытие и восстановление позиции', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openBook(page);
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.locator('[data-testid="reader-host"] iframe')).toHaveCount(
    1,
  );
  await expect(
    page.locator('[data-testid="reader-host"] iframe'),
  ).toHaveAttribute('sandbox', 'allow-same-origin');
  const first = await position(page);
  await page
    .getByRole('button', { name: 'Следующая страница', exact: true })
    .click();
  await expect.poll(() => position(page)).not.toBe(first);
  await expect(
    page.getByText('Позиция сохранена', { exact: true }),
  ).toBeVisible();
  const saved = await position(page);
  await page.screenshot({
    path: test.info().outputPath('reader-page.png'),
    animations: 'disabled',
    scale: 'css',
  });
  await page.getByRole('button', { name: 'Закрыть книгу' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Библиотека' }),
  ).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  await page
    .getByRole('list', { name: 'Книги библиотеки' })
    .getByRole('button', { name: /Длинная книга для чтения/ })
    .click();
  await page
    .getByRole('button', { name: 'Читать файл reader.epub', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Следующая страница', exact: true }),
  ).toBeEnabled({ timeout: 20000 });
  await expect.poll(() => position(page)).toBe(saved);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('вся книга: последовательный spine, неполное оглавление и конец текста', async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openBook(page);
  const next = page.getByRole('button', {
    name: 'Следующая страница',
    exact: true,
  });
  const chapters = new Set<string>();
  let turns = 0;
  while ((await next.isEnabled()) && turns < 100) {
    const before = await position(page);
    await next.click();
    await expect(
      page.getByText('Позиция сохранена', { exact: true }),
    ).toBeVisible();
    await expect.poll(() => position(page)).not.toBe(before);
    chapters.add(await page.locator('.reader-chapter').innerText());
    turns++;
  }
  expect(turns).toBeGreaterThan(5);
  expect(turns).toBeLessThan(100);
  expect([...chapters].some((title) => title.includes('2'))).toBe(true);
  await expect(next).toBeDisabled();
  // Reaching the final screen does not imply traversing every character on it.
  const progress = Number(
    await page.getByRole('progressbar').getAttribute('value'),
  );
  expect(progress).toBeGreaterThan(0.5);
  expect(progress).toBeLessThan(1);
  const frame = page.frameLocator('[data-testid="reader-host"] iframe');
  await expect(frame.locator('body')).toContainText('Конец всей книги.');
  await page
    .getByRole('button', { name: 'Предыдущая страница', exact: true })
    .click();
  await expect(next).toBeEnabled();
});

test('оформление, поворот экрана, прокрутка и переходы по разделам', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 320, height: 740 });
  await openBook(page);
  await page
    .getByRole('button', { name: 'Следующая страница', exact: true })
    .click();
  await expect(
    page.getByText('Позиция сохранена', { exact: true }),
  ).toBeVisible();
  const saved = await position(page);
  await page.getByRole('button', { name: 'Оформление чтения' }).click();
  await page.getByRole('radio', { name: 'Сепия', exact: true }).check();
  await page.getByLabel('Шрифт чтения', { exact: true }).selectOption('sans');
  await page
    .getByRole('slider', { name: 'Размер шрифта', exact: true })
    .fill('24');
  await page.getByRole('slider', { name: 'Поля', exact: true }).fill('32');
  await page
    .getByRole('slider', { name: 'Межстрочный интервал', exact: true })
    .fill('1.8');
  await page.getByRole('radio', { name: 'По ширине', exact: true }).check();
  await page.getByLabel('Плавные переходы панелей').uncheck();
  await page.getByRole('button', { name: 'Применить оформление' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.reader-screen')).toHaveAttribute(
    'data-reader-theme',
    'sepia',
  );
  await expect.poll(() => position(page)).toBe(saved);
  await expect(page.locator('iframe')).toHaveCount(1);
  await page.setViewportSize({ width: 740, height: 320 });
  await expect(
    page.getByText('Позиция сохранена', { exact: true }),
  ).toBeVisible();
  await expect.poll(() => position(page)).toBe(saved);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Оформление чтения' }).click();
  await page.getByRole('radio', { name: 'Прокрутка', exact: true }).check();
  await page.getByRole('button', { name: 'Применить оформление' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Следующий раздел', exact: true }),
  ).toBeEnabled();
  const beforeScroll = await position(page);
  await page.locator('.reader-host .epub-container').evaluate((element) => {
    element.scrollTop += 600;
  });
  await expect.poll(() => position(page)).not.toBe(beforeScroll);
  await page.getByRole('button', { name: 'Оглавление' }).click();
  await page.getByText('Все текстовые разделы (3)', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Раздел 2 · middle.xhtml', exact: true })
    .click();
  await expect(page.locator('.reader-chapter')).toContainText('Раздел 2');
  await expect(page.frameLocator('iframe').locator('body')).toContainText(
    'Середина без оглавления.',
  );
  await page
    .getByRole('button', { name: 'Следующий раздел', exact: true })
    .click();
  await expect(page.locator('.reader-chapter')).toContainText('Раздел 3');
  await page.getByRole('button', { name: 'Закрыть книгу' }).click();
  await expect(page).toHaveURL(/#\/library$/);
  await page.reload();
  await page
    .getByRole('list', { name: 'Книги библиотеки' })
    .getByRole('button', { name: /Длинная книга для чтения/ })
    .click();
  await page
    .getByRole('button', { name: 'Читать файл reader.epub', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Предыдущий раздел', exact: true }),
  ).toBeEnabled({ timeout: 20000 });
  await expect(page.locator('.reader-screen')).toHaveAttribute(
    'data-reader-theme',
    'sepia',
  );
  await expect(page.locator('.reader-chapter')).toContainText('Раздел 3');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('касания и выделение не вызывают двойное перелистывание; экземпляр удаляется', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBook(page);
  const host = page.locator('[data-testid="reader-host"]');
  const box = await host.boundingBox();
  if (!box) throw new Error('Нет области чтения');
  await page.mouse.click(box.x + box.width / 2, box.y + 100);
  await expect(
    page.getByRole('button', { name: 'Показать панели' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Показать панели' }).click();
  const before = await position(page);
  await page
    .frameLocator('iframe')
    .locator('body')
    .evaluate((element) => {
      const selection = element.ownerDocument.defaultView?.getSelection();
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
  await page.mouse.click(box.x + box.width - 45, box.y + 100);
  await expect.poll(() => position(page)).toBe(before);
  await page
    .frameLocator('iframe')
    .locator('body')
    .evaluate((element) =>
      element.ownerDocument.defaultView?.getSelection()?.removeAllRanges(),
    );
  await page.mouse.click(box.x + box.width - 45, box.y + 100);
  await expect.poll(() => position(page)).not.toBe(before);
  await page.getByRole('button', { name: 'Закрыть книгу' }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('нативные сенсорные жесты: один свайп — одна страница, касание центра — панели', async ({
  page,
  isMobile,
  browserName,
}) => {
  test.skip(
    !isMobile || browserName !== 'chromium',
    'Требуется Chromium с сенсорным вводом',
  );
  await openBook(page);
  const initial = await position(page);
  const box = await page.locator('[data-testid="reader-host"]').boundingBox();
  if (!box) throw new Error('Нет области чтения');
  const cdp = await page.context().newCDPSession(page);
  const y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: box.x + 280, y }],
  });
  for (const x of [250, 210, 160, 100])
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: box.x + x, y }],
    });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect.poll(() => position(page)).not.toBe(initial);
  await expect(
    page.getByText('Позиция сохранена', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Предыдущая страница', exact: true })
    .click();
  await expect.poll(() => position(page)).toBe(initial);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + 100);
  await expect(
    page.getByRole('button', { name: 'Показать панели' }),
  ).toBeVisible();
  await cdp.detach();
});

test('EPUB 2: заголовок, курсив, иллюстрация и узкий экран без переполнения', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBook(page, {
    version: '2',
    cover: true,
    chapters: [
      {
        name: 'illustrated.xhtml',
        text: 'Заголовок. Курсив и длинный русский текст.',
        markup:
          '<h1>Заголовок</h1><p><em>Курсив</em> и <span style="color:black;font-family:monospace;font-size:8px">длинный русский текст.</span></p><img src="cover.png" width="2400" alt="Большое изображение"/>',
      },
    ],
    toc: [0],
  });
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('h1')).toHaveText('Заголовок');
  await expect(frame.locator('em')).toHaveCSS('font-style', 'italic');
  await expect(frame.getByAltText('Большое изображение')).toBeVisible();
  expect(
    await frame
      .getByAltText('Большое изображение')
      .evaluate((image) => image.getBoundingClientRect().width <= 272),
  ).toBe(true);
  await expect(
    frame.locator('meta[http-equiv="Content-Security-Policy"]'),
  ).toHaveAttribute('content', /script-src 'none'/);
  await page.getByRole('button', { name: 'Оформление чтения' }).click();
  await page.getByRole('radio', { name: 'Тёмная', exact: true }).check();
  await page.getByRole('button', { name: 'Применить оформление' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(frame.locator('body')).toHaveCSS(
    'background-color',
    'rgb(25, 27, 25)',
  );
  await expect(frame.locator('span')).toHaveCSS('color', 'rgb(238, 238, 230)');
  await expect(frame.locator('span')).toHaveCSS('font-size', '20px');
  await page.screenshot({
    path: test.info().outputPath('reader-dark.png'),
    animations: 'disabled',
    scale: 'css',
  });
  expect(errors).toEqual([]);
});

test('отказ записи позиции сохраняет прежнее место и допускает повторение', async ({
  page,
}) => {
  await openBook(page);
  const initial = await position(page);
  await page.evaluate(() => {
    const original = Object.getOwnPropertyDescriptor(
      IDBObjectStore.prototype,
      'put',
    );
    if (!original) throw new Error('Missing IndexedDB put');
    IDBObjectStore.prototype.put = function () {
      throw new DOMException('full', 'QuotaExceededError');
    };
    window.addEventListener(
      'restore-reader-writes',
      () => Object.defineProperty(IDBObjectStore.prototype, 'put', original),
      { once: true },
    );
  });
  await page
    .getByRole('button', { name: 'Следующая страница', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Сообщение читалки' }).getByRole('alert'),
  ).toContainText('Недостаточно места');
  expect(await position(page)).toBe(initial);
  await page.getByRole('button', { name: 'Закрыть книгу' }).click();
  await expect(
    page.getByRole('heading', { name: 'Выйти без сохранения?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Продолжить чтение' }).click();
  await page.evaluate(() =>
    window.dispatchEvent(new Event('restore-reader-writes')),
  );
  await page.getByRole('button', { name: 'Повторить сохранение' }).click();
  await expect(
    page.getByText('Позиция сохранена', { exact: true }),
  ).toBeVisible();
  await expect.poll(() => position(page)).not.toBe(initial);
});

test('закрытие во время открытия не оставляет старых iframe или ошибок', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBook(page);
  const url = page.url();
  await page.getByRole('button', { name: 'Закрыть книгу' }).click();
  await expect(
    page.getByRole('heading', { name: 'Библиотека', exact: true }),
  ).toBeVisible();
  await page.goto(url);
  await page.getByRole('button', { name: 'Закрыть книгу' }).click();
  await expect(
    page.getByRole('heading', { name: 'Библиотека', exact: true }),
  ).toBeVisible();
  await page.goto(url);
  await expect(
    page.getByRole('button', { name: 'Оформление чтения' }),
  ).toBeEnabled({ timeout: 20000 });
  await expect(page.locator('iframe')).toHaveCount(1);
  await page.getByRole('button', { name: 'Закрыть книгу' }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(errors).toEqual([]);
});
