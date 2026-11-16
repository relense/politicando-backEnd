# Public contracts API (for the frontend)

Public contracts from **BASE** (base.gov.pt), the portal where every public body must publish
the contracts it signs. The data is IMPIC's open data on dados.gov.pt, imported weekly. It
covers what public bodies *report*: late or missing reports are not our gaps to fill. Always
link to the contract on BASE (`baseUrl`) and credit the source ("Fonte: Portal BASE / IMPIC").

All amounts are **euros without VAT**, as BASE publishes them. Contract texts (`object`,
`legalBasis`...) are in Portuguese, exactly as published; they are often in capitals or full of
internal reference codes. Show them as they are.

Base path: `/api/v2`. Errors use the usual `{ error: { code, message } }`.

## The idea for the pages

- **Ajustes diretos**: `GET /contracts?procedure=direct_award` (newest) or `&sort=price` (the
  biggest). Explain what an ajuste direto is with `GET /contracts/procedures` (`plain`).
- **By place**: `GET /contracts/stats?by=municipality` for a ranking or a map, then
  `GET /contracts?place=LOCAL-060300` for one municipality. Keys are the same `places` keys as
  elections (`/elections/:id/places/:key`).
- **A company or public body**: `GET /contracts/parties/:nif`: what it awarded, what it won,
  how much by ajuste direto, and its main counterparts.
- **Search**: `GET /contracts?q=refeições escolares`.

## Filters (shared)

`GET /contracts`, `GET /contracts/stats` and `GET /contracts/procedures` take the same filters,
combined with AND:

| param | meaning |
| --- | --- |
| `procedure` | Procedure kind: `direct_award`, `direct_award_simplified`, `prior_consultation`, `public_tender`, `limited_tender`, `framework_agreement`, `excluded`, `special_sectors`, `negotiation`, `other` |
| `entity` | NIF of the public body that awarded it |
| `supplier` | NIF of the company or person it went to |
| `place` | Municipality or district key, e.g. `LOCAL-060300` (Coimbra) or `LOCAL-060000` (Coimbra district) |
| `q` | Words in the contract's object (Portuguese stemming: "escola" finds "escolas") |
| `from`, `to` | Publication date range, `YYYY-MM-DD` |
| `minPrice` | Minimum price, euros |

## GET /contracts

Query: the filters, plus `sort=date|price` (default `date`, newest first; `price` biggest
first), `limit` (1-50, default 20), `cursor` (the previous page's `nextCursor`; keep the same
`sort` and filters).

```json
{
  "items": [
    {
      "id": "15836681",
      "object": "AD_109/2026 – Aquisição de serviços para confecção e fornecimento de refeições escolares transportadas a quente",
      "procedure": { "kind": "direct_award", "label": "Ajuste direto", "published": "Ajuste Direto Regime Geral" },
      "contractTypes": ["Aquisição de serviços"],
      "price": 906352.76,
      "publishedAt": "2026-10-26",
      "signedAt": "2026-09-11",
      "entities": [{ "nif": "506415082", "name": "Município de Coimbra" }],
      "suppliers": [{ "nif": "501426230", "name": "ICA - Indústria e Comércio Alimentar, S.A." }],
      "places": ["Portugal, Coimbra, Coimbra"],
      "baseUrl": "https://www.base.gov.pt/Base4/pt/detalhe/?type=contratos&id=15836681"
    }
  ],
  "nextCursor": "eyJ2IjoiMjAyNi0xMC0yNiIsImlkIjoiMTU4MzY2ODEifQ"
}
```

- `nif` is `""` when BASE doesn't publish one. That's common for private individuals. Don't
  link those to `/contracts/parties`.
- `entities` usually has one item; joint purchases have several. `suppliers` can be empty or
  have several.

## GET /contracts/:id

The summary above, plus:

| field | meaning |
| --- | --- |
| `description` | Longer description, when it differs from `object` |
| `procedureExplained` | What this kind of procedure means, in plain Portuguese |
| `basePrice` | The procedure's base price (the most it could cost), when published |
| `effectivePrice` | What was actually paid, once the contract closed; `null` until then |
| `cpv` | `{ code, description }`: the EU procurement category, e.g. "Serviços de fornecimento de refeições para escolas" |
| `deadlineDays` | Execution period, in days |
| `municipalities` | `[{ key, name }]`: places of execution we matched |
| `legalBasis` | The legal article invoked, e.g. "Artigo 20.º, n.º 1, alínea d) do Código dos Contratos Públicos" |
| `directAwardReason` | For ajustes diretos on material grounds (urgency, a sole supplier...), the reason given |
| `frameworkAgreement` | The framework agreement it falls under |
| `centralized` | Bought through a central purchasing body |
| `invited` | How many companies were invited to bid, when listed |
| `documentsUrl` | Procedure documents on the e-procurement platform, when public |
| `status` | As published; often empty |

404 if unknown.

## GET /contracts/procedures

Every procedure kind, in a fixed order, with a plain explanation and how many contracts and
euros it accounts for under the filters (except `procedure`):

```json
{ "items": [{ "kind": "direct_award", "label": "Ajuste direto", "plain": "A entidade pública escolhe a empresa…", "count": 90023, "total": 2960305772.12 }] }
```

Good for a "how public money is spent" bar or donut: open competition (`public_tender`,
`limited_tender`) vs. no or limited competition (`direct_award*`, `prior_consultation`).

## GET /contracts/stats

Query: the filters, plus:

- `by` (required): `year`, `month`, `procedure`, `entity`, `supplier`, `municipality`, `district`
- `order=total|count` (default `total`) and `limit` (1-100, default 20). These apply to
  `entity`, `supplier`, `municipality` and `district`, which return the top N.
  `year`, `month` and `procedure` return every group (`year` and `month` in date order).
- `year` and `month` group by the **signing date** (the publication date when there is none),
  the way BASE splits its yearly files, and only cover the years in `years`. So each bar is a
  complete year (the current one so far). Label the chart "por data de celebração do contrato".
- `years`: the years we have imported, e.g. `[2024, 2025, 2026]`.

```json
{
  "by": "municipality",
  "items": [{ "key": "LOCAL-110600", "label": "Lisboa", "count": 100240, "total": 8987803516.15 }],
  "totals": { "count": 687557, "total": 59535735887.99 },
  "updatedAt": "2026-11-15 10:43:39.927567+00",
  "years": [2024, 2025, 2026],
  "source": "https://dados.gov.pt/pt/datasets/66d72d488ca4b7cb2de28712/"
}
```

- `key` is a NIF for `entity` and `supplier`, a place key for places, `YYYY` or `YYYY-MM` for
  periods, and a procedure kind for `procedure`.
- `totals` covers every contract matching the filters, not just the groups listed.
- A contract carried out in several municipalities counts in each one. Contracts with no
  identifiable place (e.g. "Portugal") are in no place group.
- Lisbon and Porto lead partly because many national bodies are based there and list it as
  the place of execution. Say so next to any ranking by place.

## GET /contracts/parties/:nif

One NIF, which can be a public body, a company or both:

```json
{
  "nif": "506415082",
  "name": "Município de Coimbra",
  "asEntity": {
    "count": 1023, "total": 169359370.53, "directAwards": 479,
    "counterparts": [{ "key": "502519533", "label": "TECNORÉM - Engenharia e Construções, S.A", "count": 1, "total": 35688997.2 }]
  },
  "asSupplier": { "count": 0, "total": 0, "directAwards": 0, "counterparts": [] },
  "latest": [ /* up to 10 contract summaries, newest first */ ]
}
```

- `counterparts`: the top 10 on the other side (suppliers it paid, or bodies that paid it), by
  total.
- `directAwards`: how many of its contracts were ajustes diretos (simplified ones included).
- 404 if the NIF is in no contract.

## Notes for wording

- Present facts, not accusations. An ajuste direto is legal within its limits; what's newsworthy
  is patterns (the same supplier again and again, contracts just under thresholds), which
  readers can explore with these endpoints.
- Data covers 2024 onwards for now; older years can be imported on request (BASE goes back to
  2012). `GET /contracts/stats?by=year` shows what's there.
