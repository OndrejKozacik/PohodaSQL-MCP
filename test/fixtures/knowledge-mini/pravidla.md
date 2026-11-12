# Pravidla (zkušební jádro)

## Kapitoly k dočtení

Rejstřík kapitol: sklad.

## 0. Role a výstup

Píšeš dotazy nad zkušební databází. Tabulky kvalifikuj schématem.

## 1. Databáze

Název databáze se zjišťuje, neodvozuje. Slovenská varianta má databázi StwPhSK a schéma sk.

## 2. Pojmenování tabulek

Malé písmeno na začátku názvu je typový prefix.

### 2.1. Pokladna a prodejna

Pokladna není prodejna.

## 3. Pojmenování sloupců

Sloupce Rel jsou číselníky, sloupce Ref jsou vazby.

## 4. Mapa hlavních tabulek

Faktury jsou v tabulce FA, adresář v tabulce AD.

## 5. Faktury

Úvod k fakturám: typ dokladu určuje sloupec RelTpFak.

### 5.1. Typ dokladu

Sloupec RelTpFak rozlišuje typy. Hodnota 1 je běžná faktura.
Zálohová faktura má RelTpFak 4.

```sql
-- ukázka: nadpis v bloku kódu se nepočítá
## 99. Tohle není sekce
SELECT f.RelTpFak FROM dbo.FA AS f;
```

### 5.2. Storno

Stornovaný doklad má příznak storna. Částka storna je záporná.

### 5.3. Obrat

Obrat je součet faktur bez storna.

## 6. DPH

→ Obsah je v kapitole `pravidla/sklad.md` – přečti ji celou, když se zadání týká tohoto tématu.

## 7. Číselníky

Tabulka číselníků dalších dokladů.

### 7.5. Sklad – pohyby

→ Obsah je v kapitole `pravidla/sklad.md` – přečti ji celou, když se zadání týká tohoto tématu.

## 8. Vazby a JOINy

Vazby mezi tabulkami se zapisují přes sloupce Ref.

### 8.1. Co databáze vynucuje

Cizí klíče databáze nevynucuje, na číselníky použij LEFT JOIN.

### 8.2. Ověřené vazby

Sloupec FA.RefAD míří do tabulky dbo.AD (adresář).

### 8.3. Krátká skutečná sekce

Podrobnosti viz pravidla/sklad.md.

## 9. Datové typy

Peníze jsou typu money.

## 10. Instalačně specifické věci

Uživatelské sloupce se v každé instalaci liší.

## 11. Vzorové dotazy

### 11.2. Měsíční rozpad

Vzor s měsíčním rozpadem faktur.

### 11.6. Pomocný dotaz

Neznámou hodnotu číselníku zjisti pomocným dotazem.

### 11.15. Rozvaha po řádcích

Vzor rozvahy, řádek po řádku.

## 12. Hledání

Slovo jehla: sekce 12 ho má třikrát – jehla, jehla.

### 12.1. Podsekce s kupkou

Kupka sena bez hledaného slova.

### 12.2. Podsekce s jehlou

Tady je jehla jednou. Vedle leží kupka.

## 13. Dlouhý seznam

Osmnáct podsekcí se stejným slovem pro zkoušku limitu výsledků.

### 13.1. Položka

opakovaneslovo 1

### 13.2. Položka

opakovaneslovo 2

### 13.3. Položka

opakovaneslovo 3

### 13.4. Položka

opakovaneslovo 4

### 13.5. Položka

opakovaneslovo 5

### 13.6. Položka

opakovaneslovo 6

### 13.7. Položka

opakovaneslovo 7

### 13.8. Položka

opakovaneslovo 8

### 13.9. Položka

opakovaneslovo 9

### 13.10. Položka

opakovaneslovo 10

### 13.11. Položka

opakovaneslovo 11

### 13.12. Položka

opakovaneslovo 12

### 13.13. Položka

opakovaneslovo 13

### 13.14. Položka

opakovaneslovo 14

### 13.15. Položka

opakovaneslovo 15

### 13.16. Položka

opakovaneslovo 16

### 13.17. Položka

opakovaneslovo 17

### 13.18. Položka

opakovaneslovo 18
