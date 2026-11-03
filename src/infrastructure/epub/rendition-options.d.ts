import 'epubjs/types/rendition';
declare module 'epubjs/types/rendition' {
  interface RenditionOptions {
    gap?: number;
    allowPopups?: boolean;
    method?: 'blobUrl' | 'srcdoc' | 'write';
  }
}
