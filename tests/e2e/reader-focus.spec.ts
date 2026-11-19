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
          {
            name: 'notes.xhtml',
            text: '',
            linear: false,
            markup: `<aside id="short" role="doc-footnote">Краткое примечание.</aside><aside id="long" role="doc-footnote">${longNote}</aside>`,
          },
        ],
        toc: [0],
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
      if (format === 'fb2')
        await page.getByRole('button', { name: 'Следующая страница' }).click();
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
      }
      if (format !== 'epub') return;
      const host = page.getByTestId('reader-host');
      const tapCenter = async () => {
        const box = await host.boundingBox();
        if (!box) throw Error('No reader surface');
        await page.touchscreen.tap(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
      };
      await expect(
        page.getByRole('button', { name: 'Режимы чтения' }),
      ).toBeEnabled();
      const geometry = await host.boundingBox();
      await tapCenter();
      await expect(page.locator('.reader-bottom')).toBeHidden();
      expect(await host.boundingBox()).toEqual(geometry);
      await tapCenter();
      await expect(page.locator('.reader-bottom')).toBeVisible();
      for (const mode of ['По одному слову', 'С подсветкой текста']) {
        await page.getByRole('button', { name: 'Режимы чтения' }).click();
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
          page.getByRole('button', { name: 'Режимы чтения' }),
        ).toBeEnabled();
      }
    });
  }
}
