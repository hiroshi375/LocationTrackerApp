import { defineFunction, secret } from "@aws-amplify/backend";

export const shareGroupApi = defineFunction({
    name: "share-group-api",
    entry: "./handler.ts",

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
