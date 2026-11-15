# Parties API (party list, "by power")

Base URL: `/api/v2`. Spec at `/docs`.

## `GET /parties?sort=name|seats|votes`

Every party we follow. `sort` defaults to `name`. `seats` and `votes` put the most first,
with ties in name order.

```jsonc
[{
  "slug": "psd",
  "acronym": "PSD",
  "name": "Partido Social Democrata",
  "website": "https://www.psd.pt/",
  "assemblySeats": 89,                 // seats in parliament now
  "seatsAsOf": "2026-10-08",
  "governmentMembers": 14,             // people in the Government in office, see below
  "lastElection": {                    // latest legislativas with results; null if it didn't run
    "id": "legislativas-2025",         // GET /elections/legislativas-2025
    "date": "2025-05-18",
    "votes": 2008437,
    "validPct": 33.15,
    "mandates": 91,
    "lists": ["PPD/PSD.CDS-PP", "PPD/PSD.CDS-PP.PPM"],
    "coalition": true
  },
  "leader": {                          // null for parties without seats
    "name": "Luís Montenegro",
    "title": "Presidente do PSD",
    "deputyId": null,                  // set: link to /deputados/:id
    "governmentMemberId": "6d6019…",   // set: link to the Government member page
    "photoUrl": "https://…",           // null when we have no photo (BE, JPP leaders)
    "asOf": "2026-11-15"               // when the curated list was last checked
  }
}]
```

- **Coalitions:** a party that ran in a coalition gets the coalition's whole result, and
  so does each partner. PSD, CDS-PP and PPM all show the AD's 2 million votes, with
  `coalition: true`. Say "in coalition" next to these numbers rather than adding them up.
  `mandates` are the coalition's seats too; `assemblySeats` is the party's own.
- `votes` and `validPct` are summed over every list the party ran in: the AD ran under two
  names in 2025, with PPM in the Açores.
- `governmentMembers` counts people in office whose deputy record belongs to the party.
  Members who were never deputies aren't counted, so it's a lower bound: show it as
  "at least", or only as "in Government" when it's above zero.

- `leader` is curated by hand (no open source says who leads each party), for the ten
  parties with seats. A leader can be outside parliament: Montenegro and Nuno Melo link to
  their Government pages; the BE and JPP leaders have no page of ours, so show the name only.

## `GET /parties/:slug/votes`

How the party voted in parliament, newest first. Query: `phase` (`deciding`, the default:
votes that decide an initiative such as generalidade and votação final global; or `all`),
`position` (`favor`, `against`, `abstention`, `absent`, `split`), `page`, `limit` (≤ 100).
Paging is by page number, not cursor: `total` counts the matching votes, so the number of pages is
`ceil(total / limit)`.

```jsonc
{
  "party": { "slug": "ps", "acronym": "PS", "name": "Partido Socialista" },
  "legislature": "XVII",
  "summary": { "total": 2025, "favor": 1184, "against": 282, "abstention": 550, "absent": 0, "unknown": 9, "split": 36 },
  "agreement": [                       // other parties with seats, most aligned first
    { "party": { "slug": "jpp", "acronym": "JPP" }, "compared": 1823, "same": 1108, "pct": 60.8 }
  ],
  "items": [{
    "initiative": { /* initiative summary, as in GET /initiatives */ },
    "vote": { "id": "193280", "date": "2026-10-28", "phase": "Votação final global", "result": "Aprovado", "unanimous": false },
    "position": "favor",               // favor | against | abstention | null
    "split": false,                    // part of the group voted otherwise
    "basis": "group"                   // group | unanimous | absent | unknown
  }],
  "total": 2025
}
```

- The parliament records votes **by group**, so this is the group's position. When a group
  split ("3-PS" for, "PS" abstaining), `position` is what the group as a whole did and
  `split` is true: say "a maioria absteve-se; 3 deputados votaram a favor". The deputies
  who broke ranks are in the initiative's votes (`GET /initiatives/:id`, `named`).
- `basis: "unanimous"`: approved unanimously with no breakdown, counted as favour.
  `unknown`: the party isn't in the record for that vote (e.g. it had no group then).
- `agreement` leaves out unanimous votes (or everyone would look aligned) and votes where
  either party's position is unknown. `pct` is null when there's nothing to compare.
- Ideas: a "vota mais vezes com…" bar chart from `agreement`; a tab on the party page with
  the list, filtered by position; the `summary` as a stacked bar.
