const { toNumericId } = require("./dataloaders");

const PLACE_COLUMNS = `p.id, p.osm_id::text AS "osmId",
  p.city_id AS "cityId", p.name, p.category, p.lat, p.lon, p.address, p.rating`;

function buildPlaceConditions(filter = {}) {
  const values = [];
  const conditions = [];
  const addCondition = (sql, value) => {
    values.push(value);
    conditions.push(sql.replace("?", `$${values.length}`));
  };

  if (filter.cityId != null) {
    const cityId = toNumericId(filter.cityId);
    if (cityId === null) {
      conditions.push("FALSE");
    } else {
      addCondition("p.city_id = ?", cityId);
    }
  }
  if (filter.countryCode) {
    addCondition(
      "EXISTS (SELECT 1 FROM cities c WHERE c.id = p.city_id AND c.country_code = ?)",
      filter.countryCode,
    );
  }
  if (filter.category) {
    addCondition("p.category = ?", filter.category);
  }
  if (filter.minRating != null) {
    addCondition("p.rating >= ?", filter.minRating);
  }
  if (filter.search?.trim()) {
    addCondition("p.name ILIKE ?", `%${filter.search.trim()}%`);
  }

  return {
    values,
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
  };
}

function normalizePageValue(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

async function getPlaceCount(pool, where, values) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM places p ${where}`,
    values,
  );
  return result.rows[0].count;
}

function createResolvers(pool) {
  return {
    Country: {
      __resolveReference: (reference, { loaders }) =>
        loaders.countryByCodeLoader.load(reference.code),
      cities: (country, _args, { loaders }) =>
        loaders.citiesByCountryLoader.load(country.code),
    },
    City: {
      __resolveReference: (reference, { loaders }) =>
        loaders.cityByIdLoader.load(reference.id),
      country: (city, _args, { loaders }) =>
        loaders.countryByCodeLoader.load(city.countryCode),
      places: (city, { limit = 10, offset = 0 }, { loaders }) =>
        loaders.placesByCityLoader.load({
          cityId: city.id,
          limit: normalizePageValue(limit, 10),
          offset: normalizePageValue(offset, 0),
        }),
    },
    Place: {
      __resolveReference: (reference, { loaders }) =>
        loaders.placeByIdLoader.load(reference.id),
      city: (place, _args, { loaders }) =>
        loaders.cityByIdLoader.load(place.cityId),
    },
    Query: {
      countries: async () => {
        const result = await pool.query(
          `SELECT code, name, capital, currency, region, flag_url AS "flagUrl"
           FROM countries
           ORDER BY name`,
        );
        return result.rows;
      },
      cities: async (_parent, { countryCode }) => {
        const result = countryCode
          ? await pool.query(
              `SELECT id, name, country_code AS "countryCode", lat, lon
               FROM cities
               WHERE country_code = $1
               ORDER BY name`,
              [countryCode],
            )
          : await pool.query(
              `SELECT id, name, country_code AS "countryCode", lat, lon
               FROM cities
               ORDER BY name`,
            );
        return result.rows;
      },
      places: async (
        _parent,
        { filter, sortBy = "RATING", sortOrder = "DESC", limit = 20, offset = 0 },
      ) => {
        const pageLimit = normalizePageValue(limit, 20);
        const pageOffset = normalizePageValue(offset, 0);
        const { where, values } = buildPlaceConditions(filter);
        const sortColumn = sortBy === "NAME" ? "p.name" : "p.rating";
        const direction = sortOrder === "ASC" ? "ASC" : "DESC";
        const queryValues = [...values, pageLimit, pageOffset];
        const limitPlaceholder = `$${queryValues.length - 1}`;
        const offsetPlaceholder = `$${queryValues.length}`;
        const result = await pool.query(
          `SELECT ${PLACE_COLUMNS}, COUNT(*) OVER() AS "totalCount"
           FROM places p
           ${where}
           ORDER BY ${sortColumn} ${direction}, p.id ASC
           LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
          queryValues,
        );
        const totalCount =
          result.rows.length > 0
            ? Number(result.rows[0].totalCount)
            : await getPlaceCount(pool, where, values);
        const items = result.rows.map(({ totalCount: _count, ...place }) => place);

        return {
          items,
          totalCount,
          hasMore: pageOffset + items.length < totalCount,
        };
      },
      place: (_parent, { id }, { loaders }) =>
        loaders.placeByIdLoader.load(id),
    },
  };
}

module.exports = { createResolvers };
