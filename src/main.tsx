import { HttpCatalogTransport } from './infrastructure/catalog/transport';
import {
  GoogleBooksProvider,
  OpenLibraryProvider,
} from './infrastructure/catalog/providers';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './features/shell/App';
import { createLocalStore } from './infrastructure/local-store';
import './ui/styles.css';
import { startPwa } from './services/pwa';
startPwa();
import type { EpubAdapter } from './domain/epub';
const epubAdapter: EpubAdapter = {
  async openReader(options) {
    const { DocumentAdapter } =
      await import('./infrastructure/DocumentAdapter');
    return new DocumentAdapter().openReader(options);
  },
  async analyze(file, signal, onProgress) {
    const { DocumentAdapter } =
      await import('./infrastructure/DocumentAdapter');
    return new DocumentAdapter().analyze(file, signal, onProgress);
  },
};

const root = document.getElementById('root');
if (!root) throw new Error('Корневой элемент отсутствует');
const store = createLocalStore();
const catalogTransport = new HttpCatalogTransport();
const catalogProviders = [
  new OpenLibraryProvider(catalogTransport),
  new GoogleBooksProvider(catalogTransport),
];
createRoot(root).render(
  <StrictMode>
    <App
      store={store}
      epubAdapter={epubAdapter}
      catalogProviders={catalogProviders}
    />
  </StrictMode>,
);
