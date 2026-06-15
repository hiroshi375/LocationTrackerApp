import { fetchUserAttributes, getCurrentUser } from "aws-amplify/auth";

import { client } from "../lib/client";

export async function ensureUserProfile() {
    const user = await getCurrentUser();
    const attributes = await fetchUserAttributes();

    const email = attributes.email ?? user.signInDetails?.loginId ?? "";
    const displayName = attributes.name ?? email ?? user.username ?? "ユーザー";

    const searchText = `${displayName} ${email}`.toLowerCase();

    const existingResult = await client.models.UserProfile.list({
        filter: {
            userId: {
                eq: user.userId,
            },
        },
        limit: 1,
    });

    if (existingResult.errors) {
        console.error("UserProfile list errors:", existingResult.errors);
        return;
    }

    const existingData = existingResult.data ?? [];
    const existing = Array.isArray(existingData)
        ? existingData[0]
        : existingData;

    if (existing) {
        const nextData: any = {
            id: existing.id,
            email,
            displayName,
            searchText,
        };

        if (!existing.ownerValue && existing.owner) {
            nextData.ownerValue = existing.owner;
        }

        const updateResult = await client.models.UserProfile.update(nextData);

        if (updateResult.errors) {
            console.error("UserProfile update errors:", updateResult.errors);
        }

        return;
    }

    const createResult = await client.models.UserProfile.create({
        userId: user.userId,
        email,
        displayName,
        searchText,
    });

    if (createResult.errors) {
        console.error("UserProfile create errors:", createResult.errors);
        return;
    }

    const created = Array.isArray(createResult.data)
        ? createResult.data[0]
        : createResult.data;

    if (created?.id && created?.owner) {
        const updateResult = await client.models.UserProfile.update({
            id: created.id,
            ownerValue: created.owner,
        });

        if (updateResult.errors) {
            console.error(
                "UserProfile ownerValue update errors:",
                updateResult.errors,
            );
        }
    }
}
