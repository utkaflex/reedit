import { expect, test } from '@playwright/test';
import { makeEpubFixture } from '../fixtures/epub';
import { libraryAction } from '../fixtures/library-actions';

test.use({ video: { mode: 'on', size: { width: 390, height: 780 } } });

for (const [width, version] of [
  [320, '2'],
  [390, '3'],
] as const) {
  test(`мобильная читалка · ${String(width)} · EPUB ${version}`, async ({
    page,
    browserName,
    isMobile,
  }) => {
    test.skip(
      browserName !== 'chromium' || !isMobile,
      'Требуется мобильный Chromium',
    );
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 780 });
    const paragraphs =
      '<p>Строки длинной главы тянулись одна за другой, пока герои дошли до старого дома и увидели свет в окне.</p>'.repeat(
        38,
      );
    const book = await makeEpubFixture({
      version,
      chapters: [
        {
          name: 'start.xhtml',
          text: '',
          markup: `<h1>Дорога</h1>${paragraphs}<p>Последняя строка главы.</p>`,
        },
        {
          name: 'next.xhtml',
          text: '',
          markup: `<h1>У дома</h1><p id="origin">Отсюда начинается новая глава. <a id="ref1" href="#old">[1]</a> <a ${version === '3' ? 'xmlns:epub="http://www.idpf.org/2007/ops" epub:type="noteref"' : 'role="doc-noteref"'} href="#long">[2]</a> <a role="doc-noteref" href="#missing">[3]</a> <a href="#route">4</a></p>${paragraphs}<p id="old">Старое примечание. <a href="#ref1">↩</a></p><aside id="long" role="doc-footnote">${paragraphs}</aside><p id="route">Обычный внутренний переход.</p>${paragraphs}`,
        },
      ],
    });
    await page.goto('/');
    await libraryAction(page, 'upload');
    await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
      name: 'reader.epub',
      mimeType: 'application/epub+zip',
      buffer: Buffer.from(book.bytes),
    });
    await page.getByRole('button', { name: 'Добавить и читать' }).click();
    const appearance = page.getByRole('button', { name: 'Оформление чтения' });
    await expect(appearance).toBeEnabled();
    const host = page.getByTestId('reader-host');
    const surface = host.locator('.epub-container');
    const bounds = await host.boundingBox();
    if (!bounds) throw Error('Область чтения не найдена');
    const center = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
    const cdp = await page.context().newCDPSession(page);
    const swipe = async (axis: 'x' | 'y', delta: number, point = center) => {
      const step = (progress: number) => ({
        ...point,
        [axis]: point[axis] + delta * (progress - 0.5),
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [step(0)],
      });
      for (const progress of [0.25, 0.5, 0.75, 1])
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [step(progress)],
        });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
    };
    const tapCenter = async () => {
      await page.touchscreen.tap(center.x, center.y);
    };
    const frame = host.locator('iframe').last().contentFrame();
    const origin = frame.locator('#origin');
    const ending = host
      .locator('iframe')
      .first()
      .contentFrame()
      .getByText('Последняя строка главы.');
    await surface.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await expect(ending).toBeInViewport();
    const before = await ending.boundingBox();
    await tapCenter();
    await expect(appearance).toBeHidden();
    expect(await ending.boundingBox()).toEqual(before);
    await swipe('x', -154);
    await expect(origin).toBeInViewport();
    await swipe('x', 154);
    await expect(ending).toBeInViewport();
    await swipe('x', -154);
    await expect(origin).toBeInViewport();
    await tapCenter();
    await expect(appearance).toBeEnabled();
    await expect(
      page.getByRole('button', { name: /^Страница 1 из \d+$/u }),
    ).toHaveAttribute('title', 'У дома');
    await page.screenshot({
      path: test.info().outputPath('reader.png'),
      scale: 'css',
    });
    await appearance.click();
    await expect(
      page.getByRole('dialog', { name: 'Оформление чтения' }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath('appearance.png'),
      scale: 'css',
      animations: 'disabled',
    });
    await page.getByRole('radio', { name: 'Прокрутка', exact: true }).check();
    await page.getByRole('button', { name: 'Увеличить шрифт' }).click();
    await page.getByRole('button', { name: 'Применить оформление' }).click();
    await expect(appearance).toBeEnabled();
    await expect(origin).toBeInViewport();
    await tapCenter();
    await expect(appearance).toBeHidden();
    await swipe('y', 185);
    await expect(ending).toBeInViewport();
    await swipe('y', -185);
    await expect(origin).toBeInViewport();
    await tapCenter();
    await expect(appearance).toBeEnabled();

    await origin.evaluate((p) => {
      const range = p.ownerDocument.createRange();
      const text = p.firstChild;
      if (!text) throw Error('Первый текст отсутствует');
      range.setStart(text, 0);
      range.setEnd(text, 22);
      const selection = p.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page
      .getByRole('button', { name: 'Сохранить цитату', exact: true })
      .click();
    await expect(
      page.getByText('Цитата сохранена', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Добавить закладку', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: 'Название закладки' })
      .fill('У дома');
    await page.getByRole('button', { name: 'Сохранить закладку' }).click();

    const progress = page.getByRole('progressbar', {
      name: 'Прогресс по читаемому тексту',
    });
    const stored = await progress.getAttribute('value');
    const note = page.getByRole('dialog', { name: 'Примечание' });
    const closeNote = note.getByRole('button', {
      name: 'К тексту',
      exact: true,
    });
    for (const label of ['[1]', '[2]', '[1]']) {
      const link = origin.getByRole('link', { name: label, exact: true });
      await expect(link).toHaveCSS('vertical-align', 'super');
      const originalRow = await origin.boundingBox();
      await link.tap();
      await expect(note).toContainText(
        label === '[1]' ? 'Старое примечание.' : 'Строки длинной главы',
      );
      if (label === '[2]') {
        const body = note.locator('.dialog__body');
        await body.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        await expect(closeNote).toBeInViewport();
        await swipe('x', 140, { x: center.x, y: 46 });
      } else await closeNote.click();
      await expect(note).toBeHidden();
      await expect.poll(() => origin.boundingBox()).toEqual(originalRow);
      await expect(progress).toHaveAttribute('value', stored ?? '');
    }
    await origin.getByRole('link', { name: '[3]' }).tap();
    await expect(
      page.getByText('Сноска недоступна', { exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(appearance).toBeEnabled();
    await expect(progress).toHaveAttribute('value', stored ?? '');
    const numeric = origin.getByRole('link', { name: '4', exact: true });
    await expect(numeric).toHaveCSS('vertical-align', 'baseline');
    await numeric.click();
    await expect(
      frame.getByText('Обычный внутренний переход.'),
    ).toBeInViewport();
    await page.getByRole('button', { name: 'К месту чтения' }).click();
    await expect(progress).toHaveAttribute('value', stored ?? '');
    await expect(origin).toBeInViewport();

    await page.getByRole('button', { name: 'Режимы', exact: true }).click();
    await page
      .getByRole('button', { name: 'С подсветкой текста', exact: true })
      .click();
    const play = page.getByRole('button', { name: 'Продолжить', exact: true });
    const position = await surface.evaluate((el) => el.scrollTop);
    await play.click();
    await expect
      .poll(() => surface.evaluate((el) => el.scrollTop))
      .not.toBe(position);
    await expect
      .poll(async () => {
        const line = await host
          .locator('.speed-word-highlight')
          .first()
          .boundingBox();
        return line ? Math.abs(line.y + line.height / 2 - center.y) : Infinity;
      })
      .toBeLessThan(75);
    await origin.getByRole('link', { name: '[1]' }).tap();
    await expect(note).toBeVisible();
    await closeNote.click();
    await expect(play).toBeEnabled();
    await page.getByRole('button', { name: 'К тексту', exact: true }).click();
    await expect(appearance).toBeEnabled();
    await expect(origin).toBeInViewport();
    const anchor = await progress.getAttribute('value');
    await page.getByRole('button', { name: 'Закрыть книгу' }).click();
    await page
      .getByRole('button', { name: 'Продолжить чтение', exact: true })
      .click();
    await expect(progress).toHaveAttribute('value', anchor ?? '');
    await expect(origin).toBeInViewport();
  });
}
