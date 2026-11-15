# Elections API (results since 2011)

Base URL: `/api/v2`. Spec at `/docs`.

Official results from the Ministry of Internal Administration (www.eleicoes.mai.gov.pt),
for every place: the whole country, districts, municipalities and, for juntas de freguesia,
parishes. Use it for an elections menu, result pages with maps, and drill-down from the
country to a town.

| Type | Elections | Bodies (`organ`) |
|---|---|---|
| `legislativas` | 2011, 2015, 2019, 2022, 2024, 2025 | `AR`: Assembleia da República |
| `europeias` | 2014, 2019 (`EUR`), 2024 (`PE`) | European Parliament |
| `presidenciais` | 2011, 2016, 2021 | `PR` |
| `autarquicas` | 2013, 2017, 2021, 2025 | `CM` câmara, `AM` assembleia municipal, `AF` assembleia de freguesia |

Not yet available: **presidenciais 2026**, which isn't on the MAI site.

Election ids are `<type>-<year>`, e.g. `legislativas-2025`.

## `GET /elections?type=`

The elections menu, newest first.

```jsonc
{
  "items": [{
    "id": "legislativas-2025",
    "type": "legislativas",
    "name": "Legislativas 2025",
    "date": "2025-05-18",
    "organs": ["AR"],                   // the first one is the main body
    "sourceUrl": "https://www.eleicoes.mai.gov.pt/legislativas2025/",
    "turnout": { "registered": 10850000, "voters": 6340000, "turnoutPct": 58.23,
                 "blank": 80000, "null": 90000, "totalMandates": 230 },
    "winner": { /* a list result, see below */ },
    "imported": true                    // false while the import is still running
  }]
}
```

## `GET /elections/:id?organ=` and `GET /elections/:id/places/:key?organ=`

Results in one place, plus the places inside it, ready for a map. Without a place, you get
the top level: the total including votes abroad (`GLOBAL-990000`) or, for autárquicas,
mainland and islands (`LOCAL-500000`). `organ` defaults to the main body; send it to switch
between câmara, assembleia municipal and freguesia.

```jsonc
{
  "election": { "id": "legislativas-2025", "type": "legislativas", "name": "…", "date": "…", "organs": ["AR"], "sourceUrl": "…" },
  "organ": "AR",
  "place": { "key": "LOCAL-010100", "name": "Águeda", "level": "municipality", "dicofre": "0101" },
  "breadcrumb": [                      // from the top down, for "Total › Território nacional › Aveiro"
    { "key": "GLOBAL-990000", "name": "Total", "level": "global", "dicofre": null }, "…"
  ],
  "turnout": { "registered": 40000, "voters": 23000, "turnoutPct": 57.5, "blank": 300, "null": 250, "totalMandates": null },
  "lists": [{                          // most votes first
    "list": "PPD/PSD.CDS-PP",          // as on the ballot (a candidate's name in presidenciais)
    "name": "AD - COLIGAÇÃO PSD/CDS",  // autárquicas: the list's local name ("Viva Cascais")
    "partySlugs": ["psd", "cds-pp"],   // our parties in it: use for colours and links; [] if none
    "coalition": true,
    "citizens": false,                 // citizens' group (independents), autárquicas
    "votes": 9000,
    "pct": 39.1,                       // of all votes, blank and null included
    "validPct": 40.4,                  // of valid votes: the usual headline figure
    "mandates": 2,                     // seats won here, when there are seats here
    "presidents": null                 // autárquicas: câmaras/juntas won inside this area
  }],
  "children": [{                       // alphabetical; empty at the deepest level
    "key": "LOCAL-010103", "name": "Aguada de Cima", "level": "parish", "dicofre": "010103",
    "turnoutPct": 61.2,
    "winner": { "list": "PS", "partySlugs": ["ps"], "votes": 300, "validPct": 77.9 }
  }]
}
```

Errors: `404` for an unknown election or a place with no results; `400` for a body that the
election doesn't have (e.g. `organ=CM` in legislativas).

### Places and keys

| Level | Key | `dicofre` |
|---|---|---|
| `global` | `GLOBAL-990000` (total, with abroad) | null |
| `national` | `LOCAL-500000` (mainland and islands) | null |
| `foreign` | `FOREIGN-600000`, then `FOREIGN-800000` Europe, `FOREIGN-900000` outside Europe | null |
| `district` | `LOCAL-xx0000` (and the islands' regions) | `xx` |
| `municipality` | `LOCAL-xxyy00` | `xxyy` |
| `parish` | `LOCAL-xxyyzz` (`AUTARQUICAS2025-n` for parishes restored in 2025) | `xxyyzz` (null for restored ones) |

`dicofre` is the official INE/DGT code, which also identifies features in the CAOP map
boundaries (GeoJSON from DGT), so `children[].dicofre` can colour a map by winner.

- Legislativas, europeias and presidenciais go down to municipalities. Autárquicas go to
  municipalities for `CM`/`AM` and to parishes for `AF`.
- Parish boundaries change over time. The 2013 reform merged many parishes, and in 2025 about
  300 were restored. So a parish key that exists in 2013 may not exist in 2021.
- **Autárquicas 2025:** the site gives no official codes, so places are matched by name to
  earlier elections. The restored parishes are new: their key looks like
  `AUTARQUICAS2025-1234` and `dicofre` is `null`, so they can't be coloured on a map by
  code yet. Their results are complete.
- In autárquicas, one acronym can stand for different local lists (`PPD/PSD.CDS-PP` runs as
  "Viva Cascais" in one town and "MAIA EM PRIMEIRO" in another). `name` is the local name
  on that ballot. In national totals for such acronyms, it is the acronym itself.
- In legislativas, seats are won per district (*círculo*): `mandates` at district level
  and in the total, not at municipality level.

## `GET /places/:key`

A place with its parent and children (names only, no results): for search and navigation.

```jsonc
{ "key": "LOCAL-010100", "name": "Águeda", "level": "municipality", "dicofre": "0101",
  "parent": { "key": "LOCAL-010000", "name": "Aveiro", "level": "district", "dicofre": "01" },
  "children": [ /* places */ ] }
```

## Page ideas

- **Menu:** `GET /elections`, grouped by `type`, with the winner's colour and turnout.
- **Election page:** bar of `lists` (seats for AR/PE, `validPct` otherwise), map of
  `children` coloured by `winner.partySlugs[0]`, click to drill down.
- **Compare:** fetch the same place in two elections (e.g. `legislativas-2024` and
  `legislativas-2025`) and show the swing.
