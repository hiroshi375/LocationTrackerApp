/** Exact allowlist: never delete directories, recording databases, queues or credentials. */
export const LEGACY_DIAGNOSTIC_FILES = ['headless-native-diagnostic.previous.log', 'headless-native-diagnostic.log'] as const;
export async function clearLegacyDiagnosticLogs(input: {
    applicationId: string | null; recording: boolean; sharing: boolean;
    deleteFile: (name: typeof LEGACY_DIAGNOSTIC_FILES[number]) => Promise<void>;
}) {
    if (input.applicationId !== 'com.hiroshisato.locationtrackerapp.incident104') throw new Error('TEST_APP_ONLY');
    if (input.recording || input.sharing) throw new Error('STOP_RECORDING_AND_SHARING_FIRST');
    for (const name of LEGACY_DIAGNOSTIC_FILES) await input.deleteFile(name);
}
export function compactDecisionDiagnostic(value: string | null): string | null {
    if (!value) return null;
    try {
        const snapshot = JSON.parse(value);
        if (snapshot.schema !== 1 || !Array.isArray(snapshot.rows) || !snapshot.rows.some((r: any) => r.nativeEvidence?.schema === 1)) return null;
        return '===== EXPORT SCOPE =====\nNative採否診断。旧Nativeテキスト・旧JS stageは省略。元の採否証拠・欠落情報は保持。\n===== LOCATION DECISION EVIDENCE =====\n' + value;
    } catch { return null; }
}
