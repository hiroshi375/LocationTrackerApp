import { useRef, useState } from "react";
import { Alert, Button, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getCurrentUser } from "aws-amplify/auth";
import { client } from "../lib/client";

const targetKey = "@aclog/phase7-group-access-test-target";
type Target = {
    recordId: string;
    sessionId: string;
    name: string;
    logId: string;
    logCount: number;
};
type Result = {
    data?: { id: string } | null;
    errors?: { errorType?: string }[];
};
type Page = {
    data: { id: string }[];
    errors?: { errorType?: string }[];
    nextToken?: string | null;
};
type Model = {
    get(input: object, options: object): Promise<Result>;
    listLocationLogsBySessionAndRecordedAt(
        input: object,
        options: object,
    ): Promise<Page>;
};
const models = client.models as unknown as Record<
    "RecordingSession" | "LocationLog",
    Model
>;
const readOptions = { authMode: "userPool" as const, selectionSet: ["id"] };
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                "読み取りが時間内に完了しませんでした（未判定）",
                            ),
                        ),
                    ms,
                );
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
async function readLogs(sessionId: string, deadline: number) {
    const ids = new Set<string>();
    const tokens = new Set<string>();
    let nextToken: string | undefined;
    do {
        if (Date.now() >= deadline)
            throw new Error("全ページを取得できませんでした（未判定）");
        const page = await bounded(
            models.LocationLog.listLocationLogsBySessionAndRecordedAt(
                {
                    recordingSessionId: sessionId,
                    sortDirection: "ASC",
                    limit: 1000,
                    nextToken,
                },
                readOptions,
            ),
            Math.min(15000, deadline - Date.now()),
        );
        if (page.errors?.length || !Array.isArray(page.data))
            throw new Error("セッション別取得でAPIエラー（未判定）");
        page.data.forEach((item) => ids.add(item.id));
        nextToken = page.nextToken ?? undefined;
        if (nextToken && tokens.has(nextToken))
            throw new Error("ページが循環しています（未判定）");
        if (nextToken) tokens.add(nextToken);
    } while (nextToken);
    return ids;
}
/** Read-only developer tooling. Never logs location IDs, coordinates or credentials. */
export async function prepareGroupAccessTarget(session: {
    id: string;
    userId: string;
    recordingSessionId: string;
    recordingSessionName: string;
}) {
    const user = await getCurrentUser();
    if (user.userId !== session.userId)
        throw new Error("所有者本人の履歴を選択してください。");
    const ids = await readLogs(session.recordingSessionId, Date.now() + 60000);
    if (!ids.size)
        throw new Error("位置ログが1件以上ある履歴を選択してください。");
    if ((await getCurrentUser()).userId !== user.userId)
        throw new Error("検証対象の準備中にユーザーが変わりました。");
    const target: Target = {
        recordId: session.id,
        sessionId: session.recordingSessionId,
        name: session.recordingSessionName,
        logId: [...ids][0],
        logCount: ids.size,
    };
    await AsyncStorage.setItem(targetKey, JSON.stringify(target));
    Alert.alert(
        "検証対象を設定しました",
        `${target.name}\n${target.logCount}件の位置ログを確認しました。`,
    );
}
export function GroupAccessReadProbe() {
    const [expanded, setExpanded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [report, setReport] = useState("");
    const running = useRef(false);
    const run = async (readable: boolean) => {
        if (running.current) return;
        running.current = true;
        setBusy(true);
        const lines: string[] = [];
        const emit = (line: string) => {
            lines.push(line);
            setReport(lines.join("\n"));
            console.log("[GroupAccessProbe]", line);
        };
        try {
            const user = await bounded(getCurrentUser(), 15000);
            const raw = await AsyncStorage.getItem(targetKey);
            if (!raw)
                throw new Error(
                    "Aの履歴共有管理で、先に検証対象を設定してください。",
                );
            const target = JSON.parse(raw) as Target;
            if (
                ![
                    target.recordId,
                    target.sessionId,
                    target.logId,
                    target.name,
                ].every(
                    (value) => typeof value === "string" && value.length > 0,
                ) ||
                !Number.isFinite(target.logCount) ||
                target.logCount < 1
            )
                throw new Error("検証対象を設定し直してください。");
            emit(
                `開始: ${new Date().toISOString()} / userId: ${user.userId} / 期待: ${readable ? "取得可" : "取得拒否"}`,
            );
            emit(`対象: ${target.name}`);
            const checks: boolean[] = [];
            for (const [model, id] of [
                ["RecordingSession", target.recordId],
                ["LocationLog", target.logId],
            ] as const) {
                const result = await bounded(
                    models[model].get({ id }, readOptions),
                    15000,
                );
                const denied =
                    !result.data &&
                    !!result.errors?.length &&
                    result.errors.every(
                        (error) => error.errorType === "Unauthorized",
                    );
                const success = readable
                    ? result.data?.id === id && !result.errors?.length
                    : denied;
                checks.push(success);
                emit(
                    `${model} get: ${result.data ? "取得可" : denied ? "Unauthorized" : "未判定"} / ${success ? "PASS" : "未合格"}`,
                );
            }
            const ids = await readLogs(target.sessionId, Date.now() + 60000);
            const listSuccess = readable
                ? ids.size >= target.logCount && ids.has(target.logId)
                : ids.size === 0;
            checks.push(listSuccess);
            emit(
                `LocationLog session GSI: ${ids.size}件（全ページ） / ${listSuccess ? "PASS" : "未合格"}`,
            );
            if ((await bounded(getCurrentUser(), 15000)).userId !== user.userId)
                throw new Error("実行中にユーザーが変わりました（未判定）");
            emit(
                `完了: 3経路 ${checks.every(Boolean) ? "PASS" : "未合格"}。Grant・全ログのDynamoDB整合確認は別途必要です。`,
            );
        } catch (error) {
            emit(
                `検証未完了: ${error instanceof Error ? error.message : "認証・通信エラー"}。アクセス拒否のPASSにはしません。`,
            );
        } finally {
            running.current = false;
            setBusy(false);
        }
    };
    if (!__DEV__) return null;
    return (
        <View style={{ gap: 8, marginVertical: 12 }}>
            <Button
                title={
                    expanded
                        ? "開発用アクセス検証を閉じる"
                        : "開発用：履歴アクセスを検証"
                }
                onPress={() => setExpanded(!expanded)}
            />
            {expanded && (
                <>
                    <Text>
                        所有者の履歴共有管理で設定した対象を、現在ログイン中の認証で新規取得します。
                    </Text>
                    <Button
                        title="取得できないことを検証"
                        disabled={busy}
                        onPress={() => {
                            void run(false);
                        }}
                    />
                    <Button
                        title="取得できることを検証"
                        disabled={busy}
                        onPress={() => {
                            void run(true);
                        }}
                    />
                    <Text selectable>{report}</Text>
                </>
            )}
        </View>
    );
}
