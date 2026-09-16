"""Keep the container importer bound to the selected installation and saved plan."""
import argparse
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('podman_import', Path(__file__).resolve().parents[2] / 'import-keep-podman.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


class ContainerImport(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='stow-import-unit-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / 'workspace/stow-git'
        self.source.mkdir(parents=True)
        self.state = self.root / 'state'
        self.state.mkdir()
        (self.state / 'settings.json').write_text(json.dumps({'schema': 1, 'installed': True, 'name': 'stow-test'}))
        (self.state / 'stow.env').write_text('STOW_PASSWORD=literal $ " # password\n')
        self.input = self.root / 'My Keep export'
        self.input.mkdir()
        self.build = self.source.parent / 'build'
        self.staging = self.build / 'keep-import-stow-test'
        self.args = argparse.Namespace(state_dir=self.state, input=self.input, plan=None, apply=False,
                                       vault=None, replace=False, build_network=None)
        for name, value in [('SOURCE', self.source), ('BUILD', self.build)]:
            mock = patch.object(importer, name, value)
            mock.start()
            self.addCleanup(mock.stop)
        self.calls = []

    def invoke(self, *, running=True, notes=None):
        def run(*args, **kwargs):
            self.calls.append(args)
            if args[:2] == ('podman', 'inspect'):
                return 'container-id\n' + str(running).lower() + '\n' + json.dumps([
                    {'Destination': '/data', 'Source': str(notes or self.state / 'notes')}])
            if args[:3] == ('podman', 'image', 'inspect'):
                return 'sha256:import-image'
        with patch.object(importer.os, 'geteuid', return_value=0), \
                patch.object(importer, 'run', side_effect=run), redirect_stdout(io.StringIO()):
            importer.import_keep(self.args)

    def saved_plan(self):
        self.staging.mkdir(parents=True)
        self.args.input = None
        self.args.plan = self.staging / 'plan.json'
        self.args.plan.write_text('{}')

    def test_preview_uses_installed_password_and_private_api_without_mounting_live_notes(self):
        self.invoke()
        command = self.calls[-1]
        self.assertIn('container:container-id', command)
        self.assertIn(str(self.state / 'stow.env'), command)
        self.assertIn(f'{self.input}:{self.input}:ro,z', command)
        self.assertIn('http://127.0.0.1:3001', command)
        self.assertIn('password', command)
        self.assertNotIn('--replace', command)
        self.assertNotIn('--apply', command)
        self.assertNotIn('literal $ " # password', ' '.join(command))
        self.assertFalse(any(str(self.state / 'notes') in arg for arg in command))
        self.assertFalse((self.state / 'import-backups').exists())
        self.assertEqual(self.staging.stat().st_mode & 0o777, 0o700)

    def test_apply_only_mounts_saved_staging_and_persistent_backups(self):
        self.saved_plan()
        self.args.apply = True
        self.args.vault = 'a' * 64
        self.invoke()
        command = self.calls[-1]
        self.assertIn(f'{self.state}/import-backups:{self.state}/import-backups:Z', command)
        self.assertIn(str(self.args.plan), command)
        self.assertNotIn('--input', command)
        self.assertNotIn(str(self.input), ' '.join(command))
        self.assertEqual((self.state / 'import-backups').stat().st_mode & 0o777, 0o700)

    def test_replacement_requires_an_explicit_preview_choice(self):
        self.args.replace = True
        self.invoke()
        self.assertIn('--replace', self.calls[-1])
        self.args.input = None
        self.args.plan = self.staging / 'plan.json'
        with self.assertRaisesRegex(ValueError, 'Replacement choices belong to the preview'):
            self.invoke()

    def test_wrong_or_stopped_container_is_rejected_before_build_or_import(self):
        for options in [{'running': False}, {'notes': self.root / 'other-vault'}]:
            with self.subTest(options=options), self.assertRaisesRegex(ValueError, 'does not match'):
                self.invoke(**options)
        self.assertTrue(all(command[:2] == ('podman', 'inspect') for command in self.calls))
        self.assertFalse(self.staging.exists())

    def test_apply_requires_a_preview_and_explicit_vault(self):
        self.args.apply = True
        with self.assertRaisesRegex(ValueError, 'requires --plan and --vault'):
            self.invoke()
        self.saved_plan()
        with self.assertRaisesRegex(ValueError, 'requires --plan and --vault'):
            self.invoke()
        self.assertEqual(self.calls, [])

    def test_another_installations_plan_and_output_symlinks_are_rejected(self):
        self.saved_plan()
        foreign = self.root / 'other-plan.json'
        foreign.write_text('{}')
        self.args.plan = foreign
        with self.assertRaisesRegex(ValueError, 'saved plan from this installation'):
            self.invoke()
        self.args.plan = self.staging / 'linked-plan.json'
        self.args.plan.symlink_to(foreign)
        with self.assertRaisesRegex(ValueError, 'saved plan from this installation'):
            self.invoke()
        target = self.root / 'private-output'
        target.symlink_to(self.input, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlinks'):
            importer.private_directory(target)
        self.assertEqual(self.calls, [])

    def test_input_cannot_hide_container_tools_or_include_import_outputs(self):
        (self.source.parent / 'node_modules').mkdir()
        for source in [self.root, Path('/usr'), self.source, self.source.parent, self.source.parent / 'node_modules']:
            self.args.input = source
            with self.subTest(source=source), self.assertRaises(ValueError):
                self.invoke()
        self.assertEqual(self.calls, [])

    def test_installer_lock_blocks_simultaneous_import(self):
        lock = self.root / 'setup.lock'
        with importer.installation_lock(lock):
            with self.assertRaisesRegex(ValueError, 'Another Stow setup or import'):
                with importer.installation_lock(lock):
                    self.fail('Concurrent import acquired the lock')


if __name__ == '__main__':
    unittest.main()
