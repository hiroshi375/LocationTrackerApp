import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { createDelayEvidenceWriter, createIOSDelayObserver } from './iosDelayDiagnosticCore';
const observer = createIOSDelayObserver(createDelayEvidenceWriter(AsyncStorage));
export function recordIOSReceipt(eventId: string, atMs: number, timestamps: number[]): void {
    if (Platform.OS !== 'ios') return;
    try { observer.receipt(eventId, atMs, timestamps); } catch { /* diagnostic only */ }
}
export function recordIOSDelayStage(eventId: string, stage: string, atMs: number, details?: Record<string, unknown>): void {
    if (Platform.OS !== 'ios') return;
    try { observer.stage(eventId, stage, atMs, details); } catch { /* diagnostic only */ }
}
