# Agenda API (political calendar)

`GET /api/v2/agenda` lists upcoming political events, soonest first. Only events that
haven't ended are included: an event stays listed while it's still happening, and an
all-day event stays listed until the end of its last day (Lisbon time).

## Query

| Param | Example | Notes |
|---|---|---|
| `from` | `2026-12-01` | A day. Default: today in Lisbon. Days before today are treated as today, so past events never come back. |
| `kind` | `parliament,committee` | One or more, comma-separated. See [kinds](#kinds). An unknown kind returns 400. |
| `district` | `Porto` | One of the 18 districts, `Açores` or `Madeira`, spelled exactly like that (with accents). Events abroad and online-only events have no district. |
| `open` | `true` | Only events the public can attend (`attend.open`). |
| `cursor` | | The `nextCursor` from the previous page. |
| `limit` | `20` | Default 50, max 100. |

## Response

```json
{
  "items": [
    {
      "id": "ar-48673",
      "kind": "parliament",
      "title": "Debate na especialidade do Orçamento do Estado para 2027",
      "summary": "ORDEM DO DIA\n10H00\nDebate na especialidade do Orçamento do Estado para 2027",
      "start": "2026-11-18T10:00:00+00:00",
      "end": null,
      "allDay": false,
      "status": "scheduled",
      "place": {
        "name": "Assembleia da República",
        "address": "Palácio de São Bento, Lisboa",
        "municipality": "Lisboa",
        "district": "Lisboa",
        "lat": 38.7135,
        "lng": -9.1561
      },
      "online": { "url": "https://canal.parlamento.pt/", "label": "Canal Parlamento" },
      "attend": {
        "open": true,
        "how": "Entrada pelo Palácio de São Bento, indicando a reunião. Lugares limitados; é preciso documento de identificação.",
        "url": null
      },
      "organizer": "Assembleia da República",
      "parties": [],
      "sourceUrl": "https://agenda.parlamento.pt/",
      "featured": false
    }
  ],
  "nextCursor": "WyIyMDI2LTExLTE4VDEwOjAwOjAwLjAwMFoiLCJhci00ODY3MyJd",
  "total": 29
}
```

- `id` is a string and stays the same across imports. The prefix tells you the source: `ar-`
  parliament, `pr-` President, `pe-` European Parliament, `ed-` our editors.
- `start` and `end`:
  - timed events: ISO 8601 with the Lisbon offset (`+00:00` in winter, `+01:00` in summer).
  - `allDay` events: a bare day, `"2026-11-23"`. For an event over several days, `end` is the
    **last day, inclusive** (`"2026-11-26"`). For a one-day event, `end` is `null`.
  - `end` is `null` when the source doesn't say when it ends. That's common: the parliament
    rarely gives end times, and the President's site never does.
- `summary` is plain text, with `\n` between lines (agenda items, audience lists), or `null`.
- `status`: `scheduled`, `cancelled` or `postponed`. Only our editors set cancelled or postponed;
  imported events that disappear from their source are removed, because the sources don't
  say why something was taken off. Cancelled events stay listed until their date passes.
- `place` is `null` when unknown or for online-only events. `district` is `null` abroad
  (Strasbourg, Brussels).
- `parties`: `[{slug, acronym}]`, e.g. a parliamentary group's audiences or a party congress.
- `featured`: the editors' pick, for the front page box. The frontend's "next event" picks
  the first featured, non-cancelled one.
- `total` counts every event matching the filters (not just this page), and stays the same
  across pages.

## Kinds

| Kind | What | Where it comes from |
|---|---|---|
| `parliament` | Plenary sittings; the Leaders' Conference | Parliament's open data (automatic) |
| `committee` | Parliamentary committees and working groups | Parliament's open data (automatic) |
| `president` | The President's public agenda | presidencia.pt (automatic, today and the next day or two) |
| `european` | European Parliament plenary sessions; EU summits | EP open data (automatic, plenaries); summits by the editors |
| `party` | Parliamentary groups' audiences (automatic); congresses, rallies, campaign events (editors) | Both |
| `government` | Council of Ministers, Government events | Editors (portugal.gov.pt has no public agenda) |
| `election` | Election days | Editors |
| `local` | Municipal assemblies and council meetings | Editors |
| `media` | **New:** interviews, debates and commentary on TV and radio ("tonight on SIC: interview with…") | Editors |
| `other` | Anything else | Editors |

`media` isn't in the frontend's list yet. Until it's added, `lib/api/agenda.ts` shows it as
`other`, so nothing breaks. For `media` events, `online` holds the channel or stream
(`{url: "https://sic.pt/direto", label: "SIC"}`), `place` is usually `null`, and `parties`
says whose politicians are on.

### What the automatic sources give

- **Parliament** (two weeks ahead, refreshed every 3 hours):
  - Plenary sittings: titled by the first item of business. `attend.open` is true (the
    public galleries), and they're broadcast on Canal Parlamento.
  - Committees: open to the public, though some meetings are behind closed doors.
    `sourceUrl` is the committee's page.
  - Parliamentary groups' audiences: one item per hearing, at its time in `start` (parliament
    lists a day's hearings as lines like "15h30 - Tabaqueira"). Title "Audiência do PS:
    Tabaqueira", closed, with the party. A day listed without times stays one all-day item.
    Each hearing's id comes from its time and who is heard (`ar-48673-1530-3f9a1c2b`), so it
    stays put when parliament adds or reorders hearings. (Until 2026-11 it was the line number,
    `ar-48673-2`; those events were replaced on the next import.)
  - School visits and guided tours are left out.
- **President**: what presidencia.pt shows (today and the next day or two), with the place.
  Not open to the public.
- **European Parliament**: plenary sessions for this year and next, one all-day event per
  session (Monday to Thursday in Strasbourg, or two days in Brussels).

## Admin (editors)

All the endpoints below need an admin session. Editors can add, edit and delete their own
events. Moderators can also feature or hide any event, imported ones included.

| Method | Path | |
|---|---|---|
| GET | `/admin/agenda?from=&source=` | Events from a day on (default today), hidden ones included. `source`: `parliament`, `president`, `europarl` or `editorial` |
| POST | `/admin/agenda` | Add an event → 201 |
| PUT | `/admin/agenda/:id` | Replace an editors' event (400 `imported` for imported ones) |
| DELETE | `/admin/agenda/:id` | Delete an editors' event → 204 |
| POST | `/admin/agenda/:id/feature` · `unfeature` | Front page box (moderators) |
| POST | `/admin/agenda/:id/hide` · `unhide` | Leave out of the public calendar; this survives imports (moderators) |

Admin items carry everything the public items have, plus `source`, `hidden`, `partySlugs`
and `updatedAt`.

The body for POST and PUT:

```json
{
  "kind": "media",
  "title": "Entrevista ao secretário-geral do PS",
  "summary": "Grande entrevista no Jornal da Noite",
  "allDay": false,
  "start": "2026-11-20T21:00",
  "end": "2026-11-20T22:00",
  "status": "scheduled",
  "place": null,
  "online": { "url": "https://sic.pt/direto", "label": "SIC" },
  "attend": { "open": false, "how": null, "url": null },
  "organizer": "SIC",
  "partySlugs": ["ps"],
  "sourceUrl": "https://sic.pt/..."
}
```

- `start` and `end` are Lisbon wall-clock time with no offset: `"2026-11-20T21:00"`. When
  `allDay` is true, use days instead: `"2026-11-21"`, with `end` as the last day, inclusive.
  `end` can be `null`.
- `place.district` may be `null`. It's then filled in from `place.municipality`
  (e.g. `"Porto"` → `"Porto"`, `"Funchal"` → `"Madeira"`).
- Unknown `partySlugs` return 400 `unknown_party`.
- URLs must be http(s).
