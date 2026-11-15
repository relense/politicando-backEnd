# History API (governments since 1974, timeline)

Base URL: `/api/v2`. Spec at `/docs`.

For a "timeline of governments since the 25th of April" page. The history is curated in
`src/government/history.ts`:
- **Dates:** from the Government's list of heads of government on portugal.gov.pt
  (`source` in the response).
- **Parties, support and how each government ended:** historical record, summarised by hand.

## `GET /governments/history`

All 31 governments, newest first: six provisional ones (1974-76), then constitutional
governments I to XXV.

```jsonc
{
  "items": [{
    "code": "gc24",                    // gc01-gc25 constitutional, gp1-gp6 provisional
    "kind": "constitutional",
    "name": "XXIV Governo Constitucional",
    "primeMinister": "Luís Montenegro",
    "start": "2024-04-02",
    "end": "2025-06-05",               // the next one's first day; null while in office
    "days": 429,
    "parties": [{ "slug": "psd", "acronym": "PSD", "name": "…" }, { "slug": "cds-pp", … }],
    "support": "Coligação PSD e CDS-PP (AD), minoria",
    "endReason": "confidence_rejected",
    "endNote": "O Parlamento rejeitou uma moção de confiança, em março de 2025; eleições antecipadas em maio.",
    "portalUrl": "https://www.portugal.gov.pt/pt/gc24",   // from the XXI on; null before
    "current": false
  }],
  "source": "https://www.portugal.gov.pt/pt/gc25/governo/governos-anteriores/chefes-do-governo-desde-1821"
}
```

| `endReason` | Show as |
|---|---|
| `end_of_term` | Fim da legislatura |
| `early_election` | Eleições antecipadas |
| `censure` | Moção de censura aprovada |
| `confidence_rejected` | Moção de confiança rejeitada |
| `programme_rejected` | Programa do Governo rejeitado |
| `resignation` | Demissão do Primeiro-Ministro (novo governo sem eleições) |
| `dismissed` | Exonerado pelo Presidente |
| `death` | Morte do Primeiro-Ministro |
| `provisional` | Governo provisório |
| `in_office` | Em funções |

Page ideas:
- A horizontal bar per government, sized by `days` and coloured by the first party.
- Counters such as "only N governments lasted a full legislature" (`end_of_term`).
- Filter by Prime Minister.
- The current government links to `GET /government` for its members.

## `GET /timeline?from=&to=&kinds=`

Governments, elections and Presidents on one line, newest first.

- `kinds`: comma-separated `government`, `election`, `president`. Default: all.
- `from` / `to`: dates. A span counts if it overlaps the period.

```jsonc
{ "items": [
  { "kind": "president", "date": "2026-03-09", "endDate": null,
    "title": "Presidente da República: António José Seguro", "detail": null,
    "ref": { "kind": "president", "id": "antonio-jose-seguro" } },        // → /people/president/:id/path
  { "kind": "government", "date": "2025-06-05", "endDate": null, "title": "XXV Governo Constitucional",
    "detail": "Luís Montenegro. Coligação PSD e CDS-PP (AD), minoria", "ref": { "kind": "government", "id": "gc25" } },
  { "kind": "election", "date": "2025-05-18", "endDate": null, "title": "Legislativas 2025",
    "detail": "Mais votado: AD - COLIGAÇÃO PSD/CDS (32,54%)", "ref": { "kind": "election", "id": "legislativas-2025" } },  // → /elections/:id
  { "kind": "election", "date": "1979-12-02", "endDate": null, "title": "Legislativas 1979", "detail": null, "ref": null }
] }
```

- **Elections:** every legislativas since 1975, plus every election we have results for
  (since 2011: europeias, presidenciais, autárquicas). Elections before 2011 have no results
  (`ref: null`).
- **Presidents:** every President since 1976.
- The editorial events planned for later (crises, scandals, landmark laws) will appear here
  too, with `kind` values of their own. Ignore kinds you don't know.
