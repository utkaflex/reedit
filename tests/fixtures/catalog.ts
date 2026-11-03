/** Synthetic catalog responses, CC0. These are test fixtures, never seeded as user books. */
export const catalogWork = {
  key: '/works/OL100W',
  title: 'Преступление и наказание',
  author_name: ['Фёдор Достоевский'],
  first_publish_year: 1866,
  cover_i: 100,
};
export const catalogEdition = {
  key: '/books/OL101M',
  title: 'Преступление и наказание',
  isbn_13: ['9781234567897'],
  publishers: ['Тестовое издательство'],
  publish_date: '2020',
  languages: [{ key: '/languages/rus' }],
  covers: [101, 102],
};
export const catalogOtherEdition = {
  ...catalogEdition,
  key: '/books/OL102M',
  title: 'Crime and Punishment',
  isbn_13: ['9780140449136'],
  publish_date: '2003',
  publishers: ['Synthetic English publisher'],
  languages: [{ key: '/languages/eng' }],
};
export const googleVolume = {
  id: 'synthetic-volume',
  volumeInfo: {
    title: 'Crime and Punishment',
    authors: ['Fyodor Dostoevsky'],
    publisher: 'Synthetic Publisher',
    publishedDate: '2021',
    language: 'en',
    description: '<p>Example <b>description</b>.</p><script>unsafe()</script>',
    industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780140449136' }],
    imageLinks: { thumbnail: 'https://books.google.com/cover' },
  },
};
