import { defineBackend } from "@aws-amplify/backend";
import { Function } from "aws-cdk-lib/aws-lambda";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { storage } from "./storage/resource";
import { liveLocationApi } from "./functions/live-location-api/resource";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
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
