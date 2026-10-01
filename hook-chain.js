// Shared metadata for these cooperating wrappers only. Unknown third-party
// wrappers remain opaque and are always forwarded to with their receiver intact.
const CHAIN = Symbol.for('hyedam.request-injection.hook-chain.v1');

export function hasHookOwner(fn, owner) {
    return Array.isArray(fn?.[CHAIN]) && fn[CHAIN].includes(owner);
}

export function markHookOwner(wrapped, original, owner) {
    const inherited = Array.isArray(original?.[CHAIN]) ? original[CHAIN] : [];
    Object.defineProperty(wrapped, CHAIN, {
        value: Object.freeze([...inherited, owner]), enumerable: false,
    });
    return wrapped;
}
