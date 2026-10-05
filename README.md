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

## Botão Corrigir

Para cada padrão faltando, o HUB abre uma pull request na branch de integração (`dev` ou `develop`) com um único commit. Nada vai direto para a branch.

- **No repositório**: botão *Corrigir* em cada padrão, ou *Corrigir tudo numa PR* quando há mais de uma pendência.
- **Na aba Padrões**: *Corrigir pendências* abre uma PR por repositório de uma vez. Repositórios em que você não tem escrita ficam de fora.
- **Desatualizado** (amarelo): o workflow existe, mas não é o modelo do HUB. Hoje vale só para o Discord, para todos os repos notificarem no mesmo formato.

| Padrão | Como é gerado |
| --- | --- |
| CI | Montado a partir do repo: lockfile (npm, yarn, pnpm), versão do Node em `engines` ou `.nvmrc`, e os scripts `lint`, `typecheck` e `test` que existirem. Sem nenhum deles, roda `tsc --noEmit`. |
| Release | Workflow + `release-please-config.json` + `.release-please-manifest.json`, com a versão do `package.json` e `bootstrap-sha` na ponta da main. Arquivos de config existentes são mantidos. |
| Sync dev | `templates/sync-main-to-dev.yml`: a cada push na main, fast-forward ou merge na dev; se falhar, abre PR. |
| Discord | `templates/notify-discord-pr.yml`: substitui o workflow antigo de Discord, se houver. |
| PR Title | `templates/pr-title.yml` (action-semantic-pull-request). Repos que já validam com commitlint contam como ok. |

O token precisa de escrita em `Contents`, `Pull requests` e `Workflows` (classic: `repo` e `workflow`).

Para ver o que seria feito sem escrever nada no GitHub:

```bash
npm run fix-plan
```

### Discord

Todos os repositórios, menos o edifica (que tem canal próprio junto com os feedbacks), notificam no mesmo canal. A mensagem traz o nome do repositório em destaque, no topo do embed, e uma cor fixa por repositório.

No plano Free, secrets e variáveis de organização não chegam a repositórios privados, então a configuração é feita **em cada repositório** (menos o edifica), por alguém com admin, em *Settings > Secrets and variables > Actions*:

- Secret `DISCORD_WEBHOOK_URL`: webhook do canal compartilhado.
- Variable `DISCORD_PO_USER_ID`: ID do usuário do PO no Discord, para a menção (o nome antigo `DISCORD_PO_ID` também é aceito).

Para fazer todos de uma vez no PowerShell:

```powershell
$repos = 'Tempus','Latitude','concretou','Ekko','DataBook','Alicerce','Lumina','auditBIM','capacitamais'
$webhook = Read-Host 'Cole o webhook do Discord'
foreach ($r in $repos) {
  $webhook | gh secret set DISCORD_WEBHOOK_URL -R "devGPL/$r"
  gh variable set DISCORD_PO_USER_ID -R "devGPL/$r" --body <ID do PO>
}
```

Repositório novo no monitoramento precisa dos dois também. O webhook nunca vai para o código: ele só existe como secret.

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
