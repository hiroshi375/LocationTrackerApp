type Page = { data?: any[] | null; errors?: readonly unknown[]; nextToken?: string | null };

export async function readAuthorizedLiveLocations(
    readPage: (nextToken?: string) => Promise<Page>,
    getUserId: () => Promise<string>,
    isCancelled: () => boolean,
): Promise<any[]> {
    const userId = await getUserId();
    const items: any[] = [];
    let nextToken: string | undefined;
    const tokens = new Set<string>();
    do {
        if (isCancelled()) return [];
        const result = await readPage(nextToken);
        if (result.errors?.length) throw new Error("共有中の現在地を取得できませんでした。");
        items.push(...(result.data ?? []));
        nextToken = result.nextToken || undefined;
        if (nextToken && tokens.has(nextToken)) throw new Error("現在地のページ取得が完了しませんでした。");
        if (nextToken) tokens.add(nextToken);
    } while (nextToken);
    // Account switches must never publish data fetched with the previous token.
    const currentUserId = await getUserId();
    if (isCancelled() || currentUserId !== userId) return [];
    return items;
}
