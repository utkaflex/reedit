import { expect, test } from '@playwright/test';
import { makeEpubFixture } from '../fixtures/epub';
import { makeFb2Fixture } from '../fixtures/fb2';
import { libraryAction } from '../fixtures/library-actions';

for (const format of ['epub', 'fb2'] as const) {
  test(`сквозная навигация и восстановление места · ${format}`, async ({
    page,
    browserName,
    isMobile,
  }) => {
    test.skip(
      browserName !== 'chromium' || !isMobile,
      'Требуется сенсорный Chromium',
    );
    test.setTimeout(90000);
    const width = format === 'epub' ? 390 : 320;
    await page.setViewportSize({ width, height: 780 });
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });
    const chapters = ['Первая', 'Вторая'].map((name, chapter) => ({
      name,
      body: Array.from(
        { length: 24 },
        (_, index) =>
          `<p id="line-${String(chapter)}-${String(index)}">${name} глава, абзац ${String(index + 1)}. Утренний свет заполнял комнату, и рассказ о долгой дороге продолжался.</p>`,
      ).join(''),
    }));
    const bytes =
      format === 'epub'
        ? Buffer.from(
            (
              await makeEpubFixture({
                chapters: chapters.map(({ body }, index) => ({
                  name: `chapter-${String(index + 1)}.xhtml`,
                  text: '',
                  markup: body,
                })),
              })
            ).bytes,
          )
        : Buffer.from(
            makeFb2Fixture()
              .source.replace(/<body name="notes">.*?<\/body>/u, '')
              .replace(
                /<body>.*?<\/body>/u,
                `<body>${chapters.map(({ name, body }) => `<section><title><p>${name} глава</p></title>${body}</section>`).join('')}</body>`,
              ),
          );
    await page.goto('/');
    await libraryAction(page, 'upload');
    await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
      name: `sections.${format}`,
      mimeType:
        format === 'epub'
          ? 'application/epub+zip'
          : 'application/x-fictionbook+xml',
      buffer: bytes,
    });
    await page.getByRole('button', { name: 'Добавить и читать' }).click();

    const appearance = page.getByRole('button', { name: 'Оформление чтения' });
    await expect(appearance).toBeEnabled();
    const host = page.getByTestId('reader-host');
    const surface = host.locator('.epub-container');
    const pageButton = page.getByRole('button', {
      name: /^Страница \d+ из \d+$/u,
    });
    await expect(pageButton).toBeVisible();
    const readPage = async () =>
      Number((await pageButton.innerText()).split(' ')[1]);
    const bounds = await host.boundingBox();
    if (!bounds) throw new Error('Область чтения не отображается');
    const middle = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
    const cdp = await page.context().newCDPSession(page);
    const swipe = async (axis: 'x' | 'y', delta: number, slow = false) => {
      const point = (fraction: number) => ({
        ...middle,
        [axis]: middle[axis] + delta * (fraction - 0.5),
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [point(0)],
      });
      for (const fraction of [0.25, 0.5, 0.75, 1]) {
        if (slow) await new Promise((resolve) => setTimeout(resolve, 100));
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [point(fraction)],
        });
      }
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
    };
    const first = host.locator('iframe').first().contentFrame();
    const last = host.locator('iframe').last().contentFrame();
    const endOfFirst = first.getByText(/^Первая глава, абзац 24\./u);
    const startOfSecond = last.getByText(/^Вторая глава, абзац 1\./u);
    const inViewport = (location: typeof endOfFirst) =>
      location.evaluate((element, bounds) => {
        const frame =
          element.ownerDocument.defaultView?.frameElement?.getBoundingClientRect();
        if (!frame) return false;
        // A paragraph can be split between columns, each with its own rectangle.
        return Array.from(element.getClientRects()).some(
          (box) =>
            box.left + frame.left < bounds.x + bounds.width &&
            box.right + frame.left > bounds.x &&
            box.top + frame.top < bounds.y + bounds.height &&
            box.bottom + frame.top > bounds.y,
        );
      }, bounds);

    await surface.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await expect.poll(() => inViewport(endOfFirst)).toBe(true);
    await swipe('x', -160, true);
    await expect(startOfSecond).toBeVisible();
    await expect.poll(() => inViewport(startOfSecond)).toBe(true);
    await expect(pageButton).toBeEnabled();
    const secondStart = await readPage();
    expect(secondStart).toBeGreaterThan(1);
    await expect(appearance).toBeEnabled();
    await swipe('x', 160);
    await expect(endOfFirst).toBeVisible();
    await expect.poll(() => inViewport(endOfFirst)).toBe(true);
    await expect(appearance).toBeEnabled();

    await appearance.click();
    await page.getByRole('radio', { name: 'Прокрутка', exact: true }).check();
    await page.getByRole('button', { name: 'Применить оформление' }).click();
    await expect(appearance).toBeEnabled();
    await expect(startOfSecond).toBeAttached();
    await surface.evaluate((el) => {
      const frame = el.querySelector('iframe');
      if (!frame) throw new Error('Отсутствует первый раздел');
      el.scrollTop =
        el.scrollTop +
        frame.getBoundingClientRect().bottom -
        el.getBoundingClientRect().bottom -
        12;
    });
    await expect.poll(() => inViewport(endOfFirst)).toBe(true);
    await page.touchscreen.tap(middle.x, middle.y);
    await expect(appearance).toBeHidden();
    await swipe('y', -210);
    await expect.poll(() => inViewport(startOfSecond)).toBe(true);
    await swipe('y', 210);
    await expect.poll(() => inViewport(endOfFirst)).toBe(true);
    await expect(appearance).toBeHidden();

    const paragraph = last.getByText(/^Вторая глава, абзац 12\./u);
    const offset = await paragraph.boundingBox();
    if (!offset) throw new Error('Не найден абзац для восстановления');
    await surface.evaluate(
      (el, move) => {
        el.scrollTop += move;
      },
      offset.y - bounds.y - 3,
    );
    await expect
      .poll(async () => (await paragraph.boundingBox())?.y ?? Infinity)
      .toBeLessThan(bounds.y + 25);
    await page.touchscreen.tap(middle.x, middle.y);
    await expect(appearance).toBeVisible();
    const progress = page.getByRole('progressbar', {
      name: 'Прогресс по читаемому тексту',
    });
    await expect
      .poll(async () => Number(await progress.getAttribute('value')))
      .toBeGreaterThan(0.65);
    const saved = await progress.getAttribute('value');
    await page.getByRole('button', { name: 'Оглавление' }).click();
    await page
      .getByRole('button', { name: /^(Раздел 1|Первая глава)$/u })
      .click();
    await expect
      .poll(async () => Number(await progress.getAttribute('value')))
      .toBeLessThan(0.1);
    await page.getByRole('button', { name: 'К месту чтения' }).click();
    await expect(progress).toHaveAttribute('value', saved ?? '');
    await page.getByRole('button', { name: 'Закрыть книгу' }).click();
    await page
      .getByRole('button', { name: 'Продолжить чтение', exact: true })
      .click();
    await expect(appearance).toBeEnabled();
    await expect(progress).toHaveAttribute('value', saved ?? '');
    await expect
      .poll(async () =>
        Math.abs(((await paragraph.boundingBox())?.y ?? Infinity) - bounds.y),
      )
      .toBeLessThan(30);

    await appearance.click();
    await page.getByRole('radio', { name: 'Страницы', exact: true }).check();
    await page.getByRole('button', { name: 'Применить оформление' }).click();
    await expect(appearance).toBeEnabled();
    await expect(progress).toHaveAttribute('value', saved ?? '');
    await expect.poll(() => inViewport(paragraph)).toBe(true);

    await expect(pageButton).toBeVisible();
    const total = async () =>
      Number((await pageButton.innerText()).split(' ').at(-1));
    const jump = async (number: number) => {
      await pageButton.click();
      await expect(page.getByText(/^Страницы всей книги/u)).toBeVisible();
      await page.getByLabel('Номер страницы').fill(String(number));
      await page.getByRole('button', { name: 'Перейти', exact: true }).click();
      await expect(pageButton).toHaveText(
        new RegExp(`^Страница ${String(number)} из `, 'u'),
      );
      const keep = page.getByRole('button', {
        name: 'Читать отсюда',
        exact: true,
      });
      if (await keep.isVisible()) await keep.click();
    };
    const bookTotal = await total();
    expect(bookTotal).toBeGreaterThan(secondStart);
    await jump(secondStart);
    await expect.poll(() => inViewport(startOfSecond)).toBe(true);
    await swipe('x', 160);
    await expect.poll(() => inViewport(endOfFirst)).toBe(true);
    await expect(pageButton).toBeEnabled();
    await expect(pageButton).toHaveText(
      `Страница ${String(secondStart - 1)} из ${String(bookTotal)}`,
    );
    await swipe('x', -160);
    await expect(pageButton).toHaveText(
      `Страница ${String(secondStart)} из ${String(bookTotal)}`,
    );
    await expect(pageButton).toBeEnabled();
    await swipe('x', -160);
    await expect(pageButton).toHaveText(
      `Страница ${String(secondStart + 1)} из ${String(bookTotal)}`,
    );
    await jump(secondStart + 2);
    const paginatedPosition = await progress.getAttribute('value');

    await appearance.click();
    await page
      .getByRole('button', { name: 'Увеличить шрифт' })
      .click({ clickCount: 3 });
    await page.getByRole('button', { name: 'Применить оформление' }).click();
    await expect(appearance).toBeEnabled();
    await expect(progress).toHaveAttribute('value', paginatedPosition ?? '');
    await expect.poll(total).toBeGreaterThan(bookTotal);

    const portraitPageCount = await total();
    await page.setViewportSize({ width: 780, height: width });
    await expect.poll(total).not.toBe(portraitPageCount);
    await expect(progress).toHaveAttribute('value', paginatedPosition ?? '');
    await page.setViewportSize({ width, height: 780 });
    await expect.poll(total).toBe(portraitPageCount);
    await expect(progress).toHaveAttribute('value', paginatedPosition ?? '');

    await appearance.click();
    const widerMargins = page.getByRole('button', { name: 'Увеличить: поля' });
    for (let step = 0; step < 6; step++) await widerMargins.click();
    await page.getByRole('button', { name: 'Применить оформление' }).click();
    await expect(last.locator('body')).toHaveCSS('padding-left', '48px');
    await expect(pageButton).toBeEnabled();
    await expect(progress).toHaveAttribute('value', paginatedPosition ?? '');
    const secondChapterPages = await surface.evaluate((el) =>
      Math.ceil(el.scrollWidth / el.clientWidth),
    );

    const targetPage = await pageButton.innerText();
    await page.getByRole('button', { name: 'Закрыть книгу' }).click();
    await page
      .getByRole('button', { name: 'Продолжить чтение', exact: true })
      .click();
    await expect(pageButton).toHaveText(targetPage);
    await expect(progress).toHaveAttribute('value', paginatedPosition ?? '');
    await jump(1);
    const firstChapterPages = await surface.evaluate((el) =>
      Math.ceil(el.scrollWidth / el.clientWidth),
    );
    expect(await total()).toBe(firstChapterPages + secondChapterPages);
    expect(errors).toEqual([]);
  });
}
