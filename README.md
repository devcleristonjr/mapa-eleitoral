# Atlas Eleitoral da Bahia

Mapa interativo dos resultados eleitorais dos 417 municípios da Bahia. A aplicação usa JavaScript sem framework, Leaflet, Chart.js, SheetJS e códigos IBGE para relacionar os resultados à malha municipal.

O mapa e os indicadores podem ser filtrados por território de identidade. O gráfico apresenta os dez maiores eleitorados do ano selecionado. A tabela no fim da página compara os votos de Lula, Bolsonaro, Jerônimo Rodrigues e ACM Neto no segundo turno de 2022; permite ordenar os municípios e exportar os resultados visíveis para Excel.

## Fonte de dados

`data/original/Votação Bahia.xlsx` é a planilha central do projeto e a única entrada do importador. Ela reúne o primeiro turno de 2026 e o segundo turno de 2022 para presidente e governador, além dos territórios de identidade da Bahia. As planilhas antigas mantidas na pasta são arquivos de referência e não são mais usadas na atualização.

O importador valida abas, cabeçalhos, municípios, territórios, números e duplicidades antes de gerar `data/processed/dados.json`. Cada município fica associado ao código IBGE, ao território de identidade e aos resultados por ano, cargo e turno. `data/geo/bahia-municipios.geojson` contém as geometrias municipais e `data/processed/municipios_ibge.json` é a tabela local de referência do IBGE.

## Instalação

Requer Python 3.8 ou superior. Instale a dependência do importador:

```powershell
python -m pip install -r requirements.txt
```

O mapa carrega Leaflet, Chart.js e SheetJS por CDN e não requer instalação npm.

## Atualizar os dados

Substitua ou atualize a planilha central e execute:

```powershell
python scripts/importar_excel.py
```

Para atualizar a tabela municipal local pela API oficial do IBGE:

```powershell
python scripts/importar_excel.py --atualizar-ibge
```

`scripts/importar_geojson.py` atualiza a malha municipal oficial e valida a correspondência integral com os códigos de `dados.json`; execute-o apenas quando precisar atualizar a malha.

## Executar localmente

Na raiz do projeto, inicie o servidor estático:

```powershell
python -m http.server 4173
```

Abra `http://localhost:4173/src/`. Não abra o HTML diretamente como arquivo: o mapa precisa carregar os arquivos JSON via HTTP.

## Publicar

Publique a estrutura do projeto em um host de arquivos estáticos, preservando `src/` e `data/`. O navegador precisa de acesso à internet para carregar Leaflet e as fontes tipográficas via CDN.
