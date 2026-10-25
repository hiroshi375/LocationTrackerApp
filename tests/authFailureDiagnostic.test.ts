import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosedSignIn, readAuthFailureDiagnostics, needsLoginRecoveryHint, LOGIN_RECOVERY_HINT, type AuthFailureEvidence } from '../src/utils/authFailureDiagnostic';
test('success and MFA results, inputs and original errors retain SDK semantics', async () => {
    const input = { username: 'private@example.invalid', password: 'SECRET_PASSWORD' };
    for (const output of [{ isSignedIn: true }, { isSignedIn: false, nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' } }]) {
        const before = readAuthFailureDiagnostics().length;
        assert.equal(await createDiagnosedSignIn(async value => { assert.equal(value, input); return output; })(input), output);
        assert.equal(readAuthFailureDiagnostics().length, before);
    }
    const original = Object.assign(new Error('private email and token'), { name: 'NotAuthorizedException' });
    let saved: AuthFailureEvidence | undefined;
    await assert.rejects(createDiagnosedSignIn(async () => { throw original; }, row => { saved = row; })(input), error => error === original);
    assert.equal(saved?.category, 'authentication');
    assert.equal(needsLoginRecoveryHint(original.message), false);
});
test('storage failure classification omits inputs, raw messages, tokens and coordinates', async () => {
    const original = Object.assign(new Error('An unknown error has occurred.'), {
        name: 'Unknown', underlyingError: new Error('AsyncStorage SQLITE_FULL SECRET_TOKEN email@example.invalid latitude=35.123'),
    });
    const rows: AuthFailureEvidence[] = [];
    await assert.rejects(createDiagnosedSignIn(async () => { throw original; }, row => rows.push(row))({ password: 'PASSWORD' }), error => error === original);
    assert.equal(rows[0].category, 'storage');
    assert.equal(rows[0].underlyingName, 'Error');
    assert.ok(!/SECRET|email@|latitude|PASSWORD|SQLITE_FULL/.test(JSON.stringify(rows)));
    assert.equal(needsLoginRecoveryHint(original.message), true);
    assert.match(LOGIN_RECOVERY_HINT, /停止中/);
    assert.match(LOGIN_RECOVERY_HINT, /データ消去・再インストールは行わない/);
});
test('diagnostics remain bounded and emitter/readback mutation cannot affect stored evidence', async () => {
    const original = Object.assign(new Error('SECRET'), { name: 'untrusted@example.invalid' });
    const wrapped = createDiagnosedSignIn(async () => { throw original; }, row => { row.name = 'mutated'; throw Error('logger failure'); });
    for (let i=0;i<30;i++) await assert.rejects(wrapped(null), error => error === original);
    const rows = readAuthFailureDiagnostics(); assert.equal(rows.length, 20);
    assert.equal(rows[0].name, 'Other'); rows[0].name='modified';
    assert.equal(readAuthFailureDiagnostics()[0].name, 'Other');
});
test('hostile error properties cannot replace the original failure', async () => {
    const original = Object.defineProperty({}, 'name', { get() { throw Error('getter failure'); } });
    await assert.rejects(createDiagnosedSignIn(async () => { throw original; }, () => {})(undefined), error => error === original);
});
