# Places API (for the frontend): the map of officials

Every district, municipality and parish, with who represents it and what happens there. These
per-municipality pages are among our best search pages: give each its own URL
(e.g. `/sitios/LOCAL-060300` or a slug of the name) and put them in the sitemap
(`docs/seo.md`).

Keys are the same as in the elections API: `LOCAL-` plus the 6-digit DICOFRE code
(`LOCAL-060000` is Coimbra district, `LOCAL-060300` Coimbra municipality). Base path: `/api/v2`.

## GET /places

Query: `level` (`district`, `municipality` (default) or `parish`) and optionally `parent` (a
place key). For the map:

```json
{
  "items": [
    {
      "key": "LOCAL-060300",
      "name": "Coimbra",
      "level": "municipality",
      "parentKey": "LOCAL-060000",
      "dicofre": "0603",
      "mayor": {
        "id": "ana-aragao-coimbra",                 // their page: GET /local-officials/:id
        "name": "Ana Maria Pereira Abrunhosa Trigueiros de Aragão",
        "list": "PS.L.PAN",
        "label": "AVANÇAR COIMBRA",
        "parties": ["ps", "livre", "pan"],
        "election": "autarquicas-2025"
      }
    }
  ]
}
```

- **Colour the map** by `mayor.parties[0]` (the main party of the winning list). For
  citizens' groups `parties` is empty: use a neutral "independentes" colour.
- `mayor` is only set for municipalities. All 308 have one, from the 2025 autárquicas.
- Boundaries (GeoJSON) aren't served by us. Use the official CAOP files from DGT and join
  them on `dicofre`.

## GET /places/locate

For the "Usar a minha localização" button on `/sitios`: `GET /places/locate?lat=38.72&lon=-9.14`
returns the municipality containing the point.

```json
{ "key": "LOCAL-110600", "name": "Lisboa", "level": "municipality", "parentKey": "LOCAL-110000", "dicofre": "1106" }
```

- **404** `not_found`: the point isn't in Portugal (including the open sea).
- **400** `invalid_request`: `lat` or `lon` is missing, isn't a number, or is out of range.
- Built from CAOP 2024 (DGT), the same boundaries as the frontend's maps, simplified to about
  30 m. Points up to 1.5 km outside every outline count as in the nearest municipality, so
  beaches and harbours work.
- We don't log or store the coordinates: this route is left out of the request log.
- Use the browser's location API, then navigate to `/sitios/<key>`. If the visitor declines,
  or gets 404, keep the list or map.

## GET /places/:key

The place page. The first fields are the same as before (`key`, `name`, `level`, `dicofre`,
`parent`, `children`), so existing navigation keeps working. Then:

| field | what |
| --- | --- |
| `mayor` | Municipalities: the presidente da câmara, as in `/places` |
| `council` | Seats from the latest autárquicas: `{ election, organs: [{ organ, totalMandates, seats: [{ list, label, parties, votes, validPct, mandates }] }] }`. `CM` is the câmara and `AM` the assembleia municipal; for a parish, `AF` is the assembleia de freguesia. `null` if there are no seats here |
| `deputies` | Deputies elected by the district (círculo) the place is in: `{ circle: { key, name }, items: [{ id, name, photoUrl, party }] }`. Link each to `/deputados/:id` |
| `elections` | The latest election of each type with results here, newest first: `[{ election, name, date, organ, turnoutPct, winner: { list, label, validPct } }]`. Link to the full results at `/elections/:election/places/:key` |
| `contracts.carriedOut` | `{ count, total }`: public contracts carried out here, from BASE since 2024. Link to `/contracts?place=:key` |
| `contracts.council` | Municipalities: the câmara as a public buyer, `{ nif, name, count, total, directAwards }`. Link to `/contracts/parties/:nif`; show "ajustes diretos: N". Both `contracts` figures are kept in memory until the next weekly contracts import, like the contracts API's totals |

Non-local places (`GLOBAL-…`, `FOREIGN-…`) still answer, with the place-specific sections
empty.

## GET /local-officials/:id

A mayor's own page (presidente da câmara), from `mayor.id`. Ids are readable and stable:
first and last name plus the municipality (`carlos-moedas-lisboa`).

```jsonc
{
  "id": "carlos-moedas-lisboa",
  "name": "Carlos Manuel Félix Moedas",          // in full, as on the ballot
  "shortName": "Carlos Moedas",                  // as the news writes it: use it in the title
  "role": "mayor",
  "title": "Presidente da Câmara Municipal de Lisboa",
  "place": { "key": "LOCAL-110600", "name": "Lisboa", "level": "municipality" },
  "district": { "key": "LOCAL-110000", "name": "Lisboa", "level": "district" },
  "list": "PPD/PSD.CDS-PP", "label": "Por ti, Lisboa", "parties": ["psd", "cds-pp"],
  "election": "autarquicas-2025",                // results: /elections/:id/places/:key
  "term": { "start": "2025-10-12", "end": "2029-10-12" },  // end: when the next autárquicas are due
  "current": true,
  "otherRoles": [                                // other public roles, from our records, by full name
    { "kind": "candidate", "title": "Candidatura às Legislativas 2024", "detail": "Nº 7 da lista PPD/PSD.CDS-PP, Lisboa",
      "date": "2024-03-10", "current": false, "elected": true, "link": "/elections/legislativas-2024/candidates" }
  ],                                             // a seat in parliament shows as kind "deputy", link "/deputies/:id"
  "articles": [/* the 10 latest news naming them, as on /articles */],
  "updatedAt": "2026-11-17T20:42:04Z"
}
```

404 for unknown ids. **Page title:** "{shortName}, presidente da Câmara Municipal de {place}"
ranks for both their name and "presidente da câmara de X". In the sitemap they're kind
`local-official`. For IndexNow (`docs/seo.md`) the backend announces them as
`/autarcas/:id`; tell us if the route is different.

## What isn't there (yet)

- **Parishes restored in 2025:** about 300 parishes were split back out in 2025. They have
  results and pages, but `dicofre` is null (no code in our older data), so they can't be
  joined to boundary files by code yet.

- **Junta presidents (parishes) and vereadores:** the results site publishes only the head of
  each câmara list, so only mayors have ids and pages. We know which list won each junta
  (`elections`, organ `AF`) and each list's seats, but not the people. No other open source
  lists them; Diário da República notices are per municipality and not structured.
- Mayors before 2025.
- **Mayors' photos:** no official source publishes them in one place, so `mayor` has no
  `photoUrl`. Keep showing initials.

## Page ideas

- **Município page:** the mayor up top (photo: none from the source; use the party colour and
  initials), câmara composition as a seat bar, "Quem te representa no Parlamento" with the
  district's deputies, the last results, and a contracts box ("A câmara fez N contratos,
  X% por ajuste direto").
- **Map:** `GET /places` coloured by mayor's party; click → place page.
- Text for search: "Quem governa Coimbra? Presidente da câmara, vereadores, deputados e
  contratos públicos". Every page has the data to fill a unique title and description.
