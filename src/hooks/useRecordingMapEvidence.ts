import { useEffect, useState } from "react";
import { Platform } from "react-native";
import * as Application from "expo-application";
import { getCurrentUser } from "aws-amplify/auth";
import { recordingLifecycle } from "../services/recordingLifecycleService";
import { recordingRouteReceipts } from "../services/recordingRouteReceiptService";
import { recordingMapEvidence, type RecordingMapEvidence } from "../services/recordingMapRoute";

export function useRecordingMapEvidence(sessionId: string | null, live: boolean, focused: boolean) {
    const enabled = Platform.OS === "android" && Application.applicationId === "com.hiroshisato.locationtrackerapp";
    const [state, setState] = useState<{ sessionId: string; live: boolean; evidence: RecordingMapEvidence | null } | null>(null);
    useEffect(() => {
        if (!enabled || !sessionId || !focused) return;
        let disposed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        async function refresh() {
            let terminal = false;
            try {
                const { userId } = await getCurrentUser();
                if (disposed) return;
                const [input, stop] = await Promise.all([
                    recordingRouteReceipts.read(userId, sessionId!),
                    recordingLifecycle.read(userId, sessionId!),
                ]);
                if (disposed) return;
                terminal = Boolean(stop && ["STOPPED", "SAVE_REQUESTED", "SAVED"].includes(stop.state));
                const validStop = stop && (live ? terminal : stop.state === "SAVED");
                const matchingStop = validStop && input?.context.startedAtMs === stop.startedAtMs;
                const evidence = input && (matchingStop || (live && !stop))
                    ? recordingMapEvidence(input.context.startedAtMs, input.receipts, matchingStop ? stop.stoppedAtMs : undefined)
                    : null;
                setState({ sessionId: sessionId!, live, evidence });
                // The final inbox batch may still be arriving when the stop receipt becomes visible.
                if (terminal && !evidence) terminal = false;
            } catch {
                if (!disposed) setState({ sessionId: sessionId!, live, evidence: null });
            } finally {
                if (!disposed && live && !terminal) timer = setTimeout(() => void refresh(), 5000);
            }
        }
        void refresh();
        return () => {
            disposed = true;
            if (timer) clearTimeout(timer);
        };
    }, [enabled, focused, live, sessionId]);

    if (!enabled || !sessionId) return null;
    return state?.sessionId === sessionId && state.live === live ? state.evidence : undefined;
}
