"""Exercise the operator import commands without host Node, Rust, or image tools."""
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import tarfile
import zipfile
import zlib


def events(text):
    decoder = json.JSONDecoder()
    while text:
        start = text.find('{')
        if start < 0:
            return
        value, end = decoder.raw_decode(text[start:])
        yield value
        text = text[start + end:]


def check_import(checkout, state, log_dir, mode, build_network, request, trust, authenticated, vault):
    workspace = checkout.parent
    keep = workspace / 'My Takeout/Takeout/Keep'
    keep.mkdir(parents=True)
    # A real PNG exercises the packaged native image checker and image codecs.
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    picture = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', 24, 16, 8, 2, 0, 0, 0)) \
        + chunk(b'IDAT', zlib.compress((b'\0' + b'\x20\x90\xc0' * 24) * 16)) + chunk(b'IEND', b'')
    (keep / 'photo.png').write_bytes(picture)
    common = {'color': 'BLUE', 'isPinned': False, 'isArchived': False, 'isTrashed': False,
              'createdTimestampUsec': 1420070400123000, 'userEditedTimestampUsec': 1520070456789000,
              'labels': [{'name': 'From Keep'}]}
    (keep / 'note.json').write_text(json.dumps({**common, 'title': 'Imported Keep note',
        'textContent': 'Takeout body with *literal stars* and 日本語',
        'attachments': [{'filePath': 'photo.png', 'mimetype': 'image/png'}]}))
    (keep / 'list.json').write_text(json.dumps({**common, 'title': 'Imported Keep checklist',
        'listContent': [{'text': 'Packed charger', 'isChecked': True}, {'text': 'Buy milk', 'isChecked': False}]}))
    if mode == 'proxy-lan':
        zipped = workspace / 'My Takeout.zip'
        with zipfile.ZipFile(zipped, 'w') as archive:
            for filename in keep.iterdir():
                archive.write(filename, arcname='Takeout/Keep/' + filename.name)
        subprocess.run(['python3', '-m', 'zipfile', '-e', str(zipped), str(workspace / 'extracted')], check=True)
        keep = workspace / 'extracted/Takeout/Keep'
        source = keep
    else:
        source = workspace / ('My Takeout.tgz' if mode == 'home' else 'My Takeout.tar.gz')
        with tarfile.open(source, 'w:gz') as archive:
            archive.add(keep, arcname='Takeout/Keep')
    before_input = {str(p.relative_to(keep)): p.read_bytes() for p in keep.iterdir()}
    before_blobs = set((state / 'notes/blobs').iterdir())
    # These commands must never rely on the development tools installed on a CI runner.
    blocked_tools = workspace / 'host-tools'
    blocked_tools.mkdir()
    for tool in ['node', 'npm', 'cargo', 'rustc', 'convert', 'identify']:
        stub = blocked_tools / tool
        stub.write_text('#!/bin/sh\necho "Unexpected host development tool" >&2\nexit 77\n')
        stub.chmod(0o755)
    (workspace / '.env').write_text('STOW_PASSWORD=wrong-workspace-password\n')
    env = {**os.environ, 'PATH': str(blocked_tools) + os.pathsep + os.environ['PATH']}
    command = [str(checkout / 'import-keep-podman.py'), '--state-dir', str(state)]
    if build_network:
        command += ['--build-network', build_network]

    def invoke(label, *options, success=True):
        with (log_dir / ('import-' + label + '.log')).open('w') as log:
            result = subprocess.run([*command, *map(str, options)], text=True, stdout=subprocess.PIPE, stderr=log, env=env)
            log.write(result.stdout)
        assert (result.returncode == 0) == success, f'Import {label} returned {result.returncode}; see {log.name}'
        return list(events(result.stdout)) if success else []

    preview = next(value for value in invoke('preview', '--input', source) if value.get('event') == 'preview')
    plan = Path(preview['plan'])
    assert plan.is_file() and plan.is_relative_to(workspace / 'build'), 'Printed plan must be a usable host filename'
    assert preview['vaultId'] == vault and preview['mode'] == 'append'
    assert set((state / 'notes/blobs').iterdir()) == before_blobs, 'Preview uploaded files'
    assert not (state / 'import-backups').exists(), 'Preview created an apply backup'
    assert before_input == {str(p.relative_to(keep)): p.read_bytes() for p in keep.iterdir()}, 'Preview modified the export'
    # Apply must depend only on saved staging, not an original mount or a surviving container.
    source.rename(source.with_name(source.name + '-moved'))
    invoke('wrong-vault', '--plan', plan, '--apply', '--vault', '0' * 64, success=False)
    assert set((state / 'notes/blobs').iterdir()) == before_blobs, 'Wrong vault uploaded files'
    applied = next(value for value in invoke('apply', '--plan', plan, '--apply', '--vault', vault) if value.get('event') == 'import-complete')
    assert applied['status'] == 'applied' and applied['added'] == 2
    backup = Path(applied['backup'])
    assert backup.is_relative_to(state / 'import-backups')
    for name in ['before.yjs', 'before-notes.json', 'before-history.json', 'import-plan.json', 'result.json']:
        assert (backup / name).is_file(), f'Missing persistent backup: {name}'
    assert any(note['title'] == 'Home setup test' for note in json.loads((backup / 'before-notes.json').read_text())['notes'])
    with request('/api/blobs/' + hashlib.sha256(picture).hexdigest(), context=trust, headers=authenticated) as response:
        assert response.read() == picture, 'Image bytes did not survive import and HTTPS download'
    retried = next(value for value in invoke('retry', '--plan', plan, '--apply', '--vault', vault) if value.get('event') == 'import-complete')
    assert retried['status'] == 'already-applied', 'A repeated plan duplicated the import'
    assert len(list((state / 'import-backups' / vault).iterdir())) == 1, 'Retry created another backup'
    # Reuse the same build cache at a different workspace path. A cached COPY
    # destination must not strand dependencies in the previous workspace.
    relocated_image = 'localhost/stow-import-relocated:' + state.name
    build = ['podman', 'build', '--format', 'oci', '--target', 'importer', '--tag', relocated_image,
             '--build-arg', 'STOW_IMPORT_WORKSPACE=' + str(workspace / 'another-workspace'), '--file', 'Containerfile']
    if build_network:
        build += ['--network', build_network]
    with (log_dir / 'import-relocated-build.log').open('w') as log:
        subprocess.run([*build, '.'], cwd=checkout, check=True, env=env, stdout=log, stderr=subprocess.STDOUT)
        subprocess.run(['podman', 'run', '--rm', '--network', 'none', relocated_image, '--help'],
                       check=True, env=env, stdout=log, stderr=subprocess.STDOUT)
    print('Container import passed: preview, image validation, vault binding, apply, persistent backup, and retry without host development tools.', flush=True)
