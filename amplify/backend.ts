import { CfnFunctionConfiguration } from "aws-cdk-lib/aws-appsync";
import { defineBackend } from "@aws-amplify/backend";
import { Function } from "aws-cdk-lib/aws-lambda";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { storage } from "./storage/resource";
import { liveLocationApi } from "./functions/live-location-api/resource";
import {
    AttributeType,
    BillingMode,
    Table,
    StreamViewType,
} from "aws-cdk-lib/aws-dynamodb";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import {
    StartingPosition,
    FilterCriteria,
    FilterRule,
} from "aws-cdk-lib/aws-lambda";
import { Rule, Schedule, RuleTargetInput } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { Duration, Stack } from "aws-cdk-lib";
import { RemovalPolicy } from "aws-cdk-lib";

import { shareGroupApi } from "./functions/share-group-api/resource";

const backend = defineBackend({
    auth,
    data,
    storage,
    liveLocationApi,
    shareGroupApi,
});

// DynamoDBテーブルを取得
const liveLocationTable = backend.data.resources.tables["LiveLocation"];

const shareGroupMemberTable = backend.data.resources.tables["ShareGroupMember"];

const shareGroupTable = backend.data.resources.tables["ShareGroup"];

// LiveLocationレコードの読み書きを許可
liveLocationTable.grantReadWriteData(backend.liveLocationApi.resources.lambda);

// 共有先の所属確認に必要な読み取り権限
shareGroupMemberTable.grantReadData(backend.liveLocationApi.resources.lambda);

shareGroupTable.grantReadData(backend.liveLocationApi.resources.lambda);

// Amplify Gen2のIFunctionをCDK Functionとして扱う
const liveLocationLambda = backend.liveLocationApi.resources.lambda as Function;

// DynamoDBテーブル名をLambdaの環境変数へ設定
liveLocationLambda.addEnvironment(
    "LIVE_LOCATION_TABLE_NAME",
    liveLocationTable.tableName,
);

liveLocationLambda.addEnvironment(
    "SHARE_GROUP_MEMBER_TABLE_NAME",
    shareGroupMemberTable.tableName,
);

liveLocationLambda.addEnvironment(
    "SHARE_GROUP_TABLE_NAME",
    shareGroupTable.tableName,
);

/*
 * 履歴共有操作のセッション単位ロックと状態管理。
 *
 * LocationLog / RecordingSession の保存テーブルには
 * 変更を加えない。
 */
const historicalShareStack = backend.createStack("HistoricalShareOperations");

// Durable dispatch: committing READY emits a stream event. A watchdog also
// resumes expired chunks and re-emits missed dispatch, without relying on the app.
const groupAccessOperations = new Table(
    historicalShareStack,
    "GroupAccessOperationTable",
    {
        partitionKey: { name: "groupId", type: AttributeType.STRING },
        sortKey: { name: "entryKey", type: AttributeType.STRING },
        billingMode: BillingMode.PAY_PER_REQUEST,
        stream: StreamViewType.NEW_IMAGE,
        removalPolicy: RemovalPolicy.RETAIN,
    },
);
groupAccessOperations.grantReadWriteData(
    backend.shareGroupApi.resources.lambda,
);
const accessLambda = backend.shareGroupApi.resources.lambda as Function;
// Strongly consistent, session-scoped log inventory. No client access.
const sessionLogIndex = new Table(historicalShareStack, "SessionLogIndexTable", {
    partitionKey: { name: "sessionKey", type: AttributeType.STRING },
    sortKey: { name: "logId", type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
    removalPolicy: RemovalPolicy.RETAIN,
});
sessionLogIndex.grantReadWriteData(accessLambda);
accessLambda.addEnvironment("SESSION_LOG_INDEX_TABLE_NAME", sessionLogIndex.tableName);
accessLambda.addEnvironment(
    "GROUP_ACCESS_OPERATION_TABLE_NAME",
    groupAccessOperations.tableName,
);
shareGroupTable.grantReadWriteData(accessLambda);
shareGroupMemberTable.grantReadWriteData(accessLambda);
accessLambda.addEnvironment(
    "SHARE_GROUP_TABLE_NAME",
    shareGroupTable.tableName,
);
accessLambda.addEnvironment(
    "SHARE_GROUP_MEMBER_TABLE_NAME",
    shareGroupMemberTable.tableName,
);
accessLambda.addEventSource(
    new DynamoEventSource(groupAccessOperations, {
        startingPosition: StartingPosition.TRIM_HORIZON,
        batchSize: 1,
        retryAttempts: 3,
        bisectBatchOnError: true,
        filters: [
            FilterCriteria.filter({
                dynamodb: {
                    NewImage: {
                        recordType: { S: FilterRule.isEqual("JOB") },
                        status: { S: FilterRule.isEqual("READY") },
                    },
                },
            }),
        ],
    }),
);
const accessWatchdog = new Rule(Stack.of(accessLambda), "GroupAccessWatchdog", {
    schedule: Schedule.rate(Duration.minutes(1)),
});
accessWatchdog.addTarget(
    new LambdaFunction(accessLambda, {
        event: RuleTargetInput.fromObject({ reconcileGroupAccess: true }),
    }),
);

const historicalShareOperationTable = new Table(
    historicalShareStack,
    "HistoricalShareOperationTable",
    {
        partitionKey: {
            name: "recordingSessionRecordId",
            type: AttributeType.STRING,
        },
        billingMode: BillingMode.PAY_PER_REQUEST,
        removalPolicy: RemovalPolicy.RETAIN,
    },
);

// shareGroupApiに操作状態テーブルの読み書きを許可
historicalShareOperationTable.grantReadWriteData(
    backend.shareGroupApi.resources.lambda,
);

// LambdaをCDKのFunction型として扱う
const shareGroupLambda = backend.shareGroupApi.resources.lambda as Function;

// テーブル名をLambdaへ渡す
shareGroupLambda.addEnvironment(
    "HISTORICAL_SHARE_OPERATION_TABLE_NAME",
    historicalShareOperationTable.tableName,
);

// ⑥-F-4：条件付きGrant作成に使用する実テーブル
const historicalShareGrantTable =
    backend.data.resources.tables["HistoricalShareGrant"];

// shareGroupApiから条件付き書き込みを許可する
historicalShareGrantTable.grantReadWriteData(
    backend.shareGroupApi.resources.lambda,
);

// 実テーブル名をLambdaへ渡す
shareGroupLambda.addEnvironment(
    "HISTORICAL_SHARE_GRANT_TABLE_NAME",
    historicalShareGrantTable.tableName,
);

// Historical sharing: Lambda alone may update sharedOwners in DynamoDB.
// The client-facing GraphQL field denies direct owner updates.
const historicalLocationLogTable = backend.data.resources.tables["LocationLog"];
const historicalRecordingSessionTable =
    backend.data.resources.tables["RecordingSession"];
historicalLocationLogTable.grantReadWriteData(
    backend.shareGroupApi.resources.lambda,
);
historicalRecordingSessionTable.grantReadWriteData(
    backend.shareGroupApi.resources.lambda,
);
const historicalShareLambda = backend.shareGroupApi.resources
    .lambda as import("aws-cdk-lib/aws-lambda").Function;

historicalShareLambda.addEnvironment(
    "HISTORICAL_LOCATION_LOG_TABLE_NAME",
    historicalLocationLogTable.tableName,
);

historicalShareLambda.addEnvironment(
    "HISTORICAL_RECORDING_SESSION_TABLE_NAME",
    historicalRecordingSessionTable.tableName,
);

// Backward compatibility: released apps still call generated create mutations.
// Keep their GraphQL names/input/return types while enforcing sharing in Lambda.
for (const field of ["createLocationLog", "createRecordingSession"]) {
    const resolver = Object.values(backend.data.resources.cfnResources.cfnResolvers)
        .find(item => item.typeName === "Mutation" && item.fieldName === field);
    if (!resolver) throw new Error(`Missing generated resolver: ${field}`);
    const compat = new CfnFunctionConfiguration(Stack.of(resolver), `${field}CompatibilityFunction`, {
        apiId: resolver.apiId,
        name: `${field}Compatibility`,
        dataSourceName: "FnIngestLocationLogLambdaDataSource",
        functionVersion: "2018-05-29",
        requestMappingTemplate: `$util.toJson({"version":"2018-05-29","operation":"Invoke","payload":{"fieldName":"${field}","arguments":$ctx.args,"identity":$ctx.identity}})`,
        responseMappingTemplate: '#if($ctx.error) $util.error($ctx.error.message, $ctx.error.type) #end $util.toJson($ctx.result)',
    });
    resolver.pipelineConfig = { functions: [compat.attrFunctionId] };
}

// Account deletion is isolated from recording schemas/resolvers. No client table access.
const accountDeletionTable = new Table(historicalShareStack, "AccountDeletionTable", {
    timeToLiveAttribute: "expiresAt",
    partitionKey: { name: "userId", type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
    removalPolicy: RemovalPolicy.RETAIN,
});
accountDeletionTable.grantReadWriteData(accessLambda);
accessLambda.addEnvironment("ACCOUNT_DELETION_TABLE_NAME", accountDeletionTable.tableName);
for (const name of ["LiveLocation", "UserActivityMonthlySummary", "UserActivityWeeklySummary", "BackgroundLocationDebugLog", "UserDeviceSession"]) {
    const table = backend.data.resources.tables[name];
    table.grantReadWriteData(accessLambda);
    accessLambda.addEnvironment(`ACCOUNT_DELETE_${name.toUpperCase()}_TABLE_NAME`, table.tableName);
}
accountDeletionTable.grantReadData(liveLocationLambda);
liveLocationLambda.addEnvironment("ACCOUNT_DELETION_TABLE_NAME", accountDeletionTable.tableName);
