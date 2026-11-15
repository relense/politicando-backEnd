# Government API (Government page)

Base URL: `/api/v2` (locally `http://localhost:4000/api/v2`). The live OpenAPI spec is at `/docs`.
Data comes from the official Government portal, portugal.gov.pt, and is refreshed daily. It
covers the Prime Minister, ministers and secretaries of state, with past holders.
Text fields are stored as received: escape them when rendering.

Members of the Government are **not deputies**: they have their own IDs (32 hex characters,
the portal's), photos and pages. When someone was elected to this legislature and left
their seat to join the Government, `deputyId` links to their record (`GET /deputies/:id`).

## `GET /government`

One call for the whole page, ministries in protocol order (the order the portal uses).

```jsonc
{
  "government": {
    "code": "gc25",
    "name": "XXV Governo Constitucional",
    "startDate": "2025-06-05",
    "updatedAt": "2026-11-15T08:54:27.902Z"         // last sync
  },
  "primeMinister": { /* member, see below */ },
  "ministries": [
    {
      "area": "primeiro-ministro",                  // the PM's office comes first
      "name": "Primeiro-Ministro",
      "minister": { /* the Prime Minister */ },
      "secretaries": []                             // secretaries of state reporting to the PM, if any
    },
    {
      "area": "financas",
      "name": "Finanças",
      "minister": {
        "id": "f831cf8a3b3946edbd18cdf98253b3e2",
        "name": "Joaquim Miranda Sarmento",
        "title": "Ministro de Estado e das Finanças",
        "kind": "minister",                         // prime_minister | minister | secretary_of_state
        "gender": "M",                              // M | F | null
        "photoUrl": "https://edge.sitecorecloud.io/…/Joaquim-Miranda-Sarmento.jpg?h=1029&iar=0&w=800",
        "startDate": "2025-06-05",
        "endDate": null,                            // null while in office
        "deputyId": null,
        "party": null                               // party slug, only known via deputyId
      },
      "secretaries": [ /* members, kind "secretary_of_state", in the portal's order */ ]
    }
  ],
  "former": [                                       // people who left this government, latest first
    { /* member */ "name": "Maria Lúcia Amaral", "title": "Ministra da Administração Interna",
      "endDate": "2026-02-11", "areaName": "Administração Interna" }
  ]
}
```

- `minister` can be `null` if a ministry has no minister in office (e.g. between appointments).
- **Party is often unknown.** The portal doesn't publish party membership, and many members
  are independents. `party` is filled only when they have a deputy record. Don't infer it.
- Photos are portraits (about 800×1000) hosted by the portal. They're lighter than deputy
  photos, but still load them lazily.

## `GET /government/members/:id`

```jsonc
{
  "id": "6d6019aee9774dde80cc8342401a7065",
  "name": "Luís Montenegro",
  "gender": "M",
  "photoUrl": "https://…",
  "bio": ["Luis Montenegro nasceu no Porto…", "Licenciado em direito…"],  // official, plain-text paragraphs
  "links": [{ "network": "X", "url": "https://x.com/LMontenegro_PT" }],  // often empty except the PM
  "inOffice": true,
  "deputy": null,                                   // { id, name, party } when linked
  "positions": [                                    // every post held, latest first
    { "title": "Primeiro-Ministro", "kind": "prime_minister", "area": "primeiro-ministro",
      "areaName": "Primeiro-Ministro", "government": "gc25", "startDate": "2025-06-05",
      "endDate": null, "url": "https://portugal.gov.pt/pt/gc25/primeiro-ministro/acerca" }
  ],
  "articles": [ /* latest 10 articles naming them, same shape as /articles */ ]
}
```

404 for an unknown ID, 400 for a malformed one.

## News

- Every article now has `government: [{ id, name }]`, the members named in it.
- `GET /articles?governmentMember=<id>` lists their news, with the usual cursor paging.
- Matching uses the **full name** only ("Luís Montenegro"), so it misses articles that say just
  "Montenegro" or "o primeiro-ministro". Counts are a lower bound. A name shared with a sitting
  deputy isn't matched at all, because the news would mostly be about the deputy.
