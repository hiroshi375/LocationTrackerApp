import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { deviceSessionApi } from "../functions/device-session-api/resource";
import { shareGroupApi } from "../functions/share-group-api/resource";
import { liveLocationApi } from "../functions/live-location-api/resource";

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
                // Creation goes through ingestLocationLog. Indexed identity is immutable.
                userId: a.string().required().authorization(allow => [
                    allow.owner().to(["read"]),
                    allow.ownersDefinedIn("sharedOwners").to(["read"]),
                ]),
                latitude: a.float().required(),
                longitude: a.float().required(),
                accuracy: a.float(),
                recordedAt: a.datetime().required(),
                memo: a.string(),
                recordingSessionId: a.string().authorization(allow => [
                    allow.owner().to(["read"]),
                    allow.ownersDefinedIn("sharedOwners").to(["read"]),
                ]),
                recordingSessionName: a.string(),
                sharedOwners: a
                    .string()
                    .array()
                    .authorization((allow) => [
                        // 記録所有者は読み取りのみ可能。
                        // 作成・更新時の共有先指定はバックエンドに限定する。
                        allow.owner().to(["read"]),

                        // 既存の共有相手からの読み取りを維持
                        allow.ownersDefinedIn("sharedOwners").to(["read"]),
                    ]),

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
                // フィールド認可があるモデルでは固定IDも作成許可を明示する。
                // sharedOwnersの書き込み権限は付与しない。
                id: a.id().required().authorization((allow) => [
                    allow.owner(),
                    allow.ownersDefinedIn("sharedOwners").to(["read"]),
                ]),
                recordingSessionId: a.string().required(),
                userId: a.string().required(),

                recordingSessionName: a.string(),

                startedAt: a.datetime().required(),
                endedAt: a.datetime().required(),

                distanceMeters: a.float().required(),
                pointCount: a.integer().required(),

                startBatteryLevel: a.float(),
                endBatteryLevel: a.float(),

                sharedOwners: a
                    .string()
                    .array()
                    .authorization((allow) => [
                        // 記録所有者は読み取りのみ可能。
                        // 作成・更新時の共有先指定はバックエンドに限定する。
                        allow.owner().to(["read"]),

                        // 既存の共有相手からの読み取りを維持
                        allow.ownersDefinedIn("sharedOwners").to(["read"]),
                    ]),
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
        UserDeviceSession: a
            .model({
                /*
                 * Cognito user sub。
                 * 1ユーザーにつき1レコード。
                 */
                userId: a.string().required(),

                /*
                 * 現在ログインを許可している端末ID。
                 */
                activeDeviceId: a.string().required(),

                /*
                 * この端末を有効化した日時。
                 */
                lastLoginAt: a.datetime().required(),

                /*
                 * 最後に有効端末チェックを行った日時。
                 */
                lastCheckedAt: a.datetime(),
            })
            .identifier(["userId"])
            .authorization((allow) => [allow.ownerDefinedIn("userId")]),
        UserProfile: a
            .model({
                userId: a.string().required(),
                email: a.email(),
                displayName: a.string(),
                ownerValue: a.string(),
                searchText: a.string(),
                iconImagePath: a.string(),
                role: a.string(),
                // 消費カロリー推定用の体重（kg）
                weightKg: a.float(),
                /*
                 * 利用規約・プライバシーポリシーへの同意情報。
                 *
                 * acceptedAt:
                 *   初回同意日時。
                 *
                 * version:
                 *   同意した文書のバージョン。
                 *   将来、重要な規約改定時に再同意を求める場合にも利用できる。
                 */
                termsAcceptedAt: a.datetime(),
                termsVersion: a.string(),
                privacyPolicyAcceptedAt: a.datetime(),
                privacyPolicyVersion: a.string(),
                totalAggregationDistanceMeters: a.float(),
                totalAggregationDurationSeconds: a.integer(),
                totalAggregationSessionCount: a.integer(),
                currentMonthKey: a.string(),
                currentMonthDistanceMeters: a.float(),
                currentMonthDurationSeconds: a.integer(),
                currentMonthSessionCount: a.integer(),
                subscriptionUsageMonthKey: a.string(),
                currentMonthRecordedActivityCount: a.integer(),
                appVersion: a.string(),
                appBuildVersion: a.integer(),
                lastAppPlatform: a.string(),
                lastAppOpenedAt: a.datetime(),
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
        UserActivityWeeklySummary: a
            .model({
                userId: a.string().required(),
                weekKey: a.string().required(),

                distanceMeters: a.float().required(),
                durationSeconds: a.integer().required(),
                sessionCount: a.integer().required(),

                displayName: a.string(),
                iconImagePath: a.string(),
            })
            .secondaryIndexes((index) => [
                index("weekKey")
                    .sortKeys(["distanceMeters"])
                    .queryField("listWeeklyActivityRanking"),

                index("userId")
                    .sortKeys(["weekKey"])
                    .queryField("listWeeklyActivitySummariesByUser"),
            ])
            .authorization((allow) => [
                allow.owner(),
                allow.authenticated().to(["read"]),
            ]),
        LiveLocation: a
            .model({
                userId: a.string().required(),
                recordingSessionId: a.string(),
                isRecording: a.boolean().required(),
                lastStoppedRecordingSessionId: a.string(),
                latitude: a.float().required(),
                longitude: a.float().required(),
                accuracy: a.float(),
                updatedAt: a.datetime().required(),
                isActive: a.boolean().required(),
                sharedOwners: a.string().array(),
                shareRevision: a.integer(),
                shareEnabled: a.boolean(),
            })
            .authorization((allow) => [
                allow.owner().to(["read"]),
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
                lifecycle: a.string(),

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
                 * 作成者は参照のみ可能。
                 * 変更・削除は正式なFunction API経由に限定する。
                 */
                allow.ownerDefinedIn("ownerUserId").to(["read"]),
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

        HistoricalShareGrant: a
            .model({
                // 一意キー：セッション主キー + グループ + 共有先ユーザー
                grantId: a.string().required(),

                // RecordingSessionのDynamoDB主キー
                recordingSessionRecordId: a.id().required(),

                // Cognito sub
                ownerUserId: a.string().required(),

                // 共有元グループ
                groupId: a.id().required(),

                // 共有先のCognito sub
                recipientUserId: a.string().required(),

                // AppSync sharedOwnersに設定する識別子
                recipientOwnerValue: a.string().required(),

                // true=有効、false=失効
                isActive: a.boolean().required(),

                grantedAt: a.datetime().required(),
                revokedAt: a.datetime(),
            })
            .identifier(["grantId"])
            .secondaryIndexes((index) => [
                index("recordingSessionRecordId").queryField(
                    "listHistoricalGrantsBySession",
                ),

                index("groupId").queryField("listHistoricalGrantsByGroup"),
            ])
            .authorization((allow) => [
                // 所有者による参照のみ許可。
                // クライアントからの作成・変更・削除は禁止。
                allow.ownerDefinedIn("ownerUserId").to(["read"]),
            ]),

        LocationLogWriteResult: a.customType({
            id: a.id().required(),
            created: a.boolean().required(),
        }),
        ShareGroupActionResult: a.customType({
            success: a.boolean().required(),
            message: a.string().required(),
            accepted: a.boolean(),
            operationId: a.string(),
            status: a.string(),
            phase: a.string(),
            completedSessionCount: a.integer(),
            canCancel: a.boolean(),

            groupId: a.id(),
            groupName: a.string(),

            /*
             * グループ作成時・招待コード再発行時のみ返す。
             */
            inviteCode: a.string(),
        }),
        DeviceSessionResult: a.customType({
            success: a.boolean().required(),
            isActive: a.boolean().required(),
            message: a.string().required(),
        }),
        /**
         * Phase ⑦-1
         * 履歴共有先一覧の1件分。
         */
        HistoricalShareRecipient: a.customType({
            grantId: a.string().required(),
            groupId: a.id().required(),
            recipientUserId: a.string().required(),
            isActive: a.boolean().required(),
            grantedAt: a.datetime().required(),
            revokedAt: a.datetime(),
        }),
        ShareCandidate: a.customType({
            userId: a.string().required(),
            ownerValue: a.string().required(),

            displayName: a.string(),
            email: a.email(),
            iconImagePath: a.string(),
        }),
        ShareGroupMemberSummary: a.customType({
            userId: a.string().required(),
            displayName: a.string(),
            iconImagePath: a.string(),
            role: a.string().required(),
        }),

        ShareGroupSummary: a.customType({
            groupId: a.id().required(),
            name: a.string().required(),
            lifecycle: a.string(),
            operationId: a.string(),
            role: a.string().required(),
            /*
             * このグループに所属しているメンバー。
             */
            members: a.ref("ShareGroupMemberSummary").array(),
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

        discardRecordingSession: a.mutation()
            .arguments({ recordingSessionId: a.string().required() })
            .returns(a.boolean())
            .authorization(allow => [allow.authenticated()])
            .handler(a.handler.function(shareGroupApi)),
        ingestLocationLog: a.mutation()
            .arguments({ input: a.json().required() })
            .returns(a.ref("LocationLogWriteResult"))
            .authorization(allow => [allow.authenticated()])
            .handler(a.handler.function(shareGroupApi)),
        leaveShareGroup: a.mutation()
            .arguments({ groupId: a.id().required(), requestId: a.string().required() })
            .returns(a.ref("ShareGroupActionResult"))
            .authorization(allow => [allow.authenticated()])
            .handler(a.handler.function(shareGroupApi)),
        removeShareGroupMember: a.mutation()
            .arguments({ groupId: a.id().required(), targetUserId: a.string().required(), requestId: a.string().required() })
            .returns(a.ref("ShareGroupActionResult"))
            .authorization(allow => [allow.authenticated()])
            .handler(a.handler.function(shareGroupApi)),
        deactivateOwnedShareGroup: a.mutation()
            .arguments({ groupId: a.id().required(), requestId: a.string().required() })
            .returns(a.ref("ShareGroupActionResult"))
            .authorization(allow => [allow.authenticated()])
            .handler(a.handler.function(shareGroupApi)),
        listMyShareGroupAccessOperations: a.query()
            .returns(a.ref("ShareGroupActionResult").array())
            .authorization(allow => [allow.authenticated()])
            .handler(a.handler.function(shareGroupApi)),
        getShareGroupAccessOperation: a.query()
            .arguments({ groupId: a.id().required(), operationId: a.string().required() })
            .returns(a.ref("ShareGroupActionResult"))
            .authorization(allow => [allow.authenticated()])
            .handler(a.handler.function(shareGroupApi)),
        resumeShareGroupAccessOperation: a.mutation()
            .arguments({ groupId: a.id().required(), operationId: a.string().required() })
            .returns(a.ref("ShareGroupActionResult"))
            .authorization(allow => [allow.authenticated()])
            .handler(a.handler.function(shareGroupApi)),
        cancelShareGroupAccessOperation: a.mutation()
            .arguments({ groupId: a.id().required(), operationId: a.string().required() })
            .returns(a.ref("ShareGroupActionResult"))
            .authorization(allow => [allow.authenticated()])
            .handler(a.handler.function(shareGroupApi)),
        deleteOwnedShareGroup: a
            .mutation()
            .arguments({
                groupId: a.id().required(),
                requestId: a.string(),
            })
            .returns(a.ref("ShareGroupActionResult"))
            .authorization((allow) => [allow.authenticated()])
            .handler(a.handler.function(shareGroupApi)),

        shareHistoricalRecordingSession: a
            .mutation()
            .arguments({
                recordingSessionId: a.string().required(),
                groupId: a.id().required(),
                recipientUserIds: a.string().array().required(),
            })
            .returns(a.boolean())
            .authorization((allow) => [allow.authenticated()])
            .handler(a.handler.function(shareGroupApi)),

        AccountDeletionProgress: a.customType({
            completed: a.boolean().required(),
            phase: a.string().required(),
        }),
        deleteCurrentAccountData: a.mutation()
            .returns(a.ref("AccountDeletionProgress"))
            .authorization((allow) => [allow.authenticated()])
            .handler(a.handler.function(shareGroupApi)),

        setHistoricalShareGrant: a
            .mutation()
            .arguments({
                recordingSessionId: a.string().required(),
                groupId: a.id().required(),
                recipientUserId: a.string().required(),
                enabled: a.boolean().required(),
            })
            .returns(a.boolean())
            .authorization((allow) => [allow.authenticated()])
            .handler(a.handler.function(shareGroupApi)),

        /**
         * Phase ⑦-1
         * 指定セッションの共有Grant一覧を取得する。
         *
         * Cognito認証必須。
         * Lambda内で所有者本人であることを検証する。
         *
         * GrantやsharedOwnersは変更しない。
         */
        resumeHistoricalShareOperation: a
            .mutation()
            .arguments({ recordingSessionId: a.string().required() })
            .returns(a.boolean())
            .authorization((allow) => [allow.authenticated()])
            .handler(a.handler.function(shareGroupApi)),

        listHistoricalShareRecipients: a
            .query()
            .arguments({
                recordingSessionId: a.string().required(),
            })
            .returns(a.ref("HistoricalShareRecipient").array().required())
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
        activateMyDeviceSession: a
            .mutation()
            .arguments({
                deviceId: a.string().required(),
            })
            .returns(a.ref("DeviceSessionResult"))
            .authorization((allow) => [allow.authenticated()])
            .handler(a.handler.function(deviceSessionApi)),

        checkMyDeviceSession: a
            .query()
            .arguments({
                deviceId: a.string().required(),
            })
            .returns(a.ref("DeviceSessionResult"))
            .authorization((allow) => [allow.authenticated()])
            .handler(a.handler.function(deviceSessionApi)),

        releaseMyDeviceSession: a
            .mutation()
            .arguments({
                deviceId: a.string().required(),
            })
            .returns(a.ref("DeviceSessionResult"))
            .authorization((allow) => [allow.authenticated()])
            .handler(a.handler.function(deviceSessionApi)),
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

        LiveLocationSharingState: a.customType({
            revision: a.integer().required(),
            enabled: a.boolean().required(),
            sharedOwners: a.string().array().required(),
        }),

        getLiveLocationSharingState: a
            .query()
            .returns(a.ref("LiveLocationSharingState"))
            .authorization((allow) => [allow.authenticated()])
            .handler(a.handler.function(liveLocationApi)),

        updateLiveLocationCoordinates: a
            .mutation()
            .arguments({
                expectedRevision: a.integer().required(),
                latitude: a.float().required(),
                longitude: a.float().required(),
                accuracy: a.float(),
            })
            .returns(a.boolean())
            .authorization((allow) => [allow.authenticated()])
            .handler(a.handler.function(liveLocationApi)),

        changeLiveLocationSharing: a
            .mutation()
            .arguments({
                expectedRevision: a.integer().required(),
                sharedOwners: a.string().array().required(),
            })
            .returns(a.integer())
            .authorization((allow) => [allow.authenticated()])
            .handler(a.handler.function(liveLocationApi)),

        startLiveLocationRecording: a
            .mutation()
            .arguments({
                expectedRevision: a.integer().required(),
                recordingSessionId: a.string().required(),
            })
            .returns(a.boolean())
            .authorization((allow) => [allow.authenticated()])
            .handler(a.handler.function(liveLocationApi)),

        stopLiveLocationRecording: a
            .mutation()
            .arguments({
                expectedRevision: a.integer().required(),
                expectedRecordingSessionId: a.string().required(),
            })
            .returns(a.boolean())
            .authorization((allow) => [allow.authenticated()])
            .handler(a.handler.function(liveLocationApi)),

        diagnoseHistoricalShareMigrationAdmin: a
            .query()
            .arguments({
                ownerUserId: a.string().required(),
                recordingSessionId: a.string().required(),
            })
            .returns(a.json())
            .authorization((allow) => [allow.group("Admins")])
            .handler(a.handler.function(shareGroupApi)),
        /**
         * ⑥-F-4：旧共有移行の障害・復旧判断用診断。
         * 管理者専用、読み取り専用。
         */
        diagnoseHistoricalShareRecoveryAdmin: a
            .query()
            .arguments({
                ownerUserId: a.string().required(),
                recordingSessionId: a.string().required(),
            })
            .returns(a.json())
            .authorization((allow) => [allow.group("Admins")])
            .handler(a.handler.function(shareGroupApi)),
    })
    .authorization((allow) => [
        allow.resource(shareGroupApi),
        allow.resource(deviceSessionApi),
    ]);

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
