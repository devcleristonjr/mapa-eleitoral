# Atlas Eleitoral da Bahia

Aplicação web interativa com resultados eleitorais dos 417 municípios da Bahia. O projeto usa Flask no backend e mantém o frontend em HTML, CSS e JavaScript, com Leaflet, Chart.js e SheetJS carregados por CDN.

## Requisitos

- Python 3.10 ou superior
- A planilha-fonte `data/original/Votação Bahia.xlsx`
- A malha municipal `data/geo/bahia-municipios.geojson`

## Executar localmente no Windows

Na raiz do projeto, crie e ative um ambiente virtual e instale as dependências:

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Acesse <http://localhost:5000>. Para escolher outra porta, defina `PORT` antes de iniciar o servidor:

```powershell
$env:PORT = "5001"
python app.py
```

O modo de depuração fica desativado por padrão. Para ativá-lo durante o desenvolvimento:

```powershell
$env:FLASK_DEBUG = "1"
python app.py
```

## Dados eleitorais

`data/original/Votação Bahia.xlsx` é a fonte principal. Ela reúne o primeiro turno de 2026 e o segundo turno de 2022 para presidente e governador, além dos territórios de identidade.

Ao iniciar, a aplicação carrega `data/processed/dados.json` uma vez por processo e o mantém em memória. Se o JSON estiver ausente, o backend executa a mesma validação do importador e o gera a partir da planilha e da referência municipal local em `data/processed/municipios_ibge.json`. Caso essa referência também não exista, o importador consulta a API do IBGE. Um erro de planilha, dados ou malha é informado no log e na resposta da API.

Para atualizar os dados após alterar a planilha, execute:

```powershell
python scripts/importar_excel.py
```

Para atualizar também a lista municipal oficial do IBGE:

```powershell
python scripts/importar_excel.py --atualizar-ibge
```

Reinicie o servidor após gerar um novo `dados.json`, pois os dados são mantidos em memória enquanto o processo estiver ativo.

`data/geo/bahia-municipios.geojson` é a malha usada pelo mapa. Para atualizá-la e validá-la contra os códigos IBGE do JSON:

```powershell
python scripts/importar_geojson.py
```

## API

- `GET /api/dados` — registros eleitorais completos
- `GET /api/municipios` — códigos IBGE, nomes e territórios
- `GET /api/territorios` — territórios de identidade
- `GET /api/geojson` — malha municipal em GeoJSON
- `GET /api/eleicao/<ano>` — resultados de 2022 ou 2026

## Estrutura

```text
app.py
Procfile
requirements.txt
data/
  original/       Planilha eleitoral e arquivos de referência
  processed/      Dados eleitorais e tabela municipal do IBGE
  geo/            Malha GeoJSON dos municípios da Bahia
templates/
  index.html      Página renderizada pelo Flask
static/
  css/style.css   Estilos
  js/app.js       Interação do mapa e dos dados
scripts/
  importar_excel.py
  importar_geojson.py
```

## Publicar no Render

1. Envie o repositório ao GitHub com `data/processed/dados.json`, a planilha-fonte e o GeoJSON versionados.
2. No Render, crie um **Web Service** conectado ao repositório.
3. Selecione **Python** como runtime. O Render instala as dependências de `requirements.txt` e usa o comando do `Procfile` (`gunicorn app:app --bind 0.0.0.0:$PORT`).
4. Faça o deploy. Não é necessário configurar Node.js nem executar um servidor estático separado.

O arquivo `Procfile` vincula o Gunicorn à porta fornecida pelo ambiente de produção. Leaflet, Chart.js, SheetJS e as fontes tipográficas continuam sendo servidos por CDN; portanto, o navegador precisa de acesso à internet para carregá-los.
