import { fetchRuntimeReleases } from '../../dist/src/runtime-registry.js';
import { selectRuntimeRelease } from '../../dist/src/runtime-resolution.js';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const root = fileURLToPath(new URL('./', import.meta.url));
const selectedAt = new Date().toISOString();
const roots = [];
for (const name of ['harbor', 'smolmachines']) {
  const selection = selectRuntimeRelease(await fetchRuntimeReleases({ source: 'pypi', name }), { now: selectedAt });
  roots.push({ name, version: selection.release.version, publishedAt: selection.release.publishedAt,
    selectedAt: selection.selectedAt, cutoff: selection.cutoff, policy: selection.policy });
}
await writeFile(join(root, 'requirements.in'), roots.map(r => `${r.name}==${r.version}`).join('\n') + '\n');
execFileSync(process.env.EBO_CI_UV ?? 'uv', [
  'pip', 'compile', join(root, 'requirements.in'), '--output-file', join(root, 'requirements.lock.txt'),
  '--python-version', '3.14', '--python-platform', 'x86_64-unknown-linux-gnu',
  '--no-config', '--no-cache', '--no-python-downloads', '--only-binary', ':all:', '--generate-hashes',
  '--exclude-newer', roots[0].cutoff, '--prerelease', 'disallow',
  '--index-url', 'https://pypi.org/simple', '--no-header', '--no-annotate',
], { stdio: 'inherit' });
const requirementsSha256 = createHash('sha256').update(await readFile(join(root, 'requirements.lock.txt'))).digest('hex');
await writeFile(join(root, 'selection.json'), JSON.stringify({
  schemaVersion: 'ebo.ci-runtime-selection/v1',
  purpose: 'Frozen Linux conformance snapshot; uses the study resolver release-selection policy, not a harness allowlist.',
  target: 'linux-x64 / Python 3.14', requirementsSha256, roots,
}, null, 2) + '\n');
console.log(JSON.stringify({ roots, requirementsSha256 }));
