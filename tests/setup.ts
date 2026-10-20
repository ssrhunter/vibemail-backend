try {
  process.loadEnvFile('.env');
} catch {
  // .env may not exist in CI, where real env vars are injected directly — that's fine.
}
