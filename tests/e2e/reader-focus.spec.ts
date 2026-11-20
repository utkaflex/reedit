import { test, expect } from '@playwright/test';
import { makeEpubFixture } from '../fixtures/epub';
import { makeFb2Fixture } from '../fixtures/fb2';
import { libraryAction } from '../fixtures/library-actions';

test.use({ video: { mode: 'on', size: { width: 390, height: 780 } } });

const longNote =
  'Длинное примечание объясняет происхождение выражения. '.repeat(65);

for (const width of [320, 390]) {
  for (const format of ['epub', 'fb2'] as const) {
    test(`чтение и примечания ${format} ${String(width)}`, async ({ page }) => {
      test.setTimeout(45000);
      await page.setViewportSize({ width, height: 780 });
      const sentence =
        'Когда мы вышли из дома перед самым рассветом, у дороги уже стоял человек, который ждал нашего возвращения, чтобы рассказать о событиях прошлого вечера';
      const epub = await makeEpubFixture({
        chapters: [
          {
            name: 'text.xhtml',
            text: '',
            markup: `<p>Начало <a role="doc-noteref" href="notes.xhtml#short">1</a> и <a role="doc-noteref" href="notes.xhtml#long">2</a>.</p><p>${Array.from({ length: 15 }, () => sentence).join(', ')}.</p>`,
          },
          { name: 'next.xhtml', text: 'Другая глава начинается у пристани.' },
          {
            name: 'notes.xhtml',
            text: '',
            linear: false,
            markup: `<aside id="short" role="doc-footnote">Краткое примечание.</aside><aside id="long" role="doc-footnote">${longNote}</aside>`,
          },
        ],
        toc: [0, 1],
      });
      const fb2 = makeFb2Fixture()
        .source.replace(
          '<poem>',
          '<p>Сноски <a l:href="#note1" type="note">4</a> и <a l:href="#note2" type="note">5</a>.</p><poem>',
        )
        .replace(
          '</section></body><binary',
          `</section><section id="note2"><p>${longNote}</p></section></body><binary`,
        );
      await page.goto('/');
      await libraryAction(page, 'upload');
      await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
        name: 'reader.' + format,
        mimeType:
          format === 'epub'
            ? 'application/epub+zip'
            : 'application/x-fictionbook+xml',
        buffer: Buffer.from(
          format === 'epub' ? Buffer.from(epub.bytes) : Buffer.from(fb2),
        ),
      });
      await page.getByRole('button', { name: 'Добавить и читать' }).click();
      if (format === 'fb2') {
        await page.getByRole('button', { name: 'Оформление чтения' }).waitFor();
        const book = page.getByRole('button', { name: 'Оформление чтения' });
        await expect(book).toBeEnabled();
        await page.getByRole('button', { name: 'Оглавление' }).click();
        await page.getByRole('button', { name: 'Начало', exact: true }).click();
        await page
          .getByRole('button', { name: 'Читать отсюда', exact: true })
          .click();
      }
      const noteProgress = page.getByRole('progressbar', {
        name: 'Прогресс по читаемому тексту',
      });
      const beforeNote = await noteProgress.getAttribute('value');
      const frame = page.locator('iframe').last().contentFrame();
      for (const [index, label] of (format === 'epub'
        ? ['1', '2']
        : ['4', '5']
      ).entries()) {
        const link = frame.getByRole('link', { name: label, exact: true });
        await expect(link).toHaveCSS('vertical-align', 'super');
        await link.click();
        const note = page.getByRole('dialog', { name: 'Примечание' });
        await expect(note).toContainText(
          index ? 'Длинное примечание' : /Краткое примечание|Текст примечания/,
        );
        if (index) {
          const scrollable = await note
            .locator('.dialog__body')
            .evaluate((el) => el.scrollHeight > el.clientHeight);
          expect(scrollable).toBe(true);
        }
        await note
          .getByRole('button', { name: 'К тексту', exact: true })
          .click();
        await expect(link).toBeVisible();
        await expect(noteProgress).toHaveAttribute('value', beforeNote ?? '');
      }
      if (format !== 'epub') {
        await page.getByRole('button', { name: 'Закрыть книгу' }).click();
        await page
          .getByRole('button', { name: 'Продолжить чтение', exact: true })
          .click();
        await expect(
          frame.getByRole('link', { name: '4', exact: true }),
        ).toBeInViewport();
        await expect(noteProgress).toHaveAttribute('value', beforeNote ?? '');
        return;
      }
      const host = page.getByTestId('reader-host');
      const tapCenter = async () => {
        const box = await host.boundingBox();
        if (!box) throw Error('No reader surface');
        await page.touchscreen.tap(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
      };
      await expect(page.getByRole('button', { name: 'Режимы' })).toBeEnabled();
      const geometry = await host.boundingBox();
      if (!geometry) throw Error('No reader surface');
      for (const bar of ['.reader-top', '.reader-bottom']) {
        const buttons = page.locator(bar).getByRole('button');
        for (const button of await buttons.all()) {
          const rect = await button.boundingBox();
          if (!rect) continue;
          expect(rect.width).toBeGreaterThanOrEqual(44);
          expect(rect.height).toBeGreaterThanOrEqual(44);
          expect(
            bar === '.reader-top'
              ? rect.y + rect.height <= geometry.y
              : rect.y >= geometry.y + geometry.height,
          ).toBe(true);
        }
      }
      await tapCenter();
      await expect(page.locator('.reader-top')).toBeHidden();
      await expect(page.locator('.reader-bottom')).toBeHidden();
      expect(await host.boundingBox()).toEqual(geometry);
      await tapCenter();
      await expect(page.locator('.reader-bottom')).toBeVisible();
      const progress = page.getByRole('progressbar', {
        name: 'Прогресс по читаемому тексту',
      });
      const origin = await progress.getAttribute('value');
      await page.getByRole('button', { name: 'Оглавление' }).click();
      await page.getByRole('button', { name: 'Раздел 2', exact: true }).click();
      await expect(frame.locator('body')).toContainText('Другая глава');
      await page
        .getByRole('button', { name: 'К месту чтения', exact: true })
        .click();
      await expect(frame.locator('body')).toContainText('Когда мы вышли');
      await expect(progress).toHaveAttribute('value', origin ?? '');
      await page.getByRole('button', { name: 'Оформление чтения' }).click();
      const appearance = page.getByRole('dialog', {
        name: 'Оформление чтения',
      });
      await expect(
        appearance.getByRole('radio', { name: 'Книжный' }),
      ).toBeVisible();
      await appearance.getByRole('button', { name: 'Увеличить шрифт' }).click();
      await appearance
        .getByRole('button', { name: 'Применить оформление' })
        .click();
      await expect(appearance).toBeHidden();
      await expect(progress).toHaveAttribute('value', origin ?? '');

      for (const mode of ['По одному слову', 'С подсветкой текста']) {
        await page.getByRole('button', { name: 'Режимы' }).click();
        await page.getByRole('button', { name: mode, exact: true }).click();
        const play = page.getByRole('button', {
          name: 'Продолжить',
          exact: true,
        });
        await expect(play).toBeEnabled();
        const back = page.getByRole('button', {
          name: 'К тексту',
          exact: true,
        });
        await expect(back).toBeVisible();
        if (mode === 'С подсветкой текста') {
          await play.click();
          const faster = page.getByRole('button', {
            name: 'Увеличить скорость',
          });
          const slower = page.getByRole('button', {
            name: 'Уменьшить скорость',
          });
          await faster.evaluate((button) => {
            for (let index = 0; index < 3; index++)
              (button as HTMLButtonElement).click();
          });
          await slower.click();
          await expect(
            page.getByRole('button', { name: '270 слов/мин', exact: true }),
          ).toBeVisible();
          const scroll = host.locator('.epub-container');
          await expect
            .poll(() => scroll.evaluate((el) => el.scrollTop), {
              timeout: 18000,
            })
            .toBeGreaterThan(30);
          await tapCenter();
          await expect(back).toBeHidden();
          await tapCenter();
          await page
            .getByRole('button', { name: 'Пауза', exact: true })
            .click();
        }
        await back.click();
        await expect(
          page.getByRole('button', { name: 'Режимы' }),
        ).toBeEnabled();
      }
    });
  }
}

const personalFixture = process.env.REEDIT_VISUAL_EPUB;
if (personalFixture) {
  for (const width of [320, 390]) {
    test(`снимки реальной книги ${String(width)}`, async ({ page }) => {
      test.setTimeout(45000);
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript(() => {
        localStorage.setItem('reedit-reader-gesture', 'seen');
      });
      await page.goto('/');
      await libraryAction(page, 'upload');
      await page
        .getByLabel('Файл книги', { exact: true })
        .setInputFiles(personalFixture);
      await page.getByRole('button', { name: 'Добавить и читать' }).click();
      const appearance = page.getByRole('button', {
        name: 'Оформление чтения',
      });
      await expect(appearance).toBeEnabled({ timeout: 20000 });
      await page.getByRole('button', { name: 'Оглавление' }).click();
      const toc = page.getByRole('dialog', { name: 'Оглавление' });
      await toc
        .getByRole('button', { name: /Кровавый спорт/i })
        .first()
        .click();
      const host = page.getByTestId('reader-host');
      await expect(appearance).toBeEnabled();
      await expect(
        host.locator('iframe').last().contentFrame().locator('body'),
      ).toContainText(/Кровавый спорт/i);
      await page.getByRole('button', { name: 'Оглавление' }).click();
      await toc.getByRole('button', { name: 'Читать отсюда' }).click();
      const area = await host.boundingBox();
      if (!area) throw Error('No reading surface');
      await page.screenshot({
        path: test.info().outputPath('controls.png'),
        scale: 'css',
      });
      await page.touchscreen.tap(
        area.x + area.width / 2,
        area.y + area.height / 2,
      );
      await expect(appearance).toBeHidden();
      await page.screenshot({
        path: test.info().outputPath('clean.png'),
        scale: 'css',
      });
      await page.touchscreen.tap(
        area.x + area.width / 2,
        area.y + area.height / 2,
      );
      await appearance.click();
      await expect(
        page.getByRole('dialog', { name: 'Оформление чтения' }),
      ).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath('appearance.png'),
        scale: 'css',
      });
      await page.getByRole('radio', { name: 'Прокрутка', exact: true }).check();
      await page.getByRole('button', { name: 'Применить оформление' }).click();
      await expect(appearance).toBeEnabled();
      await page.getByRole('button', { name: 'Оглавление' }).click();
      await toc
        .getByRole('button', { name: /Кровавый спорт — фрагмент 5/u })
        .click();
      const link = host
        .locator('iframe')
        .last()
        .contentFrame()
        .getByRole('link', { name: '[1]', exact: true });
      await expect(link).toHaveCSS('vertical-align', 'super');
      await link.click();
      const note = page.getByRole('dialog', { name: 'Примечание' });
      await expect(note.locator('.reader-footnote-text')).not.toHaveText('1');
      await expect(note.locator('.reader-footnote-text')).toBeVisible();
      await note.getByRole('button', { name: 'К тексту', exact: true }).click();
      await expect(note).toBeHidden();
    });
  }
}
