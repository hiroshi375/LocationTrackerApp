import { useRef, useState } from "react";
import { Button, Text, View } from "react-native";
import { getCurrentUser } from "aws-amplify/auth";
import { client } from "../lib/client";
import AsyncStorage from "@react-native-async-storage/async-storage";

/** Dedicated Test3/Test5 fixtures. Uses the signed-in Cognito user, never AWS admin credentials. */
export function GroupAccessApiProbe() {
    const running = useRef(false);
    const [busy, setBusy] = useState(false);
    const [report, setReport] = useState("");
    if (!__DEV__) return null;
    const run = async () => {
        if (running.current) return;
        running.current = true;
        setBusy(true);
        const lines: string[] = [];
        const emit = (line: string) => {
            lines.push(line);
            setReport(lines.join("\n"));
            console.log("[GroupApiProbe]", line);
        };
        try {
            const user = await getCurrentUser();
            if (user.userId !== "87c4ca18-80d1-70d4-85ee-8b4204fc226c")
                throw new Error("専用検証はCで実行してください");
            emit(`開始: ${new Date().toISOString()} / userId: ${user.userId}`);
            for (const name of ["deleteOwnedShareGroup", "deactivateOwnedShareGroup", "removeShareGroupMember"] as const) {
                if ((await getCurrentUser()).userId !== user.userId)
                    throw new Error("ユーザー変更を検出");
                let messages: string[] = [];
                try {
                    const invoke = client.mutations[name] as unknown as (args: object, options: object) => Promise<{ errors?: { message: string }[] }>;
                    const result = await invoke({
                        groupId: "ada95eec-d146-4706-b3e9-ea922b6d730f",
                        requestId: `negative-${Date.now()}-${name}`,
                        ...(name === "removeShareGroupMember"
                            ? { targetUserId: "47248aa8-a031-7004-66b8-e41578c805e7" }
                            : {}),
                    }, { authMode: "userPool" });
                    messages = result.errors?.map(error => error.message) ?? [];
                } catch (error) {
                    messages = [error instanceof Error ? error.message : "通信エラー"];
                }
                const denied = messages.length > 0 && messages.every(message =>
                    message === "グループ作成者だけが操作できます。",
                );
                emit(`${name}: ${denied ? "所有者以外を拒否 / PASS" : "未合格・中断"}`);
                if (!denied) throw new Error("想定した認可拒否を確認できません。後続要求を停止しました");
            }
            for (const name of ["getShareGroupAccessOperation", "resumeShareGroupAccessOperation", "cancelShareGroupAccessOperation"] as const) {
                if ((await getCurrentUser()).userId !== user.userId) throw new Error("ユーザー変更を検出");
                const invoke = (name === "getShareGroupAccessOperation" ? client.queries[name] : client.mutations[name]) as unknown as (args: object, options: object) => Promise<{ errors?: { message: string }[] }>;
                const result = await invoke({ groupId: "ada95eec-d146-4706-b3e9-ea922b6d730f", operationId: "c97e9180-79cb-43d1-bbbd-e57ad69eaf66" }, { authMode: "userPool" });
                const denied = !!result.errors?.length && result.errors.every(error => error.message === "このグループ操作を参照・変更できません。");
                emit(`${name}: ${denied ? "他人の操作を拒否 / PASS" : "未合格・中断"}`);
                if (!denied) throw new Error("想定した認可拒否を確認できません。後続要求を停止しました");
            }
            const ownGroup = "e6a7ccf2-9eef-41cc-9be1-dbdf610135a0";
            for (const name of ["leaveShareGroup", "removeShareGroupMember"] as const) {
                const invoke = client.mutations[name] as unknown as (args: object, options: object) => Promise<{ errors?: { message: string }[] }>;
                const result = await invoke({ groupId: ownGroup, requestId: `negative-owner-${Date.now()}`, ...(name === "removeShareGroupMember" ? { targetUserId: user.userId } : {}) }, { authMode: "userPool" });
                const denied = !!result.errors?.length && result.errors.every(error => error.message === "グループ作成者は脱退・除外できません。");
                emit(`${name}（所有者本人）: ${denied ? "拒否 / PASS" : "未合格・中断"}`);
                if (!denied) throw new Error("所有者保護の拒否を確認できません");
            }
            const generated = client.models as unknown as Record<string, Record<string, (args: object, options: object) => Promise<{ errors?: { errorType?: string; message: string }[] }>>>;
            for (const model of ["ShareGroup", "ShareGroupMember"]) {
                for (const method of ["create", "update", "delete"]) {
                    if ((await getCurrentUser()).userId !== user.userId) throw new Error("ユーザー変更を検出");
                    const create = method === "create";
                    const args = model === "ShareGroup"
                        ? { groupId: create ? "phase7-negative-C-group" : ownGroup, ...(create ? { ownerUserId: user.userId, name: "Phase7 negative fixture", inviteCodeHash: "phase7-negative-unused", isActive: false } : method === "update" ? { name: "Phase7-6-Test5" } : {}) }
                        : { membershipId: create ? "phase7-negative-C-member" : `${ownGroup}#${user.userId}`, ...(create ? { groupId: ownGroup, userId: user.userId, ownerValue: user.userId, role: "MEMBER", joinedAt: new Date().toISOString() } : method === "update" ? { role: "OWNER" } : {}) };
                    const result = await generated[model][method](args, { authMode: "userPool" });
                    const denied = !!result.errors?.length && result.errors.every(error => error.errorType === "Unauthorized");
                    emit(`${model}.${method}: ${denied ? "Unauthorized / PASS" : "未合格・中断"}`);
                    if (!denied) throw new Error("モデル直接変更の認可拒否を確認できません");
                }
            }
            const raw = await AsyncStorage.getItem("@aclog/phase7-group-access-test-target");
            const target = raw ? JSON.parse(raw) as { name: string; recordId: string; logId: string } : null;
            if (!target || target.name !== "Phase7Ctest" || !target.recordId.startsWith(`recording-session:${user.userId}:`)) throw new Error("C専用履歴の検証対象を確認できません");
            for (const [model, args, label] of [
                ["RecordingSession", { id: target.recordId, sharedOwners: ["3704aac8-90e1-70e4-bc50-6acd159a5049"] }, "共有先の直接追加"],
                ["LocationLog", { id: target.logId, sharedOwners: ["3704aac8-90e1-70e4-bc50-6acd159a5049"] }, "共有先の直接追加"],
                ["LocationLog", { id: target.logId, userId: "3704aac8-90e1-70e4-bc50-6acd159a5049" }, "所有者ID変更"],
                ["LocationLog", { id: target.logId, recordingSessionId: "phase7-negative-session" }, "セッションID変更"],
            ] as const) {
                if ((await getCurrentUser()).userId !== user.userId) throw new Error("ユーザー変更を検出");
                const result = await generated[model].update(args, { authMode: "userPool", selectionSet: ["id"] });
                const denied = !!result.errors?.length && result.errors.every(error => error.errorType === "Unauthorized");
                emit(`${model} ${label}: ${denied ? "Unauthorized / PASS" : "未合格・中断"}`);
                if (!denied) throw new Error("権限・識別子の直接変更拒否を確認できません");
            }
            const write = client.mutations.ingestLocationLog as unknown as (args: object, options: object) => Promise<{ errors?: { message: string }[] }>;
            const ingest = await write({ input: JSON.stringify({ id: "phase7-negative-foreign-log", userId: "3704aac8-90e1-70e4-bc50-6acd159a5049", latitude: 0, longitude: 0, recordedAt: new Date().toISOString() }) }, { authMode: "userPool" });
            const foreignDenied = !!ingest.errors?.length && ingest.errors.every(error => error.message === "位置情報の所有者が一致しません。");
            emit(`ingestLocationLog 他ユーザーの記録: ${foreignDenied ? "拒否 / PASS" : "未合格・中断"}`);
            if (!foreignDenied) throw new Error("別ユーザーを指定した保存の拒否を確認できません");
            for (const model of ["RecordingSession", "LocationLog"]) {
                const id = `phase7-api-compat-${model}-${Date.now()}`;
                const now = new Date().toISOString();
                const api = generated[model] as unknown as Record<string, (args: object, options: object) => Promise<{ data?: { id?: string; sharedOwners?: string[] | null }; errors?: { message: string }[] }>>;
                const args = { id, userId: user.userId, sharedOwners: ["3704aac8-90e1-70e4-bc50-6acd159a5049"], ...(model === "LocationLog" ? { latitude: 0, longitude: 0, recordedAt: now } : { recordingSessionId: id, recordingSessionName: "Phase7 API compatibility fixture", startedAt: now, endedAt: now, distanceMeters: 0, pointCount: 0 }) };
                let created = false;
                try {
                    const result = await api.create(args, { authMode: "userPool", selectionSet: ["id"] });
                    created = result.data?.id === id && !result.errors?.length;
                    if (!created) throw new Error("旧保存APIの検証用作成結果が未判定");
                    const read = await api.get({ id }, { authMode: "userPool", selectionSet: ["id", "sharedOwners"] });
                    const safe = read.data?.id === id && !read.errors?.length && Array.isArray(read.data.sharedOwners) && read.data.sharedOwners.length === 0;
                    emit(`${model}.create 共有先指定: ${safe ? "保存可・共有先はサーバーで空 / PASS" : "未合格"}`);
                    if (!safe) throw new Error("旧保存APIの共有先無視を確認できません");
                } finally {
                    if (created) {
                        const deleted = await api.delete({ id }, { authMode: "userPool", selectionSet: ["id"] });
                        emit(`${model} 一時検証データ削除: ${deleted.errors?.length || deleted.data?.id !== id ? "APIでは未完了・専用データの別途清掃が必要" : "完了"}`);
                    }
                }
            }
            emit("完了: 直接API21/21 PASS。DynamoDBの変更なし確認は別途必要です。");
        } catch (error) {
            emit(`未完了: ${error instanceof Error ? error.message : "認証・通信エラー"}`);
        } finally {
            running.current = false;
            setBusy(false);
        }
    };
    return <View style={{ gap: 8, marginVertical: 12 }}>
        <Button title="開発用：Cの直接API認可を検証（Test3・5限定）" disabled={busy} onPress={() => { void run(); }} />
        <Text selectable>{report}</Text>
    </View>;
}
