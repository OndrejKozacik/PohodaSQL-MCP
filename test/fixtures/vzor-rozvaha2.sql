DECLARE @Datum date = '2026-09-30';
DECLARE @Plna bit = 0;              -- 0 = zkrácený rozsah, 1 = plný rozsah
DECLARE @Tiskopis int = CASE WHEN @Plna = 1 THEN 128 ELSE 130 END;   -- RefAg tiskopisu v rRozvahZ / rRozvZSc
DECLARE @MinulyTp int = CASE WHEN @Plna = 1 THEN 1 ELSE 9 END;       -- pRozv.RelRozTp: 1 = rozvaha plná, 9 = zkrácená

-- 1) zůstatky účtů k datu: počáteční stav + zápisy do data
SELECT z.Ucet, SUM(z.MD - z.D) AS Kc
INTO #u
FROM (SELECT d.UMD AS Ucet, d.Kc AS MD, 0 AS D FROM dbo.pUD AS d
      WHERE d.RelUdAg <> 68 AND (d.TpUD = 5 OR (d.TpUD <> 5 AND d.Datum <= @Datum))
      UNION ALL
      SELECT d.UD, 0, d.Kc FROM dbo.pUD AS d
      WHERE d.RelUdAg <> 68 AND (d.TpUD = 5 OR (d.TpUD <> 5 AND d.Datum <= @Datum))) AS z
GROUP BY z.Ucet;

-- 2) nesoučtové řádky
CREATE TABLE #r (Radek int PRIMARY KEY, Brutto money NOT NULL, Korekce money NOT NULL, Netto money NOT NULL, Minule money NOT NULL);
WITH ucty AS (
    SELECT LEFT(o.Ucet, 3) AS S, o.Korekce,
           CASE WHEN @Plna = 1 THEN o.Radek  ELSE o.RadekZ  END AS RadekA,
           CASE WHEN @Plna = 1 THEN o.RadekP ELSE o.RadekZP END AS RadekP,
           u.Kc * CASE WHEN o.Minus = 1 THEN -1 ELSE 1 END AS Kc
    FROM #u AS u JOIN dbo.pOS AS o ON o.Ucet = u.Ucet
    WHERE o.RelDruhU = 1                     -- rozvahové účty
), synt AS (                                 -- Pohoda sčítá po syntetice, 221 po jednotlivých účtech
    SELECT S, RadekA, RadekP, Korekce, SUM(Kc) AS Kc FROM ucty WHERE S <> '221' GROUP BY S, RadekA, RadekP, Korekce
    UNION ALL
    SELECT S, RadekA, RadekP, Korekce, Kc FROM ucty WHERE S = '221'
), radky AS (                                -- záporný zůstatek jde na řádek pasiv, je-li vyplněn
    SELECT CASE WHEN RadekP <> 0 AND Kc < 0 THEN RadekP ELSE RadekA END AS Radek, Korekce, Kc FROM synt
    UNION ALL                                -- VH běžného období = výnosy − náklady
    SELECT (SELECT MIN(v.Radek) FROM dbo.rRozvahZ AS v WHERE v.RefAg = @Tiskopis AND v.SText LIKE 'Výsledek hospodaření běžného%'),
           0, SUM(u.Kc) FROM #u AS u JOIN dbo.pOS AS o ON o.Ucet = u.Ucet WHERE o.RelDruhU = 2
), agg AS (
    SELECT r.Radek, SUM(CASE WHEN r.Korekce = 0 THEN r.Kc ELSE 0 END) AS B,
           -SUM(CASE WHEN r.Korekce = 1 THEN r.Kc ELSE 0 END) AS K, SUM(r.Kc) AS N
    FROM radky AS r GROUP BY r.Radek
), minule AS (                               -- Výkazy minulého roku (netto)
    SELECT p.Radek, SUM(p.KcHaler) AS Kc FROM dbo.pRozv AS p WHERE p.RelRozTp = @MinulyTp GROUP BY p.Radek
)
INSERT #r (Radek, Brutto, Korekce, Netto, Minule)
SELECT t.Radek,
       ISNULL(a.B, 0) * CASE WHEN t.Stav >= 128 THEN -1 ELSE 1 END,                  -- pasiva kladně
       ISNULL(a.K, 0),
       ISNULL(a.N, 0) * CASE WHEN t.Stav >= 128 THEN -1 ELSE 1 END,
       ISNULL(m.Kc, 0)
FROM dbo.rRozvahZ AS t
LEFT JOIN agg AS a ON a.Radek = t.Radek
LEFT JOIN minule AS m ON m.Radek = t.Radek
WHERE t.RefAg = @Tiskopis AND t.Radek > 0;

-- 3) součtové řádky podle definice tiskopisu – POZOR: víc definic může mít stejné OrderFld
--    (plná rozvaha: ř. 95 = ř. 96 + ř. 98), proto se číslují ROW_NUMBER přes OrderFld, ID
SELECT ROW_NUMBER() OVER (ORDER BY sc.OrderFld, sc.ID) AS N, sc.Soucet,
       CASE WHEN sc.Minus = 1 THEN -1 ELSE 1 END AS Zn, sc.Od, ISNULL(sc.Do, sc.Od) AS Do
INTO #sc
FROM dbo.rRozvZSc AS sc
WHERE sc.RefAg = @Tiskopis AND sc.Soucet NOT BETWEEN sc.Od AND ISNULL(sc.Do, sc.Od);
UPDATE #r SET Brutto = 0, Korekce = 0, Netto = 0, Minule = 0 WHERE Radek IN (SELECT s.Soucet FROM #sc AS s);
DECLARE @i int = 1, @n int = (SELECT COUNT(*) FROM #sc), @Soucet int, @Zn int, @Od int, @Do int;
WHILE @i <= @n
BEGIN
    SELECT @Soucet = s.Soucet, @Zn = s.Zn, @Od = s.Od, @Do = s.Do FROM #sc AS s WHERE s.N = @i;
    UPDATE #r SET
        Brutto  = Brutto  + @Zn * (SELECT ISNULL(SUM(y.Brutto), 0)  FROM #r AS y WHERE y.Radek BETWEEN @Od AND @Do),
        Korekce = Korekce + @Zn * (SELECT ISNULL(SUM(y.Korekce), 0) FROM #r AS y WHERE y.Radek BETWEEN @Od AND @Do),
        Netto   = Netto   + @Zn * (SELECT ISNULL(SUM(y.Netto), 0)   FROM #r AS y WHERE y.Radek BETWEEN @Od AND @Do),
        Minule  = Minule  + @Zn * (SELECT ISNULL(SUM(y.Minule), 0)  FROM #r AS y WHERE y.Radek BETWEEN @Od AND @Do)
    WHERE Radek = @Soucet;
    SET @i += 1;
END;

SELECT x.Radek, CONCAT_WS(' ', NULLIF(t.C1, ''), NULLIF(t.C2, ''), NULLIF(t.C3, '')) AS Oznaceni, t.SText AS Text,
       CASE WHEN t.Stav >= 128 THEN 'P' ELSE 'A' END AS Strana,
       CONVERT(decimal(19,2), x.Brutto) AS Brutto, CONVERT(decimal(19,2), x.Korekce) AS Korekce,
       CONVERT(decimal(19,2), x.Netto) AS Netto, CONVERT(decimal(19,2), x.Minule) AS Minule
FROM #r AS x JOIN dbo.rRozvahZ AS t ON t.RefAg = @Tiskopis AND t.Radek = x.Radek
WHERE ABS(x.Brutto) + ABS(x.Korekce) + ABS(x.Netto) + ABS(x.Minule) >= 0.01
ORDER BY x.Radek;

-- 4) kontrola: účty se zůstatkem, které na výkaz nepřišly (řádek 0 / mimo osnovu / závěrkové)
SELECT u.Ucet, o.RelDruhU, CONVERT(decimal(19,2), u.Kc) AS Zustatek,
       'zůstatek není na žádném řádku výkazu – zkontroluj účtovou osnovu' AS Pozor
FROM #u AS u LEFT JOIN dbo.pOS AS o ON o.Ucet = u.Ucet
WHERE ABS(u.Kc) >= 0.01
  AND (o.Ucet IS NULL OR o.RelDruhU NOT IN (1, 2)
       OR (o.RelDruhU = 1 AND ISNULL(CASE WHEN @Plna = 1 THEN o.Radek ELSE o.RadekZ END, 0) = 0))
ORDER BY u.Ucet;
DROP TABLE #r; DROP TABLE #sc; DROP TABLE #u;
