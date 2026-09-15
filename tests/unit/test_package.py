from pathlib import Path
import hashlib
import importlib.util
import json
import tempfile
import unittest
import warnings
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('verify_package', ROOT / 'scripts' / 'verify-package.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class PackageVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='prompt-later-package-test-')
        self.root = Path(self.temporary.name)
        self.dist = self.root / 'dist'
        self.dist.mkdir()
        self.archive = self.root / 'extension.zip'
        self.manifest = {'manifest_version': 3, 'name': 'Prompt Later', 'version': '0.3.0'}
        for name in verifier.EXPECTED_FILES:
            target = self.dist / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(json.dumps(self.manifest).encode() if name == 'manifest.json' else b'synthetic asset')
        (self.root / 'manifest.json').write_text(json.dumps(self.manifest))
        self.original_root = verifier.ROOT
        verifier.ROOT = self.root

    def tearDown(self):
        verifier.ROOT = self.original_root
        self.temporary.cleanup()

    def package(self, missing=None, extra=None):
        with zipfile.ZipFile(self.archive, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name in sorted(verifier.EXPECTED_FILES):
                if name != missing:
                    archive.writestr(name, (self.dist / name).read_bytes())
            if extra:
                archive.writestr(extra, b'not a production asset')

    def test_exact_package_has_expected_version_and_digest(self):
        self.package()
        result = verifier.verify_package(self.archive, self.dist)
        self.assertEqual(result['version'], '0.3.0')
        self.assertEqual(result['sha256'], hashlib.sha256(self.archive.read_bytes()).hexdigest())

    def test_missing_unexpected_test_and_traversal_entries_are_rejected(self):
        for missing, extra in [('content.js', None), (None, 'vault-fixture.js'), (None, '../outside')]:
            with self.subTest(missing=missing, extra=extra):
                self.package(missing, extra)
                with self.assertRaisesRegex(ValueError, 'missing, duplicate, or unexpected'):
                    verifier.verify_package(self.archive, self.dist)

    def test_duplicate_entry_is_rejected(self):
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            self.package(extra='app.js')
        with self.assertRaises(ValueError):
            verifier.verify_package(self.archive, self.dist)

    def test_archive_must_match_tested_distribution(self):
        self.package()
        (self.dist / 'worker.js').write_bytes(b'changed after packaging')
        with self.assertRaisesRegex(ValueError, 'tested distribution'):
            verifier.verify_package(self.archive, self.dist)

    def test_archive_manifest_must_match_source_manifest(self):
        self.package()
        (self.root / 'manifest.json').write_text(json.dumps({**self.manifest, 'version': '0.2.0'}))
        with self.assertRaisesRegex(ValueError, 'source manifest'):
            verifier.verify_package(self.archive, self.dist)


if __name__ == '__main__':
    unittest.main()
