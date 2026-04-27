import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    vue(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/client'),
    },
  },
  server: {
    // 用 127.0.0.1 显式走 IPv4。Node 20+ 默认 DNS 解析 localhost 可能优先返回 ::1
    // (IPv6),但 Fastify 绑 0.0.0.0 只听 IPv4 → Vite 代理 ECONNREFUSED → 浏览器拿到
    // 空响应体 → fetch().json() 抛 "Unexpected end of JSON input"。
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/mock': 'http://127.0.0.1:3000',
      '/uploads': 'http://127.0.0.1:3000',
    },
  },
  build: {
    outDir: 'dist/client',
  },
});
