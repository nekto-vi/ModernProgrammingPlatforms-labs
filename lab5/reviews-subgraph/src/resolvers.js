const { GraphQLError } = require("graphql");
const { toDatabaseId } = require("./dataloaders");

const REVIEW_ADDED_TOPIC = "reviewAdded";
const reviewTopic = (placeId) => `${REVIEW_ADDED_TOPIC}:${placeId}`;

function formatReview(row) {
  return {
    id: String(row.id),
    placeId: String(row.placeId),
    author: row.author,
    rating: row.rating,
    comment: row.comment,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : new Date(row.createdAt).toISOString(),
  };
}

function badInput(message) {
  return new GraphQLError(message, {
    extensions: { code: "BAD_USER_INPUT" },
  });
}

function createResolvers(pool, pubsub) {
  return {
    Place: {
      __resolveReference: (reference) => reference,
      reviews: async (place, _args, { loaders }) => {
        const result = await loaders.reviewsByPlaceLoader.load(place.id);
        return result.reviews.map(formatReview);
      },
      reviewsCount: async (place, _args, { loaders }) => {
        const result = await loaders.reviewsByPlaceLoader.load(place.id);
        return result.count;
      },
    },
    Mutation: {
      addReview: async (_parent, { input }) => {
        const author = input.author.trim();
        const comment = input.comment.trim();
        if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
          throw badInput("Rating must be an integer from 1 to 5");
        }
        if (!author) {
          throw badInput("Author must not be empty");
        }
        if (!comment) {
          throw badInput("Comment must not be empty");
        }

        const placeId = toDatabaseId(input.placeId);
        if (placeId === null) {
          throw badInput("Place ID must be a positive integer");
        }

        const client = await pool.connect();
        let review;
        try {
          await client.query("BEGIN");
          const placeResult = await client.query(
            "SELECT id FROM places WHERE id = $1 FOR UPDATE",
            [placeId],
          );
          if (placeResult.rowCount === 0) {
            throw new GraphQLError("Place not found", {
              extensions: { code: "NOT_FOUND" },
            });
          }

          const result = await client.query(
            `INSERT INTO reviews (place_id, author, rating, comment)
             VALUES ($1, $2, $3, $4)
             RETURNING id, place_id AS "placeId", author, rating, comment,
                       created_at AS "createdAt"`,
            [placeId, author, input.rating, comment],
          );
          await client.query(
            `UPDATE places
             SET rating = (SELECT AVG(rating) FROM reviews WHERE place_id = $1)
             WHERE id = $1`,
            [placeId],
          );
          await client.query("COMMIT");
          review = formatReview(result.rows[0]);
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }

        await Promise.all([
          pubsub.publish(reviewTopic(placeId), { reviewAdded: review }),
          pubsub.publish(REVIEW_ADDED_TOPIC, { reviewAdded: review }),
        ]);
        return review;
      },
      deleteReview: async (_parent, { id }) => {
        const reviewId = toDatabaseId(id);
        if (reviewId === null) {
          throw badInput("Review ID must be a positive integer");
        }

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const reviewResult = await client.query(
            `SELECT place_id AS "placeId"
             FROM reviews
             WHERE id = $1
             FOR UPDATE`,
            [reviewId],
          );
          if (reviewResult.rowCount === 0) {
            await client.query("COMMIT");
            return false;
          }

          const placeId = reviewResult.rows[0].placeId;
          await client.query("SELECT id FROM places WHERE id = $1 FOR UPDATE", [
            placeId,
          ]);
          await client.query("DELETE FROM reviews WHERE id = $1", [reviewId]);
          await client.query(
            `UPDATE places
             SET rating = COALESCE(
               (SELECT AVG(rating) FROM reviews WHERE place_id = $1),
               4.0
             )
             WHERE id = $1`,
            [placeId],
          );
          await client.query("COMMIT");
          return true;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
    },
    Subscription: {
      reviewAdded: {
        subscribe: (_parent, { placeId }, { pubsub }) => {
          const id = placeId == null ? null : toDatabaseId(placeId);
          if (placeId != null && id === null) {
            throw badInput("Place ID must be a positive integer");
          }
          return pubsub.asyncIterator(
            id === null ? REVIEW_ADDED_TOPIC : reviewTopic(id),
          );
        },
        resolve: (payload) => payload.reviewAdded,
      },
    },
  };
}

module.exports = { createResolvers, REVIEW_ADDED_TOPIC, reviewTopic };
