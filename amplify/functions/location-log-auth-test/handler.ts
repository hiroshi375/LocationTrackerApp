import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const db = new DynamoDBClient({});

export const handler = async (event: {
    id: string;
    expectedUserId: string;
    sharedOwners: string[];
}) => {
    const tableName = process.env.AUTH_TEST_TABLE_NAME;

    if (!tableName) {
        throw new Error("AUTH_TEST_TABLE_NAME is missing");
    }

    if (
        !event.id ||
        !event.expectedUserId ||
        !Array.isArray(event.sharedOwners)
    ) {
        throw new Error("Invalid test input");
    }

    await db.send(
        new UpdateItemCommand({
            TableName: tableName,
            Key: {
                id: { S: event.id },
            },
            UpdateExpression: "SET sharedOwners = :owners",
            ConditionExpression: "attribute_exists(id) AND userId = :userId",
            ExpressionAttributeValues: {
                ":owners": {
                    L: event.sharedOwners.map((value) => ({
                        S: value,
                    })),
                },
                ":userId": { S: event.expectedUserId },
            },
        }),
    );

    return {
        success: true,
    };
};
