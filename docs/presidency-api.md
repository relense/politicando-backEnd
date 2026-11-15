# Presidency API (President of the Republic page)

Base URL: `/api/v2`. Spec at `/docs`.

In Portugal the President is head of state, not head of government: the Government (see
`docs/government-api.md`) runs the country. The President's main everyday power is over
laws: he **promulgates** them (they then go to the Diário da República) or **vetoes** them
(back to parliament, which can pass them again, in which case he must promulgate). He can
also send a law to the Constitutional Court first, appoint the Prime Minister, and dissolve
parliament. A short "what does the President do" explainer on the page will help readers.

## `GET /president`

```jsonc
{
  "president": {
    "id": "antonio-jose-seguro",
    "name": "António José Seguro",
    "fullName": "António José Martins Seguro",
    "termStart": "2026-03-09",
    "bio": ["António José Martins Seguro nasceu a 11 de março de 1962…", "…"],  // official, plain text
    "photoUrl": "https://www.presidencia.pt/media/…jpg?…&width=800&height=533",  // landscape photo
    "url": "https://www.presidencia.pt/presidente-da-republica/o-presidente/biografia/"
  },
  "legislation": {                     // parliament decrees only, during his term
    "promulgated": 92,
    "vetoed": 2,                       // includes laws parliament later passed again
    "pending": 1,                      // waiting for his decision right now
    "latestVetoes": [ /* initiative summaries, as in /initiatives */ ],
    "latestPromulgated": [ /* … */ ],
    "pendingNow": [ /* … */ ]
  },
  "articles": [ /* latest 10 articles naming him */ ],
  "former": [{ "id": "marcelo-rebelo-de-sousa", "name": "Marcelo Rebelo de Sousa",
               "termStart": "2016-03-09", "termEnd": "2026-03-09" }]
}
```

- Every initiative has a `presidency` object (see `docs/parliament-api.md`), and
  `GET /initiatives?presidency=vetoed|promulgated|pending` lists them.
- Government decrees aren't covered yet: they aren't in the parliament's data. They're
  announced on presidencia.pt, which could be added later.

### New fields

- `president.birthDate`, `birthPlace`, `residence`: read from the official biography
  ("nasceu a 11 de março de 1962, em Penamacor", "reside nas Caldas da Rainha"). Null when
  the biography doesn't say it that way.
- `legislation.allTime`: `{ since, promulgated, vetoed, vetoedUnconstitutional, pending,
  byPresident: [{ id, name, promulgated, vetoed }] }` over every decree in our data. Our data
  starts with the current legislature (`since`, July 2025), so it spans Marcelo and Seguro.
  Label it "desde julho de 2025", not "desde sempre". `vetoed` counts each veto, so a law
  vetoed twice counts twice.

## News

- Articles have `president: { id, name } | null`.
- `GET /articles?president=antonio-jose-seguro` lists his news.
- Matched by full name, and by "Seguro" only when the article is about the presidency
  (mentions "Presidente da República", Belém, promulgation or vetoes). That keeps
  insurance stories ("seguro de saúde") out.
