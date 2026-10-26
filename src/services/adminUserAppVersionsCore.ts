export type UserAppVersionRow = {
    id: string;
    displayName: string;
    appVersion: string;
    appBuildVersion: number | null;
    platform: string;
    lastAppOpenedAt: string | null;
};

export type UserAppVersionRecord = {
    id?: string | null;
    displayName?: string | null;
    appVersion?: string | null;
    appBuildVersion?: number | null;
    lastAppPlatform?: string | null;
    lastAppOpenedAt?: string | null;
};

type Page = {
    data?: (UserAppVersionRecord | null)[] | null;
    errors?: readonly unknown[];
    nextToken?: string | null;
};

export type AdminAppVersionIdentity = { userId: string; isAdmin: boolean };

export class AdminAppVersionsAccessError extends Error {
    constructor() {
        super("この画面は管理者のみ利用できます。");
        this.name = "AdminAppVersionsAccessError";
    }
}

function timestamp(value?: string | null): number | null {
    if (!value) return null;
    const result = Date.parse(value);
    return Number.isFinite(result) ? result : null;
}

export function formatAppOpenedAtJst(value?: string | null): string {
    const time = timestamp(value);
    if (time === null) return "未取得";
    // UTC getters keep the display in JST regardless of the device timezone.
    const date = new Date(time + 9 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

export function normalizeUserAppVersions(
    records: readonly (UserAppVersionRecord | null)[],
): UserAppVersionRow[] {
    const rows = new Map<string, UserAppVersionRow>();
    for (const record of records) {
        if (!record?.id) continue;
        const platform = record.lastAppPlatform?.toLowerCase();
        const row: UserAppVersionRow = {
            id: record.id,
            displayName: record.displayName?.trim() || "名前未設定",
            appVersion: record.appVersion?.trim() || "未取得",
            appBuildVersion: Number.isInteger(record.appBuildVersion) &&
                (record.appBuildVersion ?? -1) >= 0 ? record.appBuildVersion! : null,
            platform: platform === "ios" ? "iOS" : platform === "android" ? "Android" : "未取得",
            lastAppOpenedAt: timestamp(record.lastAppOpenedAt) === null ? null : record.lastAppOpenedAt!,
        };
        const previous = rows.get(row.id);
        if (!previous || (timestamp(row.lastAppOpenedAt) ?? -Infinity) >
            (timestamp(previous.lastAppOpenedAt) ?? -Infinity)) {
            rows.set(row.id, row);
        }
    }
    return [...rows.values()].sort((a, b) => {
        const at = timestamp(a.lastAppOpenedAt);
        const bt = timestamp(b.lastAppOpenedAt);
        if (at !== bt) {
            if (at === null) return 1;
            if (bt === null) return -1;
            return bt - at;
        }
        return a.displayName.localeCompare(b.displayName, "ja") || a.id.localeCompare(b.id);
    });
}

export async function readAdminUserAppVersions(
    readPage: (nextToken?: string) => Promise<Page>,
    getIdentity: () => Promise<AdminAppVersionIdentity>,
    isCancelled: () => boolean,
): Promise<UserAppVersionRow[] | null> {
    if (isCancelled()) return null;
    const identity = await getIdentity();
    if (!identity.isAdmin) throw new AdminAppVersionsAccessError();
    const records: (UserAppVersionRecord | null)[] = [];
    const tokens = new Set<string>();
    let nextToken: string | undefined;
    do {
        if (isCancelled()) return null;
        const page = await readPage(nextToken);
        if (isCancelled()) return null;
        if (page.errors?.length || !Array.isArray(page.data)) {
            throw new Error("一覧を取得できませんでした。通信状態を確認して再取得してください。");
        }
        records.push(...page.data);
        nextToken = page.nextToken || undefined;
        if (nextToken && tokens.has(nextToken)) {
            throw new Error("一覧のページ取得が完了しませんでした。再取得してください。");
        }
        if (nextToken) tokens.add(nextToken);
    } while (nextToken);
    const current = await getIdentity();
    if (isCancelled()) return null;
    if (!current.isAdmin || current.userId !== identity.userId) {
        throw new AdminAppVersionsAccessError();
    }
    return normalizeUserAppVersions(records);
}
