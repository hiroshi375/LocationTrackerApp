/** Independent bounded diagnostic pages. No recording queue, acceptance state or credentials are read. */
export function createLocationDecisionArchive(options: {
    runtimeId: string;
    write: (page: number, value: string) => Promise<void>;
    rowsPerPage?: number;
    maxBufferedPages?: number;
}) {
    const pageSize = Math.max(1, Math.min(64, options.rowsPerPage ?? 32));
    const bufferLimit = Math.max(1, Math.min(8, options.maxBufferedPages ?? 8));
    type Page = { rows: Record<string, unknown>[]; revision: number; written: number };
    const pages = new Map<number, Page>();
    let pageNo = 0, running = false, droppedRows = 0, writeFailures = 0;
    const idleWaiters: (() => void)[] = [];
    const pump = async () => {
        if (running) return;
        running = true;
        try {
            for (;;) {
                const entry = [...pages].find(([, p]) => p.revision !== p.written);
                if (!entry) break;
                const [number, page] = entry, revision = page.revision;
                const value = JSON.stringify({ schema: 1, runtimeId: options.runtimeId, page: number,
                    droppedRows, writeFailures, rows: page.rows });
                try { await options.write(number, value); page.written = revision; }
                catch { writeFailures++; /* Keep recording independent; a later append/export can retry. */ break; }
                if (number !== pageNo && page.revision === revision) pages.delete(number);
            }
        } finally { running = false; for (const resolve of idleWaiters.splice(0)) resolve(); }
    };
    return {
        append(row: Record<string, unknown>) {
            try {
                // Input is already allowlisted; copy so asynchronous storage cannot observe later mutation.
                const value = JSON.stringify(row);
                if (value.length * 3 > 12 * 1024) { droppedRows++; return; }
                let page = pages.get(pageNo);
                if (!page || page.rows.length >= pageSize) {
                    if (page && page.written === page.revision) pages.delete(pageNo);
                    pageNo++; page = { rows: [], revision: 0, written: 0 }; pages.set(pageNo, page); }
                page.rows.push(JSON.parse(value)); page.revision++;
                while (pages.size > bufferLimit) {
                    const [oldNo, old] = pages.entries().next().value!;
                    // Conservative: report every removed buffered row, even if a previous revision reached disk.
                    droppedRows += old.rows.length; pages.delete(oldNo);
                }
                void pump();
            } catch { droppedRows++; }
        },
        async flush() {
            if (running) await new Promise<void>(resolve => idleWaiters.push(resolve));
            await pump();
            return ![...pages.values()].some(p => p.revision !== p.written);
        },
        stats() { return { droppedRows, writeFailures, bufferedPages: pages.size, lastPage: pageNo }; },
    };
}
