import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
  target: 'node20',
  platform: 'node',
  // GramJS and the AWS SDK are heavy; keep them external (peer at runtime).
  external: ['telegram', '@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'],
});
