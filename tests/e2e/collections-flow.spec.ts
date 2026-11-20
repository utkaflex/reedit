import { expect, test } from '@playwright/test';
import { makeEpubFixture } from '../fixtures/epub';
import { makeFb2Fixture } from '../fixtures/fb2';
import { libraryAction } from '../fixtures/library-actions';

for (const width of [390, 1440]) {
  test(`коллекции и первая загрузка · ${String(width)} px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 740 : 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'Загрузить EPUB или FB2', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Добавить', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText('Карточка без файла')).toBeVisible();
    await expect(page.getByText('Для бумажной книги')).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath('empty.png'),
      scale: 'css',
    });

    const collections = page.getByRole('button', {
      name: 'Коллекции',
      exact: true,
    });
    const allBooks = page.getByRole('button', {
      name: 'Все книги',
      exact: true,
    });
    await collections.click();
    await page
      .getByRole('button', { name: 'Создать коллекцию', exact: true })
      .click();
    await page.getByLabel('Название коллекции').fill('Чтение на выходных');
    await page.getByRole('button', { name: 'Сохранить коллекцию' }).click();
    const heading = page.getByRole('heading', {
      name: 'Чтение на выходных',
      exact: true,
    });
    await expect(heading).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Добавить книги', exact: true }),
    ).toBeVisible();
    await allBooks.click();

    const epub = await makeEpubFixture({
      title: 'Сад вечерних историй',
      chapters: [
        {
          name: 'garden.xhtml',
          text: 'Тихий сад хранит истории, которые возвращаются вместе с весной. '.repeat(
            80,
          ),
        },
      ],
    });
    await libraryAction(page, 'upload');
    const upload = page.getByLabel('Файл книги', { exact: true });
    const epubFile = {
      name: 'garden.epub',
      mimeType: 'application/epub+zip',
      buffer: Buffer.from(epub.bytes),
    };
    await upload.setInputFiles(epubFile);
    await expect(
      page.getByRole('button', { name: 'Добавить в библиотеку', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Добавить и читать', exact: true })
      .click();
    const appear = page.getByRole('button', { name: 'Оформление чтения' });
    const close = page.getByRole('button', { name: 'Закрыть книгу' });
    await expect(appear).toBeEnabled({ timeout: 20000 });
    await close.click();

    await libraryAction(page, 'upload');
    await upload.setInputFiles({
      name: 'letters.fb2',
      mimeType: 'application/x-fictionbook+xml',
      buffer: Buffer.from(
        makeFb2Fixture({ title: 'Письма к морю' }).source.replace(
          /<coverpage>.*?<\/coverpage>/u,
          '',
        ),
      ),
    });
    await expect(
      page.getByRole('button', { name: 'Добавить и читать', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Добавить в библиотеку', exact: true })
      .click();
    const book = page.getByRole('dialog', { name: 'Письма к морю' });
    await book
      .getByRole('button', { name: 'Читать файл letters.fb2', exact: true })
      .click();
    await expect(appear).toBeEnabled({ timeout: 20000 });
    await expect(page.frameLocator('iframe').locator('body')).toContainText(
      'Первая часть',
    );
    await close.click();

    await libraryAction(page, 'manual');
    await page.getByLabel('Название', { exact: true }).fill('Бумажный блокнот');
    await page
      .getByRole('button', { name: 'Добавить в библиотеку', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Бумажный блокнот' })
      .getByRole('button', { name: 'Закрыть', exact: true })
      .click();

    await collections.click();
    const picker = page.getByRole('dialog', { name: 'Коллекции', exact: true });
    await picker
      .getByRole('button', { name: 'Чтение на выходных', exact: true })
      .click();
    await expect(heading).toBeVisible();
    await page
      .getByRole('button', { name: 'Добавить книги', exact: true })
      .click();
    const editor = page.getByRole('dialog', { name: 'Добавить книги' });
    const search = editor.getByRole('searchbox', {
      name: 'Поиск книг для коллекции',
    });
    await search.fill('Сад');
    await expect(editor.getByRole('checkbox')).toHaveCount(1);
    await editor
      .getByRole('checkbox', { name: /Сад вечерних историй/u })
      .check();
    await search.fill('Авторов');
    await expect(editor.getByRole('checkbox')).toHaveCount(1);
    await editor.getByRole('checkbox', { name: /Письма к морю/u }).check();
    await expect(editor.getByRole('status')).toHaveText('Выбрано: 2');
    await search.fill('Сад');
    await expect(
      editor.getByRole('checkbox', { name: /Сад вечерних историй/u }),
    ).toBeChecked();
    await editor
      .getByRole('button', { name: 'Сохранить коллекцию', exact: true })
      .click();
    await expect(heading).toBeVisible();
    const shelf = page.getByRole('list', { name: 'Книги библиотеки' });
    await expect(shelf.getByRole('listitem')).toHaveCount(2);
    const resume = page.getByRole('region', { name: 'Продолжить чтение' });
    await expect(resume).toBeHidden();
    await expect(
      shelf.getByRole('button', { name: /^Продолжить/u }),
    ).toHaveCount(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({
      path: test.info().outputPath('collection.png'),
      scale: 'css',
    });
    await allBooks.click();
    await expect(heading).toHaveCount(0);
    await expect(shelf.getByRole('listitem')).toHaveCount(3);
    await expect(resume).toBeVisible();

    await libraryAction(page, 'upload');
    await upload.setInputFiles(epubFile);
    await page
      .getByRole('button', { name: 'Открыть сохранённую книгу', exact: true })
      .click();
    await expect(appear).toBeEnabled({ timeout: 20000 });
    await expect(page.frameLocator('iframe').locator('body')).toContainText(
      'Тихий сад',
    );
    await close.click();
    await expect(shelf.getByRole('listitem')).toHaveCount(3);
  });
}
