/**
 * 1ユーザーにつき1件のLiveLocationを管理するための固定ID。
 *
 * userIdはCognitoのsubを想定。
 */
export function getLiveLocationId(userId: string): string {
    if (!userId) {
        throw new Error("LiveLocation userId is required.");
    }

    return `live-${userId}`;
}
