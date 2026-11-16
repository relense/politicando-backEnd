# Legislatures API

Base URL: `/api/v2`. Spec at `/docs`.

One page per legislature (*legislatura*) of the Assembleia da República, from the
Constituent Assembly (1975) to today: who was elected, who governed, what parliament
proposed and passed, and what happened in those years, scandals included. Use it when someone
taps a legislature, for example on a deputy's career path (`pastLegislatures`), on the
history timeline or on an election.

Legislature ids are the parliament's: `"Constituinte"`, `"I"` … `"XVII"`.

## `GET /legislatures`

Every legislature, newest first. Good for a list or a strip of chips.

```json
{
  "items": [
    {
      "id": "XV",
      "name": "XV Legislatura",
      "start": "2022-03-29",
      "end": "2024-03-26",
      "current": false,
      "elections": ["legislativas-2022"],
      "primeMinisters": ["António Costa"],
      "initiatives": 2167,
      "events": 7
    }
  ]
}
```

- `end` is the day the next legislature first sat, and `null` for the current one.
- `elections` holds the `/elections/:id` that elected it. The I Legislatura has two
  (`legislativas-1976` and `legislativas-1979`): the 1979 interim election elected a parliament
  to finish the I's term.
- `primeMinisters` covers those who governed during it, oldest first. An outgoing government
  that stays on for a few days as caretaker isn't counted.

## `GET /legislatures/:id`

```json
{
  "id": "XV",
  "name": "XV Legislatura",
  "start": "2022-03-29",
  "end": "2024-03-26",
  "current": false,
  "primeMinisters": ["António Costa"],
  "elections": [
    {
      "id": "legislativas-2022", "name": "Legislativas 2022", "date": "2022-01-30", "totalMandates": 230,
      "seats": [{ "list": "PS", "name": "Partido Socialista", "partySlugs": ["ps"], "votes": 2301887, "mandates": 120 }]
    }
  ],
  "governments": [{ "code": "gc23", "name": "XXIII Governo Constitucional", "primeMinister": "António Costa", "...": "same shape as /governments/history" }],
  "presidents": [{ "id": "marcelo-rebelo-de-sousa", "name": "Marcelo Rebelo de Sousa", "termStart": "2016-03-09", "termEnd": "2026-03-09" }],
  "initiatives": {
    "submitted": 2167, "approved": 442, "rejected": 1102, "withdrawn": 70, "pending": 553, "laws": 167,
    "byAuthor": [{ "key": "pan", "name": "PAN", "partySlug": "pan", "submitted": 387, "approved": 58, "rejected": 213, "withdrawn": 5, "pending": 111 }]
  },
  "events": [
    {
      "date": "2023-11-07", "precision": "day", "kind": "controversy", "judicial": true,
      "title": "Operação Influencer e demissão de António Costa",
      "summary": "…",
      "sources": [{ "url": "https://eco.sapo.pt/…", "title": "…", "publisher": "ECO" }]
    }
  ],
  "cases": [{ "id": 3, "title": "…", "status": "accused", "statusDate": "2024-05-02", "startedAt": "2019-01-10" }]
}
```

404 `not_found` for an unknown id.

### Sections

- **`elections`**: the composition at the start, with `seats` listing the lists that won seats,
  most seats first. Draw a hemicycle from `totalMandates` (250, 263 or 230 depending on the
  year). Colour and link with `partySlugs`. Parties that no longer exist have `[]`.
- **`governments`**: the same objects as `/governments/history` (how each one ended is in
  `endReason` and `endNote`). `presidents` lists the Presidents in office during it; the
  Constituinte's is empty, since the President then wasn't elected under the Constitution.
- **`initiatives`**: what parliament had on its table.
  - `laws` counts approved *projetos* and *propostas de lei*.
  - `pending` means still being decided for the current legislature. For past ones it means
    the initiative **lapsed** (*caducou*) when the legislature ended, so label it that way.
  - `byAuthor`: an initiative co-signed by several parties counts for each, so the rows don't
    add up to the total. `partySlug` is set when we have a party page (`CDS` in the 1980s
    shows as `cds-pp`, `PPD` as `psd`). Other authors come by name: parties that no longer
    exist (PRD, UDP, MDP/CDE, ASDI, UEDS, ID, PSN), "Governo", the President of the Assembly,
    the regional assemblies, committees and citizens.
  - **The older the legislature, the less complete the record.** The open data has only 282
    initiatives for the III (1983–85) against about 2,000 a legislature recently, and none for
    the Constituinte. Say so on the page ("registo incompleto nos dados abertos do
    Parlamento") rather than drawing conclusions from the 1980s numbers.
- **`events`**: curated by hand, 5–10 per legislature: main laws and reforms, crises,
  controversies, and economic, international or social moments. Every event has at least one
  source; show them (e.g. "Fontes: ECO, RTP") with links.
  - `kind`: `law`, `policy`, `crisis`, `controversy`, `economy`, `international`, `society`.
    A filter or an icon per kind works well; "Polémicas" is `controversy`.
  - `precision`: `"month"` or `"year"` means only that much of the date is known (the day is
    set to 1). Show "junho de 1993" or "1990", not "1 de junho".
  - `judicial: true` marks a criminal case. Its summary gives the legal stage as of a date
    (arguido, acusado, condenado em primeira instância, absolvido, arquivado). Show the text
    as is, without shortening it in ways that drop the outcome.
  - Governments taking office or falling aren't repeated here; that's what `governments` is for.
- **`cases`**: published cases from the corruption record (`/cases/:id`) that started, or had
  something happen, during the legislature. The record is curated in the admin, so this is
  empty until cases are added. Events marked `judicial` are a separate, shorter
  history-book view.

## Page idea

Header with the dates and the hemicycle. Then "Quem governou" (governments and President),
"O que aconteceu" (a timeline of `events`, filterable by kind), "No Parlamento"
(`initiatives` with a bar per author) and "Casos na justiça" (`cases`). Link back to the
election (`/elections/:id`) and to the previous and next legislature.
