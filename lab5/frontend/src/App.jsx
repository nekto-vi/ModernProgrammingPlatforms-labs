import React, { useMemo, useState } from "react";
import { gql, useMutation, useQuery, useSubscription } from "@apollo/client";

const DASHBOARD_QUERY = gql`
  query TravelDashboard(
    $filter: PlaceFilterInput
    $sortBy: PlaceSortField
    $sortOrder: SortOrder
    $limit: Int
    $offset: Int
  ) {
    countries {
      code
      name
    }
    cities {
      id
      name
      countryCode
    }
    places(
      filter: $filter
      sortBy: $sortBy
      sortOrder: $sortOrder
      limit: $limit
      offset: $offset
    ) {
      items {
        id
        name
        category
        address
        rating
        city {
          id
          name
          countryCode
          lat
          lon
          country {
            name
            flagUrl
          }
          weather {
            temperature
            windSpeed
            weatherCode
            isDay
          }
        }
        wikiSummary {
          title
          extract
          thumbnailUrl
          pageUrl
        }
        reviewsCount
        reviews {
          id
          placeId
          author
          rating
          comment
          createdAt
        }
      }
      totalCount
      hasMore
    }
    exchangeRates {
      currencyCode
      scale
      name
      rateToByn
    }
  }
`;

const ADD_REVIEW = gql`
  mutation AddReview($input: AddReviewInput!) {
    addReview(input: $input) {
      id
      placeId
      author
      rating
      comment
      createdAt
    }
  }
`;

const REVIEW_ADDED = gql`
  subscription ReviewAdded {
    reviewAdded {
      id
      placeId
      author
      rating
      comment
      createdAt
    }
  }
`;

const PAGE_SIZE = 10;

const categoryLabels = {
  attraction: "Достопримечательность",
  museum: "Музей",
  hotel: "Отель",
  viewpoint: "Смотровая площадка",
  cafe: "Кафе",
  restaurant: "Ресторан",
  theatre: "Театр",
};

function formatDate(value) {
  return new Intl.DateTimeFormat("ru", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function Stars({ value }) {
  return (
    <span className="stars" aria-label={`Оценка ${value.toFixed(1)} из 5`}>
      <span aria-hidden="true">★</span> {value.toFixed(1)}
    </span>
  );
}

function ReviewForm({ place, onClose, onCreated }) {
  const [author, setAuthor] = useState("");
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [addReview, { loading, error }] = useMutation(ADD_REVIEW, {
    onCompleted: (data) => onCreated(data.addReview),
  });

  const submit = async (event) => {
    event.preventDefault();
    await addReview({
      variables: {
        input: {
          placeId: place.id,
          author,
          rating: Number(rating),
          comment,
        },
      },
    });
  };

  return (
    <form className="review-form" onSubmit={submit}>
      <div className="form-heading">
        <h3>Ваш отзыв</h3>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Закрыть">
          ×
        </button>
      </div>
      <label>
        Имя
        <input
          value={author}
          onChange={(event) => setAuthor(event.target.value)}
          placeholder="Как к вам обращаться?"
          maxLength={100}
          required
        />
      </label>
      <label>
        Оценка
        <select value={rating} onChange={(event) => setRating(event.target.value)}>
          {[5, 4, 3, 2, 1].map((score) => (
            <option key={score} value={score}>
              {score} — {score === 5 ? "Превосходно" : score === 4 ? "Очень хорошо" : score === 3 ? "Хорошо" : score === 2 ? "Неплохо" : "Плохо"}
            </option>
          ))}
        </select>
      </label>
      <label>
        Впечатления
        <textarea
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder="Поделитесь впечатлениями о месте"
          rows={3}
          maxLength={2000}
          required
        />
      </label>
      {error && <p className="form-error">{error.message}</p>}
      <button className="button button-dark" type="submit" disabled={loading}>
        {loading ? "Отправляем…" : "Опубликовать отзыв"}
      </button>
    </form>
  );
}

function PlaceCard({ place, onWriteReview }) {
  const latestReview = place.reviews[0];
  const weather = place.city.weather;

  return (
    <article className="place-card">
      {place.wikiSummary?.thumbnailUrl ? (
        <img
          className="place-image"
          src={place.wikiSummary.thumbnailUrl}
          alt=""
          loading="lazy"
        />
      ) : (
        <div className="place-image image-placeholder" aria-hidden="true">
          <span>{place.city.country?.flagUrl ? "✦" : "⌖"}</span>
        </div>
      )}
      <div className="place-content">
        <div className="place-meta">
          <span className="category-tag">
            {categoryLabels[place.category] ?? place.category}
          </span>
          <Stars value={place.rating} />
        </div>
        <h2>{place.name}</h2>
        <p className="place-location">
          {place.city.country?.name ?? place.city.countryCode} · {place.city.name}
        </p>
        {place.address && <p className="place-address">{place.address}</p>}
        {place.wikiSummary?.extract && (
          <p className="place-description">
            {place.wikiSummary.extract}
            {place.wikiSummary.pageUrl && (
              <>{" "}<a href={place.wikiSummary.pageUrl} target="_blank" rel="noreferrer">Подробнее</a></>
            )}
          </p>
        )}
        {weather && (
          <div className="weather-line">
            <span aria-hidden="true">{weather.isDay ? "☀" : "☾"}</span>
            Сейчас в городе {weather.temperature}°C · ветер {weather.windSpeed} км/ч
          </div>
        )}
        <div className="card-footer">
          <span className="review-count">
            {place.reviewsCount} {place.reviewsCount === 1 ? "отзыв" : "отзывов"}
          </span>
          <button className="text-button" type="button" onClick={() => onWriteReview(place)}>
            Оставить отзыв <span aria-hidden="true">↗</span>
          </button>
        </div>
        {latestReview && (
          <blockquote className="latest-review">
            <div>
              <strong>{latestReview.author}</strong>
              <span className="review-stars">{"★".repeat(latestReview.rating)}</span>
            </div>
            <p>{latestReview.comment}</p>
          </blockquote>
        )}
      </div>
    </article>
  );
}

export default function App() {
  const [countryCode, setCountryCode] = useState("BY");
  const [cityId, setCityId] = useState("");
  const [category, setCategory] = useState("restaurant");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [sortBy, setSortBy] = useState("RATING");
  const [offset, setOffset] = useState(0);
  const [reviewPlace, setReviewPlace] = useState(null);
  const [liveReviews, setLiveReviews] = useState([]);

  const filter = useMemo(
    () => ({
      ...(countryCode ? { countryCode } : {}),
      ...(cityId ? { cityId } : {}),
      ...(category ? { category } : {}),
      ...(search ? { search } : {}),
    }),
    [countryCode, cityId, category, search],
  );
  const { data, loading, error, refetch } = useQuery(DASHBOARD_QUERY, {
    variables: {
      filter,
      sortBy,
      sortOrder: "DESC",
      limit: PAGE_SIZE,
      offset,
    },
    notifyOnNetworkStatusChange: true,
  });

  useSubscription(REVIEW_ADDED, {
    onData: ({ data: subscriptionData }) => {
      const review = subscriptionData.data?.reviewAdded;
      if (!review) return;
      setLiveReviews((current) => [review, ...current].slice(0, 3));
      refetch();
    },
  });

  const countries = data?.countries ?? [];
  const cities = (data?.cities ?? []).filter(
    (city) => !countryCode || city.countryCode === countryCode,
  );
  const page = data?.places;
  const showingSamples = page?.items.some((place) =>
    place.name.startsWith("Учебный ресторан №"),
  );

  const changeCountry = (value) => {
    setCountryCode(value);
    setCityId("");
    setOffset(0);
  };

  const runSearch = (event) => {
    event.preventDefault();
    setSearch(searchInput.trim());
    setOffset(0);
  };

  const reviewedPlace = (review) => {
    setReviewPlace(null);
    refetch();
    if (review?.placeId) {
      setLiveReviews((current) => current.filter((item) => item.id !== review.id));
    }
  };

  return (
    <main>
      <header className="page-header">
        <h1>Путеводитель по городам</h1>
        <p>Поиск интересных мест и заведений</p>
      </header>

      <section className="explore-section" id="places">
        <div className="section-heading">
          <div>
            <h2>Места и заведения</h2>
          </div>
          <p className="section-intro">
            Ищите по названию или выберите страну, город и категорию.
          </p>
        </div>

        <form className="filters" onSubmit={runSearch}>
          <label className="search-field">
            <span aria-hidden="true">⌕</span>
            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Введите название места"
              aria-label="Поиск места по названию"
            />
            {searchInput && (
              <button
                className="clear-search"
                type="button"
                onClick={() => {
                  setSearchInput("");
                  setSearch("");
                  setOffset(0);
                }}
                aria-label="Очистить поиск"
              >
                ×
              </button>
            )}
          </label>
          <button className="button button-dark search-button" type="submit">Найти</button>
          <label className="select-field">
            <span>Страна</span>
            <select value={countryCode} onChange={(event) => changeCountry(event.target.value)}>
              <option value="">Все страны</option>
              {countries.map((country) => (
                <option key={country.code} value={country.code}>{country.name}</option>
              ))}
            </select>
          </label>
          <label className="select-field">
            <span>Город</span>
            <select
              value={cityId}
              onChange={(event) => {
                setCityId(event.target.value);
                setOffset(0);
              }}
            >
              <option value="">Все города</option>
              {cities.map((city) => (
                <option key={city.id} value={city.id}>{city.name}</option>
              ))}
            </select>
          </label>
          <label className="select-field">
            <span>Категория</span>
            <select
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
                setOffset(0);
              }}
            >
              <option value="">Все категории</option>
              {Object.entries(categoryLabels).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </label>
          <label className="select-field sort-field">
            <span>Сортировка</span>
            <select
              value={sortBy}
              onChange={(event) => {
                setSortBy(event.target.value);
                setOffset(0);
              }}
            >
              <option value="RATING">По рейтингу</option>
              <option value="NAME">По названию</option>
            </select>
          </label>
        </form>
        <p className="search-help">
          Поиск находит совпадения в названиях мест. Данные о заведениях загружаются
          из OpenStreetMap; описание, если оно доступно, — из Wikipedia.
        </p>
        {showingSamples && (
          <p className="sample-note">
            Это учебные примеры для демонстрации интерфейса, а не реальные рестораны.
          </p>
        )}

        <div className="results-caption">
          <p>
            {loading && !page ? "Ищем интересные места…" : `Найдено мест: ${page?.totalCount ?? 0}`}
          </p>
          {page && <span>Показаны {page.items.length ? offset + 1 : 0}–{offset + page.items.length}</span>}
        </div>

        {error && (
          <div className="notice notice-error">
            <div>
              <strong>Не удалось загрузить места</strong>
              <p>{error.message}</p>
            </div>
            <button className="button button-dark" onClick={() => refetch()}>Повторить</button>
          </div>
        )}
        {loading && !page && <div className="loading-state"><span className="loader" />Загружаем путеводитель…</div>}
        {!loading && !error && page?.items.length === 0 && (
          <div className="empty-state">
            <h3>Места не найдены</h3>
            <p>Измените запрос или фильтры. Если список пустой, проверьте загрузку данных.</p>
            <button
              className="text-button"
              onClick={() => {
                changeCountry("");
                setCategory("");
                setSearch("");
                setSearchInput("");
              }}
            >
              Сбросить фильтры
            </button>
          </div>
        )}

        {liveReviews.length > 0 && (
          <aside className="live-banner" aria-live="polite">
            <span className="live-dot" />
            Новый отзыв: <strong>{liveReviews[0].author}</strong> — «{liveReviews[0].comment}»
          </aside>
        )}

        <div className="places-grid">
          {page?.items.map((place) => (
            <PlaceCard key={place.id} place={place} onWriteReview={setReviewPlace} />
          ))}
        </div>

        {reviewPlace && (
          <div className="modal-backdrop" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setReviewPlace(null);
          }}>
            <div className="review-modal" role="dialog" aria-modal="true" aria-label={`Отзыв о ${reviewPlace.name}`}>
              <p className="eyebrow eyebrow-dark">{reviewPlace.city.name}</p>
              <h2>{reviewPlace.name}</h2>
              <ReviewForm
                place={reviewPlace}
                onClose={() => setReviewPlace(null)}
                onCreated={reviewedPlace}
              />
            </div>
          </div>
        )}

        {page && page.totalCount > PAGE_SIZE && (
          <div className="pagination">
            <button
              className="button button-outline"
              disabled={offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              ← Назад
            </button>
            <span>
              Страница {Math.floor(offset / PAGE_SIZE) + 1} из {Math.ceil(page.totalCount / PAGE_SIZE)}
            </span>
            <button
              className="button button-outline"
              disabled={!page.hasMore || loading}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Далее →
            </button>
          </div>
        )}
      </section>

      <section className="rates-section" id="about">
        <div>
          <h2>Курсы валют к белорусскому рублю</h2>
        </div>
        <div className="rates-list">
          {(data?.exchangeRates ?? []).map((rate) => (
            <div className="rate-item" key={rate.currencyCode}>
              <span className="rate-code">{rate.currencyCode}</span>
              <span className="rate-name">{rate.name} · {rate.scale}</span>
              <strong>{rate.rateToByn.toLocaleString("ru", { maximumFractionDigits: 4 })} BYN</strong>
            </div>
          ))}
          {!data?.exchangeRates?.length && !error && <p className="muted">Курсы сейчас недоступны.</p>}
        </div>
      </section>
    </main>
  );
}
