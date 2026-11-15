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
