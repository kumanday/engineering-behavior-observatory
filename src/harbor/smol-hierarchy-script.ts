/** Preparation lineage only; native Harbor still owns trial and verifier execution. */
export const SMOL_HIERARCHY_SCRIPT = String.raw`
from dataclasses import asdict

def hierarchical(manifest):
    return manifest.get('schemaVersion') == 'ebo.smol-family-environments/v1'

def validate_hierarchy(manifest):
    if not hierarchical(manifest): return
    import re
    families = manifest.get('families')
    harnesses = manifest.get('harnesses')
    if not isinstance(families, dict) or not families: raise ValueError('Hierarchy needs image families')
    if not isinstance(harnesses, dict) or not harnesses: raise ValueError('Hierarchy needs explicit harness bindings')
    for name, family in families.items():
        if not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]*', name): raise ValueError('Invalid family ID')
        if not isinstance(family, dict) or set(family) != {'image', 'recipeDigest', 'baseImageDigest'}:
            raise ValueError('Family must pin exactly one image, recipeDigest and baseImageDigest')
        validate_image_binding(family)
    for harness in harnesses.values():
        if not isinstance(harness, dict) or set(harness) - {'families', 'setupRef'}:
            raise ValueError('Invalid harness preparation binding')
        if not isinstance(harness.get('families'), list) or not harness['families'] or any(f not in families for f in harness['families']):
            raise ValueError('Harness references an unknown or empty family list')
        if 'setupRef' in harness:
            ref = harness['setupRef']
            if not isinstance(ref, dict) or not isinstance(ref.get('locator'), str) or ref.get('digest', {}).get('algorithm') != 'sha256' or not re.fullmatch('[0-9a-f]{64}', ref.get('digest', {}).get('value', '')):
                raise ValueError('Harness setupRef requires a SHA-256 artifact reference')
    for task in manifest['tasks'].values():
        for binding in [task['agent'], *task.get('graders', {}).values()]:
            if not isinstance(binding, dict) or set(binding) - {'family', 'localSetup'} or binding.get('family') not in families:
                raise ValueError('Task must select a family without overriding its image')
            validate_local_setup(binding.get('localSetup'))

def task_image_binding(manifest, task_id):
    binding = manifest['tasks'][task_id]
    if not hierarchical(manifest): return binding
    def expand(value):
        return {**manifest['families'][value['family']], **value}
    return {'agent': expand(binding['agent']), 'graders': {key: expand(value) for key, value in binding.get('graders', {}).items()}}

def harness_preparation_payload(request, harness_id):
    definition = request['environmentManifest']['harnesses'][harness_id]
    ref = definition.get('setupRef')
    if ref is None: return None
    digest = ref['digest']['value']
    source = request.get('preparationScripts', {}).get(digest)
    if source is None: raise ValueError('Missing resolved harness preparation script')
    payload = Path(source).read_bytes()
    if hashlib.sha256(payload).hexdigest() != digest: raise ValueError('Harness preparation script digest changed')
    return ref, payload

async def prepare_harness(machine, request, harness_id, evidence, workdir, owner=None, save_owner=None, stop=None):
    resolved = harness_preparation_payload(request, harness_id)
    if resolved is None: return
    ref, payload = resolved
    remote = '/var/tmp/ebo-harness-setup-' + ref['digest']['value'] + '.sh'
    await machine.write_file(remote, payload, mode=0o600)
    try:
        result = await run_preparation_command(machine, request['environmentManifest'], ['sh', '-eu', remote], evidence,
            workdir=workdir, owner=owner, save_owner=save_owner, stop=stop)
        json_write(evidence, {'harnessId': harness_id, 'setupRef': ref, 'exitCode': result.exit_code,
            'stdout': result.stdout, 'stderr': result.stderr})
        if result.exit_code: raise RuntimeError('Harness preparation failed; inspect ' + str(evidence))
    finally:
        result = await machine.exec(['rm', '-f', remote])
        if result.exit_code: raise RuntimeError('Cannot remove harness preparation script')

async def verify_prepared_machine(machine, manifest, worker):
    if manifest.get('target') == 'cloud':
        info = await machine.info()
        arch = info.get('arch')
        if arch is not None and arch != manifest['platform'].split('/')[1]:
            raise ValueError('Cloud placement architecture differs from the frozen image family: ' + str(arch))
    architecture = await machine.exec(['uname', '-m'])
    expected = 'aarch64' if manifest['platform'] == 'linux/arm64' else 'x86_64'
    if architecture.exit_code or architecture.stdout.strip() != expected:
        raise ValueError('Machine architecture differs from the frozen platform')
    if worker:
        marker = await machine.read_file('/opt/ebo/runtime.sha256')
        if marker.decode().strip() != manifest['runtimeArchiveDigest']:
            raise ValueError('Prepared image has the wrong /opt/ebo runtime pack')

async def plan_preparation(request, work):
    manifest = request['environmentManifest']
    plans, seen, families = [], set(), {}
    for task in request['tasks']:
        harness_id = task.get('harnessId')
        if hierarchical(manifest) and harness_id not in manifest['harnesses']:
            raise ValueError('Queue harness has no hierarchy preparation binding')
        if hierarchical(manifest): harness_preparation_payload(request, harness_id)
        target = work / task['id'] / fingerprint(harness_id)[:16]
        target.parent.mkdir(parents=True, exist_ok=True)
        images = task_image_binding(manifest, task['id'])
        derive_task(task['path'], target, images, task['verified'])
        trial_request = {**request, 'taskPath': str(target), 'attemptId': 'prepare-' + fingerprint([task['id'], harness_id])[:24],
            'taskSourceId': task['id'], 'harnessId': harness_id, 'verified': task['verified'], 'trialsDir': str(work / 'trials')}
        trial = await create_trial(trial_request, prepare=True)
        async for env, binding in preparation_environments(trial, images):
            identity = env_identity(env)
            key = fingerprint(identity)
            if key in seen: continue
            seen.add(key)
            family_id = binding.get('family') if hierarchical(manifest) else None
            if family_id is not None:
                if identity['role'] == 'agent' and family_id not in manifest['harnesses'][harness_id]['families']:
                    raise ValueError('Harness does not support the selected image family')
                spec = {'resources': asdict(env._resource_spec()), 'network': identity['network']}
                previous = families.get(family_id)
                if previous is not None and previous['spec'] != spec:
                    raise ValueError('Family has incompatible resources or network policies; declare separate compatible families')
                families.setdefault(family_id, {'spec': spec, 'env': env, 'worker': False})
                families[family_id]['worker'] |= identity['role'] == 'agent'
            plans.append({'env': env, 'binding': binding, 'identity': identity, 'key': key, 'harnessId': harness_id, 'family': family_id})
    return plans, families

async def prepare_owned_parents(request, work, receipt, machines, stop):
    manifest = request['environmentManifest']
    plans, families = await plan_preparation(request, work)
    root, session = Path(request['ownerRoot']), receipt['ownerSession']
    def save(): json_write(root / 'receipt.json', receipt)
    # A Cloud node may pull the image cold before the guest answers.
    ready_timeout = 600 if manifest.get('target') == 'cloud' else 90
    async def allocate(name, role, image, spec, source=None, startup=None):
        intent = {'machineName': name, 'role': role, 'state': 'submitting', 'source': await machine_identity(source, manifest) if source else None}
        receipt.setdefault('allocationIntents', []).append(intent)
        save()
        if source is None:
            machine = await AsyncMachine.create(MachineConfig(name=name, image=image, branchable=True,
                persistent=True, resources=spec, workdir='/', ready_timeout_seconds=ready_timeout, **(startup or {})), connection_options(manifest))
        else:
            machine = await source.branch(name, branchable=True)
        machines.append(machine)
        machine_id = await machine_identity(machine, manifest)
        intent.update(state='accepted', machine=machine_id)
        receipt.setdefault('allocatedMachines', []).append(machine_id)
        save()
        return machine
    async def reuse(binding, worker):
        machine = await AsyncMachine.connect(binding['machine'], connection_options(manifest))
        state = await machine.state()
        if state not in {'running', 'started'} or not await machine.ready():
            raise ValueError('Prepared machine is not warm and ready; no cold fallback')
        if await boot_identity(machine) != binding['bootId']:
            raise ValueError('Prepared machine restarted; cannot resume its warm lineage')
        await verify_prepared_machine(machine, manifest, worker)
        machines.append(machine)
        return machine
    metas = {}
    # All bindings are validated before the first allocation.
    for family_id, plan in families.items():
        if stop.is_set(): raise RuntimeError('Preparation interrupted')
        family = manifest['families'][family_id]
        if family_id in receipt.get('metaParents', {}):
            metas[family_id] = await reuse(receipt['metaParents'][family_id], plan['worker'])
            continue
        name = 'ebo-meta-' + session[:8] + '-' + fingerprint(family_id)[:10]
        machine = await allocate(name, 'meta-parent', family['image'], plan['env']._resource_spec())
        await verify_prepared_machine(machine, manifest, False)
        metas[family_id] = machine
        receipt.setdefault('metaParents', {})[family_id] = {'machine': await machine_identity(machine, manifest), 'image': family['image'],
            'spec': plan['spec'], 'bootId': await boot_identity(machine), 'familyDigest': fingerprint(family)}
        save()
    for plan in plans:
        if stop.is_set(): raise RuntimeError('Preparation interrupted')
        env, binding, identity, key = (plan[k] for k in ('env', 'binding', 'identity', 'key'))
        if key in receipt['parents']:
            await reuse(receipt['parents'][key], identity['role'] == 'agent')
            continue
        start = time.monotonic()
        source = metas.get(plan['family'])
        name = 'ebo-parent-' + session[:8] + '-' + key[:10]
        # Boot a task-free image, then prepare private files in the owned parent.
        startup = {'command': ['sleep', 'infinity'], 'wait_for_ports': False} if binding.get('parentStartup') == 'idle' else None
        machine = await allocate(name, 'harness-parent' if identity['role'] == 'agent' else 'grader-parent',
            binding['image'], env._resource_spec(), source, startup)
        await verify_prepared_machine(machine, manifest, False)
        result = await machine.exec(['mkdir', '-p', env.task_env_config.workdir], ExecOptions(user=local_setup_user(binding)))
        if result.exit_code: raise RuntimeError('Cannot create task workdir')
        harness_evidence = work / (key + '-harness.json')
        if hierarchical(manifest) and identity['role'] == 'agent':
            await prepare_harness(machine, request, plan['harnessId'], harness_evidence, env.task_env_config.workdir, receipt, save, stop)
        setup_evidence = work / (key + '-setup.json')
        await prepare_local_context(env, machine, binding, setup_evidence,
            None if request.get('budgetMs') is None else request['budgetMs'] / 1000, manifest, receipt, save, stop)
        # The worker pack can come from the image or from this parent's setup; check it once both have run.
        await verify_prepared_machine(machine, manifest, identity['role'] == 'agent')
        checkpoint = {'machine': await machine_identity(machine, manifest), 'resources': {
            'cpus': env._effective_cpus, 'memory_mb': env._effective_memory_mb,
            'storage_mb': env._effective_storage_mb, 'gpus': env._effective_gpus},
            'network_mode': env.network_policy.network_mode.value, 'allowed_hosts': list(env.network_policy.allowed_hosts)}
        checkpoint['resources'] = {k: v for k, v in checkpoint['resources'].items() if v is not None}
        receipt['parents'][key] = {'machine': await machine_identity(machine, manifest), 'checkpoint': checkpoint,
            'bootId': await boot_identity(machine), 'identity': identity, 'family': plan['family'],
            'metaParent': await machine_identity(source, manifest) if source else None,
            'harnessPreparation': json.loads(harness_evidence.read_text()) if harness_evidence.exists() else None,
            'localSetup': json.loads(setup_evidence.read_text()) if setup_evidence.exists() else None,
            'preparationSeconds': time.monotonic()-start}
        save()
`;
