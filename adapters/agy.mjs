import { historyManaged, listManaged, send as sendManaged, waitIdle as waitIdleManaged } from './agy-managed.mjs';
import { historyNative, listNative, sendNative, waitNative } from './agy-native.mjs';

export { close, lookupBridge, resume, savedSession, start } from './agy-managed.mjs';
export { confirmNativeTui, lookupNative, recordNativeHook, recordNativeStatus } from './agy-native.mjs';

export async function list() {
  const [managed, native] = await Promise.all([listManaged(), listNative()]);
  return [...managed, ...native];
}

export function history(session, limit) {
  return session._agy === 'managed' ? historyManaged(session, limit) : historyNative(session, limit);
}

export function send(session, text, options) {
  return session._agy === 'managed' ? sendManaged(session, text) : sendNative(session, text, options);
}

export function waitIdle(session, timeoutMs) {
  return session._agy === 'managed' ? waitIdleManaged(session, timeoutMs) : waitNative(session, timeoutMs);
}
