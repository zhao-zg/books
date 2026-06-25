const BASES = [
  'https://books.07170501.xyz',
  'https://books.1189.dpdns.org'
];

export default {
  async fetch(request) {
    for (const base of BASES) {
      try {
        const res = await fetch(base + 'version.json', { cf: { cacheEverything: false } });
        if (!res.ok) continue;
        const { apk_file } = await res.json();
        if (!apk_file) continue;
        return Response.redirect(base + apk_file, 302); // 302 临时重定向
      } catch (_) {
        continue;
      }
    }
    // 兜底：返回 ASSET_URL
    return Response.redirect('__ASSET_URL__', 302);
  },
};
