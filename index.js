import { Buffer } from "buffer";
import "react-native-get-random-values";

import { registerRootComponent } from "expo";
import App from "./App";

global.Buffer = global.Buffer || Buffer;

registerRootComponent(App);
