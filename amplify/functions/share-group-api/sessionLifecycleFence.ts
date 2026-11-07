import { tables } from "./groupAccessStore";
/** Separate key namespace: historical sharing operations are not overwritten. */
export const sessionLifecycleKey = (userId: string, sessionId: string) =>
  `lifecycle:${JSON.stringify([userId, sessionId])}`;
export function savedSessionFence(userId: string, sessionId: string) {
  return {
    Put: {
      TableName: tables.operations(),
      Item: {
        recordingSessionRecordId: sessionLifecycleKey(userId, sessionId),
        ownerUserId: userId,
        recordingSessionId: sessionId,
        sessionLifecycleState: "SAVED",
      },
      ConditionExpression:
        "attribute_not_exists(sessionLifecycleState) OR sessionLifecycleState = :saved",
      ExpressionAttributeValues: { ":saved": "SAVED" },
    },
  };
}
export function discardSessionFence(userId: string, sessionId: string) {
  return {
    Put: {
      TableName: tables.operations(),
      Item: {
        recordingSessionRecordId: sessionLifecycleKey(userId, sessionId),
        ownerUserId: userId,
        recordingSessionId: sessionId,
        sessionLifecycleState: "DISCARDING",
      },
      ConditionExpression:
        "attribute_not_exists(sessionLifecycleState) OR sessionLifecycleState = :discarding",
      ExpressionAttributeValues: { ":discarding": "DISCARDING" },
    },
  };
}
