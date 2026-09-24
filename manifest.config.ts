import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

export default defineManifest({
  manifest_version: 3,
  name: 'Smart Bookmarks',
  version: pkg.version,
  description:
    'AI-powered bookmarks: auto-classify, semantic search, dead-link detection, smart recommendations.',
  action: {
    default_title: 'Smart Bookmarks',
    default_popup: 'src/popup.html',
    default_icon: {
      '16': 'public/icons/icon-16.png',
      '32': 'public/icons/icon-32.png',
      '48': 'public/icons/icon-48.png',
      '128': 'public/icons/icon-128.png',
    },
  },
  icons: {
    '16': 'public/icons/icon-16.png',
    '32': 'public/icons/icon-32.png',
    '48': 'public/icons/icon-48.png',
    '128': 'public/icons/icon-128.png',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
  options_page: 'src/options.html',
  permissions: [
    'bookmarks',
    'storage',
    'tabs',
    'alarms',
    'notifications',
    'contextMenus',
    'scripting',
  ],
  host_permissions: ['<all_urls>'],
  commands: {
    'save-bookmark': {
      suggested_key: { default: 'Ctrl+Shift+S', mac: 'Command+Shift+S' },
      description: 'Save current page to Smart Bookmarks',
    },
  },
});
