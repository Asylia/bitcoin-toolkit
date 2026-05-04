import { defineConfig } from 'tsup';

const productionLikeBuild =
  process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
const unsafeDiagnostics =
  !productionLikeBuild &&
  (process.env.ASYLIA_HW_TREZOR_UNSAFE_DIAGNOSTICS === '1' ||
    process.env.ASYLIA_HW_TREZOR_UNSAFE_DIAGNOSTICS === 'true');

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  tsconfig: 'tsconfig.build.json',
  define: {
    __ASYLIA_HW_TREZOR_UNSAFE_DIAGNOSTICS__: JSON.stringify(unsafeDiagnostics),
  },
  esbuildOptions(options) {
    options.minifySyntax = true;
  },
});
