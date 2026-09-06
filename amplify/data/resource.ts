import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { shareGroupApi } from "../functions/share-group-api/resource";
/*== STEP 1 ===============================================================
The section below creates a Todo database table with a "content" field. Try
adding a new "isDone" field as a boolean. The authorization rule below
specifies that any unauthenticated user can "create", "read", "update",
and "delete" any "Todo" records.
=========================================================================*/
const schema = a
    .schema({
        LocationLog: a
            .model({
                userId: a.string().required(),
                latitude: a.float().required(),
                longitude: a.float().required(),
                accuracy: a.float(),
                recordedAt: a.datetime().required(),
                memo: a.string(),
                recordingSessionId: a.string(),
                recordingSessionName: a.string(),
                sharedOwners: a.string().array(),

                batteryLevel: a.float(),
                batteryState: a.string(),
                lowPowerMode: a.boolean(),

                source: a.string(),
                // 同一セッション・同一時刻・同一座標・同一精度の重複防止用
                locationUniqueKey: a.string(),

                activityType: a.string(),
                isAggregationTarget: a.boolean(),
            })
            .secondaryIndexes((index) => [
                /*
                 * recordingSessionIdごとのLocationLogを
                 * recordedAt順にQueryできるようにする。
                 *
                 * 「地図で表示」などで全LocationLogをfilterする必要がなくなる。
                 */
                index("recordingSessionId")
                    .sortKeys(["recordedAt"])
                    .queryField("listLocationLogsBySessionAndRecordedAt"),
            ])
            .authorization((allow) => [
                allow.owner(),
                allow.ownersDefinedIn("sharedOwners").to(["read"]),
            ]),
        RecordingSession: a
            .model({
                recordingSessionId: a.string().required(),
                userId: a.string().required(),

                recordingSessionName: a.string(),

                startedAt: a.datetime().required(),
                endedAt: a.datetime().required(),

                distanceMeters: a.float().required(),
                pointCount: a.integer().required(),

                startBatteryLevel: a.float(),
                endBatteryLevel: a.float(),

                sharedOwners: a.string().array(),
                recordingIntervalMs: a.integer(),
                recordingDistanceMeters: a.float(),

                lastContinuationConfirmedAt: a.datetime(),
                continuationConfirmationCount: a.integer(),
                autoStoppedAt: a.datetime(),
                autoStopReason: a.string(),

                activityType: a.string(),
                isAggregationTarget: a.boolean(),
                classificationSource: a.string(),
                classificationReason: a.string(),
                averageSpeedKmh: a.float(),
                maxSpeedKmh: a.float(),
                movingDurationSeconds: a.integer(),
                monthKey: a.string(),
            })
            .secondaryIndexes((index) => [
                index("userId")
                    .sortKeys(["endedAt"])
                    .queryField("listRecordingSessionsByUserAndEndedAt"),
            ])
            .authorization((allow) => [
                allow.owner(),
                allow.ownersDefinedIn("sharedOwners").to(["read"]),
            ]),
        UserProfile: a
            .model({
                userId: a.string().required(),
                email: a.email(),
                displayName: a.string(),
                ownerValue: a.string(),
                searchText: a.string(),
                iconImagePath: a.string(),
                role: a.string(),

                totalAggregationDistanceMeters: a.float(),
                totalAggregationDurationSeconds: a.integer(),
                totalAggregationSessionCount: a.integer(),
                currentMonthKey: a.string(),
                currentMonthDistanceMeters: a.float(),
                currentMonthDurationSeconds: a.integer(),
                currentMonthSessionCount: a.integer(),
                subscriptionUsageMonthKey: a.string(),
                currentMonthRecordedActivityCount: a.integer(),
            })
            .secondaryIndexes((index) => [
                index("userId").queryField("listUserProfilesByUserId"),
            ])
            .authorization((allow) => [
                allow.owner(),
                allow.authenticated().to(["read"]),
            ]),
        UserActivityMonthlySummary: a
            .model({
                userId: a.string().required(),
                monthKey: a.string().required(),
                distanceMeters: a.float().required(),
                durationSeconds: a.integer().required(),
                sessionCount: a.integer().required(),
                displayName: a.string(),
                iconImagePath: a.string(),
            })
            .secondaryIndexes((index) => [
                index("monthKey")
                    .sortKeys(["distanceMeters"])
                    .queryField("listMonthlyActivityRanking"),
                index("userId")
                    .sortKeys(["monthKey"])
                    .queryField("listMonthlyActivitySummariesByUser"),
            ])
            .authorization((allow) => [
                allow.owner(),
                allow.authenticated().to(["read"]),
            ]),
        LiveLocation: a
            .model({
                userId: a.string().required(),

                /*
                 * 自動記録していない位置共有ではnullになるため、
                 * required()を付けない。
                 */
                recordingSessionId: a.string(),

                /*
                 * true:
                 *   自動記録中。現在地とPolylineを表示する。
                 *
                 * false:
                 *   現在地共有のみ。現在地マーカーだけを表示する。
                 */
                isRecording: a.boolean().required(),

                latitude: a.float().required(),
                longitude: a.float().required(),
                accuracy: a.float(),

                updatedAt: a.datetime().required(),
                isActive: a.boolean().required(),

                sharedOwners: a.string().array(),
            })
            .authorization((allow) => [
                allow.owner(),
                allow.ownersDefinedIn("sharedOwners").to(["read"]),
            ]),
        ShareGroup: a
            .model({
                /*
                 * グループを一意に識別するID。
                 * UUID等をアプリ側／Function側で生成する。
                 */
                groupId: a.id().required(),

                /*
                 * 画面表示用グループ名。
                 * 例: 家族、ランニング仲間
                 */
                name: a.string().required(),

                /*
                 * グループ作成者のCognito user sub。
                 *
                 * ownerDefinedIn()でも使用する。
                 */
                ownerUserId: a.string().required(),

                /*
                 * 招待コードそのものではなく、
                 * SHA-256した値を保存する。
                 */
                inviteCodeHash: a.string().required(),

                /*
                 * falseにすればグループを無効化できる。
                 */
                isActive: a.boolean().required(),
            })
            .identifier(["groupId"])
            .secondaryIndexes((index) => [
                /*
                 * 自分が作成したグループを取得する。
                 */
                index("ownerUserId").queryField("listShareGroupsByOwner"),

                /*
                 * 招待コードから対象グループを検索する。
                 *
                 * 実際の検索はLambda Functionからのみ行う。
                 */
                index("inviteCodeHash").queryField(
                    "listShareGroupsByInviteCodeHash",
                ),
            ])
            .authorization((allow) => [
                /*
                 * 通常のクライアントから直接扱えるのは
                 * グループ作成者だけ。
                 */
                allow.ownerDefinedIn("ownerUserId"),
            ]),
        ShareGroupMember: a
            .model({
                /*
                 * groupId + userId から作る一意キー。
                 *
                 * 例:
                 *   <groupId>#<userId>
                 *
                 * 同じユーザーが同じグループに
                 * 二重参加することを防止する。
                 */
                membershipId: a.string().required(),

                groupId: a.id().required(),

                /*
                 * Cognito user sub。
                 */
                userId: a.string().required(),

                /*
                 * LocationLog / RecordingSession / LiveLocation の
                 * sharedOwnersにそのまま利用できる値。
                 */
                ownerValue: a.string().required(),

                /*
                 * 共有先一覧を表示するときに
                 * UserProfile全件取得をしなくて済むよう、
                 * メンバー追加時のプロフィール情報を保持する。
                 */
                displayName: a.string(),
                email: a.email(),
                iconImagePath: a.string(),

                /*
                 * OWNER / MEMBER
                 */
                role: a.enum(["OWNER", "MEMBER"]),

                joinedAt: a.datetime().required(),
            })
            .identifier(["membershipId"])
            .secondaryIndexes((index) => [
                /*
                 * ログインユーザーが所属している
                 * グループをQueryする。
                 */
                index("userId")
                    .sortKeys(["joinedAt"])
                    .queryField("listShareGroupMembershipsByUser"),

                /*
                 * 特定グループのメンバー一覧をQueryする。
                 *
                 * Function側で利用する。
                 */
                index("groupId")
                    .sortKeys(["joinedAt"])
                    .queryField("listShareGroupMembersByGroup"),
            ])
            .authorization((allow) => [
                /*
                 * 通常クライアントからは
                 * 自分自身のMembershipだけ読める。
                 *
                 * create/update/deleteはFunction経由に限定する。
                 */
                allow.ownerDefinedIn("userId").to(["read"]),
            ]),
        ShareGroupActionResult: a.customType({
            success: a.boolean().required(),
            message: a.string().required(),

            groupId: a.id(),
            groupName: a.string(),

            /*
             * グループ作成時・招待コード再発行時のみ返す。
             */
            inviteCode: a.string(),
        }),
        ShareCandidate: a.customType({
            userId: a.string().required(),
            ownerValue: a.string().required(),

            displayName: a.string(),
            email: a.email(),
            iconImagePath: a.string(),
        }),
        ShareGroupSummary: a.customType({
            groupId: a.id().required(),
            name: a.string().required(),
            role: a.string().required(),
        }),
        createShareGroupWithInviteCode: a
            .mutation()
            .arguments({
                name: a.string().required(),
            })
            .returns(a.ref("ShareGroupActionResult"))
            .authorization((allow) => [allow.authenticated()])
            .handler(a.handler.function(shareGroupApi)),
        joinShareGroupByInviteCode: a
            .mutation()
            .arguments({
                inviteCode: a.string().required(),
            })
            .returns(a.ref("ShareGroupActionResult"))
            .authorization((allow) => [allow.authenticated()])
            .handler(a.handler.function(shareGroupApi)),

        regenerateShareGroupInviteCode: a
            .mutation()
            .arguments({
                groupId: a.id().required(),
            })
            .returns(a.ref("ShareGroupActionResult"))
            .authorization((allow) => [allow.authenticated()])
            .handler(a.handler.function(shareGroupApi)),

        listMyShareCandidates: a
            .query()
            .returns(a.ref("ShareCandidate").array())
            .authorization((allow) => [allow.authenticated()])
            .handler(a.handler.function(shareGroupApi)),
        listMyShareGroups: a
            .query()
            .returns(a.ref("ShareGroupSummary").array())
            .authorization((allow) => [allow.authenticated()])
            .handler(a.handler.function(shareGroupApi)),
        BackgroundLocationDebugLog: a
            .model({
                userId: a.string().required(),
                recordingSessionId: a.string(),
                eventName: a.string().required(),

                loggedAt: a.datetime().required(),

                taskFiredAt: a.datetime(),
                locationsLength: a.integer(),
                saveSuccessCount: a.integer(),
                saveFailureCount: a.integer(),

                skippedCount: a.integer(),
                invalidCoordinateSkippedCount: a.integer(),
                lowAccuracySkippedCount: a.integer(),
                abnormalSpeedSkippedCount: a.integer(),
                inProgressDuplicateSkippedCount: a.integer(),
                exactDuplicateSkippedCount: a.integer(),
                nearDuplicateSkippedCount: a.integer(),
                saveConditionSkippedCount: a.integer(),

                hasStartedLocationUpdates: a.boolean(),

                foregroundPermissionStatus: a.string(),
                foregroundPermissionGranted: a.boolean(),
                foregroundPermissionCanAskAgain: a.boolean(),

                backgroundPermissionStatus: a.string(),
                backgroundPermissionGranted: a.boolean(),
                backgroundPermissionCanAskAgain: a.boolean(),

                errorMessage: a.string(),

                detailsJson: a.string(),
            })
            .authorization((allow) => [allow.owner()]),
    })
    .authorization((allow) => [allow.resource(shareGroupApi)]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
    schema,
    authorizationModes: {
        defaultAuthorizationMode: "userPool",
    },
});

/*== STEP 2 ===============================================================
Go to your frontend source code. From your client-side code, generate a
Data client to make CRUDL requests to your table. (THIS SNIPPET WILL ONLY
WORK IN THE FRONTEND CODE FILE.)

Using JavaScript or Next.js React Server Components, Middleware, Server
Actions or Pages Router? Review how to generate Data clients for those use
cases: https://docs.amplify.aws/gen2/build-a-backend/data/connect-to-API/
=========================================================================*/

/*
"use client"
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>() // use this Data client for CRUDL requests
*/

/*== STEP 3 ===============================================================
Fetch records from the database and use them in your frontend component.
(THIS SNIPPET WILL ONLY WORK IN THE FRONTEND CODE FILE.)
=========================================================================*/

/* For example, in a React component, you can use this snippet in your
  function's RETURN statement */
// const { data: todos } = await client.models.Todo.list()

// return <ul>{todos.map(todo => <li key={todo.id}>{todo.content}</li>)}</ul>
