# People API (career paths)

Base URL: `/api/v2`. Spec at `/docs`.

For a "how did they get here" page: one timeline per person, joining their records in
parliament, the Government and the Presidency. Everything comes from official sources: the
parliament's open data, portugal.gov.pt and presidencia.pt. Nothing is written by hand
except the dates of each legislature.

## `GET /people/featured`

Who to show first: the President, the Prime Minister, the President of the Assembleia, and
the party leaders who sit as deputies (biggest party first).

```jsonc
{ "items": [
  { "kind": "president", "id": "antonio-jose-seguro", "name": "António José Seguro",
    "role": "Presidente da República", "photoUrl": "https://www.presidencia.pt/…", "party": null },
  { "kind": "government", "id": "6d6019ae…", "name": "Luís Montenegro", "role": "Primeiro-Ministro", "photoUrl": "…", "party": null },
  { "kind": "deputy", "id": "6535", "name": "André Ventura", "role": "Presidente do CHEGA",
    "photoUrl": "…", "party": { "slug": "chega", "acronym": "CH" } }
] }
```

`party` is known only through a deputy record: Government members who aren't deputies,
including the Prime Minister now, have `null`.

## `GET /people/:kind/:id/path`

`kind` is `deputy` (id: the deputy's number), `government` (id: the member's 32-character
id) or `president` (id: e.g. `marcelo-rebelo-de-sousa`), the same ids as `/people/featured`.
A person who is both a deputy and a Government member gets the same answer from either.

```jsonc
{
  "person": {
    "name": "André Ventura",
    "photoUrl": "https://app.parlamento.pt/…",
    "party": { "slug": "chega", "acronym": "CH" },
    "links": { "deputyId": 6535, "governmentMemberId": null, "presidentId": null }  // other pages
  },
  "path": [                            // dated steps: ongoing first, then newest
    { "from": "2026-02-09", "to": null, "precision": "day",
      "title": "Deputado à Assembleia da República", "detail": "XVII legislatura, eleito por Lisboa",
      "kind": "parliament", "current": true, "source": "https://www.parlamento.pt/…BID=6535" },
    { "from": "2025-06-03", "to": "2025-12-31", "precision": "day", "…": "…" },   // a break: he suspended his seat
    { "from": "2024-03-26", "to": "2025-06-03", "precision": "legislature",
      "title": "Deputado à Assembleia da República", "detail": "XVI legislatura", "…": "…" }
  ],
  "currentRoles": [                    // held now, not dated by the source
    { "title": "Presidente do CHEGA", "kind": "party", "current": true, "…": "…" },
    { "title": "Membro da Comissão Permanente", "kind": "parliament", "…": "…" }
  ],
  "otherRoles": [                      // from their parliament biography, undated
    { "title": "Eleito Assembleia Municipal de Vila Franca de Xira", "kind": "local", "current": true, "…": "…" }
  ]
}
```

- `precision: "legislature"` means they sat at some point in that legislature, and
  `from`/`to` are the legislature's dates, not necessarily theirs. Show it as "XVI
  legislatura (2024–2025)" rather than as exact dates.
- `kind`: `parliament`, `government`, `presidency`, `party`, `local` (municipal and parish
  office) or `other`. Use it for icons or colours.
- Gaps between `day` steps in the same legislature are real: the deputy suspended their seat,
  for example to run for President or to join the Government.

### Limits, for now

- Deputies' earlier careers come from the current legislature's records, so they cover their
  past legislatures but not their roles in them. Government posts cover the current
  Government only, and Presidents show their term. So people with long careers outside the
  current parliament (the Prime Minister, the President) have short paths for now. Importing
  past legislatures and past Governments (planned) will fill these in.
- Party leaders are kept by hand (`src/parliament/leadership.ts`), since no open data says who
  leads each party.

## Records

Every path response also has `records`: the person's published cases in the corruption record
and how many declared interests we have. See `docs/cases-api.md` for the fields and for the
wording rules (presumption of innocence) that apply wherever these appear.
