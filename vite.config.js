import { defineConfig } from 'vite';

// `base: './'` makes every asset URL relative, so the built site works
// no matter which sub-folder it is served from. That matters on GitHub Pages,
// where the game lives at https://<user>.github.io/<repo-name>/ and not at "/".
export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 900, // three.js is a big library; silence the size warning
  },
});
