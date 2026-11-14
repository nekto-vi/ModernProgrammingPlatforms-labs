const {
  getCityWeather,
  getNbrbRates,
  getPlaceWikiSummary,
} = require("./services");

const resolvers = {
  City: {
    __resolveReference: (reference) => reference,
    weather: (city) => getCityWeather(city.lat, city.lon),
  },
  Place: {
    __resolveReference: (reference) => reference,
    wikiSummary: (place) => getPlaceWikiSummary(place.name),
  },
  Query: {
    exchangeRates: () => getNbrbRates(),
  },
};

module.exports = { resolvers };
