import { expect, test } from '@playwright/test';
import { makeEpubFixture } from '../fixtures/epub';
import { makeFb2Fixture } from '../fixtures/fb2';
import { libraryAction } from '../fixtures/library-actions';

test.use({ video: 'on', viewport: { width: 390, height: 780 } });
const carrie = process.env.REEDIT_CARRIE_EPUB;
const offline = process.env.REEDIT_BOOK_PWA === '1';

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
                  .source.replace(/<body name="notes">.*?<\/body>/u, '')
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
      const counter = page.getByRole('button', {
        name: /^Страница \d+ из \d+$/u,
      });
      await expect(counter).toHaveText(/^Страница 1 из (?:[2-9]|\d{2,})$/u, {
        timeout: 30000,
      });
      const total = Number((await counter.innerText()).split(' ').at(-1));
      if (offline) {
        await expect
          .poll(() =>
            page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
          )
          .toBe(true);
        await page.context().setOffline(true);
      }
      const atPage = (number: number) =>
        expect(counter).toHaveText(
          'Страница ' + String(number) + ' из ' + String(total),
        );
      const frame = host.locator('iframe').contentFrame();
      const cover =
        format === 'carrie'
          ? frame.locator('svg image').first()
          : frame.getByRole('img', { name: 'Обложка' });
      const box = await host.boundingBox();
      if (!box) throw Error('Книга не отображается.');
      const cdp = await page.context().newCDPSession(page);
      const swipe = async (direction: -1 | 1, y = box.y + box.height / 2) => {
        const point = (fraction: number) => ({
          x: box.x + box.width / 2 + direction * 176 * (fraction - 0.5),
          y,
        });
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [point(0)],
        });
        for (const fraction of [0.25, 0.5, 0.75, 1]) {
          await new Promise((resolve) => setTimeout(resolve, 75));
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
      const imageRow = async (image: typeof cover) => {
        await expect(image).toBeInViewport();
        const rect = await image.boundingBox();
        if (!rect) throw Error('Изображение не отображается.');
        return rect.y + rect.height / 2;
      };
      // Keep the cover and the resulting chapter visible long enough in the recording.
      const showStep = async () => {
        if (format === 'carrie')
          await new Promise((resolve) => setTimeout(resolve, 550));
      };
      await showStep();
      await swipe(-1, await imageRow(cover));
      await atPage(2);
      let pageAtBoundary: number;
      if (format !== 'carrie') {
        await swipe(
          -1,
          await imageRow(frame.getByRole('img', { name: 'Иллюстрация' })),
        );
        await atPage(3);
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
      };
      await jump(pageAtBoundary);
      await showStep();
      await swipe(-1);
      await atPage(pageAtBoundary + 1);
      if (format !== 'carrie')
        await expect(
          frame.getByText(/^Вторая глава, абзац 1\./u),
        ).toBeInViewport();
      else await expect(counter).toHaveAttribute('title', /^Часть вторая/u);
      await showStep();
      await swipe(1);
      await atPage(pageAtBoundary);
      await showStep();
      await jump(pageAtBoundary + 2);
      const progress = page.getByRole('progressbar', {
        name: 'Прогресс по читаемому тексту',
      });
      const original = await progress.getAttribute('value');
      await page.getByRole('button', { name: 'Закрыть книгу' }).click();
      await page
        .getByRole('button', { name: 'Продолжить чтение', exact: true })
        .click();
      await atPage(pageAtBoundary + 2);
      await expect(progress).toHaveAttribute('value', original ?? '');
    },
  );
}
