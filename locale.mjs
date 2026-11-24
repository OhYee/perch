// POSIX locale names (zh_CN.UTF-8) and BCP 47 tags (zh-CN) share a language prefix.
function supportedLanguage(locale) {
  return /^(zh|en)(?:[-_][a-z0-9]+)*(?:\.[a-z0-9-]+)?(?:@[a-z0-9-]+)?$/i.exec(locale)?.[1].toLowerCase();
}

export function systemLanguage(env = process.env) {
  return supportedLanguage(env.LC_ALL || env.LC_MESSAGES || env.LANG || '') ?? 'en';
}

export function parseLanguage(argv, env = process.env) {
  let lang = systemLanguage(env);
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { args.push(...argv.slice(i)); break; }
    if (arg === '--lang' || arg.startsWith('--lang=')) {
      const value = arg === '--lang' ? argv[++i] : arg.slice(7);
      const selected = supportedLanguage(value);
      if (!selected) throw Error(lang === 'zh' ? '--lang 仅支持 zh 或 en' : '--lang expects zh or en');
      lang = selected;
    } else args.push(arg);
  }
  return { lang, args };
}
