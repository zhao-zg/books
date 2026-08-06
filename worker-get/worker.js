// ── 主镜像源（账户1） ──
const BASES = [
  'https://books.07170501.xyz',
  'https://books.1189.dpdns.org'
];

// ── 备用镜像源（账户2，待配置域名后启用） ──
const FALLBACK_BASES = [
  // 'https://books2.example.com',
];

// 合并所有镜像源，主源优先，备用源兜底
const ALL_BASES = [...BASES, ...FALLBACK_BASES];

export default {
  async fetch(request) {
    for (const base of ALL_BASES) {
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
