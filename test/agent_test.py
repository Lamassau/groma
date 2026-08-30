import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('agent', Path(__file__).parents[1] / 'src/deployment/agent.py')
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class OperationsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.project = self.root / 'demo-dev'
        (self.project / 'releases').mkdir(parents=True)
        self.worker = agent.Agent(self.root)
        self.request = {'project': 'demo-dev', 'identity': 'demo:dev'}
        for n in range(1, 8):
            release = self.project / 'releases' / str(n)
            release.mkdir()
            (release / 'compose.yaml').write_text('services: {}')
            (release / 'identity').write_text('demo:dev')
            (release / 'routes.tsv').write_text('demo.example.com\t18080\n')
            (release / 'route.caddy').write_text('demo.example.com {}')
            (release / 'release.json').write_text(json.dumps({'release': str(n), 'project': 'demo-dev'}))
            os.utime(release, (time.time() - (10-n)*86400,) * 2)
        (self.project / 'current').symlink_to(self.project / 'releases' / '7')
        (self.project / 'previous').symlink_to(self.project / 'releases' / '6')

    def tearDown(self):
        self.temp.cleanup()

    def test_prune_defaults_to_preview_and_preserves_used_releases_and_volumes(self):
        volume = self.root / 'database-volume'
        volume.mkdir()
        (volume / 'data').write_text('keep me')
        used = {'Config': {'Labels': {'com.docker.compose.project.working_dir': str(self.project / 'releases' / '1')}}}
        with patch.object(self.worker, 'inspect', return_value=[used]):
            result = self.worker.dispatch('prune', {**self.request, 'keep': 2})
            self.assertTrue(result['dryRun'])
            self.assertEqual(result['releases'], ['5', '4', '3', '2'])
            self.assertTrue((self.project / 'releases' / '5').exists())
            result = self.worker.dispatch('prune', {**self.request, 'keep': 2, 'execute': True})
        self.assertFalse((self.project / 'releases' / '5').exists())
        for protected in ['1', '6', '7']:
            self.assertTrue((self.project / 'releases' / protected).exists())
        self.assertEqual((volume / 'data').read_text(), 'keep me')

    def test_prune_skips_symlinks_and_unrecognized_metadata(self):
        (self.project / 'releases' / 'outside').symlink_to(self.root)
        (self.project / 'releases' / '2' / 'identity').write_text('other:app')
        with patch.object(self.worker, 'inspect', return_value=[]):
            result = self.worker.dispatch('prune', {**self.request, 'keep': 2, 'execute': True})
        self.assertIn('outside', result['skipped'])
        self.assertIn('2', result['skipped'])
        self.assertTrue((self.project / 'releases' / '2').exists())

    def test_escape_and_identity_mismatch_fail_closed(self):
        with self.assertRaises(ValueError):
            self.worker.project('../elsewhere')
        (self.project / 'current').unlink()
        (self.project / 'current').symlink_to(self.root)
        with self.assertRaises(RuntimeError):
            self.worker.dispatch('prune', self.request)
        with self.assertRaises(RuntimeError):
            self.worker.identity(self.project / 'releases' / '1', 'other:app')

    def test_stop_needs_explicit_ephemeral_data_acknowledgement(self):
        with patch.object(self.worker, 'compose', return_value=json.dumps({'services': {'db': {'tmpfs': ['/data']}}})) as compose:
            with self.assertRaisesRegex(RuntimeError, 'ephemeral'):
                self.worker.dispatch('stop', self.request)
            self.assertEqual(compose.call_count, 1)
        replies = [json.dumps({'services': {'db': {'tmpfs': ['/data']}}}), '', '[]']
        with patch.object(self.worker, 'compose', side_effect=replies) as compose:
            result = self.worker.dispatch('stop', {**self.request, 'allowEphemeralLoss': True})
            self.assertEqual(result['action'], 'stop')
            self.assertIn(['stop', '--timeout', '30'], [call.args[2] for call in compose.call_args_list])

    def test_start_does_not_recreate_missing_containers(self):
        with patch.object(self.worker, 'compose', return_value=json.dumps({'services': {'web': {}}})), patch.object(self.worker, 'inspect', return_value=[]):
            with self.assertRaisesRegex(RuntimeError, 'missing'):
                self.worker.dispatch('start', self.request)

    def test_start_uses_current_release_without_pulling_images(self):
        with patch.object(self.worker, 'compose', side_effect=[json.dumps({'services': {'web': {}}}), '', '[]']) as compose, patch.object(self.worker, 'inspect', return_value=[{'Config': {'Labels': {'com.docker.compose.service': 'web'}}}]):
            self.worker.dispatch('start', self.request)
            calls = [call.args[2] for call in compose.call_args_list]
            self.assertIn(['start', '--wait', '--wait-timeout', '120'], calls)
            self.assertFalse(any('pull' in c or 'up' in c for c in calls))

    def test_apps_reports_actual_health_images_and_usage_without_env_values(self):
        containers = [{'Id': 'abc123', 'Config': {'Image': 'demo@sha256:abc', 'Env': ['SECRET=hidden'], 'Labels': {'com.docker.compose.service': 'web'}}, 'State': {'Running': True, 'Status': 'running', 'Health': {'Status': 'healthy'}}}]
        with patch.object(self.worker, 'inspect', return_value=containers), patch.object(agent, 'run', return_value='{"ID":"abc123","CPUPerc":"2%","MemUsage":"32MiB / 256MiB"}\n'):
            result = self.worker.dispatch('apps', {})
        app = result['apps'][0]
        self.assertEqual(app['services'][0]['health'], 'healthy')
        self.assertEqual(app['services'][0]['cpu'], '2%')
        self.assertEqual(app['urls'], ['https://demo.example.com'])
        self.assertNotIn('hidden', json.dumps(result))

    def test_snapshot_uses_temporary_files_and_keeps_active_release_unchanged(self):
        replies = [json.dumps({'services': {'web': {'image': 'old'}}}), 'services: {}', json.dumps({'services': {'web': {'image': 'new'}}})]
        with patch.object(self.worker, 'compose', side_effect=replies):
            data = self.worker.dispatch('snapshot', {**self.request, 'compose': 'services: {}', 'routes': 'new.example.com {}'})
        self.assertEqual(data['currentRelease'], '7')
        self.assertEqual(data['candidate']['services']['web']['image'], 'new')
        self.assertEqual((self.project / 'current').resolve().name, '7')
        self.assertEqual(len(list((self.project / 'releases').iterdir())), 7)


if __name__ == '__main__':
    unittest.main()
