// Bundles src/city3d.mjs and Three.js into public/city3d.js (one file, global A2ZCity, no runtime CDN).
// npm install && npm run build:city
import { build } from 'esbuild';
await build({ entryPoints: ['src/city3d.mjs'], bundle: true, minify: true, format: 'iife', target: 'es2020', outfile: 'public/city3d.js', legalComments: 'eof', logLevel: 'info' });
