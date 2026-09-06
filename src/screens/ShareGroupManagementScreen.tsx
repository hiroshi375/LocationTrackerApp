import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Pressable,
    ScrollView,
    Share,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";

import { client } from "../lib/client";

import {
    FREE_PLAN_LIMITS,
    canCreateShareGroup,
} from "../config/subscriptionPlan";

type ShareGroupSummaryItem = {
    groupId: string;
    name: string;
    role: string;
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
    const [groups, setGroups] = useState<ShareGroupSummaryItem[]>([]);
    const [loadingGroups, setLoadingGroups] = useState(false);
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

    const ownedGroupCount = groups.filter(
        (group) => group.role === "OWNER",
    ).length;

    const canCreateFreeShareGroup = canCreateShareGroup(
        "FREE",
        ownedGroupCount,
    );

    const maxOwnedShareGroups = FREE_PLAN_LIMITS.maxOwnedShareGroups;

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
        if (creatingGroup) {
            return;
        }

        if (!canCreateFreeShareGroup) {
            Alert.alert(
                "作成上限",
                `Freeプランでは共有グループを${maxOwnedShareGroups}件まで作成できます。`,
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
        canCreateFreeShareGroup,
        creatingGroup,
        groupName,
        loadGroups,
        maxOwnedShareGroups,
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
                    "LocationTrackerAppの共有グループに招待します。",
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
        <ScrollView
            contentContainerStyle={styles.container}
            keyboardShouldPersistTaps="handled"
        >
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>グループを作成</Text>

                <Text style={styles.description}>
                    位置情報を共有したい相手とのグループを作成します。
                </Text>
                <Text style={styles.groupLimitText}>
                    作成済み: {ownedGroupCount} / {maxOwnedShareGroups}グループ
                </Text>

                {!canCreateFreeShareGroup && (
                    <Text style={styles.limitWarningText}>
                        Freeプランでは共有グループを
                        {maxOwnedShareGroups}件まで作成できます。
                    </Text>
                )}
                <TextInput
                    style={[
                        styles.input,
                        !canCreateFreeShareGroup && styles.disabledInput,
                    ]}
                    value={groupName}
                    onChangeText={setGroupName}
                    placeholder="例：家族、ランニング仲間"
                    maxLength={50}
                    editable={!creatingGroup && canCreateFreeShareGroup}
                />

                <Pressable
                    style={({ pressed }) => [
                        styles.primaryButton,
                        pressed &&
                            !creatingGroup &&
                            canCreateFreeShareGroup &&
                            styles.buttonPressed,
                        (creatingGroup || !canCreateFreeShareGroup) &&
                            styles.disabledButton,
                    ]}
                    onPress={() => {
                        void handleCreateGroup();
                    }}
                    disabled={creatingGroup || !canCreateFreeShareGroup}
                >
                    <Text style={styles.primaryButtonText}>
                        {creatingGroup
                            ? "作成中..."
                            : !canCreateFreeShareGroup
                              ? "作成上限に達しています"
                              : "グループを作成"}
                    </Text>
                </Pressable>

                {createdInviteCode && (
                    <View style={styles.inviteCodeBox}>
                        <Text style={styles.inviteCodeTitle}>招待コード</Text>

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
                            <Text style={styles.shareInviteButtonText}>
                                招待コードを共有
                            </Text>
                        </Pressable>

                        <Text style={styles.inviteCodeWarning}>
                            この画面を離れると招待コードは再表示できません。
                        </Text>
                    </View>
                )}
            </View>

            <View style={styles.section}>
                <Text style={styles.sectionTitle}>招待コードで参加</Text>

                <Text style={styles.description}>
                    相手から受け取った招待コードを入力します。
                </Text>

                <TextInput
                    style={[styles.input, styles.inviteInput]}
                    value={inviteCodeInput}
                    onChangeText={setInviteCodeInput}
                    placeholder="AB7K92FD"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    maxLength={12}
                    editable={!joiningGroup}
                />

                <Pressable
                    style={({ pressed }) => [
                        styles.primaryButton,
                        pressed && !joiningGroup && styles.buttonPressed,
                        joiningGroup && styles.disabledButton,
                    ]}
                    onPress={() => {
                        void handleJoinGroup();
                    }}
                    disabled={joiningGroup}
                >
                    <Text style={styles.primaryButtonText}>
                        {joiningGroup ? "参加処理中..." : "グループに参加"}
                    </Text>
                </Pressable>
            </View>

            <View style={styles.section}>
                <View style={styles.groupHeader}>
                    <Text style={styles.sectionTitle}>所属グループ</Text>

                    <Pressable
                        style={styles.refreshButton}
                        onPress={() => {
                            void loadGroups();
                        }}
                        disabled={loadingGroups}
                    >
                        <Text style={styles.refreshButtonText}>更新</Text>
                    </Pressable>
                </View>

                {loadingGroups ? (
                    <ActivityIndicator
                        style={{
                            marginVertical: 20,
                        }}
                    />
                ) : groups.length === 0 ? (
                    <Text style={styles.emptyText}>
                        所属しているグループはありません。
                    </Text>
                ) : (
                    groups.map((group) => {
                        const isOwner = group.role === "OWNER";

                        const isRegenerating =
                            regeneratingGroupId === group.groupId;

                        return (
                            <View key={group.groupId} style={styles.groupItem}>
                                <View style={styles.groupNameArea}>
                                    <Text style={styles.groupName}>
                                        {group.name}
                                    </Text>

                                    <Text style={styles.groupRoleText}>
                                        {isOwner ? "作成者" : "メンバー"}
                                    </Text>
                                </View>

                                {isOwner && (
                                    <Pressable
                                        style={({ pressed }) => [
                                            styles.regenerateButton,
                                            pressed &&
                                                !isRegenerating &&
                                                styles.buttonPressed,
                                            isRegenerating &&
                                                styles.disabledButton,
                                        ]}
                                        onPress={() => {
                                            confirmRegenerateInviteCode(group);
                                        }}
                                        disabled={isRegenerating}
                                    >
                                        <Text
                                            style={styles.regenerateButtonText}
                                        >
                                            {isRegenerating
                                                ? "再発行中..."
                                                : "招待コードを再発行"}
                                        </Text>
                                    </Pressable>
                                )}
                            </View>
                        );
                    })
                )}
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        padding: 20,
        paddingBottom: 40,
        gap: 16,
        backgroundColor: "#fff",
    },

    section: {
        borderWidth: 1,
        borderColor: "#d9e0e6",
        borderRadius: 10,
        padding: 16,
        gap: 12,
        backgroundColor: "#fff",
    },

    sectionTitle: {
        fontSize: 18,
        fontWeight: "bold",
        color: "#333",
    },

    description: {
        fontSize: 14,
        color: "#666",
        lineHeight: 20,
    },

    input: {
        borderWidth: 1,
        borderColor: "#c8d0d7",
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 16,
        backgroundColor: "#fff",
    },

    inviteInput: {
        letterSpacing: 2,
        fontWeight: "bold",
    },

    primaryButton: {
        backgroundColor: "#4b6f8f",
        borderRadius: 8,
        paddingVertical: 10,
        alignItems: "center",
        justifyContent: "center",
    },

    primaryButtonText: {
        color: "#fff",
        fontSize: 15,
        fontWeight: "bold",
    },

    buttonPressed: {
        opacity: 0.75,
    },

    disabledButton: {
        opacity: 0.5,
    },

    inviteCodeBox: {
        borderWidth: 1,
        borderColor: "#9eb4c7",
        borderRadius: 10,
        padding: 16,
        alignItems: "center",
        backgroundColor: "#f5f8fa",
        gap: 6,
    },

    inviteCodeTitle: {
        fontSize: 14,
        color: "#555",
        fontWeight: "bold",
    },

    inviteGroupName: {
        fontSize: 15,
        color: "#333",
    },

    inviteCodeText: {
        fontSize: 28,
        fontWeight: "bold",
        letterSpacing: 3,
        color: "#2f536f",
        marginVertical: 4,
    },

    inviteCodeHelp: {
        fontSize: 13,
        color: "#555",
        textAlign: "center",
    },

    inviteCodeWarning: {
        fontSize: 12,
        color: "#8b5a3c",
        textAlign: "center",
    },

    shareInviteButton: {
        marginTop: 8,
        backgroundColor: "#4b6f8f",
        borderRadius: 8,
        paddingVertical: 10,
        paddingHorizontal: 24,
        alignItems: "center",
        justifyContent: "center",
        alignSelf: "stretch",
    },

    shareInviteButtonText: {
        color: "#fff",
        fontSize: 15,
        fontWeight: "bold",
    },

    groupHeader: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
    },

    refreshButton: {
        paddingHorizontal: 12,
        paddingVertical: 6,
    },

    refreshButtonText: {
        color: "#4b6f8f",
        fontWeight: "bold",
    },

    emptyText: {
        fontSize: 14,
        color: "#777",
        paddingVertical: 12,
    },

    groupItem: {
        borderTopWidth: 1,
        borderTopColor: "#e5e8eb",
        paddingVertical: 12,
    },

    groupNameArea: {
        gap: 4,
    },

    groupName: {
        fontSize: 16,
        fontWeight: "bold",
        color: "#333",
    },

    groupRoleText: {
        fontSize: 13,
        color: "#777",
    },

    regenerateButton: {
        marginTop: 10,
        borderWidth: 1,
        borderColor: "#4b6f8f",
        borderRadius: 8,
        paddingVertical: 8,
        paddingHorizontal: 12,
        alignItems: "center",
        justifyContent: "center",
    },

    regenerateButtonText: {
        color: "#4b6f8f",
        fontSize: 14,
        fontWeight: "bold",
    },

    groupLimitText: {
        fontSize: 13,
        color: "#666",
    },

    limitWarningText: {
        fontSize: 13,
        color: "#b45309",
        lineHeight: 19,
    },

    disabledInput: {
        backgroundColor: "#f1f3f5",
        color: "#999",
    },
});
