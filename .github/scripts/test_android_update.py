import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('verify_android_update', Path(__file__).with_name('verify-android-update.py'))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class CertificateOutputTests(unittest.TestCase):
    def test_permanent_key_supports_updates(self):
        self.assertFalse(verify.requires_reinstall([verify.RELEASE_CERTIFICATE], [verify.RELEASE_CERTIFICATE]))

    def test_approved_debug_key_migration_requires_reinstall(self):
        self.assertTrue(verify.requires_reinstall([verify.LEGACY_DEBUG_CERTIFICATE], [verify.RELEASE_CERTIFICATE]))

    def test_lost_permanent_key_rotation_requires_reinstall(self):
        self.assertTrue(verify.requires_reinstall([verify.PREVIOUS_RELEASE_CERTIFICATE], [verify.RELEASE_CERTIFICATE]))

    def test_other_key_transitions_are_rejected(self):
        for old, new in [([verify.RELEASE_CERTIFICATE], [verify.LEGACY_DEBUG_CERTIFICATE]),
                         (['a' * 64], [verify.RELEASE_CERTIFICATE]),
                         ([verify.RELEASE_CERTIFICATE], ['a' * 64]),
                         (['a' * 64], ['a' * 64])]:
            with self.assertRaises(RuntimeError):
                verify.requires_reinstall(old, new)

    def test_numbered_signer(self):
        self.assertEqual(verify.certificate_digests('Signer #1 certificate SHA-256 digest: ' + 'a' * 64 + '\n'), ['a' * 64])

    def test_sdk_range_signer(self):
        self.assertEqual(verify.certificate_digests('Signer (minSdkVersion=25, maxSdkVersion=2147483647) certificate SHA-256 digest: ' + 'B' * 64 + '\n'), ['b' * 64])

    def test_repeated_sdk_ranges_do_not_change_key_identity(self):
        output = '\n'.join('Signer (minSdkVersion=' + str(sdk) + ') certificate SHA-256 digest: ' + 'a' * 64 for sdk in [25, 28])
        self.assertEqual(verify.certificate_digests(output), ['a' * 64])

    def test_source_stamp_does_not_replace_app_signer(self):
        output = 'Signer #1 certificate SHA-256 digest: ' + 'a' * 64 + '\nSource Stamp Signer certificate SHA-256 digest: ' + 'b' * 64
        self.assertEqual(verify.certificate_digests(output), ['a' * 64])

    def test_missing_or_truncated_digest_fails(self):
        for output in ['', 'Signer #1 certificate SHA-256 digest: abcd']:
            with self.assertRaises(RuntimeError):
                verify.certificate_digests(output)


if __name__ == '__main__':
    unittest.main()
