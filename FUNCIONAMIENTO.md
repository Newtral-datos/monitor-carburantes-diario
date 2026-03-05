# Mapa de precios de carburantes — Funcionamiento del proyecto

## Visión general

Este proyecto descarga diariamente los precios de todas las gasolineras de España desde la API del Ministerio de Industria, los acumula en una base de datos SQLite para construir un histórico, genera un mapa en formato PMTiles y lo publica en GitHub Pages. Todo el proceso está automatizado con GitHub Actions.

```
API Ministerio → run.py → SQLite (historico.db)
                       → GeoJSON → Tippecanoe → PMTiles → GitHub Pages → MapLibre GL
                       → stats.json
                       → nacional.json
                       → historico/{IDEESS}.json (uno por estación)
```

---

## Ficheros del proyecto

| Fichero/Directorio | Rol |
|---|---|
| `run.py` | Pipeline completo: descarga, SQLite, GeoJSON, PMTiles, exports JSON |
| `requirements.txt` | Dependencias Python |
| `.github/workflows/daily.yml` | Automatización diaria con GitHub Actions |
| `index.html` | Página web del mapa |
| `app.js` | Lógica del mapa (MapLibre, PMTiles, leyenda, filtros, gráficos) |
| `styles.css` | Estilos de la interfaz |
| `data/historico.db` | Base de datos SQLite acumulativa (generada por `run.py`) |
| `data/historico/` | JSON de serie temporal por estación (generados por `run.py`) |
| `viz/` | Directorio listo para servir localmente (generado por `run.py`) |

---

## 1. Pipeline de datos — `run.py`

### 1.1 Descarga de la API

```
https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/
```

La API del Ministerio usa TLS 1.2 con cifrados antiguos. El adaptador `TLS12LegacyCiphersAdapter` fuerza TLS 1.2 y ajusta la lista de cifrados con varios niveles de fallback para compatibilidad tanto con OpenSSL como con LibreSSL (macOS). Incluye reintentos automáticos (hasta 5) con backoff exponencial ante errores 429/502/503/504.

### 1.2 Limpieza y transformación

Del JSON descargado (`ListaEESSPrecio`) se extrae un DataFrame con:

- `IDEESS` — identificador único de la estación
- Rótulo, Horario, Dirección, Municipio, Provincia
- Precio Gasoleo A, Precio Gasolina 95 E5
- Latitud, Longitud (WGS84)
- FechaDescarga (añadida por el script)

Los precios y coordenadas vienen como cadenas con coma decimal (`"1,549"`), convertidas a `float`. El resultado se guarda también como Excel en `data/estaciones_FECHA.xlsx`.

### 1.3 Base de datos SQLite — `data/historico.db`

Cada ejecución actualiza dos tablas:

**`estaciones`** — una fila por gasolinera, se actualiza (no duplica):
```sql
CREATE TABLE estaciones (
    ideess        TEXT PRIMARY KEY,
    rotulo        TEXT, direccion TEXT, municipio TEXT, provincia TEXT,
    latitud       REAL, longitud  REAL,
    primera_fecha TEXT,   -- fecha del primer registro
    ultima_fecha  TEXT    -- fecha del último registro
);
```

**`precios`** — una fila por estación y día, idempotente (re-ejecutar el mismo día no duplica):
```sql
CREATE TABLE precios (
    ideess      TEXT NOT NULL,
    fecha       TEXT NOT NULL,   -- formato 'YYYY-MM-DD'
    gasolina95  REAL,
    gasoleo_a   REAL,
    PRIMARY KEY (ideess, fecha)
);
```

### 1.4 Enriquecimiento con variación histórica

Antes de generar el GeoJSON, el script consulta la DB para calcular, por cada estación, la diferencia entre el precio de hoy y el del primer día registrado:

- `delta_g95` = precio_hoy_g95 − precio_primer_dia_g95
- `delta_diesel` = precio_hoy_diesel − precio_primer_dia_diesel

Estos campos se incluyen como propiedades en el GeoJSON y quedan embebidos en el PMTiles para que el frontend pueda usarlos sin fetch adicional.

### 1.5 Generación de PMTiles

Con las estaciones que tienen coordenadas válidas se construye un GeoJSON y se llama a **Tippecanoe**:

```bash
tippecanoe -o data/estaciones.pmtiles -r1 -z12 -Z3 -l estaciones estaciones.geojson --force
```

- Tippecanoe ≥ 2.14 genera `.pmtiles` directamente
- Si la versión es antigua, hace fallback a `.mbtiles` + CLI `pmtiles convert`

### 1.6 Ficheros JSON exportados

| Fichero | Contenido |
|---|---|
| `data/stats.json` | Min, max y 7 breaks de cuantil para G95 y Diésel (para calibrar colores y slider) |
| `data/nacional.json` | Arrays: fechas, media_g95, media_diesel, n_estaciones — una entrada por día |
| `data/historico/{IDEESS}.json` | Serie temporal de cada estación: fechas, gasolina95, gasoleo_a |

### 1.7 Preparación de `viz/`

Al final, el script copia todo a `viz/` para poder servir localmente con un solo comando:

```
viz/
  index.html, app.js, styles.css
  estaciones.pmtiles
  stats.json
  nacional.json
  historico/
    {IDEESS}.json   ← uno por estación
```

---

## 2. Ejecución local

```bash
# 1. Instalar dependencias (una sola vez)
pip3 install requests pandas certifi urllib3 openpyxl
brew install tippecanoe

# 2. Ejecutar el pipeline
python3 run.py

# 3. Servir y abrir el mapa
cd public && python3 -m http.server 8080
# Abrir http://localhost:8080
```

---

## 3. Automatización — `.github/workflows/daily.yml`

El workflow se ejecuta **cada día a las 05:00 UTC (07:00 Madrid)** y también manualmente desde la pestaña Actions.

### Pasos

1. **Checkout** del repositorio
2. **`git pull --rebase`** para obtener la última versión de `historico.db` guardada en `main`
3. **Setup Python 3.11** + instala Tippecanoe via `apt-get`
4. **Instala dependencias Python**
5. **Ejecuta `run.py`** → genera PMTiles, stats, SQLite e históricos JSON
6. **Convierte MBTiles → PMTiles** con Docker `protomaps/go-pmtiles` y copia todo a `viz/`
7. **Commit** de `data/historico.db`, `data/historico/` y `data/nacional.json` a la rama `main` (persiste el histórico entre ejecuciones)
8. **Publica en `gh-pages`** con `peaceiris/actions-gh-pages` (`force_orphan: true`)

> La DB crece ~120 MB/año sin comprimir (~30-40 MB comprimida en git).

---

## 4. Frontend — `index.html` + `app.js`

### Librerías (CDN, sin bundler)

| Librería | Versión | Uso |
|---|---|---|
| **MapLibre GL JS** | 3.6.2 | Motor de mapa vectorial |
| **pmtiles** | 3.0.6 | Protocolo para cargar PMTiles directamente |
| **noUiSlider** | 15.7.1 | Slider de rango para filtrar por precio |
| **Chart.js** | 4.4.2 | Gráficos de líneas (histórico estación y evolución nacional) |

### Estructura de la interfaz

```
┌──────────────────────────────────────────────────────────┐
│  [Gasolina 95] [Diésel] [Variación]  │ Leyenda │ Slider  │  ← header
├──────────────────────────────────────────────────────────┤
│                                                          │
│                        MAPA                              │
│                                              [📈 Nacional]│
└──────────────────────────────────────────────────────────┘
```

### Modos del mapa

**Modo precio** (por defecto)
- Círculos coloreados por precio actual
- Gasolina 95: escala verde (#b8fff1 → #00745b), 8 clases por cuantil
- Diésel: escala amarillo-marrón (#fff4c2 → #6f4d00), 8 clases por cuantil
- Slider filtra el rango de precios visible

**Modo variación** (botón "Variación")
- Círculos coloreados por `delta_g95` o `delta_diesel` (variación vs. primer día registrado)
- Paleta divergente: verde (bajó) → amarillo (sin cambio) → rojo (subió)
- 7 clases con breaks en ±0,02 / ±0,06 / ±0,12 €/l
- Slider desactivado

### Interactividad

| Acción | Resultado |
|---|---|
| **Hover** sobre gasolinera | Popup con rótulo, dirección, precios y fecha de actualización |
| **Clic** sobre gasolinera | Popup con los mismos datos + gráfico de líneas del histórico (cargado vía `historico/{IDEESS}.json`) |
| **Tab** Gasolina / Diésel | Cambia el combustible mostrado en mapa, leyenda y slider |
| **Botón Variación** | Alterna entre modo precio y modo variación histórica |
| **Botón 📈 Nacional** | Abre panel con gráfico de la media nacional de G95 y diésel a lo largo del tiempo |

### Detección local vs. producción

```js
const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const BASE_URL = IS_LOCAL
  ? window.location.origin                                      // http://localhost:8080
  : 'https://Newtral-datos.github.io/actualizacion_precio_gasolineras';
```

Todas las URLs (PMTiles, stats, nacional, historico) se construyen sobre `BASE_URL`, sin necesidad de cambiar nada entre entorno local y producción.

---

## 5. Formato PMTiles

PMTiles es un archivo único que contiene todas las teselas vectoriales indexadas. A diferencia de MBTiles (que necesita un servidor SQLite), PMTiles permite acceso directo desde hosting estático usando **HTTP Range Requests**: el cliente solo descarga las teselas del área visible.

En local el servidor `python3 -m http.server` soporta range requests de serie. En producción lo hace GitHub Pages.

---

## 6. Flujo completo resumido

```
07:00 Madrid (cron)
    │
    ▼
GitHub Actions
    │
    ├─ git pull → obtiene historico.db actualizado de main
    ├─ Python: descarga API Ministerio (~11.000 estaciones)
    ├─ Python: limpieza + GeoJSON + Excel
    ├─ Python: upsert SQLite (estaciones + precios del día)
    ├─ Python: calcula delta_g95/delta_diesel desde primer registro
    ├─ Tippecanoe: GeoJSON enriquecido → PMTiles
    ├─ Python: stats.json (cuantiles) + nacional.json + historico/*.json
    ├─ git commit historico.db + historico/ + nacional.json → main
    └─ Publica en gh-pages: PMTiles + JSONs + HTML/CSS/JS
                │
                ▼
        GitHub Pages (hosting estático)
                │
                ▼
        Usuario abre el mapa
                ├─ fetch stats.json → colores y slider calibrados
                ├─ MapLibre carga PMTiles via HTTP Range Requests
                ├─ Hover → popup precio
                ├─ Clic → fetch historico/{IDEESS}.json → gráfico histórico
                └─ Botón Nacional → fetch nacional.json → gráfico evolución media
```

---

## Notas técnicas

- **TLS legacy**: La API del Ministerio requiere `TLS12LegacyCiphersAdapter`. El fallback triple (cifrados específicos → DEFAULT:@SECLEVEL=1 → sin set_ciphers) garantiza compatibilidad con OpenSSL moderno, LibreSSL (macOS) y entornos restringidos.
- **Idempotencia**: Re-ejecutar `run.py` el mismo día actualiza los precios sin duplicar registros (`INSERT OR REPLACE` en SQLite).
- **`force_orphan: true`**: Cada despliegue reemplaza completamente el historial de `gh-pages`, evitando que crezca con el tiempo.
- **Sin servidor de teselas**: arquitectura completamente serverless; el único coste es almacenamiento en GitHub y tiempo de GitHub Actions.
