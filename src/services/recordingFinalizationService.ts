import AsyncStorage from "@react-native-async-storage/async-storage";
import { createPlanStopReceiptStore } from "./recordingFinalizationCore";
export const planStopReceipts = createPlanStopReceiptStore(AsyncStorage);
