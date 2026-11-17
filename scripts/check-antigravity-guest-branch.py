"""Verify native Google-account authentication in two independent Harbor branches.

Run after antigravity-guest-auth.py has prepared its private parent and Google
sign-in has completed. The Node/Linux worker pack must be installed in /opt/ebo.
This script reads no authentication secrets and downloads only attempt evidence.
"""
import argparse
import asyncio
import importlib.metadata
import json
import os
import re
import shlex
import uuid
from pathlib import Path

from smol import Machine, ConnectOptions, ExecOptions
from harbor.environments.smol import SmolEnvironment, _checkpoint
from harbor.models.task.config import EnvironmentConfig, NetworkMode, NetworkPolicy
from harbor.models.trial.paths import TrialPaths

GUEST_ENV = {
    'HOME': '/root',
    'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/ebo-antigravity/bus',
    'XDG_RUNTIME_DIR': '/run/ebo-antigravity',
    'AGY_CLI_DISABLE_AUTO_UPDATE': 'true',
}


def require_versions():
    for name, version in {'smolmachines': '1.35.0', 'harbor': '0.26.0'}.items():
        if importlib.metadata.version(name) != version:
            raise ValueError(f'Requires {name}=={version}')


async def borrower(parent, image, model, root, label, guest_env):
    attempt = root/label
    attempt.mkdir(mode=0o700)
    context = attempt/'environment'
    context.mkdir()
    paths = TrialPaths(attempt/'trial')
    paths.mkdir()
    env = SmolEnvironment(
        environment_dir=context, environment_name='ebo-agy-branch-proof',
        session_id=label, trial_paths=paths,
        task_env_config=EnvironmentConfig(docker_image=image, cpus=2, memory_mb=2048,
                                        storage_mb=8192, workdir='/workspace'),
        network_policy=NetworkPolicy(network_mode=NetworkMode.PUBLIC),
        target='local', auto_checkpoint=False, fork_batch_window_ms=0,
    )
    env._checkpoints[env.environment_id] = _checkpoint({
        'machine': parent, 'resources': {'cpus': 2, 'memory_mb': 2048, 'storage_mb': 8192},
        'network_mode': 'public',
    })
    started = False
    result = None
    try:
        await env.start(force_build=False)
        started = True
        readiness = await env.exec(
            'test -S "$XDG_RUNTIME_DIR/bus" && '
            'test "$(secret-tool lookup ebo branch-proof)" = "$(cat "$XDG_RUNTIME_DIR/sentinel")" && '
            'test ! -e /workspace/capture-proof.txt', env=guest_env,
        )
        if readiness.return_code:
            raise RuntimeError('Branched keyring or fresh-workspace check failed')
        result = await env.exec(
            '/opt/ebo/node /opt/ebo/scripts/antigravity-guest-smoke.mjs '+shlex.quote(model),
            env={**guest_env, 'EBO_AUTH_IMAGE': image, 'TMPDIR': '/var/tmp'},
        )
        (attempt/'worker-stdio.json').write_text(json.dumps({
            'returnCode': result.return_code, 'stdout': result.stdout, 'stderr': result.stderr,
        }, indent=2))
        # Retain failed native attempts before deleting the child.
        exists = await env.exec('test -d /var/tmp/ebo-agy-branch-proof')
        if exists.return_code == 0:
            await env.download_dir('/var/tmp/ebo-agy-branch-proof', attempt/'evidence')
        if result.return_code:
            raise RuntimeError(f'{label}: native worker failed; inspect private retained evidence')
        # The provider may wrap a downloaded directory; find exactly one summary.
        summaries = list((attempt/'evidence').rglob('summary.json'))
        if len(summaries) != 1:
            raise RuntimeError('Expected one native worker summary')
        summary = json.loads(summaries[0].read_text())
        if summary.get('status') != 'passed' or not summary.get('nativeSessionId'):
            raise RuntimeError('Native worker did not qualify its proof')
        receipt = {'branch': env._machine.name, 'parent': parent, **summary}
        (attempt/'receipt.json').write_text(json.dumps(receipt, indent=2))
        print(json.dumps({'branch': label, 'status': 'passed', 'normalizedEvents': summary['normalizedEvents']}), flush=True)
        return receipt
    finally:
        # start() can fail after allocating a machine; Harbor owns its cleanup.
        await env.stop(delete=True)
        (attempt/'cleanup.json').write_text(json.dumps({'deleted': True, 'started': started}))


async def verify(state_root, model, login_confirmed=False):
    require_versions()
    state = json.loads((state_root/'state.json').read_text())
    if not re.fullmatch(r'ebo-agy-auth-[a-f0-9]{10}', state['machine']):
        raise ValueError('Select a parent owned by the Antigravity guest preparation tool')
    if state['phase'] not in {'awaiting-google-sign-in', 'login-returned'}:
        raise ValueError('Guest parent is not ready for authentication verification')
    if state.get('authentication', 'oauth-personal') != 'oauth-personal' or state.get('gcpProject'):
        raise ValueError('Guest verification requires a personal OAuth parent')
    if not login_confirmed and not (state_root/'login-finished').exists():
        raise ValueError('Complete Google sign-in and exit the guest CLI first')
    parent = Machine.connect(state['machine'], ConnectOptions(target='local'))
    home = state.get('accountHome', '/root')
    runtime = state.get('runtimeDirectory', '/run/ebo-antigravity')
    if not re.fullmatch(r'/root(?:/[A-Za-z0-9_-]+)*', home) or not re.fullmatch(r'/run/ebo-antigravity(?:-[a-z0-9-]+)?', runtime):
        raise ValueError('Invalid guest authentication profile')
    guest_env = {**GUEST_ENV, 'HOME': home, 'XDG_RUNTIME_DIR': runtime,
                 'DBUS_SESSION_BUS_ADDRESS': 'unix:path='+runtime+'/bus'}
    history = state_root/'branch-verifications'
    history.mkdir(mode=0o700, exist_ok=True)
    run_root = history/uuid.uuid4().hex
    run_root.mkdir(mode=0o700)
    receipts = []
    for label in ['first', 'second']:
        receipts.append(await borrower(state['machine'], state['image'], model, run_root, label, guest_env))
    if receipts[0]['nativeSessionId'] == receipts[1]['nativeSessionId']:
        raise RuntimeError('Independent branches reused a native conversation')
    if receipts[0]['attemptId'] == receipts[1]['attemptId'] or receipts[0]['runId'] == receipts[1]['runId']:
        raise RuntimeError('Independent proofs reused an EBO attempt identity')
    result = parent.exec(['/bin/sh', '-ec',
        'test ! -e /workspace/capture-proof.txt; '
        'test "$(secret-tool lookup ebo branch-proof)" = "$(cat "$XDG_RUNTIME_DIR/sentinel")"'],
        ExecOptions(env=guest_env, timeout=10))
    if result.exit_code:
        raise RuntimeError('Parent isolation check failed')
    report = {'schemaVersion': 'ebo.antigravity-guest-branch-verification/v1',
              'status': 'passed', 'parent': state['machine'], 'image': state['image'],
              'model': model, 'harborVersion': '0.26.0', 'smolVersion': '1.35.0',
              'branches': receipts, 'parentWorkspaceUnchanged': True,
              'parentKeyringAvailable': True, 'childrenDeleted': True,
              'authentication': 'oauth-personal',
              'coldRestart': 'not-tested', 'expiredTokenRefresh': 'not-tested'}
    (run_root/'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({'status': 'passed', 'branches': 2, 'report': str(run_root/'report.json')}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-root', type=Path, required=True)
    parser.add_argument('--model', required=True, help='Native model slug available to the signed-in account')
    parser.add_argument('--login-confirmed', action='store_true', help='Operator confirmed sign-in and closed SSH, even if the interactive CLI returned a nonzero exit')
    args = parser.parse_args()
    os.umask(0o077)
    asyncio.run(verify(args.state_root.resolve(), args.model, args.login_confirmed))
