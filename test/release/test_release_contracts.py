import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('release_contracts', ROOT / 'scripts/release/release_contracts.py')
contracts = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(contracts)


class ReleaseContractTests(unittest.TestCase):
    def test_versions_and_tags_are_strict(self):
        self.assertEqual(contracts.require_upstream_version('1.4.030'), '1.4.030')
        self.assertEqual(contracts.require_fork_version('1.4.030.1'), '1.4.030.1')
        self.assertEqual(contracts.require_release_tag('v1.4.030.1'), 'v1.4.030.1')
        for value in ('1.4', '1.4.030-rc1', 'v1.4.030.0.1'):
            with self.assertRaises(ValueError):
                contracts.require_release_tag(value)

    def test_source_must_inherit_upstream_version(self):
        sha = 'a' * 40
        self.assertEqual(
            contracts.release_source_contract(
                source_commit=sha,
                upstream_parent='b' * 40,
                version='1.4.030.2',
                parent_version='1.4.030',
            )['version'],
            '1.4.030.2',
        )
        with self.assertRaises(ValueError):
            contracts.release_source_contract(
                source_commit=sha,
                upstream_parent='b' * 40,
                version='1.4.029.1',
                parent_version='1.4.030',
            )

    def test_asset_and_image_contracts(self):
        self.assertEqual(
            contracts.require_asset_contract(['cli-node', 'kin-worker'], ['kin-worker']),
            ('cli-node', 'kin-worker'),
        )
        with self.assertRaises(ValueError):
            contracts.require_asset_contract(['../secret'], [])
        with self.assertRaises(ValueError):
            contracts.require_asset_contract([], ['kin-worker'])
        self.assertEqual(
            contracts.image_platform_contract(architecture='amd64', operating_system='linux'),
            {'architecture': 'amd64', 'os': 'linux'},
        )
        with self.assertRaises(ValueError):
            contracts.image_platform_contract(architecture='arm64', operating_system='linux')

    def test_deploy_tag_and_architecture_contracts(self):
        self.assertEqual(contracts.normalize_deploy_tag('1.4.030.1-arm64'), 'v1.4.030.1')
        self.assertEqual(contracts.deploy_architecture('x86_64'), 'amd64')
        self.assertEqual(contracts.deploy_image_tag('v1.4.030.1', 'aarch64'), 'v1.4.030.1-arm64')
        with self.assertRaises(ValueError):
            contracts.normalize_deploy_tag('v1.4.030-rc1')
        with self.assertRaises(ValueError):
            contracts.deploy_architecture('mips64')


if __name__ == '__main__':
    unittest.main()
