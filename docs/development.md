# Разработка

[Актуальная мобильная композиция и проверки](mobile-composition-2026-11-04.md).

Reedit v2: [композиция, цитаты и приёмка](redesign-v2-2026-11-04.md). Архитектурные границы, версии хранилища и текстового индекса сохранены.

## Проверки редизайна 04.11.2026

Новые рабочие пути добавления проверяет helper `tests/fixtures/library-actions.ts`: сначала «Добавить», затем загрузка/каталог/ручной ввод. Файловое поле называется «Файл книги», формат определяет адаптер. Сведения о spine/SHA раскрываются в диагностике. У карточки два разных действия: сведения и чтение; в тестах выбирать нужное, не общий regexp названия.

`redesign.spec.ts` проверяет 320/390/768/1024/1440, темы, увеличенный текст, продолжение, заметку, пустую коллекцию и уменьшенный visualViewport. Искусственное выделение создаётся в сфокусированном живом iframe; при reflow повторяется только получение selection/открытие редактора, не сохранение заметки. Native long press этим не подтверждается.

Для одновременных браузерных прогонов обязательны разные output: например `pnpm test:e2e --project chromium --project chromium-mobile --output test-results/ui` и `pnpm test:pwa --output test-results/pwa`. Иначе Playwright удалит временные trace-файлы другого прогона. Постоянный тестовый PWA-профиль использует короткий путь внутри outputDir, отдельно от любых пользовательских профилей.

Результаты и ограничения: [отчёт](redesign-2026-11-04.md), [снимки](screenshots/redesign-2026-11-04/README.md).

## Проверки дополнительного этапа 04B · 2 ноября 2026

- Typecheck, ESLint, Vitest (98 тестов, из них 24 FB2), production build и форматирование проходят. Зависимости не добавлены. Таблицы/индексы IndexedDB остаются v5; прежние EPUB/позиции не мигрируют и не переписываются.
- Unit: метаданные/обложка, все body/sections/стихи/примечания, изображения/ссылки, самостоятельный эквивалентный EPUB, точные исходные байты, повторяемый EPUB, UTF-16/Windows-1251, namespace/DTD/XXE/PI/XSS/неизвестные элементы/Base64/потерянные ресурсы, отмена, quota, повторное открытие БД, дубли, удаление файла и прикрепление с сохранением личных полей.
- Chromium desktop/mobile: FB2 выбирается системным input, сохраняется и открывается общей читалкой; изображение реально декодируется; ссылка ведёт к примечанию; reload восстанавливает место. Сверяются оригинал, разные SHA оригинала/EPUB, source SHA курсора и одинаковый полный DocumentTextIndex FB2/EPUB. Проверяются дубли, отсутствие внешних запросов и отсутствие записей опасного XML.
- Полный регрессионный прогон Chromium desktop/mobile: 63 E2E проходят, 1 touch-сценарий ожидаемо пропущен в desktop. Все прежние сценарии EPUB/библиотеки/позиций проходят; добавлены 4 успешных запуска FB2-сценариев.

Изменённые файлы 04B:

- Новые: `src/infrastructure/DocumentAdapter.ts`, `src/infrastructure/fb2/Fb2Adapter.ts`, `tests/fixtures/fb2.ts`, `tests/fb2.test.ts`, `tests/e2e/fb2.spec.ts`, `docs/fb2-import.md`.
- Domain/сохранение: `src/domain/{model,epub,rules}.ts`, `src/services/epub-import.ts`, `src/services/reader.ts`, `src/infrastructure/local-store.ts`.
- Интеграция: `src/main.tsx`, `src/infrastructure/epub/{reader,xml}.ts` (выбор неизменного представления/отдельная проверка SHA; optional XML-предел при прежнем EPUB-default), `src/features/library/{Library,BookView,EpubImportDialog}.tsx`, `src/features/shell/App.tsx`.
- Регрессия: `tests/e2e/library-files.spec.ts` обновлён под формат-нейтральное пустое состояние. Документы: README, architecture, data-model, decisions, development, epub-import, positions, roadmap.

Ручная приёмка: iPhone Safari → выбрать FB2 из Files/iCloud Drive, проверить большую книгу, кодировку, иллюстрации, стихи, таблицы, примечания/обратные ссылки, safe-area/VoiceOver, отмену и нехватку места. Перезапустить приложение и проверить позицию/оригинал, прикрепить к книге с отзывом и оценкой. Ограничения: только обычный FB2 до 16 МБ; PNG/JPEG/WebP; без FBZ/GIF/SVG/удалённых изображений; структурная проверка вместо полной XSD-валидации. WebKit Windows ранее отклонял нативную запись Blob без кода приложения, поэтому приёмка на физическом Safari остаётся отдельной. Подробности — fb2-import.md.

## Проверки этапа 06 · 2 ноября 2026

- Typecheck, ESLint, Vitest (74 теста), build и Prettier проходят. Новых зависимостей нет. Схема v5 добавляет производный кеш, не изменяя пользовательские записи.
- Unit/integration: русский/NFC/пунктуация/soft hyphen, inline, CDATA, порядок spine/пустые разделы, CFI↔Range↔ReadingCursor, прогресс/интервалы, отмена/длинное слово, алгоритм/издание, атомарный кеш, quota, раздельные Reading и удаление производных данных с сохранением CFI/cursor. Миграции из v3/v4 проверяют UUID/CFI/Blob.
- Property-based: seeded генератор, 80 случайных DOM для каждого Intl/fallback (160 случаев), roundtrip каждого слова, покрытие токенами, NFC и монотонный progress. Ошибки сообщают seed/case/word. Не устанавливался отдельный пакет ради генерации.
- Браузерные проверки используют реальный адаптер/IndexedDB: точное слово → CFI → selection → смена шрифта/полей/режима → сохранение → новый экземпляр → тот же курсор; отдельно старый HTML-CFI таблицы переносится в XHTML, CDATA остаётся текстом. Dev-only harness не входит в production.
- Контрольный Chromium desktop/mobile: 59 E2E проходят, 1 сценарий touch ожидаемо пропущен в desktop. Пройдены все прежние сценарии библиотеки/импорта/читалки и 6 новых запусков для точного курсора, старой таблицы и CDATA.
- После финального уточнения семантических блоков повторно прошли все 6 новых запусков desktop/mobile. Повторная изолированная проверка WebKit на пустой HTTP-странице без Reedit снова отклонила нативную запись Blob: `Error preparing Blob/File data to be stored in object store`. Safari-совместимость этим не подтверждается.
- Усиленный roundtrip выбирает слово далеко от начала главы и проверяет его реальные DOM rectangles в viewport после перехода, смены оформления и восстановления. Обнаруженное ограничение scrollTop при первой раскладке исправлено ожиданием fonts/images и повторным display того же CFI, с отменой/таймаутом и без сохранения промежуточных релокаций.

Файлы этапа 06:

- Новые: `src/domain/text-position.ts`, `src/services/{reading-progress,position-persistence}.ts`, `src/infrastructure/epub/{text-index,text-dom,PositionResolver}.ts`, `tests/text-position.test.ts`, `tests/fixtures/position-harness.ts`, `docs/positions.md`.
- Изменены: `src/domain/{model,reader,repositories,rules}.ts`, `src/services/reader.ts`, `src/infrastructure/{database,local-store}.ts`, `src/infrastructure/epub/{reader.ts,epubjs.d.ts,rendition-options.d.ts}`, `src/features/reader/ReaderScreen.tsx`, `tsconfig.json`.
- Проверки: `tests/{store,reader,epub-import}.test.ts`, `tests/e2e/reader.spec.ts`. Документы: README, architecture, data-model, decisions, design-system, development, reader, roadmap.

Ручная приёмка iPhone: большое разрешённое EPUB, слово у границы XHTML, таблица/CDATA/иллюстрация, смена шрифта/ориентации, закрытие/выгрузка/перезапуск, сверка слова и текстового прогресса. Проверить отзывчивость первой индексации, повторное открытие из кеша, выделение и нехватку места. Guided Reading/RSVP и статистика не добавлены.

Ограничения: правила внешнего CSS не участвуют в структурной фильтрации; fallback границы слов отличаются от Intl. Нативные XML/Intl/IndexedDB вызовы не прерываются посередине, индексация кооперативная с ограниченными окнами. Прежний CFI с несовпадающим читаемым текстом не переносится молча. WebKit Windows воспроизводит отказ нативной записи Blob даже на пустой странице; Safari на устройстве остаётся отдельной обязательной проверкой. Детали — positions.md.

## Проверки этапа 05 · 2 ноября 2026

- Typecheck, ESLint, Vitest (61 тест), production build и Prettier проходят. Новых зависимостей нет; движок чтения загружается отдельным ленивым chunk.
- Контрольный полный прогон Chromium desktop/mobile: 53 E2E проходят, 1 сенсорный сценарий пропущен в desktop без touch. Из них 15 успешных запусков проверяют читалку. Ошибок в контрольном прогоне нет.
- Reader unit/integration: правила жестов и настроек, защита от повторных команд, маршруты, очередь/ошибка/повтор записи, позиции разных файлов, сохранность настроек приложения и миграция v3→v4 с прежним UUID/CFI/Blob.
- E2E читалки в Chromium desktop/mobile: длинная книга целиком до конца, включая середину вне ToC; CFI после закрытия/reload; оформление, поля и поворот; прокрутка и все разделы; выделение; нативный touch-свайп; EPUB 2, курсив, иллюстрация, собственные стили текста и тёмная тема; sandbox/CSP; quota с повторением и подтверждением выхода; закрытие во время загрузки. Touch-сценарий намеренно пропускается в desktop-проекте без сенсорного ввода.
- Просмотрены скриншоты светлого чтения и тёмной темы на 320 px. Полный Chromium-прогон выполняется с `--workers 1`: при параллельном запуске был единичный сбой browser protocol `Page.reload: Not attached to an active page` в прежнем сценарии темы. Повторная проверка нужна в стабильной среде CI.
- Повторная проверка WebKit: браузер теперь запускается (прежняя блокировка DLL уже не препятствует запуску), но нативная запись Blob отклоняется до чтения книги. Изолированная проверка на пустой HTTP-странице без React/Dexie/Reedit воспроизводит abort: `Error preparing Blob/File data to be stored in object store`. Сценарий читалки останавливается на импорте; базовый тест Blob также не проходит. Это не подтверждение совместимости с Safari. Формат хранения оригинала ради обхода среды не менялся.

Изменённые файлы этапа 05:

- Domain: `src/domain/reader.ts`, `epub.ts`, `model.ts`, `repositories.ts`, `rules.ts`.
- Infrastructure: `src/infrastructure/database.ts`, `local-store.ts`, `epub/reader.ts`, `epub/EpubJsAdapter.ts`, `epub/epubjs.d.ts`, `epub/rendition-options.d.ts`.
- Services: `src/services/reader.ts`, `reader-navigation.ts`.
- UI: `src/features/reader/{ReaderScreen,ReaderSettings,ReaderContents}.tsx`, `reader.css`, `src/features/shell/{App.tsx,navigation.ts}`, `src/features/library/{BookView,Library}.tsx`, `src/main.tsx`.
- Tests: `tests/reader.test.ts`, `tests/store.test.ts`, `tests/e2e/reader.spec.ts`.
- Документы: `README.md`, `docs/{reader,architecture,data-model,decisions,design-system,development,epub-import,roadmap}.md`.

Ручная приёмка: импортировать длинный разрешённый EPUB, открыть выбранное прочтение, читать через несколько XHTML до конца, проверить оглавление и разделы вне ToC. Изменить оформление/режим, повернуть iPhone, закрыть/перезагрузить/открыть — сохранить то же место и настройки. Проверить выделение/двойное касание/свайп Safari от края, VoiceOver, safe-area и системные панели, большую иллюстрацию, reduced motion, нехватку места и выгрузку вкладки. Подробный контракт и ограничения — reader.md.

Ограничения: прогресс приблизительный; вертикальная прокрутка по одному XHTML с переходом между разделами; fixed-layout и линейный SVG-spine отклоняются явно. При закрытии во время операции освобождение движка ждёт её завершения и кадров браузера. WebKit в Windows сейчас отклоняет нативную запись Blob; физический iPhone остаётся обязательной проверкой. Отдельные будущие этапы (аннотации, статистика, Guided Reading, RSVP, Service Worker) не реализованы.

## Проверки этапа 04 · 2 ноября 2026

- Typecheck, ESLint, Vitest (55 тестов), production build и Prettier проходят. Адаптер вынесен в ленивый chunk, renderer не загружается.
- Chromium desktop/mobile: 38 сценариев, в том числе 8 запусков EPUB-сценариев. В настоящем IndexedDB проверены исходные байты, SHA-256 и полный упорядоченный текст после reload, повторный файл, прикрепление без изменения отзыва, DRM/скрипты и отмена. Превью импорта просмотрено визуально.
- Production dependency audit: известных уязвимостей не обнаружено; `pnpm why jszip` подтверждает одну версию JSZip 3.10.2 для приложения и epub.js. Версии закреплены lockfile; XML-зависимость epub.js обновлена совместимым override. Необязательные postinstall core-js/es5-ext явно запрещены.
- Синтетические CC0-файлы и ожидаемый текст — `tests/fixtures/epubs`; воспроизведение `pnpm fixtures:epub`. Генератор также проверяется strict TypeScript (allowImportingTsExtensions разрешён для прямого запуска тестовых TS-файлов Node с --experimental-strip-types).
- Повторная попытка EPUB-сценария в WebKit: браузер не запустился из-за прежней блокировки libwebpmux.dll. Chromium emulation не заменяет физический iPhone.

Основные новые файлы: `src/domain/epub.ts`, `src/services/epub-import.ts`, `src/infrastructure/epub/{EpubJsAdapter,zip,xml,characters,raster-cover}.ts` и декларации типов; `src/features/library/EpubImportDialog.tsx`; `tests/epub-adapter.test.ts`, `tests/epub-import.test.ts`, `tests/e2e/epub-import.spec.ts`, генератор/фикстуры. Обновлены модель/контракты, схема БД v3, LocalStore, точки интеграции main/App/Library/BookView, метаданные книги, package/lockfile/pnpm-workspace/tsconfig и документы архитектуры/модели/решений/roadmap/README.

Ручная приёмка: импортировать split-chapter.epub и parts-sparse-toc.epub из Files на iPhone, дождаться проверки всех ресурсов и подтвердить создание; перезагрузить. Повторить файл под другим именем — новая запись не создаётся. Прикрепить EPUB к книге с отзывом, убедиться, что история и метаданные сохранены. Проверить повреждённый, DRM и unsafe-script файлы, отмену анализа/подтверждения, нехватку места, VoiceOver и file picker iCloud Drive. Поддерживаемый поднабор, лимиты и правила текста описаны в epub-import.md. Читалка и внешний поиск не реализованы.

## Проверки этапа 03 · 2 ноября 2026

Изменённые и добавленные файлы этапа:

- Модель и контракты: `src/domain/model.ts`, `rules.ts`, `repositories.ts`, новый `library.ts`.
- Хранение и сценарии: `src/infrastructure/database.ts`, `local-store.ts`, новый `cover.ts`; новый `src/services/library.ts`.
- Модуль библиотеки: новые `src/features/library/Library.tsx`, `BookEditor.tsx`, `ReadingEditor.tsx`, `CollectionEditor.tsx`, `BookView.tsx`, `EditorDialog.tsx`, `library.css`; подключение в `src/features/shell/App.tsx`.
- Общие элементы: новые `src/ui/FormControls.tsx`, `useBlobUrl.ts`, `format.ts`; обновлён `src/ui/styles.css`.
- Проверки: новые `tests/library.test.ts`, `tests/e2e/library.spec.ts`, `tests/e2e/library-files.spec.ts`; обновлены `tests/store.test.ts`, `tests/e2e/foundation.spec.ts`.
- Документация: `README.md`, `docs/architecture.md`, `data-model.md`, `decisions.md`, `design-system.md`, `development.md`, `roadmap.md`.

- Typecheck, ESLint, build и форматирование проходят.
- Vitest: 27 тестов. Дополнены сценарии атомарного создания, метаданных/обложек, рейтинга и дат, повторных прочтений, дублей (в том числе конкурентных), поиска и коллекций, устаревших правок. Настоящая v1 проверяется на миграцию в v2 и откат при ошибке с безопасным повторным запуском.
- Chromium desktop/mobile: 30 браузерных проверок, включая создание книги с обложкой, оценку/отзыв/даты и коллекцию, перезагрузку, редактирование, повторное чтение, поиск/фильтры/список, дубли, подтверждения отказа от правок, удаление файла и коллекции. Изображение обложки проверено после reload. Скриншоты узкого списка и карточки просмотрены визуально.
- Повторная попытка сценария приёмки библиотеки в WebKit: браузер не запускается из-за прежней блокировки libwebpmux.dll. Нужна разрешённая среда; сенсорный Chromium не подтверждает совместимость Safari.
- Добавлены `tests/library.test.ts`, `tests/e2e/library.spec.ts`, `tests/e2e/library-files.spec.ts`; существующие регрессии сохранены и адаптированы к новой модели.

Ручная приёмка этапа: добавить книгу без EPUB, загрузить локальную обложку, заполнить прочтение с оценкой 4,5 и отзывом, создать коллекцию и включить книгу, перезагрузить. Проверить карточку, обложку и все значения. Создать второе прочтение и убедиться, что старый отзыв/оценка остались. Отменить, затем подтвердить удаление книги; проверить очистку её ссылок в коллекциях. Проверить VoiceOver, клавиатуру, date/file picker и длинные формы на физическом iPhone.

Ограничения этапа: растровые обложки JPG/PNG/WebP до 10 МБ и 6000×6000; HEIC и SVG не поддерживаются. Отзывы и оценки относятся к конкретному прочтению. Поиск, фильтры, сортировка и вид сбрасываются при выходе из раздела. Несохранённые формы не являются автосохраняемыми черновиками; закрытие через крестик/ESC требует подтверждения, но при принудительном закрытии браузера/навигации системой черновик может потеряться. Библиотека загружается целиком без пагинации; масштабирование на десятки тысяч книг пока не проверено. Импорт EPUB и каталоги отсутствуют намеренно.

## Проверки этапа 02 · 2 ноября 2026

- Typecheck, ESLint, production build и форматирование — успешно.
- Vitest: 16 тестов, включая сохранность существующей БД и сервис оформления.
- Playwright: 22 проверки проходят в Chromium desktop и Chromium с сенсорной эмуляцией iPhone. Включены навигация/история/фокус, обе темы, ошибка записи, диалоги, компоненты, 320 px и увеличенный текст. Светлая и тёмная темы просмотрены визуально.
- Повторная попытка WebKit mobile на сценарии навигации: браузер не запускается из-за прежней блокировки libwebpmux.dll политикой Windows. Остальные WebKit-сценарии требуют разрешённой среды; полный `pnpm test:e2e` здесь не будет зелёным.
- Схема v1 и данные этапа 01 не изменены; зависимости не добавлены.

Только доступные в этой среде браузерные проверки: `pnpm test:e2e --project chromium --project chromium-mobile`. Это не замена Safari.

## Проверки этапа 01 · 2 ноября 2026

- `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm format:check` — успешно.
- `pnpm test` — 12 unit-тестов успешно: правила, связи, сохранность Blob, повторное прикрепление, миграция, конкурирующие операции и откат.
- Chromium — 3 E2E-сценария успешно: начальный экран и перезагрузка, сохранность Blob в настоящем IndexedDB, отказ доступа и повторная проверка. Скриншот экрана проверен визуально.
- WebKit mobile — 3 сценария не запущены: Windows Application Control блокирует `libwebpmux.dll` из комплекта WebKit. Диагностика PrintDeps: «Политика управления приложениями заблокировала этот файл». Это препятствие среды, а не результат выполнения тестов приложения. Требуется повторный запуск в среде, разрешающей официальный WebKit Playwright, и ручная проверка физического iPhone.

Node.js 22.12+ (проверено на 24), pnpm 11.25.0 (зафиксирован в packageManager). Установка: `pnpm install --frozen-lockfile`. Запуск: `pnpm dev`. Разрешён только build script esbuild через pnpm-workspace.yaml.

Проверки перед изменением этапа:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm format:check
pnpm exec playwright install chromium webkit
pnpm test:e2e
```

Для форматирования — `pnpm format`. Playwright сам запускает Vite на 127.0.0.1:4173. Unit-тесты используют отдельные БД и удаляют только их после теста; приложение никогда не удаляет БД при запуске. Тестовые книги не попадают в production.

При добавлении миграции не менять номер/смысл v1 задним числом, не использовать deleteDatabase как восстановление. Проверять перенос всех существующих данных, в том числе Blob. Ошибка транзакции должна откатывать все изменения. Не обходить ошибки типизации.

## Ручная проверка

- Физический iPhone / Safari: portrait, landscape, увеличение текста, VoiceOver, safe-area, отсутствие горизонтальной прокрутки.
- Открыть Настройки, дождаться проверки, перезагрузить — хранилище доступно. Настройки не создаются до явного выбора темы; фиктивные книги не создаются.
- Переключить светлую/тёмную/автоматическую тему; перезагрузить, изменить системную тему. Пройти разделы, Back/Forward, открыть и закрыть информационные окна через touch и клавиатуру, проверить возврат фокуса.
- Проверить поле в диалоге с виртуальной клавиатурой iPhone через тестовую витрину `/tests/fixtures/components.html` в dev-сервере. В production тестовая витрина не собирается.
- Запретить хранилище: отображается ошибка и доступная с клавиатуры кнопка повторной проверки.
- Проверить открытие двух вкладок при будущем обновлении схемы; проверить нехватку места на реальном устройстве.

Текущие ограничения PWA, резервных копий и ручной приёмки перечислены в pwa.md и backup.md. До загрузки Settings при запуске тема следует системе, затем применяется сохранённый выбор. Очистка браузера уничтожает локальные данные. Сохранность в реальном Safari проверяется дополнительно к fake-indexeddb. Целевой минимум iOS Safari 16.4 (Tailwind v4); старые версии требуют отдельной оценки совместимости.

Этап 07: [annotations.md](annotations.md) описывает схему v6, поведение цитат/закладок, деградацию старых CFI и обязательную ручную проверку iPhone. Новые регрессии находятся в tests/epub-import.test.ts, tests/text-position.test.ts, tests/store.test.ts и tests/e2e/annotations.spec.ts. Запуск только новых браузерных сценариев: `pnpm test:e2e tests/e2e/annotations.spec.ts --project chromium --project chromium-mobile --workers 1`. Системные Selection handles, share sheet и экранная клавиатура требуют реального устройства.

Этап 08: [speed-reading.md](speed-reading.md). Планировщик тестируется внедряемыми часами (1000 deadlines с jitter), без ожидания реального времени. Unit/integration — tests/speed-reading.test.ts; E2E — `pnpm test:e2e tests/e2e/speed-reading.spec.ts --project chromium --project chromium-mobile --workers 1`. Настоящие блокировка/разблокировка iPhone и Safari остаются ручной приёмкой; синтетический hidden тестирует обработчики, не ОС.

Этап 09: [catalog-search.md](catalog-search.md). Локально запустите catalog server `pnpm start` (4174) и Vite `pnpm dev` (проксирует /api/catalog). Серверные переменные описаны в .env.example; Google требует ключ вне VITE_/bundle. Тесты HTTP proxy используют только loopback и фиктивный upstream, внешних API не вызывают; ограниченная среда должна разрешать соединения 127.0.0.1. Браузерные catalog.spec.ts проверяют выбор издания/обложки, EPUB без дубля, сохранность отзыва, отмену/офлайн и Google.

# Проверки этапа 10

`pnpm test` включает `tests/statistics.test.ts`: календарь, интервалы, реальная IndexedDB через fake-indexeddb, сбои/повторы транзакций, аренда и миграция V8. `pnpm test:e2e tests/e2e/statistics.spec.ts --project chromium --project chromium-mobile --workers 1` проверяет дневник, бумажные книги, цели и все режимы настоящей EPUB-читалки. Общие проверки остаются `typecheck`, `lint`, `test`, `build`, `format:check` и полный E2E-набор. Не изменяйте исходники во время E2E: HMR меняет документ под выполняющимся сценарием. Ручные проверки/ограничения перечислены в [statistics.md](statistics.md).

# Этап 11

`pnpm test:pwa` сначала собирает production, затем запускает playwright.pwa.config.ts с отдельным сервером tests/pwa на localhost:4185. Тестовый сервер моделирует два обновления и сломанный install, не входит в production и не используется для Railway. Проверяется закрытие/повторный запуск Chromium с сохранённым дисковым профилем без сети. Для обычных E2E по-прежнему используется Vite: Service Worker намеренно выключен в dev, чтобы не смешивать HMR и старые кэши. Не пересобирайте dist во время production E2E. `node --experimental-strip-types build/icons.ts` воспроизводит PNG-иконки из собственного знака.

Unit/regression: tests/backup.test.ts; миграция будущей схемы обновлена до v10 после текущей v9. Обязательны typecheck/lint/test/build/format:check, обычные E2E и отдельный production PWA набор. На физическом iPhone дополнительно проверяются установка, перезапуск устройства офлайн, «Файлы»/ZIP, обновление, блокировка и нехватка квоты. Выпуск не выполнялся. [pwa.md](pwa.md), [backup.md](backup.md).

## Этап 12

Production-сервер: `pnpm build`, затем `pnpm start`. PWA-набор использует тот же createWebHandler с настоящими MIME, CSP, кэшем и сжатием; тестовая обёртка меняет только варианты `/sw.js` и предоставляет управляющий маршрут `/__test/`, отсутствующий в production. Длинная CC0-фикстура генерируется в тесте, проверяет полный текст и прикладывает измерение готовности.

tests/web-server.test.ts проверяет маршруты, безопасность, MIME, сжатие и healthcheck; tests/blob-url.test.ts — совместное владение обложкой; tests/store.test.ts — v8 → v9; tests/epub-import.test.ts — summary без Blob и адресные запросы читалки. Сборка Docker требует Docker/Railway и отдельно от проверок Node не заявляется. [Развёртывание](deployment.md), [аудит и ограничения](release-audit.md).

Первая iPhone-приёмка: [iphone-hotfix.md](iphone-hotfix.md). Новые регрессии: operation-deadline.test.ts, mobile-layout.spec.ts, случаи пассивной кодировки/отсутствующего якоря в epub-adapter.test.ts, выбора встроенной обложки в epub-import.test.ts, Google-preview в catalog.spec.ts. Личные присланные файлы проверялись локально и в публичные фикстуры не включены.
