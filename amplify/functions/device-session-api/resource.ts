import { defineFunction } from "@aws-amplify/backend";

export const deviceSessionApi = defineFunction({
    name: "device-session-api",
    entry: "./handler.ts",
});
