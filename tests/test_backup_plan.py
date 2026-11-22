import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('backup', ROOT / 'scripts/backup/prepare_backup.py')
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)


class BackupPlanTests(unittest.TestCase):
    def setUp(self):
        self.config = backup.load_config(ROOT / 'scripts/backup/production.json')
        self.template = backup.build_template(self.config)

    def test_existing_tables_cannot_be_recreated_or_deleted(self):
        types = {r['Type'] for r in self.template['Resources'].values()}
        self.assertNotIn('AWS::DynamoDB::Table', types)
        self.assertFalse(any(t.startswith('Custom::') for t in types))
        statements = self.template['Resources']['BackupRole']['Properties']['Policies'][0]['PolicyDocument']['Statement']
        actions = {a for s in statements for a in s['Action']}
        self.assertFalse(actions & {'dynamodb:DeleteTable', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem', 'dynamodb:UpdateItem'})

    def test_only_explicit_twelve_tables_and_ten_pitr(self):
        resources = self.template['Resources']
        selection = resources['Selection']['Properties']['BackupSelection']['Resources']
        self.assertEqual(len(selection), 12)
        self.assertTrue(all('*' not in a for a in selection))
        self.assertEqual(sum(x['pitr'] for x in self.config['tables']), 10)
        self.assertTrue(all('005466002626:table/' in a for a in selection))
        self.assertTrue(all('DebugLog' not in a and 'LiveLocation' not in a and 'UserDeviceSession' not in a for a in selection))
        fences = next(x for x in self.config['tables'] if x['logicalName'] == 'HistoricalShareOperationTable')
        self.assertTrue(fences['pitr'])

    def test_schedule_retention_and_vault_survive_stack_removal(self):
        r = self.template['Resources']
        rule = r['Plan']['Properties']['BackupPlan']['BackupPlanRule'][0]
        self.assertEqual(rule['ScheduleExpression'], 'cron(0 3 * * ? *)')
        self.assertEqual(rule['ScheduleExpressionTimezone'], 'Asia/Tokyo')
        self.assertEqual(rule['Lifecycle'], {'DeleteAfterDays': 35})
        self.assertFalse(rule['EnableContinuousBackup'])
        self.assertNotIn('CopyActions', rule)
        self.assertEqual(r['Vault']['DeletionPolicy'], 'Retain')
        self.assertEqual(r['Vault']['UpdateReplacePolicy'], 'Retain')
        self.assertNotIn('LockConfiguration', r['Vault']['Properties'])

    def test_notifications_require_recipient_and_service_policy(self):
        r = self.template['Resources']
        self.assertNotIn('Default', self.template['Parameters']['AlertEmail'])
        self.assertEqual(r['NotificationEmail']['Properties']['Protocol'], 'email')
        policy = r['TopicPolicy']['Properties']['PolicyDocument']['Statement'][0]
        self.assertEqual(policy['Principal'], {'Service': 'backup.amazonaws.com'})
        self.assertEqual(policy['Action'], 'sns:Publish')
        self.assertIn('BACKUP_JOB_FAILED', r['Vault']['Properties']['Notifications']['BackupVaultEvents'])

    def test_offline_artifacts_have_no_aws_mutations(self):
        with tempfile.TemporaryDirectory() as td:
            result = backup.prepare(ROOT / 'scripts/backup/production.json', td)
            requests = result['pitr-enable-requests.json']
            self.assertEqual(len(requests), 10)
            self.assertTrue(all(x['PointInTimeRecoverySpecification'] == {
                'PointInTimeRecoveryEnabled': True, 'RecoveryPeriodInDays': 35} for x in requests))
            self.assertEqual(json.loads((Path(td) / 'backup-stack.json').read_text()), self.template)

    def test_invalid_targets_fail_closed(self):
        for change in ('account', 'region', 'count', 'duplicate', 'diagnostic', 'wildcard'):
            c = copy.deepcopy(self.config)
            if change == 'account': c['accountId'] = '000000000000'
            if change == 'region': c['region'] = 'us-east-1'
            if change == 'count': c['tables'].pop()
            if change == 'duplicate': c['tables'][0] = c['tables'][1]
            if change == 'diagnostic': c['tables'][0]['name'] = 'BackgroundLocationDebugLog-other'
            if change == 'wildcard': c['tables'][0]['name'] = '*'
            with tempfile.TemporaryDirectory() as td:
                p = Path(td) / 'bad.json'
                p.write_text(json.dumps(c))
                with self.subTest(change=change), self.assertRaises(ValueError):
                    backup.load_config(p)


if __name__ == '__main__':
    unittest.main()
