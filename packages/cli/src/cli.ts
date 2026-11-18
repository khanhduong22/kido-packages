#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { executeAddCommand } from './commands/add';
import { executeInfoCommand } from './commands/info';
import { executeListCommand } from './commands/list';
import { colors } from './utils/colors';

const VERSION = '1.0.0';

const HELP_TEXT = `
${colors.bold(colors.cyan('kido-bag'))} — ${colors.dim(`v${VERSION}`)}
Shadcn-style surgical slice cherry-pick and blueprint extractor for Kido Packages (@kido/*)

${colors.bold('USAGE:')}
  $ ${colors.green('npx kido-bag')} <command> [options]

${colors.bold('COMMANDS:')}
  ${colors.bold('list')}                     List available blueprints and domain slices categorized by pillar
  ${colors.bold('add')} <slice|blueprint>    Surgically copy a slice or blueprint into your project
  ${colors.bold('info')} <slice|blueprint>   Inspect exports, dependencies, and metadata for a slice
  ${colors.bold('help')}                     Display this help text

${colors.bold('OPTIONS for "list":')}
  -p, --pillar <id|name>     Filter slices by pillar (1 to 6 or name)
  -b, --blueprints           List only the 12 Architecture Blueprints
  -s, --slices               List only Domain Combo Slices
  -q, --search <term>        Search blueprints and slices by keyword
      --json                 Output machine-readable JSON format

${colors.bold('OPTIONS for "add":')}
  -o, --out <dir>            Output destination directory (default: src/lib/kido)
  -f, --force                Overwrite existing files in destination
  -d, --dry-run              Simulate extraction without writing to disk

${colors.bold('EXAMPLES:')}
  $ ${colors.green('npx kido-bag list')}
  $ ${colors.green('npx kido-bag list --pillar 2')}
  $ ${colors.green('npx kido-bag list --search "counter"')}
  $ ${colors.green('npx kido-bag add slotted-counter')}
  $ ${colors.green('npx kido-bag add rpm-rate-guard --out src/lib/stream')}
  $ ${colors.green('npx kido-bag add 01-youtube-view-counter')}
  $ ${colors.green('npx kido-bag info slotted-counter')}
`;

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    console.log(HELP_TEXT);
    return;
  }

  if (argv.includes('--version') || argv.includes('-v') || argv[0] === 'version') {
    console.log(`kido-bag v${VERSION}`);
    return;
  }

  const command = argv[0];
  const commandArgs = argv.slice(1);

  try {
    switch (command) {
      case 'list': {
        const { values } = parseArgs({
          args: commandArgs,
          options: {
            pillar: { type: 'string', short: 'p' },
            blueprints: { type: 'boolean', short: 'b' },
            slices: { type: 'boolean', short: 's' },
            search: { type: 'string', short: 'q' },
            json: { type: 'boolean' },
          },
          allowPositionals: true,
        });

        await executeListCommand({
          pillar: values.pillar,
          blueprintsOnly: values.blueprints,
          slicesOnly: values.slices,
          search: values.search,
          json: values.json,
        });
        break;
      }

      case 'add': {
        const { values, positionals } = parseArgs({
          args: commandArgs,
          options: {
            out: { type: 'string', short: 'o' },
            force: { type: 'boolean', short: 'f' },
            'dry-run': { type: 'boolean', short: 'd' },
            dryRun: { type: 'boolean' },
          },
          allowPositionals: true,
        });

        const target = positionals[0];
        if (!target) {
          console.error(colors.red('Error: Missing slice or blueprint name to add.'));
          console.log(`Usage: ${colors.green('npx kido-bag add <slice-name>')}`);
          process.exit(1);
        }

        await executeAddCommand(target, {
          outDir: values.out,
          force: values.force,
          dryRun: values['dry-run'] || values.dryRun,
        });
        break;
      }

      case 'info':
      case 'view': {
        const target = commandArgs[0];
        if (!target) {
          console.error(colors.red('Error: Missing slice or blueprint name to inspect.'));
          console.log(`Usage: ${colors.green('npx kido-bag info <name>')}`);
          process.exit(1);
        }

        await executeInfoCommand(target);
        break;
      }

      default: {
        console.error(colors.red(`Unknown command: "${command}"`));
        console.log(`Run ${colors.green('npx kido-bag --help')} for available commands.`);
        process.exit(1);
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n${colors.bold(colors.red('✖ Error:'))} ${message}\n`);
    process.exit(1);
  }
}

// Automatically invoke if executed directly as a script
if (require.main === module || (typeof process !== 'undefined' && process.argv[1]?.endsWith('cli.js'))) {
  runCli();
}
