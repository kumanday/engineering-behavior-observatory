import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { validateSmolProfile } from "../src/harbor/smol.js";
import { HARBOR_TRIAL_SCRIPT } from "../src/harbor/trial-script.js";

const image = { image: "registry.example/meta@sha256:" + "a".repeat(64), recipeDigest: "b".repeat(64), baseImageDigest: "c".repeat(64) };
const manifest = { schemaVersion: "ebo.smol-family-environments/v1", target: "cloud", platform: "linux/amd64",
  cloud: { baseUrl: "https://api.smolmachines.com", tokenEnv: "SMOL_CLOUD_TOKEN" },
  families: { node: image }, harnesses: { "pi-sdk": { families: ["node"] } }, tasks: { frozen: { agent: { family: "node" } } } };

test("hierarchy profiles use one immutable image per family and explicit compatible harnesses", () => {
  validateSmolProfile(manifest);
  validateSmolProfile({ ...manifest, cloud: { baseUrl: manifest.cloud.baseUrl, auth: "cli" } });
  assert.throws(() => validateSmolProfile({ ...manifest, cloud: { ...manifest.cloud, auth: "cli" } }));
  assert.throws(() => validateSmolProfile({ ...manifest, cloud: { baseUrl: manifest.cloud.baseUrl, auth: "cli" } }, ["SMOL_CLOUD_TOKEN"]));
  for (const invalid of [
    { ...manifest, families: {} },
    { ...manifest, families: { node: { ...image, image: "registry.example/meta:latest" } } },
    { ...manifest, harnesses: { "pi-sdk": { families: ["unknown"] } } },
    { ...manifest, tasks: { frozen: { agent: { family: "node", image: image.image } } } },
    { ...manifest, tasks: { frozen: { agent: { family: "unknown" } } } },
    { ...manifest, harnesses: { "pi-sdk": { families: ["node"], setupRef: { locator: "setup.sh", digest: { algorithm: "sha256", value: "bad" } } } } },
  ]) assert.throws(() => validateSmolProfile(invalid));
});

const python = process.env.EBO_HARBOR_PYTHON;
test("official Harbor trials inherit distinct prepared parents from a single clean meta-parent", { skip: !python }, () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-hierarchy-"));
  writeFileSync(join(root, "ebo_runtime.py"), HARBOR_TRIAL_SCRIPT);
  const result = spawnSync(python!, ["-c", String.raw`
import asyncio, copy, fcntl, hashlib, json, os, shutil
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch
import ebo_runtime as e

root = Path.cwd()
task = root/'frozen'
(task/'environment').mkdir(parents=True)
(task/'tests').mkdir()
(task/'environment'/'Dockerfile').write_text('FROM alpine:3.22\n')
(task/'instruction.md').write_text('Preserve this frozen instruction.\n')
(task/'tests'/'test.sh').write_text('echo hidden-grader-fixture\n')
(task/'task.toml').write_text('''schema_version = "1.4"
[environment]
workdir = "/workspace"
cpus = 1
memory_mb = 512
[verifier]
environment_mode = "separate"
''')
before = {str(p.relative_to(task)): p.read_bytes() for p in task.rglob('*') if p.is_file()}
image = {'image': 'registry.example/meta@sha256:'+'a'*64, 'recipeDigest': 'b'*64, 'baseImageDigest': 'c'*64}
scripts, harnesses = {}, {}
for harness in ('pi-sdk', 'codex'):
    script = root/(harness+'.sh')
    script.write_text('prepare-'+harness)
    digest = hashlib.sha256(script.read_bytes()).hexdigest()
    scripts[digest] = str(script)
    harnesses[harness] = {'families': ['node'], 'setupRef': {'locator': harness+'.sh', 'digest': {'algorithm': 'sha256', 'value': digest}}}
manifest = {'schemaVersion': 'ebo.smol-family-environments/v1', 'target': 'cloud', 'platform': 'linux/amd64',
    'cloud': {'baseUrl': 'https://api.smolmachines.com', 'tokenEnv': 'CONTROL_TOKEN'},
    'runtimeArchiveDigest': 'd'*64, 'families': {'node': image}, 'harnesses': harnesses,
    'tasks': {'frozen': {'agent': {'family': 'node'}, 'graders': {'single': {'family': 'node'}}}}}
e.validate_environment_manifest(manifest)
owner = root/'owner'; owner.mkdir()
work = root/'work'; work.mkdir()
request = {'ownerRoot': str(owner), 'queueDigest': 'queue', 'environmentManifest': manifest,
    'frozenPythonVersions': {name: __import__('importlib.metadata').metadata.version(name) for name in ('smolmachines', 'harbor')},
    'preparationScripts': scripts, 'build': 'test', 'model': 'fixture',
    'tasks': [{'id': 'frozen', 'path': str(task), 'verified': True, 'harnessId': h} for h in harnesses]}
receipt = {'state': 'preparing', 'ownerSession': 's'*32, 'queueDigest': 'queue', 'parents': {}}
creates, branches, trial_branches, pool, deletes = [], [], [], {}, []
class FakeMachine:
    def __init__(self, name, files=None):
        self.name = name
        self.id = 'mach-' + str(len(pool))
        self.files = copy.deepcopy(files if files is not None else {'/opt/ebo/runtime.sha256': b'd'*64})
        pool[self.id] = self
    async def exec(self, argv, opts=None):
        output = ''
        if argv[:2] == ['uname','-m']: output = 'x86_64'
        elif argv[:2] == ['cat','/proc/sys/kernel/random/boot_id']: output = 'same-kernel-boot'
        elif argv[:2] == ['sh','-eu']:
            assert opts.env is None
            self.files['harness-preparation'] = self.files[argv[2]]
        elif argv[:2] == ['rm','-f']: self.files.pop(argv[2], None)
        return NS(exit_code=0, stdout=output, stderr='')
    async def start_job(self, command, **kwargs):
        assert kwargs.get('timeout') is None
        await self.exec(command, NS(env=None, workdir=kwargs.get('workdir')))
        return NS(id='preparation-job', info=AsyncMock(return_value=NS(state='exited', exit_code=0)),
            output=AsyncMock(side_effect=lambda **kw: NS(data=b'', next_offset=kw['offset'], eof=True)))
    async def read_file(self, path): return self.files[path]
    async def write_file(self, path, data, mode=None): self.files[path] = data
    async def state(self): return 'started'
    async def ready(self): return True
    async def info(self): return {'id': self.id, 'source': {'type': 'image', 'reference': image['image']}}
    async def branch(self, name, *, branchable=False):
        assert branchable is True
        branches.append((self.name, name))
        return FakeMachine(name, self.files)
    async def fork_batch(self, *, names):
        trial_branches.extend((self.name, name) for name in names)
        return [FakeMachine(name, self.files) for name in names]
    async def delete(self, **kwargs): deletes.append(self.name)

async def create(config, connection):
    creates.append(config)
    assert config.branchable and config.env is None
    return FakeMachine(config.name)
async def connect(name, connection): return pool[name]

async def check():
    with patch.dict(os.environ, {'CONTROL_TOKEN': 'fixture-control-secret'}), \
         patch.object(e.AsyncMachine, 'create', side_effect=create), \
         patch.object(e.AsyncMachine, 'connect', side_effect=connect):
        machines = []
        await e.prepare_owned_parents(request, work, receipt, machines, asyncio.Event())
        assert len(creates) == 1 and creates[0].image == image['image']
        assert len(branches) == 3, branches  # two harness parents and one shared grader
        assert len(receipt['metaParents']) == 1 and len(receipt['parents']) == 3
        assert all(p['machine'].startswith('mach-') and p['checkpoint']['machine'] == p['machine'] for p in receipt['parents'].values())
        meta = pool[receipt['metaParents']['node']['machine']]
        assert 'harness-preparation' not in meta.files
        assert len({p['harnessPreparation']['harnessId'] for p in receipt['parents'].values() if p['harnessPreparation']}) == 2
        assert 'fixture-control-secret' not in json.dumps(receipt)
        assert {str(p.relative_to(task)): p.read_bytes() for p in task.rglob('*') if p.is_file()} == before
        receipt['state'] = 'ready'; e.json_write(owner/'receipt.json', receipt)
        (owner/'children.jsonl').write_text('')
        with (owner/'owner.lock').open('a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for harness in harnesses:
                derived = work/'frozen'/e.fingerprint(harness)[:16]
                for repetition in range(3):
                    trial_request = {**request, 'taskPath': str(derived), 'taskSourceId': 'frozen', 'harnessId': harness,
                        'attemptId': harness+'-'+str(repetition), 'verified': True, 'trialsDir': str(root/'trials')}
                    trial = await e.create_trial(trial_request, prepare=True)
                    env = trial.agent_environment; env.ebo_prepare = False
                    with patch.object(env, '_upload_environment_dir_after_start', new_callable=AsyncMock):
                        await env.start(False)
                    assert env._machine.files['harness-preparation'] == ('prepare-'+harness).encode()
                    assert not any('hidden-grader' in str(v) for v in env._machine.files.values())
                    env._machine.files['trial-private'] = b'private mutation'
                    assert 'trial-private' not in meta.files
            assert len(trial_branches) == 6
            assert len(creates) == 1
        # Warm completed bindings can be reused without new image pulls, forks or setup jobs.
        reused = []
        previous_creates, previous_branches = len(creates), len(branches)
        previous_jobs = len(receipt.get('preparationJobs', []))
        await e.prepare_owned_parents(request, root/'reused-work', receipt, reused, asyncio.Event())
        assert len(reused) == 4
        assert len(creates) == previous_creates and len(branches) == previous_branches
        assert len(receipt.get('preparationJobs', [])) == previous_jobs
        damaged = copy.deepcopy(receipt)
        damaged['metaParents']['node']['bootId'] = 'cold-boot'
        try: await e.prepare_owned_parents(request, root/'cold-work', damaged, [], asyncio.Event())
        except ValueError as exc: assert 'restarted' in str(exc)
        else: raise AssertionError('Cold parent resumed')
        # Lost trial-fork responses also block ancestor deletion, even without a child ID.
        journal = owner/'children.jsonl'
        journal.write_text('')
        with (owner/'owner.lock').open('a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            trial = await e.create_trial({**trial_request, 'attemptId': 'ambiguous-trial'}, prepare=True)
            env = trial.agent_environment; env.ebo_prepare = False
            with patch.object(FakeMachine, 'fork_batch', new_callable=AsyncMock, side_effect=ConnectionError('trial fork response lost')):
                try: await env.start(False)
                except ConnectionError: pass
                else: raise AssertionError('Ambiguous trial branch hidden')
        barriers = e.recovery_barriers(journal)
        assert any('Ambiguous trial branches' in value['error'] for value in barriers)
        event = next(json.loads(line) for line in journal.read_text().splitlines() if json.loads(line)['state']=='branch-failed')
        with journal.open('a') as file: file.write(json.dumps({'state': 'branch-reconciled', 'parent': event['parent']})+'\n')
        assert not e.recovery_barriers(journal)
        # A failed explicit warm-resume validation cannot delete a validated ancestor.
        resume_owner = root/'resume-owner'; resume_owner.mkdir()
        (resume_owner/'children.jsonl').write_text('')
        resumed_receipt = copy.deepcopy(receipt)
        resumed_receipt.update(state='cleanup-pending', runtime=e.runtime_provenance(manifest, request['frozenPythonVersions']))
        resumed_receipt['parents'][next(iter(resumed_receipt['parents']))]['bootId'] = 'different-boot'
        (resume_owner/'receipt.json').write_text(json.dumps(resumed_receipt))
        try: await e.serve_parents({**request, 'ownerRoot': str(resume_owner), 'resume': True})
        except ValueError as exc: assert 'restarted' in str(exc)
        else: raise AssertionError('Cold parent accepted by resume owner')
        blocked = json.loads((resume_owner/'receipt.json').read_text())
        assert blocked['state'] == 'cleanup-pending' and blocked['resumeValidation'] == 'checking'
        assert not deletes
        # Image overrides, unsupported families and ambiguous resource sharing fail before allocation.
        bad = copy.deepcopy(request)
        bad['environmentManifest']['harnesses']['pi-sdk']['families'] = ['different']
        bad['environmentManifest']['families']['different'] = image
        try: await e.plan_preparation(bad, root/'invalid')
        except ValueError as exc: assert 'does not support' in str(exc)
        else: raise AssertionError('Incompatible harness family was accepted')
        assert len(creates) == 1
        # Corrupt resolved recipes are rejected before they can prepare a parent.
        script = Path(next(iter(scripts.values())))
        old = script.read_bytes(); script.write_bytes(b'changed script')
        try: await e.prepare_harness(meta, request, 'pi-sdk', root/'bad.json', '/workspace')
        except ValueError as exc: assert 'digest changed' in str(exc)
        else: raise AssertionError('Changed preparation script accepted')
        script.write_bytes(old)
        # Different requested resources cannot silently share a family.
        other = root/'other-task'; shutil.copytree(task, other)
        (other/'task.toml').write_text((other/'task.toml').read_text().replace('cpus = 1','cpus = 2'))
        mismatch = copy.deepcopy(request)
        mismatch['environmentManifest']['tasks']['other'] = copy.deepcopy(manifest['tasks']['frozen'])
        mismatch['tasks'].append({'id': 'other', 'path': str(other), 'verified': True, 'harnessId': 'pi-sdk'})
        try: await e.plan_preparation(mismatch, root/'resource-mismatch')
        except ValueError as exc: assert 'incompatible resources' in str(exc)
        else: raise AssertionError('Resources silently changed in a branch')
        assert len(creates) == 1
        # A lost setup-job response retains its meta/parent and never repeats submission.
        prep_failure = {**request, 'ownerRoot': str(root/'failed-preparation-owner')}
        with patch.object(FakeMachine, 'start_job', new_callable=AsyncMock, side_effect=ConnectionError('setup response lost')) as submit:
            try: await e.serve_parents(prep_failure)
            except ConnectionError: pass
            else: raise AssertionError('Ambiguous preparation submission hidden')
            assert submit.await_count == 1
        pending = json.loads((root/'failed-preparation-owner'/'receipt.json').read_text())
        assert pending['state'] == 'cleanup-pending'
        assert pending['preparationJobs'][-1]['state'] == 'submitting'
        assert any('Preparation job' in error['error'] for error in pending['cleanupErrors'])
        assert not deletes
        # A transport loss after acceptance preserves the existing setup job identity.
        disconnected_job = NS(id='accepted-setup-job', info=AsyncMock(side_effect=ConnectionError('setup poll disconnected')))
        poll_failure = {**request, 'ownerRoot': str(root/'disconnected-preparation-owner')}
        with patch.object(FakeMachine, 'start_job', new_callable=AsyncMock, return_value=disconnected_job) as submit:
            try: await e.serve_parents(poll_failure)
            except ConnectionError: pass
            else: raise AssertionError('Preparation disconnect hidden')
            assert submit.await_count == 1
        retained = json.loads((root/'disconnected-preparation-owner'/'receipt.json').read_text())
        assert retained['state'] == 'cleanup-pending'
        assert retained['preparationJobs'][-1]['jobId'] == 'accepted-setup-job'
        assert retained['preparationJobs'][-1]['state'] == 'running'
        assert not deletes
        # A lost branch response retains every ancestor for reconciliation.
        original_branch = FakeMachine.branch
        branch_count = 0
        async def ambiguous_branch(self, name, *, branchable=False):
            nonlocal branch_count
            branch_count += 1
            if branch_count == 2: raise ConnectionError('lost branch response')
            return await original_branch(self, name, branchable=branchable)
        failure = {**request, 'ownerRoot': str(root/'failed-owner')}
        with patch.object(FakeMachine, 'branch', ambiguous_branch):
            try: await e.serve_parents(failure)
            except ConnectionError: pass
            else: raise AssertionError('Ambiguous branch hidden')
        failed = json.loads((root/'failed-owner'/'receipt.json').read_text())
        assert failed['state'] == 'cleanup-pending'
        assert failed['allocationIntents'][-1]['state'] == 'submitting'
        assert failed['allocationIntents'][-1]['source']
        assert not deletes

asyncio.run(check())
print('Hierarchy native Harbor contract: passed')
`], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Hierarchy native Harbor contract: passed/);
});
