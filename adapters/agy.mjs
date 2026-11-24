import { historyManaged, listManaged } from './agy-managed.mjs';
import { historyNative, listNative } from './agy-native.mjs';

export { close, lookupBridge, resume, savedSession, send, start, waitIdle } from './agy-managed.mjs';
export { confirmNativeTui, lookupNative, recordNativeStatus } from './agy-native.mjs';

export async function list() {
  const [managed, native] = await Promise.all([listManaged(), listNative()]);
  return [...managed, ...native];
}

export function history(session, limit) {
  return session._agy === 'managed' ? historyManaged(session, limit) : historyNative(session, limit);
}
