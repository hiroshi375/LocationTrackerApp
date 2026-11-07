import AsyncStorage from '@react-native-async-storage/async-storage';
import { createQualityReviewStore, type ReviewPoint } from './locationQualityReviewCore';
// Remains OFF until side-by-side local validation, including slow walking/loops/offline replay, is approved.
export const ENABLE_LOCATION_QUALITY_REVIEW = false;
const store = createQualityReviewStore(AsyncStorage);
export async function holdAbnormalLocationForReview(point: ReviewPoint): Promise<void> {
    if (ENABLE_LOCATION_QUALITY_REVIEW) await store.hold(point, 'abnormalSpeed');
}
export async function hasPendingLocationQualityReview(point: ReviewPoint): Promise<boolean> {
    return ENABLE_LOCATION_QUALITY_REVIEW ? Boolean(await store.read(point)) : false;
}
