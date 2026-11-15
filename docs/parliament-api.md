# Parliament API (hemicycle page)

Base URL: `/api/v2` (locally `http://localhost:4000/api/v2`). The live OpenAPI spec is at `/docs`.
All data comes from the Assembleia da República's open data and is refreshed daily.
Text fields are stored as received: escape them when rendering.

## Seats: what is and isn't known

- **Known, official:** which party owns each of the 230 seats. The map is in
  Deliberação n.º 5-PL/2025 (approved 18 June 2025). `GET /parliament` returns every
  seat with its position and party.
- **Not published:** which deputy sits in which chair. Each group decides that
  internally. `seat` on a deputy and `deputyId` on a seat are `null` until a reliable
  source exists. Don't invent a mapping. Suggested UI: clicking a seat opens that
  party's block (its list of deputies), and clicking a deputy opens their profile.
  When the data arrives, the fields fill in and no API change is needed.

## `GET /parliament`

One call with everything the hemicycle needs.

```jsonc
{
  "legislature": "XVII",
  "updatedAt": "2026-11-15T07:32:10.813Z",        // last parliament sync
  "seatMap": {
    "source": "Deliberação n.º 5-PL/2025",
    "width": 1,
    "height": 0.6223,                              // x is 0..1, y is 0..height
    "seats": [
      { "number": 1, "group": "PCP", "party": "pcp", "x": 0.2809, "y": 0.6186, "deputyId": null }
      // 230 seats
    ]
  },
  "groups": [                                      // left to right, as in the chamber
    { "group": "PS", "party": { "slug": "ps", "acronym": "PS", "name": "Partido Socialista" }, "seats": 58 }
  ],
  "deputies": [                                    // the 230 sitting deputies, by name
    {
      "id": 7341,                                  // parliament's ID, stable for life
      "name": "Francisco César",
      "group": "PS",                               // as the parliament writes it
      "party": "ps",                               // our party slug (null for independents)
      "constituency": "Açores",
      "seat": null,
      "parliamentRole": null,                      // e.g. "Vice-Presidente"
      "photoUrl": "https://app.parlamento.pt/webutils/getimage.aspx?id=7341&type=deputado"
    }
  ],
  "initiativeCounts": { "approved": 620, "rejected": 853, "in_progress": 859, "withdrawn": 29 }
}
```

How to draw it:
- The map is drawn as the public sees the chamber: left-wing parties on the left, the
  back row at `y = 0`, the rostrum and front rows at large `y`. Use `x, y` as floor
  positions for the 3D view. Distance from `(0.5, ~0.62)` approximates the row, if you
  want to raise the back rows.
- Colour each seat by `party`, the same slug used across the API and the frontend.
- `group` uses the parliament's acronyms (`CH`, `L`, `BE`). Use `party` for links and
  colours.

**Photos are big** (often 0.5 MB each, served by parlamento.pt). Load a photo only
when a deputy is hovered or opened, never all 230 at once.

## `GET /deputies/:id`

```jsonc
{
  // ...the same fields as in /parliament, plus:
  "fullName": "Francisco Miguel Vital Gomes do Vale César",
  "partyInfo": { "slug": "ps", "acronym": "PS", "name": "Partido Socialista" },
  "situation": "Efetivo",                          // or "Suspenso(Eleito)", "Renunciou"...
  "active": true,                                  // sitting now
  "gender": "M",
  "birthDate": "1978-11-11",
  "profession": "Economista (não inscrito na ordem)",
  "education": [{ "course": "Economia", "completed": true }],
  "roles": [{ "title": "Presidente do PS-Açores", "current": true }],
  "committees": [{ "name": "Comissão de Agricultura e Pescas", "acronym": "CAPes",
                   "membership": "Suplente", "role": null }],
  "pastLegislatures": ["XVI", "XV"],
  "initiatives": { "total": 20, "approved": 1, "latest": [/* 10 initiative summaries */] },
  "articles": [/* the 10 latest news articles about them, same shape as /articles */]
}
```

404 if the ID is unknown. Deputies who left (resigned, suspended) still have a profile
with `active: false`.

## `GET /initiatives`

The "diplomas" section. Newest activity first, paginated like `/articles`.

Query: `status` (`approved` | `in_progress` | `rejected` | `withdrawn`), `party`
(author party slug), `deputy` (author deputy ID), `type` (e.g. `Projeto de Lei`),
`cursor`, `limit` (1-50, default 10). Returns `{ items, nextCursor }`.

- "Up for discussion" = `status=in_progress`.
- "Approved" = `status=approved`. `publishedAt` is set once it's published in the
  Diário da República.

```jsonc
{
  "id": 315671,
  "type": "Proposta de Lei",
  "number": "37",
  "title": "Orçamento do Estado para 2026",
  "status": "approved",
  "phase": "Lei (Publicação DR)",                  // latest stage, in Portuguese
  "phaseDate": "2025-12-30",
  "submittedAt": "2025-10-09",
  "publishedAt": "2025-12-30",
  "textUrl": "https://app.parlamento.pt/webutils/docs/doc.pdf?path=...",
  "authors": {
    "parties": [],                                 // [{ slug, acronym, name }]
    "deputies": [],                                // [{ id, name, party }]
    "other": "Governo"                             // or a regional assembly, citizens...
  },
  "lastVote": { "date": "2025-11-28", "phase": "Votação final global",
                "result": "Aprovado", "unanimous": false }   // null if never voted
}
```

What the statuses mean:
- `approved`: passed its final vote, or published.
- `rejected`: its latest deciding vote failed.
- `in_progress`: everything else, including bills approved "na generalidade" that are
  still in committee.
- `withdrawn`: the authors withdrew it.

## `GET /initiatives/:id`

The summary above plus `legislature` and every vote:

```jsonc
"votes": [{
  "id": "182922", "date": "2026-09-25", "phase": "Votação na generalidade",
  "result": "Rejeitado", "unanimous": false,
  "favor":      [{ "party": "ps", "count": 1 }, { "party": "livre", "count": null }],
  "against":    [{ "party": "psd", "count": null }],
  "abstention": [{ "party": "ps", "count": null }],
  "named": [{ "name": "Pedro Delgado Alves", "group": "PS", "position": "favor" }]
}]
```

- Votes are recorded **by party**. `count: null` means the whole group. A number means
  only that many of its deputies (here 1 PS deputy voted for, the rest of PS abstained).
- `named` lists deputies the parliament names because they voted apart from their group.
- A deputy's own vote = their entry in `named` if they're there, otherwise their
  party's position with `count: null`. When a party split without naming anyone, an
  individual's vote isn't known.
- `party` is our slug, or the parliament's acronym for groups we don't list
  (e.g. independents, `Ninsc`).

## News about a deputy

- Every article in `/articles` now has `deputies: [{ id, name, party }]`, next to `parties`.
- `GET /articles?deputy=7341` returns the news about one deputy (404 if unknown).

Articles are linked when they mention the deputy's full parliamentary name
("Francisco César"). Surname-only mentions ("Ventura diz...") are not linked yet.
