// Isolated local QA only: never used by npm run build or release builds.
import { defineConfig, mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import normal from './vite.config';
export default mergeConfig(normal, defineConfig({plugins:[{
  name:'isolated-public-profile-fixture',enforce:'pre',
  resolveId(source,importer) {
    if(source==='../profiles/public' && importer?.endsWith('/packages/browser/src/engine/node.ts')) return fileURLToPath(new URL('./packages/browser/test/helpers/publicProfileFixture.ts',import.meta.url));
  },
}]}));
