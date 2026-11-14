const Redis = require("ioredis");

const CACHE_TTL_SECONDS = 1_800;
const REQUEST_TIMEOUT_MS = 3_000;
const redis = new Redis(
  process.env.REDIS_URL ?? "redis://localhost:6379",
  {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 100, 1_000),
  },
);

redis.on("error", (error) => {
  console.warn("Redis cache is unavailable:", error.message);
});

async function readCache(key) {
  try {
    const value = await redis.get(key);
    if (value === null) {
      return { found: false, value: null };
    }
    return { found: true, value: JSON.parse(value) };
  } catch (error) {
    console.warn(`Could not read Redis key "${key}":`, error.message);
    return { found: false, value: null };
  }
}

async function writeCache(key, value, ttlSeconds) {
  try {
    const serialized = JSON.stringify(value);
    if (ttlSeconds > 0) {
      await redis.set(key, serialized, "EX", ttlSeconds);
    } else {
      await redis.set(key, serialized);
    }
    return true;
  } catch (error) {
    console.warn(`Could not write Redis key "${key}":`, error.message);
    return false;
  }
}

async function fetchWithCacheAndFallback(
  cacheKey,
  ttlSeconds,
  fetchFn,
  fallbackValue = null,
) {
  const cached = await readCache(cacheKey);
  if (cached.found) {
    return cached.value;
  }

  const backupKey = `backup:${cacheKey}`;
  const controller = new AbortController();
  let timeout;

  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`External request timed out after ${REQUEST_TIMEOUT_MS} ms`));
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
    });

    const result = await Promise.race([
      fetchFn(controller.signal),
      timeoutPromise,
    ]);

    if (result === null || result === undefined) {
      return fallbackValue;
    }

    await Promise.all([
      writeCache(cacheKey, result, ttlSeconds),
      writeCache(backupKey, result, 0),
    ]);
    return result;
  } catch (error) {
    console.warn(`External data request failed for "${cacheKey}":`, error.message);
    const backup = await readCache(backupKey);
    return backup.found ? backup.value : fallbackValue;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, signal, headers) {
  const response = await fetch(url, { signal, headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return response.json();
}

async function getCityWeather(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  const cacheKey = `weather:${lat.toFixed(4)}:${lon.toFixed(4)}`;
  return fetchWithCacheAndFallback(cacheKey, CACHE_TTL_SECONDS, async (signal) => {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current: "temperature_2m,wind_speed_10m,weather_code,is_day",
    }).toString();
    const data = await fetchJson(url, signal);
    const current = data.current;

    if (
      !current ||
      !Number.isFinite(current.temperature_2m) ||
      !Number.isFinite(current.wind_speed_10m) ||
      !Number.isInteger(current.weather_code) ||
      !Number.isInteger(current.is_day)
    ) {
      throw new Error("Open-Meteo response has no valid current weather");
    }

    return {
      temperature: current.temperature_2m,
      windSpeed: current.wind_speed_10m,
      weatherCode: current.weather_code,
      isDay: current.is_day === 1,
    };
  });
}

async function getPlaceWikiSummary(placeName) {
  const title = placeName?.trim();
  if (!title) {
    return null;
  }

  const cacheKey = `wiki:${encodeURIComponent(title.toLocaleLowerCase())}`;
  return fetchWithCacheAndFallback(cacheKey, CACHE_TTL_SECONDS, async (signal) => {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const response = await fetch(url, {
      signal,
      headers: { "User-Agent": "TravelAggregatorLab/1.0" },
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
    }

    const data = await response.json();
    if (!data.title || !data.extract) {
      throw new Error("Wikimedia response has no article summary");
    }

    return {
      title: data.title,
      extract: data.extract,
      thumbnailUrl: data.thumbnail?.source ?? null,
      pageUrl: data.content_urls?.desktop?.page ?? null,
    };
  });
}

async function getNbrbRates() {
  return fetchWithCacheAndFallback(
    "nbrb:rates",
    CACHE_TTL_SECONDS,
    async (signal) => {
      const data = await fetchJson(
        "https://api.nbrb.by/exrates/rates?periodicity=0",
        signal,
      );
      if (!Array.isArray(data)) {
        throw new Error("NBRB response is not a list of exchange rates");
      }

      const supportedCurrencies = new Set(["USD", "EUR", "RUB", "PLN"]);
      return data
        .filter((rate) => supportedCurrencies.has(rate.Cur_Abbreviation))
        .map((rate) => ({
          currencyCode: rate.Cur_Abbreviation,
          scale: rate.Cur_Scale,
          name: rate.Cur_Name,
          rateToByn: rate.Cur_OfficialRate,
        }));
    },
    [],
  );
}

async function closeRedis() {
  if (redis.status === "ready") {
    await redis.quit();
    return;
  }
  redis.disconnect();
}

module.exports = {
  closeRedis,
  fetchWithCacheAndFallback,
  getCityWeather,
  getNbrbRates,
  getPlaceWikiSummary,
};
