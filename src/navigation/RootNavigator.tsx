import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import LocationHomeScreen from "../screens/LocationHomeScreen";
import LocationLogDetailScreen from "../screens/LocationLogDetailScreen";
import LocationLogScreen from "../screens/LocationLogScreen";
import LocationMapScreen from "../screens/LocationMapScreen";

export type RootStackParamList = {
    LocationHome: undefined;
    LocationLog: undefined;
    LocationMap:
        | {
              selectedLocation?: {
                  id: string;
                  latitude: number;
                  longitude: number;
                  accuracy?: number | null;
                  recordedAt: string;
                  memo?: string | null;
                  recordingSessionId?: string | null;
              };
          }
        | undefined;
    LocationLogDetail: {
        locationLogId: string;
    };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function RootNavigator() {
    return (
        <NavigationContainer>
            <Stack.Navigator initialRouteName="LocationHome">
                <Stack.Screen
                    name="LocationHome"
                    component={LocationHomeScreen}
                    options={{ title: "現在地記録" }}
                />
                <Stack.Screen
                    name="LocationLog"
                    component={LocationLogScreen}
                    options={{ title: "位置履歴" }}
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
            </Stack.Navigator>
        </NavigationContainer>
    );
}
