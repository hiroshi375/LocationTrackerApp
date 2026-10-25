import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';

// Use the exact outputs bundled by the app, without making network requests.
const outputs = JSON.parse(readFileSync(new URL('../amplify_outputs.json', import.meta.url), 'utf8'));
const backend = readFileSync(new URL('../amplify/data/resource.ts', import.meta.url), 'utf8');
const required = [...backend.matchAll(/\b(\w+)\s*:\s*a\s*\.\s*(mutation|query)\s*\(/g)]
  .map(([, name, kind]) => ({ name, kind: kind === 'mutation' ? 'mutations' : 'queries' }));
assert.ok(required.some(({ name }) => name === 'discardRecordingSession'), 'Discard API must be checked');
Amplify.configure(outputs);
const client = generateClient();
for (const { name, kind } of required) {
  assert.equal(typeof client[kind]?.[name], 'function', `Release client is missing ${kind}.${name}`);
}
console.log(`Release client: ${required.length} custom operations available; no network requests made.`);
