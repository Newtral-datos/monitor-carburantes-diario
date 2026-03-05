# -*- coding: utf-8 -*-
# Descarga → Excel diario + Excel consolidado → GeoJSON → PMTiles → stats.json
import requests, pandas as pd, subprocess, shutil, json, certifi
from pathlib import Path
from datetime import datetime
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

DATA_DIR = Path("data")
VIZ_DIR  = Path("viz")
URL = "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/"

class TLS12LegacyCiphersAdapter(HTTPAdapter):
    def init_poolmanager(self, *args, **kwargs):
        import ssl as _ssl
        ctx = _ssl.create_default_context(cafile=certifi.where())
        ctx.minimum_version = _ssl.TLSVersion.TLSv1_2; ctx.maximum_version = _ssl.TLSVersion.TLSv1_2
        try: ctx.set_ciphers("ECDHE+AESGCM:ECDHE+AES:RSA+AES:AES128-SHA:AES256-SHA:!aNULL:!eNULL:!MD5:@SECLEVEL=1")
        except _ssl.SSLError:
            try: ctx.set_ciphers("DEFAULT:@SECLEVEL=1")
            except _ssl.SSLError: pass
        try: ctx.set_alpn_protocols(["http/1.1"])
        except Exception: pass
        kwargs["ssl_context"] = ctx
        return super().init_poolmanager(*args, **kwargs)

def make_session():
    s = requests.Session(); s.trust_env = False; s.headers.update({"User-Agent":"Mozilla/5.0"})
    retries = Retry(total=5, connect=5, read=5, backoff_factor=0.6, status_forcelist=(429,502,503,504), allowed_methods=frozenset(["GET"]))
    s.mount("https://", TLS12LegacyCiphersAdapter(max_retries=retries)); return s

def _to_float(s):
    return pd.to_numeric(
        s.astype(str).str.replace(",", ".").str.replace("\xa0", "").str.strip(),
        errors='coerce'
    )

def qbreaks(series: pd.Series, classes=8):
    s = pd.to_numeric(series, errors="coerce").dropna()
    if s.empty: return None
    qs = [s.quantile(i/classes) for i in range(1, classes)]
    out=[]; last=None
    for v in qs:
        v=float(v)
        if last is None or v>last: out.append(v); last=v
        else: out.append(last + 1e-6); last=out[-1]
    return out

def consolidar_excel(ruta_salida: Path):
    """Concatena todos los Excel diarios del directorio actual en un único fichero."""
    archivos = sorted(DATA_DIR.glob("estaciones_carburantes_*.xlsx"))
    if not archivos:
        print("  Sin archivos diarios para consolidar.")
        return
    dfs = []
    for f in archivos:
        try:
            dfs.append(pd.read_excel(f))
        except Exception as e:
            print(f"  AVISO: no se pudo leer {f.name}: {e}")
    if not dfs:
        return
    consolidado = pd.concat(dfs, ignore_index=True)
    consolidado.to_excel(ruta_salida, index=False)
    print(f"OK: historico_completo.xlsx generado ({len(archivos)} archivo(s), {len(consolidado)} filas).")

def df_to_geojson(df: pd.DataFrame, ruta_geojson: Path) -> None:
    excluir = {"Latitud", "Longitud (WGS84)"}
    feats = []
    for _, r in df.iterrows():
        lon = r.get("Longitud (WGS84)"); lat = r.get("Latitud")
        if pd.notnull(lon) and pd.notnull(lat):
            props = {k: (None if pd.isna(v) else v) for k, v in r.to_dict().items() if k not in excluir}
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [float(lon), float(lat)]}, "properties": props})
    ruta_geojson.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False), encoding="utf-8")

def generar_pmtiles(ruta_geojson: Path, ruta_pmtiles: Path) -> bool:
    tippecanoe_path = shutil.which("tippecanoe")
    if not tippecanoe_path:
        print("ERROR: tippecanoe no encontrado en PATH.")
        return False

    cmd = [tippecanoe_path, "-o", str(ruta_pmtiles), "-r1", "-z12", "-Z3",
           "-l", "estaciones", str(ruta_geojson), "--force"]
    res = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if res.returncode == 0:
        print(f"OK: PMTiles generado con tippecanoe → {ruta_pmtiles}")
        return True

    print("  tippecanoe no soporta .pmtiles directamente, intentando vía .mbtiles …")
    ruta_mbtiles = ruta_pmtiles.with_suffix(".mbtiles")
    cmd2 = [tippecanoe_path, "-o", str(ruta_mbtiles), "-r1", "-z12", "-Z3",
            "-l", "estaciones", str(ruta_geojson), "--force"]
    res2 = subprocess.run(cmd2, capture_output=True, text=True, check=False)
    if res2.returncode != 0:
        print(res2.stderr); return False

    pmtiles_cli = shutil.which("pmtiles")
    if not pmtiles_cli:
        print("ERROR: 'pmtiles' CLI no encontrado. Instálalo con: brew install pmtiles")
        print(f"  El fichero .mbtiles está en {ruta_mbtiles} — conviértelo manualmente.")
        return False

    res3 = subprocess.run([pmtiles_cli, "convert", str(ruta_mbtiles), str(ruta_pmtiles)],
                          capture_output=True, text=True, check=False)
    if res3.returncode != 0:
        print(res3.stderr); return False

    ruta_mbtiles.unlink(missing_ok=True)
    print(f"OK: PMTiles generado vía mbtiles → {ruta_pmtiles}")
    return True

def exportar_historicos_viz(dir_out: Path):
    """Genera viz/historico/{IDEESS}.json desde los xlsx acumulados en data/."""
    archivos = sorted(DATA_DIR.glob("estaciones_carburantes_*.xlsx"))
    if not archivos:
        return
    dfs = []
    for f in archivos:
        tmp = pd.read_excel(f)
        tmp["fecha"] = pd.to_datetime(tmp["FechaDescarga"], dayfirst=True).dt.strftime("%Y-%m-%d")
        dfs.append(tmp)
    hist = pd.concat(dfs, ignore_index=True).sort_values("fecha")

    dir_out.mkdir(parents=True, exist_ok=True)
    for ideess, grp in hist.groupby("IDEESS"):
        datos = {
            "fechas":     grp["fecha"].tolist(),
            "gasolina95": [None if pd.isna(v) else round(float(v), 4) for v in grp["Precio Gasolina 95 E5"]],
            "gasoleo_a":  [None if pd.isna(v) else round(float(v), 4) for v in grp["Precio Gasoleo A"]],
        }
        (dir_out / f"{ideess}.json").write_text(json.dumps(datos, ensure_ascii=False), encoding="utf-8")
    print(f"OK: {len(hist['IDEESS'].unique())} históricos por estación generados en {dir_out}.")

def preparar_viz(ruta_pmtiles: Path, ruta_stats: Path):
    VIZ_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ruta_pmtiles, VIZ_DIR / "estaciones.pmtiles")
    shutil.copy2(ruta_stats, VIZ_DIR / "stats.json")
    print("OK: viz/ actualizado (estaciones.pmtiles, stats.json).")

def main():
    fecha_archivo = datetime.now().strftime("%d_%m_%Y")

    print("Descargando datos …")
    s = make_session(); resp = s.get(URL, timeout=30); data = resp.json()
    if "ListaEESSPrecio" not in data:
        print("ERROR: respuesta inesperada de la API."); return
    df = pd.DataFrame(data["ListaEESSPrecio"])
    df["FechaDescarga"] = datetime.now().strftime("%d/%m/%Y")

    columnas = ["IDEESS", "Rótulo", "Horario", "Dirección", "Municipio", "Provincia",
                "Precio Gasoleo A", "Precio Gasolina 95 E5",
                "FechaDescarga", "Latitud", "Longitud (WGS84)"]
    df = df[[c for c in columnas if c in df.columns]]

    for c in ["Precio Gasoleo A", "Precio Gasolina 95 E5", "Latitud", "Longitud (WGS84)"]:
        if c in df.columns: df[c] = _to_float(df[c])

    # Excel diario
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ruta_excel = DATA_DIR / f"estaciones_carburantes_{fecha_archivo}.xlsx"
    df.to_excel(ruta_excel, index=False)
    print(f"OK: {ruta_excel.name} guardado ({len(df)} estaciones).")

    # Excel consolidado
    print("Generando historico_completo.xlsx …")
    consolidar_excel(DATA_DIR / "historico_completo.xlsx")

    # GeoJSON + PMTiles
    ruta_geojson = DATA_DIR / "estaciones.geojson"
    ruta_pmtiles = DATA_DIR / "estaciones.pmtiles"
    ruta_stats   = DATA_DIR / "stats.json"

    df_valid = df.dropna(subset=["Latitud", "Longitud (WGS84)"]).copy()
    if df_valid.empty:
        print("ERROR: no hay estaciones con coordenadas válidas."); return

    # Calcular deltas vs. primer día disponible
    archivos_hist = sorted(DATA_DIR.glob("estaciones_carburantes_*.xlsx"))
    if len(archivos_hist) >= 2:
        try:
            df_primero = pd.read_excel(archivos_hist[0])
            for c in ["Precio Gasoleo A", "Precio Gasolina 95 E5"]:
                if c in df_primero.columns:
                    df_primero[c] = _to_float(df_primero[c])
            df_primero = df_primero.dropna(subset=["IDEESS"]).set_index("IDEESS")
            df_valid = df_valid.set_index("IDEESS")
            df_valid["delta_g95"] = (
                df_valid["Precio Gasolina 95 E5"] - df_primero["Precio Gasolina 95 E5"]
            ).round(4)
            df_valid["delta_diesel"] = (
                df_valid["Precio Gasoleo A"] - df_primero["Precio Gasoleo A"]
            ).round(4)
            df_valid = df_valid.reset_index()
            print(f"OK: deltas calculados vs. {archivos_hist[0].name}.")
        except Exception as e:
            print(f"  AVISO: no se pudieron calcular deltas: {e}")
            df_valid = df_valid.reset_index(drop=True)
    else:
        df_valid["delta_g95"]    = 0.0
        df_valid["delta_diesel"] = 0.0
        print("  Solo hay un día de datos; deltas = 0.")

    print("Generando GeoJSON …")
    df_to_geojson(df_valid, ruta_geojson)

    print("Generando PMTiles …")
    if not generar_pmtiles(ruta_geojson, ruta_pmtiles):
        return

    g95 = df_valid["Precio Gasolina 95 E5"]
    di  = df_valid["Precio Gasoleo A"]
    stats = {
        "Precio Gasolina 95 E5": {
            "min": float(pd.to_numeric(g95, errors="coerce").dropna().min()) if not g95.empty else None,
            "max": float(pd.to_numeric(g95, errors="coerce").dropna().max()) if not g95.empty else None,
            "breaks": qbreaks(g95, 8)
        },
        "Precio Gasoleo A": {
            "min": float(pd.to_numeric(di, errors="coerce").dropna().min()) if not di.empty else None,
            "max": float(pd.to_numeric(di, errors="coerce").dropna().max()) if not di.empty else None,
            "breaks": qbreaks(di, 8)
        }
    }
    ruta_stats.write_text(json.dumps(stats, ensure_ascii=False), encoding="utf-8")
    print("OK: stats.json generado.")

    print("Preparando viz/ …")
    preparar_viz(ruta_pmtiles, ruta_stats)

    print("Generando históricos por estación …")
    exportar_historicos_viz(VIZ_DIR / "historico")

    print()
    print("─" * 50)
    print("Listo. Para ver el mapa:")
    print("  python3 -m http.server 8080")
    print("  Abre http://localhost:8080/viz/")
    print("─" * 50)

if __name__ == "__main__":
    main()
