import "react-native-get-random-values";
import "./src/tasks/backgroundLocationTask";

import { Authenticator } from "@aws-amplify/ui-react-native";
import { Amplify } from "aws-amplify";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { StatusBar } from "expo-status-bar";
import outputs from "./amplify_outputs.json";
import RootNavigator from "./src/navigation/RootNavigator";

Amplify.configure(outputs);

function AppContent() {
    return (
        <SafeAreaProvider>
            <RootNavigator />
        </SafeAreaProvider>
    );
}

export default function App() {
    return (
        <Authenticator.Provider>
            <StatusBar
                style="dark"
                hidden={false}
                backgroundColor="#ffffff"
                translucent={false}
            />
            <Authenticator>
                <AppContent />
            </Authenticator>
        </Authenticator.Provider>
    );
}
