import { SMOL_HIERARCHY_SCRIPT } from "./smol-hierarchy-script.js";
import { SMOL_JOBS_SCRIPT } from "./smol-jobs-script.js";
/** Provider glue only. Harbor owns steps/verifiers; Smol owns VM operations. */
export const SMOL_SCRIPT = String.raw`
import fcntl
import importlib.metadata
import platform
import shutil
import uuid
from smol import AsyncMachine, MachineConfig, ConnectOptions, ExecOptions
from harbor.environments.smol import SmolEnvironment, _checkpoint
from harbor.models.task.task import Task
from harbor.models.task.verifier_mode import resolve_effective_verifier_env_config, resolve_verifier_environment_definition
from harbor.publisher.packager import Packager
from harbor.environments.factory import EnvironmentFactory


def json_write(path, value):
    path = Path(path)
    temp = path.with_name('.' + uuid.uuid4().hex + '.tmp')
    try:
        with temp.open('x', encoding='utf-8') as file:
            os.chmod(temp, 0o600)
            json.dump(value, file)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        temp.unlink(missing_ok=True)

def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

async def cleanup_owned(name, operation, record):
    for attempt in range(1, 4):
        try:
            await operation()
            record({'machine': name, 'attempt': attempt, 'state': 'deleted'})
            return
        except Exception as exc:
            if getattr(exc, 'code', None) in {'NOT_FOUND', 'VM_NOT_FOUND'}:
                record({'machine': name, 'attempt': attempt, 'state': 'already-absent'})
                return
            record({'machine': name, 'attempt': attempt, 'state': 'failed', 'error': str(exc)})
            if attempt == 3: raise
            await asyncio.sleep(5)

@contextlib.asynccontextmanager
async def async_file_lock(path):
    with Path(path).open('a+') as lock:
        os.chmod(lock.name, 0o600)
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                await asyncio.sleep(0.1)
        try: yield
        finally: fcntl.flock(lock, fcntl.LOCK_UN)

async def boot_identity(machine):
    # SDK read_file assumes ordinary files; procfs reports a synthetic size.
    result = await machine.exec(['cat', '/proc/sys/kernel/random/boot_id'])
    value = result.stdout.strip()
    if result.exit_code or not value: raise ValueError('Cannot read parent boot identity')
    return value

def connection_options(manifest):
    if manifest.get('target', 'local') == 'local': return ConnectOptions(target='local')
    cloud = manifest['cloud']
    if cloud.get('auth') == 'cli':
        if os.environ.get('SMOL_CLOUD_TOKEN'): raise ValueError('Unset SMOL_CLOUD_TOKEN before using explicit CLI authentication')
        return ConnectOptions(target='cloud', base_url=cloud['baseUrl'], max_retries=0)
    token = os.environ.get(cloud['tokenEnv'])
    if not token: raise ValueError('Missing Cloud control credential: ' + cloud['tokenEnv'])
    return ConnectOptions(target='cloud', base_url=cloud['baseUrl'], api_key=token, max_retries=0)

async def machine_identity(machine, manifest):
    if manifest.get('target') != 'cloud': return machine.name
    info = await machine.info()
    value = info.get('id')
    if not isinstance(value, str) or not value: raise ValueError('Cloud machine metadata has no durable ID')
    return value

async def branch_image_identity(machine, manifest, expected):
    # The Cloud SDK cannot pull in a guest. Its machine record names the source image; the image
    # config digest is not reported there and stays explicitly absent.
    if manifest.get('target') == 'cloud':
        source = (await machine.info()).get('source')
        reference = source.get('reference') if isinstance(source, dict) else None
        digest = None
    else:
        pulled = await machine.pull_image(expected)
        reference, digest = pulled.reference, pulled.digest
    if reference != expected: raise ValueError('Smol branch image reference differs from its frozen input')
    return {'reference': reference, 'configDigest': digest}

async def delete_owned_machine(machine, manifest, record):
    if manifest.get('target') == 'cloud':
        from dataclasses import asdict
        machine_id = await machine_identity(machine, manifest)
        usage = await machine.delete(include_usage=True)
        record({'machine': machine_id, 'usage': asdict(usage) if usage is not None else None})
    else: await machine.delete()

def runtime_provenance(manifest, frozen_versions):
    versions = {name: importlib.metadata.version(name) for name in ('smolmachines', 'harbor')}
    if versions != frozen_versions:
        raise ValueError('RUNTIME_PROBE_MISMATCH: frozen=' + str(frozen_versions) + '; actual=' + str(versions))
    if manifest.get('target') == 'cloud':
        return {**versions, 'target': 'cloud', 'baseUrl': manifest['cloud']['baseUrl'],
                'platform': manifest['platform'], 'python': platform.python_version(), 'host': platform.node()}
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise ValueError('This Smol runtime is qualified only on Apple Silicon macOS')
    import smol
    package = Path(smol.__file__).resolve().parent
    # Smol wires its bundled library on first local use, rather than on import.
    if Path(os.environ.get('SMOLVM_LIB_DIR', package)).resolve() != package:
        raise ValueError('Smol must use its bundled libkrun; unset SMOLVM_LIB_DIR override')
    library = package / 'libkrun.dylib'
    if not library.is_file():
        raise ValueError('Smol bundled libkrun is missing')
    digest = hashlib.sha256(library.read_bytes()).hexdigest()
    if digest != manifest['libkrunSha256']:
        raise ValueError('Bundled libkrun digest differs from the frozen environment condition')
    return {**versions, 'libkrunSha256': digest, 'library': str(library),
            'python': platform.python_version(), 'host': platform.node(), 'platform': 'linux/arm64'}

def validate_environment_manifest(manifest):
    if manifest.get('schemaVersion') in {'ebo.smol-environments/v2', 'ebo.smol-environments/v3'} and 'target' not in manifest:
        raise ValueError('Smol manifest v2 requires an explicit target')
    local = manifest.get('target', 'local') == 'local'
    if manifest.get('schemaVersion') not in {'ebo.smol-environments/v1', 'ebo.smol-environments/v2', 'ebo.smol-environments/v3'}:
        raise ValueError('Expected versioned Smol environment manifest')
    if manifest.get('target', 'local') not in {'local', 'cloud'}: raise ValueError('Invalid Smol target')
    if local and manifest.get('platform') != 'linux/arm64': raise ValueError('Local Smol requires linux/arm64')
    if not local:
        if manifest['schemaVersion'] not in {'ebo.smol-environments/v2', 'ebo.smol-environments/v3'}: raise ValueError('Cloud requires manifest v2')
        if manifest.get('platform') not in {'linux/arm64', 'linux/amd64'}: raise ValueError('Unsupported Cloud architecture')
        from urllib.parse import urlsplit
        import re
        cloud = manifest.get('cloud', {})
        if set(cloud) - {'baseUrl', 'tokenEnv', 'auth'}: raise ValueError('Invalid Cloud connection metadata')
        url = urlsplit(cloud.get('baseUrl', ''))
        if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
            raise ValueError('Cloud baseUrl must be an HTTPS origin')
        cli = hierarchical(manifest) and cloud.get('auth') == 'cli' and 'tokenEnv' not in cloud
        token = 'auth' not in cloud and re.fullmatch('[A-Z][A-Z0-9_]*', cloud.get('tokenEnv', ''))
        if not (cli or token): raise ValueError('Cloud requires tokenEnv or explicit v3 CLI authentication')
    if not isinstance(manifest.get('tasks'), dict) or not manifest['tasks']:
        raise ValueError('Environment manifest needs task image bindings')
    import re
    if local and not re.fullmatch('[0-9a-f]{64}', manifest.get('libkrunSha256', '')):
        raise ValueError('Missing pinned libkrun digest')
    if hierarchical(manifest):
        validate_hierarchy(manifest)
        return
    for binding in manifest['tasks'].values():
        for image in [binding['agent'], *binding.get('graders', {}).values()]:
            validate_image_binding(image)

def local_setup_user(binding):
    return '0' if binding.get('localSetupUser') == 'root' else None

def validate_local_setup(setup):
    if setup is not None and (not isinstance(setup, str) or not setup or
            Path(setup).is_absolute() or '..' in Path(setup).parts):
        raise ValueError('localSetup must be a relative script inside the frozen environment context')

def validate_image_binding(image):
    import re
    if not re.fullmatch(r'[^\s]+@sha256:[0-9a-f]{64}', image['image']):
        raise ValueError('Use a registry-accessible platform-specific image digest, not a local tag')
    for key in ('recipeDigest', 'baseImageDigest'):
        if not re.fullmatch('[0-9a-f]{64}', image[key]):
            raise ValueError('Image preparation must record ' + key)
    validate_local_setup(image.get('localSetup'))
    if 'parentStartup' in image and image['parentStartup'] != 'idle':
        raise ValueError('parentStartup must be idle when specified')
    if 'localSetupUser' in image and (image['localSetupUser'] != 'root' or image.get('localSetup') is None):
        raise ValueError('localSetupUser must be root and requires a localSetup script')

async def prepare_local_context(env, machine, binding, evidence, timeout_seconds, manifest=None, owner=None, save_owner=None, stop=None):
    setup = binding.get('localSetup')
    if setup is None: return
    context = env.environment_dir.resolve()
    script = (context / setup).resolve()
    if not script.is_relative_to(context) or not script.is_file():
        raise ValueError('localSetup is missing or escapes the frozen environment context')
    # Only this role's context is uploaded: never the task root or hidden solution.
    guest = '/tmp/ebo-parent-setup'
    env._machine = machine
    try:
        await env.upload_dir(context, guest)
        result = await run_preparation_command(machine, manifest or {}, ['sh', '-eu', guest + '/' + setup], evidence,
            workdir=guest, timeout_seconds=timeout_seconds, user=local_setup_user(binding), owner=owner, save_owner=save_owner, stop=stop)
        json_write(evidence, {'script': setup, 'scriptDigest': hashlib.sha256(script.read_bytes()).hexdigest(),
            'exitCode': result.exit_code, 'stdout': result.stdout, 'stderr': result.stderr})
        if result.exit_code: raise RuntimeError('Local parent setup failed; see ' + str(evidence))
        result = await machine.exec(['rm', '-rf', guest], ExecOptions(user=local_setup_user(binding)))
        if result.exit_code: raise RuntimeError('Cannot remove local preparation context')
    finally:
        env._machine = None

def derive_task(source, target, binding, verified):
    # Materialize only an execution product; never edit an admitted snapshot.
    original = Task(Path(source), disable_verification=not verified)
    config = original.config.model_copy(deep=True)
    graders = []
    for step in config.steps or [None]:
        env = resolve_effective_verifier_env_config(config, step)
        if verified and env is not None:
            key = step.name if step else 'single'
            if key not in binding.get('graders', {}):
                raise ValueError('Missing separate grader image: ' + key)
            graders.append((step, env.model_copy(deep=True), binding['graders'][key]))
    config.environment.docker_image = binding['agent']['image']
    for step, env, image in graders:
        env.docker_image = image['image']
        (step.verifier if step else config.verifier).environment = env
    shutil.copytree(source, target)
    Path(target, 'task.toml').write_text(config.model_dump_toml(), encoding='utf-8')
    derived = Task(Path(target), disable_verification=not verified)
    if original.instruction != derived.instruction or [original.step_instruction(s.name) for s in original.config.steps or []] != [derived.step_instruction(s.name) for s in derived.config.steps or []]:
        raise ValueError('Image binding changed task instructions')
    return {'originalDigest': Packager.compute_content_hash(Path(source))[0],
            'derivedDigest': Packager.compute_content_hash(Path(target))[0], 'images': binding}

def owner_alive(root):
    with Path(root, 'owner.lock').open('r') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        return False

def env_identity(env):
    # environment_id includes content uploaded by Harbor after branching.
    config = env.task_env_config.model_dump(mode='json')
    if config.get('env'):
        raise ValueError('Host-expanded task environment variables cannot enter a shared parent; use worker credential keys')
    if config.get('gpus') or config.get('tpu') or config.get('mcp_servers'):
        raise ValueError('GPU, TPU and task MCP servers are not qualified for this Smol profile')
    if not config.get('workdir') or config['workdir'] == '/':
        raise ValueError('Declare an absolute non-root environment workdir')
    if env.network_policy.network_mode.value != 'public':
        raise ValueError('This Smol profile qualifies public egress only; no-network image import and allowlist networking require separate conformance. Policy is never broadened.')
    role = 'agent' if env.environment_dir.name == 'environment' else 'grader'
    context = str(Path('steps', env.environment_dir.parent.name, 'tests')) if env.environment_dir.parent.parent.name == 'steps' else env.environment_dir.name
    harness = env.ebo_harness if hierarchical(env.ebo_manifest) and role == 'agent' else None
    return {**({'harnessId': harness} if harness is not None else {}), 'role': role, 'context': context, 'environmentId': env.environment_id, 'configuration': config,
            'runtime': env.ebo_runtime,
            'network': env.network_policy.model_dump(mode='json')}

class OwnedSmolEnvironment(SmolEnvironment):
    def __init__(self, *args, ebo_owner=None, ebo_queue=None, ebo_prepare=False, ebo_events=None, ebo_runtime=None, ebo_manifest=None, ebo_controller_lock=None, ebo_harness=None, **kwargs):
        self.ebo_owner, self.ebo_queue = ebo_owner, ebo_queue
        self.ebo_prepare, self.ebo_events = ebo_prepare, ebo_events
        self.ebo_transfer_failed = False
        self.ebo_context_prepared = False
        self.ebo_harness = ebo_harness
        self.ebo_controller_lock = ebo_controller_lock
        self.ebo_runtime = ebo_runtime
        self.ebo_manifest = ebo_manifest or {}
        conn = connection_options(self.ebo_manifest)
        super().__init__(*args, target=conn.target, base_url=conn.base_url, api_key=conn.api_key, auto_checkpoint=False, fork_batch_window_ms=0, **kwargs)
        self._connect = conn
        # Smol includes session_id in the guest hostname; keep it below Linux's 64-byte limit.
        self.session_id = hashlib.sha256(self.session_id.encode()).hexdigest()[:24]

    def event(self, state, **fields):
        if self.ebo_events:
            with open(self.ebo_events, 'a', encoding='utf-8') as file:
                os.chmod(self.ebo_events, 0o600)
                file.write(json.dumps({'time': time.time(), 'state': state,
                    'environmentId': self.environment_id, **fields}) + '\n')
                file.flush()
                os.fsync(file.fileno())
        if self.ebo_owner:
            with open(Path(self.ebo_owner, 'children.jsonl'), 'a', encoding='utf-8') as file:
                os.chmod(file.name, 0o600)
                file.write(json.dumps({'state': state, **fields}) + '\n')
                file.flush()
                os.fsync(file.fileno())

    async def start(self, force_build):
        if self.ebo_prepare: raise RuntimeError('Preparation inspection cannot start an attempt')
        if not owner_alive(self.ebo_owner): raise RuntimeError('Smol parent owner is not alive; explicitly prepare again')
        receipt = json.loads(Path(self.ebo_owner, 'receipt.json').read_text())
        if receipt['state'] != 'ready' or receipt['queueDigest'] != self.ebo_queue:
            raise ValueError('Smol preparation is not ready for this queue')
        identity = env_identity(self)
        key = fingerprint(identity)
        parent = receipt['parents'].get(key)
        if parent is None: raise ValueError('Missing exact Smol parent binding; cold fallback is forbidden')
        self.ebo_context_prepared = parent.get('localSetup') is not None
        async with async_file_lock(Path(self.ebo_owner, 'fork-' + key + '.lock')):
            machine = await AsyncMachine.connect(parent['machine'], self._connect)
            state = await machine.state()
            ready = state == 'running' if self._target == 'local' else state in {'running', 'started'} and await machine.ready()
            while self._target == 'cloud' and state in {'running', 'started'} and not ready:
                if not owner_alive(self.ebo_owner): raise RuntimeError('Parent owner ended while waiting for the snapshot source')
                await asyncio.sleep(0.2)
                state = await machine.state()
                ready = state in {'running', 'started'} and await machine.ready()
            if not ready:
                raise ValueError('Smol parent is not running and ready; state=' + state + '; stopped parents are not warm preparation')
            # connect() can restart a stopped local machine. A kernel boot identity
            # prevents that cold restart from masquerading as the prepared RAM state.
            if await boot_identity(machine) != parent['bootId']:
                raise ValueError('Smol parent restarted; explicitly prepare a new parent')
            self._checkpoints = {self.environment_id: _checkpoint(parent['checkpoint'])}
            started = time.monotonic()
            self.event('branch-start', parent=parent['machine'], fingerprint=key)
            try:
                await super().start(force_build)
            except BaseException as exc:
                self.event('branch-failed', parent=parent['machine'], error=str(exc),
                           recovery='Drain attempts and restart the preparation owner; never cold-fallback on chain limits')
                raise
        self.ebo_image_identity = await branch_image_identity(self._machine, self.ebo_manifest, self.task_env_config.docker_image)
        self.ebo_child_id = await machine_identity(self._machine, self.ebo_manifest)
        self.event('branch-ready', imageConfigDigest=self.ebo_image_identity['configDigest'], parent=parent['machine'], child=self.ebo_child_id,
                   durationSeconds=time.monotonic()-started, fingerprint=key)

    async def _upload_environment_dir_after_start(self):
        if self.environment_dir.name == 'tests':
            # Harbor expects separate-verifier images to contain /tests.
            # This reusable image receives the hidden tests only in the grader child.
            await self.upload_dir(self.environment_dir, '/tests')
        elif not self.ebo_context_prepared:
            # Local setup already materialized the agent context before branching.
            await super()._upload_environment_dir_after_start()

    async def download_dir(self, source_dir, target_dir):
        try:
            if self.ebo_manifest.get('target') == 'cloud':
                async with async_file_lock(Path(self.ebo_owner, 'transfer.lock')):
                    transfer = await cloud_archive_transport(self._require_machine(), Path(target_dir).parent, getattr(self, 'ebo_baseline_excludes', ()))
                    await SmolEnvironment.download_dir(transfer, source_dir, target_dir)
            else:
                await super().download_dir(source_dir, target_dir)
        except BaseException:
            self.ebo_transfer_failed = True
            raise

    async def delete_machine(self):
        if self.ebo_manifest.get('target') != 'cloud':
            return await super().stop(True)
        await delete_owned_machine(self._machine, self.ebo_manifest,
            lambda event: self.event('usage', **event))
        self._machine = None

    async def stop(self, delete):
        child = getattr(self, 'ebo_child_id', self._machine.name) if self._machine else None
        if self.ebo_transfer_failed and child:
            self.event('cleanup-pending', child=child, reason='Evidence retrieval failed; deletion withheld. SDK process exit may stop this machine; recovery is not guaranteed.')
            return
        try:
            if delete and child:
                await cleanup_owned(child, self.delete_machine,
                    lambda event: self.event('cleanup-attempt', cleanup=event))
            else:
                await super().stop(delete)
            self.event('deleted', child=child)
        except BaseException as exc:
            self.event('cleanup-pending', child=child, reason=str(exc))
            raise

async def preparation_environments(trial, binding):
    yield trial.agent_environment, binding['agent']
    if trial.config.verifier.disable: return
    for step in trial.task.config.steps or [None]:
        definition = resolve_verifier_environment_definition(trial.task.config, trial.task.paths, step)
        if definition is None: continue
        plan = trial._network_plan(step, env_config=definition.config)
        env = EnvironmentFactory.create_environment_from_config(
            config=trial.config.environment, environment_dir=definition.directory,
            enable_environment_dir_upload=not definition.bundled_tests,
            environment_name=trial.task.short_name, session_id='ebo-prepare-grader',
            trial_paths=trial.paths, task_env_config=definition.config,
            network_policy=plan.verifier_env_baseline, phase_network_policies=[plan.verifier_phase])
        trial._validate_separate_verifier_env_policies(env, plan=plan)
        yield env, binding['graders'][step.name if step else 'single']

def recovery_barriers(journal):
    children, ambiguous = {}, {}
    for line in Path(journal).read_text().splitlines():
        event = json.loads(line)
        if event.get('child'): children[event['child']] = event['state']
        if event['state'] == 'branch-failed': ambiguous[event['parent']] = event
        if event['state'] == 'branch-reconciled': ambiguous.pop(event['parent'], None)
    errors = []
    retained = [child for child, state in children.items() if state != 'deleted']
    if retained: errors.append({'error': 'Children need recovery before parent cleanup', 'children': retained})
    if ambiguous: errors.append({'error': 'Ambiguous trial branches require inventory reconciliation before ancestor cleanup', 'branches': list(ambiguous.values())})
    return errors

async def serve_parents(request):
    root = Path(request['ownerRoot'])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    manifest = request['environmentManifest']
    validate_environment_manifest(manifest)
    provenance = runtime_provenance(manifest, request['frozenPythonVersions'])
    with (root / 'owner.lock').open('a+') as owner:
        os.chmod(root / 'owner.lock', 0o600)
        fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        old = json.loads((root / 'receipt.json').read_text()) if (root / 'receipt.json').exists() else None
        resume = bool(request.get('resume')) and old is not None and old['state'] != 'retired'
        if old is not None and old['state'] != 'retired' and not resume:
            raise ValueError('Existing preparation is not retired; inspect owned VM IDs before removing its receipt')
        if resume:
            if old['queueDigest'] != request['queueDigest'] or old['runtime'] != provenance:
                raise ValueError('Cannot resume a different preparation binding or runtime')
            if any(i['state'] not in {'accepted', 'reconciled-absent'} for i in old.get('allocationIntents', [])):
                raise ValueError('Reconcile allocation inventory before resuming preparation')
            if any(j['state'] != 'exited' or j.get('exitCode') != 0 for j in old.get('preparationJobs', [])):
                raise ValueError('Reconcile preparation jobs before resuming; setup is never rerun implicitly')
            if recovery_barriers(root / 'children.jsonl'):
                raise ValueError('Recover and reconcile existing children before resuming preparation')
            recorded = {p['machine'] for p in [*old.get('metaParents', {}).values(), *old['parents'].values()]}
            allocated = {i['machine'] for i in old.get('allocationIntents', []) if i['state'] == 'accepted'}
            if recorded != allocated:
                raise ValueError('An allocated machine lacks a completed parent binding; reconcile it first')
        session = old['ownerSession'] if resume else uuid.uuid4().hex
        work = root / session
        if resume: work = work / ('resume-' + uuid.uuid4().hex)
        work.mkdir(mode=0o700, parents=True)
        receipt = old if resume else {'ownerSession': session, 'queueDigest': request['queueDigest'],
                   'runtime': provenance, 'parents': {}, 'startedAt': time.time()}
        if resume: receipt['resumeValidation'] = 'checking'
        if resume: receipt.setdefault('resumptions', []).append({'at': time.time(), 'priorState': receipt['state'], 'priorCleanupErrors': receipt.get('cleanupErrors', [])})
        receipt.update(state='preparing', cleanupErrors=[])
        json_write(root / 'receipt.json', receipt)
        if not resume: (root / 'children.jsonl').write_text('')
        os.chmod(root / 'children.jsonl', 0o600)
        machines = []
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM): loop.add_signal_handler(sig, stop.set)
        try:
            await prepare_owned_parents(request, work, receipt, machines, stop)
            if resume: receipt['resumeValidation'] = 'passed'
            receipt['state'] = 'ready'
            json_write(root / 'receipt.json', receipt)
            print(json.dumps({'state': 'ready', 'receipt': str(root / 'receipt.json'), 'parents': len(machines)}), flush=True)
            await stop.wait()
        finally:
            receipt['state'] = 'draining'
            json_write(root / 'receipt.json', receipt)
            # Shared OS locks cover whole trials, including verifier/retrieval/cleanup.
            with (root / 'borrowers.lock').open('a+') as borrowers:
                deadline = time.monotonic() + 60
                drained = False
                while time.monotonic() < deadline:
                    try:
                        fcntl.flock(borrowers, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        drained = True
                        break
                    except BlockingIOError:
                        await asyncio.sleep(.2)
                errors = [{'error': 'Ambiguous parent allocation; inspect Cloud inventory before retrying', **intent}
                    for intent in receipt.get('allocationIntents', []) if intent['state'] not in {'accepted', 'reconciled-absent'}]
                if receipt.get('resumeValidation') == 'checking': errors.append({'error': 'Warm preparation resume validation did not complete; retain all owned machines'})
                errors.extend({'error': 'Preparation job requires reconciliation before ancestor cleanup', **job}
                    for job in receipt.get('preparationJobs', []) if job['state'] not in {'exited', 'canceled'})
                barriers = recovery_barriers(root / 'children.jsonl')
                errors.extend(barriers)
                if drained and not errors:
                    def record_cleanup(event):
                        receipt.setdefault('cleanupAttempts', []).append(event)
                        json_write(root / 'receipt.json', receipt)
                    for machine in reversed(machines):
                        try: await cleanup_owned(machine.name, lambda: delete_owned_machine(machine, manifest, record_cleanup), record_cleanup)
                        except Exception as exc:
                            errors.append({'machine': machine.name, 'error': str(exc)})
                            break
                elif not drained: errors.append({'error': 'Active trials did not drain; parents retained for operator cleanup'})
                receipt.update(state='cleanup-pending' if errors else 'retired', cleanupErrors=errors, stoppedAt=time.time())
                json_write(root / 'receipt.json', receipt)
${SMOL_HIERARCHY_SCRIPT}
${SMOL_JOBS_SCRIPT}
`;
