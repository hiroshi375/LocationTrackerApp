import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import ActivityCalendarScreen from "../screens/ActivityCalendarScreen";
import ActivityRankingScreen from "../screens/ActivityRankingScreen";
import AdminLocationLogImportScreen from "../screens/AdminLocationLogImportScreen";
import AppInfoScreen from "../screens/AppInfoScreen";
import ContactScreen from "../screens/ContactScreen";
import LiveLocationMapScreen from "../screens/LiveLocationMapScreen";
import LocationHomeScreen from "../screens/LocationHomeScreen";
import LocationLogDetailScreen from "../screens/LocationLogDetailScreen";
import LocationLogScreen from "../screens/LocationLogScreen";
import LocationMapScreen from "../screens/LocationMapScreen";
import PrivacyPolicyScreen from "../screens/PrivacyPolicyScreen";
import ProfileScreen from "../screens/ProfileScreen";
import TermsOfServiceScreen from "../screens/TermsOfServiceScreen";

export type RootStackParamList = {
    LocationHome: undefined;
    LocationLog: undefined;
    AdminLocationLogImport: undefined;
    ActivityCalendar: undefined;
    LocationMap: {
        recordingSessionId?: string | null;
        recordingIntervalMs?: number | null;
        recordingDistanceMeters?: number | null;
        sharedLiveUserId?: string | null;
        sharedLiveLocationId?: string | null;

        /**
         * true: 共有中の現在地と記録ルートを表示
         * false: 共有中の現在地のみ表示
         */
        sharedLiveIsRecording?: boolean;

        selectedLocation?: {
            id: string;
            latitude: number;
            longitude: number;
            accuracy?: number | null;
            recordedAt: string;
            memo?: string | null;
            recordingSessionId?: string | null;
            recordingSessionName?: string | null;
            sharedOwners?: string[] | null;
            source?: string | null;
        };
    };
    LocationLogDetail: {
        locationLogId: string;
    };
    Profile: undefined;
    LiveLocationMap: undefined;
    ActivityRanking: undefined;
    AppInfo: undefined;
    PrivacyPolicy: undefined;
    TermsOfService: undefined;
    Contact: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function RootNavigator() {
    return (
        <NavigationContainer>
            <Stack.Navigator initialRouteName="LocationHome">
                <Stack.Screen
                    name="LocationHome"
                    component={LocationHomeScreen}
                    options={{ title: "" }}
                />
                <Stack.Screen
                    name="LocationLog"
                    component={LocationLogScreen}
                    options={{ title: "位置履歴" }}
                />
                <Stack.Screen
                    name="AdminLocationLogImport"
                    component={AdminLocationLogImportScreen}
                    options={{ title: "LocationLog CSVインポート" }}
                />
                <Stack.Screen
                    name="ActivityCalendar"
                    component={ActivityCalendarScreen}
                    options={{ title: "アクティビティカレンダー" }}
                />
                <Stack.Screen
                    name="LocationLogDetail"
                    component={LocationLogDetailScreen}
                    options={{ title: "位置履歴詳細" }}
                />
                <Stack.Screen
                    name="LocationMap"
                    component={LocationMapScreen}
                    options={{ title: "地図表示" }}
                />
                <Stack.Screen
                    name="Profile"
                    component={ProfileScreen}
                    options={{ title: "プロフィール" }}
                />
                <Stack.Screen
                    name="ActivityRanking"
                    component={ActivityRankingScreen}
                    options={{ title: "アクティビティランキング" }}
                />
                <Stack.Screen
                    name="LiveLocationMap"
                    component={LiveLocationMapScreen}
                    options={{ title: "共有中の現在地" }}
                />
                <Stack.Screen
                    name="AppInfo"
                    component={AppInfoScreen}
                    options={{ title: "アプリ情報" }}
                />

                <Stack.Screen
                    name="PrivacyPolicy"
                    component={PrivacyPolicyScreen}
                    options={{ title: "プライバシーポリシー" }}
                />

                <Stack.Screen
                    name="TermsOfService"
                    component={TermsOfServiceScreen}
                    options={{ title: "利用規約" }}
                />

                <Stack.Screen
                    name="Contact"
                    component={ContactScreen}
                    options={{ title: "お問い合わせ" }}
                />
            </Stack.Navigator>
        </NavigationContainer>
    );
}
