"""Prepare a private local Antigravity guest and verify warm keyring branching.

Use the checkout's pinned Harbor/Smol interpreter. The foreground process owns
its parent VM until interrupted. Google sign-in happens only in the generated
SSH terminal command; credentials remain in the guest keyring.
"""
import argparse
import hashlib
import importlib.metadata
import json
import os
import secrets
import signal
import subprocess
import time
import shlex
import re
from pathlib import Path
from smol import Machine, MachineConfig, ResourceSpec, ConnectOptions, ExecOptions, PortSpec

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--state-root', type=Path, required=True)
parser.add_argument('--study', type=Path, required=True, help='Study with an installed Linux ARM64 Antigravity runtime lock')
parser.add_argument('--image', required=True, help='Public Linux ARM64 Node 26.13.0 image pinned by digest')
parser.add_argument('--port', type=int, default=48723)
parser.add_argument('--account-home', default='/root')
parser.add_argument('--runtime-directory', default='/run/ebo-antigravity')
args = parser.parse_args()
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9./_-]*@sha256:[a-f0-9]{64}', args.image):
    parser.error('--image must use a SHA-256 digest')
if not 1024 <= args.port <= 65535:
    parser.error('--port must be between 1024 and 65535')
if not re.fullmatch(r'/root(?:/[A-Za-z0-9_-]+)*', args.account_home):
    parser.error('--account-home must be /root or a private directory beneath it')
if not re.fullmatch(r'/run/ebo-antigravity(?:-[a-z0-9-]+)?', args.runtime_directory):
    parser.error('--runtime-directory must be an Antigravity guest runtime directory')
checkout = Path(__file__).resolve().parent.parent
root = args.state_root.resolve()
os.umask(0o077)
root.mkdir(parents=True, exist_ok=True, mode=0o700)
if root.stat().st_mode & 0o077:
    parser.error('--state-root must be private (mode 0700)')
if (root/'state.json').exists():
    parser.error('Use a fresh state root; existing VM evidence is never replaced')
contract = json.loads((checkout/'contracts/antigravity-cli-1.5.9/manifest.json').read_text())
assert contract['runtimeVersion'] == '1.5.9'
assert re.fullmatch(r'https://github\.com/google-antigravity/antigravity-cli/releases/download/[A-Za-z0-9./_-]+', contract['linuxArm64']['url'])
assert re.fullmatch(r'[a-f0-9]{128}', contract['linuxArm64']['sha512'])
if not (checkout/'dist/src/harbor/worker.js').is_file():
    parser.error('Run npm run build with the pinned Node version first')
source_archive = root/'worker-source.tgz'
subprocess.run(['tar', '-czf', str(source_archive), 'package.json', 'package-lock.json',
                'dist/src', 'schemas', 'contracts', 'ontology', 'compatibility', 'verification', 'viewer/package.json'], cwd=checkout, check=True)
source_digest = hashlib.sha256(source_archive.read_bytes()).hexdigest()
for key, value in {'smolmachines': '1.35.0', 'harbor': '0.26.0'}.items():
    assert importlib.metadata.version(key) == value
study = args.study.resolve()
lock = json.loads((study/'runtimes/lock.json').read_text())
group = next(g for g in lock['groups'] if 'antigravity-cli' in g['roles'])
if group['plan']['platform'] != 'linux-arm64' or group['roots'][0]['selection']['release']['version'] != contract['runtimeVersion']:
    parser.error('--study must freeze the contract release for Linux ARM64')
study_archive = root/'study.tgz'
subprocess.run(['tar', '-czf', str(study_archive), 'runtimes/lock.json',
                'runtimes/cache/'+group['installation']['key']], cwd=study, check=True)
name = 'ebo-agy-auth-' + secrets.token_hex(5)
image = args.image
port = args.port
runtime_directory = args.runtime_directory
state = {'schemaVersion': 'ebo.antigravity-guest-auth/v1', 'ownerPid': os.getpid(), 'machine': name, 'image': image, 'port': port, 'phase': 'creating', 'workerSourceSha256': source_digest, 'runtimeLockDigest': lock['digest'], 'harborVersion': '0.26.0', 'smolVersion': '1.35.0',
         'accountHome': args.account_home, 'runtimeDirectory': runtime_directory,
         'authentication': 'oauth-personal'}
def record(phase, **fields):
    state.update(phase=phase, **fields)
    temporary = root/'state.tmp'
    temporary.write_text(json.dumps(state, indent=2))
    temporary.replace(root/'state.json')
    print(json.dumps({'phase': phase, **fields}), flush=True)

def run(machine, script, timeout=300):
    result = machine.exec(['/bin/sh', '-ec', script], ExecOptions(timeout=timeout))
    if result.exit_code:
        raise RuntimeError(f'Guest command failed ({result.exit_code}): {result.stderr[-2000:]}')
    return result.stdout

machine = None
def stop(*_):
    raise KeyboardInterrupt
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    record('creating', machine=name)
    machine = Machine.create(MachineConfig(name=name, image=image, branchable=True, persistent=True,
        resources=ResourceSpec(cpus=2, memory_mb=2048, storage_gb=8, network=True),
        ports=[PortSpec(host=port, guest=22)], wait_for_ports=False, workdir='/root'), ConnectOptions(target='local'))
    record('installing')
    run(machine, 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y --no-install-recommends dbus gnome-keyring libsecret-tools openssh-server ca-certificates curl git >/var/log/ebo-auth-install.log 2>&1', 600)
    pin = contract['linuxArm64']
    record('installing-agy')
    run(machine, 'mkdir -p /opt/ebo/bin /opt/ebo/study /run/sshd '+runtime_directory+' '+args.account_home+'; chmod 700 '+runtime_directory+' '+args.account_home+'; test "$(node --version)" = v26.13.0')
    machine.write_file('/opt/ebo/study.tgz', study_archive.read_bytes(), mode=0o600)
    executable = '/opt/ebo/study/runtimes/cache/'+group['installation']['key']+'/runtime/antigravity'
    run(machine, 'tar -xzf /opt/ebo/study.tgz -C /opt/ebo/study; rm /opt/ebo/study.tgz; ln -s '+executable+' /opt/ebo/bin/agy; test "$(AGY_CLI_DISABLE_AUTO_UPDATE=true /opt/ebo/bin/agy --version)" = '+contract['runtimeVersion'], 600)
    private = root/'ssh-key'
    if not private.exists():
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(private)], check=True)
    machine.write_file('/root/ebo-auth.pub', private.with_suffix('.pub').read_text(), mode=0o600)
    run(machine, 'mkdir -p /root/.ssh; chmod 700 /root/.ssh; mv /root/ebo-auth.pub /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys; ssh-keygen -A >/dev/null 2>&1; /usr/sbin/sshd -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o PermitRootLogin=prohibit-password -o AllowTcpForwarding=no -o X11Forwarding=no')
    record('starting-keyring')
    settings_dir = args.account_home+'/.gemini/antigravity-cli'
    run(machine, 'mkdir -p '+settings_dir)
    machine.write_file(settings_dir+'/settings.json', json.dumps({'auth': {'type': 'oauth-personal'}}), mode=0o600)
    env = f'export HOME={args.account_home} XDG_RUNTIME_DIR={runtime_directory} DBUS_SESSION_BUS_ADDRESS=unix:path={runtime_directory}/bus AGY_CLI_DISABLE_AUTO_UPDATE=true; '
    password = secrets.token_hex(32)
    machine.write_file(runtime_directory+'/unlock', password, mode=0o600)
    del password
    run(machine, env + 'dbus-daemon --session --fork --address="$DBUS_SESSION_BUS_ADDRESS" --print-pid >'+runtime_directory+'/dbus.pid; '
        'gnome-keyring-daemon --unlock --components=secrets --control-directory='+runtime_directory+'/keyring <'+runtime_directory+'/unlock >'+runtime_directory+'/keyring.env 2>'+runtime_directory+'/keyring.log; rm '+runtime_directory+'/unlock')
    sentinel = secrets.token_hex(24)
    machine.write_file(runtime_directory+'/sentinel', sentinel, mode=0o600)
    run(machine, env + 'secret-tool store --label="EBO branch authentication readiness" ebo branch-proof <'+runtime_directory+'/sentinel; test "$(secret-tool lookup ebo branch-proof)" = "$(cat '+runtime_directory+'/sentinel)"')
    record('keyring-ready')
    with machine.branch(name+'-keyring-check') as child:
        run(child, env + 'test "$(secret-tool lookup ebo branch-proof)" = "$(cat '+runtime_directory+'/sentinel)"; secret-tool clear ebo branch-proof; test -z "$(secret-tool lookup ebo branch-proof || true)"')
    run(machine, env + 'test "$(secret-tool lookup ebo branch-proof)" = "$(cat '+runtime_directory+'/sentinel)"')
    record('keyring-branch-passed')
    record('installing-linux-worker')
    machine.write_file('/opt/ebo/source.tgz', source_archive.read_bytes(), mode=0o600)
    run(machine, 'cd /opt/ebo; tar -xzf source.tgz; npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/var/log/ebo-runtime-install.log 2>&1; '
        'cp /usr/local/bin/node /opt/ebo/node; rm source.tgz; mkdir -p /opt/ebo/scripts /workspace', 600)
    for script in ['antigravity-guest-smoke.mjs', 'qualify-antigravity.mjs']:
        machine.write_file('/opt/ebo/scripts/'+script, (checkout/'scripts'/script).read_bytes(), mode=0o600)
    machine.write_file('/opt/ebo/bin/agy-login', '#!/bin/sh\nset -eu\n'+env+'\nexec /opt/ebo/bin/agy\n', mode=0o700)
    hostkey = run(machine, 'cat /etc/ssh/ssh_host_ed25519_key.pub').strip().split()
    (root/'known_hosts').write_text(f'[127.0.0.1]:{port} {hostkey[0]} {hostkey[1]}\n')
    login = root/'login.sh'
    ssh = ['ssh', '-t', '-i', str(private), '-p', str(port), '-o', 'IdentitiesOnly=yes',
           '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile='+str(root/'known_hosts'),
           'root@127.0.0.1', '/opt/ebo/bin/agy-login']
    login.write_text('#!/bin/sh\nset -eu\n'+shlex.join(ssh)+'\n'
        +'printf "%s\\n" "Guest CLI exited. Return to EBO for the branch test."\n'
        +'touch '+shlex.quote(str(root/'login-finished'))+'\n')
    login.chmod(0o700)
    record('awaiting-google-sign-in', loginCommand=str(login))
    while not (root/'login-finished').exists():
        if (root/'stop').exists(): raise KeyboardInterrupt
        time.sleep(1)
    record('login-returned')
    while True:
        if (root/'stop').exists(): break
        time.sleep(1)
except KeyboardInterrupt:
    record('stopping')
except BaseException as exc:
    record('failed', error=str(exc))
    raise
finally:
    if machine is not None:
        machine.delete()
        record('deleted')
