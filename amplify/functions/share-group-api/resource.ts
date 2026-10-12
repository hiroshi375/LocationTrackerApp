import { defineFunction, secret } from "@aws-amplify/backend";

export const shareGroupApi = defineFunction({
    name: "share-group-api",
    entry: "./handler.ts",

    // AppSync Resolverと同じdataスタックへ配置
    resourceGroupName: "data",

    // 履歴共有の移行・検証処理に必要な実行時間を確保
    timeoutSeconds: 30,

    environment: {
        /*
         * RevenueCat REST APIをバックエンドから呼び出すためのSecret API Key。
         *
         * 値そのものはソースコードへ書かず、
         * Amplify Secretとして管理する。
         */
        REVENUECAT_SECRET_API_KEY: secret("REVENUECAT_SECRET_API_KEY"),

        /*
         * RevenueCatで作成済みのEntitlement ID。
         */
        REVENUECAT_ENTITLEMENT_ID: "premium",
    },
});
