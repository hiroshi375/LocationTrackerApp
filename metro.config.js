const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];

config.resolver.disableHierarchicalLookup = false;

// Local release evidence contains separate native projects and Pods.
const defaultBlockList = config.resolver.blockList;
config.resolver.blockList = [
    ...(Array.isArray(defaultBlockList) ? defaultBlockList : [defaultBlockList]),
    /[/\\]\.amplify[/\\](?:release-[^/\\]+|login-recording-incident-20261103)(?:[/\\]|$)/,
];

// Opt-in only for the side-by-side local incident APK. Never rewrite the
// production outputs file or let this test bundle connect to the production API.
if (process.env.ACLOG_ISOLATED_TEST === "incident104") {
    const fs = require("fs");
    const testOutputs = path.resolve(__dirname, ".amplify/incident-104/sandbox/amplify_outputs.json");
    const production = require("./amplify_outputs.json");
    const isolated = JSON.parse(fs.readFileSync(testOutputs, "utf8"));
    if (!isolated.auth?.user_pool_id || !isolated.data?.url ||
        isolated.auth.user_pool_id === production.auth.user_pool_id ||
        isolated.data.url === production.data.url) {
        throw new Error("Incident APK requires isolated Cognito and AppSync endpoints.");
    }
    const originalResolve = config.resolver.resolveRequest;
    config.resolver.resolveRequest = (context, moduleName, platform) => {
        if (moduleName.endsWith("/amplify_outputs.json")) {
            return { type: "sourceFile", filePath: testOutputs };
        }
        return originalResolve
            ? originalResolve(context, moduleName, platform)
            : context.resolveRequest(context, moduleName, platform);
    };
    config.cacheVersion = "incident104-isolated";
}

module.exports = config;
