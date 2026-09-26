import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useLayoutEffect, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Image,
    Pressable,
    ScrollView,
    Share,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";

import { getUrl } from "aws-amplify/storage";

import { client } from "../lib/client";

import {
    canCreateShareGroup,
    getSubscriptionPlanLimits,
} from "../config/subscriptionPlan";

import { useSubscription } from "../hooks/useSubscription";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type ShareGroupMemberSummaryItem = {
    userId: string;
    displayName?: string | null;
    iconImagePath?: string | null;
    role: string;
};

type ShareGroupSummaryItem = {
    groupId: string;
    name: string;
    role: string;
    members?: (ShareGroupMemberSummaryItem | null)[] | null;
};

type ShareGroupQueryResult = {
    data?: (ShareGroupSummaryItem | null)[] | null;
    errors?: readonly unknown[];
};

type ShareGroupActionData = {
    success: boolean;
    message: string;
    groupId?: string | null;
    groupName?: string | null;
    inviteCode?: string | null;
};

type ShareGroupActionResult = {
    data?: ShareGroupActionData | null;
    errors?: readonly unknown[];
};

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

function getFirstGraphQLErrorMessage(
    errors: readonly unknown[] | undefined | null,
): string | null {
    if (!errors || errors.length === 0) {
        return null;
    }

    const first = errors[0] as {
        message?: string;
    };

    return first?.message ?? String(errors[0]);
}

export default function ShareGroupManagementScreen() {
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    useLayoutEffect(() => {
        navigation.setOptions({
            headerShown: false,
        });
    }, [navigation]);
    const [groups, setGroups] = useState<ShareGroupSummaryItem[]>([]);
    const [loadingGroups, setLoadingGroups] = useState(false);
    /*
     * iconImagePath → 一時URL
     *
     * 同じユーザーが複数グループに所属していても
     * 同一pathは1回だけgetUrlする。
     */
    const [memberIconUrls, setMemberIconUrls] = useState<
        Record<string, string>
    >({});
    const [groupName, setGroupName] = useState("");
    const [creatingGroup, setCreatingGroup] = useState(false);
    const [inviteCodeInput, setInviteCodeInput] = useState("");
    const [joiningGroup, setJoiningGroup] = useState(false);
    const [createdGroupName, setCreatedGroupName] = useState<string | null>(
        null,
    );
    const [createdInviteCode, setCreatedInviteCode] = useState<string | null>(
        null,
    );
    const [regeneratingGroupId, setRegeneratingGroupId] = useState<
        string | null
    >(null);
    const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null);
    const ownedGroupCount = groups.filter(
        (group) => group.role === "OWNER",
    ).length;

    const { tier: subscriptionTier, loading: subscriptionLoading } =
        useSubscription();

    const planLimits = getSubscriptionPlanLimits(subscriptionTier);

    const maxOwnedShareGroups = planLimits.maxOwnedShareGroups;

    const canCreateCurrentPlanShareGroup =
        !subscriptionLoading &&
        canCreateShareGroup(subscriptionTier, ownedGroupCount);

    const loadGroups = useCallback(async () => {
        try {
            setLoadingGroups(true);

            const result = (await (client.queries.listMyShareGroups as any)(
                {},
            )) as ShareGroupQueryResult;

            if (result.errors?.length) {
                console.error("listMyShareGroups errors:", result.errors);

                throw new Error(
                    getFirstGraphQLErrorMessage(result.errors) ??
                        "所属グループを取得できませんでした。",
                );
            }

            const items: ShareGroupSummaryItem[] = (result.data ?? []).filter(
                (item): item is ShareGroupSummaryItem => item !== null,
            );

            /*
             * 全グループからプロフィール画像pathを集める。
             *
             * Setを使い、同じユーザーが複数グループに所属していても
             * 同じ画像を重複してgetUrlしない。
             */
            const iconPaths = [
                ...new Set(
                    items.flatMap((group) =>
                        (group.members ?? [])
                            .filter(
                                (
                                    member,
                                ): member is ShareGroupMemberSummaryItem =>
                                    member !== null,
                            )
                            .map((member) => member.iconImagePath)
                            .filter((path): path is string => Boolean(path)),
                    ),
                ),
            ];

            const iconUrlEntries = await Promise.all(
                iconPaths.map(async (path) => {
                    try {
                        const urlResult = await getUrl({
                            path,
                            options: {
                                expiresIn: 3600,
                            },
                        });

                        return [path, urlResult.url.toString()] as const;
                    } catch (error) {
                        /*
                         * 1人のアイコン取得に失敗しても
                         * グループ一覧全体は表示する。
                         */
                        console.error("Load share group member icon error:", {
                            path,
                            error,
                        });

                        return null;
                    }
                }),
            );

            const nextMemberIconUrls: Record<string, string> = {};

            for (const entry of iconUrlEntries) {
                if (!entry) {
                    continue;
                }

                const [path, url] = entry;

                nextMemberIconUrls[path] = url;
            }

            setMemberIconUrls(nextMemberIconUrls);
            setGroups(items);
        } catch (error) {
            console.error("Load share groups error:", error);

            Alert.alert("取得エラー", getErrorMessage(error));
        } finally {
            setLoadingGroups(false);
        }
    }, []);

    useFocusEffect(
        useCallback(() => {
            void loadGroups();
        }, [loadGroups]),
    );

    const handleCreateGroup = useCallback(async () => {
        if (creatingGroup || subscriptionLoading) {
            return;
        }

        if (!canCreateCurrentPlanShareGroup) {
            Alert.alert(
                "作成上限",
                maxOwnedShareGroups !== null
                    ? `現在のプランでは共有グループを${maxOwnedShareGroups}件まで作成できます。`
                    : "共有グループを作成できません。",
            );
            return;
        }

        const trimmedName = groupName.trim();

        if (!trimmedName) {
            Alert.alert("入力確認", "グループ名を入力してください。");
            return;
        }

        try {
            setCreatingGroup(true);

            const result = (await (
                client.mutations.createShareGroupWithInviteCode as any
            )({
                name: trimmedName,
            })) as ShareGroupActionResult;

            if (result.errors?.length) {
                console.error(
                    "createShareGroupWithInviteCode errors:",
                    result.errors,
                );

                throw new Error(
                    getFirstGraphQLErrorMessage(result.errors) ??
                        "グループを作成できませんでした。",
                );
            }

            if (!result.data?.success) {
                throw new Error(
                    result.data?.message ?? "グループを作成できませんでした。",
                );
            }

            setCreatedGroupName(result.data.groupName ?? trimmedName);

            setCreatedInviteCode(result.data.inviteCode ?? null);

            setGroupName("");

            await loadGroups();

            if (!result.data.inviteCode) {
                Alert.alert("グループ作成完了", "グループを作成しました。");
            }
        } catch (error) {
            console.error("Create share group error:", error);

            Alert.alert("作成エラー", getErrorMessage(error));
        } finally {
            setCreatingGroup(false);
        }
    }, [
        canCreateCurrentPlanShareGroup,
        creatingGroup,
        groupName,
        loadGroups,
        maxOwnedShareGroups,
        subscriptionLoading,
    ]);

    const handleJoinGroup = useCallback(async () => {
        if (joiningGroup) {
            return;
        }

        const normalizedCode = inviteCodeInput
            .trim()
            .toUpperCase()
            .replace(/[\s-]/g, "");

        if (!normalizedCode) {
            Alert.alert("入力確認", "招待コードを入力してください。");
            return;
        }

        try {
            setJoiningGroup(true);

            const result = (await (
                client.mutations.joinShareGroupByInviteCode as any
            )({
                inviteCode: normalizedCode,
            })) as ShareGroupActionResult;

            if (result.errors?.length) {
                console.error(
                    "joinShareGroupByInviteCode errors:",
                    result.errors,
                );

                throw new Error(
                    getFirstGraphQLErrorMessage(result.errors) ??
                        "グループへ参加できませんでした。",
                );
            }

            if (!result.data?.success) {
                throw new Error(
                    result.data?.message ?? "グループへ参加できませんでした。",
                );
            }

            setInviteCodeInput("");

            await loadGroups();

            Alert.alert(
                "参加完了",
                result.data.message ?? "グループへ参加しました。",
            );
        } catch (error) {
            console.error("Join share group error:", error);

            Alert.alert("参加エラー", getErrorMessage(error));
        } finally {
            setJoiningGroup(false);
        }
    }, [inviteCodeInput, joiningGroup, loadGroups]);

    const handleRegenerateInviteCode = useCallback(
        async (group: ShareGroupSummaryItem) => {
            if (regeneratingGroupId) {
                return;
            }

            try {
                setRegeneratingGroupId(group.groupId);

                const result = (await (
                    client.mutations.regenerateShareGroupInviteCode as any
                )({
                    groupId: group.groupId,
                })) as ShareGroupActionResult;

                if (result.errors?.length) {
                    console.error(
                        "regenerateShareGroupInviteCode errors:",
                        result.errors,
                    );

                    throw new Error(
                        getFirstGraphQLErrorMessage(result.errors) ??
                            "招待コードを再発行できませんでした。",
                    );
                }

                if (!result.data?.success) {
                    throw new Error(
                        result.data?.message ??
                            "招待コードを再発行できませんでした。",
                    );
                }

                const inviteCode = result.data.inviteCode;

                if (!inviteCode) {
                    throw new Error(
                        "再発行された招待コードを取得できませんでした。",
                    );
                }

                setCreatedGroupName(result.data.groupName ?? group.name);

                setCreatedInviteCode(inviteCode);

                Alert.alert(
                    "再発行完了",
                    [
                        "新しい招待コードを発行しました。",
                        "",
                        "以前の招待コードは使用できなくなります。",
                    ].join("\n"),
                );
            } catch (error) {
                console.error(
                    "Regenerate share group invite code error:",
                    error,
                );

                Alert.alert("再発行エラー", getErrorMessage(error));
            } finally {
                setRegeneratingGroupId(null);
            }
        },
        [regeneratingGroupId],
    );

    const confirmRegenerateInviteCode = useCallback(
        (group: ShareGroupSummaryItem) => {
            Alert.alert(
                "招待コードを再発行",
                [
                    `「${group.name}」の招待コードを再発行します。`,
                    "",
                    "現在の招待コードは使用できなくなります。",
                    "",
                    "再発行しますか？",
                ].join("\n"),
                [
                    {
                        text: "キャンセル",
                        style: "cancel",
                    },
                    {
                        text: "再発行",
                        onPress: () => {
                            void handleRegenerateInviteCode(group);
                        },
                    },
                ],
            );
        },
        [handleRegenerateInviteCode],
    );

    const handleDeleteGroup = useCallback(
        async (group: ShareGroupSummaryItem) => {
            if (deletingGroupId) {
                return;
            }

            try {
                setDeletingGroupId(group.groupId);

                const result = (await (
                    client.mutations.deleteOwnedShareGroup as any
                )({
                    groupId: group.groupId,
                })) as ShareGroupActionResult;

                if (result.errors?.length) {
                    console.error(
                        "deleteOwnedShareGroup errors:",
                        result.errors,
                    );

                    throw new Error(
                        getFirstGraphQLErrorMessage(result.errors) ??
                            "グループを削除できませんでした。",
                    );
                }

                if (!result.data?.success) {
                    throw new Error(
                        result.data?.message ??
                            "グループを削除できませんでした。",
                    );
                }

                /*
                 * 削除したグループの招待コードを
                 * 直前に作成・再発行して表示していた場合は消す。
                 */
                if (createdGroupName === group.name) {
                    setCreatedGroupName(null);
                    setCreatedInviteCode(null);
                }

                await loadGroups();

                Alert.alert("削除完了", `「${group.name}」を削除しました。`);
            } catch (error) {
                console.error("Delete share group error:", error);

                Alert.alert("削除エラー", getErrorMessage(error));
            } finally {
                setDeletingGroupId(null);
            }
        },
        [createdGroupName, deletingGroupId, loadGroups],
    );

    const confirmDeleteGroup = useCallback(
        (group: ShareGroupSummaryItem) => {
            Alert.alert(
                "共有グループを削除",
                [
                    `「${group.name}」を削除します。`,
                    "",
                    "このグループのメンバー情報も削除されます。",
                    "メンバーはこのグループを利用できなくなります。",
                    "",
                    "この操作は元に戻せません。",
                    "",
                    "削除しますか？",
                ].join("\n"),
                [
                    {
                        text: "キャンセル",
                        style: "cancel",
                    },
                    {
                        text: "削除",
                        style: "destructive",
                        onPress: () => {
                            void handleDeleteGroup(group);
                        },
                    },
                ],
            );
        },
        [handleDeleteGroup],
    );

    const handleShareInviteCode = async () => {
        if (!createdInviteCode) {
            Alert.alert(
                "招待コードがありません",
                "先に共有グループを作成してください。",
            );
            return;
        }

        try {
            await Share.share({
                message: [
                    "AcLog Fitの共有グループに招待します。",
                    "",
                    `グループ名: ${createdGroupName || "共有グループ"}`,
                    `招待コード: ${createdInviteCode}`,
                    "",
                    "アプリの「共有グループを管理」から招待コードを入力して参加してください。",
                ].join("\n"),
            });
        } catch (error) {
            console.error("Share invite code error:", error);

            Alert.alert("共有エラー", "招待コードを共有できませんでした。");
        }
    };

    return (
        <View style={styles.screen}>
            <StatusBar
                style="light"
                backgroundColor="#06395f"
                translucent={false}
            />

            {/* ヘッダ */}
            <View
                style={[
                    styles.appHeader,
                    {
                        paddingTop: Math.max(insets.top, 8),
                    },
                ]}
            >
                <Pressable
                    style={styles.headerBackButton}
                    onPress={() => navigation.goBack()}
                >
                    <Text style={styles.headerBackText}>‹</Text>
                </Pressable>

                <Text style={styles.headerTitle} numberOfLines={1}>
                    共有グループ管理
                </Text>

                <View style={styles.headerRightSpace} />
            </View>

            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.container}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
            >
                {/* グループを作成 */}
                <View style={styles.sectionCard}>
                    <View style={styles.sectionHeader}>
                        <View style={styles.sectionIconCircle}>
                            <MaterialCommunityIcons
                                name="account-multiple-plus-outline"
                                size={21}
                                color="#ffffff"
                            />
                        </View>

                        <View style={styles.sectionHeaderTextArea}>
                            <Text style={styles.sectionTitle}>
                                新しいグループを作成
                            </Text>

                            <Text style={styles.sectionDescription}>
                                位置情報を共有したい相手とのグループを作成します。
                            </Text>
                        </View>
                    </View>

                    <View style={styles.limitInfoRow}>
                        <MaterialCommunityIcons
                            name="account-group-outline"
                            size={17}
                            color="#71838c"
                        />

                        <Text style={styles.groupLimitText}>
                            作成済み {ownedGroupCount}
                            {maxOwnedShareGroups !== null
                                ? ` / ${maxOwnedShareGroups}グループ`
                                : " / 上限なし"}
                        </Text>
                    </View>

                    <TextInput
                        style={[
                            styles.input,
                            !canCreateCurrentPlanShareGroup &&
                                styles.disabledInput,
                        ]}
                        value={groupName}
                        onChangeText={setGroupName}
                        placeholder="例：家族、ランニング仲間"
                        placeholderTextColor="#9aa8ae"
                        maxLength={50}
                        editable={
                            !creatingGroup &&
                            !subscriptionLoading &&
                            canCreateCurrentPlanShareGroup
                        }
                    />

                    <Pressable
                        style={({ pressed }) => [
                            styles.primaryButton,
                            pressed &&
                                !creatingGroup &&
                                !subscriptionLoading &&
                                canCreateCurrentPlanShareGroup &&
                                styles.buttonPressed,
                            (creatingGroup ||
                                subscriptionLoading ||
                                !canCreateCurrentPlanShareGroup) &&
                                styles.disabledButton,
                        ]}
                        onPress={() => {
                            void handleCreateGroup();
                        }}
                        disabled={
                            creatingGroup ||
                            subscriptionLoading ||
                            !canCreateCurrentPlanShareGroup
                        }
                    >
                        {creatingGroup ? (
                            <View style={styles.buttonLoadingRow}>
                                <ActivityIndicator
                                    size="small"
                                    color="#ffffff"
                                />

                                <Text style={styles.primaryButtonText}>
                                    作成中...
                                </Text>
                            </View>
                        ) : (
                            <>
                                <MaterialCommunityIcons
                                    name="plus-circle-outline"
                                    size={19}
                                    color="#ffffff"
                                />

                                <Text style={styles.primaryButtonText}>
                                    {subscriptionLoading
                                        ? "プラン確認中..."
                                        : !canCreateCurrentPlanShareGroup
                                          ? "作成上限に達しています"
                                          : "新しいグループを作成"}
                                </Text>
                            </>
                        )}
                    </Pressable>

                    {/* 作成・再発行した招待コード */}
                    {createdInviteCode && (
                        <View style={styles.inviteCodeBox}>
                            <View style={styles.inviteCodeHeader}>
                                <MaterialCommunityIcons
                                    name="ticket-confirmation-outline"
                                    size={20}
                                    color="#0e9384"
                                />

                                <Text style={styles.inviteCodeTitle}>
                                    招待コード
                                </Text>
                            </View>

                            {createdGroupName && (
                                <Text style={styles.inviteGroupName}>
                                    {createdGroupName}
                                </Text>
                            )}

                            <Text style={styles.inviteCodeText} selectable>
                                {createdInviteCode}
                            </Text>

                            <Text style={styles.inviteCodeHelp}>
                                このコードを参加してほしい相手へ伝えてください。
                            </Text>

                            <Pressable
                                style={({ pressed }) => [
                                    styles.shareInviteButton,
                                    pressed && styles.buttonPressed,
                                ]}
                                onPress={() => {
                                    void handleShareInviteCode();
                                }}
                            >
                                <MaterialCommunityIcons
                                    name="share-variant-outline"
                                    size={18}
                                    color="#0e7185"
                                />

                                <Text style={styles.shareInviteButtonText}>
                                    招待コードを共有
                                </Text>
                            </Pressable>

                            <View style={styles.inviteWarningRow}>
                                <MaterialCommunityIcons
                                    name="alert-circle-outline"
                                    size={15}
                                    color="#a66a34"
                                />

                                <Text style={styles.inviteCodeWarning}>
                                    この画面を離れると招待コードは
                                    再表示できません。
                                </Text>
                            </View>
                        </View>
                    )}
                </View>

                {/* 招待コードで参加 */}
                <View style={styles.sectionCard}>
                    <View style={styles.sectionHeader}>
                        <View
                            style={[
                                styles.sectionIconCircle,
                                styles.joinIconCircle,
                            ]}
                        >
                            <MaterialCommunityIcons
                                name="account-arrow-left-outline"
                                size={21}
                                color="#ffffff"
                            />
                        </View>

                        <View style={styles.sectionHeaderTextArea}>
                            <Text style={styles.sectionTitle}>
                                招待コードで参加
                            </Text>

                            <Text style={styles.sectionDescription}>
                                相手から受け取った招待コードを入力します。
                            </Text>
                        </View>
                    </View>

                    <TextInput
                        style={[styles.input, styles.inviteInput]}
                        value={inviteCodeInput}
                        onChangeText={setInviteCodeInput}
                        placeholder="AB7K92FD"
                        placeholderTextColor="#9aa8ae"
                        autoCapitalize="characters"
                        autoCorrect={false}
                        maxLength={12}
                        editable={!joiningGroup}
                    />

                    <Pressable
                        style={({ pressed }) => [
                            styles.secondaryPrimaryButton,
                            pressed && !joiningGroup && styles.buttonPressed,
                            joiningGroup && styles.disabledButton,
                        ]}
                        onPress={() => {
                            void handleJoinGroup();
                        }}
                        disabled={joiningGroup}
                    >
                        {joiningGroup ? (
                            <View style={styles.buttonLoadingRow}>
                                <ActivityIndicator
                                    size="small"
                                    color="#ffffff"
                                />

                                <Text style={styles.primaryButtonText}>
                                    参加処理中...
                                </Text>
                            </View>
                        ) : (
                            <>
                                <MaterialCommunityIcons
                                    name="login-variant"
                                    size={18}
                                    color="#ffffff"
                                />

                                <Text style={styles.primaryButtonText}>
                                    グループに参加
                                </Text>
                            </>
                        )}
                    </Pressable>
                </View>

                {/* 所属グループ */}
                <View style={styles.groupsSection}>
                    <View style={styles.groupsHeader}>
                        <View>
                            <Text style={styles.groupsTitle}>所属グループ</Text>

                            <Text style={styles.groupsDescription}>
                                位置情報を共有するグループを管理します。
                            </Text>
                        </View>

                        <Pressable
                            style={({ pressed }) => [
                                styles.refreshButton,
                                pressed &&
                                    !loadingGroups &&
                                    styles.buttonPressed,
                                loadingGroups && styles.disabledButton,
                            ]}
                            onPress={() => {
                                void loadGroups();
                            }}
                            disabled={loadingGroups}
                        >
                            <MaterialCommunityIcons
                                name="refresh"
                                size={18}
                                color="#0e7185"
                            />

                            <Text style={styles.refreshButtonText}>更新</Text>
                        </Pressable>
                    </View>

                    {loadingGroups ? (
                        <View style={styles.loadingGroupsBox}>
                            <ActivityIndicator size="small" color="#0e9384" />

                            <Text style={styles.loadingGroupsText}>
                                グループを読み込み中...
                            </Text>
                        </View>
                    ) : groups.length === 0 ? (
                        <View style={styles.emptyCard}>
                            <MaterialCommunityIcons
                                name="account-group-outline"
                                size={36}
                                color="#99a8af"
                            />

                            <Text style={styles.emptyTitle}>
                                所属グループはありません
                            </Text>

                            <Text style={styles.emptyText}>
                                グループを作成するか、招待コードで参加してください。
                            </Text>
                        </View>
                    ) : (
                        groups.map((group) => {
                            const isOwner = group.role === "OWNER";

                            const isRegenerating =
                                regeneratingGroupId === group.groupId;

                            const isDeleting =
                                deletingGroupId === group.groupId;

                            const members = (group.members ?? []).filter(
                                (
                                    member,
                                ): member is ShareGroupMemberSummaryItem =>
                                    member !== null,
                            );

                            return (
                                <View
                                    key={group.groupId}
                                    style={styles.groupCard}
                                >
                                    <View style={styles.groupCardHeader}>
                                        <View style={styles.groupTitleArea}>
                                            <View
                                                style={styles.groupIconCircle}
                                            >
                                                <MaterialCommunityIcons
                                                    name="account-group"
                                                    size={22}
                                                    color="#0e9384"
                                                />
                                            </View>

                                            <View style={styles.groupNameArea}>
                                                <Text
                                                    style={styles.groupName}
                                                    numberOfLines={1}
                                                >
                                                    {group.name}
                                                </Text>

                                                <Text
                                                    style={
                                                        styles.memberCountText
                                                    }
                                                >
                                                    {members.length}
                                                    人のメンバー
                                                </Text>
                                            </View>
                                        </View>

                                        <View
                                            style={[
                                                styles.roleBadge,
                                                isOwner
                                                    ? styles.ownerBadge
                                                    : styles.memberBadge,
                                            ]}
                                        >
                                            <Text
                                                style={[
                                                    styles.roleBadgeText,
                                                    isOwner &&
                                                        styles.ownerBadgeText,
                                                ]}
                                            >
                                                {isOwner
                                                    ? "作成者"
                                                    : "メンバー"}
                                            </Text>
                                        </View>
                                    </View>

                                    {/* メンバー */}
                                    <View style={styles.groupMembersArea}>
                                        <Text style={styles.groupMembersTitle}>
                                            メンバー
                                        </Text>

                                        <View style={styles.groupMembersList}>
                                            {members.map((member) => {
                                                const displayName =
                                                    member.displayName?.trim() ||
                                                    "ユーザー";

                                                const iconUrl =
                                                    member.iconImagePath
                                                        ? memberIconUrls[
                                                              member
                                                                  .iconImagePath
                                                          ]
                                                        : undefined;

                                                return (
                                                    <View
                                                        key={member.userId}
                                                        style={
                                                            styles.groupMemberItem
                                                        }
                                                    >
                                                        <View
                                                            style={
                                                                styles.memberIconWrapper
                                                            }
                                                        >
                                                            {iconUrl ? (
                                                                <Image
                                                                    source={{
                                                                        uri: iconUrl,
                                                                    }}
                                                                    style={
                                                                        styles.groupMemberIcon
                                                                    }
                                                                />
                                                            ) : (
                                                                <View
                                                                    style={
                                                                        styles.groupMemberIconPlaceholder
                                                                    }
                                                                >
                                                                    <Text
                                                                        style={
                                                                            styles.groupMemberIconPlaceholderText
                                                                        }
                                                                    >
                                                                        {displayName.charAt(
                                                                            0,
                                                                        )}
                                                                    </Text>
                                                                </View>
                                                            )}

                                                            {member.role ===
                                                                "OWNER" && (
                                                                <View
                                                                    style={
                                                                        styles.ownerMiniBadge
                                                                    }
                                                                >
                                                                    <MaterialCommunityIcons
                                                                        name="crown"
                                                                        size={
                                                                            10
                                                                        }
                                                                        color="#ffffff"
                                                                    />
                                                                </View>
                                                            )}
                                                        </View>

                                                        <Text
                                                            style={
                                                                styles.groupMemberName
                                                            }
                                                            numberOfLines={1}
                                                        >
                                                            {displayName}
                                                        </Text>
                                                    </View>
                                                );
                                            })}
                                        </View>
                                    </View>

                                    {isOwner && (
                                        <View style={styles.ownerActionArea}>
                                            <Pressable
                                                style={({ pressed }) => [
                                                    styles.regenerateButton,
                                                    pressed &&
                                                        !isRegenerating &&
                                                        !isDeleting &&
                                                        styles.buttonPressed,
                                                    (isRegenerating ||
                                                        isDeleting) &&
                                                        styles.disabledButton,
                                                ]}
                                                onPress={() => {
                                                    confirmRegenerateInviteCode(
                                                        group,
                                                    );
                                                }}
                                                disabled={
                                                    isRegenerating || isDeleting
                                                }
                                            >
                                                <MaterialCommunityIcons
                                                    name="refresh"
                                                    size={17}
                                                    color="#0e7185"
                                                />

                                                <Text
                                                    style={
                                                        styles.regenerateButtonText
                                                    }
                                                >
                                                    {isRegenerating
                                                        ? "再発行中..."
                                                        : "招待コードを再発行"}
                                                </Text>
                                            </Pressable>

                                            <Pressable
                                                style={({ pressed }) => [
                                                    styles.deleteGroupButton,
                                                    pressed &&
                                                        !isDeleting &&
                                                        !isRegenerating &&
                                                        styles.deleteGroupButtonPressed,
                                                    (isDeleting ||
                                                        isRegenerating) &&
                                                        styles.disabledButton,
                                                ]}
                                                onPress={() => {
                                                    confirmDeleteGroup(group);
                                                }}
                                                disabled={
                                                    isDeleting || isRegenerating
                                                }
                                            >
                                                <MaterialCommunityIcons
                                                    name="delete-outline"
                                                    size={17}
                                                    color="#c0392b"
                                                />

                                                <Text
                                                    style={
                                                        styles.deleteGroupButtonText
                                                    }
                                                >
                                                    {isDeleting
                                                        ? "削除中..."
                                                        : "グループを削除"}
                                                </Text>
                                            </Pressable>
                                        </View>
                                    )}
                                </View>
                            );
                        })
                    )}
                </View>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    screen: {
        flex: 1,
        backgroundColor: "#f3f7f9",
    },

    appHeader: {
        minHeight: 58,

        paddingHorizontal: 10,
        paddingBottom: 8,

        flexDirection: "row",
        alignItems: "flex-end",

        backgroundColor: "#06395f",

        elevation: 6,

        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.16,
        shadowRadius: 4,
    },

    headerBackButton: {
        width: 46,
        height: 44,

        alignItems: "center",
        justifyContent: "center",
    },

    headerBackText: {
        color: "#ffffff",

        fontSize: 42,
        lineHeight: 42,
        fontWeight: "300",
    },

    headerTitle: {
        flex: 1,

        paddingBottom: 9,

        textAlign: "center",

        color: "#ffffff",

        fontSize: 18,
        fontWeight: "700",
    },

    headerRightSpace: {
        width: 46,
        height: 44,
    },

    scrollView: {
        flex: 1,
    },

    container: {
        paddingHorizontal: 14,
        paddingTop: 14,
        paddingBottom: 36,

        backgroundColor: "#f3f7f9",
    },

    sectionCard: {
        marginBottom: 12,

        padding: 15,

        borderWidth: 1,
        borderColor: "#dfe7ea",
        borderRadius: 14,

        backgroundColor: "#ffffff",

        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.05,
        shadowRadius: 4,

        elevation: 1,
    },

    sectionHeader: {
        flexDirection: "row",
        alignItems: "center",

        marginBottom: 14,
    },

    sectionIconCircle: {
        width: 42,
        height: 42,

        marginRight: 11,

        borderRadius: 21,

        alignItems: "center",
        justifyContent: "center",

        backgroundColor: "#0e9384",
    },

    joinIconCircle: {
        backgroundColor: "#557fc7",
    },

    sectionHeaderTextArea: {
        flex: 1,
    },

    sectionTitle: {
        color: "#203f4f",

        fontSize: 16,
        fontWeight: "700",
    },

    sectionDescription: {
        marginTop: 2,

        color: "#71838c",

        fontSize: 11,
        lineHeight: 16,
    },

    limitInfoRow: {
        marginBottom: 10,

        flexDirection: "row",
        alignItems: "center",

        gap: 5,
    },

    groupLimitText: {
        color: "#71838c",

        fontSize: 12,
    },

    input: {
        height: 44,

        paddingHorizontal: 12,

        borderWidth: 1,
        borderColor: "#d3dfe4",
        borderRadius: 9,

        backgroundColor: "#ffffff",

        color: "#213f4d",

        fontSize: 15,
    },

    inviteInput: {
        letterSpacing: 2,

        fontWeight: "700",
        textAlign: "center",
    },

    disabledInput: {
        backgroundColor: "#f1f4f5",

        color: "#9aa5aa",
    },

    primaryButton: {
        minHeight: 46,

        marginTop: 12,

        paddingHorizontal: 12,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",

        gap: 7,

        borderRadius: 10,

        backgroundColor: "#0e9384",
    },

    secondaryPrimaryButton: {
        minHeight: 46,

        marginTop: 12,

        paddingHorizontal: 12,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",

        gap: 7,

        borderRadius: 10,

        backgroundColor: "#557fc7",
    },

    primaryButtonText: {
        color: "#ffffff",

        fontSize: 14,
        fontWeight: "700",
    },

    buttonLoadingRow: {
        flexDirection: "row",
        alignItems: "center",

        gap: 8,
    },

    buttonPressed: {
        opacity: 0.7,
    },

    disabledButton: {
        opacity: 0.5,
    },

    inviteCodeBox: {
        marginTop: 14,

        padding: 14,

        alignItems: "center",

        borderWidth: 1,
        borderColor: "#b9dbd5",
        borderRadius: 12,

        backgroundColor: "#f3fbf9",
    },

    inviteCodeHeader: {
        flexDirection: "row",
        alignItems: "center",

        gap: 6,
    },

    inviteCodeTitle: {
        color: "#46616c",

        fontSize: 13,
        fontWeight: "700",
    },

    inviteGroupName: {
        marginTop: 7,

        color: "#536b75",

        fontSize: 12,
    },

    inviteCodeText: {
        marginVertical: 8,

        color: "#0e7185",

        fontSize: 27,
        fontWeight: "800",

        letterSpacing: 3,
    },

    inviteCodeHelp: {
        color: "#71838c",

        textAlign: "center",

        fontSize: 11,
        lineHeight: 16,
    },

    shareInviteButton: {
        minHeight: 40,

        marginTop: 12,
        paddingHorizontal: 18,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",

        gap: 6,

        borderWidth: 1,
        borderColor: "#b8d4dc",
        borderRadius: 20,

        backgroundColor: "#ffffff",
    },

    shareInviteButtonText: {
        color: "#0e7185",

        fontSize: 12,
        fontWeight: "700",
    },

    inviteWarningRow: {
        marginTop: 10,

        flexDirection: "row",
        alignItems: "flex-start",

        gap: 4,
    },

    inviteCodeWarning: {
        flex: 1,

        color: "#a66a34",

        fontSize: 10,
        lineHeight: 15,
    },

    groupsSection: {
        marginTop: 3,
    },

    groupsHeader: {
        marginBottom: 11,

        paddingHorizontal: 2,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
    },

    groupsTitle: {
        color: "#203f4f",

        fontSize: 17,
        fontWeight: "700",
    },

    groupsDescription: {
        marginTop: 2,

        color: "#819198",

        fontSize: 11,
    },

    refreshButton: {
        minHeight: 34,

        paddingHorizontal: 11,

        flexDirection: "row",
        alignItems: "center",

        gap: 4,

        borderWidth: 1,
        borderColor: "#c4d9df",
        borderRadius: 17,

        backgroundColor: "#ffffff",
    },

    refreshButtonText: {
        color: "#0e7185",

        fontSize: 11,
        fontWeight: "700",
    },

    loadingGroupsBox: {
        paddingVertical: 30,

        alignItems: "center",

        gap: 8,
    },

    loadingGroupsText: {
        color: "#71838c",

        fontSize: 12,
    },

    emptyCard: {
        paddingVertical: 28,
        paddingHorizontal: 20,

        alignItems: "center",

        borderWidth: 1,
        borderColor: "#dfe7ea",
        borderRadius: 14,

        backgroundColor: "#ffffff",
    },

    emptyTitle: {
        marginTop: 8,

        color: "#405d69",

        fontSize: 14,
        fontWeight: "700",
    },

    emptyText: {
        marginTop: 4,

        textAlign: "center",

        color: "#819198",

        fontSize: 11,
        lineHeight: 17,
    },

    groupCard: {
        marginBottom: 11,

        padding: 14,

        borderWidth: 1,
        borderColor: "#dfe7ea",
        borderRadius: 14,

        backgroundColor: "#ffffff",

        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.05,
        shadowRadius: 4,

        elevation: 1,
    },

    groupCardHeader: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
    },

    groupTitleArea: {
        flex: 1,

        flexDirection: "row",
        alignItems: "center",
    },

    groupIconCircle: {
        width: 42,
        height: 42,

        marginRight: 10,

        borderRadius: 21,

        alignItems: "center",
        justifyContent: "center",

        backgroundColor: "#e3f5f1",
    },

    groupNameArea: {
        flex: 1,
        minWidth: 0,
    },

    groupName: {
        color: "#203f4f",

        fontSize: 15,
        fontWeight: "700",
    },

    memberCountText: {
        marginTop: 2,

        color: "#819198",

        fontSize: 11,
    },

    roleBadge: {
        minHeight: 25,

        marginLeft: 8,
        paddingHorizontal: 9,

        alignItems: "center",
        justifyContent: "center",

        borderRadius: 13,
    },

    ownerBadge: {
        backgroundColor: "#def4ef",
    },

    memberBadge: {
        backgroundColor: "#e8eef2",
    },

    roleBadgeText: {
        color: "#617681",

        fontSize: 10,
        fontWeight: "700",
    },

    ownerBadgeText: {
        color: "#0e7f72",
    },

    groupMembersArea: {
        marginTop: 14,
        paddingTop: 12,

        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: "#dfe7ea",
    },

    groupMembersTitle: {
        marginBottom: 9,

        color: "#607780",

        fontSize: 12,
        fontWeight: "700",
    },

    groupMembersList: {
        flexDirection: "row",
        flexWrap: "wrap",

        gap: 12,
    },

    groupMemberItem: {
        width: 60,

        alignItems: "center",
    },

    memberIconWrapper: {
        position: "relative",
    },

    groupMemberIcon: {
        width: 44,
        height: 44,

        borderRadius: 22,

        backgroundColor: "#e6edf3",
    },

    groupMemberIconPlaceholder: {
        width: 44,
        height: 44,

        borderRadius: 22,

        alignItems: "center",
        justifyContent: "center",

        backgroundColor: "#dfe9ed",

        borderWidth: 1,
        borderColor: "#cad8de",
    },

    groupMemberIconPlaceholderText: {
        color: "#456575",

        fontSize: 16,
        fontWeight: "700",
    },

    ownerMiniBadge: {
        position: "absolute",

        right: -2,
        bottom: -1,

        width: 18,
        height: 18,

        borderRadius: 9,

        alignItems: "center",
        justifyContent: "center",

        borderWidth: 1.5,
        borderColor: "#ffffff",

        backgroundColor: "#d6a022",
    },

    groupMemberName: {
        width: 60,

        marginTop: 5,

        textAlign: "center",

        color: "#526872",

        fontSize: 10,
    },

    ownerActionArea: {
        marginTop: 14,

        paddingTop: 12,

        flexDirection: "row",

        gap: 8,

        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: "#dfe7ea",
    },

    regenerateButton: {
        flex: 1,

        minHeight: 40,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",

        gap: 5,

        borderWidth: 1,
        borderColor: "#b7d4dc",
        borderRadius: 9,

        backgroundColor: "#ffffff",
    },

    regenerateButtonText: {
        color: "#0e7185",

        fontSize: 11,
        fontWeight: "700",
    },

    deleteGroupButton: {
        flex: 1,

        minHeight: 40,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",

        gap: 5,

        borderWidth: 1,
        borderColor: "#e3b9b5",
        borderRadius: 9,

        backgroundColor: "#fff8f7",
    },

    deleteGroupButtonPressed: {
        backgroundColor: "#fdeceb",
    },

    deleteGroupButtonText: {
        color: "#c0392b",

        fontSize: 11,
        fontWeight: "700",
    },
});
