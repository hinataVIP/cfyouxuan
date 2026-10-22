const DATA_KEY = "cfyouxuan:data:v1";
const SOURCES = [
  { name: "UOUIN", url: "https://bestcf.tools12345.com/uouin/all.txt", categories: ["电信", "联通", "移动", "多线"] },
  { name: "WeTest", url: "https://bestcf.tools12345.com/wetest/ipv4.txt", categories: ["电信", "联通", "移动"] },
  { name: "CFYes", url: "https://bestcf.tools12345.com/cfyes/ipv4.txt", categories: ["电信", "联通", "移动"] },
];
const CATEGORIES = ["电信", "联通", "移动", "多线"];
const MINIMUMS = { "电信": 8, "联通": 8, "移动": 8, "多线": 1 };
const MAX_PER_SOURCE_CATEGORY = 5;
const FETCH_TIMEOUT_MS = 15000;

function response(body, status = 200, contentType = "text/plain; charset=utf-8") {
  return new Response(body, { status, headers: { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
function json(data, status = 200) { return response(JSON.stringify(data, null, 2), status, "application/json; charset=utf-8"); }
function validIPv4(ip) {
  const parts = ip.split(".");
  return parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255 && String(Number(p)) === p);
}
function getIP(line) {
  const m = line.match(/(?:^|[^\d])((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?(?!\d)/);
  if (!m || !validIPv4(m[1])) return null;
  if (m[2] && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return null;
  return { ip: m[1], port: m[2] ? Number(m[2]) : null };
}
function classify(line, allowed) {
  if (allowed.includes("多线") && line.includes("多线")) return "多线";
  for (const c of ["电信", "联通", "移动"]) if (allowed.includes(c) && line.includes(c)) return c;
  return null;
}
function parseSource(source, body) {
  const out = Object.fromEntries(CATEGORIES.map(c => [c, []]));
  const seen = Object.fromEntries(CATEGORIES.map(c => [c, new Set()]));
  for (const raw of body.split(/\n/)) {
    const line = raw.trim().replace(/\r/g, "");
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const category = classify(line, source.categories);
    if (!category) continue;
    const endpoint = getIP(line);
    if (!endpoint || seen[category].has(endpoint.ip) || out[category].length >= MAX_PER_SOURCE_CATEGORY) continue;
    seen[category].add(endpoint.ip);
    out[category].push(line);
  }
  if (!CATEGORIES.some(c => out[c].length)) throw new Error(`${source.name}: 未解析到带分类标签的有效 IPv4 数据`);
  return out;
}
async function fetchSource(source) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(source.url, {
      headers: { accept: "text/plain, text/*;q=0.9, */*;q=0.5", "user-agent": "cfyouxuan-worker/1.0" },
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!res.ok) throw new Error(`${source.name}: HTTP ${res.status}`);
    const body = await res.text();
    if (!body.trim()) throw new Error(`${source.name}: 返回内容为空`);
    return parseSource(source, body);
  } finally { clearTimeout(timeout); }
}
function merge(parsed) {
  const categories = Object.fromEntries(CATEGORIES.map(c => [c, []]));
  for (const sourceData of parsed) {
    for (const category of CATEGORIES) {
      const seen = new Set(categories[category].map(line => getIP(line)?.ip).filter(Boolean));
      for (const line of sourceData[category] || []) {
        const ip = getIP(line)?.ip;
        if (!ip || seen.has(ip)) continue;
        seen.add(ip);
        categories[category].push(line);
      }
    }
  }
  for (const category of CATEGORIES) {
    if (categories[category].length < MINIMUMS[category]) {
      throw new Error(`${category}数量不足：至少需要 ${MINIMUMS[category]} 个，实际 ${categories[category].length} 个`);
    }
  }
  const all = [];
  const seenAll = new Set();
  for (const category of CATEGORIES) for (const line of categories[category]) {
    const ip = getIP(line)?.ip;
    if (ip && !seenAll.has(ip)) { seenAll.add(ip); all.push(line); }
  }
  return { version: 1, updatedAt: new Date().toISOString(), categories, all,
    counts: { "电信": categories["电信"].length, "联通": categories["联通"].length, "移动": categories["移动"].length, "多线": categories["多线"].length, "全部": all.length } };
}
async function createSnapshot() {
  // All sources must fetch and parse successfully; failures never replace the old KV snapshot.
  return merge(await Promise.all(SOURCES.map(fetchSource)));
}
function sameContent(a, b) {
  return !!a?.categories && CATEGORIES.every(c => {
    const x = a.categories[c] || [], y = b.categories[c] || [];
    return x.length === y.length && x.every((line, i) => line === y[i]);
  });
}
async function refresh(env) {
  if (!env.CF_IP_DATA) throw new Error("KV 绑定 CF_IP_DATA 未配置");
  const candidate = await createSnapshot();
  const previous = await env.CF_IP_DATA.get(DATA_KEY, "json");
  if (sameContent(previous, candidate)) return { updated: false, message: "内容无变化，未写入 KV", counts: candidate.counts, previousUpdatedAt: previous.updatedAt || null };
  await env.CF_IP_DATA.put(DATA_KEY, JSON.stringify(candidate));
  return { updated: true, message: "KV 已更新", updatedAt: candidate.updatedAt, counts: candidate.counts };
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function getRoute(pathname, token) {
  if (!token || typeof token !== "string") return null;
  const prefix = `/${token}/`;
  return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : null;
}
function rowsFor(snapshot, file) {
  if (file === "a.txt") return snapshot.categories["电信"] || [];
  if (file === "b.txt") return snapshot.categories["联通"] || [];
  if (file === "c.txt") return snapshot.categories["移动"] || [];
  if (file === "d.txt") return snapshot.categories["多线"] || [];
  if (file === "e.txt") return snapshot.all || [];
  return null;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") return json({ service: "cfyouxuan", status: "ok", note: "订阅路径请妥善保管。", endpoints: env.SUB_PATH_TOKEN ? ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"].map(f => `/${env.SUB_PATH_TOKEN}/${f}`) : [] });
    const route = getRoute(url.pathname, env.SUB_PATH_TOKEN);
    if (route === null) return response("Not Found", 404);
    if (route === "r") {
      if (request.method !== "POST") return response("Method Not Allowed", 405);
      if (!env.UPDATE_SECRET) return json({ ok: false, error: "UPDATE_SECRET 未配置" }, 503);
      const auth = request.headers.get("authorization") || "";
      const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!safeEqual(supplied, env.UPDATE_SECRET)) return json({ ok: false, error: "Unauthorized" }, 401);
      try { return json({ ok: true, ...(await refresh(env)) }); }
      catch (e) { return json({ ok: false, error: e instanceof Error ? e.message : String(e), message: "更新失败，旧 KV 数据未被覆盖。" }, 502); }
    }
    if (request.method !== "GET" && request.method !== "HEAD") return response("Method Not Allowed", 405);
    const file = route.split("?")[0];
    if (!["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"].includes(file)) return response("Not Found", 404);
    try {
      const snapshot = await env.CF_IP_DATA.get(DATA_KEY, "json");
      if (!snapshot) return response("尚无订阅数据。请等待 Cron 或调用受保护的手动更新接口。", 503);
      const list = rowsFor(snapshot, file);
      const body = list.join("\n") + (list.length ? "\n" : "");
      return request.method === "HEAD" ? new Response(null, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } }) : response(body);
    } catch (e) { return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500); }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refresh(env).catch(error => { console.error("cfyouxuan scheduled refresh failed:", error); }));
  },
};
