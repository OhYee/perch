import { setTimeout as sleep } from 'node:timers/promises';

const sameMessage = (a, b) => a?.role === b?.role && a?.text === b?.text;

export async function followConversation({ read, id, title, lang, style, quote, multiline }) {
  const out = process.stdout;
  const tr = (en, zh) => lang === 'zh' ? zh : en;
  const print = (text, ink) => out.write((ink ? style(text, ink) : text) + '\n');
  let previous = null, closed = false;
  const onClose = () => { closed = true; };
  out.on('close', onClose);
  try {
    if (typeof title === 'string' && title.trim()) print(`${tr('Title', '标题')}: ${quote(title)}`, 1);
    print(`ID: ${quote(id)}`, 36);
    while (!closed) {
      const result = await read();
      if (closed) break;
      if (!Array.isArray(result) || result.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string')) {
        throw Error(tr('Invalid conversation history', '会话历史无效'));
      }
      const current = result.slice(-20).map(({ role, text }) => ({ role, text }));
      if (previous === null) print('[as-ready]', 2);
      let offset = 0, best = 0;
      if (previous) {
        for (let i = 0; i < previous.length; i++) {
          let matches = 0;
          for (let j = 0; j < current.length && i + j < previous.length; j++) {
            if (sameMessage(previous[i + j], current[j])) matches++;
          }
          if (matches > best) { best = matches; offset = i; }
        }
      }
      const old = previous ?? [];
      const changed = current.filter((message, i) => !sameMessage(message, old[offset + i]));
      const removed = previous && offset + current.length < old.length;
      if (previous && (removed || current.some((message, i) => i < old.length - offset && !sameMessage(message, old[offset + i])))) {
        print(tr('Conversation updated:', '会话已更新：'), 2);
      }
      for (const { role, text } of changed) {
        print(`${style(`[${role === 'user' ? tr('user', '用户') : tr('assistant', '助手')}]`, 36)} ${multiline(text)}`);
      }
      if (!current.length && (previous === null || previous.length)) print(tr('No chat messages yet.', '暂无聊天消息。'), 2);
      previous = current;
      if (!closed) await sleep(1000);
    }
  } finally {
    out.off('close', onClose);
  }
}
