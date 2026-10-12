import { defineFunction } from "@aws-amplify/backend";

export const locationLogAuthTest = defineFunction({
    name: "location-log-auth-test",
    entry: "./handler.ts",
    resourceGroupName: "data",
});
