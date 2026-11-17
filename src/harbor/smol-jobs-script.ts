/** Native Smol jobs, durable receipts and byte-offset output recovery. */
export const SMOL_JOBS_SCRIPT = String.raw`
from dataclasses import asdict
from smol.errors import SmolError

async def cloud_job_read(read, receipt_path, receipt, operation):
    failures = 0
    while True:
        try:
            value = await read()
            if failures:
                receipt['lastReadRecovery'] = {'operation': operation, 'at': time.time(), 'failures': failures}
                json_write(receipt_path, receipt)
            return value
        except SmolError as error:
            # Only repeat reads of an already accepted job. Never replay job
            # submission, cancellation or deletion after an ambiguous response.
            if error.code not in {'TIMEOUT', 'CONNECTION', 'NETWORK_ERROR'} and error.status not in {429, 500, 502, 503, 504}:
                raise
            failures += 1
            receipt.setdefault('readFailures', []).append({'operation': operation, 'at': time.time(),
                'code': error.code, 'status': error.status})
            json_write(receipt_path, receipt)
            await asyncio.sleep(min(30, 2 ** min(failures, 5)))

async def collect_job_output(job, receipt_path, receipt):
    target = Path(receipt_path).parent
    target.mkdir(parents=True, exist_ok=True)
    for stream in ('stdout', 'stderr'):
        path = target / ('worker-' + stream + '.log')
        offset = receipt.setdefault('offsets', {}).get(stream, 0)
        # Disk can be ahead of the fsynced receipt after a coordinator crash.
        with path.open('a+b') as file:
            os.chmod(path, 0o600)
            file.seek(0, 2)
            if file.tell() < offset: raise ValueError('Local job output is shorter than its durable offset')
            file.truncate(offset)
            while True:
                out = await cloud_job_read(lambda: job.output(stream=stream, offset=offset, limit=1024*1024),
                    receipt_path, receipt, 'output-' + stream)
                if out.next_offset != offset + len(out.data): raise ValueError('Invalid Cloud output offset')
                file.write(out.data)
                file.flush()
                os.fsync(file.fileno())
                offset = out.next_offset
                receipt['offsets'][stream] = offset
                json_write(receipt_path, receipt)
                if out.eof or not out.data: break

async def run_preparation_command(machine, manifest, command, evidence, workdir=None, timeout_seconds=None, user=None, owner=None, save_owner=None, stop=None):
    if manifest.get('target') != 'cloud':
        return await machine.exec(command, ExecOptions(workdir=workdir, timeout=None if timeout_seconds is None else max(1, int(timeout_seconds)), user=user))
    if owner is None or save_owner is None:
        raise ValueError('Cloud preparation requires durable owner bookkeeping')
    control = Path(evidence).with_suffix('.job')
    control.mkdir(parents=True, exist_ok=True)
    path = control / 'smol-job.json'
    if path.exists(): raise ValueError('Preparation receipt exists; reconcile the native job instead of resubmitting')
    receipt = {'schemaVersion': 'ebo.smol-preparation-job/v1', 'machine': await machine_identity(machine, manifest),
        'manifest': manifest, 'state': 'submitting', 'commandDigest': fingerprint(command), 'offsets': {}, 'startedAt': time.time()}
    tracked = {'machine': receipt['machine'], 'receipt': str(path), 'state': 'submitting'}
    owner.setdefault('preparationJobs', []).append(tracked)
    json_write(path, receipt); save_owner()
    job = await machine.start_job(command, workdir=workdir, user=user, timeout=None if timeout_seconds is None else max(1, __import__('math').ceil(timeout_seconds)))
    receipt.update(jobId=job.id, state='running'); tracked.update(jobId=job.id, state='running')
    json_write(path, receipt); save_owner()
    while True:
        info = await job.cancel() if stop is not None and stop.is_set() else await job.info()
        await collect_job_output(job, path, receipt)
        receipt.update(state=info.state, exitCode=info.exit_code); tracked.update(state=info.state, exitCode=info.exit_code)
        json_write(path, receipt); save_owner()
        if info.state != 'running': break
        await asyncio.sleep(1)
    if info.state not in {'exited', 'canceled'}: raise RuntimeError('Preparation job lost; retain its machine for reconciliation')
    from types import SimpleNamespace
    return SimpleNamespace(exit_code=info.exit_code, stdout=(control/'worker-stdout.log').read_text(errors='replace'),
        stderr=(control/'worker-stderr.log').read_text(errors='replace'))

async def run_cloud_worker(environment, command, env, workdir, remote_root, native_root, deadline):
    control = Path(native_root).with_name(Path(native_root).name + '-cloud-job')
    control.mkdir(parents=True, exist_ok=True)
    with (control / 'smol-job.lock').open('a+') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return await submit_cloud_worker(environment, command, env, workdir, remote_root, native_root, deadline)

async def submit_cloud_worker(environment, command, env, workdir, remote_root, native_root, deadline):
    machine = environment._require_machine()
    path = Path(native_root).with_name(Path(native_root).name + '-cloud-job') / 'smol-job.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists(): raise ValueError('Job receipt exists; recover it rather than launch a duplicate attempt')
    receipt = {'schemaVersion': 'ebo.smol-job/v1', 'state': 'submitting',
        'machine': await machine_identity(machine, environment.ebo_manifest), 'manifest': environment.ebo_manifest,
        'ownerRoot': environment.ebo_owner, 'environmentId': environment.environment_id,
        'controllerLock': getattr(environment, 'ebo_controller_lock', None),
        'remoteRoot': remote_root, 'nativeRoot': str(Path(native_root).resolve()),
        'bootId': await boot_identity(machine), 'commandDigest': fingerprint(command),
        'offsets': {}, 'startedAt': time.time()}
    # Intent is durable before submission. An ambiguous response must be investigated,
    # never retried: the service may already have accepted the original job.
    json_write(path, receipt)
    environment.ebo_transfer_failed = True
    environment.event('job-submitting', child=receipt['machine'], receipt=str(path))
    timeout = None if deadline is None else max(1, __import__('math').ceil(deadline-time.monotonic()))
    job = await machine.start_job(['/bin/sh', '-c', command], workdir=workdir, env=env, timeout=timeout)
    receipt.update(jobId=job.id, state='running')
    json_write(path, receipt)
    environment.event('job-started', child=receipt['machine'], jobId=job.id, receipt=str(path))
    try:
        while True:
            info = await cloud_job_read(job.info, path, receipt, 'status')
            await collect_job_output(job, path, receipt)
            receipt.update(state=info.state, exitCode=info.exit_code)
            json_write(path, receipt)
            if info.state != 'running': break
            await asyncio.sleep(1)
    except asyncio.CancelledError:
        # Explicit cancellation/deadline stops the owned job. Transport failures leave
        # it alive for recovery and withhold machine deletion.
        info = await job.cancel()
        receipt.update(state=info.state, exitCode=info.exit_code, canceledAt=time.time())
        json_write(path, receipt)
        await collect_job_output(job, path, receipt)
        raise
    if info.state != 'exited': raise RuntimeError('Cloud job lost; preserve the machine and partial evidence')
    return info.exit_code

async def cloud_archive_transport(machine, evidence, baseline_excludes=()):
    # Keep Harbor's archive command and safe extraction. Native jobs remove the
    # synchronous /exec transport timeout; chunks respect Cloud's per-file limit.
    from types import SimpleNamespace
    root = Path(evidence) / ('transfer-' + uuid.uuid4().hex)
    root.mkdir(parents=True)
    async def execute(command, **kwargs):
        if command.startswith('tar czf ') and baseline_excludes:
            import shlex
            patterns = [p for name in baseline_excludes for p in ('./baseline/'+name, './baseline/*/'+name)]
            command = 'tar ' + ' '.join('--exclude='+shlex.quote(p) for p in patterns) + ' -czf ' + command[len('tar czf '):]
        control = root / uuid.uuid4().hex
        control.mkdir()
        path = control / 'smol-job.json'
        receipt = {'state': 'submitting', 'command': command, 'offsets': {}}
        json_write(path, receipt)
        job = await machine.start_job(['/bin/sh', '-c', command], user=kwargs.get('user'), timeout=None)
        receipt.update(state='running', jobId=job.id); json_write(path, receipt)
        while True:
            info = await job.info()
            receipt.update(state=info.state, exitCode=info.exit_code); json_write(path, receipt)
            if info.state != 'running': break
            await asyncio.sleep(1)
        await collect_job_output(job, path, receipt)
        if info.state != 'exited': raise RuntimeError('Archive transfer job lost; retain source evidence')
        return SimpleNamespace(return_code=info.exit_code,
            stdout=(control/'worker-stdout.log').read_text(errors='replace'),
            stderr=(control/'worker-stderr.log').read_text(errors='replace'))
    async def read_file(path):
        import shlex
        parts = path + '.parts'
        command = 'mkdir -p ' + shlex.quote(parts) + ' && split -b 67108864 -d ' + shlex.quote(path) + ' ' + shlex.quote(parts+'/part-') + ' && ls ' + shlex.quote(parts)
        result = await execute(command, user='root')
        if result.return_code: raise RuntimeError('Cannot split archive: ' + result.stderr)
        names = result.stdout.splitlines()
        if not names or any(not __import__('re').fullmatch(r'part-[0-9]+', name) for name in names):
            raise ValueError('Invalid archive chunk inventory')
        payload = b''.join([await machine.read_file(parts+'/'+name) for name in names])
        result = await execute('rm -rf ' + shlex.quote(parts), user='root')
        if result.return_code: raise RuntimeError('Cannot clean archive chunks')
        return payload
    # Harbor's download_dir reads these members of its environment.
    return SimpleNamespace(exec=execute, logger=__import__('logging').getLogger('ebo.smol.transfer'),
        _require_machine=lambda: SimpleNamespace(read_file=read_file))

async def recover_cloud_job(request):
    path = Path(request['receipt']).resolve()
    # The same output offsets cannot be updated by two coordinators.
    with path.with_suffix('.lock').open('a+') as lock, contextlib.ExitStack() as locks:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        receipt = json.loads(path.read_text())
        if receipt.get('schemaVersion') != 'ebo.smol-job/v1': raise ValueError('Invalid job receipt')
        if receipt.get('controllerLock'):
            controller = locks.enter_context(Path(receipt['controllerLock']).open('a+'))
            try: fcntl.flock(controller, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise ValueError('Trial coordinator is still active; recovery cannot race its retrieval or cleanup')
        manifest = receipt['manifest']
        validate_environment_manifest(manifest)
        runtime_provenance(manifest, request['frozenPythonVersions'])
        if manifest.get('target') != 'cloud': raise ValueError('Job recovery requires Cloud')
        if not receipt.get('jobId'):
            raise ValueError('Ambiguous submission: inspect machine.jobs() and reconcile the original job ID; never relaunch')
        machine = await AsyncMachine.connect(receipt['machine'], connection_options(manifest))
        receipt['recoveryBootId'] = await boot_identity(machine)
        receipt['bootContinuity'] = receipt['recoveryBootId'] == receipt['bootId']
        if not receipt['bootContinuity']:
            receipt['continuityGap'] = 'Machine restarted; retrieve retained files without certifying uninterrupted execution'
        json_write(path, receipt)
        job = machine.job(receipt['jobId'])
        if request.get('cancel'): await job.cancel()
        info = await job.info()
        if not receipt['bootContinuity'] and info.state == 'running':
            raise ValueError('Running job reports a different machine boot; inspect remote state before recovery')
        await collect_job_output(job, path, receipt)
        receipt.update(state=info.state, exitCode=info.exit_code, recoveredAt=time.time())
        json_write(path, receipt)
        if info.state == 'running':
            if request.get('delete'): raise ValueError('Cannot delete a running job; cancel and retrieve first')
            return {'state': info.state, 'jobId': job.id, 'receipt': str(path)}
        # Reuse Harbor's archive transfer and safe extraction, with only its
        # native machine transport reconnected. This does not create a Trial.
        transfer = await cloud_archive_transport(machine, path.parent)
        async with async_file_lock(Path(receipt['ownerRoot'], 'transfer.lock')):
            await SmolEnvironment.download_dir(transfer, receipt['remoteRoot'], Path(receipt['nativeRoot']))
        receipt['evidenceRetrieved'] = True
        json_write(path, receipt)
        if request.get('delete'):
            receipt['cleanupState'] = 'deleting'
            json_write(path, receipt)
            def record_usage(event):
                receipt['usage'] = event['usage']
                json_write(path, receipt)
            def record_cleanup(event):
                receipt.setdefault('cleanupAttempts', []).append(event)
                json_write(path, receipt)
            try:
                await cleanup_owned(machine.name, lambda: delete_owned_machine(machine, manifest, record_usage), record_cleanup)
            except BaseException as exc:
                receipt.update(cleanupState='cleanup-pending', cleanupError=str(exc))
                json_write(path, receipt)
                raise
            receipt.update(deletedAt=time.time(), cleanupState='deleted')
            if 'usage' not in receipt:
                receipt.update(usage=None, usageGap='Machine already absent; settled usage was not returned')
            json_write(path, receipt)
            owner = Path(receipt['ownerRoot'], 'children.jsonl')
            with owner.open('a') as file:
                file.write(json.dumps({'state': 'deleted', 'child': receipt['machine']}) + '\n')
                file.flush(); os.fsync(file.fileno())
        return {'state': info.state, 'jobId': job.id, 'receipt': str(path), 'evidenceRetrieved': True}
`;
