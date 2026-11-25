import { expect, test } from '@playwright/test';
import { libraryAction } from '../fixtures/library-actions';
import { makeEpubFixture } from '../fixtures/epub';

for (const width of [320, 390]) {
  test(
    'панели и временные переходы · ' + String(width),
    async ({ page, isMobile }) => {
      test.skip(!isMobile, 'Мобильный профиль');
      test.setTimeout(65000);
      await page.setViewportSize({ width, height: 740 });
      const passage =
        '<p>Утренний свет мягко падал на стол, пока за открытым окном слышались шаги.</p>';
      const fixture = await makeEpubFixture({
        title: 'Кэрри',
        chapters: [
          {
            name: 'start.xhtml',
            text: '',
            markup:
              '<h1>Первая глава</h1><p id="origin">На крыльце лежало письмо. <a role="doc-noteref" href="notes.xhtml#note">[1]</a></p>' +
              passage.repeat(13),
          },
          {
            name: 'second.xhtml',
            text: '',
            markup:
              '<h1>Вторая глава</h1><p>Северный ветер сорвал с крыши лист бумаги.</p>' +
              passage.repeat(13),
          },
          { name: 'intro.xhtml', text: 'Краткое вступление.' },
          {
            name: 'notes.xhtml',
            text: '',
            markup:
              '<aside role="doc-footnote" id="note"><p>Примечание к письму.</p></aside>',
          },
        ],
        extraFiles: {
          'EPUB/nav.xhtml':
            '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Оглавление</title></head><body><nav epub:type="toc"><ol><li><a href="intro.xhtml">Annotation</a></li><li><a href="start.xhtml">Первая глава</a></li><li><a href="second.xhtml">Вторая глава</a></li><li><a href="notes.xhtml">Notes</a></li></ol></nav></body></html>',
        },
      });
      await page.goto('/');
      await libraryAction(page, 'upload');
      await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
        name: 'reader-panels.epub',
        mimeType: 'application/epub+zip',
        buffer: Buffer.from(fixture.bytes),
      });
      await page.getByRole('button', { name: 'Добавить и читать' }).click();
      const title = page.getByRole('heading', { name: 'Кэрри', exact: true });
      const host = page.getByTestId('reader-host');
      const frame = host.locator('iframe').contentFrame();
      const first = frame.locator('#origin');
      const target = frame.getByText(
        'Северный ветер сорвал с крыши лист бумаги.',
        { exact: true },
      );
      const counter = page.locator('.reader-page-button');
      const appearance = page.getByRole('button', {
        name: 'Оформление чтения',
      });
      const contents = page.getByRole('button', { name: 'Оглавление' });
      const openSearch = page.getByRole('button', { name: 'Поиск по книге' });
      const back = page.getByRole('button', {
        name: 'К месту чтения',
        exact: true,
      });
      const keep = page.getByRole('button', {
        name: 'Читать отсюда',
        exact: true,
      });
      const progress = page.getByRole('progressbar', {
        name: 'Прогресс по читаемому тексту',
      });
      const screenshot = async (name: string) => {
        if (width === 320)
          await page.screenshot({
            path: test.info().outputPath(name + '.png'),
            animations: 'disabled',
            scale: 'css',
          });
      };
      await expect(counter).toBeEnabled();
      await expect(first).toBeInViewport();
      expect(
        await title.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await expect(openSearch).toBeVisible();
      await expect(contents).toBeVisible();
      await expect(appearance).toBeVisible();
      const initialRow = await first.boundingBox();
      const initialProgress = await progress.getAttribute('value');
      const bounds = await host.boundingBox();
      if (!bounds) throw Error('Страница не видна');
      const center = () =>
        page.touchscreen.tap(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
      await center();
      await expect(appearance).toBeHidden();
      await expect(counter).toBeHidden();
      expect(await first.boundingBox()).toEqual(initialRow);
      await center();
      await expect(appearance).toBeVisible();
      expect(await first.boundingBox()).toEqual(initialRow);
      await screenshot('reader-header');

      const notes = page.getByRole('dialog', {
        name: 'Цитаты и закладки книги',
      });
      const openNotes = () =>
        page
          .getByRole('button', { name: 'Цитаты и закладки', exact: true })
          .click();
      await openNotes();
      await expect(
        notes.getByRole('heading', { name: 'Цитат пока нет' }),
      ).toBeVisible();
      await expect(
        notes.getByRole('link', { name: 'К библиотеке' }),
      ).toHaveCount(0);
      await notes
        .getByRole('button', { name: 'К тексту', exact: true })
        .click();
      expect(await first.boundingBox()).toEqual(initialRow);
      await openNotes();
      await notes
        .getByRole('button', { name: 'Добавить закладку', exact: true })
        .click();
      await expect(
        notes.getByRole('heading', { name: 'Закладка', exact: true }),
      ).toBeVisible();
      await notes.getByLabel('Действия записи', { exact: true }).click();
      await notes.getByRole('button', { name: 'Редактировать' }).click();
      const rename = page.getByRole('dialog', { name: 'Название закладки' });
      await rename.getByLabel('Название закладки').fill('Письмо на крыльце');
      await rename.getByRole('button', { name: 'Сохранить изменения' }).click();
      await expect(
        notes.getByRole('heading', { name: 'Письмо на крыльце', exact: true }),
      ).toBeVisible();
      await notes.getByRole('button', { name: 'Закрыть', exact: true }).click();
      expect(await first.boundingBox()).toEqual(initialRow);

      const resume = async () => {
        await page
          .getByRole('button', { name: 'Закрыть книгу', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Продолжить чтение', exact: true })
          .click();
        await expect(appearance).toBeEnabled();
      };
      await first.getByRole('link', { name: '[1]', exact: true }).tap();
      const footnote = page.getByRole('dialog', { name: 'Примечание' });
      await expect(footnote.getByText('Примечание к письму.')).toBeVisible();
      await footnote
        .getByRole('button', { name: 'К тексту', exact: true })
        .click();
      await expect(footnote).toBeHidden();
      expect(await first.boundingBox()).toEqual(initialRow);
      await resume();
      await expect(first).toBeInViewport();
      expect(await first.boundingBox()).toEqual(initialRow);

      const jumpWithContents = async () => {
        await contents.click();
        const toc = page.getByRole('dialog', { name: 'Оглавление' });
        await expect(
          toc
            .getByRole('region', { name: 'Вступительные материалы' })
            .getByRole('button', { name: 'Аннотация' }),
        ).toBeVisible();
        await expect(
          toc.getByText('Примечания', { exact: true }),
        ).toBeVisible();
        await toc
          .getByRole('region', { name: 'Главы' })
          .getByRole('button', { name: 'Вторая глава' })
          .click();
        await expect(target).toBeInViewport();
        await expect(back).toBeEnabled();
      };
      await jumpWithContents();
      const second = (await counter.innerText()).split(' ')[1] ?? '';
      expect(Number(second)).toBeGreaterThan(1);
      await back.click();
      await expect(first).toBeInViewport();
      expect(await first.boundingBox()).toEqual(initialRow);

      const jumpPage = async (number: string, capture = false) => {
        await counter.click();
        const dialog = page.getByRole('dialog', { name: 'Перейти к странице' });
        await expect(dialog.getByText(/^Сейчас страница \d+/u)).toBeVisible();
        await expect(
          dialog.getByText(/^Страницы всей книги · от 1 до \d+/u),
        ).toBeVisible();
        if (capture) await screenshot('reader-page-jump');
        const input = dialog.getByLabel('Номер страницы');
        if (capture) {
          await input.focus();
          await page.setViewportSize({ width, height: 380 });
          await expect(input).toBeInViewport();
        }
        await input.fill(number);
        if (capture) {
          await page.setViewportSize({ width, height: 740 });
          await expect(input).toHaveValue(number);
          await expect(
            dialog.getByRole('button', { name: 'Перейти', exact: true }),
          ).toBeEnabled();
        }
        await input.press('Enter');
        await expect(dialog).toBeHidden();
        await expect(back).toBeEnabled();
      };
      await jumpPage(second, true);
      await expect(target).toBeInViewport();
      await back.click();
      await expect(first).toBeInViewport();
      expect(await first.boundingBox()).toEqual(initialRow);
      await jumpPage(second);
      await resume();
      await expect(first).toBeInViewport();
      await expect(progress).toHaveAttribute('value', initialProgress ?? '');

      await openSearch.click();
      const search = page.getByRole('dialog', { name: 'Поиск по книге' });
      const field = search.getByRole('searchbox', { name: 'Слово или фраза' });
      await field.fill('северный ветер');
      const hit = search.getByRole('list').getByRole('button');
      await expect(hit).toBeVisible();
      await screenshot('reader-search');
      await page.setViewportSize({ width, height: 380 });
      await expect(field).toBeInViewport();
      await expect(hit).toBeInViewport();
      await field.press('Enter');
      await expect(field).not.toBeFocused();
      await page.setViewportSize({ width, height: 740 });
      await hit.click();
      await expect(target).toBeInViewport();
      await page.getByRole('button', { name: /^Результаты/u }).click();
      await expect(field).toHaveValue('северный ветер');
      await expect(hit).toHaveAttribute('aria-current', 'location');
      await search
        .getByRole('button', { name: 'Закрыть', exact: true })
        .click();
      await back.click();
      await expect(first).toBeInViewport();
      await expect(progress).toHaveAttribute('value', initialProgress ?? '');
      await openSearch.click();
      await expect(hit).toHaveAttribute('aria-current', 'location');
      await hit.click();
      await expect(keep).toBeEnabled();
      const selectedProgress = await progress.getAttribute('value');
      await keep.click();
      await resume();
      await expect(target).toBeInViewport();
      await expect(progress).toHaveAttribute('value', selectedProgress ?? '');
      await jumpPage('1');
      await expect(first).toBeInViewport();
      await keep.click();
      await resume();
      await expect(first).toBeInViewport();
      await jumpWithContents();
      await keep.click();
      await resume();
      await expect(target).toBeInViewport();
    },
  );
}
