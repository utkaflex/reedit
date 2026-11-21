import { expect, test } from '@playwright/test';
import { makeEpubFixture } from '../fixtures/epub';
import { makeFb2Fixture } from '../fixtures/fb2';
import { libraryAction } from '../fixtures/library-actions';

for (const [format, width, mode] of [
  ['epub', 320, 'Страницы'],
  ['fb2', 390, 'Прокрутка'],
] as const) {
  test(
    'офлайн-поиск по книге · ' + format,
    async ({ page, browserName, isMobile }) => {
      test.skip(browserName !== 'chromium' || !isMobile, 'Мобильный Chromium');
      await page.setViewportSize({ width, height: 780 });
      const filler =
        '<p>На рассвете дорога свернула к дому мимо тёмного леса.</p>'.repeat(
          28,
        );
      const chapters = [
        {
          name: 'Берег',
          text:
            '<p>Исходный абзац на берегу.</p>' +
            filler +
            '<p>Вечером северный <em>ветер</em> затих.</p>',
        },
        {
          name: 'Маяк',
          text: filler + '<p>У маяка снова дул северный <em>ветер</em>.</p>',
        },
      ];
      const buffer =
        format === 'epub'
          ? Buffer.from(
              (
                await makeEpubFixture({
                  chapters: chapters.map(({ name, text }, index) => ({
                    name: 'chapter-' + String(index) + '.xhtml',
                    text: '',
                    markup: '<h1>' + name + '</h1>' + text,
                  })),
                })
              ).bytes,
            )
          : Buffer.from(
              makeFb2Fixture()
                .source.replace(/<body name="notes">.*?<\/body>/u, '')
                .replace(
                  /<body>.*?<\/body>/u,
                  '<body>' +
                    chapters
                      .map(
                        ({ name, text }) =>
                          '<section><title><p>' +
                          name +
                          '</p></title>' +
                          text.replaceAll('em>', 'emphasis>') +
                          '</section>',
                      )
                      .join('') +
                    '</body>',
                ),
            );
      await page.goto('/');
      await libraryAction(page, 'upload');
      await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
        name: 'search.' + format,
        mimeType:
          format === 'epub'
            ? 'application/epub+zip'
            : 'application/x-fictionbook+xml',
        buffer,
      });
      await page.getByRole('button', { name: 'Добавить и читать' }).click();
      const searchButton = page.getByRole('button', { name: 'Поиск по книге' });
      await expect(searchButton).toBeEnabled();
      if (mode === 'Прокрутка') {
        await page.getByRole('button', { name: 'Оформление чтения' }).click();
        await page.getByRole('radio', { name: mode, exact: true }).check();
        await page
          .getByRole('button', { name: 'Применить оформление' })
          .click();
        await expect(searchButton).toBeEnabled();
      }
      const origin = page
        .locator('.reader-host iframe')
        .first()
        .contentFrame()
        .getByText('Исходный абзац на берегу.');
      await expect(origin).toBeInViewport();
      const progress = page.getByRole('progressbar', {
        name: 'Прогресс по читаемому тексту',
      });
      const readingPlace = await progress.getAttribute('value');
      await page.context().setOffline(true);
      await searchButton.click();
      const dialog = page.getByRole('dialog', { name: 'Поиск по книге' });
      const field = dialog.getByRole('searchbox', { name: 'Слово или фраза' });
      await field.fill('маяк');
      await expect(dialog.getByText('Совпадений: 2')).toBeVisible();
      await field.fill('буквнет?!');
      await expect(dialog.getByText('Ничего не найдено.')).toBeVisible();
      await field.fill('СЕВЕРНЫЙ   ВЕТЕР');
      await expect(dialog.getByText('Совпадений: 2')).toBeVisible();
      await expect(dialog.locator('mark')).toHaveText([
        'северный ветер',
        'северный ветер',
      ]);
      const results = dialog.getByRole('list').getByRole('button');
      await expect(results.first()).toHaveText(/^Берег.*Вечером/u);
      await expect(results.last()).toHaveText(/^Маяк.*У маяка/u);
      await page.setViewportSize({ width, height: 350 });
      await expect(field).toBeInViewport();
      await expect(results.first()).toBeInViewport();
      await results.last().click();
      await page.setViewportSize({ width, height: 780 });
      const highlight = page.locator('.reader-search-highlight span').first();
      await expect(highlight).toBeInViewport();
      await expect(
        page.getByRole('button', { name: 'Результаты · 2 из 2' }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Предыдущее совпадение' }).click();
      await expect(
        page.getByRole('button', { name: 'Результаты · 1 из 2' }),
      ).toBeVisible();
      await expect(highlight).toBeInViewport();
      await page.getByRole('button', { name: 'Следующее совпадение' }).click();
      await page.getByRole('button', { name: 'Результаты · 2 из 2' }).click();
      await expect(field).toHaveValue('СЕВЕРНЫЙ   ВЕТЕР');
      await expect(results.last()).toHaveAttribute('aria-current', 'location');
      await dialog
        .getByRole('button', { name: 'Закрыть', exact: true })
        .click();
      await page.getByRole('button', { name: 'К месту чтения' }).click();
      await expect(origin).toBeInViewport();
      await expect(progress).toHaveAttribute('value', readingPlace ?? '');
      await expect(highlight).toHaveCount(0);

      const jumpToLast = async (searchAgain = false) => {
        await searchButton.click();
        if (searchAgain) await field.fill('северный ветер');
        await results.last().click();
        await expect(
          page.getByRole('button', { name: 'Результаты · 2 из 2' }),
        ).toBeVisible();
      };
      const closeAndResume = async () => {
        await page.getByRole('button', { name: 'Закрыть книгу' }).click();
        await page
          .getByRole('button', { name: 'Продолжить чтение', exact: true })
          .click();
        await expect(searchButton).toBeEnabled();
      };
      await jumpToLast();
      await closeAndResume();
      await expect(origin).toBeInViewport();
      await expect(progress).toHaveAttribute('value', readingPlace ?? '');
      await jumpToLast(true);
      const matchPlace = await progress.getAttribute('value');
      expect(matchPlace).not.toBe(readingPlace);
      await page.getByRole('button', { name: 'Читать отсюда' }).click();
      await closeAndResume();
      await expect(progress).toHaveAttribute('value', matchPlace ?? '');
    },
  );
}
