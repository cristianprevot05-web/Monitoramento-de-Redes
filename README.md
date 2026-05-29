# Reparo CTOE - Grafana Business Text

Arquivos do painel **Reparo CTOE** para usar no plugin Business Text do Grafana.

## Arquivos

- `index.html`: preview simples do painel.
- `styles.css`: CSS completo.
- `script.js`: JavaScript completo com cache da última leitura válida.

## Como usar no Grafana

1. Abra o painel no Grafana.
2. Em **Business Text**, cole o conteúdo de `index.html` sem as tags `<!doctype>`, `<html>`, `<head>`, `<body>` e sem o `<script src="./script.js"></script>`.
3. Cole o conteúdo de `styles.css` na aba de CSS/Styles.
4. Cole o conteúdo de `script.js` na aba de JavaScript.
5. Salve a dashboard.

## Observação

Os KPIs usam IDs exclusivos:

- `ctoKTotal`
- `ctoKOpen`
- `ctoKExec`

Isso evita conflito com outros painéis da mesma dashboard que também usam IDs como `kTotal` ou `kOpen`.
