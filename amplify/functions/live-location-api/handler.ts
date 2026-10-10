import {
    readShareState,
    updateCoordinates,
    changeSharing,
    startLiveLocationRecording,
    stopLiveLocationRecording,
} from "./mutations";

type AuthIdentity = {
    sub?: string;
    username?: string;
    claims?: Record<string, unknown>;
};

type LiveLocationEvent = {
    info?: { fieldName?: string };
    fieldName?: string;
    arguments: Record<string, any>;
    identity?: AuthIdentity;
};

export const handler = async (event: LiveLocationEvent) => {
    const identity = event.identity;

    const sub = identity?.sub ?? identity?.claims?.sub;

    const username =
        identity?.username ?? identity?.claims?.["cognito:username"];

    if (
        typeof sub !== "string" ||
        !sub ||
        typeof username !== "string" ||
        !username
    ) {
        throw new Error("UNAUTHORIZED");
    }

    const fieldName = event.info?.fieldName ?? event.fieldName;

    switch (fieldName) {
        case "getLiveLocationSharingState": {
            return await readShareState(sub);
        }

        case "updateLiveLocationCoordinates": {
            const args = event.arguments;

            await updateCoordinates({
                userId: sub,
                expectedRevision: args.expectedRevision,
                latitude: args.latitude,
                longitude: args.longitude,
                accuracy: args.accuracy ?? null,
            });

            return true;
        }

        case "changeLiveLocationSharing": {
            const args = event.arguments;

            return await changeSharing({
                userId: sub,
                owner: `${sub}::${username}`,
                expectedRevision: args.expectedRevision,
                sharedOwners: args.sharedOwners,
            });
        }

        case "startLiveLocationRecording": {
            const args = event.arguments;

            return await startLiveLocationRecording({
                userId: sub,
                expectedRevision: args.expectedRevision,
                recordingSessionId: args.recordingSessionId,
            });
        }

        case "stopLiveLocationRecording": {
            const expectedRevision = event.arguments.expectedRevision;

            const expectedRecordingSessionId =
                event.arguments.expectedRecordingSessionId;

            return await stopLiveLocationRecording({
                userId: sub,
                expectedRevision,
                expectedRecordingSessionId,
            });
        }

        default:
            throw new Error(`Unsupported mutation: ${String(fieldName)}`);
    }
};
