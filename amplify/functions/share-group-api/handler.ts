import { createHash, randomInt, randomUUID } from "node:crypto";

import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";

import { env } from "$amplify/env/share-group-api";

import type { Schema } from "../../data/resource";

/*
 * Lambda FunctionからAmplify Dataへアクセスするための設定。
 */
const { resourceConfig, libraryOptions } =
    await getAmplifyDataClientConfig(env);

Amplify.configure(resourceConfig, libraryOptions);

const client = generateClient<Schema>();

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

    const ownerValue = profile.ownerValue;

    if (!ownerValue) {
        throw new Error("ユーザーの共有情報が設定されていません。");
    }

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
    const groupResult = await client.models.ShareGroup.create({
        groupId,
        name,
        ownerUserId: userId,
        inviteCodeHash,
        isActive: true,
    });

    if (groupResult.errors) {
        console.error(
            "[ShareGroup] Create ShareGroup errors:",
            groupResult.errors,
        );

        throw new Error("グループの作成に失敗しました。");
    }

    /*
     * グループ作成者自身を
     * OWNERメンバーとして登録する。
     */
    const membershipId = `${groupId}#${userId}`;

    const memberResult = await client.models.ShareGroupMember.create({
        membershipId,
        groupId,
        userId,

        ownerValue: profile.ownerValue,

        displayName: profile.displayName ?? undefined,

        email: profile.email ?? undefined,

        iconImagePath: profile.iconImagePath ?? undefined,

        role: "OWNER",

        joinedAt: now,
    });

    if (memberResult.errors) {
        console.error(
            "[ShareGroup] Create owner member errors:",
            memberResult.errors,
        );

        /*
         * グループだけ残る状態を避けるため、
         * OWNERメンバー登録に失敗した場合は
         * 作成済みグループを削除する。
         */
        try {
            await client.models.ShareGroup.delete({
                groupId,
            });
        } catch (rollbackError) {
            console.error(
                "[ShareGroup] Rollback group delete error:",
                rollbackError,
            );
        }

        throw new Error("グループメンバーの作成に失敗しました。");
    }

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
    const membershipId = `${group.groupId}#${userId}`;

    /*
     * すでに所属しているか確認する。
     */
    const existingResult = await client.models.ShareGroupMember.get({
        membershipId,
    });

    if (existingResult.errors) {
        console.error(
            "[ShareGroup] Existing membership lookup errors:",
            existingResult.errors,
        );

        throw new Error("グループ参加状態の確認に失敗しました。");
    }

    if (existingResult.data) {
        return {
            success: true,
            message: "すでにこのグループへ参加しています。",
            groupId: group.groupId,
            groupName: group.name,
        };
    }

    /*
     * グループOWNERのプランに応じて、
     * グループ人数上限を確認する。
     */
    await assertCanJoinShareGroup(group.groupId, group.ownerUserId);

    /*
     * 参加ユーザーのプロフィール取得。
     */
    const profile = await loadUserProfile(userId);

    /*
     * MEMBERとして登録。
     */
    const createResult = await client.models.ShareGroupMember.create({
        membershipId,

        groupId: group.groupId,

        userId,

        ownerValue: profile.ownerValue,

        displayName: profile.displayName ?? undefined,

        email: profile.email ?? undefined,

        iconImagePath: profile.iconImagePath ?? undefined,

        role: "MEMBER",

        joinedAt: new Date().toISOString(),
    });

    if (createResult.errors) {
        console.error(
            "[ShareGroup] Join group member create errors:",
            createResult.errors,
        );

        throw new Error("グループへの参加に失敗しました。");
    }

    console.log("[ShareGroup] User joined group:", {
        groupId: group.groupId,

        userId,
    });

    return {
        success: true,
        message: "グループへ参加しました。",

        groupId: group.groupId,

        groupName: group.name,
    };
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
export const handler = async (event: any) => {
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
            arguments: event?.arguments ?? null,
            userId: event?.identity?.sub ?? event?.identity?.username ?? null,
        }),
    );

    switch (operation) {
        case "createShareGroupWithInviteCode":
            return await createShareGroup(event);

        case "joinShareGroupByInviteCode":
            return await joinShareGroupByInviteCode(event);

        case "listMyShareCandidates":
            return await listMyShareCandidates(event);

        case "listMyShareGroups":
            return await listMyShareGroups(event);

        case "regenerateShareGroupInviteCode":
            return await regenerateShareGroupInviteCode(event);

        case "deleteOwnedShareGroup":
            return await deleteOwnedShareGroup(event);

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

            return {
                groupId: group.groupId,
                name: group.name,
                role: membership.role === "OWNER" ? "OWNER" : "MEMBER",
                members,
            };
        }),
    );

    return groups
        .filter(
            (
                group,
            ): group is {
                groupId: string;
                name: string;
                role: string;
                members: {
                    userId: string;
                    displayName: string | undefined;
                    iconImagePath: string | undefined;
                    role: string;
                }[];
            } => group !== null,
        )
        .sort((a, b) => a.name.localeCompare(b.name, "ja"));
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

    const updateResult = await client.models.ShareGroup.update({
        groupId,
        inviteCodeHash,
    });

    if (updateResult.errors?.length) {
        console.error(
            "[ShareGroupApi] regenerate update errors:",
            updateResult.errors,
        );

        throw new Error("招待コードを再発行できませんでした。");
    }

    return {
        success: true,
        message: "招待コードを再発行しました。",
        groupId: group.groupId,
        groupName: group.name,
        inviteCode,
    };
}

/*
 * 自分が作成した共有グループを削除する。
 *
 * OWNERのみ実行可能。
 *
 * ShareGroupMemberを先にすべて削除し、
 * 最後にShareGroup本体を削除する。
 */
async function deleteOwnedShareGroup(
    event: Parameters<Schema["deleteOwnedShareGroup"]["functionHandler"]>[0],
) {
    const { userId } = getCaller(event);

    const groupId = event.arguments.groupId;

    /*
     * 対象グループを取得する。
     */
    const groupResult = await client.models.ShareGroup.get({
        groupId,
    });

    if (groupResult.errors?.length) {
        console.error(
            "[ShareGroup] Delete group lookup errors:",
            groupResult.errors,
            {
                groupId,
                userId,
            },
        );

        throw new Error("共有グループを取得できませんでした。");
    }

    const group = groupResult.data;

    if (!group) {
        throw new Error("共有グループが見つかりません。");
    }

    /*
     * 他ユーザーが作成したグループを削除できないようにする。
     *
     * クライアント側の表示制御だけには依存せず、
     * 必ずLambda側でもOWNER確認を行う。
     */
    if (group.ownerUserId !== userId) {
        throw new Error("共有グループを削除できるのは作成者だけです。");
    }

    /*
     * グループに所属している全ShareGroupMemberを取得する。
     */
    const allMembers: {
        membershipId: string;
    }[] = [];

    let nextToken: string | null = null;

    do {
        const memberResult = (await (
            client.models.ShareGroupMember as any
        ).listShareGroupMembersByGroup(
            {
                groupId,
            },
            {
                limit: 1000,
                nextToken: nextToken ?? undefined,
            },
        )) as ShareGroupMemberDeleteListResult;

        if (memberResult.errors?.length) {
            console.error(
                "[ShareGroup] Delete group member list errors:",
                memberResult.errors,
                {
                    groupId,
                },
            );

            throw new Error(
                "共有グループのメンバー情報を取得できませんでした。",
            );
        }

        for (const member of memberResult.data ?? []) {
            allMembers.push({
                membershipId: member.membershipId,
            });
        }

        nextToken = memberResult.nextToken ?? null;
    } while (nextToken);

    /*
     * Memberを削除する。
     *
     * 1件ずつ直列にすると人数が増えた場合に遅いため、
     * 25件単位で並列削除する。
     */
    for (let index = 0; index < allMembers.length; index += 25) {
        const batch = allMembers.slice(index, index + 25);

        const deleteResults = await Promise.all(
            batch.map((member) =>
                client.models.ShareGroupMember.delete({
                    membershipId: member.membershipId,
                }),
            ),
        );

        const failedResult = deleteResults.find(
            (result) => result.errors?.length,
        );

        if (failedResult?.errors?.length) {
            console.error(
                "[ShareGroup] Delete group member errors:",
                failedResult.errors,
                {
                    groupId,
                },
            );

            throw new Error(
                "共有グループのメンバー情報を削除できませんでした。",
            );
        }
    }

    /*
     * Member削除完了後にグループ本体を削除する。
     */
    const deleteGroupResult = await client.models.ShareGroup.delete({
        groupId,
    });

    if (deleteGroupResult.errors?.length) {
        console.error(
            "[ShareGroup] Delete group errors:",
            deleteGroupResult.errors,
            {
                groupId,
            },
        );

        throw new Error("共有グループを削除できませんでした。");
    }

    console.log("[ShareGroup] Group deleted:", {
        groupId,
        groupName: group.name,
        ownerUserId: userId,
        deletedMemberCount: allMembers.length,
    });

    return {
        success: true,
        message: "共有グループを削除しました。",
        groupId,
        groupName: group.name,
    };
}

/*
 * グループOWNERのプランに応じて、
 * 1グループあたりの最大人数を確認する。
 *
 * OWNERも1人として数える。
 *
 * 既存のgroupId GSIのみ使用するため、
 * DynamoDB schema変更は不要。
 */
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
