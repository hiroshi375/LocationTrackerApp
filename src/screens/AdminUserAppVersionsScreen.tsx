import { useFocusEffect } from "@react-navigation/native";
import { Hub } from "aws-amplify/utils";
import { useCallback, useRef, useState } from "react";
import {
    ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
    formatAppOpenedAtJst, type UserAppVersionRow,
} from "../services/adminUserAppVersionsCore";
import { listAdminUserAppVersions } from "../services/adminUserAppVersionsService";

const columns = [
    { title: "ユーザー名", width: 180 },
    { title: "バージョン", width: 100 },
    { title: "ビルド", width: 80 },
    { title: "OS", width: 90 },
    { title: "最終起動日時（JST）↓", width: 210 },
];
const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);

export default function AdminUserAppVersionsScreen() {
    const insets = useSafeAreaInsets();
    const [rows, setRows] = useState<UserAppVersionRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const active = useRef(false);
    const requestId = useRef(0);

    const load = useCallback(async () => {
        const request = ++requestId.current;
        const isCancelled = () => !active.current || request !== requestId.current;
        setRows([]);
        setError(null);
        setLoading(true);
        try {
            const result = await listAdminUserAppVersions(isCancelled);
            if (!isCancelled() && result !== null) setRows(result);
        } catch (e) {
            if (!isCancelled()) {
                setError(e instanceof Error ? e.message : "一覧を取得できませんでした。");
            }
        } finally {
            if (!isCancelled()) setLoading(false);
        }
    }, []);

    useFocusEffect(useCallback(() => {
        active.current = true;
        void load();
        const stopListening = Hub.listen("auth", ({ payload }) => {
            if (payload.event === "signedOut" || payload.event === "signedIn") {
                ++requestId.current;
                setRows([]);
                setLoading(false);
                setError("ログイン状態が変わりました。画面を開き直してください。");
            }
        });
        return () => {
            active.current = false;
            ++requestId.current;
            stopListening();
        };
    }, [load]));

    return (
        <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
            <View style={styles.description}>
                <Text style={styles.note}>
                    最後に起動した端末から報告された情報です。複数端末すべての一覧ではありません。
                </Text>
                <Text style={styles.note}>
                    最終起動日時の新しい順。未取得は末尾に表示します。表は横にスクロールできます。
                </Text>
                <View style={styles.toolbar}>
                    <Text style={styles.count}>{loading ? "取得中…" : error ? "取得未完了" : `${rows.length}件`}</Text>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="インストールバージョン一覧を再取得"
                        disabled={loading}
                        onPress={() => { void load(); }}
                        style={[styles.refresh, loading && styles.disabled]}
                    >
                        <Text style={styles.refreshText}>再取得</Text>
                    </Pressable>
                </View>
            </View>
            {loading ? (
                <View style={styles.message}><ActivityIndicator color="#0c3d5d" /><Text style={styles.note}>一覧を取得しています…</Text></View>
            ) : error ? (
                <View style={styles.message}><Text accessibilityRole="alert" style={styles.error}>{error}</Text></View>
            ) : rows.length === 0 ? (
                <View style={styles.message}><Text style={styles.note}>表示するユーザーはいません。</Text></View>
            ) : (
                <ScrollView horizontal style={styles.tableScroll} contentContainerStyle={styles.tableContent}>
                    <View style={{ width: tableWidth, flex: 1 }}>
                        <FlatList
                            data={rows}
                            keyExtractor={item => item.id}
                            stickyHeaderIndices={[0]}
                            ListHeaderComponent={
                                <View style={[styles.row, styles.heading]}>
                                    {columns.map(column => <Text key={column.title} style={[styles.cell, styles.headingText, { width: column.width }]}>{column.title}</Text>)}
                                </View>
                            }
                            renderItem={({ item, index }) => (
                                <View style={[styles.row, index % 2 === 1 && styles.alternate]}>
                                    {[item.displayName, item.appVersion, item.appBuildVersion === null ? "未取得" : String(item.appBuildVersion), item.platform, formatAppOpenedAtJst(item.lastAppOpenedAt)].map((value, column) => (
                                        <Text key={column} selectable style={[styles.cell, { width: columns[column].width }]}>{value}</Text>
                                    ))}
                                </View>
                            )}
                        />
                    </View>
                </ScrollView>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    screen: { flex: 1, backgroundColor: "#f4f7fa" },
    description: { padding: 16, gap: 8 },
    note: { color: "#536773", fontSize: 13, lineHeight: 20 },
    toolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    count: { fontSize: 16, fontWeight: "600", color: "#0c3d5d" },
    refresh: { minHeight: 44, paddingHorizontal: 20, justifyContent: "center", borderRadius: 8, backgroundColor: "#27445c" },
    refreshText: { color: "#fff", fontWeight: "600" },
    disabled: { opacity: 0.5 },
    message: { padding: 24, alignItems: "center", gap: 12 },
    error: { color: "#a52e2e", fontSize: 14, lineHeight: 22 },
    tableScroll: { flex: 1 },
    tableContent: { flexGrow: 1 },
    row: { flexDirection: "row", alignItems: "stretch", backgroundColor: "#fff", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#dce5eb" },
    heading: { backgroundColor: "#0c3d5d" },
    cell: { paddingHorizontal: 12, paddingVertical: 15, fontSize: 13, lineHeight: 20, color: "#243e50", fontVariant: ["tabular-nums"] },
    headingText: { color: "#fff", fontWeight: "600" },
    alternate: { backgroundColor: "#edf3f7" },
});
