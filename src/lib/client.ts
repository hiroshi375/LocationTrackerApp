import { generateClient } from "aws-amplify/data";
import "./amplifyConfig";

export const client = generateClient<any>();
