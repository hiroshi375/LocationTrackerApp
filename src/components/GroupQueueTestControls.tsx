import { useRef, useState } from "react";
import { Alert, Button, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getCurrentUser, signOut } from "aws-amplify/auth";
import { getBackgroundRecordingStatus } from "../services/backgroundLocationService";
import { upsertRecordingSessionSummary } from "../services/recordingSessionService";
import { getLocationQueueStatusSummary } from "../services/locationLocationQueueService";
import { drainLocationQueueRepeatedly } from "../services/locationQueueUploadService";
import { prepareGroupAccessTarget } from "./GroupAccessReadProbe";
import { client } from "../lib/client";

const owner = "87c4ca18-80d1-70d4-85ee-8b4204fc226c";
const recipient = "47248aa8-a031-7004-66b8-e41578c805e7";
const groupId = "50a1437b-713c-45d2-9b7c-c382ea13b4cd";
const key = "@aclog/phase7-test8-queue-session";
type Fixture = { sessionId: string; intervalMs: number; distanceMeters: number };

/** Offline test exit at the consent error gate; never bypasses consent or deletes queues. */
export function Test8OfflineSignOut() {
    const [busy, setBusy] = useState(false);
    const run = async () => {
        setBusy(true);
        try {
            const user = await getCurrentUser();
            const raw = await AsyncStorage.getItem(key);
            const fixture = raw ? JSON.parse(raw) as Fixture : null;
            if (user.userId !== owner || !fixture?.sessionId?.startsWith("session-")) throw new Error("Test8のC専用設定が必要です");
            const status = await getBackgroundRecordingStatus();
            if (status.state?.isRecording || status.state?.liveShareOwnerValues?.length) throw new Error("記録・現在地共有を停止してください");
            const summary = await getLocationQueueStatusSummary({ userId: owner, recordingSessionId: fixture.sessionId });
            if (summary.pendingCount < 1) throw new Error("未送信データがありません");
            if ((await getCurrentUser()).userId !== owner) throw new Error("認証ユーザー変更");
            console.log("[GroupQueueTest8]", `サインアウト前の実SQLite: ${JSON.stringify(summary)}`);
            await signOut();
        } catch (error) { Alert.alert("Test8未完了", error instanceof Error ? error.message : "状態を確認できません"); }
        finally { setBusy(false); }
    };
    if (!__DEV__) return null;
    return <Button title="Test8：未送信を保持してCをサインアウト" disabled={busy} onPress={() => { void run(); }} />;
}

/** Manual, dedicated Test8 tooling; does not fabricate or edit SQLite GPS rows. */
export function GroupQueueTestControls() {
    const running = useRef(false);
    const [busy, setBusy] = useState(false);
    const [report, setReport] = useState("");
    const run = async (mode: "prepare" | "inspect" | "replay") => {
        if (running.current) return;
        running.current = true; setBusy(true);
        const lines: string[] = [];
        const emit = (line: string) => { lines.push(line); setReport(lines.join("\n")); console.log("[GroupQueueTest8]", line); };
        try {
            if ((await getCurrentUser()).userId !== owner) throw new Error("C本人で実行してください");
            const status = await getBackgroundRecordingStatus();
            let fixture: Fixture;
            if (mode === "prepare") {
                const state = status.state;
                if (!state?.isRecording || state.userId !== owner || !state.recordingSessionId || !state.startedAt || Date.now() - Date.parse(state.startedAt) > 30 * 60 * 1000) throw new Error("開始30分以内のCの専用記録が必要です");
                fixture = { sessionId: state.recordingSessionId, intervalMs: state.intervalMs, distanceMeters: state.distanceMeters };
                await AsyncStorage.setItem(key, JSON.stringify(fixture));
                await upsertRecordingSessionSummary(fixture.sessionId, "Phase7QueueTest", [], fixture.intervalMs, fixture.distanceMeters);
                if ((await getCurrentUser()).userId !== owner) throw new Error("認証ユーザー変更");
                const share = client.mutations.setHistoricalShareGrant as unknown as (args: object, options: object) => Promise<{ data?: boolean; errors?: { message: string }[] }>;
                const result = await share({ recordingSessionId: fixture.sessionId, groupId, recipientUserId: recipient, enabled: true }, { authMode: "userPool" });
                if (result.errors?.length || result.data !== true) throw new Error(result.errors?.[0]?.message ?? "正式共有が未完了");
                await prepareGroupAccessTarget({ id: `recording-session:${owner}:${fixture.sessionId}`, userId: owner, recordingSessionId: fixture.sessionId, recordingSessionName: "Phase7QueueTest" });
                emit(`正式共有・検証対象設定完了 / sessionId: ${fixture.sessionId}`);
            } else {
                const raw = await AsyncStorage.getItem(key);
                if (!raw) throw new Error("Test8専用記録を先に準備してください");
                fixture = JSON.parse(raw) as Fixture;
                if (!fixture.sessionId?.startsWith("session-") || !Number.isFinite(fixture.intervalMs) || !Number.isFinite(fixture.distanceMeters)) throw new Error("専用記録の設定不正");
                if (mode === "replay") {
                    if (status.state?.isRecording) throw new Error("自動記録を停止してから再送してください");
                    const recipients = client.queries.listHistoricalShareRecipients as unknown as (args: object, options: object) => Promise<{ data?: { recipientUserId?: string; isActive?: boolean }[]; errors?: unknown[] }>;
                    const allowed = await recipients({ recordingSessionId: fixture.sessionId }, { authMode: "userPool" });
                    if (allowed.errors?.length || !Array.isArray(allowed.data) || allowed.data.some(item => item?.recipientUserId === recipient && item.isActive)) throw new Error("Bの共有失効を確認できないため再送を停止しました");
                    emit("古い共有先Bをfallbackに指定し、通常のSQLite送信サービスで再送開始");
                    const result = await drainLocationQueueRepeatedly({ userId: owner, recordingSessionId: fixture.sessionId, intervalMs: fixture.intervalMs, distanceMeters: fixture.distanceMeters, fallbackSharedOwners: [recipient], forceIncludeRecent: true, maxItems: 10, maxIterations: 10 });
                    emit(`再送結果: ${JSON.stringify(result)}`);
                    if (result.remainingPendingCount !== 0) throw new Error("未送信が残っています。未完了として確認してください");
                    await upsertRecordingSessionSummary(fixture.sessionId, "Phase7QueueTest", [], fixture.intervalMs, fixture.distanceMeters);
                }
            }
            const summary = await getLocationQueueStatusSummary({ userId: owner, recordingSessionId: fixture.sessionId });
            emit(`SQLite実データ: ${JSON.stringify(summary)}`);
            emit("権限・全ログ・認証の最終照合は別途必要です。自動PASS判定なし。");
        } catch (error) { emit(`未完了: ${error instanceof Error ? error.message : "認証・通信エラー"}`); }
        finally { running.current = false; setBusy(false); }
    };
    if (!__DEV__) return null;
    return <View style={{ gap: 8, marginVertical: 12 }}>
        <Button title="Test8：記録中の専用履歴をBへ正式共有" disabled={busy} onPress={() => { void run("prepare"); }} />
        <Button title="Test8：SQLite未送信件数を確認" disabled={busy} onPress={() => { void run("inspect"); }} />
        <Button title="Test8：脱退後にCで未送信を再送" disabled={busy} onPress={() => { void run("replay"); }} />
        <Text selectable>{report}</Text>
    </View>;
}
