// Local synthesis only, with deliberately non-production identity and no deployment.
import { resolve } from "node:path";
async function main() {
    process.env.CDK_CONTEXT_JSON = JSON.stringify({
        "amplify-backend-namespace": "locationtrackerapp",
        "amplify-backend-name": "localverify",
        "amplify-backend-type": "sandbox",
    });
    process.env.CDK_OUTDIR = resolve(".amplify/artifacts/group-access-verify");
    process.env.CDK_DEFAULT_ACCOUNT = "000000000000";
    process.env.CDK_DEFAULT_REGION = "ap-northeast-1";
    process.env.AWS_REGION = "ap-northeast-1";
    process.env.AWS_ACCESS_KEY_ID = "local";
    process.env.AWS_SECRET_ACCESS_KEY = "local";
    process.env.AWS_EC2_METADATA_DISABLED = "true";
    await import("../amplify/backend");
    process.emit("message", "amplifySynth", undefined);
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
