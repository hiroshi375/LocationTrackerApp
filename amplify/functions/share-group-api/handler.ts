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
     * 自分が所属しているグループを取得。
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

    const candidateMap = new Map<
        string,
        {
            userId: string;
            ownerValue: string;
            displayName?: string;
            email?: string;
            iconImagePath?: string;
        }
    >();

    for (const membership of myMemberships) {
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
            if (member.userId === userId) {
                continue;
            }

            if (!member.ownerValue) {
                continue;
            }

            candidateMap.set(member.userId, {
                userId: member.userId,
                ownerValue: member.ownerValue,
                displayName: member.displayName ?? undefined,
                email: member.email ?? undefined,
                iconImagePath: member.iconImagePath ?? undefined,
            });
        }
    }

    return [...candidateMap.values()].sort((a, b) => {
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

            return {
                groupId: group.groupId,
                name: group.name,
                role: membership.role === "OWNER" ? "OWNER" : "MEMBER",
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
            } => group !== null,
        )
        .sort((a, b) => a.name.localeCompare(b.name, "ja"));
}
