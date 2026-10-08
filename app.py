import json
import os
from functools import lru_cache
from pathlib import Path

from flask import Flask, jsonify, render_template
from openpyxl.utils.exceptions import InvalidFileException

from scripts.importar_excel import generate_processed_data


ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT / "data" / "processed" / "dados.json"
GEOJSON_PATH = ROOT / "data" / "geo" / "bahia-municipios.geojson"
EXPECTED_MUNICIPALITIES = 417
ELECTION_YEARS = ("2022", "2026")

app = Flask(__name__)


class DataUnavailableError(RuntimeError):
    pass


def _validate_records(records):
    if not isinstance(records, list):
        raise ValueError("O arquivo de dados eleitorais deve conter uma lista JSON.")
    if len(records) != EXPECTED_MUNICIPALITIES:
        raise ValueError(
            f"Esperados {EXPECTED_MUNICIPALITIES} municípios em dados.json; "
            f"encontrados {len(records)}."
        )

    codes = set()
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("Há um registro municipal inválido em dados.json.")
        try:
            code = int(record["ibge"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("Há um município sem código IBGE válido em dados.json.") from error
        if code in codes:
            raise ValueError(f"O código IBGE {code} está duplicado em dados.json.")
        codes.add(code)
        if not record.get("municipio") or not record.get("territorio_identidade"):
            raise ValueError(f"Registro incompleto para o código IBGE {code}.")
        years = record.get("anos")
        if not isinstance(years, dict) or any(year not in years for year in ELECTION_YEARS):
            raise ValueError(f"Resultados de 2022 ou 2026 ausentes para o código IBGE {code}.")
        if any(
            not isinstance(years[year], dict)
            or any(election not in years[year] for election in ("presidente", "governador"))
            for year in ELECTION_YEARS
        ):
            raise ValueError(f"Resultados eleitorais incompletos para o código IBGE {code}.")
    return records


@lru_cache(maxsize=1)
def load_data():
    if not DATA_PATH.is_file():
        try:
            generated_count = generate_processed_data()
            app.logger.info("dados.json gerado automaticamente (%s municípios).", generated_count)
        except (OSError, ValueError, KeyError, InvalidFileException) as error:
            raise DataUnavailableError(
                f"Não foi possível gerar {DATA_PATH}: {error}"
            ) from error

    try:
        with DATA_PATH.open(encoding="utf-8") as data_file:
            records = json.load(data_file)
        return _validate_records(records)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        raise DataUnavailableError(
            f"Não foi possível carregar os dados eleitorais em {DATA_PATH}: {error}"
        ) from error


@lru_cache(maxsize=1)
def load_geojson():
    if not GEOJSON_PATH.is_file():
        raise DataUnavailableError(f"GeoJSON municipal não encontrado: {GEOJSON_PATH}")

    try:
        with GEOJSON_PATH.open(encoding="utf-8") as geojson_file:
            geojson = json.load(geojson_file)
    except (OSError, json.JSONDecodeError) as error:
        raise DataUnavailableError(
            f"Não foi possível ler o GeoJSON municipal em {GEOJSON_PATH}: {error}"
        ) from error

    if not isinstance(geojson, dict) or geojson.get("type") != "FeatureCollection":
        raise DataUnavailableError("O arquivo de malha municipal não é um GeoJSON válido.")
    features = geojson.get("features")
    if not isinstance(features, list):
        raise DataUnavailableError("O arquivo de malha municipal não é um GeoJSON válido.")
    if len(features) != EXPECTED_MUNICIPALITIES:
        raise DataUnavailableError(
            f"Esperadas {EXPECTED_MUNICIPALITIES} features no GeoJSON; "
            f"encontradas {len(features)}."
        )

    record_codes = {int(record["ibge"]) for record in load_data()}
    feature_codes = []
    for feature in features:
        if not isinstance(feature, dict):
            raise DataUnavailableError("Há uma feature inválida no GeoJSON municipal.")
        properties = feature.get("properties") or {}
        if not isinstance(properties, dict):
            raise DataUnavailableError("Há propriedades inválidas no GeoJSON municipal.")
        raw_code = properties.get("code", properties.get("codarea"))
        try:
            code = int(raw_code)
        except (TypeError, ValueError) as error:
            raise DataUnavailableError("Há um código IBGE inválido no GeoJSON municipal.") from error
        if not feature.get("geometry"):
            raise DataUnavailableError(f"Feature sem geometria para o código IBGE {code}.")
        feature_codes.append(code)
    if len(set(feature_codes)) != EXPECTED_MUNICIPALITIES:
        raise DataUnavailableError("O GeoJSON municipal contém códigos IBGE duplicados.")
    if set(feature_codes) != record_codes:
        raise DataUnavailableError("Os códigos IBGE do GeoJSON não correspondem aos dados eleitorais.")
    return geojson


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/dados")
def api_data():
    return jsonify(load_data())


@app.route("/api/municipios")
def api_municipalities():
    return jsonify(
        [
            {
                "ibge": record["ibge"],
                "municipio": record["municipio"],
                "territorio_identidade": record["territorio_identidade"],
            }
            for record in load_data()
        ]
    )


@app.route("/api/territorios")
def api_territories():
    territories = {record["territorio_identidade"] for record in load_data()}
    return jsonify(sorted(territories, key=str.casefold))


@app.route("/api/geojson")
def api_geojson():
    return jsonify(load_geojson())


@app.route("/api/eleicao/<int:year>")
def api_election(year):
    year_key = str(year)
    if year_key not in ELECTION_YEARS:
        return jsonify({"error": f"Ano eleitoral não disponível: {year}."}), 404

    records = load_data()
    return jsonify(
        {
            "ano": year_key,
            "turno": records[0]["anos"][year_key]["turno"],
            "municipios": [
                {
                    "ibge": record["ibge"],
                    "municipio": record["municipio"],
                    "territorio_identidade": record["territorio_identidade"],
                    "resultados": record["anos"][year_key],
                }
                for record in records
            ],
        }
    )


@app.errorhandler(DataUnavailableError)
def handle_data_error(error):
    app.logger.error("%s", error)
    return jsonify({"error": str(error)}), 503


if __name__ == "__main__":
    debug = os.environ.get("FLASK_DEBUG", "").strip().lower() in {"1", "true", "yes", "on"}
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="127.0.0.1", port=port, debug=debug)
