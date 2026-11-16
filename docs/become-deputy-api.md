# "How to become a deputy" page

Base URL: `/api/v2`. Spec at `/docs`.

The page is built from four endpoints:

1. **The rules:** `GET /explainers/become-deputy`. Sections in plain Portuguese, each with
   its legal basis, plus the seats per círculo from the latest legislativas.
2. **How seats are won:** `GET /elections/:id/dhondt?place=` (see `docs/elections-api.md`).
   The d'Hondt quotient table for a district, and how close each list came to one more seat.
3. **The lists:** `GET /elections/:id/candidates?place=` (see `docs/elections-api.md`).
   Real lists with the cut-off line, and who entered by replacement.
4. **Real paths:** `GET /people/featured` and `GET /people/:kind/:id/path` (see
   `docs/people-api.md`). Each deputy's path shows where they stood on the list
   (`kind: "election"`: "nº 3 da lista PS, círculo de Porto (eleito)").

## `GET /explainers/become-deputy`

```jsonc
{
  "title": "Como se chega a deputado",
  "reviewedAt": "2026-11-15",            // when the text was last checked against the law
  "sections": [{
    "id": "partidos",                    // stable: use it for anchors
    "title": "Só os partidos apresentam listas",
    "body": ["As listas de candidatos são apresentadas pelos partidos…", "…"],  // paragraphs
    "sources": [{ "label": "Constituição, art. 151.º", "url": "https://www.parlamento.pt/…" }]  // url may be null
  }],
  "circles": {                           // null until a legislativas is imported
    "election": "legislativas-2025",
    "items": [{ "key": "LOCAL-110000", "name": "Lisboa", "seats": 48 }, …]   // biggest first; 230 in all
  }
}
```

Sections, in order: `quem-pode`, `partidos`, `circulos`, `listas-fechadas`, `dhondt`,
`paridade`, `substituicoes`, `mandato`. The text lives in `src/explainers/becomeDeputy.ts`.
Show `sources` small under each section.

Suggested interactive bits: a map or bar chart of `circles` (seats per círculo); next to the
`dhondt` section, the quotient table for a small district (Portalegre, 2 seats) and a big one
(Lisboa, 48); next to `substituicoes`, a real list where someone below the line has a
`deputyId`.
