# -*- coding: utf-8 -*-
# Genera un DataFrame con la variación de precios por estación entre el primer
# y el último día disponible en data/estaciones_carburantes_*.xlsx
import pandas as pd
from pathlib import Path

DATA_DIR = Path("data")

def cargar_historico() -> pd.DataFrame:
    archivos = sorted(DATA_DIR.glob("estaciones_carburantes_*.xlsx"))
    if not archivos:
        raise FileNotFoundError(f"No hay archivos Excel en {DATA_DIR}/")
    dfs = []
    for f in archivos:
        df = pd.read_excel(f)
        # Normalizar fecha a formato YYYY-MM-DD para ordenar bien
        df["fecha"] = pd.to_datetime(df["FechaDescarga"], dayfirst=True)
        dfs.append(df)
    return pd.concat(dfs, ignore_index=True)

def calcular_variacion(df: pd.DataFrame) -> pd.DataFrame:
    df = df.sort_values("fecha")

    primeros = (
        df.groupby("IDEESS")
        .first()
        [["Precio Gasolina 95 E5", "Precio Gasoleo A", "fecha"]]
        .rename(columns={
            "Precio Gasolina 95 E5": "g95_inicio",
            "Precio Gasoleo A":      "diesel_inicio",
            "fecha":                 "fecha_inicio",
        })
    )

    ultimos = (
        df.groupby("IDEESS")
        .last()
        [["Rótulo", "Dirección", "Municipio", "Provincia",
          "Precio Gasolina 95 E5", "Precio Gasoleo A", "fecha"]]
        .rename(columns={
            "Precio Gasolina 95 E5": "g95_actual",
            "Precio Gasoleo A":      "diesel_actual",
            "fecha":                 "fecha_ultimo",
        })
    )

    result = ultimos.join(primeros)

    result["var_g95"]    = (result["g95_actual"]    - result["g95_inicio"]).round(4)
    result["var_diesel"] = (result["diesel_actual"] - result["diesel_inicio"]).round(4)
    result["dias"]       = (result["fecha_ultimo"]  - result["fecha_inicio"]).dt.days + 1

    result = result.reset_index().rename(columns={"IDEESS": "ideess"})[
        ["ideess", "Rótulo", "Dirección", "Municipio", "Provincia",
         "g95_actual", "diesel_actual",
         "g95_inicio", "diesel_inicio",
         "var_g95", "var_diesel",
         "dias", "fecha_inicio", "fecha_ultimo"]
    ]

    return result.sort_values("var_g95", ascending=False)

def main():
    print("Cargando histórico …")
    df = cargar_historico()
    n_dias = df["fecha"].nunique()
    print(f"  {len(df):,} registros · {df['IDEESS'].nunique():,} estaciones · {n_dias} día(s)")

    result = calcular_variacion(df)

    ruta = DATA_DIR / "variacion_estaciones.xlsx"
    result.to_excel(ruta, index=False)
    print(f"OK: {ruta} guardado ({len(result):,} estaciones).")

    print("\n── Top 10 mayores subidas G95 ──")
    print(result[result["var_g95"].notna()].head(10)[
        ["Rótulo", "Municipio", "Provincia", "g95_actual", "var_g95"]
    ].to_string(index=False))

    print("\n── Top 10 mayores bajadas G95 ──")
    print(result[result["var_g95"].notna()].tail(10)[
        ["Rótulo", "Municipio", "Provincia", "g95_actual", "var_g95"]
    ].to_string(index=False))

    return result

if __name__ == "__main__":
    main()
