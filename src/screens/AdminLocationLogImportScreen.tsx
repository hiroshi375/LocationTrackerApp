import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { getCurrentUser } from "aws-amplify/auth";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { useEffect, useMemo, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from "react-native";

import { client } from "../lib/client";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { getCurrentUserProfile } from "../services/userProfileService";

type Props = NativeStackScreenProps<
    RootStackParamList,
    "AdminLocationLogImport"
>;

type CsvRawRow = Record<string, string>;

type LocationLogImportRow = {
    rowNo: number;

    id: string;
    userId: string;

    latitude: number;
    longitude: number;
    accuracy: number | null;

    recordedAt: string;

    memo: string | null;
    recordingSessionId: string | null;
    recordingSessionName: string | null;

    sharedOwners: string[];

    batteryLevel: number | null;
    batteryState: string | null;
    lowPowerMode: boolean | null;

    source: string | null;
    locationUniqueKey: string | null;

    activityType: string | null;
    isAggregationTarget: boolean | null;
};

type ValidationError = {
    rowNo: number;
    message: string;
};

type ImportSummary = {
    totalCount: number;
    validCount: number;
    invalidCount: number;
    sessionCount: number;
};

type ImportResult = {
    createdCount: number;
    skippedCount: number;
    failedCount: number;
};

const REQUIRED_HEADERS = [
    "id",
    "userId",
    "latitude",
    "longitude",
    "recordedAt",
] as const;

export default function AdminLocationLogImportScreen({ navigation }: Props) {
    const [checkingAdmin, setCheckingAdmin] = useState(true);

    const [selectedFileName, setSelectedFileName] = useState<string | null>(
        null,
    );

    const [rows, setRows] = useState<LocationLogImportRow[]>([]);
    const [validationErrors, setValidationErrors] = useState<ValidationError[]>(
        [],
    );

    const [loadingFile, setLoadingFile] = useState(false);
    const [importing, setImporting] = useState(false);

    const [importResult, setImportResult] = useState<ImportResult | null>(null);

    const [importProgress, setImportProgress] = useState({
        current: 0,
        total: 0,
    });

    useEffect(() => {
        const checkAdmin = async () => {
            try {
                const profile = await getCurrentUserProfile();

                if (profile?.role !== "admin") {
                    Alert.alert(
                        "権限エラー",
                        "この画面は管理者のみ利用できます。",
                        [
                            {
                                text: "OK",
                                onPress: () => navigation.goBack(),
                            },
                        ],
                    );

                    return;
                }
            } catch (error) {
                console.error("[LocationLogImport] admin check error:", error);

                Alert.alert(
                    "権限確認エラー",
                    "管理者権限を確認できませんでした。",
                    [
                        {
                            text: "OK",
                            onPress: () => navigation.goBack(),
                        },
                    ],
                );
            } finally {
                setCheckingAdmin(false);
            }
        };

        void checkAdmin();
    }, [navigation]);

    const summary = useMemo<ImportSummary>(() => {
        const sessionIds = new Set(
            rows
                .map((row) => row.recordingSessionId)
                .filter((value): value is string => Boolean(value)),
        );

        return {
            totalCount: rows.length + validationErrors.length,
            validCount: rows.length,
            invalidCount: validationErrors.length,
            sessionCount: sessionIds.size,
        };
    }, [rows, validationErrors]);

    const handleSelectCsv = async () => {
        if (importing) {
            return;
        }

        try {
            setLoadingFile(true);
            setImportResult(null);
            setRows([]);
            setValidationErrors([]);

            const result = await DocumentPicker.getDocumentAsync({
                type: [
                    "text/csv",
                    "text/comma-separated-values",
                    "application/csv",
                    "text/plain",
                ],
                copyToCacheDirectory: true,
                multiple: false,
            });

            if (result.canceled) {
                return;
            }

            const asset = result.assets[0];

            if (!asset) {
                throw new Error("選択したCSVファイルを取得できませんでした。");
            }

            const csvText = await FileSystem.readAsStringAsync(asset.uri, {
                encoding: FileSystem.EncodingType.UTF8,
            });

            const parsed = await parseLocationLogCsv(csvText);

            setSelectedFileName(asset.name);
            setRows(parsed.rows);
            setValidationErrors(parsed.errors);

            if (parsed.rows.length === 0) {
                Alert.alert(
                    "CSV確認",
                    "インポート可能なLocationLogがありませんでした。",
                );
            }
        } catch (error) {
            console.error("[LocationLogImport] CSV load error:", error);

            Alert.alert("CSV読込エラー", getErrorMessage(error));
        } finally {
            setLoadingFile(false);
        }
    };

    const handleImport = () => {
        if (rows.length === 0 || importing) {
            return;
        }

        Alert.alert(
            "LocationLogをインポート",
            [
                `${rows.length}件のLocationLogを復旧します。`,
                "",
                "同じidのLocationLogが既に存在する場合はスキップします。",
                "",
                "実行しますか？",
            ].join("\n"),
            [
                {
                    text: "キャンセル",
                    style: "cancel",
                },
                {
                    text: "インポート",
                    onPress: () => {
                        void executeImport();
                    },
                },
            ],
        );
    };

    const executeImport = async () => {
        try {
            setImporting(true);
            setImportResult(null);

            const currentUser = await getCurrentUser();

            /*
             * owner認証のデータなので、別ユーザーのCSVを
             * 現在のユーザー所有データとして誤復旧しないようにする。
             */
            const foreignUserRows = rows.filter(
                (row) => row.userId !== currentUser.userId,
            );

            if (foreignUserRows.length > 0) {
                throw new Error(
                    `現在のログインユーザーと異なるuserIdの行が${foreignUserRows.length}件あります。インポートを中止しました。`,
                );
            }

            let createdCount = 0;
            let skippedCount = 0;
            let failedCount = 0;

            setImportProgress({
                current: 0,
                total: rows.length,
            });

            const locationLogModel = client.models.LocationLog as any;

            /*
             * 復旧処理なので大量並列createは行わず、
             * 1件ずつ安全に処理する。
             */
            for (let index = 0; index < rows.length; index += 1) {
                const row = rows[index];

                try {
                    /*
                     * 同じCSVを複数回取り込んでも
                     * 重複登録されないようidで確認する。
                     */
                    const existingResult = await locationLogModel.get({
                        id: row.id,
                    });

                    if (existingResult.errors) {
                        console.error("[LocationLogImport] get errors:", {
                            rowNo: row.rowNo,
                            id: row.id,
                            errors: existingResult.errors,
                        });

                        failedCount += 1;
                        continue;
                    }

                    if (existingResult.data) {
                        skippedCount += 1;
                        continue;
                    }

                    /*
                     * CSVのowner / createdAt / updatedAt / __typename は
                     * Amplifyへ渡さない。
                     *
                     * ownerとTimestampはAmplify側で再生成させる。
                     */
                    const createResult = await locationLogModel.create({
                        id: row.id,

                        userId: row.userId,

                        latitude: row.latitude,
                        longitude: row.longitude,
                        accuracy: row.accuracy,

                        recordedAt: row.recordedAt,

                        memo: row.memo,

                        recordingSessionId: row.recordingSessionId,
                        recordingSessionName: row.recordingSessionName,

                        sharedOwners:
                            row.sharedOwners.length > 0
                                ? row.sharedOwners
                                : undefined,

                        batteryLevel: row.batteryLevel,
                        batteryState: row.batteryState,
                        lowPowerMode: row.lowPowerMode,

                        source: row.source,

                        locationUniqueKey: row.locationUniqueKey,

                        activityType: row.activityType,

                        isAggregationTarget: row.isAggregationTarget,
                    });

                    if (createResult.errors) {
                        console.error("[LocationLogImport] create errors:", {
                            rowNo: row.rowNo,
                            id: row.id,
                            errors: createResult.errors,
                        });

                        failedCount += 1;
                    } else {
                        createdCount += 1;
                    }
                } catch (error) {
                    console.error("[LocationLogImport] row import error:", {
                        rowNo: row.rowNo,
                        id: row.id,
                        error,
                    });

                    failedCount += 1;
                } finally {
                    setImportProgress({
                        current: index + 1,
                        total: rows.length,
                    });
                }
            }

            const nextResult: ImportResult = {
                createdCount,
                skippedCount,
                failedCount,
            };

            setImportResult(nextResult);

            Alert.alert(
                "インポート完了",
                [
                    `新規登録: ${createdCount}件`,
                    `既存スキップ: ${skippedCount}件`,
                    `失敗: ${failedCount}件`,
                ].join("\n"),
            );
        } catch (error) {
            console.error("[LocationLogImport] import error:", error);

            Alert.alert("インポートエラー", getErrorMessage(error));
        } finally {
            setImporting(false);
        }
    };

    if (checkingAdmin) {
        return (
            <View style={styles.center}>
                <ActivityIndicator />
                <Text style={styles.loadingText}>
                    管理者権限を確認しています...
                </Text>
            </View>
        );
    }

    return (
        <ScrollView contentContainerStyle={styles.container}>
            <Text style={styles.title}>LocationLog CSVインポート</Text>

            <Text style={styles.description}>
                DynamoDBからExportしたLocationLog CSVを読み込み、
                Amplify経由でLocationLogを復旧します。
            </Text>

            <View style={styles.warningBox}>
                <Text style={styles.warningTitle}>復旧時の注意</Text>

                <Text style={styles.warningText}>
                    ・元のLocationLog idを保持して登録します。
                </Text>

                <Text style={styles.warningText}>
                    ・既に存在するidはスキップします。
                </Text>

                <Text style={styles.warningText}>
                    ・CSVのowner / createdAt / updatedAtは復旧しません。
                </Text>

                <Text style={styles.warningText}>
                    ・現在ログイン中のユーザーと異なるuserIdは登録しません。
                </Text>
            </View>

            <Pressable
                style={({ pressed }) => [
                    styles.button,
                    pressed &&
                        !loadingFile &&
                        !importing &&
                        styles.buttonPressed,
                    (loadingFile || importing) && styles.buttonDisabled,
                ]}
                disabled={loadingFile || importing}
                onPress={() => {
                    void handleSelectCsv();
                }}
            >
                <Text style={styles.buttonText}>
                    {loadingFile ? "CSV読込中..." : "CSVファイルを選択"}
                </Text>
            </Pressable>

            {selectedFileName && (
                <View style={styles.resultBox}>
                    <Text style={styles.sectionTitle}>CSV確認結果</Text>

                    <Text style={styles.fileName}>{selectedFileName}</Text>

                    <Text style={styles.resultText}>
                        CSV総件数: {summary.totalCount}件
                    </Text>

                    <Text style={styles.resultText}>
                        有効: {summary.validCount}件
                    </Text>

                    <Text style={styles.resultText}>
                        無効: {summary.invalidCount}件
                    </Text>

                    <Text style={styles.resultText}>
                        対象セッション: {summary.sessionCount}件
                    </Text>
                </View>
            )}

            {validationErrors.length > 0 && (
                <View style={styles.errorBox}>
                    <Text style={styles.errorTitle}>CSV検証エラー</Text>

                    {validationErrors.slice(0, 20).map((error, index) => (
                        <Text
                            key={`${error.rowNo}-${index}`}
                            style={styles.errorText}
                        >
                            行{error.rowNo}: {error.message}
                        </Text>
                    ))}

                    {validationErrors.length > 20 && (
                        <Text style={styles.errorText}>
                            他 {validationErrors.length - 20}件
                        </Text>
                    )}
                </View>
            )}

            {rows.length > 0 && (
                <>
                    <View style={styles.previewBox}>
                        <Text style={styles.sectionTitle}>先頭データ</Text>

                        <Text style={styles.previewText}>ID: {rows[0].id}</Text>

                        <Text style={styles.previewText}>
                            session: {rows[0].recordingSessionId ?? "-"}
                        </Text>

                        <Text style={styles.previewText}>
                            記録日時: {rows[0].recordedAt}
                        </Text>

                        <Text style={styles.previewText}>
                            緯度: {rows[0].latitude}
                        </Text>

                        <Text style={styles.previewText}>
                            経度: {rows[0].longitude}
                        </Text>

                        <Text style={styles.previewText}>
                            source: {rows[0].source ?? "-"}
                        </Text>
                    </View>

                    <Pressable
                        style={({ pressed }) => [
                            styles.importButton,
                            pressed && !importing && styles.buttonPressed,
                            importing && styles.buttonDisabled,
                        ]}
                        disabled={importing}
                        onPress={handleImport}
                    >
                        <Text style={styles.buttonText}>
                            {importing
                                ? `インポート中 ${importProgress.current} / ${importProgress.total}`
                                : `${rows.length}件をインポート`}
                        </Text>
                    </Pressable>
                </>
            )}

            {importing && (
                <View style={styles.progressBox}>
                    <ActivityIndicator />

                    <Text style={styles.progressText}>
                        {importProgress.current} / {importProgress.total}
                    </Text>
                </View>
            )}

            {importResult && (
                <View style={styles.completeBox}>
                    <Text style={styles.sectionTitle}>インポート結果</Text>

                    <Text style={styles.resultText}>
                        新規登録: {importResult.createdCount}件
                    </Text>

                    <Text style={styles.resultText}>
                        既存スキップ: {importResult.skippedCount}件
                    </Text>

                    <Text style={styles.resultText}>
                        失敗: {importResult.failedCount}件
                    </Text>
                </View>
            )}
        </ScrollView>
    );
}

/**
 * CSV全体を解析する。
 *
 * カンマ、ダブルクォート、改行を含むCSVフィールドにも対応する。
 */
function parseCsv(text: string): string[][] {
    const rows: string[][] = [];

    let row: string[] = [];
    let field = "";
    let insideQuote = false;

    const normalizedText = text.replace(/^\uFEFF/, "");

    for (let index = 0; index < normalizedText.length; index += 1) {
        const char = normalizedText[index];
        const nextChar = normalizedText[index + 1];

        if (char === '"') {
            if (insideQuote && nextChar === '"') {
                field += '"';
                index += 1;
                continue;
            }

            insideQuote = !insideQuote;
            continue;
        }

        if (char === "," && !insideQuote) {
            row.push(field);
            field = "";
            continue;
        }

        if ((char === "\n" || char === "\r") && !insideQuote) {
            if (char === "\r" && nextChar === "\n") {
                index += 1;
            }

            row.push(field);

            if (row.some((value) => value.trim().length > 0)) {
                rows.push(row);
            }

            row = [];
            field = "";
            continue;
        }

        field += char;
    }

    row.push(field);

    if (row.some((value) => value.trim().length > 0)) {
        rows.push(row);
    }

    return rows;
}

async function parseLocationLogCsv(csvText: string): Promise<{
    rows: LocationLogImportRow[];
    errors: ValidationError[];
}> {
    const csvRows = parseCsv(csvText);

    if (csvRows.length === 0) {
        throw new Error("CSVが空です。");
    }

    const headers = csvRows[0].map((header) => header.trim());

    for (const requiredHeader of REQUIRED_HEADERS) {
        if (!headers.includes(requiredHeader)) {
            throw new Error(`必須列「${requiredHeader}」がありません。`);
        }
    }

    const resultRows: LocationLogImportRow[] = [];
    const errors: ValidationError[] = [];

    for (let index = 1; index < csvRows.length; index += 1) {
        const values = csvRows[index];

        const raw: CsvRawRow = {};

        headers.forEach((header, headerIndex) => {
            raw[header] = values[headerIndex]?.trim() ?? "";
        });

        const rowNo = index + 1;

        try {
            resultRows.push(normalizeLocationLogCsvRow(raw, rowNo));
        } catch (error) {
            errors.push({
                rowNo,
                message: getErrorMessage(error),
            });
        }
    }

    return {
        rows: resultRows,
        errors,
    };
}

function normalizeLocationLogCsvRow(
    raw: CsvRawRow,
    rowNo: number,
): LocationLogImportRow {
    const id = requiredText(raw.id, "id");
    const userId = requiredText(raw.userId, "userId");

    const latitude = requiredNumber(raw.latitude, "latitude");

    const longitude = requiredNumber(raw.longitude, "longitude");

    if (latitude < -90 || latitude > 90) {
        throw new Error(`latitudeが範囲外です: ${latitude}`);
    }

    if (longitude < -180 || longitude > 180) {
        throw new Error(`longitudeが範囲外です: ${longitude}`);
    }

    const recordedAt = requiredText(raw.recordedAt, "recordedAt");

    if (Number.isNaN(new Date(recordedAt).getTime())) {
        throw new Error(`recordedAtが不正です: ${recordedAt}`);
    }

    return {
        rowNo,

        id,
        userId,

        latitude,
        longitude,

        accuracy: optionalNumber(raw.accuracy, "accuracy"),

        recordedAt,

        memo: optionalText(raw.memo),

        recordingSessionId: optionalText(raw.recordingSessionId),

        recordingSessionName: optionalText(raw.recordingSessionName),

        sharedOwners: parseSharedOwners(raw.sharedOwners),

        batteryLevel: optionalNumber(raw.batteryLevel, "batteryLevel"),

        batteryState: optionalText(raw.batteryState),

        lowPowerMode: optionalBoolean(raw.lowPowerMode, "lowPowerMode"),

        source: optionalText(raw.source),

        locationUniqueKey: optionalText(raw.locationUniqueKey),

        activityType: optionalText(raw.activityType),

        isAggregationTarget: optionalBoolean(
            raw.isAggregationTarget,
            "isAggregationTarget",
        ),
    };
}

function parseSharedOwners(value: string | undefined): string[] {
    const text = value?.trim();

    if (!text) {
        return [];
    }

    try {
        const parsed = JSON.parse(text);

        if (!Array.isArray(parsed)) {
            return [];
        }

        /*
         * DynamoDB CSV export:
         * [{"S":"xxxxx"}]
         *
         * 通常JSON:
         * ["xxxxx"]
         *
         * 両方に対応する。
         */
        return parsed
            .map((item) => {
                if (typeof item === "string") {
                    return item;
                }

                if (
                    item &&
                    typeof item === "object" &&
                    typeof item.S === "string"
                ) {
                    return item.S;
                }

                return null;
            })
            .filter((value): value is string => Boolean(value));
    } catch {
        /*
         * 単一文字列の場合も念のため対応する。
         */
        return text
            .split("|")
            .map((item) => item.trim())
            .filter(Boolean);
    }
}

function requiredText(value: string | undefined, fieldName: string): string {
    const text = value?.trim();

    if (!text) {
        throw new Error(`${fieldName}が空です。`);
    }

    return text;
}

function optionalText(value: string | undefined): string | null {
    const text = value?.trim();

    return text ? text : null;
}

function requiredNumber(value: string | undefined, fieldName: string): number {
    const text = value?.trim();

    if (!text) {
        throw new Error(`${fieldName}が空です。`);
    }

    const numberValue = Number(text);

    if (!Number.isFinite(numberValue)) {
        throw new Error(`${fieldName}が数値ではありません: ${text}`);
    }

    return numberValue;
}

function optionalNumber(
    value: string | undefined,
    fieldName: string,
): number | null {
    const text = value?.trim();

    if (!text) {
        return null;
    }

    const numberValue = Number(text);

    if (!Number.isFinite(numberValue)) {
        throw new Error(`${fieldName}が数値ではありません: ${text}`);
    }

    return numberValue;
}

function optionalBoolean(
    value: string | undefined,
    fieldName: string,
): boolean | null {
    const text = value?.trim().toLowerCase();

    if (!text) {
        return null;
    }

    if (text === "true") {
        return true;
    }

    if (text === "false") {
        return false;
    }

    throw new Error(`${fieldName}がbooleanではありません: ${value}`);
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

const styles = StyleSheet.create({
    center: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        padding: 20,
    },

    loadingText: {
        marginTop: 12,
        color: "#555",
    },

    container: {
        padding: 20,
        paddingBottom: 60,
    },

    title: {
        fontSize: 20,
        fontWeight: "bold",
        marginBottom: 8,
    },

    description: {
        color: "#555",
        lineHeight: 21,
        marginBottom: 16,
    },

    warningBox: {
        borderWidth: 1,
        borderColor: "#e0b45c",
        backgroundColor: "#fff8e8",
        borderRadius: 8,
        padding: 12,
        marginBottom: 16,
    },

    warningTitle: {
        fontWeight: "bold",
        marginBottom: 6,
    },

    warningText: {
        color: "#555",
        fontSize: 13,
        lineHeight: 20,
    },

    button: {
        backgroundColor: "#4b6f8f",
        borderRadius: 8,
        paddingVertical: 10,
        paddingHorizontal: 16,
        alignItems: "center",
    },

    importButton: {
        backgroundColor: "#27445c",
        borderRadius: 8,
        paddingVertical: 11,
        paddingHorizontal: 16,
        alignItems: "center",
        marginTop: 16,
    },

    buttonPressed: {
        opacity: 0.75,
    },

    buttonDisabled: {
        opacity: 0.5,
    },

    buttonText: {
        color: "#fff",
        fontSize: 15,
        fontWeight: "bold",
    },

    resultBox: {
        marginTop: 16,
        padding: 12,
        borderWidth: 1,
        borderColor: "#ddd",
        borderRadius: 8,
    },

    sectionTitle: {
        fontSize: 15,
        fontWeight: "bold",
        marginBottom: 8,
    },

    fileName: {
        fontWeight: "bold",
        marginBottom: 8,
    },

    resultText: {
        color: "#444",
        marginBottom: 3,
    },

    errorBox: {
        marginTop: 12,
        padding: 12,
        borderRadius: 8,
        backgroundColor: "#fff0f0",
        borderWidth: 1,
        borderColor: "#e4a5a5",
    },

    errorTitle: {
        color: "#9b2226",
        fontWeight: "bold",
        marginBottom: 8,
    },

    errorText: {
        color: "#8a1c1c",
        fontSize: 12,
        marginBottom: 4,
    },

    previewBox: {
        marginTop: 16,
        padding: 12,
        borderRadius: 8,
        backgroundColor: "#f5f7f9",
    },

    previewText: {
        color: "#444",
        fontSize: 12,
        marginBottom: 4,
    },

    progressBox: {
        marginTop: 16,
        alignItems: "center",
    },

    progressText: {
        marginTop: 8,
        color: "#555",
    },

    completeBox: {
        marginTop: 16,
        padding: 12,
        borderRadius: 8,
        backgroundColor: "#eef7ee",
        borderWidth: 1,
        borderColor: "#a8cba8",
    },
});
