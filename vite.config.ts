import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import path from 'node:path';
import pkg from './package.json' with { type: 'json' };
import manifest from './manifest.config';

// 备注：popup / options / background / content 的入口由 crxjs 根据 manifest 自动发现，
// 这里只需要在 resolve.alias 中设置 '@' 指向 src 即可。
export default defineConfig({
  define: {
    // build 时把 package.json 的 version 注入到 __APP_VERSION__，UI 端读取显示
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  plugins: [react(), crx({ manifest })],
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
