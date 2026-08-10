export default {
  server: { host: '127.0.0.1' },
  build: { target: 'esnext' },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
};
