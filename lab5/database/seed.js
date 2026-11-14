const { Pool } = require("pg");

const COUNTRIES_URL =
  "https://restcountries.com/v5/all?fields=cca2,name,capital,currencies,region,flags";
const COUNTRIES_FALLBACK_URL =
  "https://raw.githubusercontent.com/mledoze/countries/master/countries.json";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const BATCH_SIZE = 500;
const MAX_OVERPASS_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 120_000;

const cities = [
  { name: "Минск", countryCode: "BY", lat: 53.9006, lon: 27.559 },
  { name: "Брест", countryCode: "BY", lat: 52.0976, lon: 23.7341 },
  { name: "Гродно", countryCode: "BY", lat: 53.6694, lon: 23.8131 },
  { name: "Москва", countryCode: "RU", lat: 55.7558, lon: 37.6173 },
  { name: "Санкт-Петербург", countryCode: "RU", lat: 59.9311, lon: 30.3609 },
  { name: "Варшава", countryCode: "PL", lat: 52.2297, lon: 21.0122 },
  { name: "Вильнюс", countryCode: "LT", lat: 54.6872, lon: 25.2797 },
  { name: "Рига", countryCode: "LV", lat: 56.9496, lon: 24.1052 },
  { name: "Прага", countryCode: "CZ", lat: 50.0755, lon: 14.4378 },
  { name: "Берлин", countryCode: "DE", lat: 52.52, lon: 13.405 },
  { name: "Рим", countryCode: "IT", lat: 41.9028, lon: 12.4964 },
  { name: "Париж", countryCode: "FR", lat: 48.8566, lon: 2.3522 },
];

const sampleRestaurants = [
  { osmId: -500001, city: "Минск", name: "Учебный ресторан №1 — Минск", lat: 53.9006, lon: 27.559 },
  { osmId: -500002, city: "Минск", name: "Учебный ресторан №2 — Минск", lat: 53.91, lon: 27.55 },
  { osmId: -500003, city: "Минск", name: "Учебный ресторан №3 — Минск", lat: 53.89, lon: 27.57 },
  { osmId: -500004, city: "Минск", name: "Учебный ресторан №4 — Минск", lat: 53.92, lon: 27.58 },
  { osmId: -500005, city: "Минск", name: "Учебный ресторан №5 — Минск", lat: 53.88, lon: 27.54 },
  { osmId: -500006, city: "Минск", name: "Учебный ресторан №6 — Минск", lat: 53.905, lon: 27.59 },
  { osmId: -500007, city: "Брест", name: "Учебный ресторан №7 — Брест", lat: 52.0976, lon: 23.7341 },
  { osmId: -500008, city: "Брест", name: "Учебный ресторан №8 — Брест", lat: 52.1, lon: 23.69 },
  { osmId: -500009, city: "Гродно", name: "Учебный ресторан №9 — Гродно", lat: 53.6694, lon: 23.8131 },
  { osmId: -500010, city: "Гродно", name: "Учебный ресторан №10 — Гродно", lat: 53.68, lon: 23.82 },
];

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://travel_user:travel_password@localhost:5432/travel_aggregator",
});

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchCountries() {
  const headers = process.env.REST_COUNTRIES_API_KEY
    ? { Authorization: `Bearer ${process.env.REST_COUNTRIES_API_KEY}` }
    : {};
  let countries;

  try {
    const response = await fetch(COUNTRIES_URL, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`REST Countries request failed: HTTP ${response.status}`);
    }

    const payload = await response.json();
    countries = Array.isArray(payload) ? payload : payload.data;
    if (!Array.isArray(countries)) {
      throw new Error("REST Countries returned an unexpected response");
    }
  } catch (error) {
    console.warn(
      `REST Countries unavailable (${error.message}); using the public country dataset fallback`,
    );
    const response = await fetch(COUNTRIES_FALLBACK_URL, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Country dataset fallback failed: HTTP ${response.status}`);
    }
    countries = await response.json();
  }

  if (!Array.isArray(countries)) {
    throw new Error("Country data source returned an unexpected response");
  }

  const rows = countries
    .filter((country) => country.cca2 && country.name?.common)
    .map((country) => [
      country.cca2,
      country.name.common,
      country.capital?.[0] ?? null,
      Object.keys(country.currencies ?? {})[0] ?? null,
      country.region ?? null,
      country.flags?.png ?? country.flags?.svg ?? null,
    ]);

  if (rows.length === 0) {
    throw new Error("REST Countries returned no usable country records");
  }

  const values = [];
  const placeholders = rows.map((row) => {
    const offset = values.length;
    values.push(...row);
    return `(${row.map((_, index) => `$${offset + index + 1}`).join(", ")})`;
  });

  await pool.query(
    `INSERT INTO countries (code, name, capital, currency, region, flag_url)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (code) DO NOTHING`,
    values,
  );
  console.log(`Countries processed: ${rows.length}`);
}

async function saveCities() {
  const cityIds = new Map();

  for (const city of cities) {
    const result = await pool.query(
      `INSERT INTO cities (name, country_code, lat, lon)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE
       SET country_code = EXCLUDED.country_code, lat = EXCLUDED.lat, lon = EXCLUDED.lon
       RETURNING id`,
      [city.name, city.countryCode, city.lat, city.lon],
    );
    cityIds.set(city.name, result.rows[0].id);
  }

  return cityIds;
}

async function insertSampleRestaurants(cityIds) {
  const rows = sampleRestaurants.map((place) => [
    place.osmId,
    cityIds.get(place.city),
    place.name,
    "restaurant",
    place.lat,
    place.lon,
    null,
    4.5,
  ]);
  const values = [];
  const placeholders = rows.map((row) => {
    const offset = values.length;
    values.push(...row);
    return `(${row.map((_, index) => `$${offset + index + 1}`).join(", ")})`;
  });

  await pool.query(
    `INSERT INTO places (osm_id, city_id, name, category, lat, lon, address, rating)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (osm_id) DO NOTHING`,
    values,
  );
  console.log(`Sample restaurants available: ${rows.length}`);
}

function createOverpassQuery(city) {
  return `[out:json][timeout:90];
(
  node(around:15000,${city.lat},${city.lon})["tourism"~"^(museum|attraction|hotel|viewpoint)$"];
  node(around:15000,${city.lat},${city.lon})["amenity"~"^(cafe|restaurant|theatre)$"];
);
out body;`;
}

function getRetryDelay(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    const delay = Number.isFinite(seconds) ? seconds * 1000 : dateDelay;
    if (Number.isFinite(delay) && delay > 0) {
      return Math.max(2_000, delay);
    }
  }
  return 2_000 * 2 ** (attempt - 1);
}

async function fetchPlaces(city) {
  for (let attempt = 1; attempt <= MAX_OVERPASS_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: createOverpassQuery(city) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt === MAX_OVERPASS_ATTEMPTS) {
        throw new Error(
          `Overpass request failed for ${city.name} after ${attempt} attempts: ${error.message}`,
          { cause: error },
        );
      }
      const delay = 2_000 * 2 ** (attempt - 1);
      console.warn(
        `Overpass request failed for ${city.name}; retrying in ${delay} ms (${attempt}/${MAX_OVERPASS_ATTEMPTS - 1}): ${error.message}`,
      );
      await sleep(delay);
      continue;
    }

    if (response.ok) {
      const data = await response.json();
      if (!Array.isArray(data.elements)) {
        throw new Error(`Overpass returned an invalid response for ${city.name}`);
      }
      return data.elements;
    }

    if (
      ![429, 504].includes(response.status) ||
      attempt === MAX_OVERPASS_ATTEMPTS
    ) {
      throw new Error(
        `Overpass request failed for ${city.name}: HTTP ${response.status}`,
      );
    }

    const delay = getRetryDelay(response, attempt);
    console.warn(
      `Overpass returned HTTP ${response.status} for ${city.name}; retrying in ${delay} ms (${attempt}/${MAX_OVERPASS_ATTEMPTS - 1})`,
    );
    await sleep(delay);
  }

  throw new Error(`Overpass request failed for ${city.name}`);
}

function getAddress(tags) {
  const parts = [
    tags["addr:street"],
    tags["addr:housenumber"],
    tags["addr:city"],
    tags["addr:postcode"],
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

async function insertPlaces(cityId, elements) {
  const rows = elements
    .filter((element) => element.tags?.name?.trim())
    .map((element) => {
      const tags = element.tags;
      return [
        element.id,
        cityId,
        tags.name.trim(),
        tags.tourism ?? tags.amenity,
        element.lat,
        element.lon,
        getAddress(tags),
        Number((3.5 + Math.random() * 1.5).toFixed(2)),
      ];
    })
    .filter(
      (row) =>
        Number.isSafeInteger(row[0]) &&
        Number.isFinite(row[4]) &&
        Number.isFinite(row[5]),
    );

  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    const values = [];
    const placeholders = batch.map((row) => {
      const offset = values.length;
      values.push(...row);
      return `(${row.map((_, index) => `$${offset + index + 1}`).join(", ")})`;
    });

    await pool.query(
      `INSERT INTO places (osm_id, city_id, name, category, lat, lon, address, rating)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (osm_id) DO NOTHING`,
      values,
    );
  }

  return rows.length;
}

async function main() {
  await fetchCountries();
  const cityIds = await saveCities();
  await insertSampleRestaurants(cityIds);
  let processedPlaces = 0;

  if (process.env.SEED_OVERPASS === "false") {
    console.log("Skipping Overpass import because SEED_OVERPASS=false");
  } else {
    for (const [index, city] of cities.entries()) {
      console.log(`Fetching places for ${city.name} (${index + 1}/${cities.length})`);
      try {
        const elements = await fetchPlaces(city);
        const inserted = await insertPlaces(cityIds.get(city.name), elements);
        processedPlaces += inserted;
        console.log(`  Named places found: ${inserted}`);
      } catch (error) {
        console.warn(
          `  Skipping ${city.name}; sample data remains available: ${error.message}`,
        );
      }

      if (index < cities.length - 1) {
        await sleep(2_000);
      }
    }
  }

  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM places");
  const total = rows[0].count;
  console.log(`Places processed this run: ${processedPlaces}`);
  console.log(`Total places in database: ${total}`);

  if (total < 10_000) {
    console.warn(
      `The database currently contains fewer than 10,000 places (${total}). The script reports the real count and does not fabricate records.`,
    );
  }
}

main()
  .catch((error) => {
    console.error("Seeding failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
