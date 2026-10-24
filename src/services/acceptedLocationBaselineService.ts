import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAcceptedBaselineStore } from "./acceptedLocationBaselineCore";
export const acceptedLocationBaselines = createAcceptedBaselineStore(AsyncStorage);
