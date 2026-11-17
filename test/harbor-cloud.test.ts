import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { validateSmolProfile } from "../src/harbor/smol.js";
import { HARBOR_TRIAL_SCRIPT } from "../src/harbor/trial-script.js";
import { validateArtifact } from "../src/artifacts.js";

const cloud = { schemaVersion: "ebo.smol-environments/v2", target: "cloud", platform: "linux/amd64",
  cloud: { baseUrl: "https://api.smolmachines.com", tokenEnv: "SMOL_CLOUD_TOKEN" } };

test("Cloud profiles bind target/platform and keep control credentials out of workers", () => {
  validateSmolProfile(cloud, ["FIREWORKS_API_KEY"]);
  validateSmolProfile({ ...cloud, platform: "linux/arm64" });
  assert.throws(() => validateSmolProfile(cloud, ["SMOL_CLOUD_TOKEN"]), /control credentials/);
  for (const baseUrl of ["http://api.example", "https://secret@api.example", "https://api.example/path", "https://api.example?key=secret"]) {
    assert.throws(() => validateSmolProfile({ ...cloud, cloud: { ...cloud.cloud, baseUrl } }));
  }
  assert.throws(() => validateSmolProfile({ ...cloud, schemaVersion: "ebo.smol-environments/v1" }));
  assert.throws(() => validateSmolProfile({ ...cloud, platform: "linux/riscv64" }));
});

test("Harbor coordinator budget schema accepts omission and rejects invalid explicit deadlines", () => {
  // Inspect only errors under this field; required study fields are independent.
  for (const schema of ["ebo.experiment/v2", "ebo.run-queue/v2"]) {
    const errors = (budget: unknown) => validateArtifact("fixture", { schemaVersion: schema, coordinatorBudget: budget })
      .filter(error => error.field.startsWith("/coordinatorBudget"));
    assert.deepEqual(errors({}), []);
    assert.deepEqual(errors({ maxWallClockMs: 5000 }), []);
    assert.ok(errors({ maxWallClockMs: 0 }).length > 0);
    assert.ok(errors({ maxWallClockMs: null }).length > 0);
  }
});

test("worker builder writes a linux/amd64 build context and adopts only its own output", async () => {
  const { freezeStudyRuntimes } = await import("../src/study-runtimes.js");
  const { fakeSdkRuntimeOptions } = await import("./runtime-fixture-helper.js");
  const { buildHarborRuntime } = await import(new URL("../../scripts/build-harbor-runtime.mjs", import.meta.url).href);
  const root = mkdtempSync(join(tmpdir(), "ebo-cloud-builder-")), study = join(root, "study"), context = join(root, "context");
  try {
    const lock = await freezeStudyRuntimes(study, { studyId: "cloud-worker", roles: ["pi-sdk"], target: { platform: "linux", architecture: "x64" } }, fakeSdkRuntimeOptions("9.9.9"));
    const image = `docker.io/library/node@sha256:${"d".repeat(64)}`;
    const { engines, packageManager } = JSON.parse(readFileSync("package.json", "utf8"));
    const npmVersion = packageManager.slice("npm@".length);
    const toolchain = async (request: { toolchain: string; root: string }) => {
      assert.equal(request.toolchain, npmVersion);
      writeFileSync(join(request.root, "npm-cli.js"), "");
      return { directory: request.root, receipt: { locator: "authored-npm", integrity: "sha512-authored" } };
    };
    // A local Smol VM cannot run this platform, and an arm64 study has no installation for it.
    await assert.rejects(buildHarborRuntime({ destination: context, study, nodeImage: image, platform: "linux/amd64" }), /--context/);
    await assert.rejects(buildHarborRuntime({ destination: context, study, nodeImage: image, platform: "linux/arm64", context: true }, toolchain), /linux-arm64 installations/);
    const receipt = await buildHarborRuntime({ destination: context, study, nodeImage: image, platform: "linux/amd64", context: true }, toolchain);
    assert.equal(receipt.platform, "linux/amd64");
    assert.equal(receipt.baseImageDigest, "d".repeat(64));
    const dockerfile = readFileSync(join(context, "Dockerfile"), "utf8");
    assert.equal(receipt.recipeDigest, createHash("sha256").update(dockerfile).digest("hex"));
    assert.equal(dockerfile.split("\n").filter(line => line.startsWith("FROM ")).every(line => line.includes(image)), true);
    assert.match(readFileSync(join(context, "build-worker.sh"), "utf8"), /"linux:x64"/);
    assert.ok(existsSync(join(context, "source/dist/src/harbor/worker.js")));
    assert.ok(existsSync(join(context, "study/runtimes/cache", lock.groups[0]!.installation.key, ".ebo-runtime-receipt.json")));
    assert.deepEqual(JSON.parse(readFileSync(join(context, "study/runtimes/lock.json"), "utf8")), JSON.parse(readFileSync(join(study, "runtimes/lock.json"), "utf8")));
    // Stand in for the native builder: its worker stage leaves these files in /output.
    const output = join(root, "output"), stage = join(root, "stage");
    mkdirSync(output); mkdirSync(join(stage, "study"), { recursive: true });
    cpSync(join(study, "runtimes"), join(stage, "study/runtimes"), { recursive: true });
    assert.equal(spawnSync("tar", ["-czf", join(output, "worker.tgz"), "-C", stage, "."]).status, 0);
    writeFileSync(join(output, "node-version.txt"), `v${engines.node}`);
    writeFileSync(join(output, "npm-version.txt"), npmVersion);
    cpSync(join(context, "context.json"), join(output, "context.json"));
    const adopt = (platform: string, nodeImage = image) => buildHarborRuntime({ destination: join(root, `worker-${platform.replace("/", "-")}-${nodeImage.length}`), study, nodeImage, platform, adopt: output });
    await assert.rejects(adopt("linux/amd64", `docker.io/library/node@sha256:${"e".repeat(64)}`), /different study lock, platform or Node image/);
    const build = await adopt("linux/amd64");
    assert.equal(build.platform, "linux/amd64");
    assert.deepEqual(build.execution, { backend: "oci-build", target: "external", image, baseImageDigest: receipt.baseImageDigest, recipeDigest: receipt.recipeDigest, commandDigest: receipt.commandDigest });
    assert.equal(build.runtimeArchiveDigest, createHash("sha256").update(readFileSync(join(output, "worker.tgz"))).digest("hex"));
    writeFileSync(join(output, "npm-version.txt"), "0.0.0");
    await assert.rejects(buildHarborRuntime({ destination: join(root, "worker-stale"), study, nodeImage: image, platform: "linux/amd64", adopt: output }), /Worker npm probe disagrees/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const python = process.env.EBO_HARBOR_PYTHON;
test("Native Cloud jobs retain ambiguous submissions, recover offsets and cancel without replacement", { skip: !python }, () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-cloud-contract-"));
  writeFileSync(join(root, "ebo_runtime.py"), HARBOR_TRIAL_SCRIPT);
  const result = spawnSync(python!, ["-c", String.raw`
import asyncio, fcntl, json, os
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch
from smol.types import JobInfo, JobOutput, MachineUsageReport
import ebo_runtime as e

root = Path.cwd()
image = {'image': 'registry.example/image@sha256:'+'a'*64, 'recipeDigest': 'b'*64, 'baseImageDigest': 'c'*64}
manifest = {'schemaVersion': 'ebo.smol-environments/v2', 'target': 'cloud', 'platform': 'linux/amd64',
    'runtimeArchiveDigest': 'd'*64, 'tasks': {'frozen-task': {'agent': image}},
    'cloud': {'baseUrl': 'https://api.smolmachines.com', 'tokenEnv': 'CONTROL_TOKEN'}}
e.validate_environment_manifest(manifest)
frozen = {name: __import__('importlib.metadata').metadata.version(name) for name in ('smolmachines', 'harbor')}
assert e.runtime_provenance(manifest, frozen)['target'] == 'cloud'
try: e.runtime_provenance(manifest, {**frozen, 'harbor': '0.0.0'})
except ValueError as exc: assert 'RUNTIME_PROBE_MISMATCH' in str(exc)
else: raise AssertionError('A runtime other than the frozen study selection was accepted')
with patch.dict(os.environ, {'CONTROL_TOKEN': 'fixture-secret'}):
    conn = e.connection_options(manifest)
    assert conn.target == 'cloud' and conn.api_key == 'fixture-secret'
assert 'fixture-secret' not in json.dumps(manifest)

async def check():
    job = NS(id='owned-job')
    job.info = AsyncMock(return_value=NS(state='exited', exit_code=0))
    job.cancel = AsyncMock(return_value=NS(state='exited', exit_code=143))
    chunks = {'stdout': b'hello\xc3\xa9\n', 'stderr': b'diagnostic\n'}
    async def output(*, stream, offset, limit):
        data = chunks[stream][offset:offset+3]
        return JobOutput(stream=stream, offset=offset, text=data.decode('utf8', errors='replace'), data=data, next_offset=offset+len(data), eof=offset+len(data)>=len(chunks[stream]))
    job.output = AsyncMock(side_effect=output)
    machine = NS(name='owned-machine', info=AsyncMock(return_value={'id': 'owned-machine'}), start_job=AsyncMock(return_value=job), job=lambda id: job,
        exec=AsyncMock(return_value=NS(exit_code=0, stdout='same-boot', stderr='')),
        delete=AsyncMock(return_value=MachineUsageReport(machine_id='owned-machine', from_ts='start', to_ts='end', usage={}, cost={})))
    environment = NS(_require_machine=lambda: machine, ebo_manifest=manifest, ebo_owner=str(root),
        environment_id='agent', event=lambda *args, **kw: None, ebo_transfer_failed=False)
    native = root/'native'
    code = await e.run_cloud_worker(environment, 'native-worker', {}, '/workspace', '/var/tmp/evidence', native, None)
    assert code == 0 and environment.ebo_transfer_failed
    assert machine.start_job.call_args.kwargs['timeout'] is None
    control = root/'native-cloud-job'
    receipt_path = control/'smol-job.json'
    receipt = json.loads(receipt_path.read_text())
    assert receipt['jobId'] == 'owned-job' and receipt['state'] == 'exited'
    assert receipt['offsets']['stdout'] == len(chunks['stdout'])
    assert (control/'worker-stdout.log').read_bytes() == chunks['stdout']
    # Replaying after a crash truncates bytes beyond the receipt offset, then resumes.
    receipt['offsets']['stdout'] = 2
    (control/'worker-stdout.log').write_bytes(b'heCRASH-TAIL')
    await e.collect_job_output(job, receipt_path, receipt)
    assert (control/'worker-stdout.log').read_bytes() == chunks['stdout']
    try: await e.run_cloud_worker(environment, 'native-worker', {}, '/workspace', '/var/tmp/evidence', native, None)
    except ValueError: pass
    else: raise AssertionError('Duplicate attempt launched')
    assert machine.start_job.await_count == 1
    # Recovery cannot race an active Trial coordinator.
    controller_path = root/'controller.lock'
    receipt['controllerLock'] = str(controller_path)
    e.json_write(receipt_path, receipt)
    with controller_path.open('a+') as controller:
        fcntl.flock(controller, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try: await e.recover_cloud_job({'frozenPythonVersions': frozen, 'receipt': str(receipt_path)})
        except ValueError as exc: assert 'still active' in str(exc)
        else: raise AssertionError('Recovery raced the coordinator')
    receipt.pop('controllerLock')
    e.json_write(receipt_path, receipt)
    # Recovery uses the existing ID, official Harbor transfer and settled deletion usage.
    with patch.object(e.AsyncMachine, 'connect', new_callable=AsyncMock, return_value=machine), \
         patch.object(e.SmolEnvironment, 'download_dir', new_callable=AsyncMock) as download, \
         patch.dict(os.environ, {'CONTROL_TOKEN': 'fixture-secret'}):
        result = await e.recover_cloud_job({'frozenPythonVersions': frozen, 'receipt': str(receipt_path), 'delete': True})
        assert result['evidenceRetrieved']
        download.assert_awaited_once()
    machine.delete.assert_awaited_once_with(include_usage=True)
    assert json.loads(receipt_path.read_text())['usage']['machine_id'] == 'owned-machine'
    assert machine.start_job.await_count == 1
    # Deletion errors remain durable and do not mark billing settled.
    receipt = json.loads(receipt_path.read_text())
    for key in ('usage', 'deletedAt', 'cleanupAttempts', 'cleanupState'): receipt.pop(key, None)
    e.json_write(receipt_path, receipt)
    machine.delete.side_effect = RuntimeError('deletion rejected')
    with patch.object(e.AsyncMachine, 'connect', new_callable=AsyncMock, return_value=machine), \
         patch.object(e.SmolEnvironment, 'download_dir', new_callable=AsyncMock), \
         patch.object(e.asyncio, 'sleep', new_callable=AsyncMock), \
         patch.dict(os.environ, {'CONTROL_TOKEN': 'fixture-secret'}):
        try: await e.recover_cloud_job({'frozenPythonVersions': frozen, 'receipt': str(receipt_path), 'delete': True})
        except RuntimeError: pass
        else: raise AssertionError('Cleanup failure hidden')
    failed = json.loads(receipt_path.read_text())
    assert failed['cleanupState'] == 'cleanup-pending' and len(failed['cleanupAttempts']) == 3
    assert 'usage' not in failed and 'deletedAt' not in failed
    machine.delete.side_effect = None
    # A restarted/lost job still permits partial evidence retrieval with a continuity gap.
    machine.exec.return_value = NS(exit_code=0, stdout='new-boot', stderr='')
    job.info.return_value = NS(state='lost', exit_code=None)
    with patch.object(e.AsyncMachine, 'connect', new_callable=AsyncMock, return_value=machine), \
         patch.object(e.SmolEnvironment, 'download_dir', new_callable=AsyncMock), \
         patch.dict(os.environ, {'CONTROL_TOKEN': 'fixture-secret'}):
        lost = await e.recover_cloud_job({'frozenPythonVersions': frozen, 'receipt': str(receipt_path)})
    assert lost['state'] == 'lost' and lost['evidenceRetrieved']
    assert json.loads(receipt_path.read_text())['bootContinuity'] is False
    machine.exec.return_value = NS(exit_code=0, stdout='same-boot', stderr='')
    job.info.return_value = NS(state='exited', exit_code=0)
    # A transient read timeout must not strand an accepted live worker or replay its submission.
    from smol.errors import SmolError
    before = machine.start_job.await_count
    job.info.side_effect = [SmolError('TIMEOUT', 'status read timed out'),
        SmolError('CONNECTION', 'status connection reset'), NS(state='exited', exit_code=0)]
    with patch.object(e.asyncio, 'sleep', new_callable=AsyncMock) as backoff:
        assert await e.run_cloud_worker(environment, 'native-worker', {}, '/workspace', '/var/tmp/evidence', root/'read-retry', None) == 0
        assert [c.args[0] for c in backoff.await_args_list] == [2, 4]
    assert machine.start_job.await_count == before + 1
    job.cancel.assert_not_called()
    retry_receipt = json.loads((root/'read-retry-cloud-job'/'smol-job.json').read_text())
    assert retry_receipt['jobId'] == 'owned-job' and len(retry_receipt['readFailures']) == 2
    assert retry_receipt['lastReadRecovery']['operation'] == 'status'
    # Retrying output at the same durable offset writes each byte once.
    calls = 0
    async def interrupted_output(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 1: raise SmolError('TIMEOUT', 'output read timed out')
        return await output(**kwargs)
    job.info.side_effect = None
    job.output.side_effect = interrupted_output
    with patch.object(e.asyncio, 'sleep', new_callable=AsyncMock):
        assert await e.run_cloud_worker(environment, 'native-worker', {}, '/workspace', '/var/tmp/evidence', root/'output-retry', None) == 0
    assert (root/'output-retry-cloud-job'/'worker-stdout.log').read_bytes() == chunks['stdout']
    job.output.side_effect = output
    # Authentication failures are not retried as transient reads.
    job.info.side_effect = SmolError('UNAUTHORIZED', 'expired credential', status=401)
    with patch.object(e.asyncio, 'sleep', new_callable=AsyncMock) as backoff:
        try: await e.run_cloud_worker(environment, 'native-worker', {}, '/workspace', '/var/tmp/evidence', root/'auth-failure', None)
        except SmolError: pass
        else: raise AssertionError('Authentication failure hidden')
        backoff.assert_not_awaited()
    job.cancel.assert_not_called()
    job.info.side_effect = None
    # Unknown submission state leaves intent and the VM, never a replacement.
    machine.start_job.side_effect = ConnectionError('response lost after submit')
    unknown = root/'ambiguous'
    try: await e.run_cloud_worker(environment, 'native-worker', {}, '/workspace', '/var/tmp/evidence', unknown, None)
    except ConnectionError: pass
    else: raise AssertionError('Expected ambiguous submission')
    intent = json.loads((root/'ambiguous-cloud-job'/'smol-job.json').read_text())
    assert intent['state'] == 'submitting' and 'jobId' not in intent
    assert environment.ebo_transfer_failed
    # Transport loss after a known job ID retains the remote job, including partial output.
    machine.start_job.side_effect = None
    job.info.side_effect = ConnectionError('disconnected')
    try: await e.run_cloud_worker(environment, 'native-worker', {}, '/workspace', '/var/tmp/evidence', root/'disconnect', None)
    except ConnectionError: pass
    job.cancel.assert_not_called()
    assert json.loads((root/'disconnect-cloud-job'/'smol-job.json').read_text())['jobId'] == 'owned-job'
    # Explicit cancellation stops this job and records its exit, with no relaunch.
    job.info.side_effect = asyncio.CancelledError()
    try: await e.run_cloud_worker(environment, 'native-worker', {}, '/workspace', '/var/tmp/evidence', root/'cancel', e.time.monotonic()+10)
    except asyncio.CancelledError: pass
    job.cancel.assert_awaited_once()
    assert 1 <= machine.start_job.call_args.kwargs['timeout'] <= 10
    assert json.loads((root/'cancel-cloud-job'/'smol-job.json').read_text())['exitCode'] == 143
    # Exercise the actual BaseAgent Cloud route with an omitted deadline.
    job.info.side_effect = None
    runner = object.__new__(e.EboAgent)
    runner.index, runner.deadline = 0, None
    runner.request = {'workerInput': {'maxWallClockMs': 99, 'prepared': {'steps': [{'index': 1}], 'task': {}, 'evidence': {}}},
        'runtime': {'node': 'node', 'entrypoint': 'worker.js', 'environmentKeys': []}, 'nativeRoot': str(root/'agent-steps')}
    policy = root/'capture.json'; policy.write_text(json.dumps({'workspaceOutcome': {'excludeDirectoryNames': ['.pnpm-store']}}))
    ref = {'locator': 'capture.json', 'digest': {'algorithm': 'sha256', 'value': e.hashlib.sha256(policy.read_bytes()).hexdigest()}}
    runner.request['workerInput']['configuration'] = {'captureProfile': ref}
    runner.request['configurationFiles'] = [{'locator': 'capture.json', 'hostPath': str(policy)}]
    # A Cloud guest has no local libkrun; its owned-task identity keeps that field explicitly absent.
    runner.request['environmentManifest'] = manifest
    environment.ebo_image_identity = {'reference': image['image'], 'configDigest': 'sha256:'+'f'*64}
    environment.ebo_child_id = 'mach-owned'
    environment._machine = machine
    async def upload(source, target):
        payload = json.loads(Path(source).read_text())
        assert 'maxWallClockMs' not in payload
        assert payload['prepared']['steps'][0]['index'] == 1
        owned = payload['ownedSmolEnvironment']
        assert owned['machine'] == 'mach-owned' and owned['bootId'] == 'same-boot' and owned['libkrunSha256'] is None
    async def download(source, target):
        (target/'worker-finished.json').write_text(json.dumps({'terminal': {'state': 'completed'}, 'bundleLocator': 'native/manifest.json'}))
    environment.exec = AsyncMock(return_value=NS(return_code=0, stdout='/workspace', stderr=''))
    environment.upload_file = AsyncMock(side_effect=upload)
    environment.download_dir = AsyncMock(side_effect=download)
    await runner.run('frozen instruction', environment, NS())
    assert not environment.ebo_transfer_failed
    assert environment.ebo_baseline_excludes == ['.pnpm-store']
    assert (root/'agent-steps'/'1-cloud-job'/'baseline-transfer-policy.json').exists()
    assert not (root/'agent-steps'/'1'/'baseline-transfer-policy.json').exists()
    assert machine.start_job.call_args.kwargs['timeout'] is None
    assert (root/'agent-steps'/'1-cloud-job'/'smol-job.json').exists()
    # Python trial cancellation is opt-in, preserving an omitted deadline.
    trial = NS(run=AsyncMock(return_value=NS(model_dump=lambda **kw: {'complete': True})),
        result=NS(model_dump=lambda **kw: {'partial': True}))
    assert (await e.execute_trial(trial, {}))['complete']
    async def wait_forever(): await asyncio.Event().wait()
    trial.run = wait_forever
    assert (await e.execute_trial(trial, {'budgetMs': 1}))['partial']
    # An ambiguous parent allocation retains the pre-submission machine name.
    owner = root/'owner-ambiguous'
    request = {'ownerRoot': str(owner), 'queueDigest': 'queue', 'environmentManifest': manifest, 'frozenPythonVersions': frozen,
        'build': 'test', 'tasks': [{'id': 'frozen-task', 'path': '/unused', 'verified': False}]}
    parent_env = NS(task_env_config=NS(docker_image=image['image'], workdir='/workspace'), _resource_spec=lambda: None)
    async def environments(trial, binding): yield parent_env, image
    with patch.object(e, 'derive_task', return_value={}), \
         patch.object(e, 'create_trial', new_callable=AsyncMock), \
         patch.object(e, 'preparation_environments', environments), \
         patch.object(e, 'env_identity', return_value={'role': 'agent'}), \
         patch.object(e.AsyncMachine, 'create', new_callable=AsyncMock, side_effect=ConnectionError('lost allocation response')), \
         patch.dict(os.environ, {'CONTROL_TOKEN': 'fixture-secret'}):
        try: await e.serve_parents(request)
        except ConnectionError: pass
        else: raise AssertionError('Allocation failure hidden')
    parent_receipt = json.loads((owner/'receipt.json').read_text())
    assert parent_receipt['state'] == 'cleanup-pending'
    assert parent_receipt['allocationIntents'][0]['machineName'].startswith('ebo-parent-')
    assert parent_receipt['allocationIntents'][0]['state'] == 'submitting'
    # Parent and child usage deletion is retained through the native SDK contract.
    records = []
    await e.delete_owned_machine(machine, manifest, records.append)
    assert records[0]['usage']['machine_id'] == 'owned-machine'

asyncio.run(check())
print('Cloud jobs contract: passed')
`], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Cloud jobs contract: passed/);
});

test("Cloud archive jobs retain receipts, split large transfers, and serialize source access", { skip: !python }, () => {
 const root=mkdtempSync(join(tmpdir(),"ebo-cloud-transfer-"));
 writeFileSync(join(root,"ebo_runtime.py"),HARBOR_TRIAL_SCRIPT);
 const result=spawnSync(python!,["-c",String.raw`
import asyncio,json
from pathlib import Path
from types import SimpleNamespace as NS
import ebo_runtime as e
root=Path.cwd(); commands=[];jobs={}
class Job:
    def __init__(self,id,out):self.id=id;self.out=out
    async def info(self):return NS(state='exited',exit_code=0)
    async def output(self,**kw):
        b=self.out.encode() if kw['stream']=='stdout' else b''
        return NS(data=b[kw['offset']:],next_offset=len(b),eof=True)
class Machine:
    async def start_job(self,argv,**kw):
        assert kw['timeout'] is None
        commands.append(argv[-1]);job=Job('job-'+str(len(commands)),'part-00\npart-01\n' if 'split -b' in argv[-1] else '')
        jobs[job.id]=job;return job
    async def read_file(self,path):return b'A' if path.endswith('00') else b'B'
async def check():
    t=await e.cloud_archive_transport(Machine(),root)
    assert await t._require_machine().read_file('/tmp/archive')==b'AB'
    assert '67108864' in commands[0]
    assert all(json.loads(p.read_text())['state']=='exited' for p in root.rglob('*.json'))
    # Harbor's own archive download runs unchanged over the job transport and extracts both chunks.
    import io, tarfile
    from harbor.environments.smol import SmolEnvironment
    packed=io.BytesIO()
    with tarfile.open(fileobj=packed,mode='w:gz') as archive:
        member=tarfile.TarInfo('worker-finished.json');body=b'{"terminal":"fixture"}';member.size=len(body);archive.addfile(member,io.BytesIO(body))
    payload=packed.getvalue();half=len(payload)//2
    class ArchiveMachine(Machine):
        async def read_file(self,path):return payload[:half] if path.endswith('00') else payload[half:]
    await SmolEnvironment.download_dir(await e.cloud_archive_transport(ArchiveMachine(),root),'/var/tmp/evidence',root/'retrieved')
    assert (root/'retrieved'/'worker-finished.json').read_bytes()==body
    (root/'fork.lock').touch();active=0;peak=0
    async def borrow():
        nonlocal active,peak
        async with e.async_file_lock(root/'fork.lock'):
            active+=1;peak=max(peak,active);await asyncio.sleep(.01);active-=1
    await asyncio.gather(*[borrow() for _ in range(3)]);assert peak==1
asyncio.run(check())
`],{cwd:root,encoding:"utf8"});
 assert.equal(result.status,0,result.stdout+result.stderr);
});
