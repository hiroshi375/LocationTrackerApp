import { Amplify } from "aws-amplify";
import {
    signIn,
    signOut,
    fetchAuthSession,
} from "aws-amplify/auth";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const outputs = require("../.auth-test-output/amplify_outputs.json");

Amplify.configure(outputs);

const action = process.env.TEST_ACTION;
const username = process.env.TEST_USERNAME;
const password = process.env.TEST_PASSWORD;
const recordId = process.env.TEST_RECORD_ID;
const userAId = process.env.TEST_A_USER_ID;
const userBId = process.env.TEST_B_USER_ID;

if (!action || !username || !password) {
    throw new Error("TEST_ACTION、TEST_USERNAME、TEST_PASSWORDが必要です");
}

async function executeGraphQL(query, variables, token) {
    const response = await fetch(outputs.data.url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: token,
        },
        body: JSON.stringify({ query, variables }),
    });

    const result = await response.json();

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${JSON.stringify(result.errors)}`);
    }

    return result;
}

const fields = "id userId latitude testPointCount sharedOwners";

const CREATE = `
mutation($input: CreateLocationLogAuthTestInput!) {
    createLocationLogAuthTest(input: $input) {
        ${fields}
    }
}`;

const UPDATE = `
mutation($input: UpdateLocationLogAuthTestInput!) {
    updateLocationLogAuthTest(input: $input) {
        ${fields}
    }
}`;

const GET = `
query($id: ID!) {
    getLocationLogAuthTest(id: $id) {
        ${fields}
    }
}`;

try {
    const login = await signIn({
        username,
        password,
    });

    if (!login.isSignedIn) {
        throw new Error("サインインが完了していません");
    }

    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    if (!token) {
        throw new Error("IDトークンの取得に失敗しました");
    }

    let result;

    switch (action) {
        case "create":
            result = await executeGraphQL(
                CREATE,
                {
                    input: {
                        userId: userAId,
                        recordingSessionId: "auth-test-session-001",
                        latitude: 35.7,
                        longitude: 139.4,
                        testPointCount: 1,
                    },
                },
                token,
            );
            break;

        case "update-share":
            result = await executeGraphQL(
                UPDATE,
                {
                    input: {
                        id: recordId,
                        sharedOwners: [userBId],
                    },
                },
                token,
            );
            break;

        case "update-normal":
            result = await executeGraphQL(
                UPDATE,
                {
                    input: {
                        id: recordId,
                        testPointCount: 2,
                    },
                },
                token,
            );
            break;

        case "get":
            result = await executeGraphQL(
                GET,
                {
                    id: recordId,
                },
                token,
            );
            break;

        default:
            throw new Error(`不明なTEST_ACTION: ${action}`);
    }

    console.log(JSON.stringify(result, null, 2));

    const errors = result.errors ?? [];
    const item = result.data
        ? Object.values(result.data)[0]
        : null;

    if (action === "update-share") {
        if (
            !errors.length ||
            !errors.every((error) => error.errorType === "Unauthorized")
        ) {
            throw new Error(
                "SECURITY_TEST_FAILED: sharedOwnersの直接更新が拒否されませんでした",
            );
        }

        console.log("PASS: sharedOwners直接更新は禁止");
    } else if (action === "get") {
        if (errors.length || !item) {
            console.log("DENIED: レコードを参照できません");
        } else {
            console.log("PASS: レコード参照成功");
        }
    } else {
        if (errors.length || !item) {
            throw new Error(
                `TEST_FAILED: ${action} に失敗しました`,
            );
        }

        console.log(`PASS: ${action}`);
    }
} catch (error) {
    console.error("FAIL:", error.message);
    process.exitCode = 1;
} finally {
    await signOut().catch(() => {});
}
