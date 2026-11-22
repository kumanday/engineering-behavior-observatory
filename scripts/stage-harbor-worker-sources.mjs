// Copies the npm inputs of the Harbor guest worker into dist/harbor-worker/ during `npm run build`, so a packaged
// install carries them: npm never packs the root package-lock.json, and the worker installs EBO's dependencies from it.
import {cpSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'dist/harbor-worker');
mkdirSync(resolve(target, 'viewer'), {recursive: true});
for (const path of ['package.json', 'package-lock.json', 'viewer/package.json']) cpSync(resolve(root, path), resolve(target, path));
