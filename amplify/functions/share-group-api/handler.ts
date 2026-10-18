import { advanceAccountDeletion } from "./accountDeletion";
import { assertAccountNotDeleting } from "./accountDeletionGuard";
import { createLegacyLocationLog, createLegacyRecordingSession } from "./legacyRecordingWrite";
import { prepareStoppedHistoricalRecovery } from "./historicalRecoveryAdmission";
import { readSessionLogs, withSessionLogInventory, resetSessionLogInventory } from "./sessionLogReader";
import { getRow, scanRows, tables, gate, withGroupLocks, historicalWriteGroups, fencedWrite } from "./groupAccessStore";
import { assertRecordOwner, requestGroupAccessChange, getGroupJob, groupJobView, resumeGroupJob, cancelGroupJob, advanceGroupJobBatch, reconcileGroupJobs } from "./groupAccessOperation";
import { ingestLocationLog } from "./locationLogIngest";
import { createHash, randomInt, randomUUID } from "node:crypto";

import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
    DynamoDBDocumentClient,
    GetCommand,
    UpdateCommand,
    BatchGetCommand,
} from "@aws-sdk/lib-dynamodb";

import { env } from "$amplify/env/share-group-api";

import type { Schema } from "../../data/resource";
import {
    calculateEffectiveSharedOwners,
    areSharedOwnersEqual,
} from "./historicalShareProjection";

import {
    beginHistoricalShareOperation,
    markHistoricalShareApplying,
    completeHistoricalShareOperation,
    failHistoricalShareOperation,
    markHistoricalShareGrantManaged,
    commitLegacyShareGrantsAtomically,
    getHistoricalShareOperation,
    recordHistoricalShareIntent,
    markHistoricalGrantWriteConfirmed,
    assessHistoricalShareRecovery,
    beginHistoricalShareRecovery,
} from "./historicalShareOperation";

import type { HistoricalShareOperation } from "./historicalShareOperation";

/*
 * Lambda FunctionからAmplify Dataへアクセスするための設定。
 */
const { resourceConfig, libraryOptions } =
    await getAmplifyDataClientConfig(env);

Amplify.configure(resourceConfig, libraryOptions);

const client = generateClient<Schema>();

// Grant投影はAppSyncのフィールド認可を通さず、IAMで許可されたLambdaだけが更新する。
const projectionDb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function projectionTableName(kind: "session" | "log"): string {
    const value =
        kind === "session"
            ? process.env.HISTORICAL_RECORDING_SESSION_TABLE_NAME
            : process.env.HISTORICAL_LOCATION_LOG_TABLE_NAME;

    if (!value) {
        throw new Error(
            kind === "session"
                ? "HISTORICAL_RECORDING_SESSION_TABLE_NAME が未設定です。"
                : "HISTORICAL_LOCATION_LOG_TABLE_NAME が未設定です。",
        );
    }

    return value;
}

/**
 * 強整合読み取りと条件付き更新で、同時変更を検知した場合は安全に停止する。
 * 全項目の上書きは行わず、sharedOwnersだけを変更する。
 */
async function updateProjectedSharedOwners(input: {
    kind: "session" | "log";
    id: string;
    ownerUserId: string;
    recordingSessionId: string;
    expectedOwners: readonly (string | null)[] | null | undefined;
    nextOwners: readonly string[];
}): Promise<void> {
    const tableName = projectionTableName(input.kind);
    const result = await projectionDb.send(
        new GetCommand({
            TableName: tableName,
            Key: { id: input.id },
            ConsistentRead: true,
            ProjectionExpression: "#id, #userId, #sessionId, #owners",
            ExpressionAttributeNames: {
                "#id": "id",
                "#userId": "userId",
                "#sessionId": "recordingSessionId",
                "#owners": "sharedOwners",
            },
        }),
    );
    const item = result.Item;
    if (
        !item ||
        item.userId !== input.ownerUserId ||
        item.recordingSessionId !== input.recordingSessionId
    ) {
        throw new Error(
            `投影対象レコードの所有者・セッションが一致しません: ${input.id}`,
        );
    }
    const raw = item.sharedOwners;
    if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
        throw new Error(`sharedOwnersの保存形式が不正です: ${input.id}`);
    }
    const existing = (raw ?? []) as (string | null)[];
    if (
        !areSharedOwnersEqual(
            existing as string[],
            (input.expectedOwners ?? []) as string[],
        )
    ) {
        throw new Error(
            `投影対象がスナップショット取得後に変更されました: ${input.id}`,
        );
    }
    if (areSharedOwnersEqual(existing as string[], input.nextOwners)) return;

    // 現在の配列値とユーザー/セッションIDがすべて一致するときだけ更新。
    const conditionOwners =
        raw === undefined
            ? "attribute_not_exists(#owners)"
            : raw === null
              ? "#owners = :nullOwners"
              : "#owners = :beforeOwners";
    const values: Record<string, unknown> = {
        ":owner": input.ownerUserId,
        ":session": input.recordingSessionId,
        ":newOwners": [...input.nextOwners],
    };
    if (raw === null) values[":nullOwners"] = null;
    if (Array.isArray(raw)) values[":beforeOwners"] = raw;
    try {
        await fencedWrite([{ Update: {
                TableName: tableName,
                Key: { id: input.id },
                UpdateExpression: "SET #owners = :newOwners",
                ConditionExpression:
                    "attribute_exists(#id) AND #userId = :owner AND " +
                    "#sessionId = :session AND " +
                    conditionOwners,
                ExpressionAttributeNames: {
                    "#id": "id",
                    "#userId": "userId",
                    "#sessionId": "recordingSessionId",
                    "#owners": "sharedOwners",
                },
                ExpressionAttributeValues: values,
            } }]);
    } catch (error) {
        if (
            error instanceof Error &&
            error.name === "ConditionalCheckFailedException"
        ) {
            throw new Error(
                `同時変更を検出したため共有反映を停止しました: ${input.id}`,
            );
        }
        throw error;
    }
}

/*
 * 招待コードで使用する文字。
 *
 * 0 / O / 1 / I など、
 * 見間違えやすい文字は除外している。
 */
const INVITE_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/*
 * 招待コードの文字数。
 */
const INVITE_CODE_LENGTH = 8;

/*
 * 招待コード生成時の最大リトライ回数。
 */
const INVITE_CODE_GENERATION_MAX_ATTEMPTS = 10;

type BackendSubscriptionTier = "FREE" | "PREMIUM";

type BackendSubscriptionLimits = {
    maxOwnedShareGroups: number | null;
    maxUsersPerShareGroup: number | null;
};

type RevenueCatEntitlement = {
    expires_date?: string | null;
    purchase_date?: string | null;
    product_identifier?: string | null;
};

type RevenueCatSubscriber = {
    entitlements?: Record<string, RevenueCatEntitlement | undefined>;
};

type RevenueCatCustomerResponse = {
    subscriber?: RevenueCatSubscriber;
};

type ShareGroupMemberDeleteListResult = {
    data?:
        | {
              membershipId: string;
          }[]
        | null;
    errors?: readonly unknown[] | null;
    nextToken?: string | null;
};

const BACKEND_SUBSCRIPTION_LIMITS: Record<
    BackendSubscriptionTier,
    BackendSubscriptionLimits
> = {
    FREE: {
        maxOwnedShareGroups: 2,
        maxUsersPerShareGroup: 5,
    },
    PREMIUM: {
        maxOwnedShareGroups: 10,
        maxUsersPerShareGroup: 20,
    },
};

async function hasRevenueCatPremiumEntitlement(
    userId: string,
): Promise<boolean> {
    const apiKey = env.REVENUECAT_SECRET_API_KEY;

    const entitlementId = env.REVENUECAT_ENTITLEMENT_ID || "premium";

    if (!apiKey) {
        console.error(
            "[ShareGroup] RevenueCat secret API key is not configured.",
        );

        return false;
    }

    const url =
        "https://api.revenuecat.com/v1/subscribers/" +
        encodeURIComponent(userId);

    try {
        const response = await fetch(url, {
            method: "GET",
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${apiKey}`,
            },

            /*
             * RevenueCat側で通信障害が発生しても、
             * Lambda処理を長時間止めない。
             */
            signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
            console.error("[ShareGroup] RevenueCat request failed:", {
                userId,
                status: response.status,
                statusText: response.statusText,
            });

            return false;
        }

        const customer = (await response.json()) as RevenueCatCustomerResponse;

        const entitlement = customer.subscriber?.entitlements?.[entitlementId];

        if (!entitlement) {
            console.log("[ShareGroup] RevenueCat entitlement not found:", {
                userId,
                entitlementId,
            });

            return false;
        }

        /*
         * 今回のpremium_lifetimeは買い切り商品のため、
         * expires_dateがnullなら有効と判定する。
         *
         * 将来サブスクリプションを追加した場合も、
         * 有効期限が未来ならPremiumとして扱える。
         */
        if (!entitlement.expires_date) {
            console.log(
                "[ShareGroup] RevenueCat lifetime entitlement active:",
                {
                    userId,
                    entitlementId,
                    productIdentifier: entitlement.product_identifier ?? null,
                },
            );

            return true;
        }

        const expiresAtMs = new Date(entitlement.expires_date).getTime();

        const isActive =
            Number.isFinite(expiresAtMs) && expiresAtMs > Date.now();

        console.log("[ShareGroup] RevenueCat entitlement result:", {
            userId,
            entitlementId,
            expiresDate: entitlement.expires_date,
            isActive,
        });

        return isActive;
    } catch (error) {
        console.error("[ShareGroup] RevenueCat request error:", {
            userId,
            error,
        });

        /*
         * RevenueCatの確認に失敗した場合は、
         * Premium機能を誤って開放しないようFREEへ倒す。
         */
        return false;
    }
}

/*
 * 現時点ではRevenueCat未導入のため、
 * すべてのユーザーをFREEとして扱う。
 *
 * Phase 5で、この関数の中身だけを
 * RevenueCat / entitlement判定へ置き換える。
 */
async function getSubscriptionTierForUser(
    userId: string,
): Promise<BackendSubscriptionTier> {
    /*
     * 管理者は課金状態に関係なく
     * Premium相当の機能を利用可能とする。
     */
    const profile = await loadUserProfile(userId);

    if (profile.role === "admin") {
        console.log("[ShareGroup] Admin user -> PREMIUM", {
            userId,
        });

        return "PREMIUM";
    }

    /*
     * 一般ユーザーはRevenueCatの
     * premium Entitlementで判定する。
     */
    const hasPremium = await hasRevenueCatPremiumEntitlement(userId);

    const tier: BackendSubscriptionTier = hasPremium ? "PREMIUM" : "FREE";

    console.log("[ShareGroup] RevenueCat subscription tier:", {
        userId,
        tier,
    });

    return tier;
}

function getBackendSubscriptionLimits(
    tier: BackendSubscriptionTier,
): BackendSubscriptionLimits {
    return BACKEND_SUBSCRIPTION_LIMITS[tier];
}

/*
 * 招待コードを生成する。
 *
 * 例:
 *   AB7K92FD
 */
function generateInviteCode(): string {
    let result = "";

    for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
        result += INVITE_CODE_CHARS[randomInt(0, INVITE_CODE_CHARS.length)];
    }

    return result;
}

/*
 * ユーザーが入力した招待コードを正規化する。
 *
 * 以下を吸収する。
 *
 * - 小文字 → 大文字
 * - 前後スペース
 * - 途中のスペース
 * - ハイフン
 *
 * 例:
 *
 * "ab7k-92fd"
 *
 * ↓
 *
 * "AB7K92FD"
 */
function normalizeInviteCode(value: string): string {
    return value.trim().toUpperCase().replace(/[\s-]/g, "");
}

/*
 * 招待コードをSHA-256でハッシュ化する。
 *
 * DynamoDBには招待コードそのものを保存せず、
 * このハッシュ値だけを保存する。
 */
function hashInviteCode(inviteCode: string): string {
    return createHash("sha256")
        .update(normalizeInviteCode(inviteCode))
        .digest("hex");
}

/*
 * GraphQLリクエストを行った
 * Cognitoログインユーザーを取得する。
 */
function getCaller(event: any): {
    userId: string;
    username: string;
} {
    const identity = event.identity;

    const sub = identity?.sub;

    if (!sub || typeof sub !== "string") {
        throw new Error("ログインユーザーを特定できません。");
    }

    return {
        userId: sub,
        username:
            typeof identity?.username === "string" ? identity.username : "",
    };
}

/**
 * Cognito Adminsグループ所属を検証する。
 *
 * UserProfile.roleは認可判定には使用しない。
 */
function assertHistoricalMigrationAdmin(event: any): string {
    const { userId } = getCaller(event);

    const identity = event.identity;
    const claims = identity?.claims;

    const rawGroups = claims?.["cognito:groups"] ?? identity?.groups;

    const groups: string[] = Array.isArray(rawGroups)
        ? rawGroups.filter(
              (group): group is string => typeof group === "string",
          )
        : [];

    if (!groups.includes("Admins")) {
        throw new Error("履歴共有の移行診断を実行する権限がありません。");
    }

    return userId;
}

/**
 * 管理者専用の旧共有データ移行診断。
 *
 * ownerUserIdは診断対象の所有者。
 * 管理者本人のIDとは限らない。
 *
 * 読み取り処理のみを実行する。
 */
async function diagnoseHistoricalShareMigrationAdmin(
    event: Parameters<
        Schema["diagnoseHistoricalShareMigrationAdmin"]["functionHandler"]
    >[0],
): Promise<HistoricalShareMigrationDiagnosis> {
    const adminUserId = assertHistoricalMigrationAdmin(event);

    const { ownerUserId, recordingSessionId } = event.arguments;

    if (!ownerUserId?.trim() || !recordingSessionId?.trim()) {
        throw new Error("復旧診断の対象指定が不正です。");
    }

    // 初回の承認済み移行対象に限定
    const approvedOwnerUserId = "3704aac8-90e1-70e4-bc50-6acd159a5049";

    const approvedRecordingSessionId = "session-1789508764591-byar86l3";

    if (
        ownerUserId !== approvedOwnerUserId ||
        recordingSessionId !== approvedRecordingSessionId
    ) {
        throw new Error("承認済みの初回移行対象ではありません。");
    }

    const diagnosis = await diagnoseHistoricalShareMigration(
        ownerUserId,
        recordingSessionId,
    );

    console.info("[HistoricalShareMigration] Admin diagnosis executed", {
        adminUserId,
        ownerUserId,
        recordingSessionRecordId: diagnosis.recordingSessionRecordId,
        classification: diagnosis.classification,
        locationLogCount: diagnosis.locationLogCount,
    });

    return diagnosis;
}

type OwnedRecordingSession = {
    id: string;
    userId: string;
    recordingSessionId: string;
};

async function getOwnedRecordingSession(
    userId: string,
    recordingSessionId: string,
): Promise<OwnedRecordingSession> {
    const normalized = recordingSessionId.trim();
    if (!normalized) throw new Error("recordingSessionIdが空です。");
    const deterministic = await getRow(tables.sessions(), { id: `recording-session:${userId}:${normalized}` });
    const matches = deterministic ? [deterministic] : await scanRows(tables.sessions(), row => row.userId === userId && row.recordingSessionId === normalized);
    if (matches.length !== 1 || matches[0].recordingSessionId !== normalized) throw new Error("共有対象の履歴を一意に確認できません。");
    assertRecordOwner(matches[0], userId);
    return { id: matches[0].id, userId, recordingSessionId: normalized };
}

/*
 * UserProfileを取得する。
 *
 * 現在のUserProfileにはuserIdのGSIがないため、
 * 今回は既存モデルを変更せず、
 * list + filterで取得する。
 *
 * グループ作成・参加時のみ使うため、
 * 通常の位置記録処理には影響しない。
 */
async function loadUserProfile(userId: string) {
    const result = await client.models.UserProfile.list({
        filter: {
            userId: {
                eq: userId,
            },
        },
        limit: 1000,
    });

    if (result.errors) {
        console.error("[ShareGroup] UserProfile list errors:", result.errors);

        throw new Error("ユーザープロフィールを取得できませんでした。");
    }

    const profile = (result.data ?? []).find((item) => item.userId === userId);

    if (!profile) {
        throw new Error("ユーザープロフィールが存在しません。");
    }

    // Owner identifiers must come from the authenticated sub, never a mutable profile field.
    const ownerValue = userId;

    return {
        ...profile,
        ownerValue,
    };
}

/*
 * グループOWNERのプランに応じて、
 * 所有できる共有グループ数の上限を確認する。
 *
 * 既存のownerUserId GSIのみ使用するため、
 * DynamoDB schema変更は不要。
 */
async function assertCanCreateShareGroup(userId: string): Promise<void> {
    const tier = await getSubscriptionTierForUser(userId);

    const maxOwnedShareGroups =
        getBackendSubscriptionLimits(tier).maxOwnedShareGroups;

    /*
     * nullなら上限なし。
     */
    if (maxOwnedShareGroups === null) {
        return;
    }

    let nextToken: string | null = null;
    let activeOwnedGroupCount = 0;

    do {
        const result = (await (
            client.models.ShareGroup as any
        ).listShareGroupsByOwner(
            {
                ownerUserId: userId,
            },
            {
                limit: 100,
                nextToken: nextToken ?? undefined,
            },
        )) as {
            data?:
                | {
                      groupId: string;
                      isActive?: boolean | null;
                  }[]
                | null;
            errors?: unknown;
            nextToken?: string | null;
        };

        if (result.errors) {
            console.error(
                "[ShareGroup] Owned group limit check errors:",
                result.errors,
                {
                    userId,
                },
            );

            throw new Error("共有グループの作成上限を確認できませんでした。");
        }

        for (const group of result.data ?? []) {
            /*
             * 無効化済みグループは上限数に含めない。
             */
            if (group.isActive !== true) {
                continue;
            }

            activeOwnedGroupCount += 1;

            /*
             * 上限に到達した時点で、
             * それ以上Queryする必要はない。
             */
            if (activeOwnedGroupCount >= maxOwnedShareGroups) {
                const planName =
                    tier === "PREMIUM" ? "Premiumプラン" : "Freeプラン";

                throw new Error(
                    `${planName}では共有グループを${maxOwnedShareGroups}件まで作成できます。`,
                );
            }
        }

        nextToken = result.nextToken ?? null;
    } while (nextToken);
}

/*
 * 重複していない招待コードを生成する。
 */
async function createUniqueInviteCode(): Promise<{
    inviteCode: string;
    inviteCodeHash: string;
}> {
    for (
        let attempt = 0;
        attempt < INVITE_CODE_GENERATION_MAX_ATTEMPTS;
        attempt += 1
    ) {
        const inviteCode = generateInviteCode();
        const inviteCodeHash = hashInviteCode(inviteCode);

        const result =
            await client.models.ShareGroup.listShareGroupsByInviteCodeHash(
                {
                    inviteCodeHash,
                },
                {
                    limit: 1,
                },
            );

        if (result.errors) {
            console.error(
                "[ShareGroup] Invite code duplicate check errors:",
                result.errors,
            );

            throw new Error("招待コードの重複確認に失敗しました。");
        }

        if ((result.data ?? []).length === 0) {
            return {
                inviteCode,
                inviteCodeHash,
            };
        }
    }

    throw new Error("招待コードを生成できませんでした。再度お試しください。");
}

/*
 * グループを作成する。
 */
async function createShareGroup(
    event: Parameters<
        Schema["createShareGroupWithInviteCode"]["functionHandler"]
    >[0],
) {
    const { userId } = getCaller(event);

    const name = event.arguments.name.trim();

    if (!name) {
        throw new Error("グループ名を入力してください。");
    }

    /*
     * Freeプランの所有グループ数上限を確認する。
     *
     * 制限超過の場合は、
     * ShareGroupやShareGroupMemberを作成する前に終了する。
     */
    await assertCanCreateShareGroup(userId);

    /*
     * グループオーナーのプロフィールを取得する。
     */
    const profile = await loadUserProfile(userId);

    /*
     * 招待コードを生成する。
     */
    const { inviteCode, inviteCodeHash } = await createUniqueInviteCode();

    const groupId = randomUUID();
    const now = new Date().toISOString();

    /*
     * ShareGroup作成。
     */
    await withGroupLocks([groupId], () => fencedWrite([
        { Put: { TableName: tables.groups(), Item: { groupId, name, ownerUserId: userId, inviteCodeHash, isActive: true, lifecycle: "ACTIVE", createdAt: now, updatedAt: now, __typename: "ShareGroup" }, ConditionExpression: "attribute_not_exists(groupId)" } },
        { Put: { TableName: tables.members(), Item: { membershipId: `${groupId}#${userId}`, groupId, userId, ownerValue: profile.ownerValue, displayName: profile.displayName, email: profile.email, iconImagePath: profile.iconImagePath, role: "OWNER", joinedAt: now, createdAt: now, updatedAt: now, __typename: "ShareGroupMember" }, ConditionExpression: "attribute_not_exists(membershipId)" } },
    ]));

    console.log("[ShareGroup] Group created:", {
        groupId,
        ownerUserId: userId,
    });

    return {
        success: true,
        message: "グループを作成しました。",
        groupId,
        groupName: name,

        /*
         * 招待コードは作成時だけ返す。
         *
         * DBにはハッシュ値しか保存しない。
         */
        inviteCode,
    };
}

/*
 * 招待コードを使ってグループへ参加する。
 */
async function joinShareGroupByInviteCode(
    event: Parameters<
        Schema["joinShareGroupByInviteCode"]["functionHandler"]
    >[0],
) {
    const { userId } = getCaller(event);

    const inviteCode = normalizeInviteCode(event.arguments.inviteCode);

    if (!inviteCode) {
        throw new Error("招待コードを入力してください。");
    }

    if (inviteCode.length !== INVITE_CODE_LENGTH) {
        throw new Error("招待コードの形式が正しくありません。");
    }

    const inviteCodeHash = hashInviteCode(inviteCode);

    /*
     * GSIを使って招待コードに該当する
     * ShareGroupを取得する。
     */
    const groupResult =
        await client.models.ShareGroup.listShareGroupsByInviteCodeHash(
            {
                inviteCodeHash,
            },
            {
                limit: 10,
            },
        );

    if (groupResult.errors) {
        console.error(
            "[ShareGroup] Invite code lookup errors:",
            groupResult.errors,
        );

        throw new Error("招待コードの確認に失敗しました。");
    }

    /*
     * 有効なグループのみ参加可能。
     */
    const group = (groupResult.data ?? []).find(
        (item) => item.isActive === true,
    );

    if (!group) {
        throw new Error("招待コードが正しくないか、グループが無効です。");
    }

    /*
     * groupId + userId をmembershipIdとする。
     */
    return withGroupLocks([group.groupId], async () => {
        const currentGroup = await getRow(tables.groups(), { groupId: group.groupId });
        if (currentGroup?.isActive !== true || currentGroup.inviteCodeHash !== inviteCodeHash) throw new Error("グループが無効または招待コードが更新されています。");
        const membershipId = `${group.groupId}#${userId}`;
        const existing = await getRow(tables.members(), { membershipId });
        if (existing) return { success: true, message: "すでにこのグループへ参加しています。", groupId: group.groupId, groupName: group.name };
        await assertCanJoinShareGroup(group.groupId, group.ownerUserId);
        const profile = await loadUserProfile(userId);
        const timestamp = new Date().toISOString();
        await fencedWrite([{ Put: { TableName: tables.members(), Item: { membershipId, groupId: group.groupId, userId, ownerValue: profile.ownerValue, displayName: profile.displayName, email: profile.email, iconImagePath: profile.iconImagePath, role: "MEMBER", joinedAt: timestamp, createdAt: timestamp, updatedAt: timestamp, __typename: "ShareGroupMember" }, ConditionExpression: "attribute_not_exists(membershipId)" } }]);
        return { success: true, message: "グループへ参加しました。", groupId: group.groupId, groupName: group.name };
    });
}

/*
 * 自分と同じグループに所属している
 * 共有候補ユーザーを取得する。
 *
 * UserProfile全件をクライアントへ返さないための
 * 重要な処理。
 */
async function listMyShareCandidates(
    event: Parameters<Schema["listMyShareCandidates"]["functionHandler"]>[0],
) {
    const { userId } = getCaller(event);

    /*
     * 自分が所属しているグループを取得する。
     */
    const myMembershipResult =
        await client.models.ShareGroupMember.listShareGroupMembershipsByUser(
            {
                userId,
            },
            {
                limit: 1000,
            },
        );

    if (myMembershipResult.errors) {
        console.error(
            "[ShareGroup] My memberships query errors:",
            myMembershipResult.errors,
        );

        throw new Error("所属グループを取得できませんでした。");
    }

    const myMemberships = myMembershipResult.data ?? [];

    if (myMemberships.length === 0) {
        return [];
    }

    /*
     * ShareGroupMemberからは、
     * 「誰が同じグループに所属しているか」と
     * ownerValueだけを取得する。
     *
     * displayName / email / iconImagePath は
     * ShareGroupMemberに保存されているコピーを使用しない。
     */
    const membershipCandidateMap = new Map<
        string,
        {
            userId: string;
            ownerValue: string;
        }
    >();

    for (const membership of myMemberships) {
        /*
         * 削除済み・無効化済みグループのMembershipが
         * 万一残っていても共有候補へ含めない。
         */
        if ((await gate(membership.groupId))?.activeJobId) continue;
        const groupResult = await client.models.ShareGroup.get({
            groupId: membership.groupId,
        });

        if (groupResult.errors?.length) {
            console.error(
                "[ShareGroup] Share candidate group lookup errors:",
                groupResult.errors,
                {
                    groupId: membership.groupId,
                },
            );

            continue;
        }

        if (!groupResult.data || groupResult.data.isActive !== true) {
            continue;
        }

        const groupMembersResult =
            await client.models.ShareGroupMember.listShareGroupMembersByGroup(
                {
                    groupId: membership.groupId,
                },
                {
                    limit: 1000,
                },
            );

        if (groupMembersResult.errors) {
            console.error(
                "[ShareGroup] Group members query errors:",
                groupMembersResult.errors,
                {
                    groupId: membership.groupId,
                },
            );

            throw new Error("グループメンバーを取得できませんでした。");
        }

        for (const member of groupMembersResult.data ?? []) {
            /*
             * 自分自身は共有候補から除外する。
             */
            if (member.userId === userId) {
                continue;
            }

            if (!member.ownerValue) {
                continue;
            }

            /*
             * 同じユーザーと複数グループでつながっていても
             * userId単位で1件だけ保持する。
             */
            membershipCandidateMap.set(member.userId, {
                userId: member.userId,
                ownerValue: member.ownerValue,
            });
        }
    }

    /*
     * ShareGroupMemberで確定した共有候補について、
     * 最新のUserProfileを取得する。
     */
    const candidateEntries = await Promise.all(
        [...membershipCandidateMap.values()].map(async (candidate) => {
            const profileResult = await client.models.UserProfile.list({
                filter: {
                    userId: {
                        eq: candidate.userId,
                    },
                },
                limit: 100,
            });

            if (profileResult.errors) {
                console.error(
                    "[ShareGroup] UserProfile lookup errors:",
                    profileResult.errors,
                    {
                        userId: candidate.userId,
                    },
                );

                /*
                 * 1人のプロフィール取得失敗で
                 * 共有候補一覧全体を失敗させない。
                 */
                return null;
            }

            const profile = (profileResult.data ?? []).find(
                (item) => item.userId === candidate.userId,
            );

            /*
             * Cognito削除済みなどでUserProfileが存在しない場合は、
             * 古いShareGroupMemberを候補として表示しない。
             */
            if (!profile) {
                console.warn(
                    "[ShareGroup] UserProfile not found for membership:",
                    {
                        userId: candidate.userId,
                    },
                );

                return null;
            }

            return {
                userId: candidate.userId,

                /*
                 * 共有権限判定に使うownerValueは
                 * Membership側を正とする。
                 */
                ownerValue: candidate.ownerValue,

                /*
                 * 表示情報は最新UserProfileを正とする。
                 */
                displayName: profile.displayName ?? undefined,
                email: profile.email ?? undefined,
                iconImagePath: profile.iconImagePath ?? undefined,
            };
        }),
    );

    return candidateEntries
        .filter(
            (
                candidate,
            ): candidate is {
                userId: string;
                ownerValue: string;
                displayName: string | undefined;
                email: string | undefined;
                iconImagePath: string | undefined;
            } => candidate !== null,
        )
        .sort((a, b) => {
            const aName = a.displayName ?? a.email ?? "";
            const bName = b.displayName ?? b.email ?? "";

            return aName.localeCompare(bName, "ja");
        });
}

/*
 * AppSyncカスタムQuery / Mutationの
 * エントリポイント。
 *
 * fieldNameによって処理を振り分ける。
 */
/**
 * 1つのLambdaを複数のCustom Query / Mutationから利用するため、
 * AppSyncから渡されるfieldNameで処理を振り分ける。
 */
async function runHistoricalWrite(event: any, bulk: boolean, write: () => Promise<boolean>): Promise<boolean> {
    const userId = getCaller(event).userId;
    const { recordingSessionId, groupId } = event.arguments;
    const session = await getOwnedRecordingSession(userId, recordingSessionId);
    if (bulk && (!Array.isArray(event.arguments.recipientUserIds) || event.arguments.recipientUserIds.length === 0 || event.arguments.recipientUserIds.some((value: unknown) => typeof value !== "string" || !value.trim() || value === userId))) throw new Error("共有先が不正です。");
    if (!bulk && event.arguments.enabled === false) {
        const grant = await getRow(tables.grants(), { grantId: makeHistoricalGrantId(session.id, groupId, event.arguments.recipientUserId) });
        const membership = await getRow(tables.members(), { membershipId: `${groupId}#${userId}` });
        if ((!grant || grant.ownerUserId !== userId) && membership?.userId !== userId) throw new Error("このグループの共有を変更する権限がありません。");
    } else {
        for (const recipient of bulk ? [...new Set(event.arguments.recipientUserIds ?? [])] : [event.arguments.recipientUserId]) {
            await validateHistoricalRecipient(userId, groupId, String(recipient));
        }
    }
    return withGroupLocks(await historicalWriteGroups(userId, groupId, recordingSessionId), () =>
        withSessionLogInventory(async () => {
            const previous = await getHistoricalShareOperation(session.id);
            if (previous && previous.status !== "COMPLETED") {
                await prepareStoppedHistoricalRecovery(previous, userId, event.arguments);
                await recoverFailedHistoricalShareProjection(userId, recordingSessionId, previous.operationId);
                // This retry repeats the persisted intent; do not create a second operation.
                if (!bulk) return true;
            }
            return write();
        }),
    );
}

export const handler = async (event: any) => {
    if (event?.reconcileGroupAccess === true && !event?.identity) { await reconcileGroupJobs(); return; }
    if (Array.isArray(event?.Records) && !event?.identity) {
        for (const record of event.Records) {
            const image = record?.dynamodb?.NewImage;
            if (record.eventSource === "aws:dynamodb" && image?.recordType?.S === "JOB" && image?.status?.S === "READY") {
                await advanceGroupJobBatch(image.groupId.S, image.operationId.S);
            }
        }
        return;
    }
    const operation =
        event?.fieldName ??
        event?.info?.fieldName ??
        event?.requestContext?.fieldName ??
        null;

    console.log(
        "[ShareGroupApi] event summary:",
        JSON.stringify({
            typeName: event?.typeName ?? null,
            fieldName: event?.fieldName ?? null,
            operation,
            argumentNames: Object.keys(event?.arguments ?? {}),
            userId: event?.identity?.sub ?? event?.identity?.username ?? null,
        }),
    );

    if (operation === "deleteCurrentAccountData") {
        if (Object.keys(event.arguments ?? {}).length) throw new Error("削除対象は本人に限定されます。");
        const result = await advanceAccountDeletion(getCaller(event).userId);
        console.log("[AccountDeletion] progress", result);
        return result;
    }
    // Deny only accounts with an explicit deletion request; existing save API contracts are unchanged.
    const recoveryOperations = ["resumeHistoricalShareOperation", "resumeShareGroupAccessOperation", "getShareGroupAccessOperation", "listMyShareGroupAccessOperations"];
    if (!recoveryOperations.includes(operation)) await assertAccountNotDeleting(getCaller(event).userId);
    const recipients = [event.arguments?.recipientUserId, ...(event.arguments?.recipientUserIds ?? [])];
    for (const recipient of recipients) if (typeof recipient === "string") await assertAccountNotDeleting(recipient);

    switch (operation) {
        case "createShareGroupWithInviteCode":
            return await createShareGroup(event);

        case "joinShareGroupByInviteCode":
            return await joinShareGroupByInviteCode(event);

        case "listMyShareCandidates":
            return await listMyShareCandidates(event);

        case "listHistoricalShareRecipients":
            return await listHistoricalShareRecipients(event);

        case "listMyShareGroups":
            return await listMyShareGroups(event);

        case "regenerateShareGroupInviteCode": {
            const group = await getRow(tables.groups(), { groupId: event.arguments.groupId });
            if (group?.ownerUserId !== getCaller(event).userId || group?.isActive !== true) throw new Error("招待コードを再発行する権限がありません。");
            return await withGroupLocks([event.arguments.groupId], () => regenerateShareGroupInviteCode(event));
        }

        case "deleteOwnedShareGroup":
            return await requestGroupAccessChange(getCaller(event).userId, event.arguments.groupId, "DELETE", undefined, event.arguments.requestId);
        case "deactivateOwnedShareGroup":
            return await requestGroupAccessChange(getCaller(event).userId, event.arguments.groupId, "DEACTIVATE", undefined, event.arguments.requestId);
        case "leaveShareGroup":
            return await requestGroupAccessChange(getCaller(event).userId, event.arguments.groupId, "LEAVE", undefined, event.arguments.requestId);
        case "removeShareGroupMember":
            return await requestGroupAccessChange(getCaller(event).userId, event.arguments.groupId, "REMOVE", event.arguments.targetUserId, event.arguments.requestId);
        case "listMyShareGroupAccessOperations": {
            const caller = getCaller(event).userId;
            const jobs = await scanRows(tables.jobs(), row => row.recordType === "JOB" && (!["COMPLETED", "CANCELLED"].includes(row.status) || Date.now() - Date.parse(row.updatedAt) < 600000) && (row.requesterUserId === caller || row.groupOwnerUserId === caller));
            return jobs.map(groupJobView);
        }
        case "getShareGroupAccessOperation":
            return groupJobView(await getGroupJob(event.arguments.groupId, event.arguments.operationId, getCaller(event).userId));
        case "resumeShareGroupAccessOperation":
            return await resumeGroupJob(event.arguments.groupId, event.arguments.operationId, getCaller(event).userId);
        case "cancelShareGroupAccessOperation":
            return await cancelGroupJob(event.arguments.groupId, event.arguments.operationId, getCaller(event).userId);
        case "createLocationLog": {
            const caller = getCaller(event);
            return createLegacyLocationLog(caller.userId, caller.username, event.arguments.input);
        }
        case "createRecordingSession": {
            const caller = getCaller(event);
            return createLegacyRecordingSession(caller.userId, caller.username, event.arguments.input);
        }
        case "ingestLocationLog": {
            const caller = getCaller(event);
            return await ingestLocationLog(caller.userId, caller.username, event.arguments.input);
        }

        case "shareHistoricalRecordingSession":
            return await runHistoricalWrite(event, true, () => shareHistoricalRecordingSession(event));

        case "resumeHistoricalShareOperation": {
            const caller = getCaller(event).userId;
            const session = await getOwnedRecordingSession(caller, event.arguments.recordingSessionId);
            const previous = await getHistoricalShareOperation(session.id);
            if (!previous || previous.status === "COMPLETED") return true;
            const retry = { ...event, arguments: { recordingSessionId: session.recordingSessionId,
                groupId: previous.groupId, recipientUserId: previous.recipientUserId, enabled: previous.requestedEnabled } };
            return await runHistoricalWrite(retry, false, async () => true);
        }

        case "setHistoricalShareGrant":
            return await runHistoricalWrite(event, false, () => setHistoricalShareGrant(event));

        case "diagnoseHistoricalShareMigrationAdmin":
            return await diagnoseHistoricalShareMigrationAdmin(event);

        case "diagnoseHistoricalShareRecoveryAdmin":
            return await diagnoseHistoricalShareRecoveryAdmin(event);

        default:
            throw new Error(`Unsupported operation: ${operation ?? "unknown"}`);
    }
};

async function listMyShareGroups(
    event: Parameters<Schema["listMyShareGroups"]["functionHandler"]>[0],
) {
    const { userId } = getCaller(event);

    /*
     * 自分のShareGroupMemberをuserId GSIで取得する。
     */
    const membershipResult =
        await client.models.ShareGroupMember.listShareGroupMembershipsByUser(
            {
                userId,
            },
            {
                limit: 1000,
            },
        );

    if (membershipResult.errors) {
        console.error(
            "[ShareGroup] My group memberships query errors:",
            membershipResult.errors,
        );

        throw new Error("所属グループを取得できませんでした。");
    }

    const memberships = membershipResult.data ?? [];

    const groups = await Promise.all(
        memberships.map(async (membership) => {
            /*
             * グループ本体を取得する。
             */
            const groupResult = await client.models.ShareGroup.get({
                groupId: membership.groupId,
            });

            if (groupResult.errors) {
                console.error(
                    "[ShareGroup] ShareGroup get errors:",
                    groupResult.errors,
                    {
                        groupId: membership.groupId,
                    },
                );

                return null;
            }

            const group = groupResult.data;

            if (!group || !group.isActive) {
                return null;
            }

            /*
             * グループに所属している全メンバーを取得する。
             */
            const groupMembersResult =
                await client.models.ShareGroupMember.listShareGroupMembersByGroup(
                    {
                        groupId: membership.groupId,
                    },
                    {
                        limit: 1000,
                    },
                );

            if (groupMembersResult.errors) {
                console.error(
                    "[ShareGroup] Group members query errors:",
                    groupMembersResult.errors,
                    {
                        groupId: membership.groupId,
                    },
                );

                throw new Error(
                    `「${group.name}」のメンバーを取得できませんでした。`,
                );
            }

            /*
             * グループメンバーごとに最新のUserProfileを取得する。
             *
             * ShareGroupMemberのdisplayName / iconImagePathは、
             * グループ参加時点のコピーなので、
             * プロフィール変更後も最新情報を表示できるよう
             * UserProfile側を優先する。
             */
            const members = await Promise.all(
                (groupMembersResult.data ?? []).map(async (member) => {
                    const profileResult =
                        await client.models.UserProfile.listUserProfilesByUserId(
                            {
                                userId: member.userId,
                            },
                            {
                                limit: 1,
                            },
                        );

                    if (profileResult.errors) {
                        console.error(
                            "[ShareGroup] Member profile query errors:",
                            profileResult.errors,
                            {
                                groupId: membership.groupId,
                                userId: member.userId,
                            },
                        );
                    }

                    const profile = profileResult.data?.[0];

                    return {
                        userId: member.userId,

                        /*
                         * 最新UserProfileを優先する。
                         *
                         * UserProfileを取得できなかった場合は、
                         * ShareGroupMemberに保存されている値へfallbackする。
                         */
                        displayName:
                            profile?.displayName ??
                            member.displayName ??
                            undefined,

                        iconImagePath:
                            profile?.iconImagePath ??
                            member.iconImagePath ??
                            undefined,

                        role: member.role === "OWNER" ? "OWNER" : "MEMBER",
                    };
                }),
            );

            /*
             * OWNERを先頭に表示し、
             * 同じrole内ではdisplayName順に並べる。
             */
            members.sort((a, b) => {
                if (a.role !== b.role) {
                    return a.role === "OWNER" ? -1 : 1;
                }

                return (a.displayName ?? "").localeCompare(
                    b.displayName ?? "",
                    "ja",
                );
            });

            const accessState = await gate(group.groupId);
            return {
                groupId: group.groupId,
                name: group.name,
                lifecycle: accessState?.activeJobId ? "CHANGING" : group.lifecycle ?? "ACTIVE",
                operationId: accessState?.activeJobId,
                role: membership.role === "OWNER" ? "OWNER" : "MEMBER",
                members,
            };
        }),
    );

    return groups.filter((group): group is NonNullable<typeof group> => group !== null).sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

async function regenerateShareGroupInviteCode(
    event: Parameters<
        Schema["regenerateShareGroupInviteCode"]["functionHandler"]
    >[0],
) {
    const { userId } = getCaller(event);

    const groupId = event.arguments.groupId;

    const groupResult = await client.models.ShareGroup.get({
        groupId,
    });

    if (groupResult.errors?.length) {
        console.error(
            "[ShareGroupApi] regenerate get group errors:",
            groupResult.errors,
        );

        throw new Error("共有グループを取得できませんでした。");
    }

    const group = groupResult.data;

    if (!group) {
        throw new Error("共有グループが見つかりません。");
    }

    if (!group.isActive) {
        throw new Error("この共有グループは現在利用できません。");
    }

    if (group.ownerUserId !== userId) {
        throw new Error("招待コードを再発行できるのはグループ作成者だけです。");
    }

    /*
     * 既存の招待コードと衝突しないコードを生成する。
     */
    const { inviteCode, inviteCodeHash } = await createUniqueInviteCode();

    await fencedWrite([{ Update: {
        TableName: tables.groups(), Key: { groupId },
        UpdateExpression: "SET inviteCodeHash = :hash, updatedAt = :now",
        ConditionExpression: "ownerUserId = :owner AND isActive = :yes",
        ExpressionAttributeValues: { ":hash": inviteCodeHash, ":now": new Date().toISOString(), ":owner": userId, ":yes": true },
    } }]);

    return {
        success: true,
        message: "招待コードを再発行しました。",
        groupId: group.groupId,
        groupName: group.name,
        inviteCode,
    };
}

async function assertCanJoinShareGroup(
    groupId: string,
    ownerUserId: string,
): Promise<void> {
    const tier = await getSubscriptionTierForUser(ownerUserId);

    const maxUsersPerShareGroup =
        getBackendSubscriptionLimits(tier).maxUsersPerShareGroup;

    /*
     * nullなら上限なし。
     */
    if (maxUsersPerShareGroup === null) {
        return;
    }

    const result = (await (
        client.models.ShareGroupMember as any
    ).listShareGroupMembersByGroup(
        {
            groupId,
        },
        {
            limit: maxUsersPerShareGroup,
        },
    )) as {
        data?:
            | {
                  membershipId: string;
                  groupId: string;
                  userId: string;
              }[]
            | null;
        errors?: unknown;
    };

    if (result.errors) {
        console.error(
            "[ShareGroup] Group member limit check errors:",
            result.errors,
            {
                groupId,
                ownerUserId,
                tier,
            },
        );

        throw new Error("共有グループの参加人数を確認できませんでした。");
    }

    const memberCount = (result.data ?? []).length;

    if (memberCount >= maxUsersPerShareGroup) {
        const planName = tier === "PREMIUM" ? "Premiumプラン" : "Freeプラン";

        throw new Error(
            `この共有グループは${planName}の上限${maxUsersPerShareGroup}人に達しています。`,
        );
    }
}

async function shareHistoricalRecordingSession(
    event: Parameters<
        Schema["shareHistoricalRecordingSession"]["functionHandler"]
    >[0],
): Promise<boolean> {
    const { userId } = getCaller(event);

    const { recordingSessionId, groupId, recipientUserIds } = event.arguments;

    if (!recordingSessionId || !groupId) {
        throw new Error("共有対象が不正です。");
    }

    const requestedUsers = [...new Set(recipientUserIds ?? [])];

    if (requestedUsers.length === 0 || requestedUsers.includes(userId)) {
        throw new Error("共有先が不正です。");
    }

    // 対象RecordingSessionが呼び出し元本人の記録であることを確認
    await getOwnedRecordingSession(userId, recordingSessionId);

    // グループが有効であることを確認
    const groupResult = await client.models.ShareGroup.get({
        groupId,
    });

    if (groupResult.errors?.length || groupResult.data?.isActive !== true) {
        throw new Error("有効な共有グループではありません。");
    }

    // 呼び出し元がグループに所属していることを確認
    const callerMembership = await client.models.ShareGroupMember.get({
        membershipId: `${groupId}#${userId}`,
    });

    if (callerMembership.errors?.length || !callerMembership.data) {
        throw new Error("共有グループのメンバーではありません。");
    }

    // 共有先の所属情報とownerValueを確定
    const verifiedOwners: string[] = [];

    for (const recipientUserId of requestedUsers) {
        const result = await client.models.ShareGroupMember.get({
            membershipId: `${groupId}#${recipientUserId}`,
        });

        if (result.errors?.length || !result.data || !result.data.ownerValue) {
            throw new Error("共有先ユーザーのグループ所属を確認できません。");
        }

        verifiedOwners.push(result.data.ownerValue);
    }

    /*
     * ここまでで、
     * ・呼び出し元の認証
     * ・有効グループ
     * ・呼び出し元の所属
     * ・共有先全員の所属
     * を検証できた。
     */

    console.log("[HistoricalSharing] Validation succeeded", {
        userId,
        recordingSessionId,
        groupId,
        recipientCount: verifiedOwners.length,
    });

    // Legacy public entry point delegates to the same Grant-authoritative writer.
    for (const recipientUserId of requestedUsers) {
        await setHistoricalShareGrant({ ...event, arguments: { recordingSessionId, groupId, recipientUserId, enabled: true } } as Parameters<typeof setHistoricalShareGrant>[0]);
    }
    return true;
}

type HistoricalGrantRecord = Schema["HistoricalShareGrant"]["type"];

async function loadHistoricalGrantsBySession(
    recordingSessionRecordId: string,
    ownerUserId: string,
): Promise<HistoricalGrantRecord[]> {
    const rows = await scanRows(tables.grants(), row => row.recordingSessionRecordId === recordingSessionRecordId);
    if (rows.some(row => row.ownerUserId !== ownerUserId || typeof row.recipientUserId !== "string" || typeof row.recipientOwnerValue !== "string" || !(row.recipientOwnerValue === row.recipientUserId || row.recipientOwnerValue.startsWith(`${row.recipientUserId}::`)))) throw new Error("Grantの所有者または共有先識別子が一致しません。");
    return rows as HistoricalGrantRecord[];
}

/**
 * Phase ⑦-1
 * 指定RecordingSessionの履歴共有Grant一覧を返す。
 *
 * セキュリティ:
 * - Cognito認証必須
 * - RecordingSessionの所有者本人だけ取得可能
 * - Grantの所有者・セッション整合性を検証
 *
 * 読み取り専用:
 * - Grantは変更しない
 * - Operationは変更しない
 * - sharedOwnersは変更しない
 */
async function listHistoricalShareRecipients(
    event: Parameters<
        Schema["listHistoricalShareRecipients"]["functionHandler"]
    >[0],
): Promise<
    {
        grantId: string;
        groupId: string;
        recipientUserId: string;
        isActive: boolean;
        grantedAt: string;
        revokedAt: string | null;
    }[]
> {
    const { userId } = getCaller(event);

    const recordingSessionId = event.arguments.recordingSessionId?.trim();

    if (!recordingSessionId) {
        throw new Error("recordingSessionIdが指定されていません。");
    }

    // 呼び出し元が所有するセッションだけを取得
    const session = await getOwnedRecordingSession(userId, recordingSessionId);

    // Grantの正本を取得
    // この関数内でも所有者・セッションの整合性を検証
    const grants = await loadHistoricalGrantsBySession(session.id, userId);

    const recipients = grants
        .map((grant) => ({
            grantId: grant.grantId,
            groupId: grant.groupId,
            recipientUserId: grant.recipientUserId,
            isActive: grant.isActive,
            grantedAt: grant.grantedAt,
            revokedAt: grant.revokedAt ?? null,
        }))
        .sort((a, b) => {
            // 有効な共有先を先頭にする
            if (a.isActive !== b.isActive) {
                return a.isActive ? -1 : 1;
            }

            // 同じ状態なら登録日時の新しい順
            const dateDiff = Date.parse(b.grantedAt) - Date.parse(a.grantedAt);

            if (dateDiff !== 0) {
                return dateDiff;
            }

            // 同日時でも表示順を安定させる
            return a.grantId.localeCompare(b.grantId);
        });

    console.info("[HistoricalSharing] Recipients loaded", {
        ownerUserId: userId,
        recordingSessionId,
        recipientCount: recipients.length,
        activeCount: recipients.filter((item) => item.isActive).length,
    });

    return recipients;
}

type HistoricalLocationLog = Schema["LocationLog"]["type"];

async function loadOwnedLocationLogsBySession(
    recordingSessionId: string,
    ownerUserId: string,
): Promise<HistoricalLocationLog[]> {
    const rows = await readSessionLogs(ownerUserId, recordingSessionId);
    for (const row of rows) assertRecordOwner(row, ownerUserId);
    return rows as HistoricalLocationLog[];
}

function makeHistoricalGrantId(
    recordingSessionRecordId: string,
    groupId: string,
    recipientUserId: string,
): string {
    return [
        "historical-grant",
        recordingSessionRecordId,
        groupId,
        recipientUserId,
    ].join("#");
}

async function validateHistoricalRecipient(userId: string, groupId: string, recipientUserId: string) {
    const group = await getRow(tables.groups(), { groupId });
    const caller = await getRow(tables.members(), { membershipId: `${groupId}#${userId}` });
    const recipient = await getRow(tables.members(), { membershipId: `${groupId}#${recipientUserId}` });
    if (group?.isActive !== true || caller?.userId !== userId || caller?.groupId !== groupId || recipient?.userId !== recipientUserId || recipient?.groupId !== groupId || typeof recipient.ownerValue !== "string" || !(recipient.ownerValue === recipientUserId || recipient.ownerValue.startsWith(`${recipientUserId}::`))) {
        throw new Error("有効な共有グループと双方の所属を確認できません。");
    }
    return recipient;
}

async function setHistoricalShareGrant(
    event: Parameters<Schema["setHistoricalShareGrant"]["functionHandler"]>[0],
): Promise<boolean> {
    const { userId } = getCaller(event);

    const { recordingSessionId, groupId, recipientUserId, enabled } =
        event.arguments;

    if (
        !recordingSessionId?.trim() ||
        !groupId?.trim() ||
        !recipientUserId?.trim()
    ) {
        throw new Error("共有権限の指定が不正です。");
    }

    if (recipientUserId === userId) {
        throw new Error("自分自身には共有できません。");
    }

    // 所有者本人のRecordingSessionを確定する
    const session = await getOwnedRecordingSession(userId, recordingSessionId);

    // Reject invalid requests before creating a session Operation; the group
    // admission lock already prevents membership changes during validation.
    const verifiedRecipient = enabled ? await validateHistoricalRecipient(userId, groupId, recipientUserId) : undefined;

    // Grantの変更より前にロックを取得する
    const operation = await beginHistoricalShareOperation(session.id, userId);
    resetSessionLogInventory();

    try {
        const grantId = makeHistoricalGrantId(
            session.id,
            groupId,
            recipientUserId,
        );

        // Grant更新より前に操作内容を永続化する
        await recordHistoricalShareIntent(operation, {
            groupId,
            recipientUserId,
            enabled,
            grantId,
        });

        // Grant管理への移行状態を検証する
        await ensureHistoricalShareGrantManaged(
            operation,
            userId,
            session.recordingSessionId,
        );

        const existing = await getRow(tables.grants(), { grantId });
        if (existing && (existing.ownerUserId !== userId || existing.recordingSessionRecordId !== session.id || existing.groupId !== groupId || existing.recipientUserId !== recipientUserId)) {
            throw new Error("Grantの整合性が不正です。");
        }
        const timestamp = new Date().toISOString();
        const sessionCondition = { ConditionCheck: {
            TableName: tables.operations(), Key: { recordingSessionRecordId: session.id },
            ConditionExpression: "operationId = :op AND ownerUserId = :owner AND #s = :pending",
            ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":op": operation.operationId, ":owner": userId, ":pending": "PENDING" },
        } };
        if (!enabled) {
            if (existing?.isActive) await fencedWrite([sessionCondition, { Update: {
                TableName: tables.grants(), Key: { grantId },
                UpdateExpression: "SET isActive = :no, revokedAt = :now, updatedAt = :now",
                ConditionExpression: "ownerUserId = :owner AND recordingSessionRecordId = :sid",
                ExpressionAttributeValues: { ":no": false, ":now": timestamp, ":owner": userId, ":sid": session.id },
            } }]);
        } else {
            const recipient = verifiedRecipient!;
            await fencedWrite([sessionCondition, { Put: {
                TableName: tables.grants(), Item: {
                    grantId, recordingSessionRecordId: session.id, ownerUserId: userId, groupId, recipientUserId,
                    recipientOwnerValue: recipient.ownerValue, isActive: true, grantedAt: existing?.grantedAt ?? timestamp,
                    revokedAt: null, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp, __typename: "HistoricalShareGrant",
                },
                ConditionExpression: existing ? "ownerUserId = :owner AND recordingSessionRecordId = :sid" : "attribute_not_exists(grantId)",
                ...(existing ? { ExpressionAttributeValues: { ":owner": userId, ":sid": session.id } } : {}),
            } }]);
        }

        // Grant登録・解除（または変更不要）の確認結果を保存
        await markHistoricalGrantWriteConfirmed(operation);

        // Grant更新後、反映フェーズに遷移
        await markHistoricalShareApplying(operation);

        // Grantから共有先を再計算し実レコードに反映
        await applyHistoricalShareProjection(
            operation,
            userId,
            session.recordingSessionId,
        );

        // 全件検証が成功した場合のみ完了へ遷移
        await completeHistoricalShareOperation(operation);

        return true;
    } catch (error) {
        try {
            await failHistoricalShareOperation(operation, error);
        } catch (stateError) {
            console.error(
                "[HistoricalSharing] Failed to record failure:",
                stateError,
            );
        }

        throw error;
    }
}

type HistoricalShareProjectionSnapshot = {
    recordingSessionRecordId: string;
    recordingSessionId: string;
    sharedOwners: string[];
    grants: HistoricalGrantRecord[];
    logs: HistoricalLocationLog[];
    recordingSessionNeedsUpdate: boolean;
    locationLogIdsNeedingUpdate: string[];
};

/**
 * 工程⑥-F：旧共有データの読み取り専用移行診断
 *
 * A: 共有先・Grantともに存在しない
 * B: 共有先に対応する有効なグループ所属が特定可能
 * C: 自動移行できない、または確認が必要
 *
 * Bも移行の実行許可を意味しない。
 *
 * AppSync mutationには接続しない。
 */
export type HistoricalShareMigrationDiagnosis = {
    classification: "A" | "B" | "C";
    recordingSessionRecordId: string;
    recordingSessionId: string;
    ownerUserId: string;
    locationLogCount: number;
    existingSharedOwners: string[];
    existingGrantCount: number;
    grantManaged: boolean;
    operationStatus: string | null;
    candidates: {
        recipientOwnerValue: string;
        groupId: string;
        recipientUserId: string;
    }[];
    reasons: string[];
};

export async function diagnoseHistoricalShareMigration(
    ownerUserId: string,
    recordingSessionId: string,
): Promise<HistoricalShareMigrationDiagnosis> {
    // 1. RecordingSessionの所有者確認
    const ownedSession = await getOwnedRecordingSession(
        ownerUserId,
        recordingSessionId,
    );

    const sessionResult = await client.models.RecordingSession.get({
        id: ownedSession.id,
    });

    if (sessionResult.errors?.length || !sessionResult.data) {
        throw new Error("移行対象RecordingSessionを取得できません。");
    }

    const session = sessionResult.data;

    if (
        session.userId !== ownerUserId ||
        session.recordingSessionId !== ownedSession.recordingSessionId
    ) {
        throw new Error("RecordingSessionの所有者が一致しません。");
    }

    // 2. 既存Grant・LocationLog・操作状態を取得
    const [grants, logs, operation] = await Promise.all([
        loadHistoricalGrantsBySession(ownedSession.id, ownerUserId),
        loadOwnedLocationLogsBySession(
            ownedSession.recordingSessionId,
            ownerUserId,
        ),
        getHistoricalShareOperation(ownedSession.id),
    ]);

    const normalizeOwners = (
        values: readonly (string | null)[] | null | undefined,
    ): string[] => {
        return [
            ...new Set(
                (values ?? [])
                    .filter((v): v is string => typeof v === "string")
                    .map((v) => v.trim())
                    .filter(Boolean),
            ),
        ].sort();
    };

    const sessionOwners = normalizeOwners(session.sharedOwners);
    const ownerSet = new Set(sessionOwners);
    const reasons: string[] = [];
    const candidates: HistoricalShareMigrationDiagnosis["candidates"] = [];

    // 3. Sessionと全ログの共有先が一致しているか検査
    let sharedOwnersConsistent = true;

    for (const log of logs) {
        const logOwners = normalizeOwners(log.sharedOwners);

        if (
            logOwners.length !== sessionOwners.length ||
            logOwners.some((v) => !ownerSet.has(v))
        ) {
            sharedOwnersConsistent = false;
            break;
        }
    }

    if (!sharedOwnersConsistent) {
        reasons.push("RecordingSessionとLocationLogの共有先が一致しません。");
    }

    if (operation && operation.ownerUserId !== ownerUserId) {
        reasons.push("操作状態の所有者が一致しません。");
    }

    if (operation && operation.status !== "COMPLETED") {
        reasons.push(`共有操作が${operation.status}のため移行できません。`);
    }

    if (operation?.grantManaged === true) {
        reasons.push("すでにGrant管理済みとして記録されています。");
    }

    if (grants.length > 0) {
        reasons.push(
            "既存Grantがあるため、旧共有データとの個別照合が必要です。",
        );
    }

    const base = {
        recordingSessionRecordId: ownedSession.id,
        recordingSessionId: ownedSession.recordingSessionId,
        ownerUserId,
        locationLogCount: logs.length,
        existingSharedOwners: sessionOwners,
        existingGrantCount: grants.length,
        grantManaged: operation?.grantManaged === true,
        operationStatus: operation?.status ?? null,
    };

    // 4. 既存の共有先がない場合
    if (sessionOwners.length === 0) {
        if (logs.length === 0) {
            reasons.push(
                "LocationLogが存在しないため、移行対象の妥当性を確認できません。",
            );
        }

        if (reasons.length === 0) {
            return {
                ...base,
                classification: "A",
                candidates,
                reasons: ["既存共有先・Grantがありません。"],
            };
        }

        return {
            ...base,
            classification: "C",
            candidates,
            reasons,
        };
    }

    // 5. 既存の矛盾があれば、帰属候補の推定に進まない
    if (reasons.length > 0) {
        return {
            ...base,
            classification: "C",
            candidates,
            reasons,
        };
    }

    // 6. 所有者が所属する全グループを取得
    const memberships: {
        groupId: string;
        userId: string;
    }[] = [];

    let nextToken: string | null = null;
    const seenTokens = new Set<string>();

    do {
        const result: {
            data: Schema["ShareGroupMember"]["type"][];
            errors?: readonly unknown[];
            nextToken?: string | null;
        } =
            await client.models.ShareGroupMember.listShareGroupMembershipsByUser(
                { userId: ownerUserId },
                {
                    limit: 100,
                    nextToken: nextToken ?? undefined,
                },
            );

        if (result.errors?.length) {
            throw new Error("共有元の所属情報取得に失敗しました。");
        }

        for (const member of result.data ?? []) {
            if (member.userId !== ownerUserId) {
                throw new Error("共有元の所属情報が不正です。");
            }

            memberships.push({
                groupId: member.groupId,
                userId: member.userId,
            });
        }

        nextToken = result.nextToken ?? null;

        if (nextToken) {
            if (seenTokens.has(nextToken)) {
                throw new Error("所属グループのページングが循環しています。");
            }
            seenTokens.add(nextToken);
        }
    } while (nextToken);

    // 7. 各グループの所属者と既存sharedOwnersを照合
    for (const membership of memberships) {
        const groupResult = await client.models.ShareGroup.get({
            groupId: membership.groupId,
        });

        if (groupResult.errors?.length) {
            throw new Error("共有グループの取得に失敗しました。");
        }

        if (!groupResult.data?.isActive) {
            continue;
        }

        let memberToken: string | null = null;
        const seenMemberTokens = new Set<string>();
        let ownerMembershipFound = false;

        const groupCandidates: HistoricalShareMigrationDiagnosis["candidates"] =
            [];

        do {
            const result: {
                data: Schema["ShareGroupMember"]["type"][];
                errors?: readonly unknown[];
                nextToken?: string | null;
            } =
                await client.models.ShareGroupMember.listShareGroupMembersByGroup(
                    { groupId: membership.groupId },
                    {
                        limit: 100,
                        nextToken: memberToken ?? undefined,
                    },
                );

            if (result.errors?.length) {
                throw new Error("グループメンバー取得に失敗しました。");
            }

            for (const member of result.data ?? []) {
                if (member.groupId !== membership.groupId) {
                    throw new Error("グループ所属情報が不正です。");
                }

                if (member.userId === ownerUserId) {
                    ownerMembershipFound = true;
                    continue;
                }

                if (
                    member.ownerValue &&
                    ownerSet.has(member.ownerValue.trim())
                ) {
                    groupCandidates.push({
                        recipientOwnerValue: member.ownerValue.trim(),
                        groupId: membership.groupId,
                        recipientUserId: member.userId,
                    });
                }
            }

            memberToken = result.nextToken ?? null;

            if (memberToken) {
                if (seenMemberTokens.has(memberToken)) {
                    throw new Error(
                        "グループメンバーのページングが循環しています。",
                    );
                }
                seenMemberTokens.add(memberToken);
            }
        } while (memberToken);

        if (ownerMembershipFound) {
            for (const candidate of groupCandidates) {
                const duplicated = candidates.some(
                    (existing) =>
                        existing.groupId === candidate.groupId &&
                        existing.recipientUserId ===
                            candidate.recipientUserId &&
                        existing.recipientOwnerValue ===
                            candidate.recipientOwnerValue,
                );

                if (!duplicated) {
                    candidates.push(candidate);
                }
            }
        }
    }

    // 8. 各sharedOwnerに対応する候補を評価
    for (const ownerValue of sessionOwners) {
        const matches = candidates.filter(
            (candidate) => candidate.recipientOwnerValue === ownerValue,
        );

        if (matches.length === 0) {
            reasons.push(
                "既存共有先に対応する有効なグループ所属がありません。",
            );
        } else if (matches.length > 1) {
            reasons.push("同一共有先に複数のグループ候補があります。");
        }
    }

    if (reasons.length > 0) {
        return {
            ...base,
            classification: "C",
            candidates,
            reasons: [...new Set(reasons)],
        };
    }

    // Bは移行候補の抽出のみ。Grantは作成しない。
    return {
        ...base,
        classification: "B",
        candidates,
        reasons: [
            "共有先の所属候補を特定できました。",
            "過去の共有元グループは確証がないため、移行前の確認が必要です。",
        ],
    };
}

export async function prepareHistoricalShareProjection(
    ownerUserId: string,
    recordingSessionId: string,
): Promise<HistoricalShareProjectionSnapshot> {
    // 1. 所有者本人のRecordingSessionを特定
    const ownedSession = await getOwnedRecordingSession(
        ownerUserId,
        recordingSessionId,
    );

    // 2. Grantを全件取得
    const grants = await loadHistoricalGrantsBySession(
        ownedSession.id,
        ownerUserId,
    );

    // 3. LocationLogを全件取得して所有者を検証
    const logs = await loadOwnedLocationLogsBySession(
        ownedSession.recordingSessionId,
        ownerUserId,
    );

    // 4. Grantから共有先を計算
    const sharedOwners = calculateEffectiveSharedOwners(
        ownedSession.id,
        grants,
    );

    // 5. RecordingSessionの最新状態を取得
    const sessionResult = await client.models.RecordingSession.get({
        id: ownedSession.id,
    });

    if (sessionResult.errors?.length || !sessionResult.data) {
        throw new Error("共有権限反映対象のRecordingSessionを取得できません。");
    }

    const session = sessionResult.data;

    if (
        session.userId !== ownerUserId ||
        session.recordingSessionId !== ownedSession.recordingSessionId
    ) {
        throw new Error("RecordingSessionの所有者が一致しません。");
    }

    // 6. 実データとの差分を計算
    const recordingSessionNeedsUpdate = !areSharedOwnersEqual(
        session.sharedOwners,
        sharedOwners,
    );

    const locationLogIdsNeedingUpdate = logs
        .filter((log) => !areSharedOwnersEqual(log.sharedOwners, sharedOwners))
        .map((log) => log.id);

    return {
        recordingSessionRecordId: ownedSession.id,
        recordingSessionId: ownedSession.recordingSessionId,
        sharedOwners,
        grants,
        logs,
        recordingSessionNeedsUpdate,
        locationLogIdsNeedingUpdate,
    };
}

/** 旧共有先を検証し、順序と重複を正規化する。 */
function strictLegacyOwners(
    owners: readonly (string | null)[] | null | undefined,
): string[] {
    const raw = owners ?? [];
    if (raw.some((value) => typeof value !== "string" || !value.trim())) {
        throw new Error("旧共有先に空値または不正値があります。");
    }
    const values = raw as readonly string[];
    if (new Set(values).size !== values.length) {
        throw new Error("旧共有先に重複があります。");
    }
    return [...values].sort();
}

type LegacyGrantTarget = {
    grantId: string;
    groupId: string;
    recipientUserId: string;
    recipientOwnerValue: string;
};

/**
 * 旧ownerValueを、有効な共有グループのメンバーへ一意に解決する。
 * 共有元が所属しないグループや、複数候補は安全のため拒否する。
 */
async function resolveLegacyGrantTargets(
    recordingSessionRecordId: string,
    ownerUserId: string,
    legacyOwners: readonly string[],
): Promise<LegacyGrantTarget[]> {
    const candidates: LegacyGrantTarget[] = [];
    const membershipTokens = new Set<string>();
    let nextMembershipToken: string | null = null;
    do {
        const memberships: {
            data: Schema["ShareGroupMember"]["type"][];
            errors?: readonly unknown[];
            nextToken?: string | null;
        } =
            await client.models.ShareGroupMember.listShareGroupMembershipsByUser(
                { userId: ownerUserId },
                { limit: 100, nextToken: nextMembershipToken ?? undefined },
            );
        if (memberships.errors?.length) {
            throw new Error("旧共有の共有元所属を取得できません。");
        }
        for (const membership of memberships.data ?? []) {
            if (membership.userId !== ownerUserId) {
                throw new Error("共有元の所属データが不正です。");
            }
            const groupId = membership.groupId;
            const groupResult = await client.models.ShareGroup.get({ groupId });
            if (groupResult.errors?.length) {
                throw new Error("共有グループの取得に失敗しました。");
            }
            if (!groupResult.data?.isActive) continue;
            let nextMemberToken: string | null = null;
            const memberTokens = new Set<string>();
            let ownerConfirmed = false;
            const groupMatches: LegacyGrantTarget[] = [];
            do {
                const members: {
                    data: Schema["ShareGroupMember"]["type"][];
                    errors?: readonly unknown[];
                    nextToken?: string | null;
                } =
                    await client.models.ShareGroupMember.listShareGroupMembersByGroup(
                        { groupId },
                        { limit: 100, nextToken: nextMemberToken ?? undefined },
                    );
                if (members.errors?.length) {
                    throw new Error(
                        "共有グループのメンバー取得に失敗しました。",
                    );
                }
                for (const member of members.data ?? []) {
                    if (member.groupId !== groupId) {
                        throw new Error("共有先の所属グループが不正です。");
                    }
                    if (member.userId === ownerUserId) {
                        ownerConfirmed = true;
                    } else if (
                        member.ownerValue &&
                        legacyOwners.includes(member.ownerValue)
                    ) {
                        groupMatches.push({
                            grantId: makeHistoricalGrantId(
                                recordingSessionRecordId,
                                groupId,
                                member.userId,
                            ),
                            groupId,
                            recipientUserId: member.userId,
                            recipientOwnerValue: member.ownerValue,
                        });
                    }
                }
                nextMemberToken = members.nextToken ?? null;
                if (nextMemberToken) {
                    if (memberTokens.has(nextMemberToken)) {
                        throw new Error(
                            "グループメンバーのページングが循環しています。",
                        );
                    }
                    memberTokens.add(nextMemberToken);
                }
            } while (nextMemberToken);
            if (ownerConfirmed) candidates.push(...groupMatches);
        }
        nextMembershipToken = memberships.nextToken ?? null;
        if (nextMembershipToken) {
            if (membershipTokens.has(nextMembershipToken)) {
                throw new Error("グループ所属のページングが循環しています。");
            }
            membershipTokens.add(nextMembershipToken);
        }
    } while (nextMembershipToken);

    return legacyOwners.map((ownerValue) => {
        const matches = candidates.filter(
            (target) => target.recipientOwnerValue === ownerValue,
        );
        const unique = [
            ...new Map(
                matches.map((target) => [target.grantId, target] as const),
            ).values(),
        ];
        if (unique.length !== 1) {
            throw new Error(
                `共有先 ${ownerValue} の所属グループを一意に確定できません (${unique.length}件)。`,
            );
        }
        return unique[0];
    });
}

/**
 * セッション単位の操作ロック(PENDING)を保持した状態で呼び出す。
 * 古い共有情報がある場合は全件一致を確認し、原子的にGrant管理へ移行する。
 */
async function ensureHistoricalShareGrantManaged(
    operation: HistoricalShareOperation,
    ownerUserId: string,
    recordingSessionId: string,
): Promise<void> {
    if (operation.ownerUserId !== ownerUserId) {
        throw new Error("共有操作の所有者が一致しません。");
    }
    const currentOperation = await getHistoricalShareOperation(
        operation.recordingSessionRecordId,
    );
    if (
        !currentOperation ||
        currentOperation.operationId !== operation.operationId ||
        currentOperation.ownerUserId !== ownerUserId ||
        currentOperation.status !== "PENDING"
    ) {
        throw new Error("共有操作のロック状態が一致しません。");
    }

    const snapshot = await prepareHistoricalShareProjection(
        ownerUserId,
        recordingSessionId,
    );
    if (
        snapshot.recordingSessionRecordId !== operation.recordingSessionRecordId
    ) {
        throw new Error("対象RecordingSessionが一致しません。");
    }

    if (currentOperation.grantManaged === true) {
        // 旧アプリによる直接変更があれば、Grantから勝手に上書きしない。
        if (
            snapshot.recordingSessionNeedsUpdate ||
            snapshot.locationLogIdsNeedingUpdate.length > 0
        ) {
            throw new Error(
                "Grant管理済みの共有先に不整合があります。診断・修復が必要です。",
            );
        }
        operation.grantManaged = true;
        return;
    }

    if (snapshot.grants.length > 0) {
        throw new Error(
            "未移行のセッションに既存Grantがあります。復旧診断が必要です。",
        );
    }
    const sessionResult = await client.models.RecordingSession.get({
        id: operation.recordingSessionRecordId,
    });
    if (sessionResult.errors?.length || !sessionResult.data) {
        throw new Error("RecordingSessionを取得できません。");
    }
    if (
        sessionResult.data.userId !== ownerUserId ||
        sessionResult.data.recordingSessionId !== recordingSessionId
    ) {
        throw new Error("RecordingSessionの所有者が一致しません。");
    }

    const legacyOwners = strictLegacyOwners(sessionResult.data.sharedOwners);
    for (const log of snapshot.logs) {
        const actual = strictLegacyOwners(log.sharedOwners);
        if (!areSharedOwnersEqual(actual, legacyOwners)) {
            throw new Error(
                `旧共有先がRecordingSessionと一致しません: ${log.id}`,
            );
        }
    }

    const targets = legacyOwners.length
        ? await resolveLegacyGrantTargets(
              operation.recordingSessionRecordId,
              ownerUserId,
              legacyOwners,
          )
        : [];

    // 全Grantの作成と管理済みフラグを一つのトランザクションで確定する。
    // 失敗時はどちらも反映されない。複数Grantの部分成功を防ぐ。
    if (targets.length > 0) {
        await commitLegacyShareGrantsAtomically(operation, targets);
    } else {
        await markHistoricalShareGrantManaged(operation);
    }
    operation.grantManaged = true;

    // 管理済みにした直後、元の共有権限が保存されていることを確認。
    // 不一致なら後続の共有更新を拒否してFAILEDとして保持する。
    const verified = await prepareHistoricalShareProjection(
        ownerUserId,
        recordingSessionId,
    );
    if (
        !areSharedOwnersEqual(verified.sharedOwners, legacyOwners) ||
        verified.recordingSessionNeedsUpdate ||
        verified.locationLogIdsNeedingUpdate.length > 0
    ) {
        throw new Error("旧共有のGrant移行後の全件照合に失敗しました。");
    }
}

async function applyHistoricalShareProjection(
    operation: HistoricalShareOperation,
    ownerUserId: string,
    recordingSessionId: string,
): Promise<void> {
    if (
        operation.ownerUserId !== ownerUserId ||
        operation.grantManaged !== true
    ) {
        throw new Error("Grant管理への移行が確認できません。");
    }

    // ロックを所有し、APPLYING状態であることを確認
    const currentOperation = await getHistoricalShareOperation(
        operation.recordingSessionRecordId,
    );

    if (
        !currentOperation ||
        currentOperation.operationId !== operation.operationId ||
        currentOperation.ownerUserId !== ownerUserId ||
        currentOperation.status !== "APPLYING" ||
        currentOperation.grantManaged !== true
    ) {
        throw new Error("共有権限反映のロック状態が一致しません。");
    }

    const snapshot = await prepareHistoricalShareProjection(
        ownerUserId,
        recordingSessionId,
    );

    if (
        snapshot.recordingSessionRecordId !== operation.recordingSessionRecordId
    ) {
        throw new Error("共有権限反映の対象Sessionが一致しません。");
    }

    const sessionResult = await client.models.RecordingSession.get({
        id: snapshot.recordingSessionRecordId,
    });

    if (sessionResult.errors?.length || !sessionResult.data) {
        throw new Error("RecordingSessionの取得に失敗しました。");
    }

    const currentSession = sessionResult.data;

    if (
        currentSession.userId !== ownerUserId ||
        currentSession.recordingSessionId !== recordingSessionId
    ) {
        throw new Error("RecordingSessionの所有者が一致しません。");
    }

    // 1件ずつ共有フィールドのみ条件付き更新（途中失敗時はOperationを未完了に残す）。
    // DDB強整合チェックで所有者・sessionIdと更新前の値を毎回検証する。
    const logsToUpdate = snapshot.logs.filter(
        (log) => !areSharedOwnersEqual(log.sharedOwners, snapshot.sharedOwners),
    );
    // 同一レコードの並列更新はせず、異なるログを8件単位で処理する。
    for (let offset = 0; offset < logsToUpdate.length; offset += 8) {
        const updates = await Promise.allSettled(
            logsToUpdate.slice(offset, offset + 8).map((log) =>
                updateProjectedSharedOwners({
                    kind: "log",
                    id: log.id,
                    ownerUserId,
                    recordingSessionId,
                    expectedOwners: log.sharedOwners,
                    nextOwners: snapshot.sharedOwners,
                }),
            ),
        );
        // Keep group fencing until every in-flight update has settled.
        const rejected = updates.find(result => result.status === "rejected");
        if (rejected?.status === "rejected") throw rejected.reason;
    }

    if (snapshot.recordingSessionNeedsUpdate) {
        await updateProjectedSharedOwners({
            kind: "session",
            id: snapshot.recordingSessionRecordId,
            ownerUserId,
            recordingSessionId,
            expectedOwners: currentSession.sharedOwners,
            nextOwners: snapshot.sharedOwners,
        });
    }

    // DynamoDBの強整合読み取りで、実際に投影が完了したか全件検証。
    // AppSyncの結果整合性により古い値が返っても誤判定しない。
    // 100件ずつ強整合BatchGetで照合し、未処理キーは再取得する。
    const logTable = projectionTableName("log");
    const verifiedLogIds = new Set<string>();
    for (let offset = 0; offset < snapshot.logs.length; offset += 100) {
        let pending = snapshot.logs
            .slice(offset, offset + 100)
            .map((log) => ({ id: log.id }));
        for (let attempt = 0; pending.length > 0 && attempt < 5; attempt++) {
            const response = await projectionDb.send(
                new BatchGetCommand({
                    RequestItems: {
                        [logTable]: {
                            Keys: pending,
                            ConsistentRead: true,
                            ProjectionExpression:
                                "#id, #userId, #sessionId, #owners",
                            ExpressionAttributeNames: {
                                "#id": "id",
                                "#userId": "userId",
                                "#sessionId": "recordingSessionId",
                                "#owners": "sharedOwners",
                            },
                        },
                    },
                }),
            );
            for (const item of response.Responses?.[logTable] ?? []) {
                if (
                    item.userId !== ownerUserId ||
                    item.recordingSessionId !== recordingSessionId ||
                    !areSharedOwnersEqual(
                        item.sharedOwners,
                        snapshot.sharedOwners,
                    )
                ) {
                    throw new Error(
                        `LocationLogの共有反映検証に失敗しました: ${item.id}`,
                    );
                }
                verifiedLogIds.add(item.id as string);
            }
            pending = (response.UnprocessedKeys?.[logTable]?.Keys ?? []).map(
                (key) => ({ id: key.id as string }),
            );
        }
        if (pending.length) {
            throw new Error("LocationLogの強整合再取得が完了しませんでした。");
        }
    }
    if (verifiedLogIds.size !== snapshot.logs.length) {
        throw new Error("LocationLogの全件照合が完了していません。");
    }
    const verifiedSession = await projectionDb.send(
        new GetCommand({
            TableName: projectionTableName("session"),
            Key: { id: snapshot.recordingSessionRecordId },
            ConsistentRead: true,
            ProjectionExpression: "#userId, #sessionId, #owners",
            ExpressionAttributeNames: {
                "#userId": "userId",
                "#sessionId": "recordingSessionId",
                "#owners": "sharedOwners",
            },
        }),
    );
    if (
        !verifiedSession.Item ||
        verifiedSession.Item.userId !== ownerUserId ||
        verifiedSession.Item.recordingSessionId !== recordingSessionId ||
        !areSharedOwnersEqual(
            verifiedSession.Item.sharedOwners,
            snapshot.sharedOwners,
        )
    ) {
        throw new Error("RecordingSessionの共有反映検証に失敗しました。");
    }
}

/**
 * 管理者による復旧実行のための内部関数。
 *
 * 必須の運用前提：
 * 1. 元のLambda実行が終了済みであること
 * 2. 同じRecordingSessionへの他の書き込みが停止していること
 * 3. 復旧対象がFAILEDであること
 *
 * これらを確認できない場合は実行しない。
 *
 * 通常APIの同一操作再試行から、期限確認・グループロック取得後にのみ接続する。
 */
export async function recoverFailedHistoricalShareProjection(
    ownerUserId: string,
    recordingSessionId: string,
    expectedFailedOperationId: string,
): Promise<void> {
    // 1. RecordingSessionの所有者を検証
    const session = await getOwnedRecordingSession(
        ownerUserId,
        recordingSessionId,
    );

    // 2. 復旧可能な状態か診断
    const assessment = await assessHistoricalShareRecovery(session.id);

    if (
        !assessment.recoveryCandidate ||
        assessment.operationId !== expectedFailedOperationId
    ) {
        throw new Error(`復旧条件を満たしていません: ${assessment.reason}`);
    }

    // 3. 復旧対象のGrant操作内容を強整合性読み取り
    const previousOperation = await getHistoricalShareOperation(session.id);

    if (
        !previousOperation ||
        previousOperation.operationId !== expectedFailedOperationId ||
        previousOperation.ownerUserId !== ownerUserId ||
        previousOperation.status !== "FAILED" ||
        previousOperation.grantManaged !== true ||
        previousOperation.operationPhase !== "GRANT_WRITE_CONFIRMED" ||
        !previousOperation.grantWriteConfirmedAt ||
        !previousOperation.grantId ||
        !previousOperation.groupId ||
        !previousOperation.recipientUserId ||
        typeof previousOperation.requestedEnabled !== "boolean"
    ) {
        throw new Error("復旧対象の操作情報が不完全です。");
    }

    // 記録されているGrant IDが対象セッションのものか確認
    const expectedGrantId = makeHistoricalGrantId(
        session.id,
        previousOperation.groupId,
        previousOperation.recipientUserId,
    );

    if (previousOperation.grantId !== expectedGrantId) {
        throw new Error("復旧対象Grant IDが一致しません。");
    }

    // 4. Grantの現在値を確認
    const grantResult = await client.models.HistoricalShareGrant.get({
        grantId: previousOperation.grantId,
    });

    if (grantResult.errors?.length) {
        throw new Error("復旧対象Grantの取得に失敗しました。");
    }

    const grant = grantResult.data;

    if (grant) {
        if (
            grant.ownerUserId !== ownerUserId ||
            grant.recordingSessionRecordId !== session.id ||
            grant.groupId !== previousOperation.groupId ||
            grant.recipientUserId !== previousOperation.recipientUserId
        ) {
            throw new Error("復旧対象Grantの整合性が不正です。");
        }
    }

    // 付与要求なら有効Grantが必要
    if (previousOperation.requestedEnabled) {
        if (!grant?.isActive || !grant.recipientOwnerValue) {
            throw new Error(
                "付与済みGrantを確認できないため復旧を中止します。",
            );
        }
    } else {
        // 解除要求ならGrantが存在しないか、無効である必要がある
        if (grant?.isActive) {
            throw new Error("Grantがまだ有効です。解除済みと判断できません。");
        }
    }

    // 5. 条件付き更新で復旧専用ロックを取得
    const recoveryOperation = await beginHistoricalShareRecovery(
        session.id,
        ownerUserId,
        expectedFailedOperationId,
    );

    resetSessionLogInventory();
    try {
        // 6. GrantからsharedOwnersを再計算して反映
        await applyHistoricalShareProjection(
            recoveryOperation,
            ownerUserId,
            session.recordingSessionId,
        );

        // 7. applyHistoricalShareProjection内の
        //    全件再取得・照合を通過した場合だけ完了
        await completeHistoricalShareOperation(recoveryOperation);
    } catch (error) {
        try {
            await failHistoricalShareOperation(recoveryOperation, error);
        } catch (stateError) {
            console.error(
                "[HistoricalSharing] Recovery failure state update failed:",
                stateError,
            );
        }

        throw error;
    }
}

type HistoricalShareRecoveryDiagnosis = {
    recordingSessionRecordId: string;
    recordingSessionId: string;
    ownerUserId: string;
    diagnosisCode:
        | "NO_OPERATION"
        | "IN_PROGRESS"
        | "PRE_COMMIT_FAILURE"
        | "REPAIR_CANDIDATE"
        | "BLOCKED"
        | "COMPLETED";
    operationId: string | null;
    operationStatus: string | null;
    operationPhase: string | null;
    grantManaged: boolean;
    expectedGrantId: string | null;
    existingGrantCount: number;
    locationLogCount: number;
    projectedSharedOwners: string[];
    recordingSessionNeedsUpdate: boolean;
    locationLogIdsNeedingUpdate: string[];
    safeToExecuteRecovery: false;
    reasons: string[];
};

/**
 * ⑥-F-4：移行障害を読み取り専用で診断する。
 *
 * REPAIR_CANDIDATEでも復旧を実行してよいわけではない。
 * Lambda終了確認・並行書き込み停止の確認は別途必要。
 */
async function diagnoseHistoricalShareRecoveryAdmin(
    event: Parameters<
        Schema["diagnoseHistoricalShareRecoveryAdmin"]["functionHandler"]
    >[0],
): Promise<HistoricalShareRecoveryDiagnosis> {
    const adminUserId = assertHistoricalMigrationAdmin(event);
    const { ownerUserId, recordingSessionId } = event.arguments;

    if (!ownerUserId?.trim() || !recordingSessionId?.trim()) {
        throw new Error("復旧診断の対象指定が不正です。");
    }

    const session = await getOwnedRecordingSession(
        ownerUserId,
        recordingSessionId,
    );

    // 強整合性で操作台帳を取得する。
    const operation = await getHistoricalShareOperation(session.id);

    // 既存のProjection処理で、Grant・全LocationLogと
    // 現在の共有先との差分を読み取り専用で確認する。
    const projection = await prepareHistoricalShareProjection(
        ownerUserId,
        recordingSessionId,
    );

    // ⑥-F-4の初回移行対象に限定する
    const approvedOwnerUserId = "3704aac8-90e1-70e4-bc50-6acd159a5049";

    const approvedRecordingSessionId = "session-1789508764591-byar86l3";

    if (
        ownerUserId !== approvedOwnerUserId ||
        recordingSessionId !== approvedRecordingSessionId
    ) {
        throw new Error("承認済みの初回移行対象ではありません。");
    }

    if (projection.recordingSessionRecordId !== session.id) {
        throw new Error("復旧診断対象のRecordingSessionが一致しません。");
    }

    const result = await client.models.RecordingSession.get({
        id: session.id,
    });

    if (result.errors?.length || !result.data) {
        throw new Error("RecordingSessionを取得できません。");
    }

    const actualSession = result.data;

    if (
        actualSession.userId !== ownerUserId ||
        actualSession.recordingSessionId !== recordingSessionId
    ) {
        throw new Error("RecordingSessionの所有者が一致しません。");
    }

    const expectedGrantId =
        operation?.groupId && operation?.recipientUserId
            ? makeHistoricalGrantId(
                  session.id,
                  operation.groupId,
                  operation.recipientUserId,
              )
            : null;

    const reasons: string[] = [];

    const base = {
        recordingSessionRecordId: session.id,
        recordingSessionId,
        ownerUserId,
        operationId: operation?.operationId ?? null,
        operationStatus: operation?.status ?? null,
        operationPhase: operation?.operationPhase ?? null,
        grantManaged: operation?.grantManaged === true,
        expectedGrantId,
        existingGrantCount: projection.grants.length,
        locationLogCount: projection.logs.length,
        projectedSharedOwners: [...projection.sharedOwners],
        recordingSessionNeedsUpdate: projection.recordingSessionNeedsUpdate,
        locationLogIdsNeedingUpdate: [
            ...projection.locationLogIdsNeedingUpdate,
        ],
        safeToExecuteRecovery: false as const,
    };

    const finish = (
        diagnosisCode: HistoricalShareRecoveryDiagnosis["diagnosisCode"],
    ): HistoricalShareRecoveryDiagnosis => ({
        ...base,
        diagnosisCode,
        reasons,
    });

    // 操作台帳がない場合
    if (!operation) {
        if (projection.grants.length > 0) {
            reasons.push(
                "操作台帳がありませんがGrantが存在します。孤立Grantの調査が必要です。",
            );
            return finish("BLOCKED");
        }

        reasons.push("移行操作台帳はありません。復旧対象ではありません。");
        return finish("NO_OPERATION");
    }

    // 台帳と所有者の基本整合性
    if (operation.ownerUserId !== ownerUserId) {
        reasons.push("操作台帳の所有者が一致しません。");
    }

    // 共有先に差分があると、移行専用の安全な復旧には進めない。
    if (
        projection.recordingSessionNeedsUpdate ||
        projection.locationLogIdsNeedingUpdate.length > 0
    ) {
        reasons.push(
            "Grantから計算した共有先と実レコードに差分があります。移行専用の復旧は保留します。",
        );
    }

    if (operation.grantManaged === true) {
        if (
            operation.operationPhase !== "GRANT_WRITE_CONFIRMED" ||
            !operation.grantWriteConfirmedAt
        ) {
            reasons.push(
                "Grant管理済みですが、Grant書き込み確認情報が不完全です。",
            );
        }

        if (
            !operation.grantId ||
            !operation.groupId ||
            !operation.recipientUserId ||
            typeof operation.requestedEnabled !== "boolean"
        ) {
            reasons.push("操作意図の保存情報が不足しています。");
        }

        if (expectedGrantId && operation.grantId !== expectedGrantId) {
            reasons.push("操作台帳のGrant IDが一致しません。");
        }
    }

    // 初回の承認済み移行は、1件の有効Grantで構成する。
    // 将来の一般共有操作とは区別して扱う。
    const isApprovedFirstMigration =
        ownerUserId === "3704aac8-90e1-70e4-bc50-6acd159a5049" &&
        recordingSessionId === "session-1789508764591-byar86l3" &&
        operation.groupId === "05159441-3d9c-4208-8aa4-4cb67a59556f" &&
        operation.recipientUserId === "57b4eac8-4021-70cd-3f37-423820f9d5c5";

    if (isApprovedFirstMigration && operation.grantManaged === true) {
        if (projection.grants.length !== 1) {
            reasons.push("承認済み移行のGrant件数が1件ではありません。");
        } else {
            const grant = projection.grants[0];

            if (
                grant.grantId !== operation.grantId ||
                grant.recordingSessionRecordId !== session.id ||
                grant.ownerUserId !== ownerUserId ||
                grant.groupId !== operation.groupId ||
                grant.recipientUserId !== operation.recipientUserId ||
                grant.recipientOwnerValue !==
                    "57b4eac8-4021-70cd-3f37-423820f9d5c5" ||
                grant.isActive !== true ||
                !areSharedOwnersEqual(projection.sharedOwners, [
                    "57b4eac8-4021-70cd-3f37-423820f9d5c5",
                ]) ||
                projection.logs.length !== 180 ||
                !areSharedOwnersEqual(actualSession.sharedOwners, [
                    "57b4eac8-4021-70cd-3f37-423820f9d5c5",
                ])
            ) {
                reasons.push(
                    "承認済み移行のGrant・件数・共有先に不一致があります。",
                );
            }
        }
    } else if (operation.grantManaged === true) {
        // 初回移行以外の状態を、今回の復旧診断では
        // 誤って安全と判定しない。
        reasons.push(
            "承認済み初回移行以外の操作です。別の復旧判断が必要です。",
        );
    }

    if (operation.status === "COMPLETED") {
        if (
            operation.grantManaged !== true ||
            operation.operationPhase !== "GRANT_WRITE_CONFIRMED" ||
            projection.grants.length !== 1 ||
            reasons.length > 0
        ) {
            reasons.push(
                "操作はCOMPLETEDですが、Grant移行完了条件を満たしていません。",
            );
            return finish("BLOCKED");
        }

        reasons.push("Grant管理・共有先整合性を確認しました。復旧不要です。");
        return finish("COMPLETED");
    }

    if (operation.status === "PENDING" || operation.status === "APPLYING") {
        // 実行中か強制終了かをDynamoDBだけでは判定できない。
        reasons.push(
            "操作が実行中、または途中停止した可能性があります。元Lambdaの終了確認が必要です。",
        );

        if (
            operation.ownerUserId !== ownerUserId ||
            (operation.grantManaged === true && reasons.length > 1)
        ) {
            return finish("BLOCKED");
        }

        return finish("IN_PROGRESS");
    }

    if (operation.status !== "FAILED") {
        reasons.push("未対応の操作状態です。");
        return finish("BLOCKED");
    }

    // FAILEDでGrant管理前
    if (operation.grantManaged !== true) {
        const preCommitProblems: string[] = [];

        if (operation.ownerUserId !== ownerUserId) {
            preCommitProblems.push("操作台帳の所有者が不一致です。");
        }

        if (projection.grants.length !== 0) {
            preCommitProblems.push("Grant管理前なのにGrantが存在します。");
        }

        if (operation.grantWriteConfirmedAt) {
            preCommitProblems.push(
                "Grant管理前なのに書き込み確認日時が存在します。",
            );
        }

        // Grant作成に進む前に記録する操作意図
        if (
            operation.operationPhase !== "INTENT_RECORDED" ||
            !operation.intentRecordedAt ||
            !operation.grantId ||
            !operation.groupId ||
            !operation.recipientUserId ||
            operation.requestedEnabled !== true
        ) {
            preCommitProblems.push(
                "移行操作の意図情報が不足、または不正です。",
            );
        }

        const expectedId = makeHistoricalGrantId(
            session.id,
            "05159441-3d9c-4208-8aa4-4cb67a59556f",
            "57b4eac8-4021-70cd-3f37-423820f9d5c5",
        );

        if (
            operation.groupId !== "05159441-3d9c-4208-8aa4-4cb67a59556f" ||
            operation.recipientUserId !==
                "57b4eac8-4021-70cd-3f37-423820f9d5c5" ||
            operation.grantId !== expectedId
        ) {
            preCommitProblems.push(
                "承認済み移行対象のグループ・共有先と一致しません。",
            );
        }

        // Grant未作成時のProjection差分は正常に起こり得る。
        // 代わりに旧共有先の実データを直接照合する。
        const expectedOwners = ["57b4eac8-4021-70cd-3f37-423820f9d5c5"];

        if (
            projection.logs.length !== 180 ||
            !areSharedOwnersEqual(actualSession.sharedOwners, expectedOwners) ||
            projection.logs.some(
                (log) =>
                    !areSharedOwnersEqual(log.sharedOwners, expectedOwners),
            )
        ) {
            preCommitProblems.push(
                "既存RecordingSessionまたはLocationLogの共有先が不一致です。",
            );
        }

        if (preCommitProblems.length > 0) {
            return {
                ...base,
                diagnosisCode: "BLOCKED",
                reasons: preCommitProblems,
            };
        }

        return {
            ...base,
            diagnosisCode: "PRE_COMMIT_FAILURE",
            reasons: [
                "Grant作成前に停止した可能性があります。",
                "Grantは未作成で、旧共有先は維持されています。",
                "操作ロックを保持し、元Lambdaの終了を確認してください。",
            ],
        };
    }

    if (reasons.length > 0) {
        return finish("BLOCKED");
    }

    reasons.push(
        "Grantと既存共有先は整合しています。復旧候補ですが、Lambda終了・並行書き込み停止の確認が必要です。",
    );

    console.info("[HistoricalShareMigration] Recovery diagnosis", {
        adminUserId,
        recordingSessionRecordId: session.id,
        operationId: operation.operationId,
        status: operation.status,
        diagnosisCode: "REPAIR_CANDIDATE",
    });

    return finish("REPAIR_CANDIDATE");
}
