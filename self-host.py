#!/usr/bin/env python3
"""Install or update a password-protected Stow service on a home Linux server."""
import argparse
from contextlib import contextmanager
import fcntl
import getpass
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.request

SOURCE = Path(__file__).resolve().parent
UNIT_DIR = Path('/etc/containers/systemd')
CADDY_IMAGE = 'docker.io/library/caddy:2'
PRIVATE_NETWORKS = [ipaddress.IPv4Network(value) for value in ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']]


@contextmanager
def setup_lock(path=Path('/run/stow-self-host.lock')):
    if os.geteuid() != 0:
        raise ValueError('Run this command with sudo; it installs system services and persistent state.')
    with os.fdopen(os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Another Stow setup is running. Wait for it to finish before retrying.') from None
        yield


def run(*args, capture=False, **kwargs):
    result = subprocess.run([str(arg) for arg in args], check=True, text=True,
                            stdout=subprocess.PIPE if capture else None, **kwargs)
    return result.stdout.strip() if capture else None


def validate(address, port, name, state):
    ip = ipaddress.IPv4Address(address)
    if not any(ip in network for network in PRIVATE_NETWORKS):
        raise ValueError('Use the server’s private LAN IPv4 address (10.x, 172.16–31.x, or 192.168.x).')
    if not 1024 <= port <= 65535:
        raise ValueError('HTTPS port must be between 1024 and 65535.')
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', name):
        raise ValueError('Service name must use lowercase letters, digits, and hyphens; start with a letter.')
    if not state.is_absolute() or not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(state)):
        raise ValueError('State directory must be an absolute path without spaces or shell/systemd punctuation.')
    if state.resolve() != state:
        raise ValueError('State directory must not contain symlinks or parent-directory components.')
    for excluded in [SOURCE, SOURCE.parent / 'build']:
        if state.is_relative_to(excluded) or excluded.is_relative_to(state):
            raise ValueError('Persistent state must be separate from the source checkout and its build directory.')
    return str(ip)


def password_value(value):
    if not value or any(char in value for char in '\r\n\0'):
        raise ValueError('Choose a nonempty password without line breaks or NUL characters.')
    return value


def origin(settings):
    return f'https://{settings["address"]}:{settings["port"]}'


def atomic_write(path, content, mode=0o600):
    if path.is_symlink():
        raise ValueError(f'Refusing to replace a symlink: {path}')
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, 'w') as output:
            output.write(content)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def caddyfile(settings):
    return f'''{{
\tadmin off
\tauto_https disable_redirects
\tskip_install_trust
\tdefault_sni {settings['address']}
\tservers {{
\t\tprotocols h1 h2
\t}}
}}

https://{settings['address']} {{
\ttls internal
\treverse_proxy {settings['name']}-app:3001
}}
'''


def units(settings, state, image, caddy_image=CADDY_IMAGE):
    name = settings['name']
    marker = f'# Managed by Stow self-host.py; state={state}\n'
    common = '\n[Service]\nRestart=on-failure\nRestartSec=5\nTimeoutStartSec=120\n\n[Install]\nWantedBy=multi-user.target\n'
    return {
        f'{name}.network': marker + f'[Network]\nNetworkName={name}\n',
        f'{name}-app.container': marker + f'''[Unit]
Description=Stow notes
Wants=network-online.target
After=network-online.target

[Container]
Image={image}
ContainerName={name}-app
Network={name}.network
EnvironmentFile={state}/stow.env
Volume={state}/notes:/data:Z
HealthCmd=curl --fail --silent http://127.0.0.1:3001/api/health
HealthInterval=30s
HealthTimeout=3s
HealthStartPeriod=10s
''' + common,
        f'{name}-https.container': marker + f'''[Unit]
Description=Stow home HTTPS
Wants={name}-app.service
After={name}-app.service

[Container]
Image={caddy_image}
ContainerName={name}-https
Network={name}.network
PublishPort={settings['address']}:{settings['port']}:443/tcp
Volume={state}/Caddyfile:/etc/caddy/Caddyfile:ro,Z
Volume={state}/tls:/data:Z
Volume={state}/caddy-config:/config:Z
''' + common,
    }


def quadlet_generator():
    for path in ['/usr/lib/systemd/system-generators/podman-system-generator',
                 '/usr/libexec/podman/quadlet', '/usr/lib/podman/quadlet']:
        if Path(path).is_file():
            return path
    raise ValueError('Podman Quadlet is missing. Install Podman 4.9 or later on a systemd Linux host.')


def verify_units(rendered):
    with tempfile.TemporaryDirectory(prefix='stow-quadlet-') as directory:
        for name, content in rendered.items():
            (Path(directory) / name).write_text(content)
        output = run(quadlet_generator(), '--dryrun', capture=True,
                     env={**os.environ, 'QUADLET_UNIT_DIRS': directory}, stderr=subprocess.PIPE)
        for name in rendered:
            service = name.removesuffix('.container') + '.service' if name.endswith('.container') else name.removesuffix('.network') + '-network.service'
            if service not in output:
                raise ValueError(f'Podman could not generate {service}; check the installed Quadlet version.')


def preflight(address):
    if os.geteuid() != 0:
        raise ValueError('Run this command with sudo; it installs system services and persistent state.')
    with socket.socket() as probe:
        probe.bind((address, 0))
    quadlet_generator()
    if not Path('/run/systemd/system').is_dir():
        raise ValueError('This setup requires a running systemd system manager.')


def ready(settings, state, timeout=60):
    ca = state / 'tls/caddy/pki/authorities/local/root.crt'
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            context = ssl.create_default_context(cafile=str(ca))
            # A LAN address must be reached directly, even when the shell has a proxy configured.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
            with opener.open(origin(settings) + '/api/health', timeout=3) as response:
                if json.load(response).get('ok') is not True:
                    raise ValueError('Unexpected health response')
            with opener.open(origin(settings), timeout=3) as response:
                if '<title>Stow</title>' not in response.read().decode():
                    raise ValueError('Browser assets are missing')
            return ca
        except (OSError, ValueError) as error:
            last_error = error
            time.sleep(0.25)
    raise ValueError(f'HTTPS did not become ready at {origin(settings)}: {last_error}. Check sudo journalctl -u {settings["name"]}-app -u {settings["name"]}-https.')


def install(args):
    state = args.state_dir
    settings_path = state / 'settings.json'
    previous = json.loads(settings_path.read_text()) if settings_path.is_file() else None
    if previous and (previous.get('schema') != 1 or previous.get('name') != args.name):
        raise ValueError('This state directory belongs to a different installation.')
    if not previous and state.exists() and any(state.iterdir()):
        raise ValueError('Choose an empty state directory; existing files will not be adopted or overwritten.')
    address = args.address or (previous and previous['address'])
    if not address:
        if not sys.stdin.isatty():
            raise ValueError('Supply --address with the server’s reserved LAN IPv4 address.')
        address = input('Reserved LAN IPv4 address: ').strip()
    port = args.port if args.port is not None else (previous and previous['port']) or 8443
    address = validate(address, port, args.name, state)
    if previous and (address != previous['address'] or port != previous['port']):
        raise ValueError('Keep the existing address and port: changing origin creates a different browser vault cache.')
    settings = previous or {'schema': 1, 'name': args.name, 'address': address, 'port': port, 'installed': False}
    preflight(address)
    if previous:
        if args.password_file:
            raise ValueError('Password already configured. To change it, edit the existing stow.env and restart the app service.')
        if not (state / 'stow.env').is_file():
            raise ValueError('Existing password configuration is missing; restore it from your backup.')
        if previous['installed'] and not all((state / 'tls/caddy/pki/authorities/local' / leaf).is_file() for leaf in ['root.crt', 'root.key']):
            raise ValueError('The existing certificate authority is missing; restore its files instead of replacing device trust.')
        password = None
    elif args.password_file:
        password = password_value(args.password_file.read_text().removesuffix('\n'))
    else:
        if not sys.stdin.isatty():
            raise ValueError('Use an interactive terminal to choose the password, or supply --password-file.')
        password = password_value(getpass.getpass('Stow password: '))
        if password != getpass.getpass('Repeat password: '):
            raise ValueError('Passwords did not match.')

    rendered = units(settings, state, 'localhost/stow:' + args.name)
    for filename, content in rendered.items():
        target = UNIT_DIR / filename
        if target.exists() and (target.is_symlink() or not target.read_text().startswith(content.splitlines()[0] + '\n')):
            raise ValueError(f'Refusing to replace an unrelated service definition: {target}')
    verify_units(rendered)
    print('Building Stow and fetching Caddy; the existing service keeps running during the build.', flush=True)
    build = ['podman', 'build', '--format', 'oci', '--tag', 'localhost/stow:' + args.name, '--file', 'Containerfile']
    if args.build_network:
        build += ['--network', args.build_network]
    run(*build, '.', cwd=SOURCE)
    image = run('podman', 'image', 'inspect', 'localhost/stow:' + args.name, '--format', '{{.Id}}', capture=True)
    run('podman', 'pull', CADDY_IMAGE)
    caddy_image = run('podman', 'image', 'inspect', CADDY_IMAGE, '--format', '{{.Id}}', capture=True)
    rendered = units(settings, state, image, caddy_image)
    saved_units = {filename: (UNIT_DIR / filename).read_text() if (UNIT_DIR / filename).exists() else None for filename in rendered}
    saved_config = {filename: (state / filename).read_text() if (state / filename).exists() else None for filename in ['Caddyfile', 'settings.json']}
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    state.chmod(0o700)
    for directory in ['notes', 'tls', 'caddy-config']:
        target = state / directory
        if target.is_symlink():
            raise ValueError(f'Refusing a symlink for persistent state: {target}')
        if not target.exists():
            target.mkdir(mode=0o700)
            if directory == 'notes':
                os.chown(target, 1000, 1000)
    if password is not None:
        atomic_write(state / 'stow.env', f'STOW_AUTH_MODE=password\nSTOW_PASSWORD={password}\nSTOW_ORIGIN={origin(settings)}\n')
    atomic_write(state / 'Caddyfile', caddyfile(settings))
    atomic_write(settings_path, json.dumps(settings, indent=2) + '\n')
    UNIT_DIR.mkdir(parents=True, exist_ok=True)
    try:
        for filename, content in rendered.items():
            atomic_write(UNIT_DIR / filename, content, 0o644)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'restart', args.name + '-app.service', args.name + '-https.service')
        ca = ready(settings, state)
    except (OSError, ValueError, subprocess.CalledProcessError):
        if previous and previous['installed'] and all(content is not None for content in saved_units.values()):
            print('Activation failed; restoring the previous service definitions.', file=sys.stderr)
            for filename, content in saved_units.items():
                atomic_write(UNIT_DIR / filename, content, 0o644)
            for filename, content in saved_config.items():
                if content is not None:
                    atomic_write(state / filename, content)
            run('systemctl', 'daemon-reload')
            run('systemctl', 'restart', args.name + '-app.service', args.name + '-https.service')
        raise
    settings['installed'] = True
    atomic_write(settings_path, json.dumps(settings, indent=2) + '\n')
    atomic_write(state / 'stow-ca.crt', ca.read_text(), 0o644)
    digest = hashlib.sha256(ssl.PEM_cert_to_DER_cert(ca.read_text())).hexdigest().upper()
    print(f'\nStow is ready: {origin(settings)}\nPublic CA certificate: {state}/stow-ca.crt\nCA SHA-256: {":".join(digest[i:i + 2] for i in range(0, len(digest), 2))}\nInstall that CA certificate on each device before opening Stow. See docs/HOME_HOSTING.md.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--address', help='Reserved private LAN IPv4 address of this server; prompted on first install.')
    parser.add_argument('--port', type=int, help='HTTPS port; defaults to 8443 on first install.')
    parser.add_argument('--name', default='stow', help='System service prefix; defaults to stow.')
    parser.add_argument('--state-dir', type=Path, default=Path('/var/lib/stow'), help='Persistent notes, settings, and certificates; defaults to /var/lib/stow.')
    parser.add_argument('--password-file', type=Path, help='Read the initial password from a private file instead of prompting.')
    parser.add_argument('--build-network', choices=['host'], help='Explicit Podman build-network override for hosts where the default build network is unavailable.')
    try:
        args = parser.parse_args()
        with setup_lock():
            install(args)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f'Stow setup failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
