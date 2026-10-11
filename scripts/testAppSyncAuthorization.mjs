import { Amplify } from "aws-amplify";
import {
    signIn,
    signOut,
    getCurrentUser,
    fetchAuthSession,
} from "aws-amplify/auth";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const outputs = require("../amplify_outputs.json");

Amplify.configure(outputs);

const TARGET_USER_A = process.env.TEST_A_USER_ID;

const endpoint = outputs.data.url;

const username = process.env.TEST_B_USERNAME;
const password = process.env.TEST_B_PASSWORD;

if (!username || !password) {
    throw new Error("Bの認証情報が設定されていません。");
}

async function testQuery(userId, label, token) {
    const query = `
    query TestRecordingSessions(
      $userId: String!
      $nextToken: String
    ) {
      listRecordingSessionsByUserAndEndedAt(
        userId: $userId
        limit: 100
        nextToken: $nextToken
      ) {
        items {
          id
          userId
          owner
          sharedOwners
        }
        nextToken
      }
    }
  `;

    let nextToken = null;
    let page = 0;
    let recordCount = 0;
    const mismatchedUserIds = new Set();
    const seenTokens = new Set();
    const MAX_PAGES = 100;
    let completed = false;

    do {
        if (page >= MAX_PAGES) {
            throw new Error(`${label}: ${MAX_PAGES}ページを超えました`);
        }

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: token,
            },
            body: JSON.stringify({
                query,
                variables: {
                    userId,
                    nextToken,
                },
            }),
        });

        const result = await response.json();

        if (!response.ok || result.errors?.length) {
            console.log(label, {
                httpStatus: response.status,
                errors: result.errors?.map((e) => ({
                    errorType: e.errorType,
                    message: e.message,
                })),
            });
            throw new Error(`${label}: GraphQLリクエスト失敗`);
        }

        const data = result.data?.listRecordingSessionsByUserAndEndedAt;

        if (!data) {
            throw new Error(`${label}: 検索結果がありません`);
        }

        const items = data.items ?? [];
        page++;
        recordCount += items.length;

        for (const item of items) {
            if (item?.userId !== userId) {
                mismatchedUserIds.add(item?.userId ?? "null");
            }
        }

        nextToken = data.nextToken ?? null;

        console.log(label, {
            page,
            count: items.length,
            hasNextPage: Boolean(nextToken),
            mismatchedUserIds: [...mismatchedUserIds],
        });

        if (nextToken) {
            if (seenTokens.has(nextToken)) {
                throw new Error(`${label}: nextTokenが循環しています`);
            }
            seenTokens.add(nextToken);
        } else {
            completed = true;
        }
    } while (nextToken);

    if (userId === TARGET_USER_A && recordCount > 0) {
        throw new Error(
            "SECURITY_TEST_FAILED: 非共有ユーザーBがAのRecordingSession一覧を取得できました。",
        );
    }

    if (mismatchedUserIds.size > 0) {
        throw new Error(
            "SECURITY_TEST_FAILED: 指定ユーザー以外のRecordingSessionが返却されました。",
        );
    }

    console.log(label, {
        totalReturned: recordCount,
        pagesChecked: page,
        completed,
        mismatchedUserIds: [...mismatchedUserIds],
    });
}

const A_RECORD_ID = process.env.TEST_A_RECORD_ID;
const A_SESSION_ID = process.env.TEST_A_SESSION_ID;
if (!TARGET_USER_A || !A_RECORD_ID || !A_SESSION_ID) {
    throw new Error(
        "TEST_A_USER_ID、TEST_A_RECORD_ID、TEST_A_SESSION_IDを設定してください。",
    );
}

async function executeGraphQL(query, variables, token) {
    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: token,
        },
        body: JSON.stringify({ query, variables }),
    });

    const result = await response.json();
    const errors = result.errors ?? [];

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: GraphQLリクエスト失敗`);
    }

    if (errors.length > 0) {
        const allUnauthorized = errors.every(
            (error) => error.errorType === "Unauthorized",
        );

        if (allUnauthorized) {
            console.log(
                "AppSyncによる認可拒否:",
                errors.map((error) => ({
                    errorType: error.errorType,
                    message: error.message,
                })),
            );

            return { denied: true, data: result.data };
        }

        throw new Error(
            `GraphQLエラー: ${JSON.stringify(
                errors.map((error) => ({
                    errorType: error.errorType,
                    message: error.message,
                })),
            )}`,
        );
    }

    return { denied: false, data: result.data };
}

async function testGetRecordingSession(token) {
    console.log("\n=== getRecordingSession 認可テスト ===");

    const query = `
    query TestGetRecordingSession($id: ID!) {
      getRecordingSession(id: $id) {
        id
        userId
        owner
        sharedOwners
      }
    }
  `;

    const result = await executeGraphQL(query, { id: A_RECORD_ID }, token);

    if (result.denied) {
        console.log("結果: 認可拒否（正常）");
        return;
    }

    const data = result.data;

    const item = data?.getRecordingSession;

    if (item === null) {
        console.log("結果: 取得不可（正常）");
        return;
    }

    if (!item) {
        throw new Error("getRecordingSessionの応答形式が不正です");
    }

    throw new Error(
        "SECURITY_TEST_FAILED: 非共有ユーザーBがユーザーAのRecordingSessionを取得できました。",
    );
}

async function testListLocationLogs(token) {
    console.log("\n=== listLocationLogsBySessionAndRecordedAt 認可テスト ===");

    const query = `
    query TestLocationLogs(
      $recordingSessionId: String!
      $nextToken: String
    ) {
      listLocationLogsBySessionAndRecordedAt(
        recordingSessionId: $recordingSessionId
        limit: 100
        nextToken: $nextToken
      ) {
        items {
          id
          userId
          owner
          sharedOwners
        }
        nextToken
      }
    }
  `;

    let nextToken = null;
    let page = 0;
    let totalCount = 0;
    const seenTokens = new Set();
    const MAX_PAGES = 100;

    do {
        if (page >= MAX_PAGES) {
            throw new Error("LocationLogのページ数上限を超えました");
        }

        const response = await executeGraphQL(
            query,
            {
                recordingSessionId: A_SESSION_ID,
                nextToken,
            },
            token,
        );

        if (response.denied) {
            console.log("結果: 認可拒否（正常）");
            return;
        }

        const data = response.data;

        const result = data?.listLocationLogsBySessionAndRecordedAt;

        if (!result) {
            throw new Error("LocationLog検索結果がありません");
        }

        const items = result.items ?? [];
        page++;
        totalCount += items.length;

        console.log({
            page,
            count: items.length,
            hasNextPage: Boolean(result.nextToken),
            returnedOwners: [...new Set(items.map((item) => item?.userId))],
        });

        nextToken = result.nextToken ?? null;

        if (nextToken) {
            if (seenTokens.has(nextToken)) {
                throw new Error("nextTokenが循環しています");
            }
            seenTokens.add(nextToken);
        }
    } while (nextToken);

    console.log("LocationLogテスト完了:", {
        totalReturned: totalCount,
        pagesChecked: page,
        completed: true,
    });

    if (totalCount > 0) {
        throw new Error(
            "SECURITY_TEST_FAILED: 非共有ユーザーBがAのLocationLog一覧を取得できました。",
        );
    }

    console.log("判定: Aの位置ログは取得されませんでした（正常）");
}

async function testGetLocationLog(token) {
    const logId = process.env.TEST_A_LOCATION_LOG_ID;

    if (!logId) {
        console.log("\ngetLocationLog: テスト対象ID未指定のためスキップ");
        return;
    }

    console.log("\n=== getLocationLog 認可テスト ===");

    const query = `
    query TestGetLocationLog($id: ID!) {
      getLocationLog(id: $id) {
        id
        userId
        owner
        sharedOwners
      }
    }
  `;

    const response = await executeGraphQL(query, { id: logId }, token);

    if (response.denied) {
        console.log("結果: 認可拒否（正常）");
        return;
    }

    const item = response.data?.getLocationLog;

    if (item === null) {
        console.log("結果: 取得不可（正常）");
        return;
    }

    if (!item) {
        throw new Error("getLocationLogの応答形式が不正です");
    }

    throw new Error(
        "SECURITY_TEST_FAILED: 非共有ユーザーBがAのLocationLogを取得できました。",
    );
}

try {
    const login = await signIn({
        username,
        password,
        options: {
            authFlowType: "USER_SRP_AUTH",
        },
    });

    if (!login.isSignedIn) {
        console.log("追加認証が必要です:", login.nextStep?.signInStep);
        process.exitCode = 1;
    } else {
        const user = await getCurrentUser();
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();

        if (!token) {
            throw new Error("IDトークンを取得できませんでした。");
        }

        if (user.userId === TARGET_USER_A) {
            throw new Error("BではなくAとしてログインしています。");
        }

        console.log("認証成功（ユーザーID）:", user.userId);

        await testQuery(user.userId, "B自身の記録", token);
        await testQuery(TARGET_USER_A, "Aの記録をBで検索", token);
        await testGetRecordingSession(token);
        await testListLocationLogs(token);
        await testGetLocationLog(token);
    }
} catch (error) {
    console.error("テスト失敗:", error.message);
    process.exitCode = 1;
} finally {
    try {
        await signOut();
    } catch {
        // ログイン前のエラーなど
    }
}
