# Parliament API (hemicycle page)

Base URL: `/api/v2` (locally `http://localhost:4000/api/v2`). The live OpenAPI spec is at `/docs`.
All data comes from the Assembleia da República's open data and is refreshed daily.
Text fields are stored as received: escape them when rendering.

## Seats: official blocks, estimated chairs

- **Known, official:** which party owns each of the 230 seats. The map is in
  Deliberação n.º 5-PL/2025 (approved 18 June 2025).
- **Not published:** which deputy sits in which chair. Each group decides that
  internally, so the backend **estimates** it. Within each party's official block the most
  important deputies take the front rows, nearest the middle of the block. Importance comes
  from party leaders, parliamentary group leaders, Mesa and committee posts, the Comissão
  Permanente and seniority. Every seat has a deputy.
- Estimated seats have `estimated: true` on the seat and `seatEstimated: true` on the deputy.
  Say so in the UI, e.g. "Lugar aproximado". If real seating data arrives, those flags turn
  `false` and no API change is needed.
- `positions` lists a deputy's official posts, most important first (e.g. "Líder do grupo
  parlamentar", "Presidente da Comissão de Saúde"). These are good for the seat tooltip.

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
      { "number": 1, "group": "PCP", "party": "pcp", "x": 0.2809, "y": 0.6186, "deputyId": 817, "estimated": true }
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
      "seat": 19,
      "seatEstimated": true,                       // seat estimated by importance, not official
      "positions": ["Líder do grupo parlamentar"], // official posts, most important first
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
- `gender`: `"M"`, `"F"` or `null`, from the parliament's records (every deputy has it). Use
  it for "Deputado" / "Deputada", "eleito" / "eleita".

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
  "links": [                                       // from Wikidata, by the parliament's own ID; [] when none
    { "network": "Website", "url": "https://…" },  // order: Website, Wikipedia, X, Instagram, Facebook, Wikidata
    { "network": "Wikipedia", "url": "https://pt.wikipedia.org/wiki/…" },
    { "network": "Wikidata", "url": "https://www.wikidata.org/wiki/Q…" }
  ],                                               // put every url in the JSON-LD Person's sameAs
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
`presidency` (`pending` | `promulgated` | `vetoed`: what the President did),
`topic` (a slug from `GET /initiatives/topics`),
`coverage` (`none` | `some`: whether any news was found about it), `cursor`, `limit`
(1-50, default 10). Returns `{ items, nextCursor }`.

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
                "result": "Aprovado", "unanimous": false },  // null if never voted
  "presidency": {                                  // null until parliament sends it to Belém
    "status": "promulgated",                       // pending | promulgated | vetoed
    "sentAt": "2025-12-18", "promulgatedAt": "2025-12-22", "vetoedAt": null,
    "by": "Marcelo Rebelo de Sousa"                // President who decided (or is deciding)
  },
  "coverage": { "articles": 8, "sources": 6, "lastAt": "2026-11-14T20:20:00.000Z" },
  "topics": [{ "slug": "impostos", "label": "Impostos" }],   // [] when none fits
  "plain": {                                       // plain-language reading, see below
    "title": "Orçamento do Estado para 2026",
    "type": { "label": "Proposta de lei do Governo", "explainer": "Uma lei nova…", "makesLaw": true },
    "status": { "label": "Aprovada e publicada", "stage": "published" }
  }
}
```

`presidency` is the President's decision, taken from the parliament's own stages. Status
is the latest: a law that was vetoed, passed again by parliament and then promulgated
shows `promulgated`, but keeps `vetoedAt`. Show "vetado e depois promulgado" when both
dates are set.

**One initiative, several decrees.** Sometimes one initiative becomes several decrees, each
decided on its own. For example, initiative 315160 became the Nationality Law (decree 48,
promulgated) and a Penal Code change (decree 49, vetoed). Then:

- `presidency.decrees` lists each current decree: `{ number: "48/XVII", status, sentAt, promulgatedAt, vetoedAt }`.
  A decree that was vetoed and later passed again under a new number isn't listed.
- `status` is `promulgated` if any of them became law. Otherwise it's `pending` if any is still
  in Belém, and `vetoed` only if all were vetoed.
- `partial: true` means they ended differently. Show e.g. "Promulgada em parte: 1 de 2 decretos
  vetado", rather than "Vetada" or a bare "Promulgada".

`decrees` and `partial` are left out for a single decree. Only parliament decrees appear here; Government decrees don't pass through
the parliament's data. More in `docs/presidency-api.md`.

`coverage` is how much news we found about it. See "News about an initiative" below
for how approximate that is.

What the statuses mean:
- `approved`: passed its final vote, or published.
- `rejected`: its latest deciding vote failed.
- `in_progress`: everything else, including bills approved "na generalidade" that are
  still in committee.
- `withdrawn`: the authors withdrew it.

### Easy to understand: `plain` and `topics`

Every initiative summary, here and on deputy and President pages, has a `plain` reading
for readers who don't know parliamentary jargon. It comes from fixed rules, with no AI, so
it is predictable but never smarter than the title.

- `plain.title`: the title without the legal boilerplate. Parentheses citing the laws it
  changes are dropped, and so are trailing ", alterando a Lei n.º…" / ", procedendo à
  terceira alteração…" clauses. "Procede à alteração do Decreto-Lei n.º X, que define Y"
  becomes "Altera a lei que define Y". Show it as the headline, with `title` as the full
  official title underneath or on the detail page.
- `plain.type`: what this kind of initiative is. `label` replaces the official type name
  ("Projeto de Resolução" → "Recomendação"). Put `explainer` in a tooltip or an info box.
  `makesLaw: false` means approving it changes no law: a recommendation to the Government
  or an internal decision. Worth a visible hint, because approved recommendations are
  often mistaken for laws.
- `plain.status`: where it stands, in one phrase. `stage` is for icons or a progress bar:

| `stage` | Meaning |
|---|---|
| `submitted` | Entered, waiting to be debated |
| `committee` | Being examined by a committee |
| `consultation` | Public consultation, or waiting for an opinion (e.g. the autonomous regions) |
| `debate` | Scheduled or being debated in plenary |
| `approved_in_principle` | Passed the first vote (*generalidade*); the details are being worked out |
| `approved` | Passed its final vote |
| `awaiting_president` | Sent to the President, who hasn't decided yet |
| `vetoed` | Vetoed by the President |
| `promulgated` | Promulgated, waiting for publication |
| `published` | Published in the Diário da República (for recommendations: approved) |
| `rejected` / `not_admitted` / `withdrawn` | Ended without approval |

- `topics`: subjects found in the title by keyword, such as Habitação, Saúde or Impostos.
  About one in five initiatives fits none: show them under "Outros".

### Stage, search, sort and counts (new)

- `?stage=` filters by the step on the law's path: `submitted` (Entregue), `debate` (Em
  debate), `approved` (Aprovada), `president` (No Presidente), `vetoed` (Vetada), `published`
  (Lei), `rejected` (Rejeitada), `withdrawn` (Retirada). Each summary has the same key in
  `plain.status.group`.
- `?q=` searches title words (Portuguese stemming, so "habitação" finds "habitacional") or
  the exact number ("78").
- `?sort=newest|oldest` by latest activity. The cursor works both ways.
- The response now has `total` (everything matching the filters) and `stages:
  [{ key, label, plain, count }]`. Stage counts apply every filter **except** `stage`, so tabs
  keep their numbers when one is selected.
- `plain.title` is now `null` when there's nothing to simplify (about 90% of titles). Show
  the official title then, without repeating it.

### Presidency fields (new)

- `promulgationRecorded: false`: parliament's record skips the promulgation, but the law was
  published in the Diário da República, so it was promulgated. `promulgatedAt` is null then;
  show the publication date (`publishedAt`). Initiative 78 was one of these: it showed as
  "pending" for months but became law on 19 August 2026.
- `vetoKind`: `political` (the President's own objection) or `unconstitutionality` (after a
  Constitutional Court ruling), for the latest veto. `constitutionalCourt: [{ ruling, url }]`
  links the rulings.
- `vetoes: [{ date, kind, constitutionalCourt }]`: every veto, oldest first. The nationality
  law was vetoed after rulings 1133/2025 and 1134/2025, passed again, and vetoed again
  politically.
- **Not available:** when a law is *sent* to the Constitutional Court. Parliament's data only
  shows the ruling, cited on the veto. So while a decree is pending we can't tell if the
  deadline is paused. Show "à espera" with the date it arrived, without calling it late.

## `GET /initiatives/topics`

```jsonc
{ "items": [{ "slug": "habitacao", "label": "Habitação e urbanismo", "count": 105 }, …],  // fixed order
  "untagged": 492 }
```

Use it for topic chips. Then `GET /initiatives?topic=habitacao`.

## `GET /initiatives/:id`

The summary above plus `legislature`, `articles` (the 10 latest news articles about it)
and every vote:

```jsonc
"votes": [{
  "id": "182922", "date": "2026-09-25", "phase": "Votação na generalidade",
  "result": "Rejeitado", "unanimous": false,
  "favor":      [{ "party": "ps", "count": 1 }, { "party": "livre", "count": null }],
  "against":    [{ "party": "psd", "count": null }],
  "abstention": [{ "party": "ps", "count": null }],
  "absent": [],                                    // groups recorded as absent
  "named": [{ "name": "Pedro Delgado Alves", "group": "PS", "position": "favor" }]
}]
```

- Votes are recorded **by party**. `count: null` means the whole group. A number means
  only that many of its deputies (here 1 PS deputy voted for, the rest of PS abstained).
- `named` lists deputies the parliament names because they voted apart from their group.
- For one deputy's votes, use `GET /deputies/:id/votes` (below) rather than working
  them out yourself.
- `party` is our slug, or the parliament's acronym for groups we don't list
  (e.g. independents, `Ninsc`).

## `GET /deputies/:id/votes`

How a deputy voted, newest first, paginated (`cursor`, `limit` 1-50, default 20). Only
votes from when they were sitting are included.

```jsonc
{
  "summary": { "favor": 1449, "against": 292, "abstention": 568, "absent": 0, "unknown": 30, "brokeRanks": 7 },
  "items": [{
    "initiative": { "id": 377001, "type": "Projeto de Lei", "number": "412", "title": "...", "status": "approved" },
    "vote": { "id": "190221", "date": "2026-10-28", "phase": "Votação na generalidade", "result": "Aprovado" },
    "position": "favor",                            // null when not known
    "basis": "group"
  }],
  "nextCursor": "..."
}
```

The parliament votes by group and doesn't list every deputy's vote, so `basis` says how
each position is known. Show it in the UI (e.g. "voted with PS" vs "voted apart from
their group"):
- `named`: the record names them. These are the votes where they broke ranks.
- `group`: their whole group voted this way and they weren't named as an exception.
- `unanimous`: unanimous vote, recorded without a breakdown.
- `absent`: their group was recorded as absent (`position: null`).
- `unknown`: their group split without naming who voted which way (`position: null`).

## News about a deputy

- Every article in `/articles` now has `deputies: [{ id, name, party }]`, next to `parties`.
- `GET /articles?deputy=7341` returns the news about one deputy (404 if unknown).

Articles are linked when they mention the deputy's full parliamentary name
("Francisco César"), or a short name the press uses for party leaders ("Ventura",
"Carneiro", "Aguiar-Branco"). Common surnames only count when the article also names the
deputy's party. Other surname-only mentions aren't linked.

## News about an initiative

- Every article in `/articles` has `initiatives: [{ id, type, number, title }]`.
- `GET /articles?initiative=377352` returns the news about one initiative (404 if unknown).
- Initiatives carry `coverage`, and `GET /initiatives?status=approved&coverage=none` lists
  approved initiatives nobody wrote about.

**This is approximate, so label it in the UI** (e.g. "notícias relacionadas"). The press
almost never cites an initiative's number, so links come from shared keywords between
the article and the official title. On the first 218 articles it linked 14, about 12 of
them correctly. It misses stories that describe a law in very different words from its
title, and it only sees the 20 outlets we scan. "No coverage" means "no articles found
in our sources", not "the media ignored it".
