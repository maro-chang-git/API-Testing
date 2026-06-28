import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5500,
    proxy: {
      '/proxy': 'http://localhost:5501',
      '/save':  'http://localhost:5501',
    },
  },
})
