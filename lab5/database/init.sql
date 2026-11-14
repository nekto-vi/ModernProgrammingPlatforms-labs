CREATE TABLE IF NOT EXISTS countries (
    id SERIAL PRIMARY KEY,
    code VARCHAR(10) UNIQUE,
    name VARCHAR,
    capital VARCHAR,
    currency VARCHAR,
    region VARCHAR,
    flag_url TEXT
);

CREATE TABLE IF NOT EXISTS cities (
    id SERIAL PRIMARY KEY,
    name VARCHAR UNIQUE,
    country_code VARCHAR,
    lat FLOAT,
    lon FLOAT
);

CREATE TABLE IF NOT EXISTS places (
    id SERIAL PRIMARY KEY,
    osm_id BIGINT UNIQUE,
    city_id INT REFERENCES cities(id),
    name VARCHAR,
    category VARCHAR,
    lat FLOAT,
    lon FLOAT,
    address TEXT,
    rating FLOAT DEFAULT 4.0
);

CREATE TABLE IF NOT EXISTS reviews (
    id SERIAL PRIMARY KEY,
    place_id INT REFERENCES places(id),
    author VARCHAR,
    rating INT,
    comment TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_places_city_id ON places(city_id);
CREATE INDEX IF NOT EXISTS idx_places_category ON places(category);
CREATE INDEX IF NOT EXISTS idx_places_name ON places(name);
