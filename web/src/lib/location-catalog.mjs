// Client-safe & server-safe global hierarchy of Countries -> States/Provinces ->
// Major Company Office / Tech Hub Cities (with ATS spelling aliases such as
// Bengaluru/Bangalore, Gurugram/Gurgaon, Mumbai/Bombay, etc.).

export const WORLD_LOCATION_CATALOG = [
  {
    country: "India",
    code: "IN",
    aliases: ["India", "IND", "IN -", ", IN"],
    states: [
      {
        state: "Karnataka",
        aliases: ["Karnataka", "KA"],
        cities: [
          { name: "Bengaluru", aliases: ["Bengaluru", "Bangalore"] },
          { name: "Mysuru", aliases: ["Mysuru", "Mysore"] },
          { name: "Mangaluru", aliases: ["Mangaluru", "Mangalore"] },
          { name: "Hubballi", aliases: ["Hubballi", "Hubli"] },
        ],
      },
      {
        state: "Maharashtra",
        aliases: ["Maharashtra", "MH"],
        cities: [
          { name: "Mumbai", aliases: ["Mumbai", "Bombay"] },
          { name: "Pune", aliases: ["Pune"] },
          { name: "Navi Mumbai", aliases: ["Navi Mumbai", "Thane"] },
          { name: "Nagpur", aliases: ["Nagpur"] },
        ],
      },
      {
        state: "Telangana",
        aliases: ["Telangana", "TG", "TS"],
        cities: [
          { name: "Hyderabad", aliases: ["Hyderabad", "Secunderabad", "Cyberabad"] },
          { name: "Warangal", aliases: ["Warangal"] },
        ],
      },
      {
        state: "Tamil Nadu",
        aliases: ["Tamil Nadu", "TN"],
        cities: [
          { name: "Chennai", aliases: ["Chennai", "Madras"] },
          { name: "Coimbatore", aliases: ["Coimbatore"] },
          { name: "Madurai", aliases: ["Madurai"] },
          { name: "Tiruchirappalli", aliases: ["Tiruchirappalli", "Trichy"] },
        ],
      },
      {
        state: "Delhi NCR",
        aliases: ["Delhi", "NCR", "New Delhi", "Delhi NCR"],
        cities: [
          { name: "New Delhi", aliases: ["New Delhi", "Delhi"] },
          { name: "Gurugram", aliases: ["Gurugram", "Gurgaon"] },
          { name: "Noida", aliases: ["Noida", "Greater Noida"] },
          { name: "Faridabad", aliases: ["Faridabad"] },
        ],
      },
      {
        state: "Haryana",
        aliases: ["Haryana", "HR"],
        cities: [
          { name: "Gurugram", aliases: ["Gurugram", "Gurgaon"] },
          { name: "Faridabad", aliases: ["Faridabad"] },
          { name: "Panchkula", aliases: ["Panchkula"] },
        ],
      },
      {
        state: "Uttar Pradesh",
        aliases: ["Uttar Pradesh", "UP"],
        cities: [
          { name: "Noida", aliases: ["Noida", "Greater Noida"] },
          { name: "Lucknow", aliases: ["Lucknow"] },
          { name: "Kanpur", aliases: ["Kanpur"] },
        ],
      },
      {
        state: "Gujarat",
        aliases: ["Gujarat", "GJ"],
        cities: [
          { name: "Ahmedabad", aliases: ["Ahmedabad"] },
          { name: "Gandhinagar", aliases: ["Gandhinagar", "GIFT City"] },
          { name: "Vadodara", aliases: ["Vadodara", "Baroda"] },
          { name: "Surat", aliases: ["Surat"] },
        ],
      },
      {
        state: "West Bengal",
        aliases: ["West Bengal", "WB"],
        cities: [
          { name: "Kolkata", aliases: ["Kolkata", "Calcutta"] },
          { name: "Durgapur", aliases: ["Durgapur"] },
        ],
      },
      {
        state: "Kerala",
        aliases: ["Kerala", "KL"],
        cities: [
          { name: "Kochi", aliases: ["Kochi", "Cochin", "Ernakulam"] },
          { name: "Thiruvananthapuram", aliases: ["Thiruvananthapuram", "Trivandrum"] },
          { name: "Kozhikode", aliases: ["Kozhikode", "Calicut"] },
        ],
      },
      {
        state: "Rajasthan",
        aliases: ["Rajasthan", "RJ"],
        cities: [
          { name: "Jaipur", aliases: ["Jaipur"] },
          { name: "Udaipur", aliases: ["Udaipur"] },
          { name: "Jodhpur", aliases: ["Jodhpur"] },
        ],
      },
      {
        state: "Punjab & Chandigarh",
        aliases: ["Punjab", "Chandigarh", "Mohali"],
        cities: [
          { name: "Chandigarh", aliases: ["Chandigarh"] },
          { name: "Mohali", aliases: ["Mohali", "SAS Nagar"] },
          { name: "Ludhiana", aliases: ["Ludhiana"] },
        ],
      },
      {
        state: "Madhya Pradesh",
        aliases: ["Madhya Pradesh", "MP"],
        cities: [
          { name: "Indore", aliases: ["Indore"] },
          { name: "Bhopal", aliases: ["Bhopal"] },
        ],
      },
      {
        state: "Odisha",
        aliases: ["Odisha", "Orissa"],
        cities: [
          { name: "Bhubaneswar", aliases: ["Bhubaneswar"] },
          { name: "Cuttack", aliases: ["Cuttack"] },
        ],
      },
      {
        state: "Andhra Pradesh",
        aliases: ["Andhra Pradesh", "AP"],
        cities: [
          { name: "Visakhapatnam", aliases: ["Visakhapatnam", "Vizag"] },
          { name: "Vijayawada", aliases: ["Vijayawada"] },
          { name: "Tirupati", aliases: ["Tirupati"] },
        ],
      },
    ],
  },
  {
    country: "United States",
    code: "US",
    aliases: ["United States", "USA", "U.S.", "US"],
    states: [
      {
        state: "California",
        aliases: ["California", "CA", "Bay Area"],
        cities: [
          { name: "San Francisco", aliases: ["San Francisco", "SF"] },
          { name: "San Jose", aliases: ["San Jose", "Silicon Valley"] },
          { name: "Palo Alto", aliases: ["Palo Alto", "Mountain View", "Sunnyvale", "Menlo Park"] },
          { name: "Los Angeles", aliases: ["Los Angeles", "Santa Monica", "Irvine"] },
          { name: "San Diego", aliases: ["San Diego"] },
        ],
      },
      {
        state: "New York",
        aliases: ["New York", "NY", "NYC"],
        cities: [
          { name: "New York City", aliases: ["New York", "NYC", "Manhattan", "Brooklyn"] },
          { name: "Albany", aliases: ["Albany"] },
        ],
      },
      {
        state: "Washington",
        aliases: ["Washington", "WA"],
        cities: [
          { name: "Seattle", aliases: ["Seattle"] },
          { name: "Bellevue", aliases: ["Bellevue", "Redmond", "Kirkland"] },
        ],
      },
      {
        state: "Texas",
        aliases: ["Texas", "TX"],
        cities: [
          { name: "Austin", aliases: ["Austin"] },
          { name: "Dallas", aliases: ["Dallas", "Plano", "Irving"] },
          { name: "Houston", aliases: ["Houston"] },
        ],
      },
      {
        state: "Massachusetts",
        aliases: ["Massachusetts", "MA"],
        cities: [
          { name: "Boston", aliases: ["Boston"] },
          { name: "Cambridge", aliases: ["Cambridge", "Somerville"] },
        ],
      },
      {
        state: "Illinois",
        aliases: ["Illinois", "IL"],
        cities: [{ name: "Chicago", aliases: ["Chicago"] }],
      },
      {
        state: "Georgia",
        aliases: ["Georgia", "GA"],
        cities: [{ name: "Atlanta", aliases: ["Atlanta"] }],
      },
      {
        state: "Colorado",
        aliases: ["Colorado", "CO"],
        cities: [
          { name: "Denver", aliases: ["Denver"] },
          { name: "Boulder", aliases: ["Boulder"] },
        ],
      },
      {
        state: "Virginia & DC",
        aliases: ["Virginia", "VA", "Washington, DC", "D.C."],
        cities: [
          { name: "Arlington", aliases: ["Arlington", "McLean", "Reston", "Tysons"] },
          { name: "Washington, D.C.", aliases: ["Washington, DC", "Washington D.C."] },
        ],
      },
    ],
  },
  {
    country: "United Kingdom",
    code: "GB",
    aliases: ["United Kingdom", "UK", "Great Britain", "England"],
    states: [
      {
        state: "England",
        aliases: ["England"],
        cities: [
          { name: "London", aliases: ["London"] },
          { name: "Manchester", aliases: ["Manchester"] },
          { name: "Cambridge", aliases: ["Cambridge"] },
          { name: "Bristol", aliases: ["Bristol"] },
          { name: "Birmingham", aliases: ["Birmingham"] },
          { name: "Oxford", aliases: ["Oxford"] },
        ],
      },
      {
        state: "Scotland",
        aliases: ["Scotland"],
        cities: [
          { name: "Edinburgh", aliases: ["Edinburgh"] },
          { name: "Glasgow", aliases: ["Glasgow"] },
        ],
      },
      {
        state: "Northern Ireland",
        aliases: ["Northern Ireland"],
        cities: [{ name: "Belfast", aliases: ["Belfast"] }],
      },
    ],
  },
  {
    country: "Canada",
    code: "CA",
    aliases: ["Canada"],
    states: [
      {
        state: "Ontario",
        aliases: ["Ontario", "ON"],
        cities: [
          { name: "Toronto", aliases: ["Toronto", "GTA"] },
          { name: "Waterloo", aliases: ["Waterloo", "Kitchener"] },
          { name: "Ottawa", aliases: ["Ottawa"] },
        ],
      },
      {
        state: "British Columbia",
        aliases: ["British Columbia", "BC"],
        cities: [{ name: "Vancouver", aliases: ["Vancouver", "Burnaby"] }],
      },
      {
        state: "Quebec",
        aliases: ["Quebec", "QC"],
        cities: [{ name: "Montreal", aliases: ["Montreal", "Montréal"] }],
      },
      {
        state: "Alberta",
        aliases: ["Alberta", "AB"],
        cities: [
          { name: "Calgary", aliases: ["Calgary"] },
          { name: "Edmonton", aliases: ["Edmonton"] },
        ],
      },
    ],
  },
  {
    country: "Germany",
    code: "DE",
    aliases: ["Germany", "Deutschland"],
    states: [
      {
        state: "Berlin",
        aliases: ["Berlin"],
        cities: [{ name: "Berlin", aliases: ["Berlin"] }],
      },
      {
        state: "Bavaria",
        aliases: ["Bavaria", "Bayern"],
        cities: [
          { name: "Munich", aliases: ["Munich", "München"] },
          { name: "Nuremberg", aliases: ["Nuremberg", "Nürnberg"] },
        ],
      },
      {
        state: "Hesse",
        aliases: ["Hesse", "Hessen"],
        cities: [{ name: "Frankfurt", aliases: ["Frankfurt"] }],
      },
      {
        state: "Hamburg",
        aliases: ["Hamburg"],
        cities: [{ name: "Hamburg", aliases: ["Hamburg"] }],
      },
      {
        state: "North Rhine-Westphalia",
        aliases: ["North Rhine-Westphalia", "NRW"],
        cities: [
          { name: "Cologne", aliases: ["Cologne", "Köln"] },
          { name: "Düsseldorf", aliases: ["Düsseldorf", "Dusseldorf"] },
        ],
      },
    ],
  },
  {
    country: "Singapore",
    code: "SG",
    aliases: ["Singapore", "SG"],
    states: [
      {
        state: "Singapore",
        aliases: ["Singapore"],
        cities: [
          { name: "Singapore Central / Marina Bay", aliases: ["Singapore"] },
          { name: "One-North / Fusionopolis", aliases: ["Singapore", "One-North"] },
        ],
      },
    ],
  },
  {
    country: "Australia",
    code: "AU",
    aliases: ["Australia", "AUS"],
    states: [
      {
        state: "New South Wales",
        aliases: ["New South Wales", "NSW"],
        cities: [{ name: "Sydney", aliases: ["Sydney"] }],
      },
      {
        state: "Victoria",
        aliases: ["Victoria", "VIC"],
        cities: [{ name: "Melbourne", aliases: ["Melbourne"] }],
      },
      {
        state: "Queensland",
        aliases: ["Queensland", "QLD"],
        cities: [{ name: "Brisbane", aliases: ["Brisbane"] }],
      },
    ],
  },
  {
    country: "United Arab Emirates",
    code: "AE",
    aliases: ["United Arab Emirates", "UAE"],
    states: [
      {
        state: "Dubai",
        aliases: ["Dubai"],
        cities: [{ name: "Dubai", aliases: ["Dubai", "DIFC", "Dubai Internet City"] }],
      },
      {
        state: "Abu Dhabi",
        aliases: ["Abu Dhabi"],
        cities: [{ name: "Abu Dhabi", aliases: ["Abu Dhabi"] }],
      },
    ],
  },
  {
    country: "Netherlands",
    code: "NL",
    aliases: ["Netherlands", "Holland"],
    states: [
      {
        state: "North Holland",
        aliases: ["North Holland"],
        cities: [{ name: "Amsterdam", aliases: ["Amsterdam"] }],
      },
      {
        state: "South Holland",
        aliases: ["South Holland"],
        cities: [
          { name: "Rotterdam", aliases: ["Rotterdam"] },
          { name: "The Hague", aliases: ["The Hague", "Den Haag"] },
        ],
      },
      {
        state: "North Brabant",
        aliases: ["North Brabant"],
        cities: [{ name: "Eindhoven", aliases: ["Eindhoven"] }],
      },
    ],
  },
  {
    country: "Ireland",
    code: "IE",
    aliases: ["Ireland"],
    states: [
      {
        state: "Leinster",
        aliases: ["Leinster", "Dublin"],
        cities: [{ name: "Dublin", aliases: ["Dublin"] }],
      },
      {
        state: "Munster",
        aliases: ["Munster", "Cork"],
        cities: [{ name: "Cork", aliases: ["Cork"] }],
      },
      {
        state: "Connacht",
        aliases: ["Connacht", "Galway"],
        cities: [{ name: "Galway", aliases: ["Galway"] }],
      },
    ],
  },
  {
    country: "France",
    code: "FR",
    aliases: ["France"],
    states: [
      {
        state: "Île-de-France",
        aliases: ["Île-de-France", "Paris"],
        cities: [{ name: "Paris", aliases: ["Paris"] }],
      },
      {
        state: "Auvergne-Rhône-Alpes",
        aliases: ["Lyon", "Grenoble"],
        cities: [
          { name: "Lyon", aliases: ["Lyon"] },
          { name: "Grenoble", aliases: ["Grenoble"] },
        ],
      },
    ],
  },
  {
    country: "Japan",
    code: "JP",
    aliases: ["Japan"],
    states: [
      {
        state: "Tokyo",
        aliases: ["Tokyo"],
        cities: [{ name: "Tokyo", aliases: ["Tokyo", "Shibuya", "Minato"] }],
      },
      {
        state: "Osaka",
        aliases: ["Osaka"],
        cities: [{ name: "Osaka", aliases: ["Osaka"] }],
      },
    ],
  },
  {
    country: "Spain",
    code: "ES",
    aliases: ["Spain", "España"],
    states: [
      {
        state: "Madrid",
        aliases: ["Madrid"],
        cities: [{ name: "Madrid", aliases: ["Madrid"] }],
      },
      {
        state: "Catalonia",
        aliases: ["Catalonia", "Cataluña", "Barcelona"],
        cities: [{ name: "Barcelona", aliases: ["Barcelona"] }],
      },
    ],
  },
  {
    country: "Poland",
    code: "PL",
    aliases: ["Poland", "Polska"],
    states: [
      {
        state: "Masovian",
        aliases: ["Warsaw", "Warszawa"],
        cities: [{ name: "Warsaw", aliases: ["Warsaw", "Warszawa"] }],
      },
      {
        state: "Lesser Poland",
        aliases: ["Kraków", "Krakow"],
        cities: [{ name: "Kraków", aliases: ["Kraków", "Krakow"] }],
      },
      {
        state: "Lower Silesian",
        aliases: ["Wrocław", "Wroclaw"],
        cities: [{ name: "Wrocław", aliases: ["Wrocław", "Wroclaw"] }],
      },
    ],
  },
  {
    country: "Switzerland",
    code: "CH",
    aliases: ["Switzerland", "Schweiz"],
    states: [
      {
        state: "Zürich",
        aliases: ["Zürich", "Zurich"],
        cities: [{ name: "Zürich", aliases: ["Zürich", "Zurich"] }],
      },
      {
        state: "Geneva & Vaud",
        aliases: ["Geneva", "Lausanne"],
        cities: [
          { name: "Geneva", aliases: ["Geneva", "Genève"] },
          { name: "Lausanne", aliases: ["Lausanne"] },
        ],
      },
    ],
  },
  {
    country: "Brazil",
    code: "BR",
    aliases: ["Brazil", "Brasil"],
    states: [
      {
        state: "São Paulo",
        aliases: ["São Paulo", "Sao Paulo"],
        cities: [{ name: "São Paulo", aliases: ["São Paulo", "Sao Paulo"] }],
      },
      {
        state: "Minas Gerais",
        aliases: ["Minas Gerais", "Belo Horizonte"],
        cities: [{ name: "Belo Horizonte", aliases: ["Belo Horizonte"] }],
      },
    ],
  },
];

export function getCountryEntry(countryName) {
  if (!countryName) return null;
  const lower = String(countryName).trim().toLowerCase();
  return (
    WORLD_LOCATION_CATALOG.find(
      (c) =>
        c.country.toLowerCase() === lower ||
        c.code.toLowerCase() === lower ||
        c.aliases.some((a) => a.toLowerCase() === lower),
    ) || null
  );
}

export function getStatesForCountry(countryName) {
  const entry = getCountryEntry(countryName);
  return entry ? entry.states : [];
}

export function getCitiesForState(countryName, stateName) {
  const entry = getCountryEntry(countryName);
  if (!entry) return [];
  if (!stateName) {
    return entry.states.flatMap((s) => s.cities);
  }
  const lower = String(stateName).trim().toLowerCase();
  const stateObj = entry.states.find(
    (s) =>
      s.state.toLowerCase() === lower ||
      s.aliases.some((a) => a.toLowerCase() === lower),
  );
  return stateObj ? stateObj.cities : [];
}

/**
 * Build scanner `allow` and `alwaysAllow` keyword arrays for a selected
 * `{ country, state, city, includeRemote }` hierarchy.
 *
 * @param {{ country?: string, state?: string, city?: string, includeRemote?: boolean }} selection
 * @returns {{ allow: string[], alwaysAllow: string[], label: string }}
 */
export function buildLocationFilterTokens({
  country = "",
  state = "",
  city = "",
  includeRemote = false,
} = {}) {
  const countryEntry = getCountryEntry(country);
  if (!countryEntry) {
    const allow = includeRemote ? ["Remote"] : [];
    return { allow, alwaysAllow: [], label: includeRemote ? "Remote" : "Worldwide" };
  }

  const tokens = new Set();
  const stateObj = state
    ? countryEntry.states.find((s) => s.state.toLowerCase() === state.toLowerCase())
    : null;
  const cityObj =
    city && stateObj
      ? stateObj.cities.find((c) => c.name.toLowerCase() === city.toLowerCase())
      : city
        ? countryEntry.states
            .flatMap((s) => s.cities)
            .find((c) => c.name.toLowerCase() === city.toLowerCase())
        : null;

  if (cityObj) {
    for (const a of cityObj.aliases) tokens.add(a);
  } else if (stateObj) {
    for (const a of stateObj.aliases) {
      if (a.length > 2) tokens.add(a);
    }
    for (const c of stateObj.cities) {
      for (const a of c.aliases) tokens.add(a);
    }
  } else {
    // Whole country selected: include country name + top office cities in that country
    tokens.add(countryEntry.country);
    for (const s of countryEntry.states) {
      for (const c of s.cities) {
        for (const a of c.aliases) tokens.add(a);
      }
    }
  }

  if (includeRemote) {
    tokens.add("Remote");
  }

  const allow = Array.from(tokens);
  const labelParts = [cityObj?.name, stateObj?.state, countryEntry.country].filter(Boolean);
  return {
    allow,
    alwaysAllow: allow.slice(0, 12),
    label: labelParts.join(", ") + (includeRemote ? " (+ Remote)" : ""),
  };
}

/**
 * Client-side predicate: check whether a discovered job offer's location string
 * matches the selected `{ country, state, city, includeRemote }` hierarchy.
 *
 * @param {string} offerLocation
 * @param {{ country?: string, state?: string, city?: string, includeRemote?: boolean }} selection
 * @returns {boolean}
 */
export function matchesLocationHierarchy(
  offerLocation = "",
  { country = "", state = "", city = "", includeRemote = false } = {},
) {
  if (!country) return true;
  const loc = String(offerLocation || "").trim();
  const lower = loc.toLowerCase();

  if (includeRemote && /\bremote\b/i.test(loc)) {
    // If a specific country is chosen alongside includeRemote, reject postings
    // explicitly restricted to a DIFFERENT country (e.g. "Remote - US" when India is selected)
    const countryEntry = getCountryEntry(country);
    if (countryEntry) {
      const otherCountries = WORLD_LOCATION_CATALOG.filter(
        (c) => c.code !== countryEntry.code,
      );
      const matchesSelectedCountry = buildLocationFilterTokens({
        country,
        state,
        city,
        includeRemote: false,
      }).allow.some((tok) => lower.includes(tok.toLowerCase()));
      if (matchesSelectedCountry) return true;
      const mentionsOtherCountry = otherCountries.some(
        (other) =>
          other.country.toLowerCase() !== countryEntry.country.toLowerCase() &&
          (lower.includes(other.country.toLowerCase()) ||
            other.states.some((s) =>
              s.cities.some((c) => lower.includes(c.name.toLowerCase())),
            )),
      );
      if (!mentionsOtherCountry) return true;
    } else {
      return true;
    }
  }

  if (!loc) return false;
  const { allow } = buildLocationFilterTokens({
    country,
    state,
    city,
    includeRemote: false,
  });
  return allow.some((tok) => lower.includes(tok.toLowerCase()));
}

/**
 * Infer a `{ country, state, city, includeRemote }` hierarchy from free text
 * (such as `cv.md` or a location string).
 *
 * @param {string} text
 * @returns {{ country: string, state: string, city: string, includeRemote: boolean }}
 */
export function inferLocationHierarchyFromText(text = "") {
  const raw = String(text || "");
  if (!raw.trim()) {
    return { country: "", state: "", city: "", includeRemote: true };
  }

  // Prefer explicit Location header in cv.md if present
  const locHeaderMatch = raw.match(/\*\*Location:\*\*\s*([^\n\r]+)/i);
  const sample = locHeaderMatch ? `${locHeaderMatch[1]}\n${raw.slice(0, 600)}` : raw.slice(0, 800);
  const lower = sample.toLowerCase();

  for (const countryEntry of WORLD_LOCATION_CATALOG) {
    // Check city match first
    for (const st of countryEntry.states) {
      for (const ct of st.cities) {
        if (
          ct.aliases.some((alias) => {
            const escaped = alias.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            return new RegExp(`\\b${escaped}\\b`, "i").test(lower);
          })
        ) {
          return {
            country: countryEntry.country,
            state: "",
            city: "",
            includeRemote: true,
          };
        }
      }
    }
    // Check country match
    if (
      countryEntry.aliases.some((alias) => {
        if (alias.length <= 2) return false;
        const escaped = alias.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${escaped}\\b`, "i").test(lower);
      })
    ) {
      return {
        country: countryEntry.country,
        state: "",
        city: "",
        includeRemote: true,
      };
    }
  }

  return { country: "", state: "", city: "", includeRemote: true };
}

/**
 * Infer `{ country, state, city, includeRemote }` from an `allow` chip array.
 *
 * @param {string[]} allow
 * @returns {{ country: string, state: string, city: string, includeRemote: boolean }}
 */
export function inferHierarchyFromAllowChips(allow = []) {
  if (!Array.isArray(allow) || allow.length === 0) {
    return { country: "", state: "", city: "", includeRemote: true };
  }
  const lowerSet = new Set(allow.map((a) => String(a).trim().toLowerCase()));
  const includeRemote = lowerSet.has("remote");

  for (const c of WORLD_LOCATION_CATALOG) {
    if (lowerSet.has(c.country.toLowerCase())) {
      return { country: c.country, state: "", city: "", includeRemote };
    }
  }
  for (const c of WORLD_LOCATION_CATALOG) {
    for (const s of c.states) {
      if (lowerSet.has(s.state.toLowerCase())) {
        return { country: c.country, state: s.state, city: "", includeRemote };
      }
      for (const ct of s.cities) {
        if (ct.aliases.some((al) => lowerSet.has(al.toLowerCase()))) {
          return { country: c.country, state: s.state, city: ct.name, includeRemote };
        }
      }
    }
  }
  return { country: "", state: "", city: "", includeRemote };
}
