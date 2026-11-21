import { expect, test } from '@playwright/test';
import { makeEpubFixture } from '../fixtures/epub';
import { libraryAction } from '../fixtures/library-actions';

test.use({ video: { mode: 'on', size: { width: 390, height: 753 } } });

for (const wpm of [200, 780]) {
  test(
    'прокрутка через границу главы · ' + String(wpm),
    async ({ page, browserName, isMobile }) => {
      test.skip(
        browserName !== 'chromium' || !isMobile,
        'Нужен мобильный Chromium',
      );
      test.setTimeout(60000);
      const book = await makeEpubFixture({
        chapters: [
          {
            name: 'river.xhtml',
            text: '',
            markup:
              '<h1>Река</h1>' +
              '<p>Тёмная вода несла ветки и отражала далёкие огни за берегом.</p>'.repeat(
                14,
              ) +
              '<p>Лодочник поднялся на пристань, оглянулся на сонную реку и увидел, как за старым мостом уже зажигались фонари. Над водой тянулся лёгкий туман, и в его белой глубине постепенно исчезали последние отблески заката.</p>',
          },
          {
            name: 'shore.xhtml',
            text: '',
            markup:
              '<h1 id="shore">Берег</h1>' +
              '<p>У тропы стояла высокая сосна, покачиваясь от ветра, пока путники разглядывали знакомые окна и слушали, как где-то вдалеке начинался дождь.</p>'.repeat(
                15,
              ),
          },
        ],
      });
      await page.goto('/');
      await libraryAction(page, 'upload');
      await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
        name: 'guided.epub',
        mimeType: 'application/epub+zip',
        buffer: Buffer.from(book.bytes),
      });
      await page.getByRole('button', { name: 'Добавить и читать' }).click();
      await page.getByRole('button', { name: 'Поиск по книге' }).click();
      await page
        .getByRole('searchbox', { name: 'Слово или фраза' })
        .fill('Лодочник');
      await page
        .getByRole('dialog', { name: 'Поиск по книге' })
        .getByRole('list')
        .getByRole('button')
        .click();
      await page.getByRole('button', { name: 'Читать отсюда' }).click();
      await page.getByRole('button', { name: 'Режимы', exact: true }).click();
      await page
        .getByRole('button', { name: 'С подсветкой текста', exact: true })
        .click();
      const play = page.getByRole('button', {
        name: 'Продолжить',
        exact: true,
      });
      await expect(play).toBeEnabled();
      await page.getByRole('button', { name: /^\d+ слов\/мин$/u }).click();
      await page.getByLabel('Слов в минуту', { exact: true }).fill(String(wpm));
      await page.getByRole('button', { name: 'Применить настройки' }).click();

      const host = page.getByTestId('reader-host');
      const surface = host.locator('.epub-container');
      const mark = host.locator('.speed-word-highlight').first();
      const collect = host.evaluate(
        async (el, duration) => {
          const samples: {
            time: number;
            scroll: number;
            line: number | null;
            max: number;
          }[] = [];
          const start = performance.now();
          await new Promise<void>((resolve) => {
            const sample = () => {
              const surface = el.querySelector('.epub-container');
              const mark = el
                .querySelector('.speed-word-highlight')
                ?.getBoundingClientRect();
              const time = Math.round(performance.now() - start);
              if (surface)
                samples.push({
                  time,
                  scroll: surface.scrollTop,
                  line: mark
                    ? Math.round(
                        mark.top +
                          mark.height / 2 -
                          el.getBoundingClientRect().top,
                      )
                    : null,
                  max: surface.scrollHeight - surface.clientHeight,
                });
              if (time >= duration) resolve();
              else requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          });
          return samples;
        },
        wpm === 200 ? 14500 : 5300,
      );
      await play.click();
      const shore = host
        .locator('iframe')
        .last()
        .contentFrame()
        .locator('#shore');
      await expect(shore).toBeInViewport({ timeout: 20000 });
      await expect(mark).toBeVisible();
      const samples = await collect;
      await test.info().attach('Движение по кадрам', {
        body: JSON.stringify(samples),
        contentType: 'application/json',
      });
      const height = await host.evaluate((el) => el.clientHeight);
      const centered = samples.filter(
        (sample) =>
          sample.line !== null && Math.abs(sample.line - height / 2) <= 16,
      );
      expect(centered.length / samples.length).toBeGreaterThan(0.75);
      const freeze = await surface.evaluate(async (el) => {
        // Click on the first frame that has actually moved, before the line settles.
        let from = el.scrollTop;
        for (let frame = 0; frame < 240; frame++) {
          await new Promise(requestAnimationFrame);
          const at = el.scrollTop;
          if (Math.abs(at - from) >= 2) {
            const pause = document.querySelector<HTMLButtonElement>(
              '.speed-controls button[aria-label="Пауза"]',
            );
            pause?.click();
            await new Promise((resolve) => setTimeout(resolve, 260));
            return { at, afterPause: el.scrollTop };
          }
          from = at;
        }
        throw new Error('Не удалось поставить движущуюся строку на паузу.');
      });
      await expect(play).toBeEnabled();
      expect(freeze.afterPause).toBe(freeze.at);
      await play.click();
      await expect
        .poll(() => surface.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(freeze.at);
      await page.getByRole('button', { name: 'Пауза', exact: true }).click();
      if (wpm === 780) {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await play.click();
        const gaps = await surface.evaluate(async (el) => {
          let from = el.scrollTop;
          let previous = 0;
          const gaps: number[] = [];
          const start = performance.now();
          const sample = (now: number) => {
            if (el.scrollTop === from) return;
            if (previous) gaps.push(now - previous);
            from = el.scrollTop;
            previous = now;
          };
          while (performance.now() - start < 1600) {
            await new Promise<void>((resolve) => {
              requestAnimationFrame((now) => {
                sample(now);
                resolve();
              });
            });
          }
          return gaps;
        });
        expect(gaps.length).toBeGreaterThan(0);
        expect(Math.min(...gaps)).toBeGreaterThan(35);
        await page.getByRole('button', { name: 'Пауза', exact: true }).click();
      }
    },
  );
}
