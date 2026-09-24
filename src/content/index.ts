// Content Script：响应后台 ping，提取并回传正文（更准确）
import { extractReadableFromDom } from '../core/extract';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'PING_EXTRACT') {
    try {
      const { text, cover, description, title } = extractReadableFromDom(
        document.documentElement.outerHTML,
        location.href,
      );
      sendResponse({
        ok: true,
        data: {
          id: msg.id,
          text,
          cover,
          description,
          title,
        },
      });
    } catch (e: any) {
      sendResponse({ ok: false, error: e?.message ?? String(e) });
    }
    return true;
  }
  return false;
});
