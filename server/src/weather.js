// Clima gratis con Open-Meteo (no requiere API key)
const CODES = {
  0: 'despejado', 1: 'mayormente despejado', 2: 'parcialmente nublado', 3: 'nublado',
  45: 'niebla', 48: 'niebla con escarcha', 51: 'llovizna ligera', 53: 'llovizna', 55: 'llovizna intensa',
  61: 'lluvia ligera', 63: 'lluvia', 65: 'lluvia fuerte', 71: 'nieve ligera', 73: 'nieve', 75: 'nieve fuerte',
  80: 'chubascos ligeros', 81: 'chubascos', 82: 'chubascos fuertes', 95: 'tormenta', 96: 'tormenta con granizo', 99: 'tormenta fuerte con granizo',
};

export async function getWeather(city) {
  const geo = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?count=1&language=es&name=${encodeURIComponent(city)}`,
    { signal: AbortSignal.timeout(10_000) }
  ).then((r) => r.json());
  const place = geo.results?.[0];
  if (!place) return { error: `No encontré la ciudad "${city}"` };

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&forecast_days=3&timezone=auto';
  const w = await fetch(url, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json());

  return {
    place: `${place.name}, ${place.country}`,
    now: {
      temp_c: w.current?.temperature_2m,
      feels_like_c: w.current?.apparent_temperature,
      humidity: w.current?.relative_humidity_2m,
      wind_kmh: w.current?.wind_speed_10m,
      sky: CODES[w.current?.weather_code] ?? 'desconocido',
    },
    days: (w.daily?.time || []).map((d, i) => ({
      date: d,
      max_c: w.daily.temperature_2m_max[i],
      min_c: w.daily.temperature_2m_min[i],
      rain_prob: w.daily.precipitation_probability_max[i],
      sky: CODES[w.daily.weather_code[i]] ?? '',
    })),
  };
}
