"""Offline-only generator. No AWS clients, deployment, or table writes."""
import argparse
import json
from pathlib import Path


def load_config(path):
    c = json.loads(Path(path).read_text())
    if c['accountId'] != '005466002626' or c['region'] != 'ap-northeast-1':
        raise ValueError('Unexpected production account/region')
    if c['apiId'] != 'yafsunxnuzb6hf2em4dxawtjfe':
        raise ValueError('Unexpected API')
    rows = c['tables']
    if len(rows) != 12 or len({x['name'] for x in rows}) != 12:
        raise ValueError('Exactly 12 distinct tables required')
    if sum(x['pitr'] is True for x in rows) != 10:
        raise ValueError('Exactly 10 PITR tables required')
    standard = {'HistoricalShareGrant', 'LocationLog', 'RecordingSession', 'ShareGroup',
                'ShareGroupMember', 'UserActivityMonthlySummary', 'UserActivityWeeklySummary', 'UserProfile'}
    custom = {'AccountDeletionTable', 'GroupAccessOperationTable',
              'HistoricalShareOperationTable', 'SessionLogIndexTable'}
    if {x['logicalName'] for x in rows} != standard | custom:
        raise ValueError('Unexpected logical table set')
    for x in rows:
        if not isinstance(x['pitr'], bool) or not x['name'] or '*' in x['name']:
            raise ValueError('Invalid table selection')
        if any(n in x['name'] for n in ('DebugLog', 'LiveLocation', 'UserDeviceSession')):
            raise ValueError('Transient/diagnostic table must not be selected')
        if x['pitr'] != (x['logicalName'] not in {'UserActivityMonthlySummary', 'UserActivityWeeklySummary'}):
            raise ValueError('Wrong PITR classification')
        if x['logicalName'] in standard and x['name'] != f"{x['logicalName']}-{c['apiId']}-NONE":
            raise ValueError('Wrong API table name')
        if x['logicalName'] in custom and (
                not x['name'].startswith('amplify-locationtrackerapp-satouhiroshi-sandbox-0dc5-HistoricalShareOperations6EF4E006-1DL2GB23HMVRL-')
                or x['logicalName'] not in x['name']):
            raise ValueError('Wrong custom table environment')
    return c


def build_template(c):
    account, region = c['accountId'], c['region']
    arns = [f"arn:aws:dynamodb:{region}:{account}:table/{x['name']}" for x in c['tables']]
    topic = {'Ref': 'NotificationTopic'}
    resources = {
        'NotificationTopic': {
            'Type': 'AWS::SNS::Topic', 'DeletionPolicy': 'Retain',
            'UpdateReplacePolicy': 'Retain',
            'Properties': {'TopicName': 'aclog-production-backup-events'}},
        'TopicPolicy': {'Type': 'AWS::SNS::TopicPolicy', 'Properties': {
            'Topics': [topic], 'PolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                'Effect': 'Allow', 'Principal': {'Service': 'backup.amazonaws.com'},
                'Action': 'sns:Publish', 'Resource': topic,
                'Condition': {'StringEquals': {'aws:SourceAccount': account}}}]}}},
        'NotificationEmail': {'Type': 'AWS::SNS::Subscription',
            'Properties': {'Protocol': 'email', 'Endpoint': {'Ref': 'AlertEmail'}, 'TopicArn': topic}},
        'Vault': {'Type': 'AWS::Backup::BackupVault', 'DeletionPolicy': 'Retain',
            'UpdateReplacePolicy': 'Retain', 'DependsOn': 'TopicPolicy', 'Properties': {
                'BackupVaultName': 'aclog-production-daily',
                'Notifications': {'SNSTopicArn': topic, 'BackupVaultEvents': [
                    'BACKUP_JOB_FAILED', 'BACKUP_JOB_EXPIRED', 'RESTORE_JOB_FAILED']}}},
        'BackupRole': {'Type': 'AWS::IAM::Role', 'Properties': {
            'AssumeRolePolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                'Effect': 'Allow', 'Principal': {'Service': 'backup.amazonaws.com'},
                'Action': 'sts:AssumeRole',
                'Condition': {'StringEquals': {'aws:SourceAccount': account},
                              'ArnLike': {'aws:SourceArn': f'arn:aws:backup:{region}:{account}:*'}}}]},
            'Policies': [{'PolicyName': 'SelectedDynamoDBBackupOnly', 'PolicyDocument': {
                'Version': '2012-10-17', 'Statement': [
                    {'Effect': 'Allow', 'Action': ['dynamodb:DescribeTable', 'dynamodb:CreateBackup',
                        'dynamodb:StartAwsBackupJob', 'dynamodb:ListTagsOfResource'], 'Resource': arns},
                    {'Effect': 'Allow', 'Action': ['dynamodb:DescribeBackup', 'dynamodb:DeleteBackup'],
                     'Resource': [a + '/backup/*' for a in arns]}]}}]}},
        'Plan': {'Type': 'AWS::Backup::BackupPlan', 'Properties': {'BackupPlan': {
            'BackupPlanName': 'aclog-production-daily-35d', 'BackupPlanRule': [{
                'RuleName': 'Daily0300JST', 'TargetBackupVault': {'Ref': 'Vault'},
                'ScheduleExpression': 'cron(0 3 * * ? *)',
                'ScheduleExpressionTimezone': 'Asia/Tokyo',
                'StartWindowMinutes': 60, 'CompletionWindowMinutes': 360,
                'EnableContinuousBackup': False, 'Lifecycle': {'DeleteAfterDays': 35},
                'RecoveryPointTags': {'Application': 'AcLogFit', 'Environment': 'production'}}]}}},
        'Selection': {'Type': 'AWS::Backup::BackupSelection', 'Properties': {
            'BackupPlanId': {'Ref': 'Plan'}, 'BackupSelection': {
                'SelectionName': 'AcLogFitExplicit12Tables',
                'IamRoleArn': {'Fn::GetAtt': ['BackupRole', 'Arn']}, 'Resources': arns}}},
    }
    # No DynamoDB::Table or Lambda custom resource: existing app tables are not recreated.
    return {'AWSTemplateFormatVersion': '2010-09-09',
            'Description': 'AcLog Fit production: daily snapshots only; PITR applied separately.',
            'Parameters': {'AlertEmail': {'Type': 'String', 'AllowedPattern': r'[^\s@]+@[^\s@]+\.[^\s@]+'}},
            'Resources': resources,
            'Outputs': {'VaultName': {'Value': {'Ref': 'Vault'}},
                        'PlanId': {'Value': {'Ref': 'Plan'}},
                        'BackupRoleArn': {'Value': {'Fn::GetAtt': ['BackupRole', 'Arn']}},
                        'NotificationTopicArn': {'Value': topic}}}


def prepare(config, output):
    c = load_config(config)
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    artifacts = {
        'backup-stack.json': build_template(c),
        'pitr-enable-requests.json': [{
            'TableName': x['name'],
            'PointInTimeRecoverySpecification': {
                'PointInTimeRecoveryEnabled': True, 'RecoveryPeriodInDays': 35}}
            for x in c['tables'] if x['pitr']],
    }
    for name, data in artifacts.items():
        (output / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    return artifacts


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path(__file__).with_name('production.json'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = prepare(args.config, args.output)
    print(f'Prepared offline: {len(result)} artifacts. No AWS changes.')
