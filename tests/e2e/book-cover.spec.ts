import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { makeEpubFixture } from '../fixtures/epub';
import { makeFb2Fixture, coverBase64 } from '../fixtures/fb2';
import { libraryAction } from '../fixtures/library-actions';

test.use({ video: 'on', viewport: { width: 390, height: 780 } });
const carrie = process.env.REEDIT_CARRIE_EPUB;
const offline = process.env.REEDIT_BOOK_PWA === '1';
const swipeBaseline = process.env.REEDIT_SWIPE_BASELINE === '1';

for (const format of ['epub', 'fb2', 'carrie'] as const) {
  test(
    'обложка и границы книги · ' + format,
    async ({ page, isMobile, browserName }) => {
      test.skip(
        !isMobile || browserName !== 'chromium',
        'Требуется мобильный Chromium',
      );
      test.skip(
        format === 'carrie' && !carrie,
        'Нужен локальный экземпляр книги',
      );
      test.setTimeout(90000);
      const chapter = (name: string) =>
        Array.from(
          { length: 20 },
          (_, i) =>
            '<p>' +
            name +
            ', абзац ' +
            String(i + 1) +
            '. Знакомая дорога тянулась вдоль незамерзающей реки до старого моста.</p>',
        ).join('');
      await page.goto('/');
      await libraryAction(page, 'upload');
      const input = page.getByLabel('Файл книги', { exact: true });
      if (format === 'carrie' && carrie) await input.setInputFiles(carrie);
      else {
        const image = (alt: string) =>
          '<img src="cover.png" alt="' + alt + '" style="width:100%;"/>';
        const buffer =
          format === 'epub'
            ? Buffer.from(
                (
                  await makeEpubFixture({
                    cover: true,
                    chapters: [
                      {
                        name: 'cover.xhtml',
                        text: '',
                        markup: image('Обложка'),
                      },
                      {
                        name: 'image.xhtml',
                        text: '',
                        markup:
                          '<a href="first.xhtml">' +
                          image('Иллюстрация') +
                          '</a>',
                      },
                      {
                        name: 'first.xhtml',
                        text: '',
                        markup: chapter('Первая глава'),
                      },
                      {
                        name: 'second.xhtml',
                        text: '',
                        markup: chapter('Вторая глава'),
                      },
                    ],
                  })
                ).bytes,
              )
            : Buffer.from(
                makeFb2Fixture()
                  .source.replace(
                    coverBase64,
                    (await readFile('public/icons/icon-192.png')).toString(
                      'base64',
                    ),
                  )
                  .replace(/<body name="notes">.*?<\/body>/u, '')
                  .replace(
                    /<body>.*?<\/body>/u,
                    '<body><section><image l:href="#cover" alt="Обложка"/></section><section><image l:href="#cover" alt="Иллюстрация"/></section><section>' +
                      chapter('Первая глава') +
                      '</section><section>' +
                      chapter('Вторая глава') +
                      '</section></body>',
                  ),
              );
        await input.setInputFiles({
          name: 'pages.' + format,
          mimeType:
            format === 'epub'
              ? 'application/epub+zip'
              : 'application/x-fictionbook+xml',
          buffer,
        });
      }
      await page.getByRole('button', { name: 'Добавить и читать' }).click();
      const host = page.getByTestId('reader-host');
      const counter = page.locator('.reader-page-button');
      await expect(counter).toHaveText(/^Страница 1 из (?:[2-9]|\d{2,})$/u, {
        timeout: 30000,
      });
      const totalPages = async () =>
        Number((await counter.innerText()).split(' ').at(-1));
      let total = await totalPages();
      if (offline) {
        await expect
          .poll(() =>
            page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
          )
          .toBe(true);
        await page.context().setOffline(true);
      }
      const atPage = async (number: number) => {
        await expect(counter).toHaveText(
          'Страница ' + String(number) + ' из ' + String(total),
        );
        await expect(counter).toBeEnabled();
      };
      const frame = host.locator('iframe').contentFrame();
      const cover =
        format === 'carrie'
          ? frame.locator('svg image').first()
          : frame.getByRole('img', { name: 'Обложка' });
      const box = await host.boundingBox();
      if (!box) throw Error('Книга не отображается.');
      const cdp = await page.context().newCDPSession(page);
      const swipe = async (
        direction: -1 | 1,
        options: {
          y?: number;
          from?: number;
          distance?: number;
          down?: number;
          interval?: number;
          returnToStart?: boolean;
          cancel?: boolean;
        } = {},
      ) => {
        const distance = options.distance ?? 176;
        const from = options.from ?? box.width / 2 - (direction * distance) / 2;
        const point = (fraction: number) => ({
          x: box.x + from + direction * distance * fraction,
          y:
            (options.y ?? box.y + box.height / 2) +
            (options.down ?? 0) * fraction,
        });
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [point(0)],
        });
        for (const fraction of options.returnToStart
          ? [0.25, 0.5, 0.75, 1, 0]
          : [0.25, 0.5, 0.75, 1]) {
          await new Promise((resolve) =>
            setTimeout(resolve, options.interval ?? 75),
          );
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [point(fraction)],
          });
        }
        await cdp.send('Input.dispatchTouchEvent', {
          type: options.cancel ? 'touchCancel' : 'touchEnd',
          touchPoints: [],
        });
      };
      const imageRow = async (image: typeof cover) => {
        await expect(image).toBeInViewport();
        const rect = await image.boundingBox();
        if (!rect) throw Error('Изображение не отображается.');
        return rect.y + rect.height / 2;
      };
      const tap = (fraction: number, y = box.y + box.height / 2) =>
        page.touchscreen.tap(box.x + box.width * fraction, y);
      const tapBelowIllustration = () => tap(0.045, box.y + box.height - 24);
      const appearance = page.getByRole('button', {
        name: 'Оформление чтения',
      });
      const visibleParagraphs = () =>
        frame.locator('p').evaluateAll((paragraphs) => {
          const outerFrame =
            paragraphs[0]?.ownerDocument.defaultView?.frameElement;
          const frameBox = outerFrame?.getBoundingClientRect();
          const viewport = outerFrame
            ?.closest('.epub-container')
            ?.getBoundingClientRect();
          if (!frameBox || !viewport) return [];
          return paragraphs
            .filter((paragraph) =>
              Array.from(paragraph.getClientRects()).some(
                (rect) =>
                  rect.left + frameBox.left < viewport.right &&
                  rect.right + frameBox.left > viewport.left &&
                  rect.top + frameBox.top < viewport.bottom &&
                  rect.bottom + frameBox.top > viewport.top,
              ),
            )
            .map((paragraph) => paragraph.textContent);
        });
      if (swipeBaseline) {
        const y = await imageRow(cover);
        await host.evaluate((element) => {
          const doc = element.querySelector('iframe')?.contentDocument;
          if (!doc) throw new Error('Книга не отображается.');
          for (const type of [
            'touchstart',
            'touchmove',
            'touchend',
            'touchcancel',
          ])
            doc.addEventListener(
              type,
              () => {
                const root = doc.documentElement;
                root.setAttribute(
                  'data-gesture-trace',
                  (root.getAttribute('data-gesture-trace') ?? '') + type + ' ',
                );
              },
              true,
            );
        });
        const trace = frame.locator('html');
        await swipe(-1, {
          y: Math.min(y, box.y + box.height - 24),
          distance: 30,
        });
        await expect(trace).toHaveAttribute(
          'data-gesture-trace',
          /^touchstart (touchmove )+touchend /u,
        );
        await atPage(1);
        await swipe(-1, {
          y,
          from: box.width - 15,
          distance: 64,
          down: 45,
          interval: 350,
        });
        await atPage(2);
        return;
      }
      // Keep the cover and the resulting chapter visible long enough in the recording.
      const showStep = async () => {
        if (format === 'carrie')
          await new Promise((resolve) => setTimeout(resolve, 550));
      };
      await showStep();
      const coverY = await imageRow(cover);
      await swipe(-1, { y: coverY, from: box.width - 6 });
      await new Promise((resolve) => setTimeout(resolve, 350));
      await atPage(1);
      await swipe(-1, { y: coverY, distance: 30, cancel: true });
      await swipe(-1, { y: coverY, distance: 30, returnToStart: true });
      await new Promise((resolve) => setTimeout(resolve, 350));
      await atPage(1);
      await expect(appearance).toBeEnabled();
      await swipe(-1, {
        y: coverY,
        from: box.width - 15,
        distance: 30,
        down: 6,
      });
      await atPage(2);
      await tapBelowIllustration();
      await atPage(1);
      await swipe(-1, { y: await imageRow(cover), from: box.width / 2 });
      await atPage(2);
      let pageAtBoundary: number;
      if (format !== 'carrie') {
        const illustration = frame.getByRole('img', { name: 'Иллюстрация' });
        await swipe(-1, {
          y: await imageRow(illustration),
          from: box.width / 2,
          distance: 30,
          interval: 350,
        });
        await atPage(3);
        if (format === 'epub') {
          await tap(0.045);
          await atPage(2);
          await illustration.tap();
          await atPage(3);
          await page.getByRole('button', { name: 'К месту чтения' }).click();
          await atPage(2);
          await tap(0.96, box.y + box.height - 24);
          await atPage(3);
        }
        await expect(
          frame.getByText(/^Первая глава, абзац 1\./u),
        ).toBeInViewport();
        const sectionPages = await host
          .locator('.epub-container')
          .evaluate((el) => Math.ceil(el.scrollWidth / el.clientWidth));
        pageAtBoundary = 3 + sectionPages - 1;
      } else {
        await showStep();
        await page
          .getByRole('button', { name: 'Оглавление', exact: true })
          .click();
        await page.getByRole('button', { name: /^Часть вторая/u }).click();
        await expect(counter).toHaveAttribute('title', /^Часть вторая/u);
        const startOfPartTwo = Number(
          (await counter.innerText()).split(' ')[1],
        );
        expect(startOfPartTwo).toBeGreaterThan(3);
        pageAtBoundary = startOfPartTwo - 1;
        await page.getByRole('button', { name: 'К месту чтения' }).click();
        await atPage(2);
      }
      const jump = async (number: number) => {
        await counter.click();
        await page.getByLabel('Номер страницы').fill(String(number));
        await page
          .getByRole('button', { name: 'Перейти', exact: true })
          .click();
        await atPage(number);
        const keep = page.getByRole('button', {
          name: 'Читать отсюда',
          exact: true,
        });
        if (await keep.isVisible()) await keep.click();
      };
      await jump(pageAtBoundary);
      await showStep();
      const diagonal = { distance: 64, down: 45 };
      const short = { distance: 30, down: 8 };
      await swipe(-1, diagonal);
      await atPage(pageAtBoundary + 1);
      if (format !== 'carrie')
        await expect(
          frame.getByText(/^Вторая глава, абзац 1\./u),
        ).toBeInViewport();
      else await expect(counter).toHaveAttribute('title', /^Часть вторая/u);
      await showStep();
      await swipe(1, short);
      await atPage(pageAtBoundary);
      await tap(0.5);
      await expect(appearance).toBeHidden();
      await swipe(-1, short);
      await atPage(pageAtBoundary + 1);
      await expect(appearance).toBeHidden();
      await swipe(1, { from: 15 });
      await atPage(pageAtBoundary);
      await expect(appearance).toBeHidden();
      await tap(0.96);
      await atPage(pageAtBoundary + 1);
      await tap(0.045);
      await atPage(pageAtBoundary);
      await tap(0.5);
      await expect(appearance).toBeEnabled();
      await showStep();
      await jump(pageAtBoundary + 2);
      const progress = page.getByRole('progressbar', {
        name: 'Прогресс по читаемому тексту',
      });
      const original = await progress.getAttribute('value');
      const paragraph = (await visibleParagraphs())[0];
      expect(paragraph).toBeTruthy();
      const continueReading = async () => {
        await page.getByRole('button', { name: 'Закрыть книгу' }).click();
        await page
          .getByRole('button', { name: 'Продолжить чтение', exact: true })
          .click();
        await expect(appearance).toBeEnabled();
      };
      await continueReading();
      await atPage(pageAtBoundary + 2);
      await expect(progress).toHaveAttribute('value', original ?? '');
      expect(await visibleParagraphs()).toContain(paragraph);
      if (format !== 'carrie') {
        await appearance.click();
        await page
          .getByRole('button', { name: 'Увеличить шрифт' })
          .click({ clickCount: 3 });
        await page
          .getByRole('button', { name: 'Применить оформление' })
          .click();
        await expect.poll(totalPages).toBeGreaterThan(total);
        total = await totalPages();
        await expect(progress).toHaveAttribute('value', original ?? '');
        expect(await visibleParagraphs()).toContain(paragraph);
        await jump(3);
        const resizedBoundary =
          2 +
          (await host
            .locator('.epub-container')
            .evaluate((element) =>
              Math.ceil(element.scrollWidth / element.clientWidth),
            ));
        await jump(resizedBoundary);
        await swipe(-1, { ...short, interval: 350 });
        await atPage(resizedBoundary + 1);
        await swipe(1, { from: 15 });
        await atPage(resizedBoundary);
        await tap(0.5);
        await expect(appearance).toBeHidden();
        await swipe(-1, diagonal);
        await atPage(resizedBoundary + 1);
        await swipe(1, short);
        await atPage(resizedBoundary);
        await expect(appearance).toBeHidden();
        await tap(0.5);
        await expect(appearance).toBeEnabled();
        const afterFont = resizedBoundary + 2;
        await jump(afterFont);
        const nextParagraph = (await visibleParagraphs())[0];
        expect(nextParagraph).toBeTruthy();
        const saved = await progress.getAttribute('value');
        await continueReading();
        await atPage(afterFont);
        await expect(progress).toHaveAttribute('value', saved ?? '');
        expect(await visibleParagraphs()).toContain(nextParagraph);
        if (!nextParagraph) throw Error('Видимый абзац не найден.');
        await frame
          .getByText(nextParagraph, { exact: true })
          .evaluate((paragraph) => {
            const selection = paragraph.ownerDocument.getSelection();
            const range = paragraph.ownerDocument.createRange();
            range.selectNodeContents(paragraph);
            selection?.removeAllRanges();
            selection?.addRange(range);
          });
        await expect(
          page.getByRole('button', { name: 'Сохранить цитату', exact: true }),
        ).toBeVisible();
        await swipe(-1, diagonal);
        await new Promise((resolve) => setTimeout(resolve, 350));
        await atPage(afterFont);
      }
    },
  );
}
