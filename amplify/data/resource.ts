import { type ClientSchema, a, defineData } from "@aws-amplify/backend";

/*== STEP 1 ===============================================================
The section below creates a Todo database table with a "content" field. Try
adding a new "isDone" field as a boolean. The authorization rule below
specifies that any unauthenticated user can "create", "read", "update",
and "delete" any "Todo" records.
=========================================================================*/
const schema = a.schema({
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
        })
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

            sharedOwners: a.string().array(),
        })
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
        })
        .authorization((allow) => [
            allow.owner(),
            allow.authenticated().to(["read"]),
        ]),
    LiveLocation: a
        .model({
            userId: a.string().required(),
            recordingSessionId: a.string().required(),

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
});

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
