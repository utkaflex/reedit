/** Original synthetic text and binary fixture, CC0-1.0. Not seeded into the application. */
export const fb2Namespace = 'http://www.gribuser.ru/xml/fictionbook/2.0';
export const coverBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=';
export const expectedFb2Parts = [
  'Первая часть Эпиграф.',
  'Начало Первый абзац с курсивом. Стихотворение Первая строка. Вторая строка. Автор стихов Подраздел Продолжение и примечание 1. Конец первой главы.',
  'Вторая часть. Последний абзац основной книги.',
  'Примечания',
  'Примечание 1 Текст примечания. Вернуться.',
];
export function makeFb2Fixture(
  options: { long?: boolean; title?: string } = {},
) {
  const tail = options.long
    ? ` ${'Длинный русский абзац сохраняет порядок текста и точную позицию. '.repeat(150)}`
    : '';
  const title = options.title ?? 'Синтетическая книга FB2';
  const source = `<?xml version="1.0" encoding="UTF-8"?><FictionBook xmlns="${fb2Namespace}" xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><genre>prose</genre><author><first-name>Иван</first-name><middle-name>Иванович</middle-name><last-name>Авторов</last-name></author><author><nickname>Соавтор</nickname></author><book-title>${title}</book-title><annotation><p>Первый абзац описания.</p><p>Второй абзац описания.</p></annotation><coverpage><image l:href="#cover"/></coverpage><lang>ru</lang></title-info><document-info><author><nickname>Тест</nickname></author><date>2026-11-02</date><id>synthetic-cc0</id><version>1.0</version></document-info></description><body><title><p>Первая часть</p></title><epigraph><p>Эпиграф.</p></epigraph><section id="start"><title><p>Начало</p></title><p id="paragraph">Первый абзац с <emphasis>курсивом</emphasis>.</p><poem><title><p>Стихотворение</p></title><stanza><v>Первая строка.</v><v>Вторая строка.</v></stanza><text-author>Автор стихов</text-author></poem><section id="nested"><title><p>Подраздел</p></title><p>Продолжение и примечание <a l:href="#note1" type="note">1</a>.</p><empty-line/><image l:href="#cover"/><p>Конец первой главы.${tail}</p></section></section><section><p>Вторая часть.</p><p>Последний абзац основной книги.</p></section></body><body name="notes"><title><p>Примечания</p></title><section id="note1"><title><p>Примечание 1</p></title><p>Текст примечания.</p><p><a l:href="#paragraph">Вернуться.</a></p></section></body><binary id="cover" content-type="image/png">${coverBase64}</binary></FictionBook>`;
  return {
    source,
    bytes: new TextEncoder().encode(source),
    expected: expectedFb2Parts,
  };
}
