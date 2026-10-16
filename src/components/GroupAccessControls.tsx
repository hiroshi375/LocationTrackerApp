import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { Alert, Button, Modal, ScrollView, Text, View } from "react-native";
import { client } from "../lib/client";

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
    onChanged,
}: {
    group: Group;
    onChanged: () => Promise<void>;
}) {
    const busy = useRef(false);
    const [working, setWorking] = useState(false);
    const [choosingMember, setChoosingMember] = useState(false);
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
                    <Button
                        title="メンバーを除外"
                        disabled={working}
                        onPress={() => setChoosingMember(true)}
                    />
                    <Button
                        title="グループを無効化"
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
                <Button
                    title="このグループから脱退"
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
                onRequestClose={() => {
                    if (!working) setChoosingMember(false);
                }}
            >
                <View
                    style={{
                        flex: 1,
                        justifyContent: "center",
                        padding: 24,
                        backgroundColor: "rgba(0,0,0,0.4)",
                    }}
                >
                    <View
                        style={{
                            maxHeight: "80%",
                            backgroundColor: "white",
                            padding: 16,
                            borderRadius: 12,
                        }}
                    >
                        <Text>除外するメンバーを選択</Text>
                        <ScrollView
                            style={{ flex: 1, minHeight: 0 }}
                            keyboardShouldPersistTaps="handled"
                        >
                            {(group.members ?? [])
                                .filter(
                                    (member) =>
                                        member && member.role !== "OWNER",
                                )
                                .map((member) => (
                                    <View
                                        key={member!.userId}
                                        style={{ marginVertical: 8 }}
                                    >
                                        <Button
                                            title={
                                                member!.displayName ||
                                                member!.userId
                                            }
                                            disabled={working}
                                            onPress={() =>
                                                confirm(
                                                    "メンバーを除外",
                                                    "removeShareGroupMember",
                                                    member!.userId,
                                                )
                                            }
                                        />
                                    </View>
                                ))}
                        </ScrollView>
                        <Button
                            title="キャンセル"
                            disabled={working}
                            onPress={() => setChoosingMember(false)}
                        />
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
                    <Button
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
                                <Button
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
                                <Button
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
