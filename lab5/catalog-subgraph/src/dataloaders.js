const DataLoader = require("dataloader");

function toNumericId(id) {
  const parsed = Number(id);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function createLoaders(pool) {
  const countryByCodeLoader = new DataLoader(async (codes) => {
    const result = await pool.query(
      `SELECT code, name, capital, currency, region, flag_url AS "flagUrl"
       FROM countries
       WHERE code = ANY($1::varchar[])`,
      [codes],
    );
    const countries = new Map(result.rows.map((country) => [country.code, country]));
    return codes.map((code) => countries.get(code) ?? null);
  });

  const citiesByCountryLoader = new DataLoader(async (codes) => {
    const result = await pool.query(
      `SELECT id, name, country_code AS "countryCode", lat, lon
       FROM cities
       WHERE country_code = ANY($1::varchar[])
       ORDER BY name`,
      [codes],
    );
    const citiesByCode = new Map(codes.map((code) => [code, []]));
    for (const city of result.rows) {
      citiesByCode.get(city.countryCode)?.push(city);
    }
    return codes.map((code) => citiesByCode.get(code) ?? []);
  });

  const cityByIdLoader = new DataLoader(async (ids) => {
    const validIds = ids.map(toNumericId).filter((id) => id !== null);
    const result =
      validIds.length === 0
        ? { rows: [] }
        : await pool.query(
            `SELECT id, name, country_code AS "countryCode", lat, lon
             FROM cities
             WHERE id = ANY($1::int[])`,
            [validIds],
          );
    const citiesById = new Map(result.rows.map((city) => [city.id, city]));
    return ids.map((id) => citiesById.get(toNumericId(id)) ?? null);
  });

  const placeByIdLoader = new DataLoader(async (ids) => {
    const validIds = ids.map(toNumericId).filter((id) => id !== null);
    const result =
      validIds.length === 0
        ? { rows: [] }
        : await pool.query(
            `SELECT id, osm_id::text AS "osmId", city_id AS "cityId", name,
                    category, lat, lon, address, rating
             FROM places
             WHERE id = ANY($1::int[])`,
            [validIds],
          );
    const placesById = new Map(result.rows.map((place) => [place.id, place]));
    return ids.map((id) => placesById.get(toNumericId(id)) ?? null);
  });

  const placesByCityLoader = new DataLoader(
    async (keys) => {
      if (keys.length === 0) {
        return [];
      }

      const values = [];
      const requestedRows = keys.map((key, index) => {
        const offset = values.length;
        values.push(index, toNumericId(key.cityId), key.limit, key.offset);
        return `($${offset + 1}::int, $${offset + 2}::int, $${offset + 3}::int, $${offset + 4}::int)`;
      });

      const [pageResult, countResult] = await Promise.all([
        pool.query(
          `WITH requested(request_id, city_id, page_limit, page_offset) AS (
             VALUES ${requestedRows.join(", ")}
           ),
           ranked AS (
             SELECT requested.request_id,
                    p.id, p.osm_id::text AS "osmId",
                    p.city_id AS "cityId", p.name, p.category,
                    p.lat, p.lon, p.address, p.rating,
                    ROW_NUMBER() OVER (
                      PARTITION BY requested.request_id
                      ORDER BY p.name ASC, p.id ASC
                    ) AS row_number
             FROM requested
             JOIN places p ON p.city_id = requested.city_id
           )
           SELECT request_id AS "requestId", id, "osmId", "cityId",
                  name, category, lat, lon, address, rating
           FROM ranked
           JOIN requested USING (request_id)
           WHERE row_number > requested.page_offset
             AND row_number <= requested.page_offset + requested.page_limit
           ORDER BY request_id, row_number`,
          values,
        ),
        pool.query(
          `SELECT city_id AS "cityId", COUNT(*)::int AS count
           FROM places
           WHERE city_id = ANY($1::int[])
           GROUP BY city_id`,
          [[...new Set(keys.map((key) => toNumericId(key.cityId)).filter(Boolean))]],
        ),
      ]);

      const itemsByRequest = keys.map(() => []);
      for (const row of pageResult.rows) {
        itemsByRequest[row.requestId].push({
          id: row.id,
          osmId: row.osmId,
          cityId: row.cityId,
          name: row.name,
          category: row.category,
          lat: row.lat,
          lon: row.lon,
          address: row.address,
          rating: row.rating,
        });
      }

      const countsByCity = new Map(
        countResult.rows.map((row) => [row.cityId, row.count]),
      );
      return keys.map((key, index) => {
        const items = itemsByRequest[index];
        const totalCount = countsByCity.get(toNumericId(key.cityId)) ?? 0;
        return {
          items,
          totalCount,
          hasMore: key.offset + items.length < totalCount,
        };
      });
    },
    {
      cacheKeyFn: (key) => `${key.cityId}:${key.limit}:${key.offset}`,
    },
  );

  return {
    citiesByCountryLoader,
    placesByCityLoader,
    cityByIdLoader,
    countryByCodeLoader,
    placeByIdLoader,
  };
}

module.exports = { createLoaders, toNumericId };
