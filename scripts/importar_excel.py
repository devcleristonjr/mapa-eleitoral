import argparse
import gzip
import json
import sys
import unicodedata
import urllib.request
from collections import Counter
from pathlib import Path

import openpyxl


EXPECTED_MUNICIPALITIES = 417
IBGE_URL = "https://servicodados.ibge.gov.br/api/v1/localidades/estados/29/municipios"
ALIASES = {
    "camaca": "camacan",
    "dias d avila": "dias d'avila",
    "santa teresinha": "santa terezinha",
}
REPORT_SEPARATOR = "====================================="
GOVERNOR_PERCENTAGE_HEADER = "Porcentagem de voto"
PRESIDENT_PERCENTAGE_HEADER = "Porcentagem de votos"
SECOND_PLACE_HEADER = "Segundo colocado"
SECOND_PLACE_PERCENTAGE_HEADER = "Percentual do segundo colocado"
SECTIONS_COUNTED_HEADER = "Seções apuradas (%)"
SOURCE_HEADER = "Fonte"
ROOT = Path(__file__).resolve().parents[1]
WORKBOOK_PATH = ROOT / "data" / "original" / "Vota\u00e7\u00e3o_Bahia_BASE_LIMPA.xlsx"
WORKBOOK_2022_PATH = ROOT / "data" / "original" / "Eleicao_2022_Segundo_turno.xlsx"
IBGE_PATH = ROOT / "data" / "processed" / "municipios_ibge.json"
OUTPUT_PATH = ROOT / "data" / "processed" / "dados.json"


def normalize_municipality_name(name):
    normalized = unicodedata.normalize("NFKD", str(name))
    normalized = "".join(char for char in normalized if not unicodedata.combining(char))
    normalized = " ".join(normalized.casefold().split())
    return ALIASES.get(normalized, normalized)


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
        IBGE_PATH.write_text(
            json.dumps(municipalities, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    else:
        municipalities = json.loads(IBGE_PATH.read_text(encoding="utf-8"))
    return municipalities


def parse_number(value, field_name, municipality, errors):
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value

    text = str(value).strip().replace("%", "").replace(" ", "")
    if "," in text and "." in text:
        if text.rfind(",") > text.rfind("."):
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
    elif "," in text:
        text = text.replace(",", ".")
    try:
        number = float(text)
        return int(number) if number.is_integer() else number
    except ValueError:
        errors.append(f"Valor numerico invalido em {field_name}: {municipality} ({value})")
        return None


def get_cell(row, positions, header):
    index = positions[header]
    return row[index] if len(row) > index else None


def get_optional_cell(row, positions, header):
    if header not in positions:
        return None
    return get_cell(row, positions, header)


def build_election_record(sheet_name, row, city, positions, errors):
    if sheet_name == "Governador":
        candidate = get_cell(row, positions, "Candidato")
        percentage = parse_number(
            get_cell(row, positions, GOVERNOR_PERCENTAGE_HEADER),
            GOVERNOR_PERCENTAGE_HEADER,
            city,
            errors,
        )
        if not candidate or percentage is None:
            errors.append(f"Dados incompletos na aba Governador: {city}")
        return {"candidato": candidate, "percentual": percentage}

    electors = parse_number(get_cell(row, positions, "Eleitores"), "Eleitores", city, errors)
    candidate = get_cell(row, positions, "Candidato")
    percentage = parse_number(
        get_cell(row, positions, PRESIDENT_PERCENTAGE_HEADER),
        PRESIDENT_PERCENTAGE_HEADER,
        city,
        errors,
    )
    has_missing_data = electors is None or not candidate or percentage is None
    if normalize_municipality_name(city) != "salvador" and has_missing_data:
        errors.append(f"Dados incompletos na aba Presidente: {city}")

    second_candidate = get_optional_cell(row, positions, SECOND_PLACE_HEADER)
    second_percentage = parse_number(
        get_optional_cell(row, positions, SECOND_PLACE_PERCENTAGE_HEADER),
        SECOND_PLACE_PERCENTAGE_HEADER,
        city,
        errors,
    )
    sections_counted = parse_number(
        get_optional_cell(row, positions, SECTIONS_COUNTED_HEADER),
        SECTIONS_COUNTED_HEADER,
        city,
        errors,
    )
    source = get_optional_cell(row, positions, SOURCE_HEADER)
    if bool(second_candidate) != (second_percentage is not None):
        errors.append(f"Dados incompletos do segundo colocado na aba Presidente: {city}")

    record = {"eleitores": electors, "candidato": candidate, "percentual": percentage}
    optional_values = {
        "segundo_candidato": second_candidate,
        "percentual_segundo": second_percentage,
        "secoes_apuradas": sections_counted,
        "fonte": source,
    }
    record.update({key: value for key, value in optional_values.items() if value is not None})
    return record


def read_sheet(workbook, sheet_name, municipality_index, errors):
    if sheet_name not in workbook.sheetnames:
        errors.append(f"Aba obrigatoria ausente: {sheet_name}")
        return {}, {}

    rows = workbook[sheet_name].iter_rows(values_only=True)
    headers = next(rows, ())
    required_headers = {
        "Governador": ("Cidade", "Candidato", GOVERNOR_PERCENTAGE_HEADER),
        "Presidente": ("Cidade", "Eleitores", "Candidato", PRESIDENT_PERCENTAGE_HEADER),
    }[sheet_name]
    header_positions = {str(value).strip(): index for index, value in enumerate(headers) if value}
    missing_headers = [header for header in required_headers if header not in header_positions]
    if missing_headers:
        errors.append(f"Colunas ausentes na aba {sheet_name}: {', '.join(missing_headers)}")
        return {}, {}

    records = {}
    display_names = {}
    municipality_count = 0
    for row in rows:
        city = get_cell(row, header_positions, "Cidade")
        if city is None or not str(city).strip():
            continue
        municipality_count += 1
        city = " ".join(str(city).split())
        key = normalize_municipality_name(city)
        if key not in municipality_index:
            errors.append(f"Municipio nao reconhecido na aba {sheet_name}: {city}")
            continue
        if key in records:
            errors.append(f"Municipio duplicado na aba {sheet_name}: {city}")
            continue

        display_names[key] = city
        records[key] = build_election_record(sheet_name, row, city, header_positions, errors)

    if municipality_count != EXPECTED_MUNICIPALITIES:
        errors.append(
            f"Aba {sheet_name}: esperados {EXPECTED_MUNICIPALITIES} municipios; encontrados {municipality_count}"
        )
    return records, display_names


def normalize_header(value):
    normalized = unicodedata.normalize("NFKD", str(value or ""))
    return "".join(char for char in normalized if not unicodedata.combining(char)).strip().casefold()


def get_2022_columns(sheet, errors):
    headers = next(sheet.iter_rows(values_only=True), ())
    normalized_headers = [normalize_header(value) for value in headers]
    if len(normalized_headers) < 6 or normalized_headers[0] not in ("municipio", "cidade"):
        errors.append(f"Cabecalho invalido na aba 2022 {sheet.title}")
        return None
    required_headers = ("brancos", "nulos", "total")
    missing_headers = [header for header in required_headers if header not in normalized_headers]
    if missing_headers:
        errors.append(f"Colunas ausentes na aba 2022 {sheet.title}: {', '.join(missing_headers)}")
        return None
    return (
        {header: index for index, header in enumerate(normalized_headers) if header},
        [format_2022_candidate(headers[index]) for index in (1, 2)],
    )


def format_2022_candidate(value):
    name = str(value).strip().title()
    return "ACM Neto" if normalize_header(value) == "acm neto" else name


def build_2022_record(row, positions, candidate_names, city, sheet_name, errors):
    votes = [
        parse_number(row[index], candidate_names[index - 1], city, errors)
        for index in (1, 2)
    ]
    blank_votes = parse_number(row[positions["brancos"]], "Brancos", city, errors)
    null_votes = parse_number(row[positions["nulos"]], "Nulos", city, errors)
    total_votes = parse_number(row[positions["total"]], "Total", city, errors)
    if any(value is None for value in (*votes, blank_votes, null_votes, total_votes)):
        errors.append(f"Dados incompletos na aba 2022 {sheet_name}: {city}")
        return None

    valid_votes = sum(votes)
    if valid_votes <= 0 or valid_votes + blank_votes + null_votes > total_votes:
        errors.append(f"Totais de votos inconsistentes na aba 2022 {sheet_name}: {city}")
        return None
    winner_index = 0 if votes[0] >= votes[1] else 1
    second_index = 1 - winner_index
    return {
        "candidato": candidate_names[winner_index],
        "percentual": round(votes[winner_index] / valid_votes * 100, 1),
        "votos": votes[winner_index],
        "segundo_candidato": candidate_names[second_index],
        "percentual_segundo": round(votes[second_index] / valid_votes * 100, 1),
        "votos_segundo": votes[second_index],
        "votos_validos": valid_votes,
        "brancos": blank_votes,
        "nulos": null_votes,
        "total_votos": total_votes,
    }


def read_2022_sheet(workbook, election, municipality_index, errors):
    sheet = next(
        (worksheet for worksheet in workbook.worksheets if normalize_header(worksheet.title).startswith(election)),
        None,
    )
    if sheet is None:
        errors.append(f"Aba obrigatoria ausente na planilha 2022: {election}")
        return {}
    columns = get_2022_columns(sheet, errors)
    if columns is None:
        return {}

    positions, candidate_names = columns
    records = {}
    municipality_count = 0
    for row in sheet.iter_rows(min_row=2, values_only=True):
        city = row[0] if row else None
        if city is None or not str(city).strip():
            continue
        municipality_count += 1
        city = " ".join(str(city).split())
        key = normalize_municipality_name(city)
        if key not in municipality_index:
            errors.append(f"Municipio nao reconhecido na aba 2022 {sheet.title}: {city}")
            continue
        if key in records:
            errors.append(f"Municipio duplicado na aba 2022 {sheet.title}: {city}")
            continue
        record = build_2022_record(row, positions, candidate_names, city, sheet.title, errors)
        if record is not None:
            records[key] = record

    if municipality_count != EXPECTED_MUNICIPALITIES:
        errors.append(
            f"Aba 2022 {sheet.title}: esperados {EXPECTED_MUNICIPALITIES} municipios; encontrados {municipality_count}"
        )
    return records


def validate_and_build(workbook, workbook_2022, municipalities):
    errors = []
    if len(municipalities) != EXPECTED_MUNICIPALITIES:
        errors.append(
            f"Tabela IBGE: esperados {EXPECTED_MUNICIPALITIES} municipios; encontrados {len(municipalities)}"
        )

    municipality_index = {}
    codes = []
    for item in municipalities:
        code = item.get("ibge")
        name = item.get("municipio")
        if code is None or not name:
            errors.append(f"Registro IBGE sem codigo ou nome: {item}")
            continue
        key = normalize_municipality_name(name)
        if key in municipality_index:
            errors.append(f"Nome duplicado na tabela IBGE: {name}")
            continue
        municipality_index[key] = {"ibge": code, "municipio": name}
        codes.append(code)

    duplicate_codes = [code for code, count in Counter(codes).items() if count > 1]
    if duplicate_codes:
        errors.append(f"Codigos IBGE duplicados: {duplicate_codes}")

    governor, governor_names = read_sheet(workbook, "Governador", municipality_index, errors)
    president, president_names = read_sheet(workbook, "Presidente", municipality_index, errors)
    governor_2022 = read_2022_sheet(workbook_2022, "governador", municipality_index, errors)
    president_2022 = read_2022_sheet(workbook_2022, "presidente", municipality_index, errors)

    expected_keys = set(municipality_index)
    for sheet_name, records in (
        ("Governador 2026", governor),
        ("Presidente 2026", president),
        ("Governador 2022", governor_2022),
        ("Presidente 2022", president_2022),
    ):
        missing = expected_keys - set(records)
        if missing:
            missing_names = [municipality_index[key]["municipio"] for key in sorted(missing)]
            errors.append(f"Municipios ausentes na aba {sheet_name}: {', '.join(missing_names)}")

    records = []
    if not errors:
        for key, municipality in municipality_index.items():
            records.append(
                {
                    "ibge": municipality["ibge"],
                    "municipio": governor_names.get(key, president_names.get(key, municipality["municipio"])),
                    "anos": {
                        "2022": {"governador": governor_2022[key], "presidente": president_2022[key]},
                        "2026": {"governador": governor[key], "presidente": president[key]},
                    },
                }
            )
        records.sort(key=lambda record: record["ibge"])

    return records, errors, len(municipality_index), len(set(codes))


def print_report(found, unique_codes, errors):
    governor_errors = any("Governador" in error for error in errors)
    president_errors = any("Presidente" in error for error in errors)
    print(REPORT_SEPARATOR)
    print("VALIDACAO DA BASE")
    print(REPORT_SEPARATOR)
    print(f"Municipios esperados: {EXPECTED_MUNICIPALITIES}")
    print(f"Municipios encontrados: {found}")
    print(f"Codigos IBGE unicos: {unique_codes}")
    print(f"Governador: {'ERRO' if governor_errors else 'OK'}")
    print(f"Presidente: {'ERRO' if president_errors else 'OK'}")
    print(f"Municipios sem correspondencia: {sum('nao reconhecido' in error for error in errors)}")
    print(f"Duplicados: {sum('duplicado' in error.lower() for error in errors)}")
    print(f"Erros: {len(errors)}")
    if errors:
        for error in errors:
            print(f"- {error}")
        print("BASE NAO VALIDADA")
    else:
        print("BASE VALIDADA COM SUCESSO")
    print("=====================================")


def main():
    parser = argparse.ArgumentParser(description="Importa dados eleitorais e associa codigos IBGE.")
    parser.add_argument("--excel", type=Path, default=WORKBOOK_PATH, help="Caminho da planilha Excel.")
    parser.add_argument(
        "--excel-2022",
        type=Path,
        default=WORKBOOK_2022_PATH,
        help="Caminho da planilha do segundo turno de 2022.",
    )
    parser.add_argument(
        "--atualizar-ibge",
        action="store_true",
        help="Baixa novamente a lista oficial de municipios da API do IBGE.",
    )
    args = parser.parse_args()

    for workbook_path in (args.excel, args.excel_2022):
        if not workbook_path.is_file():
            print(f"Planilha nao encontrada: {workbook_path}", file=sys.stderr)
            return 1

    try:
        municipalities = load_ibge_table(args.atualizar_ibge)
        workbook = openpyxl.load_workbook(args.excel, read_only=True, data_only=True)
        workbook_2022 = openpyxl.load_workbook(args.excel_2022, read_only=True, data_only=True)
        records, errors, found, unique_codes = validate_and_build(workbook, workbook_2022, municipalities)
    except (OSError, ValueError, KeyError, openpyxl.utils.exceptions.InvalidFileException) as error:
        print(f"Falha ao processar a base: {error}", file=sys.stderr)
        return 1

    print_report(found, unique_codes, errors)
    if errors:
        return 1

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(records, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Arquivo gerado: {OUTPUT_PATH.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())