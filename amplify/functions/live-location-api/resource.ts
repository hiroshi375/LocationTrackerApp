import { defineFunction } from "@aws-amplify/backend";

export const liveLocationApi = defineFunction({
    name: "live-location-api",
    entry: "./handler.ts",
    resourceGroupName: "data",
    timeoutSeconds: 15,
});
