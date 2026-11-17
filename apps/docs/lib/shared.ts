import { createGetUrl } from 'fumadocs-core/source';

export const appName = 'Kido Bag';
export const appDescription =
  'The nanoGPT + Shadcn for Distributed Systems — 8 Principal-Grade Systems Suites & 8 Architecture Blueprints in Python (FastAPI / asyncio) and TypeScript by Duong Phuc Khanh (khanhdp.com).';
export const appUrl = 'https://bag.khanhdp.com';
export const authorUrl = 'https://khanhdp.com';

export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

// GitHub repository configuration
export const gitConfig = {
  user: 'khanhduong22',
  repo: 'kido-packages',
  branch: 'main',
};

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];

  return { segments, url: getContentUrl(segments, page.locale) };
}

const getImageUrl = createGetUrl(docsImageRoute);

export function getPageImageUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'image.png'];

  return { segments, url: getImageUrl(segments, page.locale) };
}
