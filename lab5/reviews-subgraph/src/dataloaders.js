const DataLoader = require("dataloader");

function toDatabaseId(id) {
  const parsed = Number(id);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function createLoaders(pool) {
  const reviewsByPlaceLoader = new DataLoader(async (placeIds) => {
    const ids = placeIds.map(toDatabaseId);
    const validIds = ids.filter((id) => id !== null);
    const result =
      validIds.length === 0
        ? { rows: [] }
        : await pool.query(
            `SELECT id, place_id AS "placeId", author, rating, comment,
                    created_at AS "createdAt",
                    COUNT(*) OVER (PARTITION BY place_id)::int AS count
             FROM reviews
             WHERE place_id = ANY($1::int[])
             ORDER BY place_id, created_at DESC, id DESC`,
            [validIds],
          );

    const reviewsByPlace = new Map(
      ids.filter((id) => id !== null).map((id) => [id, { reviews: [], count: 0 }]),
    );
    for (const row of result.rows) {
      const place = reviewsByPlace.get(row.placeId);
      if (place) {
        place.count = row.count;
        place.reviews.push(row);
      }
    }

    return ids.map((id) => reviewsByPlace.get(id) ?? { reviews: [], count: 0 });
  });

  return { reviewsByPlaceLoader };
}

module.exports = { createLoaders, toDatabaseId };
