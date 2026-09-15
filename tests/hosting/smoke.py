#!/usr/bin/env python3
"""Exercise the documented installer, systemd services, trusted HTTPS, and offline recovery."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

SOURCE = Path(__file__).resolve().parents[2]
BUILD = SOURCE.parent / 'build'


def run(*args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, text=True, **kwargs)


def output(*args):
    return subprocess.check_output([str(arg) for arg in args], text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-network', choices=['host'])
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run with sudo on a systemd host with Podman installed.')
    addresses = json.loads(output('ip', '-j', '-4', 'address', 'show', 'scope', 'global'))
    address = next(info['local'] for interface in addresses for info in interface['addr_info']
                   if ipaddress.IPv4Address(info['local']).is_private and interface['ifname'] not in ['podman0'])
    with socket.socket() as probe:
        probe.bind((address, 0))
        port = probe.getsockname()[1]
    name = 'stow-home-check-' + uuid.uuid4().hex[:10]
    (BUILD / 'tmp').mkdir(parents=True, exist_ok=True)
    temporary = tempfile.TemporaryDirectory(prefix='home-hosting-', dir=BUILD / 'tmp')
    workspace = Path(temporary.name)
    checkout = workspace / 'stow-git'
    state = workspace / 'state'
    log_dir = BUILD / 'logs/home-hosting'
    log_dir.mkdir(parents=True, exist_ok=True)
    shutil.copytree(SOURCE, checkout, ignore=shutil.ignore_patterns('.git', '__pycache__'))
    password = secrets.token_urlsafe(24) + ' $ " # with spaces'
    password_file = workspace / 'password'
    password_file.write_text(password)
    password_file.chmod(0o600)
    command = [str(checkout / 'self-host.py'), '--name', name, '--state-dir', str(state)]
    if args.build_network:
        command += ['--build-network', args.build_network]
    services = [name + '-https.service', name + '-app.service', name + '-network.service']
    browser_image = 'localhost/stow-home-browser:check'
    profile = workspace / 'browser-profile'
    profile.mkdir()
    trust = None
    origin = f'https://{address}:{port}'

    def request(path, *, context, body=None):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
        req = urllib.request.Request(origin + path, data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Origin': origin, 'Content-Type': 'application/json'})
        return opener.open(req, timeout=10)

    def browser(phase):
        env = {**os.environ, 'STOW_TEST_PASSWORD': password}
        with (log_dir / f'browser-{phase}.log').open('w') as log:
            run('podman', 'run', '--rm', '--network', 'bridge', '--name', name + '-browser',
                '--env', 'STOW_TEST_PASSWORD', '--env', 'STOW_TEST_ORIGIN=' + origin,
                '--env', 'STOW_TEST_PHASE=' + phase,
                '--volume', str(state / 'stow-ca.crt') + ':/stow-ca.crt:ro,Z',
                '--volume', str(profile) + ':/profile:Z',
                '--volume', str(BUILD / 'node_modules/playwright-core') + ':/node_modules/playwright-core:ro',
                browser_image, env=env, stdout=log, stderr=subprocess.STDOUT)
        print(f'Trusted HTTPS browser {phase} passed.', flush=True)

    try:
        print(f'Installing from a fresh source copy at {origin}.', flush=True)
        with (log_dir / 'install.log').open('w') as log:
            run(*command, '--address', address, '--port', str(port), '--password-file', password_file,
                stdout=log, stderr=subprocess.STDOUT)
        ca = state / 'stow-ca.crt'
        trust = ssl.create_default_context(cafile=str(ca))
        try:
            request('/api/health', context=ssl.create_default_context())
        except urllib.error.URLError as error:
            assert isinstance(error.reason, ssl.SSLCertVerificationError), error
        else:
            raise AssertionError('A fresh client unexpectedly trusted the private CA')
        with request('/api/health', context=trust) as response:
            assert json.load(response)['ok'] is True
        try:
            request('/api/login', context=trust, body={'password': 'wrong-password'})
        except urllib.error.HTTPError as error:
            assert error.code in [401, 403]
        else:
            raise AssertionError('Wrong password was accepted')
        with request('/api/login', context=trust, body={'password': password}) as response:
            cookie = response.headers['Set-Cookie']
            assert 'Secure' in cookie and 'HttpOnly' in cookie
        for service in services[:2]:
            assert (Path('/run/systemd/generator/multi-user.target.wants') / service).is_symlink(), f'{service} would not start at boot'
        assert output('podman', 'port', name + '-app') == '', 'Backend HTTP port must not be published'
        assert output('podman', 'port', name + '-https') == f'443/tcp -> {address}:{port}'
        build = ['podman', 'build', '--format', 'oci', '--tag', browser_image, '--file', 'tests/hosting/Containerfile']
        if args.build_network:
            build += ['--network', args.build_network]
        with (log_dir / 'browser-build.log').open('w') as log:
            run(*build, '.', cwd=checkout, stdout=log, stderr=subprocess.STDOUT)
        browser('seed')
        retained = ['stow.env', 'notes/session-secret', 'tls/caddy/pki/authorities/local/root.crt', 'tls/caddy/pki/authorities/local/root.key']
        fingerprints = {path: hashlib.sha256((state / path).read_bytes()).digest() for path in retained}
        with (log_dir / 'update.log').open('w') as log:
            run(*command, stdout=log, stderr=subprocess.STDOUT)
        assert fingerprints == {path: hashlib.sha256((state / path).read_bytes()).digest() for path in retained}, 'Update changed credentials or identity'
        browser('recover')
        run('systemctl', 'stop', *services[:2])
        # Follow the documented full-directory backup, then restore it into an
        # empty location. Keep the original fixture until all checks finish.
        backup = workspace / 'stow-home-backup.tgz'
        backup.touch(mode=0o600)
        run('tar', '-C', state.parent, '-czf', backup, state.name)
        state.rename(workspace / 'before-restore')
        run('tar', '-C', state.parent, '-xzf', backup)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'start', name + '-https.service')
        for attempt in range(100):
            try:
                with request('/api/health', context=trust) as response:
                    assert json.load(response)['ok'] is True
                break
            except urllib.error.URLError:
                time.sleep(0.2)
        else:
            raise AssertionError('Services did not recover after being stopped and started')
        assert fingerprints == {path: hashlib.sha256((state / path).read_bytes()).digest() for path in retained}
        browser('recover')
        # An application crash must restart it without leaving its HTTPS proxy
        # permanently stopped by a systemd dependency.
        previous_container = output('podman', 'inspect', '--format', '{{.Id}}', name + '-app')
        run('podman', 'kill', '--signal', 'KILL', name + '-app', stdout=subprocess.DEVNULL)
        for attempt in range(150):
            try:
                with request('/api/health', context=trust) as response:
                    assert json.load(response)['ok'] is True
                assert output('podman', 'inspect', '--format', '{{.Id}}', name + '-app') != previous_container
                break
            except (urllib.error.URLError, subprocess.CalledProcessError):
                time.sleep(0.2)
        else:
            raise AssertionError('HTTPS did not recover after an application crash')
        print('Home hosting passed: fresh install, password rejection, trusted TLS, Secure cookies, WebSocket sync, offline startup, update, backup/restore, service restart, and crash recovery.', flush=True)
    finally:
        with (log_dir / 'services.log').open('w') as log:
            subprocess.run(['journalctl', '--no-pager', '-u', services[0], '-u', services[1]], stdout=log, stderr=subprocess.STDOUT)
        subprocess.run(['systemctl', 'stop', *services], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for suffix in ['-browser', '-https', '-app']:
            subprocess.run(['podman', 'rm', '--force', name + suffix], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for suffix in ['.network', '-app.container', '-https.container']:
            target = Path('/etc/containers/systemd') / (name + suffix)
            if target.exists():
                assert target.read_text().startswith(f'# Managed by Stow self-host.py; state={state}\n')
                target.unlink()
        run('systemctl', 'daemon-reload')
        subprocess.run(['systemctl', 'reset-failed', *services], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['podman', 'network', 'rm', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        temporary.cleanup()
        print(f'Home hosting test logs: {log_dir}', flush=True)


if __name__ == '__main__':
    main()
