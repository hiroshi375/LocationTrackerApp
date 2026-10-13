import { defineStorage } from "@aws-amplify/backend";

export const storage = defineStorage({
    name: "locationTrackerStorage",
    access: (allow) => ({
        "profile-icons/{entity_id}/*": [
            allow.entity("identity").to(["read", "write", "delete"]),
            allow.authenticated.to(["read"]),
            // Adminsグループ所属ユーザーにも読み取りを許可
            allow.groups(["Admins"]).to(["read"]),
        ],
    }),
});
