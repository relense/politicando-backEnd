# Corruption record and declared interests (for the frontend)

Two hand-curated records, written by our editors in the admin, each entry with its sources:

- **Cases**: judicial cases involving political officeholders (corruption, influence
  peddling, embezzlement...).
- **Declared interests**: officeholders' companies, shareholdings, jobs and clients, copied
  from their declarations. When we know the entity's NIF, we show the public contracts it won.

Only published entries are public. Base path: `/api/v2`.

## Wording rules (please follow them on every page)

These protect readers and us; we can be sued over this.

1. **Presumption of innocence.** Nobody is guilty until a conviction is final. When a
   person's `status.key` is `convicted` and `final` is `false`, always show "Decisão não
   transitada em julgado" (not yet final) next to it. For `arguido`, `accused` and
   `sent_to_trial`, show "Presume-se inocente".
2. **Show the stage, not a verdict.** Use the `label`s we send ("Acusado", "Em
   investigação"...) and offer `plain` as a tooltip or "o que significa?". Never write
   "corrupto", "culpado" or the like.
3. **Sources are always visible**, with publisher and date. Court and official sources first.
4. **Show `reviewedAt`**: "Revisto a 15 nov. 2026". Cases move; readers should know how fresh
   an entry is.
5. **Corrections**: add a "Pedir correção" link, to the feedback form (kind `error`) or a
   mailto to `info@politicando.pt`. People named have a right of reply.
6. **No scores or rankings of people.** Counts per party are fine with context (how many
   officeholders each party has had), but don't build a "most corrupt" list. An index will
   come later, with a public methodology.

## GET /cases/glossary

The vocabulary, each item as `{ key, label, plain }`:

- `crimes`: `corruption`, `influence_peddling`, `embezzlement`, `economic_participation`,
  `abuse_of_power`, `prevarication`, `money_laundering`, `tax_fraud`, `illegal_financing`,
  `other`
- `caseStatuses`: the stage of the case. `investigation`, `accusation`, `pre_trial`, `trial`,
  `ruled` (1st instance, appealable), `appeal`, `final`, `archived`, `prescribed`
- `personStatuses`: each person's own situation. `arguido`, `accused`, `sent_to_trial`,
  `convicted`, `acquitted`, `archived`, `not_sent_to_trial`, `prescribed`
- `interestKinds`: `company`, `shareholding`, `role`, `activity`, `client`

Good for a "Como funciona um processo" explainer: the `caseStatuses` in order are the path of
a case through the courts.

## GET /cases

Query: `party` (slug, at the time), `deputy` (id), `member` (Government member id), `status`,
`crime`, `page` (default 1), `limit` (1-50, default 20). Latest development first.

```json
{
  "items": [
    {
      "id": 1,
      "title": "Operação Exemplo",
      "crimes": [{ "key": "corruption", "label": "Corrupção", "plain": "…" }],
      "status": { "key": "accusation", "label": "Acusação deduzida", "plain": "O Ministério Público acusou formalmente. Uma acusação não é uma condenação." },
      "statusDate": "2026-05-01",
      "startedAt": "2024-02-10",
      "reviewedAt": "2026-11-15",
      "people": [
        {
          "name": "Maria Exemplo",
          "roleAtTime": "Ministra",
          "party": { "slug": "ps", "acronym": "PS" },
          "deputyId": null,
          "governmentMemberId": "maria",
          "status": { "key": "accused", "label": "Acusado", "plain": "O Ministério Público acusou-o formalmente. Presume-se inocente." },
          "final": false
        }
      ]
    }
  ],
  "total": 1
}
```

- `party` is the party **at the time**, which may differ from today's.
- `deputyId` and `governmentMemberId` link to `/people/deputy/:id/path` and
  `/people/government/:id/path` when the person is in our records.

## GET /cases/:id

Everything above, plus:

- `summary`: a plain-text paragraph or a few.
- `people[].outcome`: the sentence, for convictions, e.g. "4 anos de prisão, suspensa".
- `events`: `[{ date, description, sources }]`, oldest first as editors entered them; render
  as a timeline. `sources` are positions in `sources` ("[1]", "[2]").
- `sources`: `[{ position, url, title, publisher, publishedAt, kind }]`. `kind` is `court`,
  `official` (Ministério Público, police) or `news`.

404 for unknown or unpublished cases.

## On people's pages

`GET /people/:kind/:id/path` now has `records`:

```json
{
  "records": {
    "cases": [{ "id": 1, "title": "Operação Exemplo", "status": { "key": "accusation", "label": "Acusação deduzida" }, "personStatus": { "key": "accused", "label": "Acusado" }, "final": false }],
    "interests": 2
  }
}
```

Show a small "Registo" box: cases with the person's own status (rules above), and a link to
their declared interests when `interests > 0`.

## GET /interests

Query: `deputy`, `member` or `nif`. Entities that won the most in contracts come first.

```json
{
  "items": [
    {
      "id": 3,
      "personName": "Maria Exemplo",
      "deputyId": null,
      "governmentMemberId": "maria",
      "kind": { "key": "company", "label": "Empresa própria", "plain": "Empresa que detém ou fundou." },
      "entityName": "Exemplo, Lda",
      "nif": "501426230",
      "description": null,
      "startDate": "2025-01-01",
      "endDate": null,
      "declaredAt": "2025-07-01",
      "source": { "url": "https://entidadetransparencia.pt/…", "title": "Declaração única, 2025" },
      "contracts": {
        "won": { "count": 2, "total": 150 },
        "duringInterest": { "count": 1, "total": 50 }
      }
    }
  ]
}
```

- `contracts` is `null` when we don't know the NIF.
- `won`: every public contract the entity won, in our data (BASE, from 2024).
- `duringInterest`: those signed while the declared interest held (needs `startDate`).
- Link the entity to `/contracts/parties/:nif` and its contracts to
  `/contracts?supplier=:nif`.
- Wording: "A empresa X, declarada por Y, ganhou N contratos públicos (€…)". That's a fact.
  Don't imply wrongdoing: most such contracts are legal. Readers judge, with the sources.

## GET /interests/contracts

The same items, only those whose entity won public contracts, biggest totals first. This is
the "empresas de titulares de cargos com contratos públicos" page.

## Curating (admin, role moderator)

See `docs/admin-api.md` for sign-in. Every change is in the audit log, with the record before
and after.

### Cases

- `GET /admin/cases`: `{ items: [{ id, title, status, published, updatedAt }] }`, drafts
  included.
- `GET /admin/cases/:id`: the whole document as editors write it, plus `problems` (why it
  can't be published yet).
- `POST /admin/cases`: creates a draft. Returns 201 with the document and `problems`.
- `PUT /admin/cases/:id`: replaces the whole document. A published case must stay publishable
  (400 `not_publishable`); unpublish first for big rewrites.
- `POST /admin/cases/:id/publish` and `/unpublish`. Publishing returns 400 `not_publishable`
  with the reasons if there are problems.

The document (`POST`/`PUT` body):

```json
{
  "title": "Operação Exemplo",
  "summary": "…",
  "crimes": ["corruption"],
  "status": "accusation",
  "statusDate": "2026-05-01",
  "startedAt": "2024-02-10",
  "reviewedAt": "2026-11-15",
  "people": [
    { "name": "Maria Exemplo", "roleAtTime": "Ministra", "party": "ps", "deputyId": null, "governmentMemberId": "maria", "status": "accused", "outcome": null, "final": false }
  ],
  "events": [{ "date": "2026-05-01", "description": "O Ministério Público deduziu acusação.", "sources": [1] }],
  "sources": [{ "url": "https://…", "title": "Comunicado", "publisher": "Ministério Público", "publishedAt": "2026-05-01", "kind": "official" }]
}
```

Publish rules (`problems`):

- At least one source, and `reviewedAt` set.
- Each event cites sources that exist.
- A verdict (`ruled`, `appeal`, `final`, or anyone `convicted`/`acquitted`) needs a `court`
  or `official` source, not only news.
- `final: true` only on decisions; a `final` case needs every verdict marked final.

Unknown party slugs, deputy ids or Government member ids are rejected with 400
(`unknown_party`, `unknown_deputy`, `unknown_government_member`). To find ids, use
`/deputies`, `/government` and `/parties`.

### Declared interests

- `GET /admin/interests?deputy=&member=`: all, drafts included.
- `POST /admin/interests` and `PUT /admin/interests/:id`, with body
  `{ personName, deputyId, governmentMemberId, kind, entityName, nif, description, startDate, endDate, declaredAt, sourceUrl, sourceTitle, published }`.
  `nif` is 9 digits or null. `sourceUrl` is required (http/https).
- `DELETE /admin/interests/:id`: 204. The deleted record stays in the audit log.

Where to find declarations: the Entidade para a Transparência's platform
(entidadetransparencia.pt), one person at a time. Copy what is declared, link the
declaration, and add the NIF only when it's declared or you've checked it (e.g. on the
company's site or the official company publications).
