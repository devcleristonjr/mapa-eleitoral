import argparse
import gzip
import json
import re
import sys
import unicodedata
import urllib.request
from collections import Counter
from pathlib import Path

import openpyxl


EXPECTED_MUNICIPALITIES = 417
EXPECTED_TERRITORIES = 27
IBGE_URL = "https://servicodados.ibge.gov.br/api/v1/localidades/estados/29/municipios"
ALIASES = {
    "camaca": "camacan",
    "dias d avila": "dias d'avila",
    "santa teresinha": "santa terezinha",
}
SHEETS = {
    "governador 2026 1 turno": ("2026", "governador", 1),
    "presidente 2026 1 turno": ("2026", "presidente", 1),
    "governador 2022 2 turno": ("2022", "governador", 2),
    "presidente 2022 2 turno": ("2022", "presidente", 2),
}
ROOT = Path(__file__).resolve().parents[1]
WORKBOOK_PATH = ROOT / "data" / "original" / "Votação Bahia.xlsx"
IBGE_PATH = ROOT / "data" / "processed" / "municipios_ibge.json"
OUTPUT_PATH = ROOT / "data" / "processed" / "dados.json"


def normalize_text(value):
    normalized = unicodedata.normalize("NFKD", str(value or ""))
    normalized = "".join(char for char in normalized if not unicodedata.combining(char))
    return " ".join(re.sub(r"[^a-z0-9]+", " ", normalized.casefold()).split())


def normalize_municipality_name(name):
    normalized = " ".join(unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode().casefold().split())
    return ALIASES.get(normalized, normalized)


def format_territory(value):
    words = " ".join(str(value).split()).title().split()
    lowercase_words = {"da", "das", "de", "do", "dos", "e"}
    return " ".join(word.lower() if index and word.lower() in lowercase_words else word for index, word in enumerate(words))


def download_ibge_table():
    request = urllib.request.Request(IBGE_URL, headers={"User-Agent": "AtlasEleitoralBahia/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        content = response.read()
    if content.startswith(b"\x1f\x8b"):
        content = gzip.decompress(content)
    municipalities = json.loads(content.decode("utf-8-sig"))
    return [{"ibge": item["id"], "municipio": item["nome"]} for item in municipalities]


def load_ibge_table(refresh):
    if refresh or not IBGE_PATH.exists():
        municipalities = download_ibge_table()
        IBGE_PATH.parent.mkdir(parents=True, exist_ok=True)
        IBGE_PATH.write_text(json.dumps(municipalities, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return municipalities
    return json.loads(IBGE_PATH.read_text(encoding="utf-8"))


def parse_number(value, field_name, municipality, errors):
    if value is None or (isinstance(value, str) and not value.strip()):
        errors.append(f"Valor ausente em {field_name}: {municipality}")
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = value
    else:
        text = str(value).strip().replace("%", "").replace(" ", "")
        if "," in text and "." in text:
            text = text.replace(".", "").replace(",", ".") if text.rfind(",") > text.rfind(".") else text.replace(",", "")
        elif "," in text:
            text = text.replace(",", ".")
        try:
            number = float(text)
        except ValueError:
            errors.append(f"Valor numerico invalido em {field_name}: {municipality} ({value})")
            return None
    return int(number) if number.is_integer() else number


def build_election_record(row, positions, election, year, city, errors):
    if year == "2026":
        candidate_header = "candidato" if election == "governador" else "vencedor"
        percentage_header = "porcentagem de voto" if election == "governador" else "porcentagem de votos"
        candidate = row[positions[candidate_header]]
        percentage = parse_number(row[positions[percentage_header]], percentage_header, city, errors)
        if year == "2026" and election == "presidente" and percentage is not None and 0 <= percentage <= 1:
            percentage *= 100
        if not candidate or percentage is None or not 0 <= percentage <= 100:
            errors.append(f"Resultado incompleto ou percentual invalido em {year} {election}: {city}")
        record = {"candidato": str(candidate).strip() if candidate else None, "percentual": percentage}
        if election == "presidente":
            electors, blank_votes, null_votes, abstentions, flavio_votes, other_votes = (
                parse_number(row[positions[header]], header, city, errors)
                for header in ("eleitores", "brancos", "nulos", "abstencoes", "flavio bolsonaro", "outros candidatos")
            )
            flavio_percentage = parse_number(
                row[positions["porcentagem de votos flavio"]], "porcentagem de votos flavio", city, errors
            )
            other_percentage = parse_number(row[positions["outros"]], "percentual de outros candidatos", city, errors)
            if any(value is None for value in (electors, blank_votes, null_votes, abstentions, flavio_votes, other_votes, flavio_percentage, other_percentage)):
                return record
            valid_votes = electors - abstentions - blank_votes - null_votes
            other_percentage *= 100
            flavio_percentage *= 100
            flavio_won = normalize_text(candidate) == "flavio bolsonaro"
            first_votes = flavio_votes if flavio_won else valid_votes - flavio_votes - other_votes
            second_votes = valid_votes - flavio_votes - other_votes if flavio_won else flavio_votes
            second_percentage = 100 - flavio_percentage - other_percentage if flavio_won else flavio_percentage
            calculated_winner_percentage = first_votes / valid_votes * 100 if valid_votes > 0 else 0
            if valid_votes <= 0 or min(first_votes, second_votes, other_votes) < 0:
                errors.append(f"Totais de votos inconsistentes em {year} presidente: {city}")
            elif abs(calculated_winner_percentage - percentage) > 0.2:
                errors.append(f"Percentual do vencedor divergente das contagens em {year} presidente: {city}")
            record.update({
                "eleitores": electors,
                "votos": first_votes,
                "segundo_candidato": "Lula" if flavio_won else "Flávio Bolsonaro",
                "percentual_segundo": round(second_percentage, 2),
                "votos_segundo": second_votes,
                "votos_validos": valid_votes,
                "votos_outros": other_votes,
                "percentual_outros": round(other_percentage, 2),
                "brancos": blank_votes,
                "nulos": null_votes,
                "abstencoes": abstentions,
                "total_votos": electors - abstentions,
            })
        return record

    candidate_headers = (
        ("jeronimo rodrigues", "acm neto") if election == "governador" else ("lula", "bolsonaro")
    )
    votes = [parse_number(row[positions[header]], header, city, errors) for header in candidate_headers]
    blank_votes = parse_number(row[positions["brancos"]], "brancos", city, errors)
    null_votes = parse_number(row[positions["nulos"]], "nulos", city, errors)
    total_votes = parse_number(row[positions["total"]], "total", city, errors)
    if any(value is None for value in (*votes, blank_votes, null_votes, total_votes)):
        return None
    valid_votes = sum(votes)
    if valid_votes <= 0 or valid_votes + blank_votes + null_votes > total_votes:
        errors.append(f"Totais de votos inconsistentes em {year} {election}: {city}")
        return None
    winner_index = 0 if votes[0] >= votes[1] else 1
    second_index = 1 - winner_index
    formatted_candidates = {
        "jeronimo rodrigues": "Jerônimo Rodrigues",
        "acm neto": "ACM Neto",
        "lula": "Lula",
        "bolsonaro": "Bolsonaro",
    }
    record = {
        "candidato": formatted_candidates[candidate_headers[winner_index]],
        "percentual": round(votes[winner_index] / valid_votes * 100, 1),
        "votos": votes[winner_index],
        "segundo_candidato": formatted_candidates[candidate_headers[second_index]],
        "percentual_segundo": round(votes[second_index] / valid_votes * 100, 1),
        "votos_segundo": votes[second_index],
        "votos_validos": valid_votes,
        "brancos": blank_votes,
        "nulos": null_votes,
        "total_votos": total_votes,
    }
    if election == "presidente":
        record["eleitores"] = parse_number(row[positions["eleitorado"]], "eleitorado", city, errors)
        record["abstencoes"] = parse_number(row[positions["abstencoes"]], "abstencoes", city, errors)
    return record


def read_sheet(workbook, sheet_key, municipality_index, errors):
    sheet = next((item for item in workbook.worksheets if normalize_text(item.title) == sheet_key), None)
    if sheet is None:
        errors.append(f"Aba obrigatoria ausente: {sheet_key}")
        return {}, {}
    year, election, _ = SHEETS[sheet_key]
    rows = sheet.iter_rows(values_only=True)
    headers = next(rows, ())
    positions = {normalize_text(value): index for index, value in enumerate(headers) if value}
    required = ["cidade" if year == "2026" else "municipio", "territorio de id"]
    if year == "2026" and election == "governador":
        required.extend(("candidato", "porcentagem de voto"))
    elif year == "2026":
        required.extend(("eleitores", "vencedor", "porcentagem de votos", "flavio bolsonaro", "porcentagem de votos flavio", "brancos", "nulos", "abstencoes", "outros candidatos", "outros"))
    else:
        required.extend(("brancos", "nulos", "total"))
        required.extend(("jeronimo rodrigues", "acm neto") if election == "governador" else ("eleitorado", "lula", "bolsonaro", "abstencoes"))
    missing = [header for header in required if header not in positions]
    if missing:
        errors.append(f"Colunas ausentes na aba {sheet.title}: {', '.join(missing)}")
        return {}, {}

    records = {}
    territories = {}
    for row in rows:
        city_value = row[positions[required[0]]] if len(row) > positions[required[0]] else None
        if city_value is None or not str(city_value).strip():
            continue
        city = " ".join(str(city_value).split())
        key = normalize_municipality_name(city)
        if key not in municipality_index:
            errors.append(f"Municipio nao reconhecido na aba {sheet.title}: {city}")
            continue
        if key in records:
            errors.append(f"Municipio duplicado na aba {sheet.title}: {city}")
            continue
        territory_value = row[positions["territorio de id"]] if len(row) > positions["territorio de id"] else None
        if not territory_value or not str(territory_value).strip():
            errors.append(f"Territorio de identidade ausente em {sheet.title}: {city}")
            continue
        territories[key] = format_territory(territory_value)
        records[key] = build_election_record(row, positions, election, year, city, errors)
    if len(records) != EXPECTED_MUNICIPALITIES:
        errors.append(f"Aba {sheet.title}: esperados {EXPECTED_MUNICIPALITIES} municipios; encontrados {len(records)}")
    return records, territories


def validate_and_build(workbook, municipalities):
    errors = []
    if len(municipalities) != EXPECTED_MUNICIPALITIES:
        errors.append(f"Tabela IBGE: esperados {EXPECTED_MUNICIPALITIES} municipios; encontrados {len(municipalities)}")
    municipality_index = {}
    for item in municipalities:
        code = item.get("ibge")
        name = item.get("municipio")
        if code is None or not name:
            errors.append(f"Registro IBGE sem codigo ou nome: {item}")
            continue
        key = normalize_municipality_name(name)
        if key in municipality_index:
            errors.append(f"Municipio duplicado na tabela IBGE: {name}")
            continue
        municipality_index[key] = {"ibge": code, "municipio": name}
    if len({item["ibge"] for item in municipality_index.values()}) != len(municipality_index):
        errors.append("Codigos IBGE duplicados na tabela de referencia")

    results = {}
    territories_by_sheet = {}
    for sheet_key, (year, election, _) in SHEETS.items():
        records, territories = read_sheet(workbook, sheet_key, municipality_index, errors)
        results[(year, election)] = records
        territories_by_sheet[sheet_key] = territories

    expected_keys = set(municipality_index)
    for (year, election), records in results.items():
        missing = expected_keys - set(records)
        if missing:
            errors.append(f"Municipios ausentes em {year} {election}: {len(missing)}")
    territory_sources = list(territories_by_sheet.values())
    if territory_sources:
        reference_territories = territory_sources[0]
        for sheet_key, territories in list(territories_by_sheet.items())[1:]:
            mismatches = [key for key in expected_keys if territories.get(key) != reference_territories.get(key)]
            if mismatches:
                errors.append(f"Territorios divergentes na aba {sheet_key}: {len(mismatches)} municipios")
        if len(set(reference_territories.values())) != EXPECTED_TERRITORIES:
            errors.append(f"Territorios esperados: {EXPECTED_TERRITORIES}; encontrados: {len(set(reference_territories.values()))}")

    records = []
    if not errors:
        for key, municipality in municipality_index.items():
            records.append({
                "ibge": municipality["ibge"],
                "municipio": municipality["municipio"],
                "territorio_identidade": territories_by_sheet[next(iter(SHEETS))][key],
                "anos": {
                    year: {
                        "turno": turn,
                        "governador": results[(year, "governador")][key],
                        "presidente": results[(year, "presidente")][key],
                    }
                    for year, turn in (("2022", 2), ("2026", 1))
                },
            })
        records.sort(key=lambda record: record["ibge"])
    return records, errors, len(municipality_index)


def main():
    parser = argparse.ArgumentParser(description="Importa a base eleitoral da Bahia a partir de uma planilha.")
    parser.add_argument("--excel", type=Path, default=WORKBOOK_PATH, help="Caminho da planilha central.")
    parser.add_argument("--atualizar-ibge", action="store_true", help="Atualiza a tabela municipal oficial do IBGE.")
    args = parser.parse_args()
    if not args.excel.is_file():
        print(f"Planilha nao encontrada: {args.excel}", file=sys.stderr)
        return 1
    try:
        municipalities = load_ibge_table(args.atualizar_ibge)
        workbook = openpyxl.load_workbook(args.excel, read_only=True, data_only=True)
        records, errors, found = validate_and_build(workbook, municipalities)
    except (OSError, ValueError, KeyError, openpyxl.utils.exceptions.InvalidFileException) as error:
        print(f"Falha ao processar a base: {error}", file=sys.stderr)
        return 1
    if errors:
        print("BASE NAO VALIDADA")
        for error in errors:
            print(f"- {error}")
        return 1
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Base validada: {found} municipios, {EXPECTED_TERRITORIES} territorios, 4 abas eleitorais.")
    print(f"Arquivo gerado: {OUTPUT_PATH.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())