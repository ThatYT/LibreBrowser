/** UI strings only; visited page content is never translated or rewritten here. */
const zh = typeof location !== 'undefined' && new URLSearchParams(location.search).get('lang') === 'zh';
export const tr = (en: string, cn: string): string => zh ? cn : en;
export const connectionLabel = (state: string): string => {
  const labels: Record<string, string> = {open:'已连接',closed:'已断开',connecting:'连接中'};
  const english: Record<string, string> = {open:'Connected',closed:'Disconnected',connecting:'Connecting…'};
  return zh ? labels[state] ?? state : english[state] ?? state;
};
if (typeof document !== 'undefined') document.documentElement.lang = zh ? 'zh-CN' : 'en';
