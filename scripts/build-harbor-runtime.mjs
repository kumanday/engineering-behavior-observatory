import {spawnSync} from 'node:child_process';
import {mkdirSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {readStudyRuntimeLock} from '../dist/src/study-runtimes.js';

const flag = name => {const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1];};
const destination = resolve(process.argv[2] ?? '.ebo/harbor-runtime');
const study = flag('--study'), nodeImage = flag('--node-image');
if (!study || !nodeImage || !/^[^\s]+@sha256:[a-f0-9]{64}$/.test(nodeImage)) throw new Error('Use <output> --study <frozen-study> --node-image <immutable Linux ARM64 Node image digest>.');
if (process.argv.includes('--factory')) throw new Error('Select Factory in the study runtime request; the worker pack uses its frozen CLI and SDK.');
if (!existsSync('dist/src/harbor/worker.js')) throw new Error('Run npm run build first.');
const studyRoot = resolve(study), lock = await readStudyRuntimeLock(studyRoot);
for (const group of lock.groups) if (!existsSync(resolve(studyRoot, 'runtimes/cache', group.installation.key, '.ebo-runtime-receipt.json'))) throw new Error(`Missing frozen installation: ${group.id}`);
const nodeVersion = JSON.parse(readFileSync('package.json', 'utf8')).engines.node;
mkdirSync(destination, {recursive: true});
// Install EBO's coordinating code from its own dependency lock. Capture loads the
// study's separate runtimes, which are copied byte-for-byte into the archive.
const result = spawnSync('docker', ['run', '--rm', '--platform', 'linux/arm64',
  '--mount', `type=bind,source=${process.cwd()},target=/source,readonly`,
  '--mount', `type=bind,source=${studyRoot},target=/study,readonly`,
  '--mount', `type=bind,source=${destination},target=/output`,
  nodeImage, 'sh', '-ec', `
    test "$(node --version)" = "v${nodeVersion}"
    test "$(node -p 'process.platform + ":" + process.arch')" = "linux:arm64"
    mkdir /runtime
    cp /source/package.json /source/package-lock.json /runtime/
    cd /runtime
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund
    cp /usr/local/bin/node ./node
    cp -R /source/dist ./dist
    cp -R /source/schemas ./schemas
    cp -R /source/contracts ./contracts
    rm -rf ./dist/test
    ${process.argv.includes('--fixtures') ? 'mkdir -p dist/test; cp /source/dist/test/harbor-provider-worker.js dist/test/' : ''}
    mkdir -p study/runtimes
    cp /study/runtimes/lock.json study/runtimes/
    cp -R /study/runtimes/cache study/runtimes/
    node --version > /output/node-version.txt
    tar czf /output/worker.tgz .
  `], {stdio: 'inherit'});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (readFileSync(resolve(destination, 'node-version.txt'), 'utf8').trim() !== `v${nodeVersion}`) throw new Error('Worker Node probe disagrees with EBO coordinating runtime.');
const retained = spawnSync('tar', ['-xOf', resolve(destination, 'worker.tgz'), './study/runtimes/lock.json'], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
if (retained.status !== 0 || JSON.parse(retained.stdout).digest !== lock.digest) throw new Error('Worker archive does not retain the selected study lock.');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const archiveDigest = digest(readFileSync(resolve(destination, 'worker.tgz')));
const build = {schemaVersion: 'ebo.harbor-worker-build/v2', studyLockDigest: lock.digest, platform: 'linux/arm64', nodeImage, nodeVersion, runtimeArchiveDigest: archiveDigest};
writeFileSync(resolve(destination, 'worker-build.json'), JSON.stringify(build, null, 2));
writeFileSync(resolve(destination, 'worker.json'), JSON.stringify({schemaVersion: 'ebo.harbor-worker-runtime/v2', studyLockDigest: lock.digest,
  archive: {locator: 'worker.tgz', digest: {algorithm: 'sha256', value: archiveDigest}}, node: 'node', entrypoint: 'dist/src/harbor/worker.js', environmentKeys: []}, null, 2));
const base = flag('--base'), image = flag('--image');
if (base || image) {
  if (!base || !image || !/^\S+@sha256:[a-f0-9]{64}$/.test(base)) throw new Error('Use --base <platform-specific registry digest> --image <local output tag>.');
  const pulled = spawnSync('docker', ['pull', '--platform', 'linux/arm64', base], {stdio: 'inherit'});
  if (pulled.status !== 0) throw new Error('Cannot pull base image');
  const inspected = spawnSync('docker', ['image', 'inspect', base], {encoding: 'utf8'});
  if (inspected.status !== 0) throw new Error('Cannot inspect base image');
  const config = JSON.parse(inspected.stdout)[0].Config, user = config.User || 'root';
  if (/[\r\n]/.test(user)) throw new Error('Invalid base image USER');
  const recipe = `FROM ${base}\nUSER root\nRUN git --version\nCOPY worker.tgz /tmp/ebo-runtime.tgz\nRUN mkdir -p /opt/ebo && tar -xzf /tmp/ebo-runtime.tgz -C /opt/ebo && rm /tmp/ebo-runtime.tgz && echo ${archiveDigest} > /opt/ebo/runtime.sha256\nUSER ${user}\n`;
  const built = spawnSync('docker', ['build', '--platform', 'linux/arm64', '-t', image, '-f', '-', destination], {input: recipe, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit']});
  if (built.status !== 0) throw new Error('Execution image build failed');
  writeFileSync(resolve(destination, 'image-build.json'), JSON.stringify({...build, image, baseImage: base, baseImageDigest: base.split('@sha256:')[1], recipeDigest: digest(recipe),
    startup: {user, command: config.Cmd, entrypoint: config.Entrypoint, workdir: config.WorkingDir}}, null, 2));
  console.log('Built locally. Publish explicitly to a registry accessible to Smol, then bind its platform-specific digest in the environment manifest.');
}
