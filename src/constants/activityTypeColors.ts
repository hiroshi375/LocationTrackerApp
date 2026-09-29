export const ACTIVITY_TYPE_COLORS = {
    WALKING: "#35C366",
    RUNNING: "#18B5DA",
    CYCLING: "#FE910E",

    // 既存色を維持
    VEHICLE: "#F26B6B",
    MIXED: "#8B7CF6",
    UNKNOWN: "#9AA5B1",
} as const;

export function getActivityTypeColor(
    activityType: string | null | undefined,
): string {
    switch (activityType) {
        case "WALKING":
            return ACTIVITY_TYPE_COLORS.WALKING;

        case "RUNNING":
            return ACTIVITY_TYPE_COLORS.RUNNING;

        case "CYCLING":
            return ACTIVITY_TYPE_COLORS.CYCLING;

        case "VEHICLE":
            return ACTIVITY_TYPE_COLORS.VEHICLE;

        case "MIXED":
            return ACTIVITY_TYPE_COLORS.MIXED;

        case "UNKNOWN":
        default:
            return ACTIVITY_TYPE_COLORS.UNKNOWN;
    }
}
