#!/usr/bin/env python3
"""Preview or apply a Keep export to a running self-host.py installation."""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SOURCE = Path(__file__).resolve().parent
BUILD = SOURCE.parent / 'build'


def run(*args, capture=False, **kwargs):
    result = subprocess.run([str(arg) for arg in args], check=True, text=True,
                            stdout=subprocess.PIPE if capture else kwargs.pop('stdout', None), **kwargs)
    return result.stdout.strip() if capture else None


@contextmanager
def installation_lock(path=Path('/run/stow-self-host.lock')):
    # Share the installer's lock: a restart during import would destroy the
    # network namespace used by this temporary client container.
    with os.fdopen(os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Another Stow setup or import is running; wait for it to finish.') from None
        yield


def mount(path, *, readonly=False):
    if ':' in str(path) or any(char in str(path) for char in '\r\n\0'):
        raise ValueError('Import paths must not contain colons or line breaks.')
    return f'{path}:{path}:' + ('ro,z' if readonly else 'Z')


def private_directory(path):
    if path.resolve() != path:
        raise ValueError(f'Import output directories must not contain symlinks: {path}')
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)


def import_keep(args):
    if os.geteuid() != 0:
        raise ValueError('Run with sudo on the computer running Stow.')
    if args.apply and (not args.plan or not args.vault):
        raise ValueError('Apply requires --plan and --vault from a completed preview.')
    if args.vault and not args.apply:
        raise ValueError('Use --vault with --apply.')
    if args.replace and args.plan:
        raise ValueError('Replacement choices belong to the preview; use --replace with --input.')
    if args.vault and not re.fullmatch('[a-f0-9]{64}', args.vault):
        raise ValueError('Use the complete vault ID printed by the preview.')
    state = args.state_dir.absolute()
    if state.resolve() != state:
        raise ValueError('State directory must not contain symlinks or parent-directory components.')
    for excluded in [SOURCE, BUILD]:
        if state.is_relative_to(excluded) or excluded.is_relative_to(state):
            raise ValueError('Persistent state must be separate from source and build.')
    settings = json.loads((state / 'settings.json').read_text())
    name = settings.get('name', '')
    if (settings.get('schema') != 1 or settings.get('installed') is not True
            or settings.get('mode', 'home') not in ['home', 'proxy']
            or not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', name)):
        raise ValueError('Use the state directory of a completed self-host.py installation.')
    if not (state / 'stow.env').is_file():
        raise ValueError('The installation password file is missing; restore it from backup.')
    staging = BUILD / ('keep-import-' + name)
    backups = state / 'import-backups'
    source = args.input.resolve(strict=True) if args.input else None
    plan = args.plan.resolve(strict=True) if args.plan else None
    if plan and (not plan.is_file() or not plan.is_relative_to(staging)):
        raise ValueError(f'Use the saved plan from this installation under {staging}.')
    if source:
        if source == Path('/') or not (source.is_file() or source.is_dir()):
            raise ValueError('Select a Takeout archive or extracted Keep directory.')
        for output in [SOURCE, SOURCE.parent / 'stow-git', SOURCE.parent / 'node_modules', staging, backups]:
            if source.is_relative_to(output) or output.is_relative_to(source):
                raise ValueError('Takeout input must be separate from application files, import staging, and backups.')
        # Match the host path inside the container so saved plans and printed
        # filenames can be used unchanged on subsequent invocations.
        for internal in [Path('/stow'), Path('/usr'), Path('/etc'), Path('/proc'), Path('/dev'), Path('/sys')]:
            if source == internal or source.is_relative_to(internal) or internal.is_relative_to(source):
                raise ValueError('Move the Takeout input to a data directory outside system paths.')
    volumes = [mount(staging)]
    if source:
        volumes.append(mount(source, readonly=True))
    if args.apply:
        volumes.append(mount(backups))
    inspected = run('podman', 'inspect', '--format', '{{.Id}}\n{{.State.Running}}\n{{json .Mounts}}', name + '-app', capture=True).splitlines()
    container, running, mounts = inspected
    if running != 'true' or not any(item.get('Destination') == '/data' and item.get('Source') == str(state / 'notes') for item in json.loads(mounts)):
        raise ValueError('The running Stow container does not match this installation’s notes directory.')
    build = ['podman', 'build', '--format', 'oci', '--target', 'importer', '--tag', 'localhost/stow-import:' + name,
             '--build-arg', 'STOW_IMPORT_WORKSPACE=' + str(SOURCE.parent), '--file', 'Containerfile']
    if args.build_network:
        build += ['--network', args.build_network]
    print('Preparing the import container. Stow stays running.', flush=True)
    run(*build, '.', cwd=SOURCE, stdout=sys.stderr)
    image = run('podman', 'image', 'inspect', 'localhost/stow-import:' + name, '--format', '{{.Id}}', capture=True)
    private_directory(staging)
    if args.apply:
        private_directory(backups)
    command = ['podman', 'run', '--rm', '--network', 'container:' + container,
               '--env-file', str(state / 'stow.env')]
    for volume in volumes:
        command += ['--volume', volume]
    command += [image, '--server', 'http://127.0.0.1:3001', '--auth-mode', 'password',
                '--staging-dir', str(staging), '--backup-dir', str(backups)]
    if source:
        command += ['--input', str(source)]
    else:
        command += ['--plan', str(plan)]
    if args.replace:
        command += ['--replace']
    if args.apply:
        command += ['--apply', '--vault', args.vault]
    print(f'Importing into installation {name}. Backups: {backups}', flush=True)
    run(*command)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument('--input', type=Path, help='Takeout .tgz/.tar.gz archive or extracted Keep directory.')
    selection.add_argument('--plan', type=Path, help='Saved plan filename printed by a previous preview.')
    parser.add_argument('--apply', action='store_true', help='Apply the saved plan; requires its --vault ID.')
    parser.add_argument('--vault', help='Exact destination vault ID printed by the preview.')
    parser.add_argument('--replace', action='store_true', help='Preview replacing existing notes; default appends.')
    parser.add_argument('--state-dir', type=Path, default=Path('/var/lib/stow'), help='Installer state directory; defaults to /var/lib/stow.')
    parser.add_argument('--build-network', choices=['host'], help='Explicit Podman image build-network override.')
    try:
        args = parser.parse_args()
        if os.geteuid() != 0:
            raise ValueError('Run with sudo on the computer running Stow.')
        with installation_lock():
            import_keep(args)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f'Keep import stopped: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
