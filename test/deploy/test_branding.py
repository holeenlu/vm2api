"""Fresh-install deployment identity, independent from the real repository name."""
import unittest
from test_install_schedule import run_installer


class BrandingTests(unittest.TestCase):
    def test_default_image_and_install_directory(self):
        result = run_installer('printf "%s\n" "$IMAGE_REPO" "$INSTALL_DIR" "$SERVICE_NAME"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ['ghcr.io/holeenlu/tapmodels-gateway', '/opt/tapmodels', 'tapmodels'])

    def test_repository_override_does_not_change_image_identity(self):
        result = run_installer('printf "%s\n" "$GITHUB_REPO" "$IMAGE_REPO"', extra_env={'TAPMODELS_GITHUB_REPO': 'example/source'})
        self.assertEqual(result.stdout.splitlines(), ['example/source', 'ghcr.io/holeenlu/tapmodels-gateway'])

    def test_new_deployment_overrides_are_respected(self):
        result = run_installer('printf "%s\n" "$IMAGE_REPO" "$INSTALL_DIR"', extra_env={'TAPMODELS_IMAGE': 'registry.example/tapmodels', 'TAPMODELS_DIR': '/srv/tapmodels'})
        self.assertEqual(result.stdout.splitlines(), ['registry.example/tapmodels', '/srv/tapmodels'])

    def test_old_brand_configuration_does_not_select_an_old_installation(self):
        result = run_installer('printf "%s\n" "$IMAGE_REPO" "$INSTALL_DIR"', extra_env={'VM2API_IMAGE': 'registry.example/old', 'VM2API_DIR': '/srv/old'})
        self.assertEqual(result.stdout.splitlines(), ['ghcr.io/holeenlu/tapmodels-gateway', '/opt/tapmodels'])
