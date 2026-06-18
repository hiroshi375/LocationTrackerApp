import { defineStorage } from "@aws-amplify/backend";

export const storage = defineStorage({
    name: "locationTrackerStorage",
    access: (allow) => ({
        "profile-icons/{entity_id}/*": [
            allow.entity("identity").to(["read", "write", "delete"]),
            allow.authenticated.to(["read"]),
        ],
    }),
});
