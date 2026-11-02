import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
    {
      name: 'precompress-console',
      apply: 'build',
      generateBundle: {
        order: 'post',
        handler(_, bundle) {
          // Compress once at build time, never on the gateway's request path.
          for (const output of Object.values(bundle)) {
            if (!/\.(?:js|css|html|svg|json)$/.test(output.fileName)) continue
            const source = Buffer.from(
              output.type === 'chunk' ? output.code : output.source
            )
            if (source.length < 1024) continue
            const compressed = gzipSync(source, { level: 9 })
            if (compressed.length >= source.length) continue
            this.emitFile({
              type: 'asset',
              fileName: `${output.fileName}.gz`,
              source: compressed,
            })
          }
        },
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target:
          process.env.TAPMODELS_API_PROXY ||
          process.env.KIN_API_PROXY ||
          'http://127.0.0.1:8787',
        ws: true,
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
