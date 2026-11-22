import { useCallback, useRef, useState, type ComponentProps } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { Alert, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { client } from "../lib/client";

function GroupActionButton({
    title,
    onPress,
    disabled = false,
    destructive = false,
    icon,
}: {
    title: string;
    onPress: () => void;
    disabled?: boolean;
    destructive?: boolean;
    icon?: ComponentProps<typeof MaterialCommunityIcons>["name"];
}) {
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={onPress}
            style={({ pressed }) => [
                styles.actionButton,
                destructive && styles.destructiveButton,
                pressed && !disabled && (
                    destructive ? styles.destructivePressed : styles.actionPressed
                ),
                disabled && styles.disabledButton,
            ]}
        >
            {icon && (
                <MaterialCommunityIcons
                    name={icon}
                    size={17}
                    color={destructive ? "#c0392b" : "#0e7185"}
                />
            )}
            <Text style={[
                styles.actionText,
                destructive && styles.destructiveText,
            ]}>
                {title}
            </Text>
        </Pressable>
    );
}

type Operation = {
    groupId: string;
    operationId: string;
    groupName?: string;
    status: string;
    phase?: string;
    message?: string;
    completedSessionCount?: number;
    canCancel?: boolean;
    success?: boolean;
    accepted?: boolean;
};
const phaseLabels: Record<string, string> = {
    SNAPSHOT: "グループの所属を確認中",
    PREPARE_SESSIONS: "既存の履歴共有を確認中",
    PREPARE_LOGS: "既存の位置情報の共有を確認中",
    DISCOVER: "対象の共有権限を確認中",
    NEXT: "次の履歴を確認中",
    GRANTS: "共有権限を解除中",
    LOGS: "位置情報の閲覧権限を更新中",
    VERIFY_LOGS: "位置情報の権限を確認中",
    SESSION: "履歴の閲覧権限を更新中",
    VERIFY_SESSION: "履歴の権限を確認中",
    MEMBERS: "グループの所属を更新中",
    FINALIZE: "完了を確認中",
};
type Group = {
    groupId: string;
    name: string;
    role: string;
    operationId?: string | null;
    members?:
        | ({
              userId: string;
              role: string;
              displayName?: string | null;
              iconImagePath?: string | null;
          } | null)[]
        | null;
};
async function action(name: string, args: object): Promise<Operation> {
    const result = await (
        client.mutations[name] as (
            args: object,
        ) => Promise<{ data?: Operation; errors?: { message?: string }[] }>
    )(args);
    if (result.errors?.length || !result.data)
        throw new Error(
            result.errors?.[0]?.message ?? "操作結果を取得できませんでした。",
        );
    return result.data;
}
export function GroupAccessActions({
    group,
    memberIconUrls = {},
    onChanged,
}: {
    group: Group;
    memberIconUrls?: Record<string, string>;
    onChanged: () => Promise<void>;
}) {
    const busy = useRef(false);
    const [working, setWorking] = useState(false);
    const [choosingMember, setChoosingMember] = useState(false);
    const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
    const removableMembers = (group.members ?? []).filter(
        (member): member is NonNullable<typeof member> => !!member && member.role !== "OWNER",
    );
    const selectedMember = removableMembers.find(member => member.userId === selectedMemberId);
    const closeMemberPicker = () => {
        if (working) return;
        setChoosingMember(false);
        setSelectedMemberId(null);
    };
    const requestIds = useRef<Record<string, string>>({});
    const submit = async (name: string, targetUserId?: string) => {
        if (busy.current || group.operationId) return;
        busy.current = true;
        setWorking(true);
        const key = `${name}:${targetUserId ?? ""}`;
        const requestId =
            requestIds.current[key] ??
            `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        requestIds.current[key] = requestId;
        try {
            const result = await action(name, {
                groupId: group.groupId,
                requestId,
                ...(targetUserId ? { targetUserId } : {}),
            });
            if (__DEV__) console.log("[GroupAccessAccepted]", JSON.stringify({ groupId: group.groupId, operationId: result.operationId, status: result.status, accepted: result.accepted, at: new Date().toISOString() }));
            if (result.status === "CANCELLED") {
                delete requestIds.current[key];
                throw new Error(
                    "前回の処理は取り消されています。再度操作してください。",
                );
            }
            if (!result.accepted && !result.success)
                throw new Error(
                    result.message ?? "操作を受け付けられませんでした。",
                );
            delete requestIds.current[key];
            Alert.alert(
                result.success ? "処理完了" : "処理を受け付けました",
                "関連する履歴の共有権限を処理します。画面内の処理状況をご確認ください。",
            );
            await onChanged();
        } catch (error) {
            Alert.alert(
                "操作を確認してください",
                error instanceof Error
                    ? error.message
                    : "結果が不明です。処理状況を確認してください。",
            );
        } finally {
            busy.current = false;
            setWorking(false);
            setChoosingMember(false);
            setSelectedMemberId(null);
        }
    };
    const confirm = (title: string, name: string, targetUserId?: string) =>
        Alert.alert(
            title,
            `「${group.name}」の操作を実行します。\nこのグループを通じた過去の履歴共有が失効します。別グループの有効な共有は維持されます。処理が完了するまでグループの変更はできません。`,
            [
                { text: "キャンセル", style: "cancel" },
                {
                    text: "実行",
                    onPress: () => {
                        void submit(name, targetUserId);
                    },
                },
            ],
        );
    return (
        <View style={{ gap: 8, marginTop: 10 }}>
            {group.operationId ? (
                <Text>
                    共有権限の処理中です。画面内の処理状況をご確認ください。
                </Text>
            ) : group.role === "OWNER" ? (
                <>
                    <GroupActionButton
                        title="メンバーを除外"
                        destructive
                        icon="account-minus-outline"
                        disabled={working}
                        onPress={() => { setSelectedMemberId(null); setChoosingMember(true); }}
                    />
                    <GroupActionButton
                        title="グループを無効化"
                        destructive
                        icon="account-group-outline"
                        disabled={working}
                        onPress={() =>
                            confirm(
                                "グループを無効化",
                                "deactivateOwnedShareGroup",
                            )
                        }
                    />
                </>
            ) : (
                <GroupActionButton
                    title="このグループから脱退"
                    destructive
                    icon="exit-to-app"
                    disabled={working}
                    onPress={() =>
                        confirm("グループから脱退", "leaveShareGroup")
                    }
                />
            )}
            <Modal
                visible={choosingMember}
                transparent
                animationType="fade"
                onRequestClose={closeMemberPicker}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <Text style={styles.modalTitle}>除外するメンバーを選択</Text>
                        <Text style={styles.modalDescription}>
                            「{group.name}」から除外するメンバーを1人選択してください。
                        </Text>
                        <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} keyboardShouldPersistTaps="handled">
                            {removableMembers.length === 0 && (
                                <Text style={styles.emptyText}>除外できるメンバーはいません。</Text>
                            )}
                            {removableMembers.map(member => {
                                const selected = member.userId === selectedMemberId;
                                const displayName = member.displayName?.trim() || "ユーザー";
                                const iconUrl = member.iconImagePath ? memberIconUrls[member.iconImagePath] : undefined;
                                return (
                                    <Pressable
                                        key={member.userId}
                                        accessibilityRole="radio"
                                        accessibilityState={{ checked: selected, disabled: working }}
                                        accessibilityLabel={displayName}
                                        disabled={working}
                                        onPress={() => setSelectedMemberId(member.userId)}
                                        style={({ pressed }) => [
                                            styles.memberRow,
                                            selected && styles.memberRowSelected,
                                            pressed && !working && styles.actionPressed,
                                            working && styles.disabledButton,
                                        ]}
                                    >
                                        {iconUrl ? (
                                            <Image source={{ uri: iconUrl }} style={styles.memberIcon} resizeMode="cover" />
                                        ) : (
                                            <View style={[styles.memberIcon, styles.memberPlaceholder]}>
                                                <Text style={styles.memberInitial}>{displayName.slice(0, 1).toUpperCase()}</Text>
                                            </View>
                                        )}
                                        <Text style={styles.memberName}>{displayName}</Text>
                                        <MaterialCommunityIcons
                                            name={selected ? "radiobox-marked" : "radiobox-blank"}
                                            size={24}
                                            color={selected ? "#0e7185" : "#819198"}
                                        />
                                    </Pressable>
                                );
                            })}
                        </ScrollView>
                        <View style={styles.pickerActions}>
                            <GroupActionButton
                                title="選択したメンバーを除外"
                                destructive
                                icon="account-minus-outline"
                                disabled={working || !selectedMember}
                                onPress={() => {
                                    if (selectedMember) confirm(
                                        "メンバーを除外：" + (selectedMember.displayName || "選択したメンバー"),
                                        "removeShareGroupMember",
                                        selectedMember.userId,
                                    );
                                }}
                            />
                            <GroupActionButton title="キャンセル" disabled={working} onPress={closeMemberPicker} />
                        </View>
                    </View>
                </View>
            </Modal>
        </View>
    );
}

export function GroupAccessOperationsPanel({
    onChanged,
}: {
    onChanged: () => Promise<void>;
}) {
    const [operations, setOperations] = useState<Operation[]>([]);
    const [error, setError] = useState(false);
    const busy = useRef(false);
    const previous = useRef<Map<string, string>>(new Map());
    const refresh = useCallback(async () => {
        if (busy.current) return;
        busy.current = true;
        try {
            const result = await (
                client.queries.listMyShareGroupAccessOperations as (
                    args: object,
                ) => Promise<{
                    data?: (Operation | null)[];
                    errors?: unknown[];
                }>
            )({});
            if (result.errors?.length || !Array.isArray(result.data))
                throw new Error("操作状態の取得失敗");
            const items = result.data.filter(
                (item): item is Operation => !!item,
            );
            const current = new Map(
                items.map((item) => [item.operationId, item.status]),
            );
            const finished = [...previous.current].some(
                ([id, status]) =>
                    !["COMPLETED", "CANCELLED"].includes(status) &&
                    ["COMPLETED", "CANCELLED"].includes(current.get(id) ?? ""),
            );
            for (const item of items) {
                if (previous.current.get(item.operationId) !== item.status)
                    console.info("[GroupAccess]", {
                        operationId: item.operationId,
                        groupId: item.groupId,
                        status: item.status,
                        phase: item.phase,
                        completedSessionCount: item.completedSessionCount,
                    });
            }
            previous.current = current;
            setOperations(items);
            setError(false);
            if (finished) await onChanged();
        } catch {
            setError(true);
        } finally {
            busy.current = false;
        }
    }, [onChanged]);
    useFocusEffect(
        useCallback(() => {
            void refresh();
            const timer = setInterval(() => {
                void refresh();
            }, 4000);
            return () => clearInterval(timer);
        }, [refresh]),
    );
    const operate = async (op: Operation, name: string) => {
        try {
            await action(name, {
                groupId: op.groupId,
                operationId: op.operationId,
            });
            await refresh();
            await onChanged();
        } catch (e) {
            Alert.alert(
                "処理を確認してください",
                e instanceof Error ? e.message : "操作に失敗しました。",
            );
        }
    };
    return (
        <View style={{ gap: 8, marginTop: 12 }}>
            {error && (
                <>
                    <Text>
                        共有権限の処理状況を取得できません。完了したかは未確認です。
                    </Text>
                    <GroupActionButton
                        title="処理状況を再取得"
                        onPress={() => {
                            void refresh();
                        }}
                    />
                </>
            )}
            {operations.map((op) => (
                <View
                    key={op.operationId}
                    style={{
                        padding: 12,
                        backgroundColor: "#eef3f7",
                        borderRadius: 8,
                        gap: 6,
                    }}
                >
                    <Text>
                        {op.groupName ?? "共有グループ"}：
                        {op.status === "FAILED"
                            ? "確認が必要です"
                            : op.status === "COMPLETED"
                              ? "共有権限の処理が完了しました"
                              : op.status === "CANCELLED"
                                ? "処理を取り消しました"
                                : "共有権限を処理中"}
                    </Text>
                    {!["COMPLETED", "CANCELLED", "FAILED"].includes(
                        op.status,
                    ) && (
                        <Text>
                            {phaseLabels[op.phase ?? ""] ?? "処理状況を確認中"}
                        </Text>
                    )}
                    <Text>
                        確認完了した履歴：{op.completedSessionCount ?? 0}件
                    </Text>
                    {op.status === "FAILED" && (
                        <>
                            <Text>
                                {op.message?.replace(
                                    /^(NEEDS_MIGRATION|NEEDS_REPAIR|WAITING_REPAIR): /,
                                    "",
                                )}
                            </Text>
                            {!op.message?.startsWith("NEEDS_MIGRATION") && (
                                <GroupActionButton
                                    title="処理を再開"
                                    onPress={() => {
                                        void operate(
                                            op,
                                            "resumeShareGroupAccessOperation",
                                        );
                                    }}
                                />
                            )}
                            {op.message?.startsWith("NEEDS_MIGRATION") && (
                                <Text>
                                    失効開始前の処理を取り消し、旧共有データを移行してから再度操作してください。
                                </Text>
                            )}
                            {op.canCancel && (
                                <GroupActionButton
                                    title="失効開始前の処理を取り消す"
                                    onPress={() => {
                                        void operate(
                                            op,
                                            "cancelShareGroupAccessOperation",
                                        );
                                    }}
                                />
                            )}
                        </>
                    )}
                </View>
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    modalOverlay: {
        flex: 1, backgroundColor: "rgba(0,0,0,0.35)",
        alignItems: "center", justifyContent: "center", padding: 20,
    },
    modalContent: {
        width: "100%", maxHeight: "80%", borderRadius: 14,
        borderWidth: 1, borderColor: "#dfe7ea", padding: 18, backgroundColor: "#fff",
    },
    modalTitle: { fontSize: 18, fontWeight: "bold", color: "#203f4f", marginBottom: 8 },
    modalDescription: { fontSize: 13, color: "#555", marginBottom: 12 },
    memberRow: {
        flexDirection: "row", alignItems: "center", gap: 10, padding: 10,
        borderWidth: 1, borderColor: "#ddd", borderRadius: 8,
        marginBottom: 8, backgroundColor: "#fff",
    },
    memberRowSelected: { borderColor: "#4b6f8f", backgroundColor: "#eef3f7" },
    memberIcon: { width: 44, height: 44, borderRadius: 22 },
    memberPlaceholder: {
        alignItems: "center", justifyContent: "center", backgroundColor: "#e3edf2",
    },
    memberInitial: { color: "#4b6f8f", fontSize: 18, fontWeight: "700" },
    memberName: { flex: 1, color: "#333", fontSize: 15, fontWeight: "bold" },
    pickerActions: { marginTop: 12, gap: 8 },
    emptyText: { paddingVertical: 20, color: "#71838c", textAlign: "center" },
    actionButton: {
        minHeight: 40,
        paddingVertical: 10,
        paddingHorizontal: 12,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        borderWidth: 1,
        borderColor: "#b7d4dc",
        borderRadius: 9,
        backgroundColor: "#ffffff",
    },
    actionText: {
        flexShrink: 1,
        textAlign: "center",
        color: "#0e7185",
        fontSize: 11,
        fontWeight: "700",
    },
    actionPressed: {
        backgroundColor: "#edf7f9",
    },
    destructiveButton: {
        borderColor: "#e3b9b5",
        backgroundColor: "#fff8f7",
    },
    destructiveText: {
        color: "#c0392b",
    },
    destructivePressed: {
        backgroundColor: "#fdeceb",
    },
    disabledButton: {
        opacity: 0.45,
    },
});
