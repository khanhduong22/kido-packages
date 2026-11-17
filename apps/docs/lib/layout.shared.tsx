import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig, authorUrl } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: appName,
    },
    links: [
      {
        text: 'Documentation',
        url: '/docs',
        active: 'nested-url',
      },
      {
        text: 'Blueprints',
        url: '/docs/blueprints/01-youtube-view-counter',
      },
      {
        text: 'Systems Suites',
        url: '/docs/packages/02-concurrency-and-caching',
      },
      {
        text: 'Author (khanhdp.com)',
        url: authorUrl,
        external: true,
      },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
