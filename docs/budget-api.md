# State Budget votes API (for the frontend and the research workspace)

Base path: `/api/v2`. Every amendment proposal (proposta de alteração) to the State Budget
(Orçamento do Estado), and **how each party voted on it**: in committee (especialidade, COF), and
in the plenary when a proposal is called up (avocada). Split votes keep each part.

## Where it comes from

The parliament's open data, Dados Abertos › Orçamento do Estado
(`https://www.parlamento.pt/Cidadania/Paginas/DAOE.aspx`): one file per Budget, with the
proposals and each party's vote. The parliament updates it **the same day** during the voting
weeks. We read it every hour (`:35`), and only an unchanged file is skipped.

- **Years:** the hourly sync reads the current legislature's Budgets (OE2026, OE2027). Every
  Budget since 2006 has per-party votes and can be loaded once with
  `node dist/jobs/syncBudget.js --all`. OE2004 has proposals but no votes in the source, and the
  parliament publishes no file for OE2005.
- **Neutral:** only the parliament's data, in its own terms. Results are "approved", "rejected",
  "partially approved", never "won" or "lost". Its exact words are kept too (`status`, `label`).
- **Ambiguous votes:** when the source can't be read with certainty (a group we don't recognise,
  a vote value we don't know, a vote with no party lines, a vote that contradicts the result),
  the vote has `ambiguous: true` and `ambiguity` says why. We never guess. Show these with a
  note, e.g. "Dados incompletos na fonte oficial". OE2026 and OE2027 have 3 such votes out of
  about 2,900.
- **The Budget's own votes:** each year also has its bill (`bills`): the vote on the general
  principles (generalidade), the final overall vote (votação final global), and the rest, as on
  `/initiatives`. Bills go back to OE1983 (only some old ones have votes recorded). Parliament's
  files have no bill for OE2016 or OE2020, so those years have only their proposals.
- **Plain summaries ("O que muda"):** the source has only a title (usually the article it
  changes), a topic and the official PDF (`documentUrl`). After each hourly sync, a model (Claude
  Haiku) reads the PDFs of up to 200 proposals without a summary, latest votes first, and writes one
  or two neutral sentences (`plain`, `automatic: true`). A summary sent by a person through the
  publish key (`automatic: false`) is never replaced. A PDF that can't be read is tried again later,
  less often each time. The backlog is cleared in a few hours, or at once with
  `node dist/jobs/budgetSummaries.js --summaries=3000`.
- **News and statements:** with each summary the model also gives the words the press would use for
  the measure. The same step looks for articles we collected around the proposal's dates (a week
  before it was submitted to a month after its last vote) that use those words and read like Budget
  news, then has the model read each one (the full page, or the excerpt when it's closed). It decides
  whether the article is about **this** measure, and lists what the article reports parties or
  politicians saying about it. Each pair is judged once. A statement is only ever what an article
  says, always kept with that article. The article's text isn't stored. This is automatic and
  approximate: it favours a missing link over a wrong one. Needs `ANTHROPIC_API_KEY` on the
  `politicando-budget` cron; without it, this step is skipped.

## GET /budget

The Budgets we have, newest first: every year with amendment proposals or a bill.

```jsonc
{
  "items": [
    {
      "year": 2027, "proposals": 2919, "voted": 625, "pending": 2223, "lastVotedOn": "2026-11-19", "syncedAt": "…",
      "bills": [
        {
          "initiativeId": 377352, "legislature": "XVII", "number": "110", "title": "Orçamento do Estado para 2027",
          "status": "in_progress",           // approved, rejected, in_progress, withdrawn, lapsed
          "votes": [{ "date": "2026-10-28", "phase": "Votação na generalidade", "result": "Aprovado",
                      "favor": [{ "party": "psd", "count": null }], "against": […], "abstention": […], "absent": [], "named": [] }]
        }
      ]
    },
    { "year": 1995, "proposals": 0, "voted": 0, "pending": 0, "lastVotedOn": null, "syncedAt": null, "bills": [ … ] }
  ],
  "sourceUrl": "https://www.parlamento.pt/Cidadania/Paginas/DAOE.aspx"
}
```

- `pending` counts proposals still waiting for a vote, including those sent to the plenary.
- `voted` counts proposals with a vote, or with a result (approved, partially approved, rejected):
  the source sometimes gives the result without the vote itself (one proposal in 2027). So
  `voted` is at least `approved + partially_approved + rejected` in the summary's `results`.
- `bills`: the Budget's own bill. Usually one; **2022 has two**: the one rejected in October 2021
  (which led to early elections) and the one approved in 2022. Its votes have the same shape as
  on `/initiatives` (party slugs; `count` when only part of a group voted that way). Current
  bills have a page at `/iniciativas/:initiativeId`.
- Years before 2006 have a bill but no amendment proposals (`proposals: 0`, `syncedAt: null`).

## GET /budget/:year/proposals

`{ items, nextCursor, total }`, paged like `/articles` (pass `nextCursor` back as `cursor`).

| query | what |
| --- | --- |
| `party` | Proposals by this party (slug: `psd`, `chega`, `ps`, `il`, `livre`, `pcp`, `cds-pp`, `be`, `pan`, `jpp`), alone or with others |
| `result` | One or more, comma-separated. **`pending,sent_to_plenary` is everything still to be voted.** Values: `pending`, `sent_to_plenary`, `approved`, `partially_approved`, `rejected`, `withdrawn`, `not_admitted`, `superseded` (prejudicada), `unclear` (a status we don't know yet) |
| `topic` | Exactly as in `topics` ("Saúde"). The summary lists them |
| `q` | Words in the number, title, article or topics, ignoring accents |
| `votedFrom`, `votedTo` | Proposals with a vote in these days (`YYYY-MM-DD`): **a day's votes**. Items still carry all their votes; use each vote's `votedOn` |
| `sort` | `voted` (default: latest vote first, unvoted last) or `number` (the parliament's numbering) |
| `limit` | 1–100, default 20 |

Each item:

```jsonc
{
  "id": 28301,                       // the parliament's id
  "year": 2027,
  "number": "61C",
  "title": "Alínea f), N.º 1, … Artigo 9.º do Código do IRS",
  "article": "Artigo 9.º",
  "topics": ["Orçamento, Finanças e Administração Pública"],
  "target": "articles",              // or "tables" (the budget maps)
  "kind": "Substituição",            // as written: Aditamento, Substituição, Eliminação…
  "status": "Aprovado(a) em Comissão", // the source's words
  "result": "approved",
  "resultPhase": "committee",        // or "plenary", null
  "unanimous": false,
  "authors": {
    "parties": [{ "slug": "livre", "acronym": "L", "name": "LIVRE" }],
    "deputies": [],                  // deputies named without a group
    "label": "L"                     // as written: "PSD, CDS-PP"
  },
  "submittedOn": "2026-11-06",
  "lastVotedOn": "2026-11-19",
  "plain": { "summary": "Alarga a isenção a mais imóveis para alojamento de estudantes.", "automatic": true, "updatedAt": "…" },
  "documentUrl": "https://app.parlamento.pt/webutils/docs/doc.pdf?path=…",
  "sourceUrl": "https://www.parlamento.pt/Cidadania/Paginas/DAOE.aspx",
  "votes": [
    {
      "votedOn": "2026-11-19",
      "phase": "committee",
      "result": "approved",          // this vote's (or part's): approved, rejected, superseded, null
      "unanimous": false,
      "label": "Aprovado(a) em Comissão",
      "partLabel": "Aprovado(a)",
      "parts": [],                   // when voted in parts: ["Alínea a), N.º 1, Artigo 108.º"]
      "subject": null,
      "parties": [
        { "party": { "slug": "psd", "acronym": "PSD", "name": "Partido Social Democrata" }, "group": "Partido Social Democrata", "deputy": null, "vote": "favor" },
        { "party": { "slug": "psd", … }, "group": "Pedro Coelho(PSD)", "deputy": "Pedro Coelho", "vote": "against" }
      ],
      "ambiguous": false,
      "ambiguity": null
    }
  ]
}
```

- `plain`: "O que muda", or null. When `automatic` is true a model wrote it from the PDF: label it
  ("Resumo automático") next to the "PDF oficial" link. Without it, show the title and the PDF.
- `vote`: `favor`, `against`, `abstention` or `absent` (Favor, Contra, Abstenção, Ausente).
- `party` is null for an independent deputy (`group: "Não Inscrito"`), and when the source names a
  group we don't recognise (then the vote is `ambiguous`).
- **A deputy voting apart from their group** has their own line with `deputy` set (the Madeira
  PSD deputies often do). Show it under the party: "PSD: a favor (Pedro Coelho: contra)".
- **Split votes:** one entry per part, each with its own `parts` and `result`. The proposal's
  `result` is then usually `partially_approved`. A `superseded` part wasn't voted, so it has no
  party lines.
- Parties are listed in the source's order (by seats).

## GET /budget/:year/proposals/:id

One item, as above, plus its news and statements. 404 for an unknown id, or one from another year.

```jsonc
{
  …,                                   // every field of a list item
  "news": [
    { "id": 51234, "title": "Parlamento aprova PNAES 2.0", "source": "publico.pt", "url": "https://…", "publishedAt": "2026-11-19T15:00:00.000Z" }
  ],
  "statements": [
    {
      "party": { "slug": "pan", "acronym": "PAN", "name": "Pessoas–Animais–Natureza" },
      "speaker": "Inês de Sousa Real",  // null when it's the party's
      "text": "Diz que o plano é «urgente» para os estudantes deslocados.",
      "articleId": 51234, "articleTitle": "Parlamento aprova PNAES 2.0", "source": "publico.pt", "publishedAt": "…"
    }
  ]
}
```

- `news`: articles about this proposal, newest first (link to `/article/:id`). Often empty: most
  proposals never make the news. Hide the section when it's empty.
- `statements`: what parties and politicians said about it **according to the news**, newest first.
  `text` is a short quote (in «» or quotes, as the article has it) or a faithful paraphrase. Always
  show the source next to it ("segundo publico.pt", linking the article) and say these come from the
  news, not from the parliament's record. `party` is null when the article names no party, or one we
  can't tell apart (a coalition). Hide the section when it's empty.

## GET /budget/:year/summary

Totals for the year, or for some days with `votedFrom` / `votedTo` (then only proposals voted
in those days and only those votes count: **the daily summary**).

```jsonc
{
  "year": 2027, "votedFrom": "2026-11-19", "votedTo": "2026-11-19",
  "proposals": 81, "votes": 84, "ambiguousVotes": 0,
  "results": { "approved": 11, "rejected": 70, "partially_approved": 0, "pending": 0, … },
  "parties": [
    {
      "party": { "slug": "ps", "acronym": "PS", "name": "Partido Socialista" },
      "proposals": 8,                                   // it authored, alone or with others
      "results": { "approved": 4, "rejected": 4, … },   // of those
      "votesOnOthers": { "favor": 12, "against": 15, "abstention": 48, "absent": 0 }
    }
  ],
  "topics": [{ "topic": "Saúde", "proposals": 12 }],
  "lastVotedOn": "2026-11-19", "syncedAt": "…",
  "bills": [ … ],                                       // as on GET /budget
  "schedule": [
    { "id": "ar-48688", "title": "Comissão de Orçamento, Finanças e Administração Pública", "kind": "committee", "stage": "committee",
      "startsAt": "2026-11-20T15:00:00.000Z", "endsAt": null, "allDay": false, "started": false },
    { "id": "ar-48677", "title": "Discussão de artigos remetidos a Plenário e normas avocadas", "kind": "parliament", "stage": "final_vote",
      "startsAt": "2026-11-24T10:00:00.000Z", "endsAt": null, "allDay": false, "started": false }
  ],
  "sourceUrl": "…"
}
```

- `schedule`: **when the remaining votes happen.** The parliament doesn't say on which day each
  proposal will be voted, only which sessions are for Budget votes. While proposals are still
  waiting, this lists those sessions in the next 14 days (from `/agenda`: the Budget committee,
  the plenary's "normas avocadas", the final overall vote). It's empty once everything is voted,
  and on a day's summary (`votedFrom`/`votedTo`).
- `stage`: what the session is for. `committee` (committee votes), `plenary` (proposals called
  up to the plenary, "normas avocadas"), `general_vote` (the debate and vote on the general
  principles), `final_vote` (**the session that ends with the final overall vote**: show its
  date in the header ahead of time), or null. The parliament's agenda rarely writes "votação final
  global": that vote closes the session whose agenda reads "Encerramento do debate na
  especialidade", so that session is `final_vote`. If none is `final_vote`, the agenda doesn't
  show it yet.
- `started`: the session has already begun. A session stays listed until it ends; the parliament
  almost never gives an end time (`endsAt` is then null), so a started session stays until the
  end of its day. Show "Começou às 10h00", not "a decorrer": we can't know it is still running.

- `votesOnOthers` counts the group's own line on each vote (each part counts) on proposals it
  didn't author. A deputy voting apart doesn't change it.
- `parties` are ordered by seats, then acronym: not by how many proposals passed.

All four answers are public and cached for 5 minutes. The site is told to refresh (tag
`budget`, `docs/revalidate.md`) whenever the parliament's file changes.
