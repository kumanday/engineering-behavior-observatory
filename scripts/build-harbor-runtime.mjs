import {spawnSync} from 'node:child_process';
import {createReadStream, mkdirSync, existsSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {mkdtemp, rename, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {readStudyRuntimeLock} from '../dist/src/study-runtimes.js';
import {readOciDescriptorBinding} from '../dist/src/runtime-oci.js';
import {withStudyRuntime, lockedRuntimePython, lockedRuntimeVersion} from '../dist/src/runtime-context.js';
import {MAX_QUALIFICATION_ARTIFACT_BYTES} from '../dist/src/contracts.js';
import {MAX_HARBOR_RUNTIME_ARCHIVE_BYTES} from '../dist/src/harbor/official-trial.js';
import {installRuntime} from '../dist/src/runtime-installation.js';
import {fetchRuntimeReleases} from '../dist/src/runtime-registry.js';
import {selectRuntimeRelease} from '../dist/src/runtime-resolution.js';
import {checkRuntimeSecurity} from '../dist/src/runtime-security.js';

const BUILD_SCRIPT = String.raw`
import importlib.metadata,json,sys,uuid
from smol import Machine,MachineConfig,ConnectOptions,ResourceSpec,MountSpec,ExecOptions
request=json.loads(sys.argv[1])
if importlib.metadata.version('smolmachines') != request['engineVersion']: raise ValueError('RUNTIME_PROBE_MISMATCH: smolmachines')
machine=None
try:
    machine=Machine.create(MachineConfig(name='ebo-worker-build-'+uuid.uuid4().hex, image=request['image'], command=['sleep','infinity'],
        mounts=[MountSpec(source=m['source'],target=m['target'],read_only=m['readOnly']) for m in request['mounts']],
        resources=ResourceSpec(cpus=2,memory_mb=4096,storage_gb=16,network=True), persistent=False,detach=False),ConnectOptions(target='local'))
    image=machine.pull_image(request['image'])
    if image.reference != request['image'] or image.digest != request['configDigest'] or image.os != 'linux' or image.architecture != 'arm64': raise ValueError('RUNTIME_INTEGRITY_MISMATCH: Node build image')
    result=machine.exec(['sh','-eu','-c',request['command']],ExecOptions(timeout=900))
    if result.exit_code:
        sys.stderr.write(result.stderr[-8192:]);raise ValueError('Worker preparation failed: '+str(result.exit_code))
    boot=machine.exec(['cat','/proc/sys/kernel/random/boot_id'])
    if boot.exit_code: raise ValueError('Cannot read owned build VM identity')
    print('EBO_WORKER_BUILD '+json.dumps({'backend':'smolvm','target':'local','image':image.reference,'imageConfigDigest':image.digest,'machine':machine.name,'bootId':boot.stdout.strip(),'engineVersion':importlib.metadata.version('smolmachines')}),flush=True)
finally:
    if machine is not None:
        try: machine.stop(timeout_secs=5)
        finally: machine.delete()
`;
async function prepareNpm(version, cacheRoot) {
  const {release, selectedAt, cutoff} = selectRuntimeRelease(
    (await fetchRuntimeReleases({source: 'npm', name: 'npm'})).filter(release => release.version === version),
    {now: new Date().toISOString()},
  );
  const security = await checkRuntimeSecurity([{id: 'worker-build-npm', name: 'npm', version, ecosystem: 'npm'}]);
  for (const warning of security.warnings) process.stderr.write(`${warning}\n`);
  const packageJson = {name: 'ebo-worker-build-toolchain', version: '0.0.0', private: true, dependencies: {npm: version}};
  const packageLock = {name: packageJson.name, version: packageJson.version, lockfileVersion: 3, requires: true, packages: {
    '': {name: packageJson.name, version: packageJson.version, dependencies: packageJson.dependencies},
    'node_modules/npm': {version, resolved: release.locator, integrity: release.integrity},
  }};
  const installed = await installRuntime({kind: 'npm', recipe: 'ebo-npm/v1', platform: 'linux-arm64', abi: 'glibc', packageJson,
    packageLock, verifyRegistryProofs: Boolean(release.proofs?.length)}, {cacheRoot});
  return {directory: resolve(installed.root, 'node_modules/npm'), receipt: {selectedAt, cutoff, locator: release.locator,
    integrity: release.integrity, publishedAt: release.publishedAt, proofs: installed.receipt.proofs, security}};
}

/** The optional provider is a trusted test boundary; CLI preparation always owns a local Smol VM. */
export async function buildHarborRuntime({destination, study, nodeImage, fixtures = false}, provider) {
  if (!study || !nodeImage || !/^[^\s]+@sha256:[a-f0-9]{64}$/.test(nodeImage)) throw new Error('Use <output> --study <frozen-study> --node-image <immutable Linux ARM64 Node image digest>.');
  if (!existsSync('dist/src/harbor/worker.js')) throw new Error('Run npm run build first.');
  destination = resolve(destination);
  mkdirSync(dirname(destination), {recursive: true});
  const staging = await mkdtemp(resolve(dirname(destination), '.ebo-worker-build-'));
  try {
    const build = await buildWorker({destination: staging, studyRoot: resolve(study), nodeImage, fixtures}, provider);
    try {await rename(staging, destination);}
    catch (error) {
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw new Error('Worker output already exists; choose an empty destination.');
      throw error;
    }
    return build;
  } finally {await rm(staging, {recursive: true, force: true});}
}

async function buildWorker({destination, studyRoot, nodeImage, fixtures}, provider) {
  const lockPath = resolve(studyRoot, 'runtimes/lock.json');
  const selectedLock = readFileSync(lockPath);
  const lock = await readStudyRuntimeLock(studyRoot);
  if (!selectedLock.equals(readFileSync(lockPath))) throw new Error('Study runtime lock changed during selection.');
  for (const group of lock.groups) if (!existsSync(resolve(studyRoot, 'runtimes/cache', group.installation.key, '.ebo-runtime-receipt.json'))) throw new Error(`Missing frozen installation: ${group.id}`);
  const guestKeys = lock.groups.filter(group => group.plan.platform === 'linux-arm64').map(group => group.installation.key);
  if (!guestKeys.length || guestKeys.some(key => !/^[a-f0-9]{64}$/u.test(key))) throw new Error('The study lock must contain Linux ARM64 installations.');
  const smolKey = lock.groups.find(group => group.roles.includes('smol'))?.installation.key;
  if (smolKey && !/^[a-f0-9]{64}$/u.test(smolKey)) throw new Error('The host Smol receipt must have a frozen cache identity.');
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  const nodeVersion = packageJson.engines.node;
  const npmVersion = /^npm@(\d+\.\d+\.\d+)$/u.exec(packageJson.packageManager)?.[1];
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) throw new Error('The coordinating Node version must be exact.');
  if (!npmVersion) throw new Error('The coordinating npm version must be exact.');
  mkdirSync(destination, {recursive: true});
  const imageBinding = provider ? undefined : await readOciDescriptorBinding(nodeImage, "linux-arm64");
  const request = {image: nodeImage, configDigest: imageBinding?.configDigest, mounts: [{source: process.cwd(), target: '/source', readOnly: true}, {source: studyRoot, target: '/study', readOnly: true}, {source: destination, target: '/output', readOnly: false}], command: `
    test "$(node --version)" = "v${nodeVersion}"
    test "$(node -p 'process.platform + ":" + process.arch')" = "linux:arm64"
    mkdir /runtime
    cp /source/package.json /source/package-lock.json /runtime/
    mkdir /runtime/viewer
    cp /source/viewer/package.json /runtime/viewer/
    cd /runtime
    test "$(node /toolchain/bin/npm-cli.js --version)" = "${npmVersion}"
    touch .ebo-npm-user.rc .ebo-npm-global.rc
    node /toolchain/bin/npm-cli.js ci --omit=dev --ignore-scripts --no-audit --no-fund --userconfig=/runtime/.ebo-npm-user.rc --globalconfig=/runtime/.ebo-npm-global.rc --registry=https://registry.npmjs.org
    rm .ebo-npm-user.rc .ebo-npm-global.rc
    cp /usr/local/bin/node ./node
    for path in dist schemas contracts compatibility ontology verification; do cp -R /source/$path ./$path; done
    rm -rf ./dist/test
    ${fixtures ? 'mkdir -p dist/test; cp /source/dist/test/harbor-provider-worker.js dist/test/' : ''}
    mkdir -p study/runtimes/cache
    cp /study/runtimes/lock.json study/runtimes/
    ${guestKeys.map(key => `cp -R /study/runtimes/cache/${key} study/runtimes/cache/`).join('\n    ')}
    ${smolKey && !guestKeys.includes(smolKey) ? `mkdir study/runtimes/cache/${smolKey}; cp /study/runtimes/cache/${smolKey}/.ebo-runtime-receipt.json study/runtimes/cache/${smolKey}/` : ''}
    node --version > /output/node-version.txt
    node /toolchain/bin/npm-cli.js --version > /output/npm-version.txt
    tar czf /output/worker.tgz .
  `};
  let execution, npmArtifact;
  if (provider) execution = await provider(request);
  else {
    const toolchainRoot = await mkdtemp(resolve(tmpdir(), 'ebo-worker-toolchain-'));
    try {
      const toolchain = await prepareNpm(npmVersion, toolchainRoot);
      request.mounts.push({source: toolchain.directory, target: '/toolchain', readOnly: true});
      npmArtifact = toolchain.receipt;
      execution = await withStudyRuntime({studyRoot, role: 'smol'}, async () => {
        const engineVersion = lockedRuntimeVersion('smol');
        const result = spawnSync(lockedRuntimePython(), ['-I', '-B', '-c', BUILD_SCRIPT, JSON.stringify({...request, engineVersion})], {encoding: 'utf8', timeout: 1_200_000, maxBuffer: 1024 * 1024,
          env: {PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1'}});
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`Local Smol preparation failed: ${result.stderr.slice(-8192)}`);
        const line = result.stdout.split('\n').find(line => line.startsWith('EBO_WORKER_BUILD '));
        if (!line) throw new Error('Local Smol preparation returned no execution receipt.');
        return JSON.parse(line.slice('EBO_WORKER_BUILD '.length));
      });
    } finally {await rm(toolchainRoot, {recursive: true, force: true});}
  }
  if (execution.backend !== 'smolvm' || execution.target !== 'local' || execution.image !== nodeImage || imageBinding && execution.imageConfigDigest !== imageBinding.configDigest) throw new Error('Worker build did not use the frozen local Smol image.');
  if (readFileSync(resolve(destination, 'node-version.txt'), 'utf8').trim() !== `v${nodeVersion}`) throw new Error('Worker Node probe disagrees with EBO coordinating runtime.');
  const actualNpm = readFileSync(resolve(destination, 'npm-version.txt'), 'utf8').trim();
  if (actualNpm !== npmVersion) throw new Error('Worker npm probe disagrees with EBO coordinating runtime.');
  const archive = resolve(destination, 'worker.tgz');
  if (statSync(archive).size > MAX_HARBOR_RUNTIME_ARCHIVE_BYTES) throw new Error('Worker archive exceeds the Harbor runtime size limit.');
  const retained = spawnSync('tar', ['-xOf', archive, './study/runtimes/lock.json'], {maxBuffer: MAX_QUALIFICATION_ARTIFACT_BYTES});
  if (retained.status !== 0 || !retained.stdout.equals(selectedLock)) throw new Error('Worker archive does not retain the selected study lock.');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(archive)) hash.update(bytes);
  const archiveDigest = hash.digest('hex');
  const build = {schemaVersion: 'ebo.harbor-worker-build/v3', studyLockDigest: lock.digest, platform: 'linux/arm64', nodeImage, nodeVersion,
    npmVersion: actualNpm, ...(npmArtifact ? {npmArtifact} : {}), runtimeArchiveDigest: archiveDigest, execution};
  writeFileSync(resolve(destination, 'worker-build.json'), JSON.stringify(build, null, 2));
  writeFileSync(resolve(destination, 'worker.json'), JSON.stringify({schemaVersion: 'ebo.harbor-worker-runtime/v2', studyLockDigest: lock.digest,
    archive: {locator: 'worker.tgz', digest: {algorithm: 'sha256', value: archiveDigest}}, node: 'node', entrypoint: 'dist/src/harbor/worker.js', environmentKeys: []}, null, 2));
  return build;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = name => {const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1];};
  if (['--factory', '--base', '--image'].some(flag => process.argv.includes(flag))) throw new Error('Select harnesses in the study lock. Use a verified OCI image and localSetup for task preparation.');
  await buildHarborRuntime({destination: process.argv[2] ?? '.ebo/harbor-runtime', study: flag('--study'), nodeImage: flag('--node-image'), fixtures: process.argv.includes('--fixtures')});
}
