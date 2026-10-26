/** Authentication failure evidence only. Diagnostic records never retain login inputs/tokens. */
const MAX_FAILURES = 20;
const NAMES = new Set([
    'Error', 'TypeError', 'SyntaxError', 'Unknown', 'UnknownException',
    'NotAuthorizedException', 'UserNotFoundException', 'UserNotConfirmedException',
    'UserAlreadyAuthenticatedException', 'PasswordResetRequiredException',
    'CodeMismatchException', 'ExpiredCodeException', 'NetworkError', 'TimeoutError',
    'AbortError', 'QuotaExceededError', 'SQLiteException', 'SQLiteFullException',
    'SQLiteBlobTooBigException', 'UnexpectedSignInInterruptionException',
]);
export type AuthFailureEvidence = {
    attempt: number;
    at: string;
    elapsedMs: number;
    name: string;
    underlyingName: string;
    category: 'storage' | 'network' | 'authentication' | 'unknown';
};
const failures: AuthFailureEvidence[] = [];
let attempt = 0;
function field(value: unknown, key: string): unknown {
    try { return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined; }
    catch { return undefined; }
}
function safeName(value: unknown): string {
    const name = field(value, 'name');
    return typeof name === 'string' && NAMES.has(name) ? name : 'Other';
}
function category(error: unknown): AuthFailureEvidence['category'] {
    for (let i = 0; i < 3 && error; i++) {
        const name = safeName(error);
        const raw = field(error, 'message');
        // Inspect a bounded message for classification; never retain or print it.
        const message = typeof raw === 'string' ? raw.slice(0, 512) : '';
        if (/SQLite|QuotaExceeded/.test(name) || /CursorWindow|database (?:or disk is full|is locked)|SQLITE_|AsyncStorage/i.test(message)) return 'storage';
        if (/Network|Timeout|Abort/.test(name)) return 'network';
        if (/NotAuthorized|UserNotFound|UserNotConfirmed|PasswordResetRequired|CodeMismatch|ExpiredCode/.test(name)) return 'authentication';
        error = field(error, 'underlyingError') ?? field(error, 'cause');
    }
    return 'unknown';
}
export function readAuthFailureDiagnostics(): AuthFailureEvidence[] {
    return failures.map(value => ({ ...value }));
}
/** Preserve the SDK's result and original exception, including MFA and service errors. */
export function createDiagnosedSignIn<Input, Output>(
    signIn: (input: Input) => Promise<Output>,
    emit: (record: AuthFailureEvidence) => void = record => console.warn('[AUTH_SIGN_IN_FAILURE]', record),
): (input: Input) => Promise<Output> {
    return async input => {
        const currentAttempt = ++attempt;
        const startedAt = Date.now();
        try { return await signIn(input); }
        catch (error) {
            try {
                const underlying = field(error, 'underlyingError') ?? field(error, 'cause');
                const evidence: AuthFailureEvidence = {
                    attempt: currentAttempt, at: new Date().toISOString(),
                    elapsedMs: Math.max(0, Date.now() - startedAt),
                    name: safeName(error), underlyingName: safeName(underlying),
                    category: category(error),
                };
                failures.push(evidence);
                if (failures.length > MAX_FAILURES) failures.shift();
                emit({ ...evidence });
            } catch { /* Diagnostic failure must not replace the authentication error. */ }
            throw error;
        }
    };
}
export function needsLoginRecoveryHint(error: unknown): boolean {
    return typeof error === 'string' && error.includes('An unknown error has occurred.');
}
export const LOGIN_RECOVERY_HINT = '記録・共有が停止中なら、アプリを終了して開き直し、再度ログインしてください。動作中・状態不明の場合は終了せずお問い合わせください。データ消去・再インストールは行わないでください。';
