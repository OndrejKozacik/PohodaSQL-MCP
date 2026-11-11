<!-- Pohoda schema | db: StwPh_<ICO> | varianta: CZ | export: 2026-01-01T00:00:00+00:00 -->

## `FApol`

- Význam: Položky faktur (zkušební popis)
- Poznámka: Splatnost se bere z hlavičky dokladu.

| # | Sloupec | Typ | NULL | Poznámka |
|--:|---|---|:-:|---|
| 1 | `ID` | int | ne | PK |
| 2 | `RefAg` | int | ano | odkaz na FA.ID |
| 3 | `Datum` | datetime | ano | datum položky |
