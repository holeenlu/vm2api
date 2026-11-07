import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('install_contracts', ROOT / 'deploy/install_contracts.py')
contracts = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(contracts)


class InstallContractTests(unittest.TestCase):
    def test_tag_and_architecture_normalization(self):
        self.assertEqual(contracts.normalize_tag('1.4.030.1-arm64'), 'v1.4.030.1')
        self.assertEqual(contracts.architecture('x86_64'), 'amd64')
        self.assertEqual(contracts.image_tag('v1.4.030.1', 'aarch64'), 'v1.4.030.1-arm64')
        with self.assertRaises(ValueError):
            contracts.normalize_tag('v1.4.030-rc1')
        with self.assertRaises(ValueError):
            contracts.architecture('mips64')


if __name__ == '__main__':
    unittest.main()
