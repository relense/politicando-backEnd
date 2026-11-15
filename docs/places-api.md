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
| `contracts.council` | Municipalities: the câmara as a public buyer, `{ nif, name, count, total, directAwards }`. Link to `/contracts/parties/:nif`; show "ajustes diretos: N" |

Non-local places (`GLOBAL-…`, `FOREIGN-…`) still answer, with the place-specific sections
empty.

## What isn't there (yet)

- **Parishes restored in 2025:** about 300 parishes were split back out in 2025. They have
  results and pages, but `dicofre` is null (no code in our older data), so they can't be
  joined to boundary files by code yet.

- **Junta presidents (parishes):** the results site publishes candidates only for the câmaras,
  so we know which list won each junta (`elections`, organ `AF`) but not who leads it.
- **Councillors' names:** the same; we have each list's seats, not the people.
- Mayors before 2025.

## Page ideas

- **Município page:** the mayor up top (photo: none from the source; use the party colour and
  initials), câmara composition as a seat bar, "Quem te representa no Parlamento" with the
  district's deputies, the last results, and a contracts box ("A câmara fez N contratos,
  X% por ajuste direto").
- **Map:** `GET /places` coloured by mayor's party; click → place page.
- Text for search: "Quem governa Coimbra? Presidente da câmara, vereadores, deputados e
  contratos públicos". Every page has the data to fill a unique title and description.
