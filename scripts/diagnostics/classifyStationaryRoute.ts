import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeRouteLogs } from '../../src/lib/locationRoute';
import { calculateDistanceMeters } from '../../src/utils/locationDuplicate';

/** Descriptive bins only; never used as acceptance/exclusion rules. No coordinates or account IDs in output. */
export function classifyStationaryRoute(rows: any[]) {
    const route = normalizeRouteLogs(normalizeRouteLogs(rows));
    const bins = [{ name: 'under10m', min: 0, max: 10 }, { name: '10to100m', min: 10, max: 100 },
        { name: '100to1000m', min: 100, max: 1000 }, { name: '1000mOrMore', min: 1000, max: Infinity }]
        .map(b => ({ ...b, count: 0, meters: 0, bothAccuracyAtMost10m: 0, impliedAtMost2mps: 0 }));
    let maxLeg = 0, maxImpliedSpeed = 0, speedAvailablePairs = 0, accuracyAvailablePairs = 0;
    let over200kmh = 0, nonPositiveIntervals = 0;
    for (let i = 1; i < route.length; i++) {
        const a = route[i - 1], b = route[i];
        const meters = calculateDistanceMeters(a.latitude, a.longitude, b.latitude, b.longitude);
        const seconds = (Date.parse(b.recordedAt) - Date.parse(a.recordedAt)) / 1000;
        const bin = bins.find(x => meters >= x.min && meters < x.max)!;
        bin.count++; bin.meters += meters; maxLeg = Math.max(maxLeg, meters);
        if (Number.isFinite(a.accuracy) && Number.isFinite(b.accuracy)) {
            accuracyAvailablePairs++;
            if (a.accuracy <= 10 && b.accuracy <= 10) bin.bothAccuracyAtMost10m++;
        }
        if (Number.isFinite(a.speed) && Number.isFinite(b.speed)) speedAvailablePairs++;
        if (seconds <= 0) nonPositiveIntervals++;
        else { const speed = meters / seconds; maxImpliedSpeed = Math.max(maxImpliedSpeed, speed);
            if (speed <= 2) bin.impliedAtMost2mps++; if (speed > 200 / 3.6) over200kmh++; }
    }
    return { inputPoints: rows.length, routePoints: route.length, legs: Math.max(0, route.length - 1),
        distanceMeters: bins.reduce((n, x) => n + x.meters, 0), maxLegMeters: maxLeg,
        maxCoordinateImpliedSpeedMps: maxImpliedSpeed, coordinateImpliedOver200kmhLegs: over200kmh,
        nonPositiveIntervals, accuracyAvailablePairs, nativeSpeedAvailablePairs: speedAvailablePairs,
        bins: bins.map(({ min, max, ...x }) => x),
        warning: 'Bin boundaries are descriptions, not safe filters. Coordinate-implied speed is not Native-reported speed. Saved points omit rejected/raw receipts.' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    const directory = process.argv[2] ?? '.amplify/known-issues-20261027'; const results: any = {};
    for (const run of ['r1', 'r2']) for (const os of ['android', 'ios']) {
        const raw = fs.readFileSync(path.join(directory, `${run}-final-${os}-private.json`), 'utf8');
        results[`${run}-${os}`] = { ...classifyStationaryRoute(JSON.parse(raw).rows),
            inputSha256: crypto.createHash('sha256').update(raw).digest('hex') };
    }
    fs.writeFileSync(path.join(directory, 'stationary-leg-classification-20261028.json'), JSON.stringify(results, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(results, null, 2));
}
