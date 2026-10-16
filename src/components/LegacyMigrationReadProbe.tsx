import { useRef, useState } from "react";
import { Button, Text, View } from "react-native";
import { getCurrentUser } from "aws-amplify/auth";
import { client } from "../lib/client";
import targets from "./legacyMigrationProbeTargets.json";

// Development-only, read-only checks using the real signed-in Cognito user.
// Never print log IDs (which can contain coordinates), credentials, or tokens.
export function LegacyMigrationReadProbe() {
    const running = useRef(false);
    const [busy, setBusy] = useState(false);
    const [output, setOutput] = useState("");
    if (!__DEV__) return null;
    const run = async () => {
        if (running.current) return;
        running.current = true;
        setBusy(true);
        const lines: string[] = [];
        const record = (line: string) => { lines.push(line); setOutput(lines.join("\n")); console.log("[LegacyMigrationProbe]", line); };
        try {
            const user = await getCurrentUser();
            const assertUser = async () => {
                if ((await getCurrentUser()).userId !== user.userId) throw new Error("ユーザーが切り替わったため検証を中止しました。");
            };
            const read = async (operation: Promise<any>) => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("API読み取りタイムアウト（未判定）")), 20000); })]); }
                finally { if (timer) clearTimeout(timer); }
            };
            const denied = (result: any) => !result.data && Array.isArray(result.errors) && result.errors.length > 0 && result.errors.every((e: any) => e.errorType === "Unauthorized" || e.extensions?.errorType === "Unauthorized");
            record(`開始 ${new Date().toISOString()} / userId: ${user.userId}`);
            let passed = 0;
            for (const target of targets) {
                await assertUser();
                const allowed = target.ownerUserId === user.userId || target.sharedUserIds.includes(user.userId);
                const session: any = await read((client.models.RecordingSession as any).get({ id: target.recordId }, { authMode: "userPool" }));
                await assertUser();
                const log: any = await read((client.models.LocationLog as any).get({ id: target.logId }, { authMode: "userPool" }));
                await assertUser();
                let nextToken: string | undefined;
                const ids = new Set<string>();
                const tokens = new Set<string>();
                do {
                    const page: any = await read((client.models.LocationLog as any).listLocationLogsBySessionAndRecordedAt({ recordingSessionId: target.sessionId }, { authMode: "userPool", limit: 100, nextToken, selectionSet: ["id"] }));
                    await assertUser();
                    if (page.errors?.length) throw new Error(`${target.decisionId}: GSI APIエラー（未判定）`);
                    for (const item of page.data ?? []) if (item?.id) ids.add(item.id);
                    nextToken = page.nextToken ?? undefined;
                    if (nextToken && tokens.has(nextToken)) throw new Error("ページングが循環したため検証を中止しました。");
                    if (nextToken) tokens.add(nextToken);
                } while (nextToken);
                const sessionPass = allowed ? !session.errors?.length && session.data?.id === target.recordId : denied(session);
                const logPass = allowed ? !log.errors?.length && log.data?.id === target.logId : denied(log);
                const gsiPass = ids.size === (allowed ? target.logCount : 0);
                const pass = sessionPass && logPass && gsiPass;
                if (pass) passed++;
                record(`${target.decisionId} ${target.name} / 期待:${allowed ? "取得可" : "取得拒否"}\nSession ${sessionPass ? "PASS" : "未合格"} / Log ${logPass ? "PASS" : "未合格"} / GSI ${ids.size}件 ${gsiPass ? "PASS" : "未合格"}`);
            }
            record(`完了 ${passed}/${targets.length}履歴 PASS（現在のユーザーのみ）`);
        } catch (error) {
            record(error instanceof Error ? error.message : "検証中にエラーが発生しました（未判定）");
        } finally { running.current = false; setBusy(false); }
    };
    return <View style={{ gap: 8, marginVertical: 12 }}>
        <Button title={busy ? "移行後の権限を検証中…" : "開発用：旧共有移行後の5履歴を検証"} disabled={busy} onPress={() => void run()} />
        {output ? <Text selectable>{output}</Text> : null}
    </View>;
}
