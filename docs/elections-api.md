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

## `GET /elections/:id/dhondt?place=&organ=&seats=`

The seats recomputed from the votes with the d'Hondt method, which Portugal uses for
parliament, the European Parliament and câmaras municipais. Use it for a "how seats are
won" explainer, and to show how close each list came to one more seat.

`place` must elect seats: a district (*círculo*) or `FOREIGN-800000`/`FOREIGN-900000` in
legislativas, the top level in europeias, a municipality for `organ=CM`. Pass `seats` to
simulate a different number (1-250), for "what if this district had 10 deputies?".

```jsonc
{
  "election": { /* … */ }, "organ": "AR",
  "place": { "key": "LOCAL-110000", "name": "Lisboa", "level": "district", "dicofre": "11" },
  "seats": 48,
  "simulated": false,
  "matchesOfficial": true,             // always true on real data so far; null when simulated
  "lastSeat": { "list": "PAN", "quotient": 23369 },        // the quotient that won the 48th seat
  "firstLoser": { "list": "PS", "quotient": 23191.69 },    // the first one that missed out
  "lists": [{                          // most seats first
    "list": "PS", "name": "Partido Socialista", "partySlugs": ["ps"], "votes": 301492,
    "seats": 12, "officialSeats": 12,
    "quotients": [301492, 150746, 100497.33, 75373, 60298.4, 50248.67],  // votes ÷ 1…6
    "votesShortOfNextSeat": 2306       // all else equal; null if it won every seat
  }]
}
```

How to explain it: each list's votes are divided by 1, 2, 3…, and the seats go to the
largest results, one by one. A tie for the last seat goes to the list with fewer votes
(Lei Eleitoral da AR, art. 16.º). That is why small parties need many more votes per seat
in small districts: in Portalegre (2 seats) a list needs about a third of the votes, while
in Lisboa (48 seats) about 2% can be enough.

## `GET /elections/:id/candidates?place=&list=`

Who was on each list in a círculo, in order, and who got in. Available for **legislativas
2022, 2024 and 2025** and **europeias 2024**, which the results site publishes; older
elections return 404.

```jsonc
{
  "election": { /* … */ },
  "place": { "key": "LOCAL-130000", "name": "Porto", "level": "district", "dicofre": "13" },
  "circles": [ /* every círculo with lists: for a selector */ ],
  "lists": [{                          // most seats first
    "list": "PS", "name": "Partido Socialista", "partySlugs": ["ps"],
    "seats": 11,                       // draw the cut-off line after this many candidates
    "candidates": [                    // efetivos, in order
      { "position": 1, "name": "Fernando Manuel Ferreira Araújo", "elected": true, "deputyId": null },
      { "position": 12, "name": "Isabel Sofia Alves Andrade", "elected": false, "deputyId": 6710 }
    ],
    "alternates": [ /* suplentes, same shape */ ]
  }]
}
```

- `place` is required for legislativas (a district, `FOREIGN-800000` or `FOREIGN-900000`).
  Europeias have a single national list, which is the default.
- `elected` is who won a seat on election night. `deputyId` links to the deputy record
  (`GET /deputies/:id`): someone below the line with a `deputyId` took a seat later, replacing
  someone. That's worth showing ("entrou por substituição"). Elected candidates with no
  `deputyId` mostly went to the Government instead, or are spelled differently in the two
  sources.
- Names come in capitals from the source and are shown in proper case. A few particles may
  look odd ("D'ávila").
- Matching to deputies uses the full name. When spellings differ, it only matches within the
  same círculo and party, so it misses a few rather than linking the wrong person.

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
