import {spawnSync} from 'node:child_process';
import {mkdirSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readStudyRuntimeLock} from '../dist/src/study-runtimes.js';
import {readOciDescriptorBinding} from '../dist/src/runtime-oci.js';
import {withStudyRuntime, lockedRuntimePython, lockedRuntimeVersion} from '../dist/src/runtime-context.js';

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
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** The optional provider is a trusted test boundary; CLI preparation always owns a local Smol VM. */
export async function buildHarborRuntime({destination, study, nodeImage, fixtures = false}, provider) {
  if (!study || !nodeImage || !/^[^\s]+@sha256:[a-f0-9]{64}$/.test(nodeImage)) throw new Error('Use <output> --study <frozen-study> --node-image <immutable Linux ARM64 Node image digest>.');
  if (!existsSync('dist/src/harbor/worker.js')) throw new Error('Run npm run build first.');
  destination = resolve(destination); const studyRoot = resolve(study), lock = await readStudyRuntimeLock(studyRoot);
  for (const group of lock.groups) if (!existsSync(resolve(studyRoot, 'runtimes/cache', group.installation.key, '.ebo-runtime-receipt.json'))) throw new Error(`Missing frozen installation: ${group.id}`);
  const nodeVersion = JSON.parse(readFileSync('package.json', 'utf8')).engines.node;
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) throw new Error('The coordinating Node version must be exact.');
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
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund
    cp /usr/local/bin/node ./node
    for path in dist schemas contracts compatibility ontology verification; do cp -R /source/$path ./$path; done
    rm -rf ./dist/test
    ${fixtures ? 'mkdir -p dist/test; cp /source/dist/test/harbor-provider-worker.js dist/test/' : ''}
    mkdir -p study/runtimes
    cp /study/runtimes/lock.json study/runtimes/
    cp -R /study/runtimes/cache study/runtimes/
    node --version > /output/node-version.txt
    tar czf /output/worker.tgz .
  `};
  let execution;
  if (provider) execution = await provider(request);
  else execution = await withStudyRuntime({studyRoot, role: 'smol'}, async () => {
    const engineVersion = lockedRuntimeVersion('smol');
    const result = spawnSync(lockedRuntimePython(), ['-I', '-B', '-c', BUILD_SCRIPT, JSON.stringify({...request, engineVersion})], {encoding: 'utf8', timeout: 1_200_000, maxBuffer: 1024 * 1024,
      env: {PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1'}});
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Local Smol preparation failed: ${result.stderr.slice(-8192)}`);
    const line = result.stdout.split('\n').find(line => line.startsWith('EBO_WORKER_BUILD '));
    if (!line) throw new Error('Local Smol preparation returned no execution receipt.');
    return JSON.parse(line.slice('EBO_WORKER_BUILD '.length));
  });
  if (execution.backend !== 'smolvm' || execution.target !== 'local' || execution.image !== nodeImage || imageBinding && execution.imageConfigDigest !== imageBinding.configDigest) throw new Error('Worker build did not use the frozen local Smol image.');
  if (readFileSync(resolve(destination, 'node-version.txt'), 'utf8').trim() !== `v${nodeVersion}`) throw new Error('Worker Node probe disagrees with EBO coordinating runtime.');
  const retained = spawnSync('tar', ['-xOf', resolve(destination, 'worker.tgz'), './study/runtimes/lock.json'], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  if (retained.status !== 0 || JSON.parse(retained.stdout).digest !== lock.digest) throw new Error('Worker archive does not retain the selected study lock.');
  const archiveDigest = digest(readFileSync(resolve(destination, 'worker.tgz')));
  const build = {schemaVersion: 'ebo.harbor-worker-build/v3', studyLockDigest: lock.digest, platform: 'linux/arm64', nodeImage, nodeVersion, runtimeArchiveDigest: archiveDigest, execution};
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
