"""Protect persistent home installations from unsafe setup and update attempts."""
import argparse
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('home_setup', Path(__file__).resolve().parents[2] / 'self-host.py')
hosting = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hosting)


class HomeSetup(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='stow-home-unit-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.state = self.root / 'state'
        self.unit_dir = self.root / 'units'
        self.source = self.root / 'workspace/stow-git'
        self.source.mkdir(parents=True)
        self.password_file = self.root / 'password'
        self.password_file.write_text('literal $password "with quotes" # and spaces\n')
        self.args = argparse.Namespace(address='192.168.1.20', port=None, name='stow-test',
                                       state_dir=self.state, password_file=self.password_file, build_network=None)
        for name, value in [('SOURCE', self.source), ('UNIT_DIR', self.unit_dir)]:
            p = patch.object(hosting, name, value)
            p.start()
            self.addCleanup(p.stop)

    def existing(self):
        self.state.mkdir()
        settings = {'schema': 1, 'address': '192.168.1.20', 'port': 8443, 'name': 'stow-test', 'installed': True}
        (self.state / 'settings.json').write_text(json.dumps(settings))
        (self.state / 'stow.env').write_text('STOW_PASSWORD=existing password\n')
        (self.state / 'Caddyfile').write_text('previous Caddy configuration\n')
        (self.state / 'notes').mkdir()
        (self.state / 'notes/session-secret').write_text('existing identity')
        authority = self.state / 'tls/caddy/pki/authorities/local'
        authority.mkdir(parents=True)
        (authority / 'root.crt').write_text('existing certificate')
        (authority / 'root.key').write_text('existing private key')
        self.args.address = None
        self.args.password_file = None
        self.unit_dir.mkdir()
        for name, text in hosting.units(settings, self.state, 'sha256:old-app', 'sha256:old-proxy').items():
            (self.unit_dir / name).write_text(text)
        return settings

    def invoke(self, *, fail_build=False, fail_ready=False):
        calls = []

        def command(*args, **kwargs):
            calls.append(args)
            if fail_build and args[:2] == ('podman', 'build'):
                raise subprocess.CalledProcessError(1, args)
            return 'sha256:new-image' if kwargs.get('capture') else None

        def ready(*args):
            if fail_ready:
                raise ValueError('HTTPS failed')
            ca = self.state / 'tls/caddy/pki/authorities/local/root.crt'
            if not ca.exists():
                ca.parent.mkdir(parents=True)
                ca.write_text('test certificate')
            return ca

        with patch.object(hosting, 'preflight'), patch.object(hosting, 'verify_units'), \
                patch.object(hosting, 'run', side_effect=command), \
                patch.object(hosting, 'ready', side_effect=ready), \
                patch.object(hosting.os, 'chown'), \
                patch.object(hosting.ssl, 'PEM_cert_to_DER_cert', return_value=b'certificate'):
            with redirect_stdout(io.StringIO()):
                hosting.install(self.args)
        return calls

    def test_concurrent_setup_cannot_replace_password_or_service_state(self):
        lock = self.root / 'setup.lock'
        with patch.object(hosting.os, 'geteuid', return_value=0):
            with hosting.setup_lock(lock):
                with self.assertRaisesRegex(ValueError, 'Another Stow setup'):
                    with hosting.setup_lock(lock):
                        self.fail('Concurrent setup acquired the same lock')
            with hosting.setup_lock(lock):
                pass

    def test_only_private_ipv4_addresses_can_be_published(self):
        for address in ['0.0.0.0', '127.0.0.1', '169.254.1.1', '8.8.8.8', '224.0.0.1', '::1', 'notes.example.com']:
            with self.subTest(address=address), self.assertRaises(ValueError):
                hosting.validate(address, 8443, 'stow', self.state)
        for address in ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.20']:
            self.assertEqual(hosting.validate(address, 8443, 'stow', self.state), address)

    def test_state_cannot_occupy_source_build_or_an_ancestor(self):
        for directory in [self.source, self.source / 'data', self.source.parent / 'build/data', self.source.parent, Path('/')]:
            with self.subTest(directory=directory), self.assertRaises(ValueError):
                hosting.validate('192.168.1.20', 8443, 'stow', directory)
        self.state.symlink_to(self.root / 'other')
        with self.assertRaises(ValueError):
            hosting.validate('192.168.1.20', 8443, 'stow', self.state)

    def test_unit_and_environment_injection_are_rejected(self):
        for name in ['../other', 'stow\nExecStart=bad', 'stow.service', 'stow%h', '-stow']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                hosting.validate('192.168.1.20', 8443, name, self.state)
        for password in ['', 'first\nSTOW_ALLOW_INSECURE=true', 'first\rsecond', 'abc\0def']:
            with self.subTest(password=password), self.assertRaises(ValueError):
                hosting.password_value(password)
        for port in [0, 443, 65536]:
            with self.subTest(port=port), self.assertRaises(ValueError):
                hosting.validate('192.168.1.20', port, 'stow', self.state)

    def test_initial_install_keeps_password_literal_and_private(self):
        self.invoke()
        env = self.state / 'stow.env'
        self.assertIn('STOW_PASSWORD=literal $password "with quotes" # and spaces\n', env.read_text())
        self.assertEqual(env.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.state / 'stow-ca.crt').stat().st_mode & 0o777, 0o644)
        self.assertTrue(json.loads((self.state / 'settings.json').read_text())['installed'])

    def test_existing_unrelated_state_and_units_are_never_overwritten(self):
        self.state.mkdir()
        keep = self.state / 'unrelated'
        keep.write_text('keep me')
        with self.assertRaisesRegex(ValueError, 'empty state'):
            self.invoke()
        self.assertEqual(keep.read_text(), 'keep me')
        keep.unlink()
        self.unit_dir.mkdir()
        other = self.unit_dir / 'stow-test-app.container'
        other.write_text('another service')
        with self.assertRaisesRegex(ValueError, 'unrelated service'):
            self.invoke()
        self.assertEqual(other.read_text(), 'another service')

    def test_update_preserves_password_vault_identity_and_ca(self):
        self.existing()
        retained = ['stow.env', 'notes/session-secret', 'tls/caddy/pki/authorities/local/root.crt', 'tls/caddy/pki/authorities/local/root.key']
        before = {name: (self.state / name).read_bytes() for name in retained}
        self.invoke()
        self.assertEqual(before, {name: (self.state / name).read_bytes() for name in retained})
        self.assertIn('Image=sha256:new-image', (self.unit_dir / 'stow-test-app.container').read_text())

    def test_changing_origin_or_missing_ca_stops_before_an_update(self):
        self.existing()
        self.args.address = '192.168.1.21'
        with self.assertRaisesRegex(ValueError, 'existing address'):
            self.invoke()
        self.args.address = None
        (self.state / 'tls/caddy/pki/authorities/local/root.key').unlink()
        with self.assertRaisesRegex(ValueError, 'certificate authority is missing'):
            self.invoke()

    def test_build_failure_leaves_running_service_definitions_unchanged(self):
        self.existing()
        before = {p.name: p.read_text() for p in self.unit_dir.iterdir()}
        with self.assertRaises(subprocess.CalledProcessError):
            self.invoke(fail_build=True)
        self.assertEqual(before, {p.name: p.read_text() for p in self.unit_dir.iterdir()})

    def test_missing_server_identity_cannot_silently_create_a_different_vault(self):
        self.existing()
        (self.state / 'notes/session-secret').unlink()
        before = {p.name: p.read_text() for p in self.unit_dir.iterdir()}
        with self.assertRaisesRegex(ValueError, 'server identity is missing'):
            self.invoke()
        self.assertEqual(before, {p.name: p.read_text() for p in self.unit_dir.iterdir()})
        self.assertFalse((self.state / 'notes/session-secret').exists())

    def test_failed_activation_restores_both_previous_images_without_touching_data(self):
        self.existing()
        before = {p.name: p.read_text() for p in self.unit_dir.iterdir()}
        with self.assertRaisesRegex(ValueError, 'HTTPS failed'):
            self.invoke(fail_ready=True)
        self.assertEqual(before, {p.name: p.read_text() for p in self.unit_dir.iterdir()})
        self.assertEqual((self.state / 'notes/session-secret').read_text(), 'existing identity')
        self.assertEqual((self.state / 'Caddyfile').read_text(), 'previous Caddy configuration\n')


if __name__ == '__main__':
    unittest.main()
