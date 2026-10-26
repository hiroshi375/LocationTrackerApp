type DiscardResponse = { data?: boolean | null; errors?: readonly { message: string }[] };

// An uncertain network result must not trap the name modal indefinitely. The
// server operation is fenced/idempotent; a timed-out request may still finish.
export async function requestDiscardStep(request: () => Promise<DiscardResponse>, timeoutMs = 20_000): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const response = await Promise.race([
            Promise.resolve().then(request),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("破棄の結果を確認できませんでした。後で再開できます。")), timeoutMs);
            }),
        ]);
        if (response.errors?.length || typeof response.data !== "boolean")
            throw new Error(response.errors?.map(error => error.message).join("\n") || "破棄の結果を確認できませんでした。");
        return response.data;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
