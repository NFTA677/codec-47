// Búsquedas rápidas sin API key: YouTube (para poner música) y Wikipedia (datos y cultura general)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Devuelve el primer video de YouTube para una búsqueda
export async function findYouTube(query) {
  const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) + '&sp=EgIQAQ%253D%253D'; // solo videos
  const html = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'es-419,es;q=0.9' },
    signal: AbortSignal.timeout(10_000),
  }).then((r) => r.text());
  const m = html.match(/"videoRenderer":\{"videoId":"([\w-]{11})"[\s\S]{0,1500}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/);
  const id = m?.[1] || html.match(/"videoId":"([\w-]{11})"/)?.[1];
  if (!id) return null;
  let title = m?.[2] || query;
  try {
    title = JSON.parse(`"${title}"`);
  } catch {}
  return { videoId: id, title, url: `https://www.youtube.com/watch?v=${id}` };
}

// Resumen de Wikipedia en español (o inglés si no hay)
export async function wikipedia(query) {
  for (const lang of ['es', 'en']) {
    const s = await fetch(
      `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': 'CODEC47/1.0' }, signal: AbortSignal.timeout(8000) }
    ).then((r) => r.json());
    const hit = s.query?.search?.[0];
    if (!hit) continue;
    const sum = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title)}`, {
      headers: { 'User-Agent': 'CODEC47/1.0' },
      signal: AbortSignal.timeout(8000),
    }).then((r) => r.json());
    return {
      title: sum.title,
      summary: sum.extract,
      also: s.query.search.slice(1).map((x) => x.title),
      source: sum.content_urls?.desktop?.page,
    };
  }
  return { error: 'No encontré información sobre eso' };
}
