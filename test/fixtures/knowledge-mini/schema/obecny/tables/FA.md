<!-- Pohoda schema | db: StwPh_<ICO> | varianta: CZ | export: 2026-01-01T00:00:00+00:00 -->

## `FA`

- Význam: Faktury (zkušební popis)
- Poznámka: Částka celkem je ve sloupci KcCelkem.

| # | Sloupec | Typ | NULL | Poznámka |
|--:|---|---|:-:|---|
| 1 | `ID` | int | ne | PK |
| 2 | `ICO` | varchar(15) | ano | IČO partnera |
| 3 | `DatSplat` | datetime | ano | datum splatnosti dokladu |
| 4 | `KcCelkem` | money | ano | částka celkem |
