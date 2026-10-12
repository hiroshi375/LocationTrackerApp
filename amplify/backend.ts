import { defineBackend } from "@aws-amplify/backend";
import { Function } from "aws-cdk-lib/aws-lambda";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { storage } from "./storage/resource";
import { liveLocationApi } from "./functions/live-location-api/resource";
import { locationLogAuthTest } from "./functions/location-log-auth-test/resource";

const backend = defineBackend({
    auth,
    data,
    storage,
    liveLocationApi,
    // auth、data、その他の既存設定は維持
    locationLogAuthTest,
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

// 検証用テーブル
const authTestTable = backend.data.resources.tables["LocationLogAuthTest"];
// Lambdaに検証用テーブルの書き込み権限を付与
authTestTable.grantWriteData(backend.locationLogAuthTest.resources.lambda);

// Lambdaの環境変数にテーブル名を設定
const authTestLambdaCfn =
    backend.locationLogAuthTest.resources.cfnResources.cfnFunction;

authTestLambdaCfn.addPropertyOverride(
    "Environment.Variables.AUTH_TEST_TABLE_NAME",
    authTestTable.tableName,
);
