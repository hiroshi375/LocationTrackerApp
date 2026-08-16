import { defineFunction } from "@aws-amplify/backend";

export const shareGroupApi = defineFunction({
    name: "share-group-api",
    entry: "./handler.ts",
});
