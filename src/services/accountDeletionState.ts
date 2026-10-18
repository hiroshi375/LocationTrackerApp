import AsyncStorage from "@react-native-async-storage/async-storage";
export const accountDeletionStateKey = (userId: string) => `aclog-account-deletion:${userId}`;
export async function isAccountDeletionPending(userId: string): Promise<boolean> {
    return Boolean(await AsyncStorage.getItem(accountDeletionStateKey(userId)));
}
