import { AsyncLocalStorage } from "node:async_hooks";
import { evaluateVerification, verificationDigest, type VerificationSubject, type VerificationScope, type VerificationSnapshot } from "./harness-verification.js";
const storage = new AsyncLocalStorage<{snapshot?: VerificationSnapshot; scope: VerificationScope | null; subject?: VerificationSubject}>();
export const currentVerificationContext = () => storage.getStore();
export function withVerificationContext<T>(snapshot: VerificationSnapshot | undefined, callback: () => T, scope: VerificationScope | null = null, subject?: VerificationSubject): T {
  return storage.run({snapshot, scope, subject}, callback);
}
export function bindVerificationScope(scope: VerificationScope | null): void { const current = storage.getStore(); if (current) current.scope = scope; }
export function currentVerificationResult() { const current = storage.getStore(); return evaluateVerification(current?.subject && current.snapshot && verificationDigest(current.subject) !== verificationDigest(current.snapshot.subject) ? undefined : current?.snapshot, current?.scope ?? null); }
