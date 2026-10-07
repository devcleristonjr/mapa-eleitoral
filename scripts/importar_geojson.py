import gzip
import json
import sys
import urllib.request
from collections import Counter
from pathlib import Path


EXPECTED_MUNICIPALITIES = 417
GEOJSON_URL = (
    "https://servicodados.ibge.gov.br/api/v3/malhas/estados/29"
    "?formato=application%2Fvnd.geo%2Bjson&intrarregiao=municipio"
)
ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "processed" / "dados.json"
OUTPUT_PATH = ROOT / "data" / "geo" / "bahia-municipios.geojson"


def download_geojson():
    request = urllib.request.Request(GEOJSON_URL, headers={"User-Agent": "AtlasEleitoralBahia/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        content = response.read()
    if content.startswith(b"\x1f\x8b"):
        content = gzip.decompress(content)
    return json.loads(content.decode("utf-8-sig"))


def normalize_feature(feature, data_by_code):
    properties = feature.get("properties") or {}
    raw_code = properties.get("codarea")
    if raw_code is None:
        raise ValueError("Feature municipal sem properties.codarea.")
    try:
        code = int(raw_code)
    except (TypeError, ValueError) as error:
        raise ValueError(f"Codigo IBGE invalido na feature: {raw_code}") from error
    if code not in data_by_code:
        raise ValueError(f"Codigo IBGE {code} da malha nao esta em dados.json.")
    if not feature.get("geometry"):
        raise ValueError(f"Feature sem geometria para o codigo IBGE {code}.")

    properties["code"] = code
    properties["municipio"] = data_by_code[code]["municipio"]
    feature["properties"] = properties
    return code


def normalize_features(geojson, data):
    if geojson.get("type") != "FeatureCollection" or not isinstance(geojson.get("features"), list):
        raise ValueError("A resposta do IBGE nao e uma FeatureCollection GeoJSON valida.")
    if len(data) != EXPECTED_MUNICIPALITIES:
        raise ValueError(f"dados.json deve conter {EXPECTED_MUNICIPALITIES} municipios; encontrados {len(data)}.")

    data_by_code = {int(record["ibge"]): record for record in data}
    features = geojson["features"]
    if len(features) != EXPECTED_MUNICIPALITIES:
        raise ValueError(
            f"GeoJSON deve conter {EXPECTED_MUNICIPALITIES} features; encontrados {len(features)}."
        )

    seen_codes = [normalize_feature(feature, data_by_code) for feature in features]

    duplicates = [code for code, count in Counter(seen_codes).items() if count > 1]
    if duplicates:
        raise ValueError(f"Codigos IBGE duplicados na malha: {duplicates}")

    missing_codes = set(data_by_code) - set(seen_codes)
    if missing_codes:
        raise ValueError(f"Codigos ausentes na malha: {sorted(missing_codes)}")
    return geojson


def main():
    if not DATA_PATH.is_file():
        print(f"Arquivo de dados nao encontrado: {DATA_PATH}", file=sys.stderr)
        return 1

    try:
        data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
        geojson = normalize_features(download_geojson(), data)
    except (OSError, ValueError, KeyError) as error:
        print(f"Falha ao obter ou validar a malha municipal: {error}", file=sys.stderr)
        return 1

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(geojson, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(f"GeoJSON validado: {len(geojson['features'])} municipios")
    print("Codigos IBGE: 417 unicos; correspondencia com dados.json: 417/417")
    print(f"Arquivo gerado: {OUTPUT_PATH.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())