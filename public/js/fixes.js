// Monta as correções de padrão: quais arquivos criar e quais remover em cada repositório.
// Modelos fixos vêm de public/templates; CI e Release são gerados a partir do próprio repo.
import { getText, refSha } from './github.js';

const MARKER = (id) => `# gpl-hub:${id}@1\n# Gerado pelo GPL HUB (https://github.com/devGPL/HUB). Ajuste à vontade para o projeto.\n`;

export const COMBINED_BRANCH = 'chore/hub-padroes';
export const COMBINED_TITLE = 'ci: alinha workflows ao padrão do HUB';

async function fetchTemplate(path) {
  // Relativo a public/, resolvido a partir deste módulo (public/js/).
  const res = await fetch(new URL(`../${path}`, import.meta.url), { cache: 'no-store' });
  if (!res.ok) throw new Error(`Modelo ${path} não encontrado`);
  return res.text();
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/* ---------- CI ---------- */

function nodeMajor(pkg, nvmrc) {
  const fromEngines = pkg?.engines?.node?.match(/\d+/)?.[0];
  const fromNvmrc = nvmrc?.match(/\d+/)?.[0];
  return Number(fromEngines ?? fromNvmrc ?? 22);
}

function packageManager(pkg, locks) {
  const declared = pkg?.packageManager?.match(/^(npm|yarn|pnpm)@(\d+)/);
  if (declared?.[1] === 'yarn' || locks.yarn) {
    const berry = declared?.[1] === 'yarn' && Number(declared[2]) >= 2;
    return {
      name: 'yarn',
      cache: locks.yarn ? 'yarn' : null,
      setup: berry ? ['corepack enable'] : [],
      install: berry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile',
      run: (s) => `yarn ${s}`,
    };
  }
  if (declared?.[1] === 'pnpm' || locks.pnpm) {
    return { name: 'pnpm', cache: 'pnpm', pnpm: true, setup: [], install: 'pnpm install --frozen-lockfile', run: (s) => `pnpm ${s}` };
  }
  return {
    name: 'npm',
    cache: locks.npm ? 'npm' : null,
    setup: [],
    install: locks.npm ? 'npm ci' : 'npm install --no-audit --no-fund',
    run: (s) => `npm run ${s}`,
  };
}

async function buildCi(ctx) {
  const [pkgText, nvmrc, npmLock, yarnLock, pnpmLock, tsconfig] = await Promise.all(
    ['package.json', '.nvmrc', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'tsconfig.json'].map((p) => ctx.read(p)),
  );
  const pkg = parseJson(pkgText);
  if (!pkg) {
    throw new Error('Sem package.json na base. O CI automático do HUB só sabe montar projetos Node; esse precisa ser feito à mão.');
  }

  const pm = packageManager(pkg, { npm: npmLock != null, yarn: yarnLock != null, pnpm: pnpmLock != null });
  const node = nodeMajor(pkg, nvmrc);
  const scripts = ['lint', 'typecheck', 'test'].filter((s) => pkg.scripts?.[s]);
  const checks = scripts.map((s) => `      - run: ${pm.run(s)}`);
  const notes = [`Node ${node}, ${pm.name}, ${scripts.length ? `scripts: ${scripts.join(', ')}` : 'sem scripts de verificação'}.`];

  if (!checks.length && tsconfig != null) {
    checks.push('      # O projeto não tem scripts de lint, typecheck ou test: por enquanto, só a checagem de tipos.', '      - run: npx tsc --noEmit');
    notes.push('Sem scripts de lint, typecheck ou test: o CI roda `tsc --noEmit`. Vale criar esses scripts depois.');
  }
  if (!checks.length) throw new Error('O projeto não tem scripts de lint, typecheck ou test nem tsconfig.json. Não há o que o CI rodar.');

  const lines = [
    MARKER('ci').trimEnd(),
    'name: CI',
    '',
    '# Lint, checagem de tipos e testes nas PRs. O build fica com a Vercel, que já compila',
    '# com as variáveis de cada ambiente.',
    'on:',
    '  pull_request:',
    '    branches: [main, dev, develop]',
    '',
    'jobs:',
    '  check:',
    '    name: Checks',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    ...(pm.pnpm ? ['      - uses: pnpm/action-setup@v4'] : []),
    '      - uses: actions/setup-node@v4',
    '        with:',
    `          node-version: ${node}`,
    ...(pm.cache ? [`          cache: ${pm.cache}`] : []),
    ...pm.setup.map((s) => `      - run: ${s}`),
    `      - run: ${pm.install}`,
    ...checks,
    '',
  ];
  return { files: [{ path: '.github/workflows/ci.yml', content: lines.join('\n') }], notes };
}

/* ---------- Release Please ---------- */

const CHANGELOG_SECTIONS = [
  { type: 'feat', section: 'Novidades' },
  { type: 'fix', section: 'Correções' },
  { type: 'perf', section: 'Performance' },
  { type: 'refactor', section: 'Refatoração' },
  { type: 'chore', section: 'Manutenção' },
  { type: 'ci', section: 'Manutenção' },
  { type: 'build', section: 'Manutenção' },
  { type: 'docs', section: 'Documentação', hidden: true },
  { type: 'test', section: 'Testes', hidden: true },
  { type: 'style', section: 'Estilo', hidden: true },
];

async function buildRelease(ctx) {
  const [pkgText, config, manifest] = await Promise.all(
    ['package.json', 'release-please-config.json', '.release-please-manifest.json'].map((p) => ctx.read(p)),
  );
  const pkg = parseJson(pkgText);
  const version = pkg?.version ?? '0.1.0';
  const files = [];
  const notes = [];

  files.push({
    path: '.github/workflows/release-please.yml',
    content: [
      MARKER('release-please').trimEnd(),
      'name: Release Please',
      '',
      '# A cada merge na main, mantém aberta uma PR de release com versão e changelog.',
      '# Ao mergear essa PR, a tag e o GitHub Release são criados.',
      'on:',
      '  push:',
      '    branches: [main]',
      '',
      'permissions:',
      '  contents: write',
      '  pull-requests: write',
      '',
      'jobs:',
      '  release-please:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: googleapis/release-please-action@v4',
      '        with:',
      '          token: ${{ secrets.GITHUB_TOKEN }}',
      '          # A branch padrão pode ser dev: sem isto a PR de release nasceria lá.',
      '          target-branch: main',
      '          config-file: release-please-config.json',
      '          manifest-file: .release-please-manifest.json',
      '',
    ].join('\n'),
  });

  if (config == null) {
    // Começa o changelog a partir de agora, e não do primeiro commit do repositório.
    const bootstrap = await ctx.sha('main').catch(() => null);
    const pkgConfig = { 'release-type': pkg ? 'node' : 'simple', ...(bootstrap ? { 'bootstrap-sha': bootstrap } : {}), 'changelog-sections': CHANGELOG_SECTIONS };
    files.push({
      path: 'release-please-config.json',
      content: `${JSON.stringify(
        {
          'pull-request-header': 'Release ${version}\n\nAo mergear esta PR, a tag e o GitHub Release são criados. Não edite o corpo: o release-please usa metadados ocultos aqui.',
          'pull-request-title-pattern': 'chore: release ${version}',
          packages: { '.': pkgConfig },
        },
        null,
        2,
      )}\n`,
    });
  } else {
    notes.push('`release-please-config.json` já existe e foi mantido.');
  }

  if (manifest == null) {
    files.push({ path: '.release-please-manifest.json', content: `${JSON.stringify({ '.': version }, null, 2)}\n` });
    notes.push(`Versão inicial ${version}${pkg?.version ? ', lida do package.json' : ''}.`);
  } else {
    notes.push('`.release-please-manifest.json` já existe e foi mantido.');
  }

  return { files, notes };
}

/* ---------- Montagem ---------- */

const GENERATORS = { ci: buildCi, 'release-please': buildRelease };

/** Correção de um check num repo: { files, remove, notes }. */
export async function buildFix(def, result, ctx) {
  let built;
  if (def.fix.generator) {
    built = await GENERATORS[def.fix.generator](ctx);
  } else {
    built = { files: [{ path: def.fix.path, content: await fetchTemplate(def.fix.template) }], notes: [] };
  }
  return {
    ...built,
    remove: result.replaces.map((f) => `.github/workflows/${f}`),
  };
}

/** Contexto de leitura do repo na branch base, com cache por arquivo. */
export function repoContext(token, org, repo, base) {
  const cache = new Map();
  return {
    read(path) {
      if (!cache.has(path)) cache.set(path, getText(token, org, repo, path, base));
      return cache.get(path);
    },
    sha: (branch) => refSha(token, org, repo, branch),
  };
}

/** Junta as correções de vários checks num único plano de PR. */
export async function buildPlan(token, org, repo, defs) {
  const ctx = repoContext(token, org, repo.name, repo.integrationBranch);
  const parts = await Promise.all(
    defs.map(async (def) => {
      const res = repo.checks.find((c) => c.id === def.id);
      try {
        return { def, ok: true, ...(await buildFix(def, res, ctx)) };
      } catch (err) {
        return { def, ok: false, error: err.message, files: [], remove: [], notes: [] };
      }
    }),
  );
  const ready = parts.filter((p) => p.ok);
  const single = defs.length === 1;
  return {
    repo,
    base: repo.integrationBranch,
    parts,
    files: ready.flatMap((p) => p.files),
    remove: ready.flatMap((p) => p.remove),
    branch: single ? defs[0].fix.branch : COMBINED_BRANCH,
    title: single ? defs[0].fix.title : COMBINED_TITLE,
  };
}

export function planBody(plan) {
  const lines = ['## Manutenção', '', 'Aberta pelo [GPL HUB](https://devgpl.github.io/HUB/) para alinhar o repositório ao padrão.', ''];
  for (const p of plan.parts.filter((x) => x.ok)) {
    lines.push(`### ${p.def.label}`, '');
    p.files.forEach((f) => lines.push(`- Adiciona \`${f.path}\`.`));
    p.remove.forEach((f) => lines.push(`- Remove \`${f}\`, substituído pelo modelo.`));
    p.notes.forEach((n) => lines.push(`- ${n}`));
    if (p.def.fix.setup) lines.push(`- Configuração: ${p.def.fix.setup}`);
    lines.push('');
  }
  lines.push('## Checklist', '- [ ] Workflows conferidos para a realidade do projeto', '- [ ] CI verde');
  return lines.join('\n');
}
