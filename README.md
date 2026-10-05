# GPL HUB

Painel de monitoramento dos repositórios de desenvolvimento da GPL (org `devGPL`).

Para cada projeto monitorado, o HUB mostra:

- **Pull requests abertas**: autor, branch de origem e destino, idade, review, CI e conflito. A aba *Pull requests* junta todas numa fila, das mais antigas para as mais novas.
- **Branches**: quantas branches de trabalho existem (fora `main`, `dev` e `develop`) e quais estão paradas há mais de `staleBranchDays`.
- **Padrões**: CI, Release Please, Sync main para dev, notificação no Discord, validação de título de PR e GlitchTip, com uma nota de S a D por repositório.
- **Atalhos** para repositório, PRs, branches, Actions e workflows.

## Como o acesso funciona

A org está no plano Free, então o GitHub Pages só publica a partir de repositório público e o site também fica público. Por isso **o site não leva nenhum dado**: ele só tem o código. Ao abrir, cada pessoa conecta um token do GitHub, que fica salvo apenas no próprio navegador, e o HUB consulta a API direto dali. Quem não tem acesso aos repositórios não vê nada.

Token recomendado: *fine-grained*, dono `devGPL`, todos os repositórios, leitura em `Contents`, `Pull requests` e `Metadata`. Se a org não aceitar fine-grained, um token *classic* com escopo `repo` também funciona.

> Não adicione etapas de build que gravem dados dos repositórios no site publicado.

## Rodando local

Pré-requisitos: Node 20+ e GitHub CLI logado (`gh auth login`).

```bash
npm start
```

Abre em http://localhost:4321. No localhost o servidor repassa o token do `gh`, então não precisa colar nada.

Para conferir as regras pelo terminal:

```bash
npm run snapshot
```

## Configuração: `public/hub.config.json`

- `repos`: repositórios monitorados. Cada um aceita `label` (nome de exibição) e `logo`:
  - `path`: caminho da imagem dentro do repositório, na branch padrão.
  - `crop`: recorte `[x, y, largura, altura]` em pixels da imagem original, para pegar só o símbolo da marca.
  - `tile`: fundo do ícone, `dark` ou `light`, conforme a logo.
  - Sem `logo`, aparece a inicial do projeto.
- `staleBranchDays`: dias sem commit para considerar uma branch parada.
- `checks`: padrões verificados. Cada um casa por nome de arquivo (`fileName`) e/ou conteúdo (`content`) dos workflows em `.github/workflows`, lidos da `main` e da branch padrão. Com `required: false` aparece na matriz, mas não conta como pendência.

As logos são baixadas com o token, recortadas e guardadas no `localStorage`; só são baixadas de novo quando o arquivo muda no repositório.

## Publicação

Todo push na `main` que mexe em `public/` publica o site pelo workflow `.github/workflows/pages.yml`.

## Estrutura

```
public/
  index.html        página única
  styles.css        design system
  hub.config.json   repositórios e regras
  js/app.js         interface
  js/github.js      coleta via GraphQL (também usada pelo snapshot no Node)
  js/logos.js       download, recorte e cache das logos
  js/icons.js       ícones SVG
server.mjs          servidor local de desenvolvimento
scripts/snapshot.mjs
```
