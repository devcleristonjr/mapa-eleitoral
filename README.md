# Atlas Eleitoral da Bahia

Mapa interativo dos resultados eleitorais dos 417 municípios da Bahia. Esta versão usa JavaScript sem framework e Leaflet; a associação entre a malha municipal e os resultados é feita pelo código IBGE.

## Estrutura

- `data/original/Votação_Bahia_BASE_LIMPA.xlsx`: resultados classificados no mapa como 2026.
- `data/original/Eleicao_2022_Segundo_turno.xlsx`: resultados do segundo turno de 2022.
- `data/processed/dados.json`: resultados dos dois anos associados aos códigos IBGE.
- `data/processed/municipios_ibge.json`: tabela de referência obtida do IBGE.
- `data/geo/bahia-municipios.geojson`: geometrias municipais com `properties.code`.
- `scripts/importar_excel.py`: valida e converte a planilha.
- `scripts/importar_geojson.py`: baixa, normaliza e valida a malha do IBGE.
- `src/`: aplicação estática Leaflet.

## Instalar

Requer Python 3.8 ou superior e acesso à internet para obter ou atualizar as fontes do IBGE. Instale a dependência do importador:

```powershell
python -m pip install -r requirements.txt
```

O mapa carrega Leaflet por CDN e não requer instalação npm.

## Atualizar os dados

Depois de atualizar qualquer uma das planilhas em `data/original/`, execute:

```powershell
python scripts/importar_excel.py
python scripts/importar_geojson.py
```

O primeiro comando valida as duas planilhas, os 417 municípios e os códigos antes de gerar `dados.json`. O arquivo gerado mantém os dados agrupados por ano (`2022` e `2026`) e por cargo. Para atualizar também a tabela local de municípios a partir da API oficial do IBGE:

```powershell
python scripts/importar_excel.py --atualizar-ibge
```

O segundo comando obtém a malha municipal oficial do [IBGE](https://servicodados.ibge.gov.br/api/v3/malhas/estados/29?formato=application%2Fvnd.geo%2Bjson&intrarregiao=municipio), converte `properties.codarea` para `properties.code` e exige correspondência exata com os códigos de `dados.json`.

## Executar localmente

Na raiz do projeto, inicie o servidor estático:

```powershell
python -m http.server 4173
```

Abra `http://localhost:4173/src/` no navegador. Não abra o HTML diretamente como arquivo: o mapa precisa buscar os arquivos JSON via HTTP.

## Publicar

Publique a estrutura do projeto em um host de arquivos estáticos, preservando os diretórios `src/` e `data/`. O navegador precisa de acesso à internet para carregar o Leaflet e as fontes tipográficas via CDN.
