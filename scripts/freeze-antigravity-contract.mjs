// Regenerate the maintained protocol pin from publisher releases and verified archives.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fetchRuntimeReleases } from '../dist/src/runtime-registry.js';
import { selectRuntimeRelease } from '../dist/src/runtime-resolution.js';
import { listRuntimeRecipes } from '../dist/src/runtime-catalog.js';
import { ANTIGRAVITY_CLI_VERSION, ANTIGRAVITY_CONTRACT_DIGEST, ANTIGRAVITY_ADAPTER_VERSION } from '../dist/src/antigravity.js';
const selectedAt = process.argv[2] ?? new Date().toISOString();
const platforms = {};
let selection;
for (const [platform, architecture, key] of [['darwin', 'arm64', 'darwinArm64'], ['linux', 'arm64', 'linuxArm64']]) {
  const request = listRuntimeRecipes({platform, architecture}).find(r => r.id === 'antigravity-cli').components[0];
  const releases = await fetchRuntimeReleases(request);
  const selected = selectRuntimeRelease(releases, {now: selectedAt});
  if (selected.release.version !== ANTIGRAVITY_CLI_VERSION) throw new Error(`Newest eligible release is ${selected.release.version}; update the adapter pin before freezing.`);
  selection ??= selected;
  const response = await fetch(selected.release.locator);
  if (!response.ok) throw new Error(`Archive HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (`sha256-${Buffer.from(sha256, 'hex').toString('base64')}` !== selected.release.integrity) throw new Error('Publisher archive digest mismatch');
  platforms[key] = {url: selected.release.locator, sha256, sha512: createHash('sha512').update(bytes).digest('hex')};
}
const directory = `contracts/antigravity-cli-${ANTIGRAVITY_CLI_VERSION}`;
await mkdir(directory, {recursive: true});
await writeFile(`${directory}/manifest.json`, JSON.stringify({schemaVersion: 'ebo.antigravity-contract/v1', runtimeVersion: ANTIGRAVITY_CLI_VERSION,
  adapterVersion: ANTIGRAVITY_ADAPTER_VERSION, contractDigest: ANTIGRAVITY_CONTRACT_DIGEST, selectedAt, publishedAt: selection.release.publishedAt,
  publisher: 'google-antigravity/antigravity-cli', release: `https://github.com/google-antigravity/antigravity-cli/releases/tag/${ANTIGRAVITY_CLI_VERSION}`,
  policy: selection.policy, cutoff: selection.cutoff, excluded: selection.excluded.filter(r => r.reason === 'release-too-new'),
  source: 'https://antigravity.google/docs/cli/headless/', events: ['init', 'step_update', 'result'], inputEvents: ['user'],
  authentication: 'oauth-personal', telemetry: 'No native OTLP receipt qualified', ...platforms}, null, 2) + '\n');
