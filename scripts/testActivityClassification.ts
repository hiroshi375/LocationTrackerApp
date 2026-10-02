import fs from "node:fs";
import path from "node:path";

import {
    classifyActivitySession,
    type ActivityLocationLog,
} from "../src/services/activityClassificationService";

function parseCsvLine(line: string): string[] {
    const values: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
        const char = line[i];

        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i += 1;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === "," && !inQuotes) {
            values.push(current);
            current = "";
        } else {
            current += char;
        }
    }

    values.push(current);
    return values;
}

function parseCsv(content: string): Record<string, string>[] {
    const lines = content
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0);

    if (lines.length < 2) {
        return [];
    }

    const headers = parseCsvLine(lines[0]);

    return lines.slice(1).map((line) => {
        const values = parseCsvLine(line);

        return Object.fromEntries(
            headers.map((header, index) => [
                header,
                values[index] ?? "",
            ]),
        );
    });
}

const csvPath = process.argv[2];

if (!csvPath) {
    console.error(
        "使用方法: npx --yes tsx scripts/testActivityClassification.ts <CSVファイル>",
    );
    process.exit(1);
}

const resolvedPath = path.resolve(csvPath);

if (!fs.existsSync(resolvedPath)) {
    console.error(`CSVファイルが見つかりません: ${resolvedPath}`);
    process.exit(1);
}

const csvContent = fs.readFileSync(resolvedPath, "utf8");
const rows = parseCsv(csvContent);

const logs: ActivityLocationLog[] = rows
    .map((row) => ({
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        recordedAt: row.recordedAt,
        accuracy:
            row.accuracy === "" || row.accuracy == null
                ? null
                : Number(row.accuracy),
    }))
    .filter(
        (log) =>
            Number.isFinite(log.latitude) &&
            Number.isFinite(log.longitude) &&
            Number.isFinite(new Date(log.recordedAt).getTime()) &&
            (log.accuracy == null || Number.isFinite(log.accuracy)),
    );

console.log("========================================");
console.log("Activity Classification Test");
console.log("========================================");
console.log(`CSV: ${resolvedPath}`);
console.log(`CSV rows: ${rows.length}`);
console.log(`Converted logs: ${logs.length}`);
console.log("");

if (logs.length > 0) {
    const sortedLogs = [...logs].sort(
        (a, b) =>
            new Date(a.recordedAt).getTime() -
            new Date(b.recordedAt).getTime(),
    );

    console.log(`Start: ${sortedLogs[0].recordedAt}`);
    console.log(
        `End:   ${sortedLogs[sortedLogs.length - 1].recordedAt}`,
    );
    console.log("");
}

const result = classifyActivitySession(logs);

console.log("----------------------------------------");
console.log("Classification Result");
console.log("----------------------------------------");
console.log(`activityType:          ${result.activityType}`);
console.log(
    `classificationSource: ${result.classificationSource}`,
);
console.log(
    `isAggregationTarget:  ${result.isAggregationTarget}`,
);
console.log(
    `averageSpeedKmh:      ${result.averageSpeedKmh}`,
);
console.log(
    `maxSpeedKmh:          ${result.maxSpeedKmh}`,
);
console.log(
    `movingDurationSeconds:${result.movingDurationSeconds}`,
);
console.log("");
console.log("classificationReason:");
console.log(result.classificationReason);
console.log("========================================");
