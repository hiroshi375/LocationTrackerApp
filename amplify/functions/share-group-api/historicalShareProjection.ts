export type HistoricalGrantForProjection = {
    recordingSessionRecordId: string;
    recipientOwnerValue: string;
    isActive: boolean;
};

export function calculateEffectiveSharedOwners(
    recordingSessionRecordId: string,
    grants: HistoricalGrantForProjection[],
): string[] {
    if (!recordingSessionRecordId.trim()) {
        throw new Error("RecordingSession IDが不正です。");
    }

    const owners = new Set<string>();

    for (const grant of grants) {
        if (grant.recordingSessionRecordId !== recordingSessionRecordId) {
            throw new Error("異なるRecordingSessionのGrantが混入しています。");
        }

        if (!grant.isActive) {
            continue;
        }

        const ownerValue = grant.recipientOwnerValue.trim();

        if (!ownerValue) {
            throw new Error("有効なGrantに共有先識別子がありません。");
        }

        owners.add(ownerValue);
    }

    return [...owners].sort();
}

/**
 * sharedOwnersの順序に依存せず、内容を比較する。
 * 重複・空文字があれば不一致として扱う。
 */
export function areSharedOwnersEqual(
    actual: readonly string[] | null | undefined,
    expected: readonly string[],
): boolean {
    const actualValues = actual ?? [];

    if (
        actualValues.some((value) => typeof value !== "string" || !value.trim())
    ) {
        return false;
    }

    const normalizedActual = [...new Set(actualValues)].sort();
    const normalizedExpected = [...new Set(expected)].sort();

    // 重複している実データは一致と判定しない
    if (normalizedActual.length !== actualValues.length) {
        return false;
    }

    if (normalizedActual.length !== normalizedExpected.length) {
        return false;
    }

    return normalizedActual.every(
        (value, index) => value === normalizedExpected[index],
    );
}
