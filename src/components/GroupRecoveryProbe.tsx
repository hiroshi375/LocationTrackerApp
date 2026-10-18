import { useRef, useState } from "react";
import { Button, Text, View } from "react-native";
import { getCurrentUser } from "aws-amplify/auth";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { client } from "../lib/client";

const owner = "87c4ca18-80d1-70d4-85ee-8b4204fc226c";
const recipient = "47248aa8-a031-7004-66b8-e41578c805e7";
const groupId = "50a1437b-713c-45d2-9b7c-c382ea13b4cd";
const recordingSessionId = "session-1792235823694-wkscbkaa";
const operationKey = "@aclog/phase7-7-test8-operation";

/** Explicit development actions, restricted to C and the existing Test8 fixture. */
export function GroupRecoveryProbe() {
    const active = useRef(false);
    const [busy, setBusy] = useState(false);
    const [report, setReport] = useState("");
    const run = async (mode: "race" | "share" | "start" | "resume") => {
        if (!__DEV__ || active.current) return;
        active.current = true; setBusy(true);
        const lines: string[] = [];
        const emit = (value: string) => { lines.push(value); setReport(lines.join("\n")); console.log("[GroupRecoveryProbe]", value); };
        const invoke = async (name: string, args: object) => {
            if ((await getCurrentUser()).userId !== owner) throw new Error("C本人が必要です");
            const call = (client.mutations as unknown as Record<string, (args: object, options: object) => Promise<{ data?: any; errors?: { message: string }[] }>>)[name];
            const result = await call(args, { authMode: "userPool" });
            if (result.errors?.length) throw new Error(result.errors.map(item => item.message).join(" / "));
            if (result.data == null) throw new Error("API結果がありません");
            return result.data;
        };
        try {
            if ((await getCurrentUser()).userId !== owner) throw new Error("C本人が必要です");
            if (mode === "race") {
                // All requests use the ordinary production mutation and its locks.
                const results = await Promise.allSettled([true, false, true, false].map(enabled => invoke("setHistoricalShareGrant", { recordingSessionId, groupId, recipientUserId: recipient, enabled })));
                results.forEach((result, index) => emit(`競合${index + 1}: ${result.status === "fulfilled" ? `受付 ${JSON.stringify(result.value)}` : `拒否 ${String(result.reason)}`}`));
                await invoke("setHistoricalShareGrant", { recordingSessionId, groupId, recipientUserId: recipient, enabled: true });
                emit("最終の正式共有完了。Grant・全ログ照合前につき自動PASSなし。");
            } else if (mode === "share") {
                await invoke("setHistoricalShareGrant", { recordingSessionId, groupId, recipientUserId: recipient, enabled: true });
                emit("正式共有完了。Grant・全ログ照合前につき自動PASSなし。");
            } else if (mode === "start") {
                const operation = await invoke("deactivateOwnedShareGroup", { groupId, requestId: "phase7-7-test8-deactivate-v1" });
                await AsyncStorage.setItem(operationKey, operation.operationId);
                emit(`失効受付: ${JSON.stringify(operation)}`);
            } else {
                const operationId = await AsyncStorage.getItem(operationKey);
                if (!operationId) throw new Error("専用操作IDがありません");
                const result = await invoke("resumeShareGroupAccessOperation", { groupId, operationId });
                emit(`通常APIで再開: ${JSON.stringify(result)}`);
            }
        } catch (error) { emit(`未完了: ${error instanceof Error ? error.message : String(error)}`); }
        finally { active.current = false; setBusy(false); }
    };
    if (!__DEV__) return null;
    return <View style={{ gap: 8, marginVertical: 12 }}>
        <Button title="7-7 Test8：通常共有・解除を同時実行" disabled={busy} onPress={() => { void run("race"); }} />
        <Button title="7-7 Test8：正式共有を再確認" disabled={busy} onPress={() => { void run("share"); }} />
        <Button title="7-7 Test8：失効処理を開始" disabled={busy} onPress={() => { void run("start"); }} />
        <Button title="7-7 Test8：失敗処理を通常APIで再開" disabled={busy} onPress={() => { void run("resume"); }} />
        <Text selectable>{report}</Text>
    </View>;
}
