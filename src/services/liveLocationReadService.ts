import { AppState } from "react-native";
import { getCurrentUser } from "aws-amplify/auth";
import { client } from "../lib/client";
import { readAuthorizedLiveLocations } from "./liveLocationReadCore";

// Coordinate writes run in Lambda and do not emit generated model subscriptions.
// Re-read with the viewer's authorization; never treat a cached subscription as
// proof that a location is still shared with this user.
export function watchLiveLocations(options: {
    filter: Record<string, unknown>;
    onItems: (items: any[]) => void;
    onError: (error: unknown) => void;
}) {
    let cancelled = false;
    let running = false;
    const refresh = async () => {
        if (cancelled || running || AppState.currentState !== "active") return;
        running = true;
        try {
            const items = await readAuthorizedLiveLocations(
                nextToken => (client.models.LiveLocation as any).list({
                    filter: options.filter, limit: 100, nextToken,
                }),
                async () => (await getCurrentUser()).userId,
                () => cancelled,
            );
            if (!cancelled && AppState.currentState === "active") options.onItems(items);
        } catch (error) {
            if (!cancelled) options.onError(error);
        } finally {
            running = false;
        }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 10_000);
    const appState = AppState.addEventListener("change", state => {
        if (state === "active") void refresh();
    });
    return { unsubscribe() { cancelled = true; clearInterval(timer); appState.remove(); } };
}
