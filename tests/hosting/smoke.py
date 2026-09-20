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
from keep_import import check_import

SOURCE = Path(__file__).resolve().parents[2]
BUILD = SOURCE.parent / 'build'


def run(*args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, text=True, **kwargs)


def output(*args):
    return subprocess.check_output([str(arg) for arg in args], text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['home', 'proxy-loopback', 'proxy-lan'], default='home')
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
    proxy = args.mode != 'home'
    bind = '127.0.0.1' if args.mode == 'proxy-loopback' else address
    with socket.socket() as probe:
        probe.bind((bind, 0))
        backend_port = probe.getsockname()[1]
    name = 'stow-host-check-' + uuid.uuid4().hex[:10]
    (BUILD / 'tmp').mkdir(parents=True, exist_ok=True)
    temporary = tempfile.TemporaryDirectory(prefix='hosting-', dir=BUILD / 'tmp')
    workspace = Path(temporary.name)
    checkout = workspace / 'stow-git'
    state = workspace / 'state'
    log_dir = BUILD / 'logs' / ('hosting-' + args.mode)
    log_dir.mkdir(parents=True, exist_ok=True)
    shutil.copytree(SOURCE, checkout, ignore=shutil.ignore_patterns('.git', '__pycache__'))
    password = secrets.token_urlsafe(24) + ' $ " # with spaces'
    password_file = workspace / 'password'
    password_file.write_text(password)
    password_file.chmod(0o600)
    command = [str(checkout / 'self-host.py'), '--name', name, '--state-dir', str(state)]
    if args.build_network:
        command += ['--build-network', args.build_network]
    services = [name + '-app.service'] if proxy else [name + '-https.service', name + '-app.service']
    cleanup_services = services + ([] if proxy else [name + '-network.service'])
    browser_image = 'localhost/stow-home-browser:check'
    profile = workspace / 'browser-profile'
    profile.mkdir()
    trust = None
    origin = f'https://stow.example.test:{port}' if proxy else f'https://{address}:{port}'
    endpoint = f'https://{address}:{port}'
    ca = workspace / 'proxy/root.crt' if proxy else state / 'stow-ca.crt'

    def request(path, *, context, body=None, headers=None, method=None):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
        data = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(endpoint + path, data=data, method=method,
                                     headers={'Host': origin.removeprefix('https://'), 'Origin': origin,
                                              'Content-Type': 'application/json', **(headers or {})})
        return opener.open(req, timeout=10)

    def start_proxy():
        fixture = ca.parent
        fixture.mkdir()
        with (log_dir / 'proxy-setup.log').open('w') as log:
            run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
                '-subj', '/CN=Stow hosting test CA', '-keyout', fixture / 'root.key', '-out', ca,
                stdout=log, stderr=subprocess.STDOUT)
            run('openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=stow.example.test',
                '-keyout', fixture / 'server.key', '-out', fixture / 'server.csr', stdout=log, stderr=subprocess.STDOUT)
            (fixture / 'extensions').write_text(f'subjectAltName=DNS:stow.example.test,IP:{address}\nextendedKeyUsage=serverAuth\n')
            run('openssl', 'x509', '-req', '-in', fixture / 'server.csr', '-CA', ca, '-CAkey', fixture / 'root.key',
                '-CAcreateserial', '-days', '2', '-extfile', fixture / 'extensions', '-out', fixture / 'server.crt',
                stdout=log, stderr=subprocess.STDOUT)
            listen = f'{address}:{port}' if args.mode == 'proxy-loopback' else '443'
            (fixture / 'nginx.conf').write_text('events {}\nhttp { server {\n'
                f'listen {listen} ssl;\nserver_name stow.example.test;\n'
                'ssl_certificate /fixture/server.crt;\nssl_certificate_key /fixture/server.key;\n'
                + (state / 'nginx-location.conf').read_text() + '\n} }\n')
            network = ['--network', 'host'] if args.mode == 'proxy-loopback' else ['--network', 'bridge', '--publish', f'{address}:{port}:443']
            run('podman', 'run', '--detach', '--name', name + '-proxy', *network,
                '--volume', str(fixture) + ':/fixture:ro,Z', 'docker.io/library/nginx:stable-bookworm',
                'nginx', '-c', '/fixture/nginx.conf', '-g', 'daemon off;', stdout=log, stderr=subprocess.STDOUT)

    def wait_ready():
        for attempt in range(150):
            try:
                with request('/api/health', context=trust) as response:
                    assert json.load(response)['ok'] is True
                return
            except urllib.error.URLError:
                time.sleep(0.2)
        raise AssertionError('HTTPS did not become ready')

    def browser(phase, label=None):
        env = {**os.environ, 'STOW_TEST_PASSWORD': password}
        with (log_dir / f'browser-{label or phase}.log').open('w') as log:
            run('podman', 'run', '--rm', '--network', 'bridge', '--name', name + '-browser',
                '--env', 'STOW_TEST_PASSWORD', '--env', 'STOW_TEST_ORIGIN=' + origin,
                '--env', 'STOW_TEST_PHASE=' + phase,
                '--add-host', 'stow.example.test:' + address,
                '--volume', str(ca) + ':/stow-ca.crt:ro,z',
                '--volume', str(profile) + ':/profile:Z',
                '--volume', str(BUILD / 'node_modules/playwright-core') + ':/node_modules/playwright-core:ro',
                browser_image, env=env, stdout=log, stderr=subprocess.STDOUT)
        print(f'Trusted HTTPS browser {phase} passed.', flush=True)

    try:
        print(f'Installing from a fresh source copy at {origin}.', flush=True)
        options = ['--behind-proxy', origin] if proxy else []
        with (log_dir / 'install.log').open('w') as log:
            run(*command, *options, '--address', bind, '--port', str(backend_port if proxy else port), '--password-file', password_file,
                stdout=log, stderr=subprocess.STDOUT)
        if proxy:
            # Installation must succeed before DNS, certificates, or nginx exist.
            assert json.loads((state / 'settings.json').read_text())['installed']
            assert not (state / 'tls').exists() and not (state / 'stow-ca.crt').exists()
            assert not (Path('/etc/containers/systemd') / (name + '-https.container')).exists()
            assert output('podman', 'port', name + '-app') == f'3001/tcp -> {bind}:{backend_port}'
            start_proxy()
        else:
            assert output('podman', 'port', name + '-app') == '', 'Backend HTTP port must not be published'
            assert output('podman', 'port', name + '-https') == f'443/tcp -> {address}:{port}'
        trust = ssl.create_default_context(cafile=str(ca))
        wait_ready()
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
            vault = json.load(response)['vaultId']
        # nginx's default 1 MiB request limit would silently break normal image uploads.
        blob = secrets.token_bytes(2 * 1024 * 1024)
        blob_path = '/api/blobs/' + hashlib.sha256(blob).hexdigest()
        authenticated = {'Cookie': cookie.split(';')[0], 'X-Stow-Vault': vault, 'Content-Type': 'application/octet-stream'}
        for headers, status in [({'X-Stow-Vault': vault}, 401), ({**authenticated, 'Origin': 'https://wrong.example.test'}, 403)]:
            try:
                request(blob_path, context=trust, headers=headers)
            except urllib.error.HTTPError as error:
                assert error.code == status, error
            else:
                raise AssertionError('Unauthenticated or cross-origin blob request was accepted')
        with request(blob_path, context=trust, body=blob, headers=authenticated, method='PUT') as response:
            assert response.status == 204
        with request(blob_path, context=trust, headers=authenticated) as response:
            assert response.read() == blob
        for service in services:
            assert (Path('/run/systemd/generator/multi-user.target.wants') / service).is_symlink(), f'{service} would not start at boot'
        build = ['podman', 'build', '--format', 'oci', '--tag', browser_image, '--file', 'tests/hosting/Containerfile']
        if args.build_network:
            build += ['--network', args.build_network]
        with (log_dir / 'browser-build.log').open('w') as log:
            run(*build, '.', cwd=checkout, stdout=log, stderr=subprocess.STDOUT)
        browser('seed')
        check_import(checkout, state, log_dir, args.mode, args.build_network, request, trust, authenticated, vault)
        retained = ['stow.env', 'notes/session-secret']
        if not proxy:
            retained += ['tls/caddy/pki/authorities/local/root.crt', 'tls/caddy/pki/authorities/local/root.key']
        fingerprints = {path: hashlib.sha256((state / path).read_bytes()).digest() for path in retained}
        with (log_dir / 'update.log').open('w') as log:
            run(*command, stdout=log, stderr=subprocess.STDOUT)
        assert fingerprints == {path: hashlib.sha256((state / path).read_bytes()).digest() for path in retained}, 'Update changed credentials or identity'
        browser('recover', 'after-update')
        run('systemctl', 'stop', *services)
        # Follow the documented full-directory backup, then restore it into an
        # empty location. Keep the original fixture until all checks finish.
        backup = workspace / 'stow-backup.tgz'
        backup.touch(mode=0o600)
        run('tar', '-C', state.parent, '-czf', backup, state.name)
        state.rename(workspace / 'before-restore')
        run('tar', '-C', state.parent, '-xzf', backup)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'start', services[0])
        wait_ready()
        assert fingerprints == {path: hashlib.sha256((state / path).read_bytes()).digest() for path in retained}
        browser('recover', 'after-restore')
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
        print(f'{args.mode} hosting passed: fresh install, password/origin rejection, trusted TLS, Secure cookies, large uploads, WebSocket sync, offline startup, update, backup/restore, service restart, and crash recovery.', flush=True)
    finally:
        with (log_dir / 'services.log').open('w') as log:
            subprocess.run(['journalctl', '--no-pager', *[arg for service in services for arg in ['-u', service]]], stdout=log, stderr=subprocess.STDOUT)
        if proxy:
            with (log_dir / 'proxy.log').open('w') as log:
                subprocess.run(['podman', 'logs', name + '-proxy'], stdout=log, stderr=subprocess.STDOUT)
        subprocess.run(['systemctl', 'stop', *cleanup_services], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for suffix in ['-browser', '-proxy', '-https', '-app']:
            subprocess.run(['podman', 'rm', '--force', name + suffix], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for suffix in ['.network', '-app.container', '-https.container']:
            target = Path('/etc/containers/systemd') / (name + suffix)
            if target.exists():
                assert target.read_text().startswith(f'# Managed by Stow self-host.py; state={state}\n')
                target.unlink()
        run('systemctl', 'daemon-reload')
        subprocess.run(['systemctl', 'reset-failed', *cleanup_services], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['podman', 'network', 'rm', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        temporary.cleanup()
        print(f'Hosting test logs: {log_dir}', flush=True)


if __name__ == '__main__':
    main()
